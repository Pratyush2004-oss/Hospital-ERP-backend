import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { getPool } from "../../database/index.js";
import {
  doctorBreaks,
  doctorLeaves,
  doctorSchedules,
} from "../../database/schema/index.js";
import { seedTenantRbac } from "../rbac/rbac.seed.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * Task 16.6: scheduling RBAC, tenant isolation, RLS and consistency.
 *
 * These tests exercise the real HTTP stack (authentication, tenant context,
 * permission guards, services) and the restricted `hospitalos_app` role, so
 * they prove the security properties rather than just the happy path.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

const SCHEDULING_KEYS = [
  "schedule.create",
  "schedule.read",
  "schedule.update",
  "schedule.delete",
  "schedule.break.create",
  "schedule.break.read",
  "schedule.break.update",
  "schedule.break.delete",
  "doctor.leave.create",
  "doctor.leave.read",
  "doctor.leave.update",
  "doctor.leave.approve",
  "doctor.leave.reject",
  "doctor.leave.cancel",
] as const;

const DOCTOR_KEYS = [
  "schedule.read",
  "schedule.break.read",
  "doctor.leave.create",
  "doctor.leave.read",
  "doctor.leave.update",
  "doctor.leave.cancel",
] as const;

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

interface ScheduleShape {
  id: string;
  doctorId: string;
  branchId: string;
  isActive: boolean;
}

interface BreakShape {
  id: string;
  scheduleId: string;
}

interface LeaveShape {
  id: string;
  status: string;
  branchId: string | null;
}

