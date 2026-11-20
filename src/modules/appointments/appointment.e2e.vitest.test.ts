import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * Phase 18.7 end-to-end integration tests.
 *
 * One real Express app, one real PostgreSQL database as the restricted
 * `hospitalos_app` role (RLS enforced), and the full appointment flow:
 * availability -> booking -> retrieval -> history -> check-in -> start ->
 * complete, plus cancellation, rescheduling, no-show, idempotent retries,
 * concurrent duplicate bookings, cross-tenant access and RBAC denials.
 *
 * The unit/service suites already prove the individual rules; this suite proves
 * they compose correctly through HTTP and that tenant isolation still holds at
 * the database layer.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface AppointmentShape {
  id: string;
  appointmentCode: string;
  patientId: string;
  doctorId: string;
  branchId: string;
  appointmentStatus: string;
  startAt: string;
  endAt: string;
  consultationFee: string;
  currency: string;
  rescheduledFromAppointmentId: string | null;
  replayed: boolean;
}

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

interface ErrorEnvelope {
  error: { code: string; message: string };
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

function futureDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const DAY_1 = futureDay(40);
const DAY_2 = futureDay(41);
const DAY_3 = futureDay(42);
const DAY_4 = futureDay(43);
const DAY_5 = futureDay(44);
const DAY_6 = futureDay(45);

const slot = (day: string, time: string): string => `${day}T${time}:00Z`;
const iso = (value: string): string => new Date(value).toISOString();

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
let otherPatientId: string;
let otherAppointmentId: string;
let secondDoctorAppointmentId: string;
let completedAppointmentId: string;
let completedAppointmentCode: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@appointments-e2e.test`;
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

async function addMembership(tenant: string, userId: string, roleSlug?: string): Promise<void> {
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

  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    await getTestAdminPool().query(
      `insert into doctor_schedules
         (id, tenant_id, doctor_id, branch_id, day_of_week, start_time, end_time,
          slot_duration_minutes, buffer_minutes, effective_from, is_active)
       values ($1,$2,$3,$4,$5,'09:00:00','17:00:00',30,0,'2020-01-01',true)`,
      [randomUUID(), tenant, id, branch, dayOfWeek],
    );
  }

  return id;
}

function idempotency(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

function availabilitySlots(response: TestResponse): string[] {
  const availability = dataOf<{
    availability: { days: Array<{ slots: Array<{ startAt: string }> }> };
  }>(response).availability;

  return availability.days.flatMap((day) => day.slots.map((item) => iso(item.startAt)));
}

async function seedPastAppointment(): Promise<string> {
  const id = randomUUID();
  const { rows } = await getTestAdminPool().query<{ user_id: string }>(
    "select user_id from tenant_memberships where tenant_id = $1 limit 1",
    [tenantId],
  );

  await getTestAdminPool().query(
    `insert into appointments
       (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
        appointment_source, appointment_status, start_at, end_at,
        consultation_fee, currency, created_by)
     values ($1,$2,$3,$4,$5,$6,'RECEPTIONIST','CONFIRMED',
             now() - interval '2 hours', now() - interval '1 hour',
             '150.00','USD',$7)`,
    [
      id,
      tenantId,
      patientId,
      doctorId,
      branchId,
      `APT-SEED-${randomUUID().slice(0, 8).toUpperCase()}`,
      rows[0]?.user_id,
    ],
  );

  return id;
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  nurseApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@appointments-e2e.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "E2E Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Appointments E2E ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  branchId = await addBranch(tenantId, "E2E");

  const doctorAccount = await createAccount(`e2e-doctor-${suffix}`);
  await addMembership(tenantId, doctorAccount.id, "doctor");
  doctorId = await addDoctor(tenantId, doctorAccount.id, branchId, "150.00");
  await loginAs(doctorApi, doctorAccount.email);
  await selectTenant(doctorApi, tenantSlug);

  const secondDoctor = await createAccount(`e2e-doctor2-${suffix}`);
  await addMembership(tenantId, secondDoctor.id, "doctor");
  secondDoctorId = await addDoctor(tenantId, secondDoctor.id, branchId, "200.00");

  const nurse = await createAccount(`e2e-nurse-${suffix}`);
  await addMembership(tenantId, nurse.id, "nurse");
  await loginAs(nurseApi, nurse.email);
  await selectTenant(nurseApi, tenantSlug);

  const staff = await createAccount(`e2e-staff-${suffix}`);
  await addMembership(tenantId, staff.id);
  await loginAs(unprivilegedApi, staff.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  const patientResponse = await api.post(`${API}/patients`, {
    body: { fullName: "E2E Patient", gender: "OTHER" },
  });
  expect(patientResponse.status).toBe(201);
  patientId = dataOf<{ patient: { id: string } }>(patientResponse).patient.id;

  const otherAdminEmail = `e2e-other-${suffix}@appointments-e2e.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "E2E Other Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Appointments E2E Other ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  const otherBranchId = await addBranch(otherTenantId, "E2E Other");
  const otherDoctorAccount = await createAccount(`e2e-other-doctor-${suffix}`);
  await addMembership(otherTenantId, otherDoctorAccount.id, "doctor");
  const otherDoctorId = await addDoctor(
    otherTenantId,
    otherDoctorAccount.id,
    otherBranchId,
    "80.00",
  );

