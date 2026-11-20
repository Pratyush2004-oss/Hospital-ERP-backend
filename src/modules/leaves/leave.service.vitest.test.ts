import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import {
  approveDoctorLeave,
  cancelDoctorLeave,
  createDoctorLeave,
  getDoctorLeaveById,
  listDoctorLeaves,
  rejectDoctorLeave,
  updateDoctorLeave,
} from "./leave.service.js";
import type { DoctorLeaveActorContext } from "./leave.types.js";

/**
 * Service-level tests for Task 16.4. Writes run as the restricted
 * `hospitalos_app` role inside tenant-scoped transactions, so RLS, the
 * composite branch FK and the leave integrity CHECKs are exercised against the
 * real schema. Fixtures use the admin connection only to create tenants,
 * branches, users, memberships and doctor assignments.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly adminId: string;
  readonly branchAdminId: string;
  readonly doctorAId: string;
  readonly doctorBId: string;
  readonly doctorAUserId: string;
  readonly doctorBUserId: string;
  readonly staffUserId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

const ADMIN_PERMISSIONS = new Set([
  "doctor.leave.create",
  "doctor.leave.read",
  "doctor.leave.update",
  "doctor.leave.approve",
  "doctor.leave.reject",
  "doctor.leave.cancel",
  "doctor:update",
  "doctor:read",
]);
const NO_PERMISSIONS = new Set<string>();

async function createUser(label: string): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'leave-service-test-hash')`,
    [id, label, `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}@leaves.test`],
  );

  createdUserIds.push(id);
  return id;
}

async function createMember(tenantId: string, label: string): Promise<string> {
  const userId = await createUser(label);

  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenantId, userId],
  );

  return userId;
}

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Riverside', $5, 'Europe/London')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  const adminId = await createMember(tenantId, `${label} Admin`);
  const branchAdminId = await createMember(tenantId, `${label} Branch Admin`);
  const doctorAUserId = await createMember(tenantId, `${label} Dr Alice`);
  const doctorBUserId = await createMember(tenantId, `${label} Dr Bob`);
  const staffUserId = await createMember(tenantId, `${label} Receptionist`);

  const doctorAId = randomUUID();
  const doctorBId = randomUUID();

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $9)`,
    [
      doctorAId,
      tenantId,
      doctorAUserId,
      `DOC-A-${suffix}`,
      `REG-A-${suffix}`,
      doctorBId,
      doctorBUserId,
      `DOC-B-${suffix}`,
      `REG-B-${suffix}`,
    ],
  );

  // Doctor A works at both branches; doctor B only at Central.
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id)
     values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
    [tenantId, doctorAId, branchA, branchB, doctorBId],
  );

  const fixture = {
    tenantId,
    branchA,
    branchB,
    adminId,
    branchAdminId,
    doctorAId,
    doctorBId,
    doctorAUserId,
    doctorBUserId,
    staffUserId,
  };
  fixtures.push(fixture);
  return fixture;
}

function adminActor(fixture: Fixture): DoctorLeaveActorContext {
  return {
    userId: fixture.adminId,
    permissions: ADMIN_PERMISSIONS,
    roles: ["hospital_admin"],
  };
}

function branchAdminActor(fixture: Fixture): DoctorLeaveActorContext {
  return {
    userId: fixture.branchAdminId,
    permissions: ADMIN_PERMISSIONS,
    roles: ["branch_admin"],
  };
}

/** The doctor's own account. Alice additionally holds scheduling permission. */
function aliceActor(fixture: Fixture): DoctorLeaveActorContext {
  return {
    userId: fixture.doctorAUserId,
    permissions: ADMIN_PERMISSIONS,
    roles: ["doctor"],
  };
}

function bobActor(fixture: Fixture): DoctorLeaveActorContext {
  return { userId: fixture.doctorBUserId, permissions: NO_PERMISSIONS, roles: ["doctor"] };
}

function staffActor(fixture: Fixture): DoctorLeaveActorContext {
  return { userId: fixture.staffUserId, permissions: NO_PERMISSIONS, roles: ["receptionist"] };
}

const at = (day: number, hour: number): string =>
  new Date(Date.UTC(2026, 2, day, hour)).toISOString();

function request(
  fixture: Fixture,
  overrides: {
    doctorId?: string;
    branchId?: string | null;
    startAt?: string;
    endAt?: string;
    reason?: string | null;
  } = {},
) {
  return {
    doctorId: fixture.doctorAId,
    branchId: fixture.branchA,
    startAt: at(2, 9),
    endAt: at(2, 13),
    reason: "Family event",
    ...overrides,
  };
}

