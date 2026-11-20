import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closePool, getPool, isPoolInitialized } from "./database/index.js";
import {
  closeRedisClient,
  isRedisClientInitialized,
} from "./infrastructure/redis/index.js";
import { logger } from "./lib/logger.js";
import {
  startAppointmentReminderScheduler,
  stopAppointmentReminderScheduler,
} from "./modules/notifications/notification.appointment.service.js";
import {
  startNotificationWorker,
  stopNotificationWorker,
} from "./modules/notifications/notification.worker.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

let server: Server | null = null;
let isShuttingDown = false;


/**
 * Refuses to serve production traffic as a role that bypasses RLS. PostgreSQL
 * superusers and roles with BYPASSRLS are not subject to tenant policies, so
 * `APP_DATABASE_URL` must point at the restricted application role.
 */
async function assertRestrictedRuntimeRole(): Promise<void> {
  if (env.NODE_ENV === "production" && !env.APP_DATABASE_URL) {
    throw new Error(
      "APP_DATABASE_URL is required in production and must use the restricted application role.",
    );
  }

  const result = await getPool().query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>("select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user");

  const role = result.rows[0];
  if (!role) return;

  const bypassesRls = role.rolsuper || role.rolbypassrls;
  if (!bypassesRls) return;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start with a database role that bypasses Row Level Security. " +
        "Set APP_DATABASE_URL to the restricted application role.",
    );
  }

  logger.warn(
    { databaseRole: role.current_user },
    "Database role bypasses RLS; use APP_DATABASE_URL with a restricted role in production",
  );
}

async function closeDatabase(): Promise<void> {
  // Avoid opening a pool on shutdown when nothing ever queried the database.
  if (!isPoolInitialized()) return;

  try {
    await closePool();
  } catch (error) {
    logger.error({ err: error }, "Error while closing PostgreSQL pool");
  }
}

async function closeRedis(): Promise<void> {
  // Avoid opening a connection on shutdown when Redis was never used.
  if (!isRedisClientInitialized()) return;

  try {
    await closeRedisClient();
  } catch (error) {
    logger.error({ err: error }, "Error while closing Redis client");
  }
}

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Shutdown signal received, closing server");

  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Graceful shutdown timed out");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  const closeHttpServer = (error?: Error): void => {
    if (error) {
      clearTimeout(forceExit);
      logger.error({ err: error }, "Error while closing HTTP server");
      process.exit(1);
    }

    void (async () => {
      stopAppointmentReminderScheduler();
      stopNotificationWorker();
      await closeRedis();
      await closeDatabase();
      clearTimeout(forceExit);
      logger.info("Shutdown complete");
      process.exit(0);
    })();
  };

  if (server) {
    server.close(closeHttpServer);
    return;
  }

  closeHttpServer();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (reason, _promise) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  shutdown("SIGTERM");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  shutdown("SIGTERM");
});

async function start(): Promise<void> {
  await assertRestrictedRuntimeRole();

  const app = createApp();
  const listener: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV, apiPrefix: env.API_PREFIX },
      "HospitalOS API listening",
    );
  });

  listener.on("error", (error) => {
    logger.fatal({ err: error }, "HTTP server failed to start");
    process.exit(1);
  });

  server = listener;

  // Background delivery and reminder sweeps run in-process. They are Redis
  // locked and safe to run on more than one instance; HTTP readiness does not
  // depend on them, so a provider/Redis outage never takes the API down.
  startAppointmentReminderScheduler();
  startNotificationWorker();
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "HospitalOS API failed to start");
  process.exit(1);
});
