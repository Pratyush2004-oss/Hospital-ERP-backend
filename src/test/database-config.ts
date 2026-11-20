import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

/**
 * Test database topology:
 *
 * - admin URL  (superuser/owner)  migrations, fixtures, cleanup
 * - app URL    (restricted role)  the actual API process under test
 *
 * Keeping the two separate means every HTTP test exercises RLS with the same
 * restricted privileges production should use.
 */
export const TEST_ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL?.trim() ||
  process.env.TEST_DATABASE_URL?.trim() ||
  "postgresql://hospitalos:hospitalos@localhost:5432/hospitalos_test";

export const TEST_APP_DATABASE_USER =
  process.env.TEST_APP_DATABASE_USER?.trim() || "hospitalos_app";

export const TEST_APP_DATABASE_PASSWORD =
  process.env.TEST_APP_DATABASE_PASSWORD ?? "hospitalos_app";

/** Restricted runtime URL used by the API under test. */
export function testAppDatabaseUrl(): string {
  const override = process.env.TEST_APP_DATABASE_URL?.trim();
  if (override) return override;

  const url = new URL(TEST_ADMIN_DATABASE_URL);
  url.username = TEST_APP_DATABASE_USER;
  url.password = TEST_APP_DATABASE_PASSWORD;
  return url.toString();
}
