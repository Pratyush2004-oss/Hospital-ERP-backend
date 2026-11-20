import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for Task 16.5 schedule and break endpoints. Service suites
 * cover the business rules; these tests prove routing, Zod validation, RBAC,
 * tenant isolation and service error propagation through the real middleware
 * stack.
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
    details?: Array<{ path?: string; code?: string }>;
  };
}

interface ScheduleShape {
  id: string;
  doctorId: string;
  branchId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  isActive: boolean;
  branch: { id: string; timezone: string };
}

interface BreakShape {
  id: string;
  scheduleId: string;
  startTime: string;
  endTime: string;
  reason: string | null;
  schedule: { id: string; startTime: string; endTime: string; timezone: string };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

let api: TestApi;
let otherApi: TestApi;
let tenantId: string;
let tenantSlug: string;
let branchA: string;
let branchB: string;
let doctorId: string;
let doctorEmail: string;
let otherBranch: string;
let otherDoctorId: string;
let adminEmail: string;
let otherAdminEmail: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@scheduling-api.test`;

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'scheduling-routes-test-hash')`,
    [id, label, email],
  );

  createdUserIds.push(id);
  return { id, email };
}

/** Creates a real account through the auth endpoint so it can sign in later. */
async function registerUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@scheduling-api.test`;
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
  user: { id: string },
  suffix: string,
  code: string,
): Promise<string> {
  const doctorId = randomUUID();
  const pool = getTestAdminPool();

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5)`,
    [doctorId, tenant, user.id, `${code}-${suffix}`, `REG-${code}-${suffix}`],
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

  adminEmail = `admin-${suffix}@scheduling-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Scheduling Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Scheduling API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

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
  doctorId = await createDoctor(tenantId, [branchA], doctorUser, suffix, "DOC-A");

  // A second hospital, used for cross-tenant access checks.
  otherAdminEmail = `other-admin-${suffix}@scheduling-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Scheduling Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Scheduling API ${suffix}`);
  await selectTenant(otherApi, otherTenant.slug);

  otherBranch = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Foreign Branch', $3, 'UTC')`,
    [otherBranch, otherTenant.id, `FOR-${suffix}`],
  );

  const otherDoctorUser = await createMemberUser(otherTenant.id, `other-doctor-${suffix}`);
  otherDoctorId = await createDoctor(
    otherTenant.id,
    [otherBranch],
    otherDoctorUser,
    suffix,
    "DOC-F",
  );
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