interface RoleShape {
  id: string;
  slug: string;
  permissions: string[];
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

let api: TestApi;
let otherApi: TestApi;
let tenantId: string;
let tenantSlug: string;
let otherTenantId: string;
let branchA: string;
let branchB: string;
let otherBranch: string;
let doctorId: string;
let doctorUserId: string;
let secondDoctorId: string;
let otherDoctorId: string;
let scheduleId: string;
let breakId: string;
let leaveId: string;
let branchLeaveId: string;
let otherScheduleId: string;
let otherBreakId: string;
let otherLeaveId: string;
let receptionistEmail: string;
let doctorEmail: string;
let nurseEmail: string;
let customEmail: string;
let customMembershipId: string;
let branchAdminEmail: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

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

async function registerUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@scheduling-security.test`;
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
): Promise<string> {
  const result = await getTestAdminPool().query<{ id: string }>(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())
     returning id`,
    [tenant, userId],
  );

  const membershipId = result.rows[0]?.id;
  expect(membershipId).toBeTruthy();

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

  return membershipId!;
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

  const adminEmail = `admin-${suffix}@scheduling-security.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Security Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Scheduling Security ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  branchA = randomUUID();
  branchB = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Security Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Security Riverside', $5, 'Europe/London')`,
    [branchA, tenantId, `SEC-A-${suffix}`, branchB, `SEC-B-${suffix}`],
  );

  const doctorUser = await registerUser(`doctor-${suffix}`);
  doctorUserId = doctorUser.id;
  doctorEmail = doctorUser.email;
  await addMembership(tenantId, doctorUserId, "doctor");    doctorId = await createDoctor(
      tenantId,
      [branchA, branchB],
      doctorUserId,
      suffix,
      "SEC-DOC",
    );

  // A colleague used for cross-doctor leave authorization checks.
  const secondDoctorUser = await registerUser(`doctor-two-${suffix}`);
  await addMembership(tenantId, secondDoctorUser.id);
  secondDoctorId = await createDoctor(
    tenantId,
    [branchA],
    secondDoctorUser.id,
    suffix,
    "SEC-DOC-2",
  );

  const receptionist = await registerUser(`reception-${suffix}`);
  receptionistEmail = receptionist.email;
  await addMembership(tenantId, receptionist.id, "receptionist");

  const nurse = await registerUser(`nurse-${suffix}`);
  nurseEmail = nurse.email;
  await addMembership(tenantId, nurse.id, "nurse");

  const custom = await registerUser(`custom-${suffix}`);
  customEmail = custom.email;
  customMembershipId = await addMembership(tenantId, custom.id);

  const branchAdmin = await registerUser(`branch-admin-${suffix}`);
  branchAdminEmail = branchAdmin.email;
  await addMembership(tenantId, branchAdmin.id, "branch_admin");

  // A second hospital with its own scheduling data, used for isolation checks.
  const otherAdminEmail = `other-admin-${suffix}@scheduling-security.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Security Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Scheduling Security ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherBranch = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Foreign Security Branch', $3, 'UTC')`,
    [otherBranch, otherTenantId, `FOR-SEC-${suffix}`],
  );

  const otherDoctorUser = await registerUser(`other-doctor-${suffix}`);
  await addMembership(otherTenantId, otherDoctorUser.id);
  otherDoctorId = await createDoctor(
    otherTenantId,
    [otherBranch],
    otherDoctorUser.id,
    suffix,
    "SEC-FOR",
  );

  // Tenant A scheduling fixtures, created through the API as the admin.
  const schedule = await api.post(`${API}/doctor-schedules`, {
    body: {
      doctorId,
      branchId: branchA,
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "13:00",
      effectiveFrom: "2026-01-05",
      effectiveUntil: "2026-12-31",
    },
  });
  expect(schedule.status).toBe(201);
  scheduleId = dataOf<{ schedule: ScheduleShape }>(schedule).schedule.id;

  const doctorBreak = await api.post(`${API}/doctor-breaks`, {
    body: { scheduleId, startTime: "11:00", endTime: "11:15", reason: "Lunch" },
  });
  expect(doctorBreak.status).toBe(201);
  breakId = dataOf<{ break: BreakShape }>(doctorBreak).break.id;

  const leave = await api.post(`${API}/doctor-leaves`, {
    body: {
      doctorId,
      branchId: null,
      startAt: "2026-10-05T09:00:00Z",
      endAt: "2026-10-06T18:00:00Z",
    },
  });
  expect(leave.status).toBe(201);
  leaveId = dataOf<{ leave: LeaveShape }>(leave).leave.id;

  // Tenant B scheduling fixtures.
  const otherSchedule = await otherApi.post(`${API}/doctor-schedules`, {
    body: {
      doctorId: otherDoctorId,
      branchId: otherBranch,
      dayOfWeek: 3,
      startTime: "09:00",
      endTime: "13:00",
      effectiveFrom: "2026-01-05",
    },
  });
  expect(otherSchedule.status).toBe(201);
  otherScheduleId = dataOf<{ schedule: ScheduleShape }>(otherSchedule).schedule.id;

  const otherBreak = await otherApi.post(`${API}/doctor-breaks`, {
    body: { scheduleId: otherScheduleId, startTime: "10:00", endTime: "10:15" },
  });
  expect(otherBreak.status).toBe(201);
  otherBreakId = dataOf<{ break: BreakShape }>(otherBreak).break.id;

  const otherLeave = await otherApi.post(`${API}/doctor-leaves`, {
    body: {
      doctorId: otherDoctorId,
      startAt: "2026-11-02T09:00:00Z",
      endAt: "2026-11-03T18:00:00Z",
    },
  });
  expect(otherLeave.status).toBe(201);
  otherLeaveId = dataOf<{ leave: LeaveShape }>(otherLeave).leave.id;

  // A branch-specific leave for the branch-admin approval test.
  const branchLeave = await api.post(`${API}/doctor-leaves`, {
    body: {
      doctorId,
      branchId: branchA,
      startAt: "2026-10-19T09:00:00Z",
      endAt: "2026-10-20T18:00:00Z",
    },
  });
  expect(branchLeave.status).toBe(201);
  branchLeaveId = dataOf<{ leave: LeaveShape }>(branchLeave).leave.id;
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

