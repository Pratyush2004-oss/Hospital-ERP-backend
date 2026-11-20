/**
 * Public entry point for Redis. Modules should import from here rather than
 * reaching into the client or config directly.
 */
export { redisConfig } from "./redis.config.js";
export {
  acquireLock,
  releaseLock,
  closeRedisClient,
  del,
  exists,
  expire,
  get,
  getRedisClient,
  isRedisClientInitialized,
  set,
} from "./redis.client.js";
export { checkRedisConnection, type RedisHealth } from "./redis.health.js";
