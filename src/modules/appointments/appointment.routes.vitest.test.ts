import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for the Phase 18.6 appointment API.
 *
 * The Phase 18.2-18.5 suites already cover the availability, booking,
 * rescheduling, cancellation and lifecycle business rules. These tests prove
 * route registration, strict Zod validation, tenant context from the session,
 * RBAC, doctor-specific visibility, tenant isolation and service error mapping
 * through the real Express stack and a real database (as the restricted role).
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface AppointmentShape {
  id: string;
  appointmentCode: string;
  patientId: string;
  doctorId: string;
  branchId: string;
  departmentId: string | null;
  appointmentSource: string;
  appointmentType: string;
  appointmentStatus: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  consultationFee: string;
  currency: string;
  reason: string | null;
  cancellationReason: string | null;
  noShowAt: string | null;
  replayed: boolean;
}

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function appointmentOf(response: TestResponse): AppointmentShape {
  return dataOf<{ appointment: AppointmentShape }>(response).appointment;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

/** ISO date `offsetDays` from now, so slots are always in the future. */
function futureDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const DAY_A = futureDay(30);
const DAY_B = futureDay(31);
const DAY_C = futureDay(32);
const DAY_D = futureDay(33);
const DAY_E = futureDay(34);

const slot = (day: string, time: string): string => `${day}T${time}:00Z`;

let api: TestApi;
let doctorApi: TestApi;
let nurseApi: TestApi;
let unprivilegedApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let tenantId: string;
let tenantSlug: string;
let branchId: string;
let doctorId: string;
let secondDoctorId: string;
let patientId: string;
let otherTenantId: string;
let otherBranchId: string;
let otherDoctorId: string;
let otherPatientId: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];
let primaryAppointmentId: string;
let primaryAppointmentCode: string;
let doctor2AppointmentId: string;

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@appointments-api.test`;
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

async function addBranch(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,$3,$4,'UTC',true)`,
    [id, tenant, `${label} Branch`, `BR-${randomUUID().slice(0, 8)}`],
  );
  return id;
}

