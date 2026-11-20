import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * Phase 22.2 HTTP tests for the dashboard analytics API.
 *
 * Fixtures are inserted through the elevated test pool; every request runs
 * through the app as the restricted `hospitalos_app` role, so tenant isolation
 * is exercised under RLS. Financial expectations use decimal strings to catch
 * accidental float conversions.
 *
 * Timezone boundary: the 2027-03-10T20:00Z appointment and 20:30Z registration
 * are still 10 March in UTC but 11 March in Asia/Kolkata.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";
const DAY = "fromDate=2027-03-10&toDate=2027-03-10";

interface Envelope<T> {
  data: T;
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): { code: string; message: string } {
  return (response.body as { error: { code: string; message: string } }).error;
}

let adminApi: TestApi;
let accountantApi: TestApi;
let doctorApi: TestApi;
let unprivilegedApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let adminUserId: string;
let tenantId: string;
let tenantSlug: string;
let branchA: string;
let branchB: string;
let otherTenantId: string;
let otherBranch: string;
let doctorId: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const tag = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const email = `${tag}-${randomUUID().slice(0, 8)}@dashboard-api.test`;
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

async function registerTenant(
  client: TestApi,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await client.post(`${API}/tenants/register`, { body: { name } });
  expect(response.status).toBe(201);

  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(response).tenant;
  createdTenantIds.push(tenant.id);
  await getTestAdminPool().query(
    "update tenants set status = 'ACTIVE', timezone = 'Asia/Kolkata' where id = $1",
    [tenant.id],
  );

  return tenant;
}

async function selectTenant(client: TestApi, slug: string): Promise<void> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  expect(response.status).toBe(200);
}

async function insertBranch(tenant: string, name: string, timezone: string): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 6);

  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, $3, $4, $5)`,
    [id, tenant, name, `${name.slice(0, 3)}-${suffix}`.toUpperCase(), timezone],
  );

  return id;
}

async function seedDashboardFixtures(doctorUserId: string): Promise<void> {
  const pool = getTestAdminPool();
  branchA = await insertBranch(tenantId, "Central", "Asia/Kolkata");
  branchB = await insertBranch(tenantId, "Riverside", "UTC");
  otherBranch = await insertBranch(otherTenantId, "Other", "UTC");

  const patientOne = randomUUID();
  const patientTwo = randomUUID();
  const patientThree = randomUUID();
  const otherPatient = randomUUID();
  await pool.query(
    `insert into patient_profiles
       (id, tenant_id, patient_code, full_name, status, created_at)
     values
       ($1,$4,$5,'Dashboard Patient One','ACTIVE','2027-03-01T04:00:00Z'),
       ($2,$4,$6,'Dashboard Patient Two','ACTIVE','2027-03-10T04:30:00Z'),
       ($3,$4,$7,'Dashboard Patient Three','ACTIVE','2027-03-10T20:30:00Z'),
       ($8,$9,$10,'Other Patient','ACTIVE','2027-03-10T04:00:00Z')`,
    [
      patientOne,
      patientTwo,
      patientThree,
      tenantId,
      `DASH-P-1-${randomUUID().slice(0, 6)}`,
      `DASH-P-2-${randomUUID().slice(0, 6)}`,
      `DASH-P-3-${randomUUID().slice(0, 6)}`,
      otherPatient,
      otherTenantId,
      `DASH-P-O-${randomUUID().slice(0, 6)}`,
    ],
  );

  doctorId = randomUUID();
  await pool.query(
    `insert into doctors
       (id, tenant_id, user_id, doctor_code, registration_number, is_active)
     values ($1,$2,$3,$4,$5,true)`,
    [
      doctorId,
      tenantId,
      doctorUserId,
      `DASH-DOC-${randomUUID().slice(0, 6)}`,
      `DASH-REG-${randomUUID().slice(0, 6)}`,
    ],
  );
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, is_active)
     values ($1,$2,$3,'100.00',true)`,
    [tenantId, doctorId, branchA],
  );

  const appointment = (
    status: string,
    startAt: string,
    endAt: string,
    cancellationReason: string | null = null,
  ) => [
    randomUUID(),
    tenantId,
    patientOne,
    doctorId,
    branchA,
    `DASH-AP-${randomUUID().slice(0, 8)}`,
    status,
    startAt,
    endAt,
    adminUserId,
    cancellationReason,
  ];

  const completed = appointment("COMPLETED", "2027-03-10T04:00:00Z", "2027-03-10T04:30:00Z");
  const cancelled = appointment(
    "CANCELLED",
    "2027-03-10T05:00:00Z",
    "2027-03-10T05:30:00Z",
    "Patient request",
  );
  const confirmed = appointment("CONFIRMED", "2027-03-10T06:00:00Z", "2027-03-10T06:30:00Z");
  const afterIstMidnight = appointment(
    "CONFIRMED",
    "2027-03-10T20:00:00Z",
    "2027-03-10T20:30:00Z",
  );

  await pool.query(
    `insert into appointments
       (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
        appointment_status, start_at, end_at, created_by, cancellation_reason,
        appointment_source, appointment_type, consultation_fee, currency)
     values
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'RECEPTIONIST','CONSULTATION','100.00','USD'),
       ($12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'RECEPTIONIST','CONSULTATION','100.00','USD'),
       ($23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,'RECEPTIONIST','CONSULTATION','100.00','USD'),
       ($34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,'RECEPTIONIST','CONSULTATION','100.00','USD')`,
    [
      ...completed,
      ...cancelled,
      ...confirmed,
      ...afterIstMidnight,
    ],
  );

  await pool.query(
    `insert into invoices
       (id, tenant_id, branch_id, patient_id, invoice_number, invoice_type,
        invoice_status, issue_date, currency, subtotal, discount_total, tax_total,
        total_amount, amount_paid, balance_due, created_by)
     values
       ($1,$3,$4,$5,$7,'CONSULTATION','ISSUED','2027-03-10','USD',
        '1000.00','0.00','0.00','1000.00','600.00','400.00',$9),
       ($2,$3,$4,$6,$8,'PHARMACY','PAID','2027-03-10','USD',
        '500.00','0.00','0.00','500.00','500.00','0.00',$9)`,
    [
      randomUUID(),
      randomUUID(),
      tenantId,
      branchA,
      patientOne,
      patientTwo,
      `DASH-INV-1-${randomUUID().slice(0, 6)}`,
      `DASH-INV-2-${randomUUID().slice(0, 6)}`,
      adminUserId,
    ],
  );

  await pool.query(
    `insert into payments
       (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
        payment_status, received_by, received_at)
     values ($1,$2,$3,$4,'CASH','600.00','USD','SUCCESSFUL',$5,'2027-03-10T04:00:00Z')`,
    [randomUUID(), tenantId, branchA, patientOne, adminUserId],
  );
}