describe("doctor schedule routes", () => {
  let mainScheduleId: string;
  let secondScheduleId: string;

  it("creates a schedule and normalizes branch-local times", async () => {
    const created = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "13:00",
        slotDurationMinutes: 20,
        bufferMinutes: 5,
        effectiveFrom: "2026-01-05",
        effectiveUntil: "2026-12-31",
        isActive: true,
      },
    });

    expect(created.status).toBe(201);
    const schedule = dataOf<{ schedule: ScheduleShape }>(created).schedule;

    expect(schedule).toMatchObject({
      doctorId,
      branchId: branchA,
      dayOfWeek: 1,
      startTime: "09:00:00",
      endTime: "13:00:00",
      slotDurationMinutes: 20,
      bufferMinutes: 5,
      effectiveFrom: "2026-01-05",
      effectiveUntil: "2026-12-31",
      isActive: true,
    });
    // Times stay wall-clock; the branch zone is returned alongside them.
    expect(schedule.branch.timezone).toBe("Asia/Kolkata");

    mainScheduleId = schedule.id;

    const fetched = await api.get(`${API}/doctor-schedules/${schedule.id}`);
    expect(fetched.status).toBe(200);
    expect(dataOf<{ schedule: ScheduleShape }>(fetched).schedule.id).toBe(schedule.id);
  });

  it("rejects invalid schedule payloads before reaching the service", async () => {
    const invalidUuid = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId: "not-a-uuid",
        branchId: branchA,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "13:00",
      },
    });
    expect(invalidUuid.status).toBe(422);
    expect(errorOf(invalidUuid).code).toBe("VALIDATION_ERROR");

    const badWeekday = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 8,
        startTime: "09:00",
        endTime: "13:00",
      },
    });
    expect(badWeekday.status).toBe(422);

    const badTime = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "9:00",
        endTime: "13:00",
      },
    });
    expect(badTime.status).toBe(422);

    const reversed = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "13:00",
        endTime: "09:00",
      },
    });
    expect(reversed.status).toBe(422);

    const badEffectiveDate = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "13:00",
        effectiveFrom: "2026-02-30",
      },
    });
    expect(badEffectiveDate.status).toBe(422);

    const reversedEffectiveRange = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "13:00",
        effectiveFrom: "2026-06-01",
        effectiveUntil: "2026-01-01",
      },
    });
    expect(reversedEffectiveRange.status).toBe(422);

    const negativeBuffer = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "13:00",
        bufferMinutes: -1,
      },
    });
    expect(negativeBuffer.status).toBe(422);
  });

  it("propagates service business errors", async () => {
    // Doctor is not assigned to branchB.
    const wrongBranch = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchB,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "13:00",
      },
    });
    expect(wrongBranch.status).toBe(400);
    expect(errorOf(wrongBranch).code).toBe("BAD_REQUEST");

    const overlap = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 1,
        startTime: "10:00",
        endTime: "12:00",
        effectiveFrom: "2026-01-05",
        effectiveUntil: "2026-12-31",
      },
    });
    expect(overlap.status).toBe(409);
    expect(errorOf(overlap).code).toBe("CONFLICT");

    const unknownDoctor = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId: randomUUID(),
        branchId: branchA,
        dayOfWeek: 4,
        startTime: "09:00",
        endTime: "13:00",
      },
    });
    expect(unknownDoctor.status).toBe(404);
  });

  it("lists schedules with filters and pagination metadata", async () => {
    const second = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "14:00",
        endTime: "18:00",
        effectiveFrom: "2026-01-05",
      },
    });
    expect(second.status).toBe(201);
    secondScheduleId = dataOf<{ schedule: ScheduleShape }>(second).schedule.id;

    const listed = await api.get(
      `${API}/doctor-schedules?doctorId=${doctorId}&branchId=${branchA}&dayOfWeek=1&isActive=true&effectiveDate=2026-03-02&limit=5`,
    );
    expect(listed.status).toBe(200);

    const body = listed.body as Envelope<{ schedules: ScheduleShape[] }>;
    expect(body.data.schedules.map((schedule) => schedule.id)).toEqual([mainScheduleId]);
    expect(body.meta?.pagination).toMatchObject({
      page: 1,
      pageSize: 5,
      total: 1,
      totalPages: 1,
    });

    const byDay = await api.get(`${API}/doctor-schedules?doctorId=${doctorId}&dayOfWeek=2`);
    expect(dataOf<{ schedules: ScheduleShape[] }>(byDay).schedules).toHaveLength(1);

    const notEffective = await api.get(
      `${API}/doctor-schedules?effectiveDate=2027-01-01&doctorId=${doctorId}`,
    );
    expect(dataOf<{ schedules: ScheduleShape[] }>(notEffective).schedules).toHaveLength(1);

    const badLimit = await api.get(`${API}/doctor-schedules?limit=101`);
    expect(badLimit.status).toBe(422);

    const badFilterUuid = await api.get(`${API}/doctor-schedules?doctorId=nope`);
    expect(badFilterUuid.status).toBe(422);
  });

  it("updates a schedule and validates the complete resulting window", async () => {
    const updated = await api.patch(`${API}/doctor-schedules/${mainScheduleId}`, {
      body: { startTime: "10:00", endTime: "14:00", bufferMinutes: 10 },
    });
    expect(updated.status).toBe(200);

    expect(dataOf<{ schedule: ScheduleShape }>(updated).schedule).toMatchObject({
      startTime: "10:00:00",
      endTime: "14:00:00",
      bufferMinutes: 10,
      effectiveFrom: "2026-01-05",
    });

    // Only the start is supplied; the service validates the resulting window.
    const inconsistent = await api.patch(`${API}/doctor-schedules/${mainScheduleId}`, {
      body: { startTime: "15:00" },
    });
    expect(inconsistent.status).toBe(422);
    expect(errorOf(inconsistent).code).toBe("VALIDATION_ERROR");

    const empty = await api.patch(`${API}/doctor-schedules/${mainScheduleId}`, { body: {} });
    expect(empty.status).toBe(422);

    const badRange = await api.patch(`${API}/doctor-schedules/${mainScheduleId}`, {
      body: { effectiveUntil: "2025-12-31" },
    });
    expect(badRange.status).toBe(422);
  });

  it("toggles schedule status and re-checks overlaps on reactivation", async () => {
    const deactivated = await api.patch(`${API}/doctor-schedules/${mainScheduleId}/status`, {
      body: { isActive: false },
    });
    expect(deactivated.status).toBe(200);
    expect(dataOf<{ schedule: ScheduleShape }>(deactivated).schedule.isActive).toBe(false);

    // Same slot as the deactivated window is now free.
    const replacement = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 1,
        startTime: "10:00",
        endTime: "14:00",
        effectiveFrom: "2026-01-05",
        effectiveUntil: "2026-12-31",
      },
    });
    expect(replacement.status).toBe(201);

    // Reactivating the old window now conflicts with the replacement.
    const reactivated = await api.patch(`${API}/doctor-schedules/${mainScheduleId}/status`, {
      body: { isActive: true },
    });
    expect(reactivated.status).toBe(409);
    expect(errorOf(reactivated).code).toBe("CONFLICT");

    // Second window is unaffected and can still be toggled.
    const toggled = await api.patch(`${API}/doctor-schedules/${secondScheduleId}/status`, {
      body: { isActive: false },
    });
    expect(toggled.status).toBe(200);
    expect(dataOf<{ schedule: ScheduleShape }>(toggled).schedule.isActive).toBe(false);
  });

  it("enforces route permissions from the verified actor", async () => {
    const doctorClient = await createTestApi(createApp());

    try {
      await loginAs(doctorClient, doctorEmail);
      await selectTenant(doctorClient, tenantSlug);

      const listed = await doctorClient.get(`${API}/doctor-schedules`);
      expect(listed.status).toBe(200);

      const create = await doctorClient.post(`${API}/doctor-schedules`, {
        body: {
          doctorId,
          branchId: branchA,
          dayOfWeek: 5,
          startTime: "09:00",
          endTime: "13:00",
        },
      });
      expect(create.status).toBe(403);
    } finally {
      await doctorClient.close();
    }
  });

  it("isolates schedules between tenants and requires tenant context", async () => {
    const crossRead = await api.get(`${API}/doctor-schedules/${secondScheduleId}`);
    const otherRead = await otherApi.get(`${API}/doctor-schedules/${secondScheduleId}`);
    expect(crossRead.status).toBe(200);
    expect(otherRead.status).toBe(404);

    const listed = await otherApi.get(`${API}/doctor-schedules?doctorId=${doctorId}`);
    expect(listed.status).toBe(200);
    expect(dataOf<{ schedules: ScheduleShape[] }>(listed).schedules).toHaveLength(0);

    const anonymous = await createTestApi(createApp());

    try {
      const unauthorized = await anonymous.get(`${API}/doctor-schedules`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await anonymous.close();
    }

    // Authenticated but without a selected hospital.
    const noTenant = await createTestApi(createApp());
    const { email } = await registerUser("no-tenant-scheduling");

    try {
      await loginAs(noTenant, email);
      const noContext = await noTenant.get(`${API}/doctor-schedules`);
      expect(noContext.status).toBe(403);
    } finally {
      await noTenant.close();
    }

    // A foreign doctor cannot be scheduled in this tenant.
    const foreignDoctor = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId: otherDoctorId,
        branchId: branchA,
        dayOfWeek: 6,
        startTime: "09:00",
        endTime: "13:00",
      },
    });
    expect(foreignDoctor.status).toBe(404);
  });
});

