import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import type { CreateDoctorInput } from "./doctor.types.js";
import {
  createDoctor,
  deleteDoctor,
  getDoctorById,
  listDoctors,
  updateDoctor,
  updateDoctorBranches,
  updateDoctorDepartments,
  updateDoctorStatus,
} from "./doctor.service.js";

/**
 * Service-level tests for Task 15.2. The service runs inside tenant-scoped
 * transactions as the restricted `hospitalos_app` role (RLS enforced); fixtures
 * are created with the admin connection, matching the department suite.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  /** Cardiology operates at Branch A only. */
  readonly cardiology: string;
  /** Neurology operates at Branch B only. */
  readonly neurology: string;
  /** Existing ACTIVE member of this hospital. */
  readonly userId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'doctor-service-test-hash')`,
    [id, `Dr. ${label}`, `${label}-${id.slice(0, 8)}@doctors.test`],
  );

  createdUserIds.push(id);
  return id;
}

async function createMemberUser(
  tenantId: string,
  label: string,
  status: "ACTIVE" | "INVITED" | "SUSPENDED" | "REMOVED" = "ACTIVE",
): Promise<string> {
  const userId = await createUser(label);

  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, $3::membership_status, $4::timestamptz)`,
    [tenantId, userId, status, status === "ACTIVE" ? new Date() : null],
  );

  return userId;
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

  await pool.query(
    `insert into department_branches (tenant_id, department_id, branch_id)
     values ($1, $2, $3), ($1, $4, $5)`,
    [tenantId, cardiology, branchA, neurology, branchB],
  );

  const userId = await createMemberUser(tenantId, `${label}-doctor`);

  const fixture = { tenantId, branchA, branchB, cardiology, neurology, userId };
  fixtures.push(fixture);
  return fixture;
}

