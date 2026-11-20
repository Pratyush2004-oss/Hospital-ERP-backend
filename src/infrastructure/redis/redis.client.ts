import { Redis } from "ioredis";
import { logger } from "../../lib/logger.js";
import { redisConfig } from "./redis.config.js";

let client: Redis | null = null;

/** Avoids one error log per reconnect attempt during a single outage. */
let hasLoggedConnectionError = false;

function createClient(): Redis {
  const instance = new Redis(redisConfig.url, redisConfig.options);

  instance.on("ready", () => {
    hasLoggedConnectionError = false;
    logger.info("Redis client ready");
  });

  instance.on("reconnecting", (delay: number) => {
    logger.warn({ delayMs: delay }, "Redis connection lost, reconnecting");
  });

  // Without an 'error' listener ioredis emits an unhandled event and Node exits.
  instance.on("error", (error) => {
    if (hasLoggedConnectionError) return;
    hasLoggedConnectionError = true;
    logger.error({ err: error }, "Redis client error");
  });

  instance.on("end", () => {
    logger.debug("Redis connection ended");
  });

  return instance;
}

/**
 * Lazily created singleton client. Importing this module never opens a socket;
 * the first command (or the health probe) triggers the connection.
 */
export function getRedisClient(): Redis {
  client ??= createClient();
  return client;
}

/** Whether a client has been created, so shutdown does not open a new one. */
export function isRedisClientInitialized(): boolean {
  return client !== null;
}

/** Reads a value; `null` when the key does not exist. */
export function get(key: string): Promise<string | null> {
  return getRedisClient().get(key);
}

/** Sets a value, optionally with a TTL in seconds. */
export async function set(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const instance = getRedisClient();

  if (ttlSeconds !== undefined && ttlSeconds > 0) {
    await instance.set(key, value, "EX", ttlSeconds);
    return;
  }

  await instance.set(key, value);
}

/** Deletes a key; returns whether a key was removed. */
export async function del(key: string): Promise<boolean> {
  const removed = await getRedisClient().del(key);
  return removed > 0;
}

/** Returns whether the key exists. */
export async function exists(key: string): Promise<boolean> {
  const count = await getRedisClient().exists(key);
  return count > 0;
}

/** Sets a TTL on an existing key; returns whether it was applied. */
export async function expire(key: string, ttlSeconds: number): Promise<boolean> {
  const applied = await getRedisClient().expire(key, ttlSeconds);
  return applied === 1;
}

/**
 * Best-effort distributed lock. Returns true when this caller acquired the key.
 * The TTL bounds a crashed holder; release compares the token so a slow worker
 * cannot delete a lock another process has since acquired.
 */
export async function acquireLock(
  key: string,
  token: string,
  ttlMilliseconds: number,
): Promise<boolean> {
  const result = await getRedisClient().set(key, token, "PX", ttlMilliseconds, "NX");
  return result === "OK";
}

/** Releases a lock only if the stored token is still ours. */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  const released = await getRedisClient().eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );

  return Number(released) === 1;
}

/**
 * Closes the client gracefully (QUIT) when connected, otherwise disconnects
 * immediately. Safe to call more than once.
 */
export async function closeRedisClient(): Promise<void> {
  if (!client) return;

  const instance = client;
  client = null;

  try {
    if (instance.status === "ready") {
      await instance.quit();
    } else {
      instance.disconnect();
    }
  } catch (error) {
    logger.warn({ err: error }, "Redis quit failed, forcing disconnect");
    instance.disconnect();
  }

  logger.info("Redis connection closed");
}