describe("doctor break routes", () => {
  let breakScheduleId: string;
  let breakId: string;

  beforeAll(async () => {
    const schedule = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchA,
        dayOfWeek: 7,
        startTime: "08:00",
        endTime: "12:00",
        effectiveFrom: "2026-01-05",
      },
    });
    expect(schedule.status).toBe(201);
    breakScheduleId = dataOf<{ schedule: ScheduleShape }>(schedule).schedule.id;
  });

  it("creates a break inside its schedule window", async () => {
    const created = await api.post(`${API}/doctor-breaks`, {
      body: {
        scheduleId: breakScheduleId,
        startTime: "09:00",
        endTime: "09:15",
        reason: " Morning huddle ",
      },
    });

    expect(created.status).toBe(201);
    const doctorBreak = dataOf<{ break: BreakShape }>(created).break;

    expect(doctorBreak).toMatchObject({
      scheduleId: breakScheduleId,
      startTime: "09:00:00",
      endTime: "09:15:00",
      reason: "Morning huddle",
    });
    expect(doctorBreak.schedule.timezone).toBe("Asia/Kolkata");

    breakId = doctorBreak.id;

    const fetched = await api.get(`${API}/doctor-breaks/${doctorBreak.id}`);
    expect(fetched.status).toBe(200);
    expect(dataOf<{ break: BreakShape }>(fetched).break.id).toBe(doctorBreak.id);

    const listed = await api.get(
      `${API}/doctor-breaks?scheduleId=${breakScheduleId}&doctorId=${doctorId}&branchId=${branchA}&limit=10`,
    );
    expect(listed.status).toBe(200);

    const body = listed.body as Envelope<{ breaks: BreakShape[] }>;
    expect(body.data.breaks.map((item) => item.id)).toEqual([doctorBreak.id]);
    expect(body.meta?.pagination).toMatchObject({ total: 1, page: 1, pageSize: 10 });
  });

  it("rejects breaks outside the window, out of order or with invalid input", async () => {
    const reversed = await api.post(`${API}/doctor-breaks`, {
      body: {
        scheduleId: breakScheduleId,
        startTime: "10:00",
        endTime: "09:00",
      },
    });
    expect(reversed.status).toBe(422);

    const outsideWindow = await api.post(`${API}/doctor-breaks`, {
      body: {
        scheduleId: breakScheduleId,
        startTime: "07:00",
        endTime: "07:30",
      },
    });
    expect(outsideWindow.status).toBe(422);
    expect(errorOf(outsideWindow).code).toBe("UNPROCESSABLE_ENTITY");

    const overlap = await api.post(`${API}/doctor-breaks`, {
      body: {
        scheduleId: breakScheduleId,
        startTime: "09:10",
        endTime: "09:20",
      },
    });
    expect(overlap.status).toBe(409);
    expect(errorOf(overlap).code).toBe("CONFLICT");

    const longReason = await api.post(`${API}/doctor-breaks`, {
      body: {
        scheduleId: breakScheduleId,
        startTime: "10:00",
        endTime: "10:15",
        reason: "x".repeat(256),
      },
    });
    expect(longReason.status).toBe(422);

    const badScheduleId = await api.post(`${API}/doctor-breaks`, {
      body: { scheduleId: "not-a-uuid", startTime: "10:00", endTime: "10:15" },
    });
    expect(badScheduleId.status).toBe(422);

    const unknownSchedule = await api.post(`${API}/doctor-breaks`, {
      body: { scheduleId: randomUUID(), startTime: "10:00", endTime: "10:15" },
    });
    expect(unknownSchedule.status).toBe(404);
  });

  it("updates and deletes a break", async () => {
    const updated = await api.patch(`${API}/doctor-breaks/${breakId}`, {
      body: { startTime: "09:30", endTime: "09:45", reason: null },
    });
    expect(updated.status).toBe(200);

    expect(dataOf<{ break: BreakShape }>(updated).break).toMatchObject({
      startTime: "09:30:00",
      endTime: "09:45:00",
      reason: null,
    });

    // Resulting interval is validated against the parent window.
    const invalid = await api.patch(`${API}/doctor-breaks/${breakId}`, {
      body: { endTime: "13:00" },
    });
    expect(invalid.status).toBe(422);

    const empty = await api.patch(`${API}/doctor-breaks/${breakId}`, { body: {} });
    expect(empty.status).toBe(422);

    const removed = await api.delete(`${API}/doctor-breaks/${breakId}`);
    expect(removed.status).toBe(204);

    const gone = await api.get(`${API}/doctor-breaks/${breakId}`);
    expect(gone.status).toBe(404);

    // Deletion is idempotent.
    const removedAgain = await api.delete(`${API}/doctor-breaks/${breakId}`);
    expect(removedAgain.status).toBe(204);
  });

  it("rejects breaks on an inactive schedule", async () => {
    const deactivated = await api.patch(
      `${API}/doctor-schedules/${breakScheduleId}/status`,
      { body: { isActive: false } },
    );
    expect(deactivated.status).toBe(200);

    const created = await api.post(`${API}/doctor-breaks`, {
      body: { scheduleId: breakScheduleId, startTime: "09:00", endTime: "09:15" },
    });
    expect(created.status).toBe(400);
    expect(errorOf(created).code).toBe("BAD_REQUEST");
  });

  it("requires authentication and a hospital context", async () => {
    const anonymous = await createTestApi(createApp());

    try {
      const unauthorized = await anonymous.get(`${API}/doctor-breaks`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await anonymous.close();
    }
  });
});