beforeAll(async () => {
  adminApi = await createTestApi(createApp());
  accountantApi = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const admin = await createAccount("Dashboard Admin");
  adminUserId = admin.id;
  await loginAs(adminApi, admin.email);
  const tenant = await registerTenant(adminApi, `Dashboard API ${randomUUID().slice(0, 8)}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(adminApi, tenantSlug);

  const otherAdmin = await createAccount("Dashboard Other Admin");
  await loginAs(otherApi, otherAdmin.email);
  const otherTenant = await registerTenant(
    otherApi,
    `Dashboard Other ${randomUUID().slice(0, 8)}`,
  );
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  const accountant = await createAccount("Dashboard Accountant");
  await addMembership(tenantId, accountant.id, "accountant");
  await loginAs(accountantApi, accountant.email);
  await selectTenant(accountantApi, tenantSlug);

  // The doctor role is read-only and holds no payment:read permission.
  const doctorUser = await createAccount("Dashboard Doctor");
  await addMembership(tenantId, doctorUser.id, "doctor");
  await loginAs(doctorApi, doctorUser.email);
  await selectTenant(doctorApi, tenantSlug);

  const unprivileged = await createAccount("Dashboard No Role");
  await addMembership(tenantId, unprivileged.id);
  await loginAs(unprivilegedApi, unprivileged.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  await seedDashboardFixtures(doctorUser.id);
}, 60_000);

afterAll(async () => {
  if (createdTenantIds.length > 0) {
    await getTestAdminPool().query("delete from tenants where id = any($1::uuid[])", [
      createdTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await getTestAdminPool().query("delete from users where id = any($1::uuid[])", [
      createdUserIds,
    ]);
  }

  await Promise.all([
    adminApi.close(),
    accountantApi.close(),
    doctorApi.close(),
    unprivilegedApi.close(),
    otherApi.close(),
    anonymousApi.close(),
  ]);
  await closeTestAdminPool();
  await closePool();
}, 60_000);

describe("dashboard authentication and RBAC", () => {
  const endpoints = ["operational", "appointments", "patients", "doctors", "financial"];

  it("rejects unauthenticated requests on every dashboard endpoint", async () => {
    for (const endpoint of endpoints) {
      const response = await anonymousApi.get(`${API}/dashboard/${endpoint}?${DAY}`);
      expect(response.status).toBe(401);
    }
  });

  it("denies a hospital member with no permissions", async () => {
    for (const endpoint of endpoints) {
      const response = await unprivilegedApi.get(`${API}/dashboard/${endpoint}?${DAY}`);
      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe("FORBIDDEN");
    }
  });

  it("enforces the module read permission behind each summary", async () => {
    // Accountant: reports:read + payment/patient/appointment, but no doctor:read.
    expect((await accountantApi.get(`${API}/dashboard/financial?${DAY}`)).status).toBe(200);
    const deniedDoctors = await accountantApi.get(`${API}/dashboard/doctors?${DAY}`);
    expect(deniedDoctors.status).toBe(403);

    // Doctor: reports:read + doctor/patient/appointment, but no payment:read.
    expect((await doctorApi.get(`${API}/dashboard/doctors?${DAY}`)).status).toBe(200);
    const deniedFinancial = await doctorApi.get(`${API}/dashboard/financial?${DAY}`);
    expect(deniedFinancial.status).toBe(403);
    expect(errorOf(deniedFinancial).code).toBe("FORBIDDEN");
  });

  it("returns only the operational sections the caller may see", async () => {
    const accountant = await accountantApi.get(`${API}/dashboard/operational?${DAY}`);
    expect(accountant.status).toBe(200);
    const operational = dataOf<{ operational: Record<string, unknown> }>(accountant).operational;
    expect(operational).toHaveProperty("appointments");
    expect(operational).toHaveProperty("patients");
    expect(operational).not.toHaveProperty("doctors");
    expect(operational).not.toHaveProperty("financial");
  });
});

describe("dashboard summaries", () => {
  it("returns the operational overview for the selected branch", async () => {
    const response = await adminApi.get(
      `${API}/dashboard/operational?${DAY}&branchId=${branchA}`,
    );
    expect(response.status).toBe(200);

    const operational = dataOf<{
      operational: {
        fromDate: string;
        toDate: string;
        branchId: string | null;
        timezone: string;
        asOf: string;
        appointments: Record<string, number>;
        patients: Record<string, number>;
        doctors: {
          activeDoctors: number;
          workload: Array<Record<string, unknown>>;
        };
      };
    }>(response).operational;

    expect(operational).toMatchObject({
      fromDate: "2027-03-10",
      toDate: "2027-03-10",
      branchId: branchA,
      timezone: "Asia/Kolkata",
    });
    expect(Number.isNaN(Date.parse(operational.asOf))).toBe(false);
    expect(operational.appointments).toEqual({
      total: 3,
      completed: 1,
      cancelled: 1,
      upcoming: 1,
      noShows: 0,
    });
    expect(operational.patients).toEqual({ total: 3, newlyRegistered: 1 });
    expect(operational.doctors.activeDoctors).toBe(1);
    expect(operational.doctors.workload).toEqual([
      {
        doctorId,
        doctorCode: expect.stringContaining("DASH-DOC-"),
        doctorName: "Dashboard Doctor",
        appointmentCount: 3,
        completedCount: 1,
        upcomingCount: 1,
      },
    ]);
  });

  it("supports the appointment, patient and doctor summaries", async () => {
    const appointments = await adminApi.get(
      `${API}/dashboard/appointments?${DAY}&branchId=${branchA}`,
    );
    expect(appointments.status).toBe(200);
    expect(dataOf<{ appointments: Record<string, unknown> }>(appointments).appointments).toMatchObject({
      branchId: branchA,
      total: 3,
      completed: 1,
      cancelled: 1,
      upcoming: 1,
      noShows: 0,
    });

    const patients = await adminApi.get(`${API}/dashboard/patients?${DAY}`);
    expect(patients.status).toBe(200);
    expect(dataOf<{ patients: Record<string, unknown> }>(patients).patients).toMatchObject({
      total: 3,
      newlyRegistered: 1,
    });

    const doctors = await adminApi.get(`${API}/dashboard/doctors?${DAY}&branchId=${branchA}`);
    expect(doctors.status).toBe(200);
    expect(dataOf<{ doctors: Record<string, unknown> }>(doctors).doctors).toMatchObject({
      activeDoctors: 1,
      workload: [expect.objectContaining({ doctorId, appointmentCount: 3 })],
    });
  });

  it("applies the requested timezone to date boundaries", async () => {
    const appointments = await adminApi.get(
      `${API}/dashboard/appointments?${DAY}&branchId=${branchA}&timezone=UTC`,
    );
    expect(dataOf<{ appointments: Record<string, unknown> }>(appointments).appointments).toMatchObject({
      timezone: "UTC",
      total: 4,
      upcoming: 2,
    });

    const patients = await adminApi.get(`${API}/dashboard/patients?${DAY}&timezone=UTC`);
    expect(dataOf<{ patients: Record<string, unknown> }>(patients).patients).toMatchObject({
      timezone: "UTC",
      newlyRegistered: 2,
    });
  });

  it("returns decimal financial totals and pending balances", async () => {
    const response = await adminApi.get(
      `${API}/dashboard/financial?${DAY}&branchId=${branchA}`,
    );
    expect(response.status).toBe(200);

    expect(dataOf<{ financial: Record<string, unknown> }>(response).financial).toMatchObject({
      branchId: branchA,
      timezone: "Asia/Kolkata",
      invoiceCount: 2,
      revenue: [{ currency: "USD", amount: "1500.00" }],
      collections: [{ currency: "USD", amount: "600.00" }],
      refunds: [],
      netCollections: [{ currency: "USD", amount: "600.00" }],
      pendingInvoices: {
        invoiceCount: 1,
        outstanding: [{ currency: "USD", amount: "400.00" }],
      },
    });
  });

  it("applies the branch filter while keeping patient totals hospital-wide", async () => {
    const appointments = await adminApi.get(
      `${API}/dashboard/appointments?${DAY}&branchId=${branchB}`,
    );
    expect(
      dataOf<{ appointments: Record<string, number> }>(appointments).appointments,
    ).toMatchObject({ total: 0, completed: 0, upcoming: 0 });

    // Patient profiles have no branch column, so the branch filter cannot
    // narrow the patient totals; the explicit timezone keeps 10 March local.
    const patients = await adminApi.get(
      `${API}/dashboard/patients?${DAY}&branchId=${branchB}&timezone=Asia/Kolkata`,
    );
    expect(dataOf<{ patients: Record<string, number> }>(patients).patients).toMatchObject({
      total: 3,
      newlyRegistered: 1,
    });
  });
});

describe("dashboard validation and isolation", () => {
  it("rejects invalid query parameters", async () => {
    const invalidDate = await adminApi.get(
      `${API}/dashboard/operational?fromDate=2027-02-30&toDate=2027-03-10`,
    );
    expect(invalidDate.status).toBe(422);
    expect(errorOf(invalidDate).code).toBe("VALIDATION_ERROR");

    const reversed = await adminApi.get(
      `${API}/dashboard/operational?fromDate=2027-03-10&toDate=2027-03-01`,
    );
    expect(reversed.status).toBe(422);

    const oversized = await adminApi.get(
      `${API}/dashboard/operational?fromDate=2025-01-01&toDate=2027-03-10`,
    );
    expect(oversized.status).toBe(422);

    const badBranch = await adminApi.get(
      `${API}/dashboard/operational?${DAY}&branchId=not-a-uuid`,
    );
    expect(badBranch.status).toBe(422);

    const badTimezone = await adminApi.get(
      `${API}/dashboard/operational?${DAY}&timezone=Mars/Olympus`,
    );
    expect(badTimezone.status).toBe(422);
  });

  it("rejects a branch belonging to another hospital", async () => {
    const response = await adminApi.get(
      `${API}/dashboard/operational?${DAY}&branchId=${otherBranch}`,
    );
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("NOT_FOUND");
  });

  it("never exposes another tenant's metrics", async () => {
    const operational = await otherApi.get(`${API}/dashboard/operational?${DAY}`);
    expect(operational.status).toBe(200);
    const other = dataOf<{
      operational: {
        appointments: Record<string, number>;
        patients: Record<string, number>;
        doctors: { activeDoctors: number; workload: unknown[] };
      };
    }>(operational).operational;
    expect(other.appointments).toEqual({
      total: 0,
      completed: 0,
      cancelled: 0,
      upcoming: 0,
      noShows: 0,
    });
    // Only the other hospital's single fixture patient is visible.
    expect(other.patients).toEqual({ total: 1, newlyRegistered: 1 });
    expect(other.doctors).toEqual({ activeDoctors: 0, workload: [] });

    const financial = await otherApi.get(`${API}/dashboard/financial?${DAY}`);
    expect(dataOf<{ financial: Record<string, unknown> }>(financial).financial).toMatchObject({
      invoiceCount: 0,
      revenue: [],
      collections: [],
      refunds: [],
      netCollections: [],
      pendingInvoices: { invoiceCount: 0, outstanding: [] },
    });

    // A branch of the first hospital cannot be probed from the other tenant.
    const foreignBranch = await otherApi.get(
      `${API}/dashboard/operational?${DAY}&branchId=${branchA}`,
    );
    expect(foreignBranch.status).toBe(404);
  });
});