function createLeave(
  fixture: Fixture,
  overrides: Parameters<typeof request>[1] = {},
  actor: DoctorLeaveActorContext = adminActor(fixture),
) {
  return createDoctorLeave(fixture.tenantId, request(fixture, overrides), actor);
}

async function setTenantSetting(
  tenantId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await getTestAdminPool().query(
    `insert into tenant_settings (tenant_id, setting_key, setting_value)
     values ($1, $2, $3::jsonb)`,
    [tenantId, key, JSON.stringify(value)],
  );
}

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

describe("doctor leave service", () => {
  it("creates a branch-specific request and records the verified author", async () => {
    const fixture = await createFixture("create");

    const created = await createLeave(fixture, {
      reason: "  Family event  ",
    });

    expect(created).toMatchObject({
      doctorId: fixture.doctorAId,
      branchId: fixture.branchA,
      isAllBranches: false,
      status: "PENDING",
      createdBy: fixture.adminId,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      reason: "Family event",
    });
    expect(created.startAt).toEqual(new Date(at(2, 9)));
    expect(created.endAt).toEqual(new Date(at(2, 13)));
    expect(created.doctor).toMatchObject({
      id: fixture.doctorAId,
      isActive: true,
      doctorCode: expect.stringContaining("DOC-A-"),
    });
    expect(created.branch).toMatchObject({
      id: fixture.branchA,
      name: "Central",
      timezone: "Asia/Kolkata",
    });
    expect(created.requestedBy).toMatchObject({ id: fixture.adminId });
    expect(created.requestedBy).not.toHaveProperty("email");
    expect(created.approvedByUser).toBeNull();
  });

  it("allows a doctor to request leave for their own profile with no admin permission", async () => {
    const fixture = await createFixture("branch");

    const created = await createLeave(
      fixture,
      {
        doctorId: fixture.doctorBId,
        branchId: fixture.branchA,
        startAt: at(9, 9),
        endAt: at(9, 17),
      },
      bobActor(fixture),
    );

    expect(created).toMatchObject({
      doctorId: fixture.doctorBId,
      branchId: fixture.branchA,
      status: "PENDING",
      createdBy: fixture.doctorBUserId,
    });
  });

  it("supports all-branch leave when branchId is omitted or null", async () => {
    const fixture = await createFixture("all-branch");

    const omitted = await createLeave(fixture, { branchId: undefined, startAt: at(4, 0), endAt: at(6, 0) });
    const explicitNull = await createLeave(fixture, {
      startAt: at(9, 0),
      endAt: at(10, 0),
      branchId: null,
    });

    for (const leave of [omitted, explicitNull]) {
      expect(leave.branchId).toBeNull();
      expect(leave.isAllBranches).toBe(true);
      expect(leave.branch).toBeNull();
    }
  });

  it("rejects invalid intervals, timestamps and doctors", async () => {
    const fixture = await createFixture("invalid");

    await expect(
      createLeave(fixture, { startAt: at(3, 9), endAt: at(3, 9) }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createLeave(fixture, { startAt: at(3, 12), endAt: at(3, 9) }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createLeave(fixture, { startAt: "2026-03-02T09:00:00", endAt: at(2, 13) }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createLeave(fixture, { startAt: "not-a-date", endAt: at(2, 13) }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Doctor B is not assigned to Riverside.
    await expect(
      createLeave(fixture, {
        doctorId: fixture.doctorBId,
        branchId: fixture.branchB,
        startAt: at(2, 9),
        endAt: at(2, 13),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // An inactive doctor cannot accrue new leave.
    await getTestAdminPool().query("update doctors set is_active = false where id = $1", [
      fixture.doctorBId,
    ]);

    await expect(
      createLeave(fixture, {
        doctorId: fixture.doctorBId,
        startAt: at(2, 14),
        endAt: at(2, 15),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects overlapping leave for the same branch, including against approved leave", async () => {
    const fixture = await createFixture("conflict");

    const approved = await createLeave(fixture, {
      startAt: at(2, 0),
      endAt: at(4, 0),
      reason: "Conference",
    });
    await approveDoctorLeave(fixture.tenantId, approved.id, adminActor(fixture));

    await expect(
      createLeave(fixture, { startAt: at(3, 9), endAt: at(3, 12) }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      details: { leaveId: approved.id, branchId: fixture.branchA },
    });

    // Half-open semantics: adjacent intervals are allowed.
    const adjacent = await createLeave(fixture, {
      startAt: at(4, 0),
      endAt: at(5, 0),
    });
    expect(adjacent.status).toBe("PENDING");
  });

  it("permits branch-specific leave at another branch while blocking the same branch", async () => {
    const fixture = await createFixture("branch-conflict");

    const approvedCentral = await createLeave(fixture, {
      branchId: fixture.branchA,
      startAt: at(2, 0),
      endAt: at(4, 0),
    });
    await approveDoctorLeave(fixture.tenantId, approvedCentral.id, adminActor(fixture));

    const riverside = await createLeave(fixture, {
      branchId: fixture.branchB,
      startAt: at(3, 0),
      endAt: at(4, 0),
    });
    expect(riverside.branchId).toBe(fixture.branchB);

    await expect(
      createLeave(fixture, {
        branchId: fixture.branchA,
        startAt: at(3, 0),
        endAt: at(4, 0),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("treats all-branch leave as conflicting with every branch in both directions", async () => {
    const fixture = await createFixture("all-branch-conflict");

    const allBranches = await createLeave(fixture, {
      branchId: null,
      startAt: at(2, 0),
      endAt: at(4, 0),
    });
    await approveDoctorLeave(fixture.tenantId, allBranches.id, adminActor(fixture));

    await expect(
      createLeave(fixture, {
        branchId: fixture.branchB,
        startAt: at(3, 0),
        endAt: at(3, 6),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Reverse direction: an existing branch leave blocks a new all-branch row.
    const branchLeave = await createLeave(fixture, {
      branchId: fixture.branchB,
      startAt: at(9, 0),
      endAt: at(11, 0),
    });
    await approveDoctorLeave(fixture.tenantId, branchLeave.id, adminActor(fixture));

    await expect(
      createLeave(fixture, {
        branchId: null,
        startAt: at(10, 0),
        endAt: at(12, 0),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Different branches on non-overlapping dates remain independent.
    const independent = await createLeave(fixture, {
      branchId: fixture.branchB,
      startAt: at(14, 0),
      endAt: at(15, 0),
    });
    expect(independent.status).toBe("PENDING");
  });

  it("approves pending branch leave and records the approver", async () => {
    const fixture = await createFixture("approve");
    const created = await createLeave(fixture, { startAt: at(2, 9), endAt: at(2, 12) });

    const approved = await approveDoctorLeave(
      fixture.tenantId,
      created.id,
      branchAdminActor(fixture),
    );

    expect(approved).toMatchObject({
      id: created.id,
      status: "APPROVED",
      approvedBy: fixture.branchAdminId,
    });
    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect(approved.approvedByUser).toMatchObject({
      id: fixture.branchAdminId,
      fullName: expect.stringContaining("Branch Admin"),
    });

    await expect(
      approveDoctorLeave(fixture.tenantId, created.id, adminActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not let a branch administrator review all-branch leave", async () => {
    const fixture = await createFixture("branch-admin-scope");
    const created = await createLeave(fixture, {
      branchId: null,
      startAt: at(2, 0),
      endAt: at(3, 0),
    });

    await expect(
      approveDoctorLeave(fixture.tenantId, created.id, branchAdminActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 403 });

    const stillPending = await getDoctorLeaveById(fixture.tenantId, created.id);
    expect(stillPending.status).toBe("PENDING");

    // Hospital admins may review all-branch leave.
    const approved = await approveDoctorLeave(
      fixture.tenantId,
      created.id,
      adminActor(fixture),
    );
    expect(approved.status).toBe("APPROVED");
  });

  it("rejects pending leave with a reason without overwriting the leave reason", async () => {
    const fixture = await createFixture("reject");
    const created = await createLeave(fixture, { reason: "Medical appointment" });

    const rejected = await rejectDoctorLeave(
      fixture.tenantId,
      created.id,
      adminActor(fixture),
      "  Staffing shortage that week  ",
    );

    expect(rejected).toMatchObject({
      status: "REJECTED",
      reason: "Medical appointment",
      rejectionReason: "Staffing shortage that week",
      rejectedBy: fixture.adminId,
    });
    expect(rejected.rejectedAt).toBeInstanceOf(Date);
    expect(rejected.rejectedByUser).toMatchObject({ id: fixture.adminId });

    await expect(
      rejectDoctorLeave(fixture.tenantId, created.id, adminActor(fixture), "Again"),
    ).rejects.toMatchObject({ statusCode: 409 });

    const second = await createLeave(fixture, {
      startAt: at(9, 0),
      endAt: at(10, 0),
    });

    await expect(
      rejectDoctorLeave(fixture.tenantId, second.id, adminActor(fixture), "   "),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("cancels pending and approved leave, but not terminal requests", async () => {
    const fixture = await createFixture("cancel");

    const own = await createLeave(
      fixture,
      { doctorId: fixture.doctorBId, branchId: fixture.branchA, startAt: at(2, 9), endAt: at(2, 11) },
      bobActor(fixture),
    );

    // A doctor may cancel their own pending request.
    const ownCancelled = await cancelDoctorLeave(
      fixture.tenantId,
      own.id,
      bobActor(fixture),
    );
    expect(ownCancelled.status).toBe("CANCELLED");

    await expect(
      cancelDoctorLeave(fixture.tenantId, own.id, bobActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    const approved = await createLeave(fixture, {
      startAt: at(9, 0),
      endAt: at(10, 0),
    });
    await approveDoctorLeave(fixture.tenantId, approved.id, adminActor(fixture));

    const cancelled = await cancelDoctorLeave(
      fixture.tenantId,
      approved.id,
      adminActor(fixture),
    );
    expect(cancelled.status).toBe("CANCELLED");
    // Approval metadata is preserved as history.
    expect(cancelled.approvedBy).toBe(fixture.adminId);

    const rejected = await createLeave(fixture, {
      startAt: at(16, 0),
      endAt: at(17, 0),
    });
    await rejectDoctorLeave(fixture.tenantId, rejected.id, adminActor(fixture), "No cover");

    await expect(
      cancelDoctorLeave(fixture.tenantId, rejected.id, adminActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("blocks approval from an actor without leave management permission", async () => {
    const fixture = await createFixture("unauthorized");
    const created = await createLeave(fixture);

    await expect(
      approveDoctorLeave(fixture.tenantId, created.id, staffActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect((await getDoctorLeaveById(fixture.tenantId, created.id)).status).toBe(
      "PENDING",
    );
  });

  it("prevents self-approval unless the tenant policy allows it", async () => {
    const fixture = await createFixture("self-approval");
    const created = await createLeave(fixture, {}, aliceActor(fixture));

    await expect(
      approveDoctorLeave(fixture.tenantId, created.id, aliceActor(fixture)),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect((await getDoctorLeaveById(fixture.tenantId, created.id)).status).toBe(
      "PENDING",
    );

    await setTenantSetting(fixture.tenantId, "doctor_leave.allow_self_approval", true);

    const approved = await approveDoctorLeave(
      fixture.tenantId,
      created.id,
      aliceActor(fixture),
    );
    expect(approved).toMatchObject({
      status: "APPROVED",
      approvedBy: fixture.doctorAUserId,
    });
  });

  it("updates a pending request and rechecks conflicts", async () => {
    const fixture = await createFixture("update");
    const created = await createLeave(fixture, {
      startAt: at(2, 9),
      endAt: at(2, 11),
      reason: "Check-up",
    });
    const blocker = await createLeave(fixture, {
      branchId: fixture.branchB,
      startAt: at(9, 0),
      endAt: at(10, 0),
    });

    const updated = await updateDoctorLeave(
      fixture.tenantId,
      created.id,
      {
        startAt: at(3, 9),
        endAt: at(3, 12),
        reason: "  Specialist visit  ",
        branchId: null,
      },
      adminActor(fixture),
    );

    expect(updated).toMatchObject({
      startAt: new Date(at(3, 9)),
      endAt: new Date(at(3, 12)),
      reason: "Specialist visit",
      branchId: null,
      isAllBranches: true,
      status: "PENDING",
    });

    // Changing scope to all branches now collides with the Riverside leave.
    await expect(
      updateDoctorLeave(
        fixture.tenantId,
        created.id,
        { branchId: null, startAt: at(9, 0), endAt: at(11, 0) },
        adminActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, details: { leaveId: blocker.id } });

    await expect(
      updateDoctorLeave(
        fixture.tenantId,
        created.id,
        { endAt: at(1, 0) },
        adminActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Omitted fields are preserved; null clears the branch scope deliberately.
    const partial = await updateDoctorLeave(
      fixture.tenantId,
      created.id,
      { reason: null },
      adminActor(fixture),
    );
    expect(partial.reason).toBeNull();
    expect(partial.branchId).toBeNull();
  });

  it("refuses to edit leave that is no longer pending", async () => {
    const fixture = await createFixture("update-status");

    const approved = await createLeave(fixture, {
      startAt: at(2, 9),
      endAt: at(2, 10),
    });
    await approveDoctorLeave(fixture.tenantId, approved.id, adminActor(fixture));

    await expect(
      updateDoctorLeave(
        fixture.tenantId,
        approved.id,
        { reason: "Changed" },
        adminActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await getDoctorLeaveById(fixture.tenantId, approved.id)).reason).toBe(
      "Family event",
    );

    const rejected = await createLeave(fixture, {
      startAt: at(9, 9),
      endAt: at(9, 10),
    });
    await rejectDoctorLeave(fixture.tenantId, rejected.id, adminActor(fixture), "No");

    await expect(
      updateDoctorLeave(
        fixture.tenantId,
        rejected.id,
        { reason: "Changed" },
        adminActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces tenant isolation on read, update, approval and listing", async () => {
    const fixture = await createFixture("tenant-a");
    const other = await createFixture("tenant-b");
    const created = await createLeave(fixture);

    await expect(
      getDoctorLeaveById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctorLeave(
        other.tenantId,
        created.id,
        { reason: "Hijack" },
        adminActor(other),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      approveDoctorLeave(other.tenantId, created.id, adminActor(other)),
    ).rejects.toMatchObject({ statusCode: 404 });

    const foreignList = await listDoctorLeaves(other.tenantId);
    expect(foreignList.total).toBe(0);

    // The owner's record is untouched.
    const reloaded = await getDoctorLeaveById(fixture.tenantId, created.id);
    expect(reloaded).toMatchObject({ status: "PENDING", reason: "Family event" });
  });

  it("serializes concurrent conflicting requests", async () => {
    const fixture = await createFixture("concurrent");

    const attempts = await Promise.allSettled([
      createLeave(fixture, {
        branchId: null,
        startAt: at(2, 0),
        endAt: at(4, 0),
      }),
      createLeave(fixture, {
        branchId: fixture.branchB,
        startAt: at(3, 0),
        endAt: at(5, 0),
      }),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
    });

    const listed = await listDoctorLeaves(fixture.tenantId, {
      doctorId: fixture.doctorAId,
    });
    expect(listed.total).toBe(1);
  });

  it("filters, sorts and paginates leave without losing tenant scope", async () => {
    const fixture = await createFixture("list");

    const central = await createLeave(fixture, {
      branchId: fixture.branchA,
      startAt: at(20, 9),
      endAt: at(20, 12),
    });
    const allBranches = await createLeave(fixture, {
      branchId: null,
      startAt: at(10, 9),
      endAt: at(10, 12),
    });
    const otherDoctor = await createLeave(fixture, {
      doctorId: fixture.doctorBId,
      branchId: fixture.branchA,
      startAt: at(5, 9),
      endAt: at(5, 12),
    });
    await approveDoctorLeave(fixture.tenantId, otherDoctor.id, adminActor(fixture));

    const all = await listDoctorLeaves(fixture.tenantId, { pageSize: 2 });
    expect(all.total).toBe(3);
    expect(all.totalPages).toBe(2);
    expect(all.leaves.map((leave) => leave.startAt)).toEqual([
      new Date(at(5, 9)),
      new Date(at(10, 9)),
    ]);

    const allBranchOnly = await listDoctorLeaves(fixture.tenantId, {
      allBranches: true,
    });
    expect(allBranchOnly.leaves.map((leave) => leave.id)).toEqual([allBranches.id]);

    const approved = await listDoctorLeaves(fixture.tenantId, { status: "APPROVED" });
    expect(approved.leaves.map((leave) => leave.id)).toEqual([otherDoctor.id]);

    const centralOnly = await listDoctorLeaves(fixture.tenantId, {
      branchId: fixture.branchA,
      doctorId: fixture.doctorAId,
    });
    expect(centralOnly.leaves.map((leave) => leave.id)).toEqual([central.id]);

    const window = await listDoctorLeaves(fixture.tenantId, {
      startDate: "2026-03-19",
      endDate: "2026-03-21",
    });
    expect(window.leaves.map((leave) => leave.id)).toEqual([central.id]);

    const descending = await listDoctorLeaves(fixture.tenantId, {
      sortBy: "startAt",
      sortOrder: "desc",
    });
    expect(descending.leaves[0]?.id).toBe(central.id);

    await expect(
      listDoctorLeaves(fixture.tenantId, {
        branchId: fixture.branchA,
        allBranches: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
