import { env, type Env } from "../../config/env.js";
import { checkDatabaseConnection } from "../../database/index.js";
import {
  checkRedisConnection,
  type RedisHealth,
} from "../../infrastructure/redis/index.js";
import { logger } from "../../lib/logger.js";

const SERVICE_NAME = "hospitalos-api";
const SERVICE_VERSION = process.env.npm_package_version ?? "0.1.0";
const startedAt = process.hrtime.bigint();

export interface DependencyCheck {
  status: "up" | "down";
  latencyMs?: number;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  service: string;
  version: string;
  environment: Env["NODE_ENV"];
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    api: { status: "up" };
    database: DependencyCheck;
    redis: RedisHealth;
  };
}

async function checkDatabase(): Promise<DependencyCheck> {
  try {
    const latencyMs = await checkDatabaseConnection();
    return { status: "up", latencyMs: Number(latencyMs.toFixed(2)) };
  } catch (error) {
    logger.warn({ err: error }, "Database health check failed");
    return { status: "down" };
  }
}

/**
 * Readiness data for probes and dashboards. Dependencies are checked in
 * parallel; the endpoint fails with 503 when either PostgreSQL or Redis is
 * unreachable so orchestrators stop routing traffic to this node.
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedisConnection()]);
  const uptimeSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
  const isHealthy = database.status === "up" && redis.status === "up";

  return {
    status: isHealthy ? "ok" : "degraded",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Number(uptimeSeconds.toFixed(3)),
    timestamp: new Date().toISOString(),
    checks: {
      api: { status: "up" },
      database,
      redis,
    },
  };
}