async function addDoctor(
  tenant: string,
  userId: string,
  branch: string,
  fee: string,
): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  await getTestAdminPool().query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number, is_active)
     values ($1,$2,$3,$4,$5,true)`,
    [id, tenant, userId, `DOC-${suffix}`, `REG-${suffix}`],
  );
  await getTestAdminPool().query(
    `insert into doctor_branches
       (tenant_id, doctor_id, branch_id, consultation_fee, currency, is_active)
     values ($1,$2,$3,$4,'USD',true)`,
    [tenant, id, branch, fee],
  );

  return id;
}

/** Working window 09:00-17:00 on every weekday, 30-minute slots, no buffer. */
async function addWeeklySchedules(
  tenant: string,
  doctor: string,
  branch: string,
): Promise<void> {
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    await getTestAdminPool().query(
      `insert into doctor_schedules
         (id, tenant_id, doctor_id, branch_id, day_of_week, start_time, end_time,
          slot_duration_minutes, buffer_minutes, effective_from, is_active)
       values ($1,$2,$3,$4,$5,'09:00:00','17:00:00',30,0,'2020-01-01',true)`,
      [randomUUID(), tenant, doctor, branch, dayOfWeek],
    );
  }
}

function idempotency(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  nurseApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@appointments-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Appointment Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Appointments API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  branchId = await addBranch(tenantId, "Central");

  // Doctor account: holds `doctor` (appointment:read/update, no create/cancel).
  const doctorAccount = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctorAccount.id, "doctor");
  doctorId = await addDoctor(tenantId, doctorAccount.id, branchId, "150.00");
  await addWeeklySchedules(tenantId, doctorId, branchId);
  await loginAs(doctorApi, doctorAccount.email);
  await selectTenant(doctorApi, tenantSlug);

  // Second doctor in the same hospital, for doctor-specific visibility.
  const secondDoctor = await createAccount(`doctor2-${suffix}`);
  await addMembership(tenantId, secondDoctor.id, "doctor");
  secondDoctorId = await addDoctor(tenantId, secondDoctor.id, branchId, "200.00");
  await addWeeklySchedules(tenantId, secondDoctorId, branchId);

  // Nurse: appointment:read/update but no create or cancel.
  const nurse = await createAccount(`nurse-${suffix}`);
  await addMembership(tenantId, nurse.id, "nurse");
  await loginAs(nurseApi, nurse.email);
  await selectTenant(nurseApi, tenantSlug);

  // Active membership with no role: authenticated but no appointment keys.
  const staff = await createAccount(`staff-${suffix}`);
  await addMembership(tenantId, staff.id);
  await loginAs(unprivilegedApi, staff.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  const patientResponse = await api.post(`${API}/patients`, {
    body: { fullName: "Appointment Patient", gender: "OTHER" },
  });
  expect(patientResponse.status).toBe(201);
  patientId = dataOf<{ patient: { id: string } }>(patientResponse).patient.id;

  // Other hospital for cross-tenant checks.
  const otherAdminEmail = `other-admin-${suffix}@appointments-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Appointment Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Appointments API ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherBranchId = await addBranch(otherTenantId, "Other");
  const otherDoctorAccount = await createAccount(`other-doctor-${suffix}`);
  await addMembership(otherTenantId, otherDoctorAccount.id, "doctor");
  otherDoctorId = await addDoctor(
    otherTenantId,
    otherDoctorAccount.id,
    otherBranchId,
    "80.00",
  );
  await addWeeklySchedules(otherTenantId, otherDoctorId, otherBranchId);

  const otherPatient = await otherApi.post(`${API}/patients`, {
    body: { fullName: "Foreign Appointment Patient" },
  });
  expect(otherPatient.status).toBe(201);
  otherPatientId = dataOf<{ patient: { id: string } }>(otherPatient).patient.id;
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
  await doctorApi.close();
  await nurseApi.close();
  await unprivilegedApi.close();
  await otherApi.close();
  await anonymousApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("appointment availability routes", () => {
  it("returns slots for a doctor and branch without creating an appointment", async () => {
    const { rows } = await getTestAdminPool().query<{ count: number }>(
      "select count(*)::int as count from appointments where tenant_id = $1",
      [tenantId],
    );
    const before = rows[0]?.count ?? 0;

    const response = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}`,
    );

    expect(response.status).toBe(200);
    const availability = dataOf<{
      availability: {
        doctorId: string;
        branchId: string;
        branchTimezone: string;
        fromDate: string;
        toDate: string;
        consultationFee: string;
        currency: string;
        days: Array<{ date: string; slots: Array<{ startAt: string; endAt: string }> }>;
      };
    }>(response).availability;

    expect(availability.doctorId).toBe(doctorId);
    expect(availability.branchTimezone).toBe("UTC");
    expect(availability.consultationFee).toBe("150.00");
    expect(availability.currency).toBe("USD");
    expect(availability.days).toHaveLength(1);
    expect(availability.days[0]?.date).toBe(DAY_A);
    expect(availability.days[0]?.slots.length).toBeGreaterThan(0);
    expect(new Date(availability.days[0]?.slots[0]?.startAt ?? 0).toISOString()).toBe(
      new Date(slot(DAY_A, "09:00")).toISOString(),
    );

    const after = await getTestAdminPool().query<{ count: number }>(
      "select count(*)::int as count from appointments where tenant_id = $1",
      [tenantId],
    );
    expect(after.rows[0]?.count).toBe(before);
  });

  it("supports the doctor path and rejects invalid or contradictory ranges", async () => {
    const path = await api.get(
      `${API}/appointments/availability/${doctorId}?branchId=${branchId}&fromDate=${DAY_A}&toDate=${DAY_B}`,
    );
    expect(path.status).toBe(200);
    expect(
      dataOf<{ availability: { days: unknown[] } }>(path).availability.days,
    ).toHaveLength(2);

    const cases = [
      `${API}/appointments/availability?branchId=${branchId}&date=${DAY_A}`,
      `${API}/appointments/availability?doctorId=not-a-uuid&branchId=${branchId}&date=${DAY_A}`,
      `${API}/appointments/availability?doctorId=${doctorId}&date=${DAY_A}`,
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=2026-02-30`,
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}&fromDate=${DAY_A}&toDate=${DAY_B}`,
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&fromDate=${DAY_B}&toDate=${DAY_A}`,
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}&durationMinutes=1`,
    ];

    for (const url of cases) {
      const response = await api.get(url);
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }
  });

  it("does not expose another tenant's doctor availability", async () => {
    const response = await otherApi.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}`,
    );
    expect(response.status).toBe(404);
  });

  it("requires authentication and appointment:read", async () => {
    const anonymous = await anonymousApi.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}`,
    );
    expect(anonymous.status).toBe(401);

    const unprivileged = await unprivilegedApi.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_A}`,
    );
    expect(unprivileged.status).toBe(403);
  });
});