function uniqueCode(prefix = "DOC"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function uniqueRegistration(): string {
  return `REG-${randomUUID().slice(0, 8)}`;
}

function newDoctor(
  fixture: Fixture,
  overrides: Partial<CreateDoctorInput> = {},
): CreateDoctorInput {
  return {
    userId: fixture.userId,
    doctorCode: uniqueCode(),
    registrationNumber: uniqueRegistration(),
    ...overrides,
  };
}

let other: Fixture;

beforeAll(async () => {
  // A second hospital used as the "other tenant" in isolation checks.
  await createFixture("alpha");
  other = await createFixture("beta");
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

describe("doctor service", () => {
  it("creates a doctor profile with departments, branches and safe user data", async () => {
    const fixture = await createFixture("create");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        doctorCode: " doc - 001 ",
        registrationNumber: "REG-001",
        registrationCouncil: "State Medical Council",
        qualification: "MD, DM (Cardiology)",
        specialization: "Cardiology",
        experienceYears: 14,
        biography: "Interventional cardiologist.",
        profileImageUrl: "https://cdn.example.test/doctor.png",
        consultationLanguage: ["EN", "hi", "en"],
        departmentIds: [fixture.cardiology],
        branches: [
          { branchId: fixture.branchA, consultationFee: "150.25", currency: "usd" },
        ],
      }),
    );

    // Codes are normalised to upper case, whitespace collapsed to a hyphen.
    expect(created.doctorCode).toBe("DOC-001");
    expect(created.registrationNumber).toBe("REG-001");
    expect(created.experienceYears).toBe(14);
    expect(created.consultationLanguage).toEqual(["en", "hi"]);
    expect(created.isActive).toBe(true);
    expect(created.departments.map((department) => department.id)).toEqual([
      fixture.cardiology,
    ]);
    expect(created.branches).toHaveLength(1);
    expect(created.branches[0]).toMatchObject({
      branchId: fixture.branchA,
      branchName: "Central",
      consultationFee: "150.25",
      currency: "USD",
      isActive: true,
    });

    expect(created.user).toMatchObject({
      id: fixture.userId,
      fullName: expect.any(String),
      email: expect.stringContaining("@doctors.test"),
      isActive: true,
    });
    // No credential material on the public shape.
    expect(created.user).not.toHaveProperty("passwordHash");
    expect(created).not.toHaveProperty("passwordHash");

    const fetched = await getDoctorById(fixture.tenantId, created.id);
    expect(fetched.id).toBe(created.id);
  });

  it("rejects a duplicate doctor profile for the same user in one tenant", async () => {
    const fixture = await createFixture("duplicate-profile");

    await createDoctor(fixture.tenantId, newDoctor(fixture, { doctorCode: "DUP-1" }));

    await expect(
      createDoctor(fixture.tenantId, newDoctor(fixture, { doctorCode: "DUP-2" })),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The same global user can hold a profile in another hospital, provided
    // they hold a membership there.
    await getTestAdminPool().query(
      `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
       values ($1, $2, 'ACTIVE', now())`,
      [other.tenantId, fixture.userId],
    );

    const elsewhere = await createDoctor(
      other.tenantId,
      newDoctor(other, { userId: fixture.userId, doctorCode: "DUP-3" }),
    );
    expect(elsewhere.user.id).toBe(fixture.userId);
    expect(elsewhere.id).not.toBe(undefined);
  });

  it("rejects duplicate doctor codes per tenant, case-insensitively", async () => {
    const fixture = await createFixture("duplicate-code");
    const secondUser = await createMemberUser(fixture.tenantId, "second-doctor");
    const code = uniqueCode("CASE");

    await createDoctor(fixture.tenantId, newDoctor(fixture, { doctorCode: code.toLowerCase() }));

    await expect(
      createDoctor(
        fixture.tenantId,
        newDoctor(fixture, { userId: secondUser, doctorCode: code }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Registration numbers are also per tenant only.
    const otherTenant = await createDoctor(
      other.tenantId,
      newDoctor(other, { doctorCode: code, registrationNumber: `REG-${code}` }),
    );
    expect(otherTenant.doctorCode).toBe(code.toUpperCase());
  });

  it("rejects users without an eligible membership in the tenant", async () => {
    const fixture = await createFixture("membership");

    const stranger = await createUser("stranger");

    await expect(
      createDoctor(fixture.tenantId, newDoctor(fixture, { userId: stranger })),
    ).rejects.toMatchObject({ statusCode: 400 });

    const invitedUserId = await createMemberUser(
      fixture.tenantId,
      "invited-doctor",
      "INVITED",
    );

    await expect(
      createDoctor(fixture.tenantId, newDoctor(fixture, { userId: invitedUserId })),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createDoctor(fixture.tenantId, newDoctor(fixture, { userId: randomUUID() })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates a doctor assigned to multiple departments", async () => {
    const fixture = await createFixture("multi-department");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        departmentIds: [fixture.cardiology, fixture.neurology, fixture.cardiology],
      }),
    );

    expect(created.departments).toHaveLength(2);
    expect(new Set(created.departments.map((department) => department.id))).toEqual(
      new Set([fixture.cardiology, fixture.neurology]),
    );
    expect(created.branches).toHaveLength(0);
  });

  it("creates a doctor assigned to multiple branches with per-branch fees", async () => {
    const fixture = await createFixture("multi-branch");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        departmentIds: [fixture.cardiology, fixture.neurology],
        branches: [
          { branchId: fixture.branchA, consultationFee: 120 },
          { branchId: fixture.branchB, consultationFee: "180.50", currency: "EUR" },
        ],
      }),
    );

    expect(created.branches).toHaveLength(2);
    expect(created.branches.map((branch) => branch.consultationFee)).toEqual([
      "120.00",
      "180.50",
    ]);
    expect(created.branches.map((branch) => branch.currency).sort()).toEqual(["EUR", "USD"]);
  });

  it("rejects a department that belongs to another tenant", async () => {
    const fixture = await createFixture("cross-department");

    await expect(
      createDoctor(
        fixture.tenantId,
        newDoctor(fixture, { departmentIds: [other.cardiology] }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a branch that belongs to another tenant", async () => {
    const fixture = await createFixture("cross-branch");

    await expect(
      createDoctor(
        fixture.tenantId,
        newDoctor(fixture, {
          departmentIds: [fixture.cardiology],
          branches: [{ branchId: other.branchA, consultationFee: "50.00" }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects department-branch combinations the doctor's departments do not cover", async () => {
    const fixture = await createFixture("coverage");

    // Cardiology only operates at Branch A, so Branch B is invalid here.
    await expect(
      createDoctor(
        fixture.tenantId,
        newDoctor(fixture, {
          departmentIds: [fixture.cardiology],
          branches: [{ branchId: fixture.branchB }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        departmentIds: [fixture.cardiology],
        branches: [{ branchId: fixture.branchA }],
      }),
    );

    await expect(
      updateDoctorBranches(fixture.tenantId, created.id, [{ branchId: fixture.branchB }]),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      updateDoctorDepartments(fixture.tenantId, created.id, [fixture.neurology]),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Branch-only profiles remain possible while no department is assigned.
    const branchOnlyUser = await createMemberUser(fixture.tenantId, "coverage-branch-only");
    const branchOnly = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        userId: branchOnlyUser,
        branches: [{ branchId: fixture.branchB }],
      }),
    );
    expect(branchOnly.branches).toHaveLength(1);
  });

  it("lists doctors with pagination metadata", async () => {
    const fixture = await createFixture("paging");
    const users = await Promise.all(
      [1, 2, 3].map((index) => createMemberUser(fixture.tenantId, `paging-${index}`)),
    );

    for (const [index, userId] of users.entries()) {
      await createDoctor(fixture.tenantId, {
        userId,
        doctorCode: `PAGE-${index}`,
        registrationNumber: `REG-PAGE-${index}`,
      });
    }

    const first = await listDoctors(fixture.tenantId, { page: 1, pageSize: 2 });
    expect(first.total).toBe(3);
    expect(first.totalPages).toBe(2);
    expect(first.doctors).toHaveLength(2);

    const second = await listDoctors(fixture.tenantId, { page: 2, pageSize: 2 });
    expect(second.doctors).toHaveLength(1);
    expect(second.total).toBe(3);
  });

  it("filters doctors by search, department, branch, status and specialization", async () => {
    const fixture = await createFixture("filters");
    const aliceUser = await createMemberUser(fixture.tenantId, "filters-alice");
    const bobUser = await createMemberUser(fixture.tenantId, "filters-bob");

    const alice = await createDoctor(fixture.tenantId, {
      userId: aliceUser,
      doctorCode: `CARD-${randomUUID().slice(0, 6)}`,
      registrationNumber: `REG-A-${randomUUID().slice(0, 6)}`,
      specialization: "Cardiology",
      departmentIds: [fixture.cardiology],
      branches: [{ branchId: fixture.branchA }],
    });

    const bob = await createDoctor(fixture.tenantId, {
      userId: bobUser,
      doctorCode: `NEU-${randomUUID().slice(0, 6)}`,
      registrationNumber: `REG-B-${randomUUID().slice(0, 6)}`,
      specialization: "Neurology",
      departmentIds: [fixture.neurology],
      branches: [{ branchId: fixture.branchB }],
    });

    const byName = await listDoctors(fixture.tenantId, { search: "alice" });
    expect(byName.doctors.map((doctor) => doctor.id)).toEqual([alice.id]);

    const byCode = await listDoctors(fixture.tenantId, { search: bob.doctorCode });
    expect(byCode.doctors.map((doctor) => doctor.id)).toEqual([bob.id]);

    const byRegistration = await listDoctors(fixture.tenantId, {
      search: alice.registrationNumber,
    });
    expect(byRegistration.doctors.map((doctor) => doctor.id)).toEqual([alice.id]);

    const byDepartment = await listDoctors(fixture.tenantId, {
      departmentId: fixture.cardiology,
    });
    expect(byDepartment.doctors.map((doctor) => doctor.id)).toEqual([alice.id]);

    const byBranch = await listDoctors(fixture.tenantId, { branchId: fixture.branchB });
    expect(byBranch.doctors.map((doctor) => doctor.id)).toEqual([bob.id]);

    const bySpecialization = await listDoctors(fixture.tenantId, {
      specialization: "cardiology",
    });
    expect(bySpecialization.doctors.map((doctor) => doctor.id)).toEqual([alice.id]);

    await updateDoctorStatus(fixture.tenantId, bob.id, false);
    const inactive = await listDoctors(fixture.tenantId, { isActive: false });
    expect(inactive.doctors.map((doctor) => doctor.id)).toEqual([bob.id]);

    const sorted = await listDoctors(fixture.tenantId, {
      sortBy: "doctorCode",
      sortOrder: "desc",
    });
    expect(sorted.doctors[0]?.id).toBe(bob.id);
  });

  it("returns doctor details with user, departments and branches", async () => {
    const fixture = await createFixture("details");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        departmentIds: [fixture.cardiology],
        branches: [{ branchId: fixture.branchA, consultationFee: "95.00" }],
      }),
    );

    const found = await getDoctorById(fixture.tenantId, created.id);
    expect(found.user.id).toBe(fixture.userId);
    expect(found.departments[0]?.name).toBe("Cardiology");
    expect(found.branches[0]?.branchCode).toContain("CEN-");

    await expect(
      getDoctorById(fixture.tenantId, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates professional fields and rejects duplicate codes", async () => {
    const fixture = await createFixture("update");
    const created = await createDoctor(fixture.tenantId, newDoctor(fixture));
    const reservedCode = uniqueCode("RESERVED");

    const otherDoctorUser = await createMemberUser(fixture.tenantId, "update-other");
    await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, { userId: otherDoctorUser, doctorCode: reservedCode }),
    );

    const updated = await updateDoctor(fixture.tenantId, created.id, {
      doctorCode: "NEW-CODE",
      registrationNumber: "REG-NEW",
      registrationCouncil: "National Council",
      qualification: "MBBS, MD",
      specialization: "Internal Medicine",
      experienceYears: 7,
      biography: "Updated biography",
      profileImageUrl: "https://cdn.example.test/new.png",
      consultationLanguage: ["en", "fr"],
    });

    expect(updated).toMatchObject({
      doctorCode: "NEW-CODE",
      registrationNumber: "REG-NEW",
      registrationCouncil: "National Council",
      experienceYears: 7,
      consultationLanguage: ["en", "fr"],
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    await expect(
      updateDoctor(fixture.tenantId, created.id, { doctorCode: reservedCode }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      updateDoctor(fixture.tenantId, created.id, { experienceYears: 99 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await deleteDoctor(fixture.tenantId, created.id);
    await expect(
      updateDoctor(fixture.tenantId, created.id, { qualification: "Ghost" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("replaces department assignments atomically", async () => {
    const fixture = await createFixture("departments-replace");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, { departmentIds: [fixture.cardiology] }),
    );

    const replaced = await updateDoctorDepartments(fixture.tenantId, created.id, [
      fixture.neurology,
      fixture.neurology,
    ]);
    expect(replaced.departments.map((department) => department.id)).toEqual([
      fixture.neurology,
    ]);

    const cleared = await updateDoctorDepartments(fixture.tenantId, created.id, []);
    expect(cleared.departments).toHaveLength(0);

    // Inactive departments cannot be assigned.
    await getTestAdminPool().query("update departments set is_active = false where id = $1", [
      fixture.cardiology,
    ]);
    await expect(
      updateDoctorDepartments(fixture.tenantId, created.id, [fixture.cardiology]),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      updateDoctorDepartments(fixture.tenantId, created.id, [other.neurology]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("replaces branch assignments atomically", async () => {
    const fixture = await createFixture("branches-replace");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, {
        departmentIds: [fixture.cardiology, fixture.neurology],
        branches: [{ branchId: fixture.branchA, consultationFee: "100.00" }],
      }),
    );

    const replaced = await updateDoctorBranches(fixture.tenantId, created.id, [
      { branchId: fixture.branchB, consultationFee: "125.00" },
      { branchId: fixture.branchA, consultationFee: "110.00" },
    ]);

    // Branch summaries are ordered by branch name (Central before Riverside).
    expect(replaced.branches.map((branch) => branch.branchId)).toEqual([
      fixture.branchA,
      fixture.branchB,
    ]);
    expect(replaced.branches.map((branch) => branch.consultationFee)).toEqual([
      "110.00",
      "125.00",
    ]);

    // Duplicate branch entries collapse to one assignment.
    const deduped = await updateDoctorBranches(fixture.tenantId, created.id, [
      { branchId: fixture.branchA, consultationFee: "10.00" },
      { branchId: fixture.branchA, consultationFee: "20.00" },
    ]);
    expect(deduped.branches).toHaveLength(1);
    expect(deduped.branches[0]?.consultationFee).toBe("20.00");

    await getTestAdminPool().query("update branches set is_active = false where id = $1", [
      fixture.branchB,
    ]);
    await expect(
      updateDoctorBranches(fixture.tenantId, created.id, [{ branchId: fixture.branchB }]),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      updateDoctorBranches(fixture.tenantId, created.id, [
        { branchId: other.branchB, consultationFee: "5.00" },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("validates consultation fees", async () => {
    const fixture = await createFixture("fees");
    const created = await createDoctor(
      fixture.tenantId,
      newDoctor(fixture, { departmentIds: [fixture.cardiology] }),
    );

    for (const consultationFee of ["-1.00", "10.999", "abc", "10000000000.00"]) {
      await expect(
        updateDoctorBranches(fixture.tenantId, created.id, [
          { branchId: fixture.branchA, consultationFee },
        ]),
      ).rejects.toMatchObject({ statusCode: 422 });
    }

    const free = await updateDoctorBranches(fixture.tenantId, created.id, [
      { branchId: fixture.branchA, consultationFee: "0" },
    ]);
    expect(free.branches[0]?.consultationFee).toBe("0.00");
  });

  it("activates and deactivates a doctor", async () => {
    const fixture = await createFixture("status");
    const created = await createDoctor(fixture.tenantId, newDoctor(fixture));

    const deactivated = await updateDoctorStatus(fixture.tenantId, created.id, false);
    expect(deactivated.isActive).toBe(false);

    const reactivated = await updateDoctorStatus(fixture.tenantId, created.id, true);
    expect(reactivated.isActive).toBe(true);
  });

  it("soft deletes a doctor without touching the global user", async () => {
    const fixture = await createFixture("delete");
    const created = await createDoctor(fixture.tenantId, newDoctor(fixture));

    await deleteDoctor(fixture.tenantId, created.id);

    await expect(
      getDoctorById(fixture.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const listed = await listDoctors(fixture.tenantId, {});
    expect(listed.doctors).toHaveLength(0);

    // Repeated deletion is a no-op.
    await expect(deleteDoctor(fixture.tenantId, created.id)).resolves.toBeUndefined();

    const { rows } = await getTestAdminPool().query(
      "select id from users where id = $1",
      [fixture.userId],
    );
    expect(rows).toHaveLength(1);

    await expect(
      deleteDoctor(fixture.tenantId, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps doctors isolated between tenants", async () => {
    const fixture = await createFixture("isolation");
    const created = await createDoctor(fixture.tenantId, newDoctor(fixture));

    await expect(
      getDoctorById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctor(other.tenantId, created.id, { qualification: "Hijacked" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctorStatus(other.tenantId, created.id, false),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deleteDoctor(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const otherList = await listDoctors(other.tenantId, {});
    expect(otherList.doctors.some((doctor) => doctor.id === created.id)).toBe(false);
  });
});