describe("scheduling RBAC", () => {
  it("seeds the fine-grained scheduling permissions on the default roles", async () => {
    const response = await api.get(`${API}/tenant/roles`);
    expect(response.status).toBe(200);

    const roles = dataOf<{ roles: RoleShape[] }>(response).roles;
    const role = (slug: string) => {
      const found = roles.find((item) => item.slug === slug);
      expect(found, `${slug} role is seeded`).toBeDefined();
      return found!;
    };

    for (const slug of ["hospital_admin", "branch_admin"]) {
      expect(role(slug).permissions).toEqual(expect.arrayContaining([...SCHEDULING_KEYS]));
    }

    expect(role("doctor").permissions).toEqual(expect.arrayContaining([...DOCTOR_KEYS]));
    for (const denied of [
      "schedule.create",
      "schedule.update",
      "schedule.delete",
      "doctor.leave.approve",
      "doctor.leave.reject",
    ]) {
      expect(role("doctor").permissions).not.toContain(denied);
    }

    expect(role("receptionist").permissions).toEqual(
      expect.arrayContaining(["schedule.read", "schedule.break.read", "doctor.leave.read"]),
    );
    expect(role("receptionist").permissions).not.toContain("schedule.create");
    expect(role("receptionist").permissions).not.toContain("doctor.leave.approve");

    expect(role("nurse").permissions).toEqual(
      expect.arrayContaining(["schedule.read", "schedule.break.read"]),
    );
    expect(role("nurse").permissions).not.toContain("doctor.leave.approve");
    expect(role("nurse").permissions).not.toContain("doctor.leave.read");
  });

  it("lets a custom role receive the new scheduling permissions", async () => {
    const created = await api.post(`${API}/tenant/roles`, {
      body: { name: "Roster Viewer", permissions: ["schedule.read"] },
    });
    expect(created.status).toBe(201);
    const role = dataOf<{ role: RoleShape }>(created).role;
    expect(role.permissions).toEqual(["schedule.read"]);

    const assigned = await api.put(
      `${API}/tenant/memberships/${customMembershipId}/roles`,
      { body: { roleIds: [role.id] } },
    );
    expect(assigned.status).toBe(200);

    const custom = await createTestApi(createApp());

    try {
      await loginAs(custom, customEmail);
      await selectTenant(custom, tenantSlug);

      const listed = await custom.get(`${API}/doctor-schedules`);
      expect(listed.status).toBe(200);

      const denied = await custom.post(`${API}/doctor-schedules`, {
        body: {
          doctorId,
          branchId: branchA,
          dayOfWeek: 6,
          startTime: "09:00",
          endTime: "10:00",
          effectiveFrom: "2026-01-05",
        },
      });
      expect(denied.status).toBe(403);

      // Granting the create permission to the custom role takes effect without
      // a new session, because permissions are resolved per request.
      const granted = await api.put(`${API}/tenant/roles/${role.id}/permissions`, {
        body: { permissions: ["schedule.read", "schedule.create"] },
      });
      expect(granted.status).toBe(200);

      const allowed = await custom.post(`${API}/doctor-schedules`, {
        body: {
          doctorId,
          branchId: branchA,
          dayOfWeek: 6,
          startTime: "09:00",
          endTime: "10:00",
          effectiveFrom: "2026-01-05",
        },
      });
      expect(allowed.status).toBe(201);
    } finally {
      await custom.close();
    }
  });

  it("enforces the default role matrix on scheduling endpoints", async () => {
    const receptionist = await createTestApi(createApp());
    const nurse = await createTestApi(createApp());

    try {
      await loginAs(receptionist, receptionistEmail);
      await selectTenant(receptionist, tenantSlug);

      // Read-only roster access.
      expect((await receptionist.get(`${API}/doctor-schedules`)).status).toBe(200);
      expect((await receptionist.get(`${API}/doctor-breaks`)).status).toBe(200);
      expect((await receptionist.get(`${API}/doctor-leaves`)).status).toBe(200);

      for (const response of [
        await receptionist.post(`${API}/doctor-schedules`, {
          body: {
            doctorId,
            branchId: branchA,
            dayOfWeek: 5,
            startTime: "09:00",
            endTime: "10:00",
          },
        }),
        await receptionist.patch(`${API}/doctor-schedules/${scheduleId}`, {
          body: { startTime: "08:00" },
        }),
        await receptionist.patch(`${API}/doctor-schedules/${scheduleId}/status`, {
          body: { isActive: false },
        }),
        await receptionist.delete(`${API}/doctor-schedules/${scheduleId}`),
        await receptionist.post(`${API}/doctor-breaks`, {
          body: { scheduleId, startTime: "12:00", endTime: "12:15" },
        }),
        await receptionist.patch(`${API}/doctor-breaks/${breakId}`, {
          body: { startTime: "11:30" },
        }),
        await receptionist.delete(`${API}/doctor-breaks/${breakId}`),
        await receptionist.post(`${API}/doctor-leaves`, {
          body: {
            doctorId,
            startAt: "2026-12-01T09:00:00Z",
            endAt: "2026-12-02T18:00:00Z",
          },
        }),
        await receptionist.patch(`${API}/doctor-leaves/${leaveId}/approve`),
        await receptionist.patch(`${API}/doctor-leaves/${leaveId}/reject`, {
          body: { rejectionReason: "no" },
        }),
        await receptionist.patch(`${API}/doctor-leaves/${leaveId}/cancel`),
      ]) {
        expect(response.status).toBe(403);
      }

      await loginAs(nurse, nurseEmail);
      await selectTenant(nurse, tenantSlug);

      expect((await nurse.get(`${API}/doctor-schedules`)).status).toBe(200);
      expect((await nurse.get(`${API}/doctor-breaks`)).status).toBe(200);
      expect((await nurse.get(`${API}/doctor-leaves`)).status).toBe(403);
      expect((await nurse.patch(`${API}/doctor-leaves/${leaveId}/approve`)).status).toBe(403);
      expect(
        (
          await nurse.post(`${API}/doctor-schedules`, {
            body: {
              doctorId,
              branchId: branchA,
              dayOfWeek: 6,
              startTime: "14:00",
              endTime: "15:00",
            },
          })
        ).status,
      ).toBe(403);
    } finally {
      await receptionist.close();
      await nurse.close();
    }
  });

  it("keeps doctors to own-leave actions and denies approval", async () => {
    const doctor = await createTestApi(createApp());

    try {
      await loginAs(doctor, doctorEmail);
      await selectTenant(doctor, tenantSlug);

      // Own schedule is readable, but the roster itself is read-only.
      expect((await doctor.get(`${API}/doctor-schedules`)).status).toBe(200);
      expect(
        (
          await doctor.post(`${API}/doctor-schedules`, {
            body: {
              doctorId,
              branchId: branchA,
              dayOfWeek: 7,
              startTime: "09:00",
              endTime: "10:00",
            },
          })
        ).status,
      ).toBe(403);

      // A colleague's leave is invisible to the doctor's decision guards.
      const colleagueLeave = await api.post(`${API}/doctor-leaves`, {
        body: {
          doctorId: secondDoctorId,
          branchId: branchA,
          startAt: "2026-12-14T09:00:00Z",
          endAt: "2026-12-15T18:00:00Z",
        },
      });
      expect(colleagueLeave.status).toBe(201);
      const colleagueLeaveId = dataOf<{ leave: LeaveShape }>(colleagueLeave).leave.id;

      // Approve/reject are denied at the route guard.
      expect(
        (await doctor.patch(`${API}/doctor-leaves/${colleagueLeaveId}/approve`)).status,
      ).toBe(403);
      expect(
        (
          await doctor.patch(`${API}/doctor-leaves/${colleagueLeaveId}/reject`, {
            body: { rejectionReason: "nope" },
          })
        ).status,
      ).toBe(403);

      // The doctor role holds doctor.leave.cancel for its own requests, but the
      // service still refuses to cancel a colleague's leave.
      expect(
        (await doctor.patch(`${API}/doctor-leaves/${colleagueLeaveId}/cancel`)).status,
      ).toBe(403);
      expect(
        (
          await doctor.patch(`${API}/doctor-leaves/${colleagueLeaveId}`, {
            body: { reason: "hijack" },
          })
        ).status,
      ).toBe(403);

      // Cancelling one's own pending leave remains allowed.
      const ownLeave = await doctor.post(`${API}/doctor-leaves`, {
        body: {
          doctorId,
          branchId: branchA,
          startAt: "2027-03-01T09:00:00Z",
          endAt: "2027-03-02T18:00:00Z",
        },
      });
      expect(ownLeave.status).toBe(201);
      const ownLeaveId = dataOf<{ leave: LeaveShape }>(ownLeave).leave.id;
      expect((await doctor.patch(`${API}/doctor-leaves/${ownLeaveId}/cancel`)).status).toBe(200);
    } finally {
      await doctor.close();
    }
  });
});

