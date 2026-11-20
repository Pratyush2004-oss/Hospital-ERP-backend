import type { RedisOptions } from "ioredis";
import { env } from "../../config/env.js";

/** Upper bound for reconnect backoff; retries themselves never stop. */
const MAX_RETRY_DELAY_MS = 2_000;

export const redisConfig = {
  url: env.REDIS_URL,
  options: {
    connectTimeout: env.REDIS_CONNECT_TIMEOUT,
    // Caps how long a single command waits for a reconnect before failing,
    // instead of hanging forever while Redis is unreachable.
    maxRetriesPerRequest: env.REDIS_MAX_RETRIES,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(attempt) {
      return Math.min(attempt * 200, MAX_RETRY_DELAY_MS);
    },
  } satisfies RedisOptions,
} as const;