describe("appointment booking routes", () => {
  it("books an appointment, resolves the fee server-side and replays the idempotency key", async () => {
    const body = {
      patientId,
      doctorId,
      branchId,
      startAt: slot(DAY_A, "09:00"),
      reason: "Initial consultation",
      appointmentType: "CONSULTATION",
    };
    const key = `book-${randomUUID()}`;

    const created = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });

    expect(created.status).toBe(201);
    const appointment = appointmentOf(created);
    expect(appointment.appointmentCode).toMatch(/^APT-\d{8}-[0-9A-F]{8}$/);
    expect(appointment.appointmentStatus).toBe("CONFIRMED");
    expect(appointment.appointmentSource).toBe("RECEPTIONIST");
    expect(appointment.consultationFee).toBe("150.00");
    expect(appointment.currency).toBe("USD");
    expect(appointment.durationMinutes).toBe(30);
    expect(appointment.patientId).toBe(patientId);

    primaryAppointmentId = appointment.id;
    primaryAppointmentCode = appointment.appointmentCode;

    const replay = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });
    expect(replay.status).toBe(200);
    expect(appointmentOf(replay).id).toBe(appointment.id);
    expect(appointmentOf(replay).replayed).toBe(true);
  });

  it("rejects invalid, protected or client-controlled booking fields", async () => {
    const base = {
      patientId,
      doctorId,
      branchId,
      startAt: slot(DAY_A, "10:30"),
    };

    const cases: unknown[] = [
      {},
      { ...base, patientId: undefined },
      { ...base, startAt: `${DAY_A} 09:00` },
      { ...base, startAt: "2026-12-07T09:00:00" },
      { ...base, startAt: "not-a-date" },
      { ...base, tenantId: otherTenantId },
      { ...base, createdBy: randomUUID() },
      { ...base, appointmentStatus: "COMPLETED" },
      { ...base, consultationFee: "0.00" },
      { ...base, currency: "USD" },
      { ...base, appointmentCode: "APT-20260101-DEADBEEF" },
      { ...base, appointmentSource: "ONLINE" },
      { ...base, durationMinutes: 2 },
      { ...base, reason: "x".repeat(1001) },
    ];

    for (const body of cases) {
      const response = await api.post(`${API}/appointments`, {
        body,
        headers: idempotency(`invalid-${randomUUID()}`),
      });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }
  });

  it("requires a valid idempotency key", async () => {
    const body = {
      patientId,
      doctorId,
      branchId,
      startAt: slot(DAY_A, "10:30"),
    };

    const missing = await api.post(`${API}/appointments`, { body });
    expect(missing.status).toBe(422);
    expect(errorOf(missing).code).toBe("VALIDATION_ERROR");

    const tooLong = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency("k".repeat(201)),
    });
    expect(tooLong.status).toBe(422);

    const mismatch = await api.post(`${API}/appointments`, {
      body: { ...body, idempotencyKey: "body-key" },
      headers: idempotency("header-key"),
    });
    expect(mismatch.status).toBe(422);
  });

  it("rejects a duplicate booking of the same slot", async () => {
    const duplicate = await api.post(`${API}/appointments`, {
      body: {
        patientId,
        doctorId,
        branchId,
        startAt: slot(DAY_A, "09:00"),
      },
      headers: idempotency(`duplicate-${randomUUID()}`),
    });

    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).code).toBe("SLOT_UNAVAILABLE");
  });

  it("enforces authentication, booking permission and tenant isolation", async () => {
    const body = {
      patientId,
      doctorId,
      branchId,
      startAt: slot(DAY_A, "11:30"),
    };

    const anonymous = await anonymousApi.post(`${API}/appointments`, {
      body,
      headers: idempotency(`anon-${randomUUID()}`),
    });
    expect(anonymous.status).toBe(401);

    // A nurse may read and update appointments but cannot create them.
    const nurse = await nurseApi.post(`${API}/appointments`, {
      body,
      headers: idempotency(`nurse-${randomUUID()}`),
    });
    expect(nurse.status).toBe(403);

    // Cross-tenant patient, doctor and branch are never resolvable.
    const foreignPatient = await api.post(`${API}/appointments`, {
      body: { ...body, patientId: otherPatientId },
      headers: idempotency(`foreign-patient-${randomUUID()}`),
    });
    expect(foreignPatient.status).toBe(404);

    const foreignDoctor = await api.post(`${API}/appointments`, {
      body: { ...body, doctorId: otherDoctorId, branchId: otherBranchId },
      headers: idempotency(`foreign-doctor-${randomUUID()}`),
    });
    expect(foreignDoctor.status).toBe(404);
  });
});

