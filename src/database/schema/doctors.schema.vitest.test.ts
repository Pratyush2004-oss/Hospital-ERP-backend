import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { closePool } from "../connection.js";
import { withTenantTransaction } from "../context.js";
import type { NewDoctor } from "./doctors.js";
import { doctorBranches, doctorDepartments, doctors } from "./index.js";

/**
 * Schema-level tests for Task 15.1 (Doctor Management foundation).
 *
 * Writes go through `withTenantTransaction`, so they run as the restricted
 * `hospitalos_app` role and exercise the same RLS policies production uses.
 * Fixtures (tenants, users, branches, departments) are created with the admin
 * connection, which is also how the existing department suite seeds data.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly cardiology: string;
  readonly neurology: string;
  readonly userId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'schema-test-not-a-real-hash')`,
    [id, `Doctor ${label}`, `${label}-${id.slice(0, 8)}@schema.test`],
  );
  createdUserIds.push(id);
  return id;
}

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const cardiology = randomUUID();
  const neurology = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code)
     values ($1, $2, 'Central', $3), ($4, $2, 'Riverside', $5)`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug)
     values ($1, $2, $3, 'Cardiology', 'cardiology'), ($4, $2, $5, 'Neurology', 'neurology')`,
    [cardiology, tenantId, branchA, neurology, branchB],
  );

  // Cardiology operates at Branch A only; Neurology at Branch B only.
  await pool.query(
    `insert into department_branches (tenant_id, department_id, branch_id) values ($1, $2, $3)`,
    [tenantId, cardiology, branchA],
  );

  const userId = await createUser(`${label}-doctor`);
  const fixture = { tenantId, branchA, branchB, cardiology, neurology, userId };
  fixtures.push(fixture);
  return fixture;
}

/** Walks Drizzle's error `cause` chain to the underlying PostgreSQL SQLSTATE. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(sqlState(error)).toBe(code);
    return;
  }

  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}

let beta: Fixture;

beforeAll(async () => {
  // A second hospital used as the "other tenant" in isolation checks.
  await createFixture("alpha");
  beta = await createFixture("beta");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

function newDoctorInput(fixture: Fixture, overrides: Partial<NewDoctor> = {}): NewDoctor {
  const suffix = randomUUID().slice(0, 8);

  return {
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    doctorCode: `DOC-${suffix}`,
    registrationNumber: `REG-${suffix}`,
    ...overrides,
  };
}

describe("doctor schema", () => {
  it("stores a complete profile with defaults, JSONB languages and timestamps", async () => {
    const fixture = await createFixture("profile");
    const input = newDoctorInput(fixture, {
      registrationCouncil: "State Medical Council",
      qualification: "MD, DM (Cardiology)",
      specialization: "Cardiology",
      experienceYears: 14,
      biography: "Interventional cardiologist.",
      profileImageUrl: "https://cdn.example.test/doctors/profile.png",
      consultationLanguage: ["en", "hi"],
    });

    const [created] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(input).returning(),
    );

    expect(created).toMatchObject({
      tenantId: fixture.tenantId,
      userId: fixture.userId,
      doctorCode: input.doctorCode,
      registrationNumber: input.registrationNumber,
      registrationCouncil: "State Medical Council",
      experienceYears: 14,
      consultationLanguage: ["en", "hi"],
      isActive: true,
      deletedAt: null,
    });
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);

    // No authentication material lives on the clinical profile.
    const columnNames = Object.values(getTableColumns(doctors)).map((column) => column.name);
    expect(columnNames).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/password|credential|token|secret/i)]),
    );
  });

  it("prevents two doctor profiles for the same user inside one tenant", async () => {
    const fixture = await createFixture("duplicate-user");

    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctors).values(newDoctorInput(fixture)),
        ),
      "23505",
    );

    // The same global user may hold a doctor profile in another hospital.
    const [otherTenantProfile] = await withTenantTransaction(beta.tenantId, (tx) =>
      tx
        .insert(doctors)
        .values(newDoctorInput(beta, { userId: fixture.userId }))
        .returning(),
    );
    expect(otherTenantProfile?.tenantId).toBe(beta.tenantId);
    expect(otherTenantProfile?.userId).toBe(fixture.userId);
  });

  it("prevents duplicate doctor codes per tenant and keeps them reserved after soft delete", async () => {
    const fixture = await createFixture("duplicate-code");
    const secondDoctorUser = await createUser("duplicate-code-second");
    const code = `DOC-${randomUUID().slice(0, 8)}`;

    const [existing] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture, { doctorCode: code })).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx
            .insert(doctors)
            .values(newDoctorInput(fixture, { userId: secondDoctorUser, doctorCode: code })),
        ),
      "23505",
    );

    // Soft deleting a profile does not release its code (clinical documents
    // keep referring to it), so a plain unique index - not a partial one.
    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .update(doctors)
        .set({ deletedAt: new Date() })
        .where(eq(doctors.id, existing!.id)),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx
            .insert(doctors)
            .values(newDoctorInput(fixture, { userId: secondDoctorUser, doctorCode: code })),
        ),
      "23505",
    );

    // Codes are only unique per tenant: another hospital may use the same one.
    const [otherTenant] = await withTenantTransaction(beta.tenantId, (tx) =>
      tx
        .insert(doctors)
        .values(newDoctorInput(beta, { userId: secondDoctorUser, doctorCode: code }))
        .returning(),
    );
    expect(otherTenant?.doctorCode).toBe(code);
  });

  it("assigns a doctor to multiple departments and rejects duplicate assignments", async () => {
    const fixture = await createFixture("departments");
    const [doctor] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)).returning(),
    );

    const links = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(doctorDepartments)
        .values([
          { tenantId: fixture.tenantId, doctorId: doctor!.id, departmentId: fixture.cardiology },
          { tenantId: fixture.tenantId, doctorId: doctor!.id, departmentId: fixture.neurology },
        ])
        .returning(),
    );

    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.departmentId))).toEqual(
      new Set([fixture.cardiology, fixture.neurology]),
    );
    expect(links[0]?.createdAt).toBeInstanceOf(Date);

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctorDepartments).values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            departmentId: fixture.cardiology,
          }),
        ),
      "23505",
    );
  });

  it("assigns a doctor to multiple branches with a per-branch fee", async () => {
    const fixture = await createFixture("branches");
    const [doctor] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)).returning(),
    );

    const assignments = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(doctorBranches)
        .values([
          {
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: fixture.branchA,
            consultationFee: "150.25",
            currency: "USD",
          },
          {
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: fixture.branchB,
            consultationFee: "175.00",
          },
        ])
        .returning(),
    );

    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.consultationFee).toBe("150.25");
    expect(assignments[1]?.currency).toBe("USD");
    expect(assignments[1]?.isActive).toBe(true);

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctorBranches).values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: fixture.branchA,
            consultationFee: "99.00",
          }),
        ),
      "23505",
    );
  });

  it("rejects cross-tenant department and branch references", async () => {
    const fixture = await createFixture("cross-tenant");
    const [doctor] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)).returning(),
    );

    // Tenant A doctor -> Tenant B department.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctorDepartments).values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            departmentId: beta.cardiology,
          }),
        ),
      "23503",
    );

    // Tenant A doctor -> Tenant B branch.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctorBranches).values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: beta.branchA,
            consultationFee: "100.00",
          }),
        ),
      "23503",
    );

    // Tenant A branch id paired with Tenant B tenant id is also impossible.
    await expectSqlState(
      () =>
        withTenantTransaction(beta.tenantId, (tx) =>
          tx.insert(doctorBranches).values({
            tenantId: beta.tenantId,
            doctorId: doctor!.id,
            branchId: beta.branchA,
            consultationFee: "100.00",
          }),
        ),
      "23503",
    );
  });

  it("hides doctors and their assignments from another tenant's context (RLS)", async () => {
    const fixture = await createFixture("rls");
    const [doctor] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)).returning(),
    );
    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctorBranches).values({
        tenantId: fixture.tenantId,
        doctorId: doctor!.id,
        branchId: fixture.branchA,
        consultationFee: "80.00",
      }),
    );

    const visibleToOther = await withTenantTransaction(beta.tenantId, (tx) =>
      tx.select({ id: doctors.id }).from(doctors),
    );
    const otherBranchRows = await withTenantTransaction(beta.tenantId, (tx) =>
      tx.select({ id: doctorBranches.id }).from(doctorBranches),
    );

    expect(visibleToOther.some((row) => row.id === doctor!.id)).toBe(false);
    expect(otherBranchRows).toHaveLength(0);

    // The owning tenant still sees its own row in the same pooled process.
    const visibleToOwner = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.select({ id: doctors.id }).from(doctors),
    );
    expect(visibleToOwner.some((row) => row.id === doctor!.id)).toBe(true);
  });

  it("rejects a negative consultation fee", async () => {
    const fixture = await createFixture("negative-fee");
    const [doctor] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(doctors).values(newDoctorInput(fixture)).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(doctorBranches).values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: fixture.branchA,
            consultationFee: "-0.01",
          }),
        ),
      "23514",
    );

    // Zero is allowed (unpaid / honorary clinics).
    await expect(
      withTenantTransaction(fixture.tenantId, (tx) =>
        tx
          .insert(doctorBranches)
          .values({
            tenantId: fixture.tenantId,
            doctorId: doctor!.id,
            branchId: fixture.branchA,
            consultationFee: "0.00",
          })
          .returning({ id: doctorBranches.id }),
      ),
    ).resolves.toHaveLength(1);
  });

  it("rejects invalid experience values while allowing unknown experience", async () => {
    const fixture = await createFixture("experience");

    for (const experienceYears of [-1, 71, 1000]) {
      await expectSqlState(
        () =>
          withTenantTransaction(fixture.tenantId, (tx) =>
            tx
              .insert(doctors)
              .values(newDoctorInput(fixture, { experienceYears })),
          ),
        "23514",
      );
    }

    const [withoutExperience] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(doctors)
        .values(newDoctorInput(fixture, { experienceYears: null }))
        .returning(),
    );
    expect(withoutExperience?.experienceYears).toBeNull();
  });

  it("applies migrations that expose the reviewed doctor schema and indexes", async () => {
    const pool = getTestAdminPool();

    const expectedColumns: Record<string, string[]> = {
      doctors: Object.values(getTableColumns(doctors)).map((column) => column.name),
      doctor_departments: Object.values(getTableColumns(doctorDepartments)).map(
        (column) => column.name,
      ),
      doctor_branches: Object.values(getTableColumns(doctorBranches)).map(
        (column) => column.name,
      ),
    };

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [table],
      );
      expect(rows.map((row) => row.column_name).sort()).toEqual([...columns].sort());
    }

    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and tablename in ('doctors', 'doctor_departments', 'doctor_branches')`,
    );
    const indexNames = new Set(indexRows.map((row) => row.indexname));

    for (const name of [
      "doctors_tenant_code_unique",
      "doctors_tenant_user_unique",
      "doctors_tenant_registration_unique",
      "doctor_departments_unique",
      "doctor_branches_doctor_branch_unique",
      "doctor_departments_department_idx",
      "doctor_branches_branch_active_idx",
      "doctor_branches_doctor_active_idx",
    ]) {
      expect(indexNames).toContain(name);
    }

    // Every generated migration is recorded as applied.
    const journal = JSON.parse(
      readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: unknown[] };
    const { rows: appliedRows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    expect(Number(appliedRows[0]?.count)).toBe(journal.entries.length);

    // RLS stays enabled and forced on all doctor tables.
    const { rows: rlsRows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('doctors', 'doctor_departments', 'doctor_branches')`,
    );
    expect(rlsRows).toHaveLength(3);
    for (const row of rlsRows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Branch and department tables remain intact after the doctor migrations.
    const { rows: legacyRows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_name in ('branches', 'departments', 'department_branches')`,
    );
    expect(Number(legacyRows[0]?.count)).toBe(3);
  });
});
