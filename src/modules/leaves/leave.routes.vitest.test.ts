import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for Task 16.5 leave endpoints. The service suite covers the
 * workflow rules; these tests prove routing, Zod validation (including the
 * rejection of client-supplied approval metadata), actor context, RBAC, tenant
 * isolation and service error propagation.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; code?: string; message?: string }>;
  };
}

interface LeaveShape {
  id: string;
  doctorId: string;
  branchId: string | null;
  isAllBranches: boolean;
  startAt: string;
  endAt: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  branch: { id: string; timezone: string } | null;
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function leaveOf(response: TestResponse): LeaveShape {
  return dataOf<{ leave: LeaveShape }>(response).leave;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

let api: TestApi;
let otherApi: TestApi;
let tenantSlug: string;
let tenantId: string;
let branchA: string;
let branchB: string;
let doctorId: string;
let doctorEmail: string;
let adminUserId: string;
let otherDoctorId: string;
let otherLeaveId: string;
let otherAdminEmail: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@leave-api.test`;

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'leave-routes-test-hash')`,
    [id, label, email],
  );

  createdUserIds.push(id);
  return { id, email };
}

/** Creates a real account through the auth endpoint so it can sign in later. */
async function registerUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@leave-api.test`;
  const client = await createTestApi(createApp());

  try {
    const response = await client.post(`${API}/auth/register`, {
      body: { fullName: label, email, password: PASSWORD },
    });
    expect(response.status).toBe(201);

    const id = dataOf<{ user: { id: string } }>(response).user.id;
    createdUserIds.push(id);
    return { id, email };
  } finally {
    await client.close();
  }
}

async function addMembership(
  tenant: string,
  userId: string,
  roleSlug?: string,
): Promise<void> {
  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenant, userId],
  );

  if (roleSlug !== undefined) {
    await getTestAdminPool().query(
      `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
       select m.tenant_id, m.id, r.id
       from tenant_memberships m
       join roles r on r.tenant_id = m.tenant_id and r.slug = $3
       where m.tenant_id = $1 and m.user_id = $2`,
      [tenant, userId, roleSlug],
    );
  }
}

async function createMemberUser(
  tenant: string,
  label: string,
  roleSlug?: string,
): Promise<{ id: string; email: string }> {
  const user = await createUser(label);
  await addMembership(tenant, user.id, roleSlug);

  return user;
}

async function loginAs(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function selectTenant(client: TestApi, slug: string): Promise<void> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  expect(response.status).toBe(200);
}

async function registerTenant(
  client: TestApi,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await client.post(`${API}/tenants/register`, { body: { name } });
  expect(response.status).toBe(201);

  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(response).tenant;
  createdTenantIds.push(tenant.id);
  await getTestAdminPool().query("update tenants set status = 'ACTIVE' where id = $1", [
    tenant.id,
  ]);

  return tenant;
}

async function createDoctor(
  tenant: string,
  branchIds: readonly string[],
  userId: string,
  suffix: string,
  code: string,
): Promise<string> {
  const doctorId = randomUUID();
  const pool = getTestAdminPool();

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5)`,
    [doctorId, tenant, userId, `${code}-${suffix}`, `REG-${code}-${suffix}`],
  );

  for (const branchId of branchIds) {
    await pool.query(
      `insert into doctor_branches (tenant_id, doctor_id, branch_id)
       values ($1, $2, $3)`,
      [tenant, doctorId, branchId],
    );
  }

  return doctorId;
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@leave-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Leave Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Leave API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  const me = await api.get(`${API}/auth/me`);
  expect(me.status).toBe(200);
  adminUserId = dataOf<{ user: { id: string } }>(me).user.id;

  branchA = randomUUID();
  branchB = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Riverside', $5, 'Europe/London')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  const doctorUser = await registerUser(`doctor-${suffix}`);
  await addMembership(tenantId, doctorUser.id, "doctor");
  doctorEmail = doctorUser.email;
  doctorId = await createDoctor(tenantId, [branchA], doctorUser.id, suffix, "DOC-A");

  otherAdminEmail = `other-admin-${suffix}@leave-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Leave Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Leave API ${suffix}`);
  await selectTenant(otherApi, otherTenant.slug);

  const otherBranch = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Foreign Branch', $3, 'UTC')`,
    [otherBranch, otherTenant.id, `FOR-${suffix}`],
  );

  const otherDoctorUser = await createMemberUser(otherTenant.id, `other-doctor-${suffix}`);
  otherDoctorId = await createDoctor(
    otherTenant.id,
    [otherBranch],
    otherDoctorUser.id,
    suffix,
    "DOC-F",
  );

  const otherLeave = await otherApi.post(`${API}/doctor-leaves`, {
    body: {
      doctorId: otherDoctorId,
      startAt: "2026-07-01T09:00:00Z",
      endAt: "2026-07-02T18:00:00Z",
    },
  });
  expect(otherLeave.status).toBe(201);
  otherLeaveId = leaveOf(otherLeave).id;
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const id of createdTenantIds) {
    await pool.query("delete from tenants where id = $1", [id]);
  }
  for (const id of createdUserIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  await api.close();
  await otherApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("doctor leave routes", () => {
  let allBranchLeaveId: string;
  let branchLeaveId: string;
  let rejectedLeaveId: string;
  let cancelledLeaveId: string;

  it("creates an all-branch leave request as PENDING for the verified actor", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        branchId: null,
        startAt: "2026-02-02T09:00:00+05:30",
        endAt: "2026-02-04T18:00:00+05:30",
        reason: " Family medical leave ",
      },
    });

    expect(created.status).toBe(201);
    const leave = leaveOf(created);

    expect(leave.status).toBe("PENDING");
    expect(leave.branchId).toBeNull();
    expect(leave.isAllBranches).toBe(true);
    expect(leave.reason).toBe("Family medical leave");
    // The offset-aware input instant is preserved exactly.
    expect(new Date(leave.startAt).toISOString()).toBe("2026-02-02T03:30:00.000Z");
    expect(new Date(leave.endAt).toISOString()).toBe("2026-02-04T12:30:00.000Z");
    expect(leave.createdBy).toBe(adminUserId);
    expect(leave.approvedBy).toBeNull();
    expect(leave.approvedAt).toBeNull();

    allBranchLeaveId = leave.id;

    const fetched = await api.get(`${API}/doctor-leaves/${leave.id}`);
    expect(fetched.status).toBe(200);
    expect(leaveOf(fetched).id).toBe(leave.id);
  });

  it("creates a branch-scoped leave request", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        branchId: branchA,
        startAt: "2026-03-02T09:00:00+05:30",
        endAt: "2026-03-03T18:00:00+05:30",
      },
    });

    expect(created.status).toBe(201);
    const leave = leaveOf(created);

    expect(leave.branchId).toBe(branchA);
    expect(leave.isAllBranches).toBe(false);
    expect(leave.branch?.timezone).toBe("Asia/Kolkata");

    branchLeaveId = leave.id;
  });

  it("lists leave requests with filters and pagination", async () => {
    const listed = await api.get(
      `${API}/doctor-leaves?doctorId=${doctorId}&branchId=${branchA}&status=PENDING&startDate=2026-03-01&endDate=2026-03-31&limit=10`,
    );
    expect(listed.status).toBe(200);

    const body = listed.body as Envelope<{ leaves: LeaveShape[] }>;
    expect(body.data.leaves.map((leave) => leave.id)).toEqual([branchLeaveId]);
    expect(body.meta?.pagination).toMatchObject({
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });

    const all = await api.get(`${API}/doctor-leaves?doctorId=${doctorId}`);
    expect(dataOf<{ leaves: LeaveShape[] }>(all).leaves).toHaveLength(2);

    const february = await api.get(
      `${API}/doctor-leaves?doctorId=${doctorId}&startDate=2026-02-01&endDate=2026-02-28`,
    );
    expect(dataOf<{ leaves: LeaveShape[] }>(february).leaves.map((leave) => leave.id)).toEqual([
      allBranchLeaveId,
    ]);

    const unknownStatus = await api.get(`${API}/doctor-leaves?status=MAYBE`);
    expect(unknownStatus.status).toBe(422);

    const reversedRange = await api.get(
      `${API}/doctor-leaves?startDate=2026-05-01&endDate=2026-04-01`,
    );
    expect(reversedRange.status).toBe(422);

    const badLimit = await api.get(`${API}/doctor-leaves?limit=0`);
    expect(badLimit.status).toBe(422);
  });

  it("updates a pending leave request and rejects edits after approval", async () => {
    const updated = await api.patch(`${API}/doctor-leaves/${branchLeaveId}`, {
      body: {
        endAt: "2026-03-04T18:00:00+05:30",
        branchId: null,
        reason: "Extended leave",
      },
    });
    expect(updated.status).toBe(200);

    expect(leaveOf(updated)).toMatchObject({
      branchId: null,
      isAllBranches: true,
      reason: "Extended leave",
    });
    expect(new Date(leaveOf(updated).endAt).toISOString()).toBe("2026-03-04T12:30:00.000Z");

    // Only startAt is supplied; the service validates the resulting interval.
    const reversed = await api.patch(`${API}/doctor-leaves/${branchLeaveId}`, {
      body: { startAt: "2026-03-10T09:00:00Z" },
    });
    expect(reversed.status).toBe(422);
    expect(errorOf(reversed).code).toBe("VALIDATION_ERROR");

    const approved = await api.patch(`${API}/doctor-leaves/${branchLeaveId}/approve`);
    expect(approved.status).toBe(200);

    const editAfterApproval = await api.patch(`${API}/doctor-leaves/${branchLeaveId}`, {
      body: { reason: "Too late" },
    });
    expect(editAfterApproval.status).toBe(409);
    expect(errorOf(editAfterApproval).code).toBe("CONFLICT");
  });

  it("approves a pending request with the verified actor", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        branchId: branchA,
        startAt: "2026-04-06T09:00:00+05:30",
        endAt: "2026-04-07T18:00:00+05:30",
      },
    });
    expect(created.status).toBe(201);
    const leaveId = leaveOf(created).id;

    const approved = await api.patch(`${API}/doctor-leaves/${leaveId}/approve`);
    expect(approved.status).toBe(200);

    const leave = leaveOf(approved);
    expect(leave.status).toBe("APPROVED");
    expect(leave.approvedBy).toBe(adminUserId);
    expect(leave.approvedAt).not.toBeNull();

    const secondApproval = await api.patch(`${API}/doctor-leaves/${leaveId}/approve`);
    expect(secondApproval.status).toBe(409);
  });

  it("rejects a pending request with a required reason", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-05-04T09:00:00Z",
        endAt: "2026-05-05T18:00:00Z",
      },
    });
    expect(created.status).toBe(201);
    rejectedLeaveId = leaveOf(created).id;

    const missingReason = await api.patch(`${API}/doctor-leaves/${rejectedLeaveId}/reject`, {
      body: {},
    });
    expect(missingReason.status).toBe(422);

    const rejected = await api.patch(`${API}/doctor-leaves/${rejectedLeaveId}/reject`, {
      body: { rejectionReason: "  Coverage unavailable  " },
    });
    expect(rejected.status).toBe(200);

    expect(leaveOf(rejected)).toMatchObject({
      status: "REJECTED",
      rejectedBy: adminUserId,
      rejectionReason: "Coverage unavailable",
    });

    const secondRejection = await api.patch(`${API}/doctor-leaves/${rejectedLeaveId}/reject`, {
      body: { rejectionReason: "Again" },
    });
    expect(secondRejection.status).toBe(409);
  });

  it("cancels a pending request and refuses to cancel terminal states", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-06-01T09:00:00Z",
        endAt: "2026-06-02T18:00:00Z",
      },
    });
    expect(created.status).toBe(201);
    cancelledLeaveId = leaveOf(created).id;

    const cancelled = await api.patch(`${API}/doctor-leaves/${cancelledLeaveId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(leaveOf(cancelled).status).toBe("CANCELLED");

    const again = await api.patch(`${API}/doctor-leaves/${cancelledLeaveId}/cancel`);
    expect(again.status).toBe(409);

    const cancelRejected = await api.patch(`${API}/doctor-leaves/${rejectedLeaveId}/cancel`);
    expect(cancelRejected.status).toBe(409);
  });

  it("rejects invalid date-time values", async () => {
    const noOffset = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-08-03T09:00:00",
        endAt: "2026-08-04T18:00:00Z",
      },
    });
    expect(noOffset.status).toBe(422);
    expect(errorOf(noOffset).code).toBe("VALIDATION_ERROR");

    const impossibleInstant = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-13-03T09:00:00Z",
        endAt: "2026-13-04T18:00:00Z",
      },
    });
    expect(impossibleInstant.status).toBe(422);

    const reversed = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-08-05T09:00:00Z",
        endAt: "2026-08-04T18:00:00Z",
      },
    });
    expect(reversed.status).toBe(422);

    const equal = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-08-05T09:00:00Z",
        endAt: "2026-08-05T09:00:00Z",
      },
    });
    expect(equal.status).toBe(422);

    const badFilter = await api.get(`${API}/doctor-leaves?startDate=2026-02-30`);
    expect(badFilter.status).toBe(422);
  });

  it("never accepts client-controlled workflow or approval metadata", async () => {
    const base = {
      doctorId,
      startAt: "2026-09-01T09:00:00Z",
      endAt: "2026-09-02T18:00:00Z",
    };

    const attempted = [
      { status: "APPROVED" },
      { createdBy: adminUserId },
      { approvedBy: adminUserId },
      { approvedAt: "2026-01-01T00:00:00Z" },
      { rejectedBy: adminUserId },
      { rejectionReason: "self-rejected" },
      { approvedByUser: { id: adminUserId } },
    ];

    for (const extra of attempted) {
      const response = await api.post(`${API}/doctor-leaves`, {
        body: { ...base, ...extra },
      });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }

    // The same protection applies to later updates.
    const created = await api.post(`${API}/doctor-leaves`, { body: base });
    expect(created.status).toBe(201);
    const leaveId = leaveOf(created).id;

    const updateAttempt = await api.patch(`${API}/doctor-leaves/${leaveId}`, {
      body: { status: "APPROVED", approvedBy: adminUserId },
    });
    expect(updateAttempt.status).toBe(422);

    const rejectAttempt = await api.patch(`${API}/doctor-leaves/${leaveId}/reject`, {
      body: { rejectionReason: "No cover", status: "CANCELLED" },
    });
    expect(rejectAttempt.status).toBe(422);
  });

  it("propagates service conflict errors", async () => {
    const overlap = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2026-02-03T09:00:00Z",
        endAt: "2026-02-03T18:00:00Z",
      },
    });
    expect(overlap.status).toBe(409);
    expect(errorOf(overlap).code).toBe("CONFLICT");

    const unknownDoctor = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId: randomUUID(),
        startAt: "2026-10-01T09:00:00Z",
        endAt: "2026-10-02T18:00:00Z",
      },
    });
    expect(unknownDoctor.status).toBe(404);
  });

  it("isolates leave requests by tenant and requires verified context", async () => {
    const otherRead = await api.get(`${API}/doctor-leaves/${otherLeaveId}`);
    expect(otherRead.status).toBe(404);

    const crossUpdate = await api.patch(`${API}/doctor-leaves/${otherLeaveId}`, {
      body: { reason: "hijack" },
    });
    expect(crossUpdate.status).toBe(404);

    const crossApprove = await api.patch(`${API}/doctor-leaves/${otherLeaveId}/approve`);
    expect(crossApprove.status).toBe(404);

    const foreignDoctor = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId: otherDoctorId,
        startAt: "2026-11-01T09:00:00Z",
        endAt: "2026-11-02T18:00:00Z",
      },
    });
    expect(foreignDoctor.status).toBe(404);

    const anonymous = await createTestApi(createApp());

    try {
      const unauthorized = await anonymous.get(`${API}/doctor-leaves`);
      expect(unauthorized.status).toBe(401);

      const unauthorizedCreate = await anonymous.post(`${API}/doctor-leaves`, {
        body: {
          doctorId,
          startAt: "2026-12-01T09:00:00Z",
          endAt: "2026-12-02T18:00:00Z",
        },
      });
      expect(unauthorizedCreate.status).toBe(401);
    } finally {
      await anonymous.close();
    }

    const noTenant = await createTestApi(createApp());
    const { email } = await registerUser("no-tenant-leave");

    try {
      await loginAs(noTenant, email);
      const noContext = await noTenant.get(`${API}/doctor-leaves`);
      expect(noContext.status).toBe(403);
    } finally {
      await noTenant.close();
    }
  });

  it("allows a doctor to request their own leave without schedule permission", async () => {
    const doctorClient = await createTestApi(createApp());

    try {
      await loginAs(doctorClient, doctorEmail);
      await selectTenant(doctorClient, tenantSlug);

      const created = await doctorClient.post(`${API}/doctor-leaves`, {
        body: {
          doctorId,
          branchId: branchA,
          startAt: "2027-01-04T09:00:00+05:30",
          endAt: "2027-01-05T18:00:00+05:30",
          reason: "Personal",
        },
      });
      expect(created.status).toBe(201);
      expect(leaveOf(created).createdBy).not.toBe(adminUserId);

      // A doctor has doctor.leave.create/update/cancel but not
      // doctor.leave.approve, so approval is rejected by the route guard
      // before any business logic runs.
      const approve = await doctorClient.patch(
        `${API}/doctor-leaves/${leaveOf(created).id}/approve`,
      );
      expect(approve.status).toBe(403);
    } finally {
      await doctorClient.close();
    }
  });
});