describe("appointment listing and retrieval", () => {
  it("lists appointments with filters and pagination metadata", async () => {
    const second = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_A, "10:00") },
      headers: idempotency(`list-a-${randomUUID()}`),
    });
    expect(second.status).toBe(201);

    const third = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_B, "09:00") },
      headers: idempotency(`list-b-${randomUUID()}`),
    });
    expect(third.status).toBe(201);

    const page = await api.get(`${API}/appointments?page=1&limit=2`);
    expect(page.status).toBe(200);
    const envelope = page.body as Envelope<{ appointments: Array<Record<string, unknown>> }>;
    expect(envelope.data.appointments).toHaveLength(2);
    expect(envelope.meta?.pagination).toMatchObject({ page: 1, pageSize: 2 });
    expect(envelope.meta?.pagination?.total).toBeGreaterThanOrEqual(3);

    // Private notes are never part of the list projection.
    expect(Object.keys(envelope.data.appointments[0] ?? {})).not.toContain("notes");

    const byCode = await api.get(
      `${API}/appointments?search=${primaryAppointmentCode}`,
    );
    expect(dataOf<{ appointments: AppointmentShape[] }>(byCode).appointments.map((a) => a.id)).toEqual([
      primaryAppointmentId,
    ]);

    const byPatient = await api.get(`${API}/appointments?patientId=${patientId}&limit=100`);
    expect(byPatient.status).toBe(200);

    const byDoctor = await api.get(`${API}/appointments?doctorId=${doctorId}&limit=100`);
    expect(byDoctor.status).toBe(200);

    const byBranch = await api.get(`${API}/appointments?branchId=${branchId}&limit=100`);
    expect(byBranch.status).toBe(200);

    const confirmedOnly = await api.get(`${API}/appointments?status=CONFIRMED&limit=100`);
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(confirmedOnly).appointments.every(
        (item) => item.appointmentStatus === "CONFIRMED",
      ),
    ).toBe(true);

    const bySource = await api.get(`${API}/appointments?source=RECEPTIONIST&limit=100`);
    expect(bySource.status).toBe(200);

    const dayA = await api.get(
      `${API}/appointments?dateFrom=${DAY_A}&dateTo=${DAY_A}&limit=100`,
    );
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(dayA).appointments.every(
        (item) => item.startAt.slice(0, 10) === DAY_A,
      ),
    ).toBe(true);

    const badFilters = [
      `${API}/appointments?dateFrom=${DAY_B}&dateTo=${DAY_A}`,
      `${API}/appointments?dateFrom=2026-02-30`,
      `${API}/appointments?status=MAYBE`,
      `${API}/appointments?source=CARRIER_PIGEON`,
      `${API}/appointments?patientId=not-a-uuid`,
      `${API}/appointments?page=0&limit=101`,
    ];

    for (const url of badFilters) {
      const response = await api.get(url);
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }
  });

  it("retrieves an appointment by id and by public code", async () => {
    const byId = await api.get(`${API}/appointments/${primaryAppointmentId}`);
    expect(byId.status).toBe(200);
    expect(appointmentOf(byId).appointmentCode).toBe(primaryAppointmentCode);

    const byCode = await api.get(`${API}/appointments/code/${primaryAppointmentCode}`);
    expect(byCode.status).toBe(200);
    expect(appointmentOf(byCode).id).toBe(primaryAppointmentId);

    const missing = await api.get(`${API}/appointments/${randomUUID()}`);
    expect(missing.status).toBe(404);

    const malformed = await api.get(`${API}/appointments/not-a-uuid`);
    expect(malformed.status).toBe(422);

    const unknownCode = await api.get(`${API}/appointments/code/APT-00000000-DEADBEEF`);
    expect(unknownCode.status).toBe(404);

    const badCode = await api.get(`${API}/appointments/code/not a code!!`);
    expect(badCode.status).toBe(422);
  });

  it("restricts a doctor to their own appointments", async () => {
    const otherAppointment = await api.post(`${API}/appointments`, {
      body: {
        patientId,
        doctorId: secondDoctorId,
        branchId,
        startAt: slot(DAY_A, "11:00"),
      },
      headers: idempotency(`doctor2-${randomUUID()}`),
    });
    expect(otherAppointment.status).toBe(201);
    doctor2AppointmentId = appointmentOf(otherAppointment).id;

    const ownList = await doctorApi.get(`${API}/appointments?limit=100`);
    expect(ownList.status).toBe(200);
    const ownAppointments = dataOf<{ appointments: AppointmentShape[] }>(ownList).appointments;
    expect(ownAppointments.every((item) => item.doctorId === doctorId)).toBe(true);

    const forbiddenDetail = await doctorApi.get(
      `${API}/appointments/${doctor2AppointmentId}`,
    );
    expect(forbiddenDetail.status).toBe(403);

    const forbiddenFilter = await doctorApi.get(
      `${API}/appointments?doctorId=${secondDoctorId}`,
    );
    expect(forbiddenFilter.status).toBe(403);

    const forbiddenHistory = await doctorApi.get(
      `${API}/appointments/${doctor2AppointmentId}/history`,
    );
    expect(forbiddenHistory.status).toBe(403);
  });

  it("enforces read permissions and tenant isolation", async () => {
    const anonymous = await anonymousApi.get(`${API}/appointments`);
    expect(anonymous.status).toBe(401);

    const unprivileged = await unprivilegedApi.get(`${API}/appointments`);
    expect(unprivileged.status).toBe(403);

    const crossDetail = await otherApi.get(`${API}/appointments/${primaryAppointmentId}`);
    expect(crossDetail.status).toBe(404);

    const crossCode = await otherApi.get(
      `${API}/appointments/code/${primaryAppointmentCode}`,
    );
    expect(crossCode.status).toBe(404);

    const crossList = await otherApi.get(`${API}/appointments?limit=100`);
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(crossList).appointments.map((a) => a.id),
    ).not.toContain(primaryAppointmentId);
  });
});

