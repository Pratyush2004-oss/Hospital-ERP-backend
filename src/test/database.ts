import { Pool } from "pg";
import { TEST_ADMIN_DATABASE_URL } from "./database-config.js";

/**
 * Elevated connection used only for test fixtures and cleanup. The API under
 * test connects with the restricted `hospitalos_app` role instead.
 */
let adminPool: Pool | null = null;

export function getTestAdminPool(): Pool {
  adminPool ??= new Pool({
    connectionString: TEST_ADMIN_DATABASE_URL,
    max: 2,
    application_name: "hospitalos-test-admin",
  });

  return adminPool;
}

export async function closeTestAdminPool(): Promise<void> {
  if (!adminPool) return;

  const pool = adminPool;
  adminPool = null;
  await pool.end();
}