describe("scheduling tenant and branch isolation", () => {
  it("blocks cross-tenant schedule access with a safe 404", async () => {
    expect((await otherApi.get(`${API}/doctor-schedules/${scheduleId}`)).status).toBe(404);
    expect(
      (
        await otherApi.patch(`${API}/doctor-schedules/${scheduleId}`, {
          body: { bufferMinutes: 30 },
        })
      ).status,
    ).toBe(404);
    expect((await otherApi.delete(`${API}/doctor-schedules/${scheduleId}`)).status).toBe(404);

    expect((await api.get(`${API}/doctor-schedules/${otherScheduleId}`)).status).toBe(404);

    // A foreign branch filter cannot widen the tenant boundary.
    const filtered = await otherApi.get(
      `${API}/doctor-schedules?branchId=${branchA}&limit=100`,
    );
    expect(filtered.status).toBe(200);
    expect(dataOf<{ schedules: ScheduleShape[] }>(filtered).schedules).toHaveLength(0);
  });

  it("blocks cross-tenant break access with a safe 404", async () => {
    expect((await otherApi.get(`${API}/doctor-breaks/${breakId}`)).status).toBe(404);
    expect(
      (
        await otherApi.patch(`${API}/doctor-breaks/${breakId}`, {
          body: { endTime: "11:30" },
        })
      ).status,
    ).toBe(404);
    // Break deletion is idempotent and never reveals whether a foreign row
    // exists: the cross-tenant delete is a silent no-op.
    expect((await otherApi.delete(`${API}/doctor-breaks/${breakId}`)).status).toBe(204);
    expect((await api.get(`${API}/doctor-breaks/${breakId}`)).status).toBe(200);

    const filtered = await otherApi.get(`${API}/doctor-breaks?branchId=${branchA}`);
    expect(dataOf<{ breaks: BreakShape[] }>(filtered).breaks).toHaveLength(0);
  });

  it("blocks cross-tenant leave workflows", async () => {
    expect((await otherApi.get(`${API}/doctor-leaves/${leaveId}`)).status).toBe(404);
    expect((await otherApi.patch(`${API}/doctor-leaves/${leaveId}/approve`)).status).toBe(404);
    expect(
      (
        await otherApi.patch(`${API}/doctor-leaves/${leaveId}/reject`, {
          body: { rejectionReason: "cross-tenant" },
        })
      ).status,
    ).toBe(404);
    expect((await otherApi.patch(`${API}/doctor-leaves/${leaveId}/cancel`)).status).toBe(404);

    expect((await api.get(`${API}/doctor-leaves/${otherLeaveId}`)).status).toBe(404);
  });

  it("applies the branch-admin all-branch leave restriction", async () => {
    const branchAdmin = await createTestApi(createApp());

    try {
      await loginAs(branchAdmin, branchAdminEmail);
      await selectTenant(branchAdmin, tenantSlug);

      // All-branch leave cannot be reviewed by a branch administrator.
      const allBranch = await branchAdmin.patch(`${API}/doctor-leaves/${leaveId}/approve`);
      expect(allBranch.status).toBe(403);

      // Branch-specific leave can be reviewed.
      const branchSpecific = await branchAdmin.patch(
        `${API}/doctor-leaves/${branchLeaveId}/approve`,
      );
      expect(branchSpecific.status).toBe(200);
      expect(dataOf<{ leave: LeaveShape }>(branchSpecific).leave.status).toBe("APPROVED");
    } finally {
      await branchAdmin.close();
    }
  });
});