  const otherPatient = await otherApi.post(`${API}/patients`, {
    body: { fullName: "E2E Foreign Patient" },
  });
  expect(otherPatient.status).toBe(201);
  otherPatientId = dataOf<{ patient: { id: string } }>(otherPatient).patient.id;

  const otherAppointment = await otherApi.post(`${API}/appointments`, {
    body: {
      patientId: otherPatientId,
      doctorId: otherDoctorId,
      branchId: otherBranchId,
      startAt: slot(DAY_6, "09:00"),
    },
    headers: idempotency(`e2e-other-${randomUUID()}`),
  });
  expect(otherAppointment.status).toBe(201);
  otherAppointmentId = appointmentOf(otherAppointment).id;

  // A second doctor's appointment for doctor-scope checks.
  const secondDoctorAppointment = await api.post(`${API}/appointments`, {
    body: {
      patientId,
      doctorId: secondDoctorId,
      branchId,
      startAt: slot(DAY_6, "10:00"),
    },
    headers: idempotency(`e2e-doctor2-${randomUUID()}`),
  });
  expect(secondDoctorAppointment.status).toBe(201);
  secondDoctorAppointmentId = appointmentOf(secondDoctorAppointment).id;
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

describe("appointment end-to-end flow", () => {
  it("runs availability, booking, retrieval, history, check-in, start and completion", async () => {
    const availability = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_1}`,
    );
    expect(availability.status).toBe(200);
    expect(availabilitySlots(availability)).toContain(iso(slot(DAY_1, "09:00")));

    const booked = await api.post(`${API}/appointments`, {
      body: {
        patientId,
        doctorId,
        branchId,
        startAt: slot(DAY_1, "09:00"),
        reason: "End-to-end consultation",
      },
      headers: idempotency(`e2e-flow-${randomUUID()}`),
    });
    expect(booked.status).toBe(201);

    const appointment = appointmentOf(booked);
    completedAppointmentId = appointment.id;
    completedAppointmentCode = appointment.appointmentCode;
    expect(appointment.appointmentStatus).toBe("CONFIRMED");
    expect(appointment.consultationFee).toBe("150.00");

    const byId = await api.get(`${API}/appointments/${appointment.id}`);
    expect(byId.status).toBe(200);
    expect(appointmentOf(byId).id).toBe(appointment.id);

    const byCode = await api.get(`${API}/appointments/code/${appointment.appointmentCode}`);
    expect(byCode.status).toBe(200);
    expect(appointmentOf(byCode).id).toBe(appointment.id);

    const createdHistory = await api.get(
      `${API}/appointments/${appointment.id}/history`,
    );
    expect(createdHistory.status).toBe(200);
    expect(
      dataOf<{ events: Array<{ eventType: string }> }>(createdHistory).events.map(
        (event) => event.eventType,
      ),
    ).toEqual(["CREATED"]);

    const checkedIn = await api.post(`${API}/appointments/${appointment.id}/check-in`);
    expect(checkedIn.status).toBe(200);
    expect(appointmentOf(checkedIn).appointmentStatus).toBe("CHECKED_IN");

    const started = await api.post(`${API}/appointments/${appointment.id}/start`);
    expect(started.status).toBe(200);
    expect(appointmentOf(started).appointmentStatus).toBe("IN_PROGRESS");

    const completed = await api.post(`${API}/appointments/${appointment.id}/complete`);
    expect(completed.status).toBe(200);
    expect(appointmentOf(completed).appointmentStatus).toBe("COMPLETED");

    const history = await api.get(`${API}/appointments/${appointment.id}/history`);
    const events = dataOf<{
      appointment: AppointmentShape;
      events: Array<{ eventType: string; newStatus: string | null; actorUserId: string | null }>;
    }>(history);
    expect(events.appointment.appointmentStatus).toBe("COMPLETED");
    expect(events.events.map((event) => event.newStatus)).toEqual([
      "CONFIRMED",
      "CHECKED_IN",
      "IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(events.events.every((event) => event.actorUserId !== null)).toBe(true);

    const listed = await api.get(
      `${API}/appointments?status=COMPLETED&search=${completedAppointmentCode}`,
    );
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(listed).appointments.map((item) => item.id),
    ).toEqual([appointment.id]);

    // The terminal appointment releases its slot.
    const afterCompletion = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_1}`,
    );
    expect(availabilitySlots(afterCompletion)).toContain(iso(slot(DAY_1, "09:00")));
  });

