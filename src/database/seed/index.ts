import { closePool, getPool } from "../connection.js";
import { getDb } from "../client.js";
import { seedAccess } from "./access.js";
import { seedDepartments } from "./departments.js";
import { seedDoctors } from "./doctors.js";
import { assertSeedableEnvironment, resolveSeedPassword } from "./helpers.js";
import { seedPatients } from "./patients.js";
import { seedTenancy } from "./tenancy.js";

/**
 * Development seed runner. `npm run db:seed`.
 *
 * Safe to rerun: every step resolves rows by natural key (tenant slug, branch
 * code, email, patient code, schedule window) and updates instead of inserting
 * a second copy. No table is truncated and no existing data is deleted.
 *
 * Refuses to run when `NODE_ENV=production`; seeded accounts use a documented
 * placeholder password unless `SEED_ADMIN_PASSWORD` is set.
 */
const TABLES_TO_REPORT = [
  "tenants",
  "branches",
  "users",
  "tenant_memberships",
  "roles",
  "permissions",
  "role_permissions",
  "membership_roles",
  "departments",
  "department_branches",
  "doctors",
  "doctor_departments",
  "doctor_branches",
  "doctor_schedules",
  "doctor_breaks",
  "patient_profiles",
  "patient_contacts",
  "patient_addresses",
  "patient_emergency_contacts",
] as const;

async function reportCounts(): Promise<void> {
  const pool = getPool();

  for (const table of TABLES_TO_REPORT) {
    const result = await pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    const count = result.rows[0]?.n ?? 0;
    console.log(`  ${table.padEnd(30)} ${count}`);
  }
}

async function main(): Promise<void> {
  assertSeedableEnvironment();

  const password = resolveSeedPassword();
  const db = getDb();

  console.log("HospitalOS development seed");
  console.log("  hospitals + branches ...");
  const tenancy = await seedTenancy(db);

  console.log("  permissions, roles, admin accounts ...");
  await seedAccess(db, tenancy, password);

  console.log("  departments ...");
  const departmentIds = await seedDepartments(db, tenancy);

  console.log("  doctors, branch assignments, schedules ...");
  await seedDoctors(db, tenancy, departmentIds, password);

  console.log("  patient profiles ...");
  await seedPatients(db, tenancy, password);

  console.log("Seed complete. Current row counts:");
  await reportCounts();

  if (!process.env.SEED_ADMIN_PASSWORD?.trim()) {
    console.log("\nSeeded accounts share the development-only password in seed/helpers.ts.");
    console.log("Set SEED_ADMIN_PASSWORD to override it.");
  }
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error: unknown) => {
    console.error("Seed failed:", error);
    await closePool();
    process.exitCode = 1;
  });