describe("scheduling database security", () => {
  it("runs the suite as a restricted, non-bypassing role with forced RLS", async () => {
    const role = await getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const policies = await getPool().query<{ tablename: string; forced: boolean }>(
      `select c.relname as tablename, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('doctor_schedules', 'doctor_breaks', 'doctor_leaves')`,
    );
    expect(policies.rows.map((row) => row.tablename).sort()).toEqual([
      "doctor_breaks",
      "doctor_leaves",
      "doctor_schedules",
    ]);
    for (const row of policies.rows) {
      expect(row.forced).toBe(true);
    }
  });

  it("isolates each scheduling table by transaction-local tenant context", async () => {
    const ownSchedules = await withTenantTransaction(tenantId, (tx) =>
      tx.select({ id: doctorSchedules.id }).from(doctorSchedules),
    );
    expect(ownSchedules.some((row) => row.id === scheduleId)).toBe(true);
    expect(ownSchedules.some((row) => row.id === otherScheduleId)).toBe(false);

    const foreignSchedules = await withTenantTransaction(otherTenantId, (tx) =>
      tx.select({ id: doctorSchedules.id }).from(doctorSchedules),
    );
    expect(foreignSchedules.some((row) => row.id === otherScheduleId)).toBe(true);
    expect(foreignSchedules.some((row) => row.id === scheduleId)).toBe(false);

    const ownBreaks = await withTenantTransaction(tenantId, (tx) =>
      tx.select({ id: doctorBreaks.id }).from(doctorBreaks),
    );
    expect(ownBreaks.some((row) => row.id === breakId)).toBe(true);
    expect(ownBreaks.some((row) => row.id === otherBreakId)).toBe(false);

    const ownLeaves = await withTenantTransaction(tenantId, (tx) =>
      tx.select({ id: doctorLeaves.id }).from(doctorLeaves),
    );
    expect(ownLeaves.some((row) => row.id === leaveId)).toBe(true);
    expect(ownLeaves.some((row) => row.id === otherLeaveId)).toBe(false);
  });

  it("blocks cross-tenant writes under RLS", async () => {
    const scheduleUpdate = await withTenantTransaction(tenantId, (tx) =>
      tx
        .update(doctorSchedules)
        .set({ bufferMinutes: 25 })
        .where(eq(doctorSchedules.id, otherScheduleId))
        .returning({ id: doctorSchedules.id }),
    );
    expect(scheduleUpdate).toHaveLength(0);

    const breakUpdate = await withTenantTransaction(tenantId, (tx) =>
      tx
        .update(doctorBreaks)
        .set({ reason: "hijack" })
        .where(eq(doctorBreaks.id, otherBreakId))
        .returning({ id: doctorBreaks.id }),
    );
    expect(breakUpdate).toHaveLength(0);

    const leaveUpdate = await withTenantTransaction(tenantId, (tx) =>
      tx
        .update(doctorLeaves)
        .set({ status: "APPROVED" })
        .where(eq(doctorLeaves.id, otherLeaveId))
        .returning({ id: doctorLeaves.id }),
    );
    expect(leaveUpdate).toHaveLength(0);

    await expect(
      withTenantTransaction(tenantId, (tx) =>
        tx.insert(doctorSchedules).values({
          tenantId: otherTenantId,
          doctorId: otherDoctorId,
          branchId: otherBranch,
          dayOfWeek: 5,
          startTime: "09:00:00",
          endTime: "10:00:00",
        }),
      ),
    ).rejects.toThrow();
  });

  it("does not leak tenant context back into the pool", async () => {
    const leaked = await getPool().query<{ tid: string | null }>(
      "select current_setting('app.current_tenant_id', true) as tid",
    );
    expect(leaked.rows[0]?.tid ?? "").toBe("");
  });

  it("seeds tenant permissions idempotently", async () => {
    const countGrants = async (): Promise<number> => {
      const result = await getPool().query<{ n: number }>(
        `select count(*)::int as n
         from role_permissions rp
         join roles r on r.id = rp.role_id
         where r.tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0]?.n ?? 0;
    };

    const before = await countGrants();

    await withTenantTransaction(tenantId, (tx) => seedTenantRbac(tx, tenantId));
    await withTenantTransaction(tenantId, (tx) => seedTenantRbac(tx, tenantId));

    const after = await countGrants();
    expect(after).toBe(before);

    const duplicates = await getPool().query<{ n: number }>(
      `select count(*)::int as n
       from (
         select permission_key from permissions group by permission_key having count(*) > 1
       ) duplicated`,
    );
    expect(duplicates.rows[0]?.n).toBe(0);

    const keys = await getPool().query<{ permission_key: string; n: number }>(
      `select permission_key, count(*)::int as n
       from permissions
       where permission_key = any($1)
       group by permission_key`,
      [SCHEDULING_KEYS],
    );
    expect(keys.rows).toHaveLength(SCHEDULING_KEYS.length);
    for (const row of keys.rows) {
      expect(row.n).toBe(1);
    }
  });
});

describe("scheduling consistency", () => {
  it("refuses schedules for inactive or deleted doctors", async () => {
    const suffix = randomUUID().slice(0, 8);
    const user = await registerUser(`inactive-doctor-${suffix}`);
    await addMembership(tenantId, user.id);
    const inactiveDoctorId = await createDoctor(
      tenantId,
      [branchA],
      user.id,
      suffix,
      "INACTIVE",
    );

    await getTestAdminPool().query("update doctors set is_active = false where id = $1", [
      inactiveDoctorId,
    ]);

    const inactive = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId: inactiveDoctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "10:00",
      },
    });
    expect(inactive.status).toBe(400);

    await getTestAdminPool().query(
      "update doctors set is_active = true, deleted_at = now() where id = $1",
      [inactiveDoctorId],
    );

    const deleted = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId: inactiveDoctorId,
        branchId: branchA,
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "10:00",
      },
    });
    expect(deleted.status).toBe(404);
  });

  it("keeps inactive schedules out of break creation and preserves timezone data", async () => {
    const created = await api.post(`${API}/doctor-schedules`, {
      body: {
        doctorId,
        branchId: branchB,
        dayOfWeek: 4,
        startTime: "14:00",
        endTime: "18:00",
        effectiveFrom: "2026-01-05",
      },
    });
    expect(created.status).toBe(201);
    const schedule = dataOf<{ schedule: ScheduleShape & { branch: { timezone: string } } }>(
      created,
    ).schedule;
    expect(schedule.branch.timezone).toBe("Europe/London");

    const deactivated = await api.patch(`${API}/doctor-schedules/${schedule.id}/status`, {
      body: { isActive: false },
    });
    expect(deactivated.status).toBe(200);

    const breakOnInactive = await api.post(`${API}/doctor-breaks`, {
      body: { scheduleId: schedule.id, startTime: "15:00", endTime: "15:15" },
    });
    expect(breakOnInactive.status).toBe(400);
  });

  it("enforces leave transition rules and keeps approved leave records", async () => {
    const created = await api.post(`${API}/doctor-leaves`, {
      body: {
        doctorId,
        startAt: "2027-02-01T09:00:00+05:30",
        endAt: "2027-02-02T18:00:00+05:30",
      },
    });
    expect(created.status).toBe(201);
    const leave = dataOf<{ leave: LeaveShape }>(created).leave;

    const approved = await api.patch(`${API}/doctor-leaves/${leave.id}/approve`);
    expect(approved.status).toBe(200);

    // Approved leave remains a stored, queryable record.
    const fetched = await api.get(`${API}/doctor-leaves/${leave.id}`);
    expect(fetched.status).toBe(200);
    expect(dataOf<{ leave: LeaveShape }>(fetched).leave.status).toBe("APPROVED");

    // Terminal transitions are rejected.
    expect((await api.patch(`${API}/doctor-leaves/${leave.id}/reject`, {
      body: { rejectionReason: "late" },
    })).status).toBe(409);
    expect((await api.patch(`${API}/doctor-leaves/${leave.id}/cancel`)).status).toBe(200);
    expect((await api.patch(`${API}/doctor-leaves/${leave.id}/approve`)).status).toBe(409);
  });
});
