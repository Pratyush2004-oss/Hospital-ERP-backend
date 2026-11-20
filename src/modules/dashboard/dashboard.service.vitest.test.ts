import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { getDashboardAnalytics } from "./dashboard.service.js";

/**
 * Phase 22.1 dashboard analytics tests.
 *
 * Real PostgreSQL as the restricted application role. Financial expectations
 * are deliberately expressed as decimal strings to catch accidental float use.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";
const RANGE_DAY = { fromDate: "2027-01-15", toDate: "2027-01-15" } as const;
const IST = "Asia/Kolkata";

const ACTOR = { permissions: new Set(["reports:read"]) };

interface Envelope<T> {
  data: T;
}

let adminApi: TestApi;
let adminUserId: string;
let tenantId: string;
let otherTenantId: string;
let branchA1: string;
let branchA2: string;
let otherBranch: string;
let doctorA1: string;
let doctorA2: string;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@dashboard-phase22.test`;
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

async function login(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  adminApi = await createTestApi(createApp());
  const admin = await createAccount(`dashboard-admin-${suffix}`);
  adminUserId = admin.id;
  await login(adminApi, admin.email);

  const tenantResponse = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Dashboard Phase 22 ${suffix}` },
  });
  expect(tenantResponse.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string } }>(tenantResponse).tenant;
  tenantId = tenant.id;
  createdTenantIds.push(tenantId);

  const otherResponse = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Dashboard Empty ${suffix}` },
  });
  expect(otherResponse.status).toBe(201);
  otherTenantId = dataOf<{ tenant: { id: string } }>(otherResponse).tenant.id;
  createdTenantIds.push(otherTenantId);

  branchA1 = randomUUID();
  branchA2 = randomUUID();
  otherBranch = randomUUID();
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values
       ($1,$3,'Central Branch',$6,'Asia/Kolkata',true),
       ($2,$3,'North Branch',$7,'UTC',true),
       ($4,$5,'Empty Branch',$8,'UTC',true)`,
    [
      branchA1,
      branchA2,
      tenantId,
      otherBranch,
      otherTenantId,
      `DB-C-${suffix}`,
      `DB-N-${suffix}`,
      `DB-E-${suffix}`,
    ],
  );

  const doctorUser1 = await createAccount(`dashboard-doctor-a-${suffix}`);
  const doctorUser2 = await createAccount(`dashboard-doctor-b-${suffix}`);
  const doctorUser3 = await createAccount(`dashboard-doctor-c-${suffix}`);
  doctorA1 = randomUUID();
  doctorA2 = randomUUID();
  const doctorInactive = randomUUID();
  await pool.query(
    `insert into doctors
       (id, tenant_id, user_id, doctor_code, registration_number, is_active)
     values
       ($1,$4,$7,$8,$9,true),
       ($2,$4,$5,$10,$11,true),
       ($3,$4,$6,$12,$13,false)`,
    [
      doctorA1,
      doctorA2,
      doctorInactive,
      tenantId,
      doctorUser2.id,
      doctorUser3.id,
      doctorUser1.id,
      `DASH-A-${suffix}`,
      `REG-A-${suffix}`,
      `DASH-B-${suffix}`,
      `REG-B-${suffix}`,
      `DASH-INACTIVE-${suffix}`,
      `REG-INACTIVE-${suffix}`,
    ],
  );
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, is_active)
     values ($1,$2,$3,'100.00',true), ($1,$4,$5,'100.00',true)`,
    [tenantId, doctorA1, branchA1, doctorA2, branchA2],
  );

  const patient1 = randomUUID();
  const patient2 = randomUUID();
  const patient3 = randomUUID();
  const deletedPatient = randomUUID();
  await pool.query(
    `insert into patient_profiles
       (id, tenant_id, patient_code, full_name, status, created_at, deleted_at)
     values
       ($1,$5,$6,'Dashboard Patient One','ACTIVE','2027-01-10T04:00:00Z',null),
       ($2,$5,$7,'Dashboard Patient Two','ACTIVE','2027-01-15T04:30:00Z',null),
       ($3,$5,$8,'Dashboard Patient Three','INACTIVE','2027-01-15T20:30:00Z',null),
       ($4,$5,$9,'Dashboard Deleted','ARCHIVED','2027-01-15T05:00:00Z','2027-01-20T00:00:00Z')`,
    [
      patient1,
      patient2,
      patient3,
      deletedPatient,
      tenantId,
      `DP-1-${suffix}`,
      `DP-2-${suffix}`,
      `DP-3-${suffix}`,
      `DP-D-${suffix}`,
    ],
  );

  await pool.query(
    `insert into appointments
       (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
        appointment_source, appointment_type, appointment_status, start_at, end_at,
        consultation_fee, currency, created_by, cancellation_reason)
     values
       ($1,$6,$7,$8,$9,$10,'RECEPTIONIST','CONSULTATION','COMPLETED',
        '2027-01-15T04:00:00Z','2027-01-15T04:30:00Z','100.00','USD',$11,null),
       ($2,$6,$7,$8,$9,$12,'RECEPTIONIST','CONSULTATION','CANCELLED',
        '2027-01-15T05:00:00Z','2027-01-15T05:30:00Z','100.00','USD',$11,'Patient request'),
       ($3,$6,$7,$8,$9,$13,'RECEPTIONIST','CONSULTATION','NO_SHOW',
        '2027-01-15T06:00:00Z','2027-01-15T06:30:00Z','100.00','USD',$11,null),
       ($4,$6,$7,$8,$9,$14,'RECEPTIONIST','CONSULTATION','CONFIRMED',
        '2027-01-15T07:00:00Z','2027-01-15T07:30:00Z','100.00','USD',$11,null),
       ($5,$6,$7,$8,$9,$15,'RECEPTIONIST','CONSULTATION','CONFIRMED',
        '2027-01-15T20:00:00Z','2027-01-15T20:30:00Z','100.00','USD',$11,null)`,
    [
      randomUUID(), // completed
      randomUUID(), // cancelled
      randomUUID(), // no-show
      randomUUID(), // confirmed
      randomUUID(), // confirmed after IST midnight
      tenantId,
      patient1,
      doctorA1,
      branchA1,
      `DASH-AP-1-${suffix}`,
      adminUserId,
      `DASH-AP-2-${suffix}`,
      `DASH-AP-3-${suffix}`,
      `DASH-AP-4-${suffix}`,
      `DASH-AP-5-${suffix}`,
    ],
  );

  await pool.query(
    `insert into appointments
       (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
        appointment_source, appointment_type, appointment_status, start_at, end_at,
        consultation_fee, currency, created_by)
     values ($1,$2,$3,$4,$5,$6,'RECEPTIONIST','CONSULTATION','COMPLETED',
             '2027-01-15T08:00:00Z','2027-01-15T08:30:00Z','100.00','USD',$7)`,
    [
      randomUUID(),
      tenantId,
      patient2,
      doctorA2,
      branchA2,
      `DASH-AP-6-${suffix}`,
      adminUserId,
    ],
  );

  await pool.query(
    `insert into invoices
       (id, tenant_id, branch_id, patient_id, invoice_number, invoice_type,
        invoice_status, issue_date, currency, subtotal, discount_total, tax_total,
        total_amount, amount_paid, balance_due, created_by)
     values
       ($1,$5,$6,$7,$9,'CONSULTATION','ISSUED','2027-01-15','USD',
        '1000.00','0.00','0.00','1000.00','600.00','400.00',$8),
       ($2,$5,$6,$7,$10,'PHARMACY','PAID','2027-01-15','USD',
        '500.00','0.00','0.00','500.00','500.00','0.00',$8),
       ($3,$5,$6,$7,$11,'LABORATORY','ISSUED','2027-01-16','USD',
        '300.00','0.00','0.00','300.00','0.00','300.00',$8),
       ($4,$5,$6,$7,$12,'OTHER','DRAFT','2027-01-15','USD',
        '999.00','0.00','0.00','999.00','0.00','999.00',$8)`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      tenantId,
      branchA1,
      patient1,
      adminUserId,
      `DASH-INV-1-${suffix}`,
      `DASH-INV-2-${suffix}`,
      `DASH-INV-3-${suffix}`,
      `DASH-INV-4-${suffix}`,
    ],
  );

  await pool.query(
    `insert into payments
       (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
        payment_status, received_by, received_at)
     values
       ($1,$4,$5,$6,'CASH','600.00','USD','SUCCESSFUL',$7,'2027-01-15T04:00:00Z'),
       ($2,$4,$5,$6,'CARD','200.00','USD','SUCCESSFUL',$7,'2027-01-16T04:00:00Z'),
       ($3,$4,$5,$6,'UPI','50.00','USD','FAILED',$7,'2027-01-15T05:00:00Z')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      tenantId,
      branchA1,
      patient1,
      adminUserId,
    ],
  );

  const invoiceRows = await pool.query<{ id: string }>(
    "select id from invoices where tenant_id=$1 and invoice_number=$2",
    [tenantId, `DASH-INV-1-${suffix}`],
  );
  const firstInvoiceId = invoiceRows.rows[0]?.id;
  if (!firstInvoiceId) throw new Error("Dashboard fixture invoice was not inserted");

  await pool.query(
    `insert into invoice_refunds
       (id, tenant_id, invoice_id, payment_id, amount, currency, refund_status,
        refunded_at, created_at, reason)
     values
       ($1,$3,$4,null,'100.00','USD','SUCCESSFUL','2027-01-15T05:00:00Z','2027-01-15T04:00:00Z','Test'),
       ($2,$3,$4,null,'50.00','USD','FAILED','2027-01-15T06:00:00Z','2027-01-15T04:00:00Z','Test')`,
    [randomUUID(), randomUUID(), tenantId, firstInvoiceId],
  );
});

afterAll(async () => {
  const pool = getTestAdminPool();

  await pool.query("begin");
  await pool.query("select set_config('app.audit_maintenance','true',true)");
  await pool.query("select set_config('app.is_platform','true',true)");
  await pool.query(
    `delete from audit_logs
      where tenant_id = any($1::uuid[]) or actor_user_id = any($2::uuid[])`,
    [createdTenantIds, createdUserIds],
  );
  await pool.query("commit");

  for (const tenant of createdTenantIds) {
    await pool.query("delete from tenants where id=$1", [tenant]);
  }
  for (const user of createdUserIds) {
    await pool.query("delete from users where id=$1", [user]);
  }

  await adminApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("dashboard analytics", () => {
  it("aggregates appointments, patients, doctors and decimal financials", async () => {
    const result = await getDashboardAnalytics(
      tenantId,
      { ...RANGE_DAY, branchId: branchA1, timezone: IST },
      ACTOR,
    );

    expect(result.branchId).toBe(branchA1);
    expect(result.timezone).toBe(IST);
    expect(Number.isNaN(Date.parse(result.asOf))).toBe(false);

    expect(result.appointments).toEqual({
      total: 4,
      completed: 1,
      cancelled: 1,
      upcoming: 1,
      noShows: 1,
    });
    expect(result.patients).toEqual({ total: 3, newlyRegistered: 1 });
    expect(result.doctors.activeDoctors).toBe(1);
    expect(result.doctors.workload).toEqual([
      {
        doctorId: doctorA1,
        doctorCode: expect.stringContaining("DASH-A-"),
        doctorName: expect.stringContaining("dashboard-doctor-a"),
        appointmentCount: 4,
        completedCount: 1,
        upcomingCount: 1,
      },
    ]);

    expect(result.financial).toMatchObject({
      invoiceCount: 2,
      revenue: [{ currency: "USD", amount: "1500.00" }],
      collections: [{ currency: "USD", amount: "600.00" }],
      refunds: [{ currency: "USD", amount: "100.00" }],
      netCollections: [{ currency: "USD", amount: "500.00" }],
      pendingInvoices: {
        invoiceCount: 1,
        outstanding: [{ currency: "USD", amount: "400.00" }],
      },
    });
  });

  it("applies the selected timezone to date boundaries", async () => {
    const result = await getDashboardAnalytics(
      tenantId,
      { ...RANGE_DAY, branchId: branchA1, timezone: "UTC" },
      ACTOR,
    );

    // The 20:00Z appointment and 20:30Z registration are still 15 January in
    // UTC but 16 January in the branch's Asia/Kolkata zone.
    expect(result.appointments).toMatchObject({ total: 5, upcoming: 2 });
    expect(result.patients.newlyRegistered).toBe(2);
    expect(result.doctors.workload[0]).toMatchObject({
      appointmentCount: 5,
      upcomingCount: 2,
    });
  });

  it("filters appointments, doctors and financials by branch", async () => {
    const result = await getDashboardAnalytics(
      tenantId,
      { ...RANGE_DAY, branchId: branchA2 },
      ACTOR,
    );

    expect(result.appointments).toMatchObject({ total: 1, completed: 1, upcoming: 0 });
    expect(result.doctors.activeDoctors).toBe(1);
    expect(result.doctors.workload).toEqual([
      expect.objectContaining({ doctorId: doctorA2, appointmentCount: 1 }),
    ]);

    // Patient totals are hospital-wide because patient profiles have no branch.
    expect(result.patients.total).toBe(3);
    expect(result.patients.newlyRegistered).toBe(2);

    expect(result.financial).toMatchObject({
      invoiceCount: 0,
      revenue: [],
      collections: [],
      refunds: [],
      netCollections: [],
      pendingInvoices: { invoiceCount: 0, outstanding: [] },
    });
  });

  it("supports a different inclusive date range", async () => {
    const result = await getDashboardAnalytics(
      tenantId,
      { fromDate: "2027-01-16", toDate: "2027-01-16", branchId: branchA1, timezone: IST },
      ACTOR,
    );

    expect(result.appointments).toEqual({
      total: 1,
      completed: 0,
      cancelled: 0,
      upcoming: 1,
      noShows: 0,
    });
    expect(result.patients.newlyRegistered).toBe(1);
    expect(result.financial).toMatchObject({
      invoiceCount: 1,
      revenue: [{ currency: "USD", amount: "300.00" }],
      collections: [{ currency: "USD", amount: "200.00" }],
      refunds: [],
      netCollections: [{ currency: "USD", amount: "200.00" }],
      pendingInvoices: {
        invoiceCount: 1,
        outstanding: [{ currency: "USD", amount: "300.00" }],
      },
    });
  });

  it("returns zeroed empty datasets without inventing currencies", async () => {
    const result = await getDashboardAnalytics(
      otherTenantId,
      { ...RANGE_DAY, branchId: otherBranch },
      ACTOR,
    );

    expect(result.appointments).toEqual({
      total: 0,
      completed: 0,
      cancelled: 0,
      upcoming: 0,
      noShows: 0,
    });
    expect(result.patients).toEqual({ total: 0, newlyRegistered: 0 });
    expect(result.doctors).toEqual({ activeDoctors: 0, workload: [] });
    expect(result.financial).toMatchObject({
      invoiceCount: 0,
      revenue: [],
      collections: [],
      refunds: [],
      netCollections: [],
      pendingInvoices: { invoiceCount: 0, outstanding: [] },
    });
  });

  it("enforces reports:read, tenant boundaries and filter validation", async () => {
    await expect(
      getDashboardAnalytics(tenantId, RANGE_DAY, { permissions: new Set() }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    // A branch from another hospital cannot be probed.
    await expect(
      getDashboardAnalytics(tenantId, { ...RANGE_DAY, branchId: otherBranch }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    await expect(
      getDashboardAnalytics(
        tenantId,
        { fromDate: "2027-02-01", toDate: "2027-01-01" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });

    await expect(
      getDashboardAnalytics(tenantId, { ...RANGE_DAY, timezone: "Mars/Olympus" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
  });

  it("keeps tenant data isolated under the restricted role and RLS", async () => {
    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-dashboard-rls-test",
    });
    const client = await pool.connect();

    try {
      const identity = await client.query<{ current_user: string; bypass: boolean }>(
        `select current_user,
                coalesce((select rolbypassrls from pg_roles where rolname = current_user), true) as bypass`,
      );
      expect(identity.rows[0]?.current_user).toBe("hospitalos_app");
      expect(identity.rows[0]?.bypass).toBe(false);

      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("select set_config('app.is_platform','false',true)");
      const own = await client.query<{ count: number }>(
        "select count(*)::int as count from patient_profiles",
      );
      const foreign = await client.query<{ count: number }>(
        "select count(*)::int as count from patient_profiles where tenant_id=$1",
        [otherTenantId],
      );
      expect(own.rows[0]?.count).toBe(4);
      expect(foreign.rows[0]?.count).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
