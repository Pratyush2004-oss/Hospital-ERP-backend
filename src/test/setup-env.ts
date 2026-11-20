import {
  TEST_ADMIN_DATABASE_URL,
  testAppDatabaseUrl,
} from "./database-config.js";

/**
 * Loaded with `node --import` before any test module, so `config/env.ts` sees a
 * test configuration on its first import.
 *
 * The API under test connects with the restricted application role
 * (`APP_DATABASE_URL`); fixtures and cleanup use the admin connection. The pool
 * is capped at one connection so the suite also proves tenant context cannot
 * leak from one transaction to the next.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_ADMIN_DATABASE_URL;
process.env.TEST_ADMIN_DATABASE_URL = TEST_ADMIN_DATABASE_URL;
process.env.APP_DATABASE_URL = testAppDatabaseUrl();
process.env.DB_POOL_MAX = "1";
process.env.LOG_LEVEL = "silent";
process.env.AUTH_ACCESS_TOKEN_SECRET =
  process.env.AUTH_ACCESS_TOKEN_SECRET?.trim() ||
  "test-only-access-token-secret-with-enough-entropy-0123456789";
process.env.REDIS_URL = process.env.REDIS_URL?.trim() || "redis://localhost:6379";
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = "5";
process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS = "60000";
