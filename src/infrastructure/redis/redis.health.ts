import { logger } from "../../lib/logger.js";
import { getRedisClient } from "./redis.client.js";

/** Health checks must answer quickly even while ioredis keeps retrying. */
const REDIS_HEALTH_TIMEOUT_MS = 1_000;

export interface RedisHealth {
  status: "up" | "down";
  latencyMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Redis health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Pings Redis with a hard timeout. Returns a result object instead of throwing
 * so a Redis outage degrades the health endpoint rather than failing the request.
 */
export async function checkRedisConnection(): Promise<RedisHealth> {
  const startedAt = process.hrtime.bigint();

  try {
    await withTimeout(getRedisClient().ping(), REDIS_HEALTH_TIMEOUT_MS);
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    return { status: "up", latencyMs: Number(latencyMs.toFixed(2)) };
  } catch (error) {
    logger.warn({ err: error }, "Redis health check failed");
    return { status: "down" };
  }
}