  it("replays a booking with the same key and rejects the key with a different payload", async () => {
    const body = { patientId, doctorId, branchId, startAt: slot(DAY_2, "09:00") };
    const key = `e2e-replay-${randomUUID()}`;

    const first = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });
    expect(first.status).toBe(201);

    const replay = await api.post(`${API}/appointments`, {
      body,
      headers: idempotency(key),
    });
    expect(replay.status).toBe(200);
    expect(appointmentOf(replay).id).toBe(appointmentOf(first).id);
    expect(appointmentOf(replay).replayed).toBe(true);

    const conflict = await api.post(`${API}/appointments`, {
      body: { ...body, startAt: slot(DAY_2, "09:30") },
      headers: idempotency(key),
    });
    expect(conflict.status).toBe(409);
    expect(errorOf(conflict).code).toBe("IDEMPOTENCY_KEY_REUSED");

    const { rows } = await getTestAdminPool().query<{ count: number }>(
      `select count(*)::int as count from appointments
        where tenant_id = $1 and doctor_id = $2 and start_at = $3`,
      [tenantId, doctorId, new Date(slot(DAY_2, "09:00")).toISOString()],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("cancels, releases the slot and lets the interval be booked again", async () => {
    const booked = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_3, "09:00") },
      headers: idempotency(`e2e-cancel-${randomUUID()}`),
    });
    expect(booked.status).toBe(201);
    const appointmentId = appointmentOf(booked).id;

    const whileBooked = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_3}`,
    );
    expect(availabilitySlots(whileBooked)).not.toContain(iso(slot(DAY_3, "09:00")));

    const cancelled = await api.post(`${API}/appointments/${appointmentId}/cancel`, {
      body: { cancellationReason: "Patient called to cancel" },
      headers: idempotency(`e2e-cancel-key-${randomUUID()}`),
    });
    expect(cancelled.status).toBe(200);
    expect(appointmentOf(cancelled).appointmentStatus).toBe("CANCELLED");

    const released = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_3}`,
    );
    expect(availabilitySlots(released)).toContain(iso(slot(DAY_3, "09:00")));

    const rebooked = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_3, "09:00") },
      headers: idempotency(`e2e-rebook-${randomUUID()}`),
    });
    expect(rebooked.status).toBe(201);
    expect(appointmentOf(rebooked).appointmentStatus).toBe("CONFIRMED");

    const history = await api.get(`${API}/appointments/${appointmentId}/history`);
    expect(
      dataOf<{ events: Array<{ eventType: string }> }>(history).events.map(
        (event) => event.eventType,
      ),
    ).toContain("CANCELLED");
  });

  it("reschedules with the replacement model and releases the original interval", async () => {
    const booked = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_4, "09:00") },
      headers: idempotency(`e2e-reschedule-${randomUUID()}`),
    });
    expect(booked.status).toBe(201);
    const originalId = appointmentOf(booked).id;

    const moved = await api.post(`${API}/appointments/${originalId}/reschedule`, {
      body: { startAt: slot(DAY_4, "10:00"), reason: "Patient request" },
      headers: idempotency(`e2e-reschedule-key-${randomUUID()}`),
    });

    expect(moved.status).toBe(200);
    const result = dataOf<{ appointment: AppointmentShape; original: AppointmentShape }>(moved);
    expect(result.original.id).toBe(originalId);
    expect(result.original.appointmentStatus).toBe("RESCHEDULED");
    expect(result.appointment.appointmentStatus).toBe("CONFIRMED");
    expect(result.appointment.rescheduledFromAppointmentId).toBe(originalId);
    expect(iso(result.appointment.startAt)).toBe(iso(slot(DAY_4, "10:00")));

    const availability = await api.get(
      `${API}/appointments/availability?doctorId=${doctorId}&branchId=${branchId}&date=${DAY_4}`,
    );
    const slots = availabilitySlots(availability);
    expect(slots).toContain(iso(slot(DAY_4, "09:00")));
    expect(slots).not.toContain(iso(slot(DAY_4, "10:00")));

    const history = await api.get(`${API}/appointments/${originalId}/history`);
    const rescheduledEvent = dataOf<{
      events: Array<{ eventType: string; metadata: Record<string, unknown> }>;
    }>(history).events.find((event) => event.eventType === "RESCHEDULED");

    expect(rescheduledEvent).toBeDefined();
    expect(rescheduledEvent?.metadata.previousStartAt).toBe(
      new Date(slot(DAY_4, "09:00")).toISOString(),
    );
    expect(rescheduledEvent?.metadata.replacementAppointmentId).toBe(result.appointment.id);
  });

  it("records a no-show after the scheduled end only", async () => {
    const future = await api.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: slot(DAY_5, "09:00") },
      headers: idempotency(`e2e-noshow-${randomUUID()}`),
    });
    expect(future.status).toBe(201);

    const early = await api.post(`${API}/appointments/${appointmentOf(future).id}/no-show`, {
      body: {},
    });
    expect(early.status).toBe(409);
    expect(errorOf(early).code).toBe("NO_SHOW_TOO_EARLY");

    const pastId = await seedPastAppointment();
    const noShow = await api.post(`${API}/appointments/${pastId}/no-show`, {
      body: { reason: "Patient did not arrive" },
    });
    expect(noShow.status).toBe(200);
    expect(appointmentOf(noShow).appointmentStatus).toBe("NO_SHOW");
  });

  it("allows exactly one of two concurrent bookings for the same slot", async () => {
    const body = { patientId, doctorId, branchId, startAt: slot(DAY_6, "11:00") };

    const [first, second] = await Promise.all([
      api.post(`${API}/appointments`, {
        body,
        headers: idempotency(`e2e-race-a-${randomUUID()}`),
      }),
      api.post(`${API}/appointments`, {
        body,
        headers: idempotency(`e2e-race-b-${randomUUID()}`),
      }),
    ]);

    const statuses = [first.status, second.status].sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409]);

    const loser = first.status === 409 ? first : second;
    expect(errorOf(loser).code).toBe("SLOT_UNAVAILABLE");

    const { rows } = await getTestAdminPool().query<{ count: number; events: number }>(
      `select count(distinct a.id)::int as count,
              count(e.id)::int as events
         from appointments a
         left join appointment_events e
           on e.tenant_id = a.tenant_id and e.appointment_id = a.id
        where a.tenant_id = $1 and a.doctor_id = $2 and a.start_at = $3
          and a.appointment_status in ('PENDING','CONFIRMED','CHECKED_IN','IN_PROGRESS')`,
      [tenantId, doctorId, new Date(slot(DAY_6, "11:00")).toISOString()],
    );
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.events).toBe(1);
  });
});

