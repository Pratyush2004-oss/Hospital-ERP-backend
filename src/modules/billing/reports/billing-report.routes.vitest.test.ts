import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../app.js";
import { closePool } from "../../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../../test/http-client.js";

/**
 * Phase 19.9.2 HTTP tests for billing reports and CSV export.
 *
 * Fixtures are inserted through the elevated test pool; every request runs
 * through the app with the restricted `hospitalos_app` role, so tenant isolation
 * is exercised under RLS.
 *
 * Timezone fixture: 2026-01-31T20:00Z is 2026-02-01 01:30 in Asia/Kolkata, so a
 * January report for branch A must exclude that payment while a UTC report
 * includes it.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): { code: string; message: string } {
  return (response.body as { error: { code: string; message: string } }).error;
}

let api: TestApi;
let otherApi: TestApi;
let doctorApi: TestApi;
let unprivilegedApi: TestApi;
let anonymousApi: TestApi;

let adminUserId: string;
let tenantId: string;
let tenantSlug: string;
let branchA: string;
let branchB: string;
let otherTenantId: string;
let otherBranch: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const tag = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const email = `${tag}-${randomUUID().slice(0, 8)}@billing-reports.test`;
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

async function insertInvoice(values: {
  tenant: string;
  branch: string;
  patient: string;
  createdBy: string;
  number: string;
  type: string;
  status: string;
  issueDate: string;
  dueDate?: string;
  currency?: string;
  total: string;
  paid: string;
  balance: string;
}): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into invoices (
       id, tenant_id, branch_id, patient_id, invoice_number, invoice_type,
       invoice_status, issue_date, due_date, currency, subtotal, discount_total,
       tax_total, total_amount, amount_paid, balance_due, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'0.00','0.00',$11,$12,$13,$14)`,
    [
      id,
      values.tenant,
      values.branch,
      values.patient,
      values.number,
      values.type,
      values.status,
      values.issueDate,
      values.dueDate ?? null,
      values.currency ?? "USD",
      values.total,
      values.paid,
      values.balance,
      values.createdBy,
    ],
  );

  return id;
}

async function seedFinancials(
  patient: string,
  otherPatient: string,
  userId: string,
): Promise<void> {
  branchA = await insertBranch(tenantId, "Central", "Asia/Kolkata");
  branchB = await insertBranch(tenantId, "Riverside", "America/New_York");
  otherBranch = await insertBranch(otherTenantId, "Other", "UTC");

  await getTestAdminPool().query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, 'Report Patient'), ($4, $5, $6, 'Other Patient')`,
    [patient, tenantId, `MRN-${randomUUID().slice(0, 8)}`, otherPatient, otherTenantId, `MRN-O-${randomUUID().slice(0, 8)}`],
  );

  const suffix = randomUUID().slice(0, 8);

  await insertInvoice({
    tenant: tenantId,
    branch: branchA,
    patient,
    createdBy: userId,
    number: `R-${suffix}-1`,
    type: "CONSULTATION",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "1000.00",
    paid: "600.00",
    balance: "400.00",
  });
  const invoiceTwo = await insertInvoice({
    tenant: tenantId,
    branch: branchA,
    patient,
    createdBy: userId,
    number: `R-${suffix}-2`,
    type: "PHARMACY",
    status: "PARTIALLY_PAID",
    issueDate: "2026-01-20",
    total: "500.00",
    paid: "200.00",
    balance: "300.00",
  });
  const invoiceThree = await insertInvoice({
    tenant: tenantId,
    branch: branchA,
    patient,
    createdBy: userId,
    number: `R-${suffix}-3`,
    type: "OTHER",
    status: "OVERDUE",
    issueDate: "2026-01-02",
    dueDate: "2026-01-05",
    total: "250.00",
    paid: "100.00",
    balance: "150.00",
  });
  await insertInvoice({
    tenant: tenantId,
    branch: branchA,
    patient,
    createdBy: userId,
    number: `R-${suffix}-4`,
    type: "OTHER",
    status: "CANCELLED",
    issueDate: "2026-01-10",
    total: "200.00",
    paid: "0.00",
    balance: "200.00",
  });
  const branchBInvoice = await insertInvoice({
    tenant: tenantId,
    branch: branchB,
    patient,
    createdBy: userId,
    number: `R-${suffix}-5`,
    type: "CONSULTATION",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "700.00",
    paid: "400.00",
    balance: "300.00",
  });
  const otherInvoice = await insertInvoice({
    tenant: otherTenantId,
    branch: otherBranch,
    patient: otherPatient,
    createdBy: userId,
    number: `O-${suffix}-1`,
    type: "OTHER",
    status: "ISSUED",
    issueDate: "2026-01-15",
    total: "9999.00",
    paid: "0.00",
    balance: "9999.00",
  });

  const paymentOne = randomUUID();
  const paymentTwo = randomUUID();
  const failedPayment = randomUUID();
  const invoicePaymentOne = randomUUID();
  const invoicePaymentTwo = randomUUID();
  const branchPayment = randomUUID();

  await getTestAdminPool().query(
    `insert into payments (
       id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
       payment_status, received_by, received_at
     ) values
       ($1,$2,$3,$4,'CASH','600.00','USD','SUCCESSFUL',$5,'2026-01-15T20:00:00Z'),
       ($6,$2,$3,$4,'CARD','200.00','USD','SUCCESSFUL',$5,'2026-01-31T20:00:00Z'),
       ($7,$2,$3,$4,'UPI','50.00','USD','FAILED',$5,'2026-01-16T05:00:00Z'),
       ($8,$2,$9,$4,'CARD','400.00','USD','SUCCESSFUL',$5,'2026-01-15T15:00:00Z')`,
    [paymentOne, tenantId, branchA, patient, userId, paymentTwo, failedPayment, branchPayment, branchB],
  );

  await getTestAdminPool().query(
    `insert into invoice_payments (
       id, tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at
     ) values
       ($1,$2,$3,$4,'600.00','USD','SUCCESSFUL','2026-01-15T20:00:00Z'),
       ($5,$2,$6,$7,'200.00','USD','SUCCESSFUL','2026-01-31T20:00:00Z'),
       ($8,$2,$9,$10,'400.00','USD','SUCCESSFUL','2026-01-15T15:00:00Z')`,
    [
      invoicePaymentOne,
      tenantId,
      (await getTestAdminPool().query("select id from invoices where invoice_number like $1", [`R-${suffix}-1`])).rows[0].id,
      paymentOne,
      invoicePaymentTwo,
      invoiceTwo,
      paymentTwo,
      randomUUID(),
      branchBInvoice,
      branchPayment,
    ],
  );
  await getTestAdminPool().query(
    `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount)
     values ($1,$2,$3,'600.00'), ($1,$4,$5,'200.00')`,
    [
      tenantId,
      paymentOne,
      (await getTestAdminPool().query("select id from invoices where invoice_number like $1", [`R-${suffix}-1`])).rows[0].id,
      paymentTwo,
      invoiceTwo,
    ],
  );
  await getTestAdminPool().query(
    `insert into invoice_refunds (
       tenant_id, invoice_id, payment_id, amount, currency, refund_status, refunded_at, created_at
     ) values ($1,$2,$3,'100.00','USD','SUCCESSFUL','2026-01-25T10:00:00Z','2026-01-24T10:00:00Z')`,
    [
      tenantId,
      (await getTestAdminPool().query("select id from invoices where invoice_number like $1", [`R-${suffix}-1`])).rows[0].id,
      invoicePaymentOne,
    ],
  );

  // Keep references used by assertions from being tree-shaken by lint noise.
  expect(invoiceThree).toBeTruthy();
  expect(branchBInvoice).toBeTruthy();
  expect(otherInvoice).toBeTruthy();
  expect(failedPayment).toBeTruthy();
}

let januaryQuery: string;

beforeAll(async () => {
  api = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const admin = await createAccount("Report Admin");
  adminUserId = admin.id;

  await loginAs(api, admin.email);
  const tenant = await registerTenant(api, `Billing Reports ${randomUUID().slice(0, 8)}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  const otherAdmin = await createAccount("Other Report Admin");
  await loginAs(otherApi, otherAdmin.email);
  const otherTenant = await registerTenant(
    otherApi,
    `Other Billing Reports ${randomUUID().slice(0, 8)}`,
  );
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  const doctorUser = await createAccount("Report Doctor");
  await addMembership(tenantId, doctorUser.id, "doctor");
  await loginAs(doctorApi, doctorUser.email);
  await selectTenant(doctorApi, tenantSlug);

  const unprivileged = await createAccount("Report No Role");
  await addMembership(tenantId, unprivileged.id);
  await loginAs(unprivilegedApi, unprivileged.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  await seedFinancials(
    randomUUID(),
    randomUUID(),
    adminUserId,
  );

  januaryQuery = `fromDate=2026-01-01&toDate=2026-01-31&branchId=${branchA}`;
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
    api.close(),
    otherApi.close(),
    doctorApi.close(),
    unprivilegedApi.close(),
    anonymousApi.close(),
  ]);
  await closeTestAdminPool();
  await closePool();
}, 60_000);

describe("authentication and RBAC", () => {
  it("requires authentication", async () => {
    const response = await anonymousApi.get(`${API}/billing-reports/revenue?${januaryQuery}`);
    expect(response.status).toBe(401);
  });

  it("denies a member with no reporting role", async () => {
    const response = await unprivilegedApi.get(`${API}/billing-reports/revenue?${januaryQuery}`);
    expect(response.status).toBe(403);
  });

  it("allows reports:read but denies CSV without reports:export", async () => {
    const json = await doctorApi.get(`${API}/billing-reports/revenue?${januaryQuery}`);
    expect(json.status).toBe(200);

    const csv = await doctorApi.get(`${API}/billing-reports/revenue?${januaryQuery}&format=csv`);
    expect(csv.status).toBe(403);
    expect(errorOf(csv).code).toBe("FORBIDDEN");
  });
});

describe("revenue endpoints", () => {
  it("returns invoice, collection, refund and outstanding totals", async () => {
    const response = await api.get(`${API}/billing-reports/revenue?${januaryQuery}`);
    expect(response.status).toBe(200);

    const report = dataOf<{
      revenue: {
        timezone: string;
        invoiceCount: number;
        invoiced: Array<{ currency: string; amount: string }>;
        collected: Array<{ currency: string; amount: string }>;
        refunded: Array<{ currency: string; amount: string }>;
        netCollected: Array<{ currency: string; amount: string }>;
        outstanding: Array<{ currency: string; amount: string }>;
      };
    }>(response).revenue;

    expect(report.timezone).toBe("Asia/Kolkata");
    expect(report.invoiceCount).toBe(3);
    expect(report.invoiced).toEqual([{ currency: "USD", amount: "1750.00" }]);
    expect(report.collected).toEqual([{ currency: "USD", amount: "600.00" }]);
    expect(report.refunded).toEqual([{ currency: "USD", amount: "100.00" }]);
    expect(report.netCollected).toEqual([{ currency: "USD", amount: "500.00" }]);
    expect(report.outstanding).toEqual([{ currency: "USD", amount: "850.00" }]);
  });

  it("honours an explicit timezone at the boundary", async () => {
    const response = await api.get(
      `${API}/billing-reports/revenue?${januaryQuery}&timezone=UTC`,
    );
    const report = dataOf<{ revenue: { collected: Array<{ amount: string }> } }>(response).revenue;
    expect(report.collected).toEqual([{ currency: "USD", amount: "800.00" }]);
  });

  it("supports invoice type and invoice status filters", async () => {
    const consultation = await api.get(
      `${API}/billing-reports/revenue?${januaryQuery}&invoiceType=CONSULTATION`,
    );
    expect(consultation.status).toBe(200);
    expect(dataOf<{ revenue: { invoiced: unknown } }>(consultation).revenue.invoiced).toEqual([
      { currency: "USD", amount: "1000.00" },
    ]);

    const paid = await api.get(
      `${API}/billing-reports/revenue?${januaryQuery}&invoiceStatus=PAID`,
    );
    expect(paid.status).toBe(200);
    expect(dataOf<{ revenue: { invoiceCount: number } }>(paid).revenue.invoiceCount).toBe(0);
  });

  it("returns empty results rather than an error for an empty report", async () => {
    const response = await api.get(
      `${API}/billing-reports/revenue?fromDate=2030-01-01&toDate=2030-01-31&branchId=${branchA}`,
    );
    expect(response.status).toBe(200);

    const revenue = dataOf<{
      revenue: { invoiceCount: number; invoiced: unknown[]; collected: unknown[] };
    }>(response).revenue;
    expect(revenue).toMatchObject({ invoiceCount: 0, invoiced: [], collected: [] });
  });

  it("rejects invalid and excessively large ranges", async () => {
    const invalid = await api.get(
      `${API}/billing-reports/revenue?fromDate=2026-02-30&toDate=2026-03-01&branchId=${branchA}`,
    );
    expect(invalid.status).toBe(422);

    const reversed = await api.get(
      `${API}/billing-reports/revenue?fromDate=2026-02-01&toDate=2026-01-01&branchId=${branchA}`,
    );
    expect(reversed.status).toBe(422);

    const oversized = await api.get(
      `${API}/billing-reports/revenue?fromDate=2025-01-01&toDate=2026-02-01&branchId=${branchA}`,
    );
    expect(oversized.status).toBe(422);
    expect(errorOf(oversized).message).toBe("Request validation failed");
  });

  it("returns monthly revenue trends", async () => {
    const response = await api.get(
      `${API}/billing-reports/revenue/trends?${januaryQuery}&granularity=month`,
    );
    expect(response.status).toBe(200);

    const points = dataOf<{
      trends: { granularity: string; points: Array<Record<string, string>> };
    }>(response).trends;
    expect(points.granularity).toBe("month");
    expect(points.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          period: "2026-01-01",
          currency: "USD",
          invoiced: "1750.00",
          collected: "600.00",
          refunded: "100.00",
          netCollected: "500.00",
        }),
      ]),
    );
  });
});

describe("outstanding and pending reports", () => {
  it("sums outstanding balances and paginates invoice rows", async () => {
    const summary = await api.get(
      `${API}/billing-reports/outstanding?branchId=${branchA}&asOf=2026-01-31`,
    );
    expect(summary.status).toBe(200);
    expect(dataOf<{ outstanding: { invoiceCount: number; outstanding: unknown } }>(summary)).toMatchObject({
      outstanding: {
        invoiceCount: 3,
        outstanding: [{ currency: "USD", amount: "850.00" }],
      },
    });

    const page = await api.get(
      `${API}/billing-reports/outstanding/invoices?branchId=${branchA}&asOf=2026-01-31&page=1&limit=2`,
    );
    expect(page.status).toBe(200);
    expect((page.body as Envelope<unknown>).meta?.pagination).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });

    const rows = dataOf<{ invoices: Array<Record<string, string>> }>(page).invoices;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ branchName: "Central" });
    expect(rows[0]?.invoiceNumber).toMatch(/^R-/);
    expect(rows[0]).not.toHaveProperty("patientId");
    expect(rows[0]).not.toHaveProperty("patientName");

    const second = await api.get(
      `${API}/billing-reports/outstanding/invoices?branchId=${branchA}&asOf=2026-01-31&page=2&limit=2`,
    );
    expect(dataOf<{ invoices: unknown[] }>(second).invoices).toHaveLength(1);
  });

  it("filters record-level rows by overdue state", async () => {
    const response = await api.get(
      `${API}/billing-reports/outstanding/invoices?branchId=${branchA}&asOf=2026-01-31&state=OVERDUE`,
    );
    expect(response.status).toBe(200);
    expect((response.body as Envelope<unknown>).meta?.pagination?.total).toBe(1);
    expect(dataOf<{ invoices: Array<{ invoiceStatus: string }> }>(response).invoices[0]?.invoiceStatus).toBe(
      "OVERDUE",
    );
  });

  it("splits pending and overdue balances", async () => {
    const response = await api.get(`${API}/billing-reports/pending-overdue?${januaryQuery}`);
    expect(response.status).toBe(200);

    expect(dataOf<{ pendingOverdue: unknown }>(response)).toMatchObject({
      pendingOverdue: {
        pending: {
          invoiceCount: 2,
          outstanding: [{ currency: "USD", amount: "700.00" }],
        },
        overdue: {
          invoiceCount: 1,
          outstanding: [{ currency: "USD", amount: "150.00" }],
        },
      },
    });
  });
});

describe("summaries and breakdowns", () => {
  it("returns payment and refund summaries", async () => {
    const payments = await api.get(`${API}/billing-reports/payment-summary?${januaryQuery}`);
    expect(payments.status).toBe(200);
    expect(dataOf<{ payments: unknown[] }>(payments).payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "SUCCESSFUL",
          count: 1,
          totals: [{ currency: "USD", amount: "600.00" }],
        }),
        expect.objectContaining({
          status: "FAILED",
          count: 1,
          totals: [{ currency: "USD", amount: "50.00" }],
        }),
      ]),
    );

    const refunds = await api.get(`${API}/billing-reports/refund-summary?${januaryQuery}`);
    expect(dataOf<{ refunds: unknown[] }>(refunds).refunds).toEqual([
      {
        status: "SUCCESSFUL",
        count: 1,
        totals: [{ currency: "USD", amount: "100.00" }],
      },
    ]);
  });

  it("returns branch, payment-method, invoice-type, doctor and department breakdowns", async () => {
    const branches = await api.get(`${API}/billing-reports/branches?${januaryQuery}`);
    expect(branches.status).toBe(200);
    expect(dataOf<{ branches: unknown[] }>(branches).branches).toEqual([
      expect.objectContaining({
        branchId: branchA,
        branchName: "Central",
        invoiced: "1750.00",
        collected: "600.00",
        refunded: "100.00",
        outstanding: "850.00",
      }),
    ]);

    const methods = await api.get(`${API}/billing-reports/payment-methods?${januaryQuery}`);
    expect(dataOf<{ paymentMethods: unknown[] }>(methods).paymentMethods).toEqual([
      {
        paymentMethod: "CASH",
        currency: "USD",
        paymentCount: 1,
        collected: "600.00",
        refunded: "100.00",
        netCollected: "500.00",
      },
    ]);

    const types = await api.get(
      `${API}/billing-reports/invoice-types?${januaryQuery}`,
    );
    expect(dataOf<{ invoiceTypes: unknown[] }>(types).invoiceTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invoiceType: "CONSULTATION", invoiced: "1000.00" }),
        expect.objectContaining({ invoiceType: "PHARMACY", invoiced: "500.00" }),
      ]),
    );

    const statuses = await api.get(`${API}/billing-reports/invoice-status?${januaryQuery}`);
    expect(dataOf<{ invoiceStatus: unknown[] }>(statuses).invoiceStatus).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ISSUED", count: 1 })]),
    );

    // No appointment fixtures in this suite: doctor/department attribution is
    // empty but the endpoints are authorized and structurally valid.
    const doctors = await api.get(`${API}/billing-reports/doctors?${januaryQuery}`);
    expect(doctors.status).toBe(200);
    expect(dataOf<{ doctors: unknown[] }>(doctors).doctors).toEqual([]);

    const departments = await api.get(
      `${API}/billing-reports/departments?${januaryQuery}`,
    );
    expect(departments.status).toBe(200);
    expect(dataOf<{ departments: unknown[] }>(departments).departments).toEqual([]);
  });
});

describe("CSV export", () => {
  it("exports the revenue report with the same totals as JSON", async () => {
    const response = await api.get(
      `${API}/billing-reports/revenue?${januaryQuery}&format=csv`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("billing-revenue-");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const csv = response.body as string;
    expect(csv.split("\n")[0]).toBe(
      "from_date,to_date,timezone,currency,invoice_count,invoiced,collected,refunded,net_collected,outstanding",
    );
    expect(csv).toContain("2026-01-01,2026-01-31,Asia/Kolkata,USD,3,1750.00,600.00,100.00,500.00,850.00");
  });

  it("exports record-level outstanding invoices without patient data", async () => {
    const response = await api.get(
      `${API}/billing-reports/outstanding/invoices?branchId=${branchA}&asOf=2026-01-31&format=csv`,
    );
    expect(response.status).toBe(200);

    const csv = response.body as string;
    expect(csv.split("\n")[0]).toContain("invoice_number,status,invoice_type");
    expect(csv).toContain("Central");
    expect(csv).not.toContain("Report Patient");
    expect(csv).not.toContain("patient");
  });

  it("rejects invalid pagination limits", async () => {
    const response = await api.get(
      `${API}/billing-reports/outstanding/invoices?branchId=${branchA}&limit=101`,
    );
    expect(response.status).toBe(422);
  });
});

describe("tenant and branch isolation", () => {
  it("rejects a branch filter that belongs to another tenant", async () => {
    const response = await api.get(
      `${API}/billing-reports/revenue?fromDate=2026-01-01&toDate=2026-01-31&branchId=${otherBranch}`,
    );
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("NOT_FOUND");
  });

  it("never includes another tenant's financial records", async () => {
    const response = await otherApi.get(
      `${API}/billing-reports/revenue?fromDate=2026-01-01&toDate=2026-01-31`,
    );
    expect(response.status).toBe(200);

    const report = dataOf<{
      revenue: { invoiceCount: number; invoiced: unknown; collected: unknown };
    }>(response).revenue;
    expect(report.invoiceCount).toBe(1);
    expect(report.invoiced).toEqual([{ currency: "USD", amount: "9999.00" }]);
    expect(report.collected).toEqual([]);
  });

  it("rejects a cross-tenant branch even when it is supplied by the other admin", async () => {
    const response = await otherApi.get(
      `${API}/billing-reports/revenue?fromDate=2026-01-01&toDate=2026-01-31&branchId=${branchA}`,
    );
    expect(response.status).toBe(404);
  });
});
