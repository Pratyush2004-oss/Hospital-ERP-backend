import { Pool, type PoolConfig } from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

let pool: Pool | null = null;

function createPool(): Pool {
  const config: PoolConfig = {
    // Runtime always prefers the restricted role; DATABASE_URL is the
    // administrative connection used by migrations and seeds.
    connectionString: env.APP_DATABASE_URL ?? env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT,
    keepAlive: true,
    ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
    application_name: "hospitalos-api",
  };

  const instance = new Pool(config);

  // Idle clients emit errors when PostgreSQL restarts or drops a connection.
  // Without a listener Node would treat it as an unhandled 'error' event.
  instance.on("error", (error) => {
    logger.error({ err: error }, "Unexpected error on idle PostgreSQL client");
  });

  logger.info(
    {
      poolMax: env.DB_POOL_MAX,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT,
      credentialSource: env.APP_DATABASE_URL ? "app" : "database",
    },
    "PostgreSQL connection pool created",
  );

  return instance;
}

/**
 * Lazily created singleton pool shared by the entire process. Importing this
 * module never opens a socket; the first query (or health check) does.
 */
export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}

/** Whether a pool has been created, so shutdown does not open a new one. */
export function isPoolInitialized(): boolean {
  return pool !== null;
}

/** Drains the pool. Safe to call more than once. */
export async function closePool(): Promise<void> {
  if (!pool) return;

  const instance = pool;
  pool = null;

  await instance.end();
  logger.info("PostgreSQL connection pool closed");
}

/** Runs `SELECT 1` and returns the round-trip latency in milliseconds. */
export async function checkDatabaseConnection(): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await getPool().query("SELECT 1");
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