describe("appointment security and isolation (end to end)", () => {
  it("rejects unauthenticated and under-privileged callers at every entry point", async () => {
    const anonymousList = await anonymousApi.get(`${API}/appointments`);
    expect(anonymousList.status).toBe(401);

    expect((await anonymousApi.get(`${API}/appointments/${completedAppointmentId}`)).status).toBe(
      401,
    );
    expect(
      (await anonymousApi.post(`${API}/appointments/${completedAppointmentId}/check-in`)).status,
    ).toBe(401);

    expect((await unprivilegedApi.get(`${API}/appointments`)).status).toBe(403);
    expect(
      (
        await unprivilegedApi.post(`${API}/appointments`, {
          body: { patientId, doctorId, branchId, startAt: slot(DAY_6, "12:00") },
          headers: idempotency(`e2e-unpriv-${randomUUID()}`),
        })
      ).status,
    ).toBe(403);

    // Nurse: read + update, no create/cancel.
    expect((await nurseApi.get(`${API}/appointments`)).status).toBe(200);
    expect(
      (
        await nurseApi.post(`${API}/appointments`, {
          body: { patientId, doctorId, branchId, startAt: slot(DAY_6, "12:30") },
          headers: idempotency(`e2e-nurse-${randomUUID()}`),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await nurseApi.post(`${API}/appointments/${secondDoctorAppointmentId}/cancel`, {
          body: { cancellationReason: "Nurse cannot cancel" },
        })
      ).status,
    ).toBe(403);

    // Doctor: read + update only, and only for their own appointments.
    expect(
      (
        await doctorApi.post(`${API}/appointments`, {
          body: { patientId, doctorId, branchId, startAt: slot(DAY_6, "13:00") },
          headers: idempotency(`e2e-doctor-${randomUUID()}`),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await doctorApi.post(`${API}/appointments/${secondDoctorAppointmentId}/cancel`, {
          body: { cancellationReason: "Doctor cannot cancel" },
        })
      ).status,
    ).toBe(403);

    const doctorList = await doctorApi.get(`${API}/appointments?limit=100`);
    expect(doctorList.status).toBe(200);
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(doctorList).appointments.every(
        (item) => item.doctorId === doctorId,
      ),
    ).toBe(true);

    expect(
      (await doctorApi.get(`${API}/appointments/${secondDoctorAppointmentId}`)).status,
    ).toBe(403);
    expect(
      (
        await doctorApi.post(`${API}/appointments/${secondDoctorAppointmentId}/reschedule`, {
          body: { startAt: slot(DAY_6, "14:00") },
        })
      ).status,
    ).toBe(403);
    expect(
      (await doctorApi.get(`${API}/appointments/${secondDoctorAppointmentId}/history`)).status,
    ).toBe(403);
  });

  it("never exposes or mutates another tenant's appointments", async () => {
    expect((await otherApi.get(`${API}/appointments/${completedAppointmentId}`)).status).toBe(404);
    expect(
      (await otherApi.get(`${API}/appointments/code/${completedAppointmentCode}`)).status,
    ).toBe(404);
    expect(
      (
        await otherApi.post(`${API}/appointments/${completedAppointmentId}/reschedule`, {
          body: { startAt: slot(DAY_6, "15:00") },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await otherApi.post(`${API}/appointments/${completedAppointmentId}/cancel`, {
          body: { cancellationReason: "Cross tenant" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await otherApi.post(`${API}/appointments/${completedAppointmentId}/check-in`)).status,
    ).toBe(404);
    expect(
      (await otherApi.get(`${API}/appointments/${completedAppointmentId}/history`)).status,
    ).toBe(404);

    // A foreign id is not resolvable as a booking reference either.
    expect(
      (
        await api.post(`${API}/appointments`, {
          body: { patientId: otherPatientId, doctorId, branchId, startAt: slot(DAY_6, "15:30") },
          headers: idempotency(`e2e-cross-${randomUUID()}`),
        })
      ).status,
    ).toBe(404);

    const foreignList = await otherApi.get(`${API}/appointments?limit=100`);
    expect(
      dataOf<{ appointments: AppointmentShape[] }>(foreignList).appointments.map(
        (item) => item.id,
      ),
    ).toEqual([otherAppointmentId]);
  });

  it("enforces appointment RLS with the restricted application role", async () => {
    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-e2e-rls-test",
    });
    const client = await pool.connect();

    try {
      const identity = await client.query<{ current_user: string; bypass: boolean }>(
        `select current_user,
                coalesce((select rolbypassrls from pg_roles where rolname = current_user), true) as bypass`,
      );
      expect(identity.rows[0]?.current_user).toBe("hospitalos_app");
      expect(identity.rows[0]?.bypass).toBe(false);

      // With tenant context: own row visible, foreign row invisible.
      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query("select set_config('app.is_platform', 'false', true)");

      const own = await client.query<{ id: string }>(
        "select id from appointments where id = $1",
        [completedAppointmentId],
      );
      expect(own.rows).toHaveLength(1);

      const foreign = await client.query<{ id: string }>(
        "select id from appointments where id = $1",
        [otherAppointmentId],
      );
      expect(foreign.rows).toHaveLength(0);

      const foreignEvents = await client.query<{ id: string }>(
        "select id from appointment_events where tenant_id = $1",
        [otherTenantId],
      );
      expect(foreignEvents.rows).toHaveLength(0);
      await client.query("rollback");

      // Without tenant context nothing is visible.
      await client.query("begin");
      const noContext = await client.query<{ count: number }>(
        "select count(*)::int as count from appointments",
      );
      expect(noContext.rows[0]?.count).toBe(0);
      await client.query("rollback");

      // A cross-tenant write is rejected by the RLS WITH CHECK.
      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await expect(
        client.query(
          `insert into appointment_idempotency_keys
             (tenant_id, operation, idempotency_key, request_hash, expires_at)
           values ($1, 'appointment.create', $2, repeat('a', 64), now() + interval '1 hour')`,
          [otherTenantId, `rls-${randomUUID()}`],
        ),
      ).rejects.toThrow();
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