describe("appointment rescheduling and cancellation", () => {
  it("reschedules to a free slot and rejects an occupied replacement", async () => {
    const movable = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_C, "09:00") },
      headers: idempotency(`move-${randomUUID()}`),
    });
    expect(movable.status).toBe(201);
    const movableId = appointmentOf(movable).id;

    const moved = await api.post(`${API}/appointments/${movableId}/reschedule`, {
      body: { startAt: slot(DAY_C, "10:00"), reason: "Patient request" },
      headers: idempotency(`move-key-${randomUUID()}`),
    });

    expect(moved.status).toBe(200);
    const movedBody = moved.body as Envelope<{
      appointment: AppointmentShape;
      original: AppointmentShape;
    }>;
    expect(new Date(movedBody.data.appointment.startAt).toISOString()).toBe(
      new Date(slot(DAY_C, "10:00")).toISOString(),
    );
    expect(movedBody.data.appointment.appointmentStatus).toBe("CONFIRMED");
    expect(movedBody.data.original.id).toBe(movableId);
    expect(movedBody.data.original.appointmentStatus).toBe("RESCHEDULED");

    // Occupy the target slot with a different appointment.
    const occupied = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_C, "11:00") },
      headers: idempotency(`occupied-${randomUUID()}`),
    });
    expect(occupied.status).toBe(201);
    const occupiedId = appointmentOf(occupied).id;

    const conflict = await api.post(`${API}/appointments/${occupiedId}/reschedule`, {
      body: { startAt: slot(DAY_C, "10:00") },
      headers: idempotency(`conflict-${randomUUID()}`),
    });
    expect(conflict.status).toBe(409);
    expect(errorOf(conflict).code).toBe("SLOT_UNAVAILABLE");
  });

  it("does not let a doctor reschedule another doctor's appointment", async () => {
    const forbidden = await doctorApi.post(
      `${API}/appointments/${doctor2AppointmentId}/reschedule`,
      { body: { startAt: slot(DAY_A, "12:00") } },
    );

    expect(forbidden.status).toBe(403);
    expect(errorOf(forbidden).code).toBe("FORBIDDEN");

    // The other doctor's appointment is untouched.
    const detail = await api.get(`${API}/appointments/${doctor2AppointmentId}`);
    expect(appointmentOf(detail).appointmentStatus).toBe("CONFIRMED");
    expect(new Date(appointmentOf(detail).startAt).toISOString()).toBe(
      new Date(slot(DAY_A, "11:00")).toISOString(),
    );
  });

  it("stops replaying an idempotency key after its 24 hour expiry", async () => {
    const body = { patientId, doctorId, branchId, startAt: slot(DAY_E, "10:00") };
    const key = `expiring-${randomUUID()}`;

    const first = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });
    expect(first.status).toBe(201);

    // Age the idempotency record past its documented retention window.
    const { rowCount } = await getTestAdminPool().query(
      `update appointment_idempotency_keys
          set expires_at = now() - interval '1 minute'
        where tenant_id = $1 and operation = 'appointment.create' and idempotency_key = $2`,
      [tenantId, key],
    );
    expect(rowCount).toBe(1);

    const retried = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });

    // The expired key is no longer replayed; the slot is still taken, so the
    // request is re-evaluated and rejected instead of returning the old row.
    expect(retried.status).toBe(409);
    expect(errorOf(retried).code).toBe("SLOT_UNAVAILABLE");

    const { rows } = await getTestAdminPool().query<{ count: number }>(
      `select count(*)::int as count from appointment_idempotency_keys
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, key],
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("cancels an appointment and rejects invalid lifecycle operations", async () => {
    const created = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_D, "09:00") },
      headers: idempotency(`cancel-${randomUUID()}`),
    });
    expect(created.status).toBe(201);
    const appointmentId = appointmentOf(created).id;

    const cancelled = await api.post(`${API}/appointments/${appointmentId}/cancel`, {
      body: { cancellationReason: "Patient called to cancel" },
      headers: idempotency(`cancel-key-${randomUUID()}`),
    });

    expect(cancelled.status).toBe(200);
    const cancelledBody = dataOf<{ appointment: AppointmentShape; replayed: boolean }>(cancelled);
    expect(cancelledBody.appointment.appointmentStatus).toBe("CANCELLED");
    expect(cancelledBody.appointment.cancellationReason).toBe("Patient called to cancel");

    const checkIn = await api.post(`${API}/appointments/${appointmentId}/check-in`);
    expect(checkIn.status).toBe(409);
    expect(errorOf(checkIn).code).toBe("INVALID_STATUS_TRANSITION");

    const missingReason = await api.post(
      `${API}/appointments/${primaryAppointmentId}/cancel`,
      { body: {} },
    );
    expect(missingReason.status).toBe(422);

    const nurseCancel = await nurseApi.post(`${API}/appointments/${appointmentId}/cancel`, {
      body: { cancellationReason: "Not allowed" },
    });
    expect(nurseCancel.status).toBe(403);
  });
});

describe("appointment lifecycle routes", () => {
  it("checks in, starts and completes a consultation and returns its history", async () => {
    const created = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_E, "09:00") },
      headers: idempotency(`lifecycle-${randomUUID()}`),
    });
    expect(created.status).toBe(201);
    const appointmentId = appointmentOf(created).id;

    const checkedIn = await api.post(`${API}/appointments/${appointmentId}/check-in`);
    expect(checkedIn.status).toBe(200);
    expect(dataOf<{ appointment: AppointmentShape; applied: boolean }>(checkedIn)).toMatchObject({
      applied: true,
    });
    expect(
      dataOf<{ appointment: AppointmentShape }>(checkedIn).appointment.appointmentStatus,
    ).toBe("CHECKED_IN");

    // Repeating the transition is an idempotent no-op.
    const repeated = await api.post(`${API}/appointments/${appointmentId}/check-in`);
    expect(repeated.status).toBe(200);
    expect(dataOf<{ applied: boolean }>(repeated).applied).toBe(false);

    const started = await api.post(`${API}/appointments/${appointmentId}/start`);
    expect(started.status).toBe(200);
    expect(
      dataOf<{ appointment: AppointmentShape }>(started).appointment.appointmentStatus,
    ).toBe("IN_PROGRESS");

    const completed = await api.post(`${API}/appointments/${appointmentId}/complete`);
    expect(completed.status).toBe(200);
    expect(
      dataOf<{ appointment: AppointmentShape }>(completed).appointment.appointmentStatus,
    ).toBe("COMPLETED");

    const history = await api.get(`${API}/appointments/${appointmentId}/history`);
    expect(history.status).toBe(200);
    const historyBody = dataOf<{
      appointment: AppointmentShape;
      events: Array<{ eventType: string; newStatus: string | null }>;
    }>(history);
    expect(historyBody.appointment.appointmentStatus).toBe("COMPLETED");
    expect(historyBody.events.map((event) => event.eventType)).toEqual([
      "CREATED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
    ]);
    expect(historyBody.events.map((event) => event.newStatus)).toEqual([
      "CONFIRMED",
      "CHECKED_IN",
      "IN_PROGRESS",
      "COMPLETED",
    ]);

    // A completed appointment cannot be started again.
    const invalid = await api.post(`${API}/appointments/${appointmentId}/start`);
    expect(invalid.status).toBe(409);
    expect(errorOf(invalid).code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("refuses an early no-show and allows one after the scheduled end", async () => {
    const early = await api.post(`${API}/appointments/${primaryAppointmentId}/no-show`, {
      body: { reason: "Not due yet" },
    });
    expect(early.status).toBe(409);
    expect(errorOf(early).code).toBe("NO_SHOW_TOO_EARLY");

    // Seed an appointment whose window has already ended.
    const pastId = randomUUID();
    await getTestAdminPool().query(
      `insert into appointments
         (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
          appointment_source, appointment_status, start_at, end_at,
          consultation_fee, currency, created_by)
       values ($1,$2,$3,$4,$5,$6,'RECEPTIONIST','CONFIRMED',now() - interval '2 hours',
               now() - interval '1 hour','150.00','USD',
               (select user_id from tenant_memberships where tenant_id = $2 limit 1))`,
      [
        pastId,
        tenantId,
        patientId,
        doctorId,
        branchId,
        `APT-SEED-${randomUUID().slice(0, 8).toUpperCase()}`,
      ],
    );

    const noShow = await api.post(`${API}/appointments/${pastId}/no-show`, {
      body: { reason: "Patient did not arrive" },
    });
    expect(noShow.status).toBe(200);
    const noShowBody = dataOf<{ appointment: AppointmentShape; applied: boolean }>(noShow);
    expect(noShowBody.applied).toBe(true);
    expect(noShowBody.appointment.appointmentStatus).toBe("NO_SHOW");
    expect(noShowBody.appointment.noShowAt).not.toBeNull();
  });

  it("rejects malformed ids, missing permissions and case-by-case protected bodies", async () => {
    const malformed = await api.post(`${API}/appointments/not-a-uuid/check-in`);
    expect(malformed.status).toBe(422);

    const unprivileged = await unprivilegedApi.post(
      `${API}/appointments/${primaryAppointmentId}/check-in`,
    );
    expect(unprivileged.status).toBe(403);

    const anonymous = await anonymousApi.post(
      `${API}/appointments/${primaryAppointmentId}/check-in`,
    );
    expect(anonymous.status).toBe(401);

    const injected = await api.post(
      `${API}/appointments/${primaryAppointmentId}/no-show`,
      { body: { reason: "Early", appointmentStatus: "NO_SHOW" } },
    );
    expect(injected.status).toBe(422);

    const crossTenant = await otherApi.post(
      `${API}/appointments/${primaryAppointmentId}/check-in`,
    );
    expect(crossTenant.status).toBe(404);
  });
});
