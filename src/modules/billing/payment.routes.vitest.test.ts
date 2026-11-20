import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { createInvoice } from "./invoice.service.js";
import { cancelInvoice, issueInvoice } from "./invoice.lifecycle.service.js";

/**
 * HTTP-level tests for the Phase 19.5.1 payment API.
 *
 * The Phase 19.4 suites already prove the financial rules (allocation math,
 * concurrency, idempotency, reconciliation). These tests prove the HTTP layer:
 * routing, strict Zod validation, the session-derived tenant and actor, RBAC,
 * CSRF, tenant isolation, pagination/filters and the error envelope.
 *
 * Invoices have no API yet, so fixtures are created through the invoice
 * services (the same functions the app calls) and the tenant's branch is
 * inserted with the admin pool. Everything a client can do goes through HTTP.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface PaymentShape {
  id: string;
  branchId: string;
  patientId: string;
  paymentMethod: string;
  amount: string;
  currency: string;
  paymentStatus: string;
  reference: string | null;
  notes?: string | null;
  receivedBy: string;
  receivedAt: string;
  idempotencyKey: string | null;
  createdAt: string;
  allocations?: Array<{
    id: string;
    invoiceId: string;
    invoiceNumber: string;
    amount: string;
  }>;
}

interface InvoiceBalanceShape {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  currency: string;
  totalAmount: string;
  amountPaid: string;
  balanceDue: string;
}

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ source?: string; path?: string; code?: string; message?: string }>;
  };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

let api: TestApi;
let receptionistApi: TestApi;
let branchAdminApi: TestApi;
let doctorApi: TestApi;
let unprivilegedApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let adminUserId: string;
let tenantId: string;
let branchId: string;
let otherBranchId: string;
let patientId: string;
let otherPatientId: string;
let invoiceId: string;
let otherPatientInvoiceId: string;
let otherBranchInvoiceId: string;
let otherTenantId: string;
let otherTenantBranchId: string;
let otherTenantPatientId: string;
let otherTenantInvoiceId: string;

let firstPaymentId: string;
let firstPaymentReference: string;
let paidInvoiceId: string;
let otherTenantPaymentId: string | null = null;
let otherTenantPaymentReference: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@payments-api.test`;
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

/** Branches have an API, but invoices above them do not; keep fixtures uniform. */
async function createBranch(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 6);

  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, $3, $4, 'UTC')`,
    [id, tenant, label, `${label}-${suffix}`.slice(0, 20).toUpperCase()],
  );

  return id;
}

async function createPatient(client: TestApi, name: string): Promise<string> {
  const response = await client.post(`${API}/patients`, { body: { fullName: name } });
  expect(response.status).toBe(201);

  return dataOf<{ patient: { id: string } }>(response).patient.id;
}

async function createIssuedInvoice(
  tenant: string,
  actorUserId: string,
  patient: string,
  branch: string,
  unitPrice = "100.00",
): Promise<string> {
  const draft = await createInvoice(tenant, {
    branchId: branch,
    patientId: patient,
    createdBy: actorUserId,
    items: [
      { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice },
    ],
  });

  await issueInvoice(tenant, draft.id, { userId: actorUserId });

  return draft.id;
}

function recordingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branchId,
    patientId,
    method: "CASH",
    amount: "60.00",
    reference: `RCPT-${randomUUID().slice(0, 8)}`,
    allocations: [{ invoiceId, amount: "60.00" }],
    ...overrides,
  };
}

function record(
  client: TestApi,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> {
  return client.post(`${API}/payments`, {
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

function paymentOf(response: TestResponse): PaymentShape {
  return dataOf<{ payment: PaymentShape }>(response).payment;
}

function balancesOf(response: TestResponse): InvoiceBalanceShape[] {
  return dataOf<{ invoiceBalances: InvoiceBalanceShape[] }>(response).invoiceBalances;
}

async function paymentCount(tenant: string = tenantId): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from payments where tenant_id = $1",
    [tenant],
  );
  return (result.rows[0] as { count: number }).count;
}

async function invoiceHeader(invoice: string): Promise<{
  invoice_status: string;
  amount_paid: string;
  balance_due: string;
}> {
  const result = await getTestAdminPool().query(
    "select invoice_status, amount_paid, balance_due from invoices where id = $1",
    [invoice],
  );
  return result.rows[0] as {
    invoice_status: string;
    amount_paid: string;
    balance_due: string;
  };
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  receptionistApi = await createTestApi(createApp());
  branchAdminApi = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);
  const adminEmail = `admin-${suffix}@payments-api.test`;

  const registered = await api.post(`${API}/auth/register`, {
    body: { fullName: "Payment Admin", email: adminEmail, password: PASSWORD },
  });
  expect(registered.status).toBe(201);
  const adminId = dataOf<{ user: { id: string } }>(registered).user.id;
  adminUserId = adminId;
  createdUserIds.push(adminId);

  await loginAs(api, adminEmail);
  const tenant = await registerTenant(api, `Payments API ${suffix}`);
  tenantId = tenant.id;
  await selectTenant(api, tenant.slug);

  branchId = await createBranch(tenantId, "MAIN");
  otherBranchId = await createBranch(tenantId, "EAST");

  patientId = await createPatient(api, "Ada Payment");
  otherPatientId = await createPatient(api, "Grace Payment");

  invoiceId = await createIssuedInvoice(tenantId, adminId, patientId, branchId);
  paidInvoiceId = await createIssuedInvoice(tenantId, adminId, patientId, branchId, "40.00");
  otherPatientInvoiceId = await createIssuedInvoice(
    tenantId,
    adminId,
    otherPatientId,
    branchId,
  );
  otherBranchInvoiceId = await createIssuedInvoice(
    tenantId,
    adminId,
    patientId,
    otherBranchId,
  );

  // Front desk: payment:read + payment:create.
  const receptionist = await createAccount(`receptionist-${suffix}`);
  await addMembership(tenantId, receptionist.id, "receptionist");
  await loginAs(receptionistApi, receptionist.email);
  await selectTenant(receptionistApi, tenant.slug);

  // Branch admin: payment:read only - may audit receipts but not collect.
  const branchAdmin = await createAccount(`branch-admin-${suffix}`);
  await addMembership(tenantId, branchAdmin.id, "branch_admin");
  await loginAs(branchAdminApi, branchAdmin.email);
  await selectTenant(branchAdminApi, tenant.slug);

  // Doctor: no payment keys at all.
  const doctor = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctor.id, "doctor");
  await loginAs(doctorApi, doctor.email);
  await selectTenant(doctorApi, tenant.slug);

  // Active membership with no role: authenticated but holds no payment keys.
  const unprivileged = await createAccount(`staff-${suffix}`);
  await addMembership(tenantId, unprivileged.id);
  await loginAs(unprivilegedApi, unprivileged.email);
  await selectTenant(unprivilegedApi, tenant.slug);

  // A second hospital, with its own patient and invoice.
  const otherAdminEmail = `other-admin-${suffix}@payments-api.test`;
  const otherRegistered = await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Payment Admin", email: otherAdminEmail, password: PASSWORD },
  });
  expect(otherRegistered.status).toBe(201);
  const otherAdminId = dataOf<{ user: { id: string } }>(otherRegistered).user.id;
  createdUserIds.push(otherAdminId);

  await loginAs(otherApi, otherAdminEmail);
  const otherTenant = await registerTenant(otherApi, `Other Payments API ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherTenantBranchId = await createBranch(otherTenant.id, "MAIN");
  otherTenantPatientId = await createPatient(otherApi, "Foreign Payment Patient");
  otherTenantInvoiceId = await createIssuedInvoice(
    otherTenant.id,
    otherAdminId,
    otherTenantPatientId,
    otherTenantBranchId,
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
  await receptionistApi.close();
  await branchAdminApi.close();
  await doctorApi.close();
  await unprivilegedApi.close();
  await otherApi.close();
  await anonymousApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("payment routes", () => {
  it("records a manual payment and returns the post-payment invoice balances", async () => {
    firstPaymentReference = `RCPT-${randomUUID().slice(0, 8)}`;
    const response = await record(
      api,
      recordingBody({ reference: firstPaymentReference }),
      "route-test-first-payment",
    );

    expect(response.status).toBe(201);

    const payment = paymentOf(response);
    expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payment).toMatchObject({
      branchId,
      patientId,
      paymentMethod: "CASH",
      amount: "60.00",
      currency: "USD",
      paymentStatus: "SUCCESSFUL",
      reference: firstPaymentReference,
      idempotencyKey: "route-test-first-payment",
    });
    expect(payment.receivedBy).toMatch(/^[0-9a-f-]{36}$/);

    // The allocation is echoed with the invoice number, never the raw ledger.
    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations?.[0]).toMatchObject({ invoiceId, amount: "60.00" });
    expect(payment.allocations?.[0]?.invoiceNumber).toMatch(/^INV-/);

    const balances = balancesOf(response);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      invoiceId,
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "60.00",
      balanceDue: "40.00",
    });

    // The invoice header really moved, not just the response.
    const stored = await getTestAdminPool().query(
      "select amount_paid, balance_due from invoices where id = $1",
      [invoiceId],
    );
    expect(stored.rows[0]).toEqual({ amount_paid: "60.00", balance_due: "40.00" });

    firstPaymentId = payment.id;
  });

  it("replays a retried recording instead of collecting twice", async () => {
    const body = recordingBody({
      amount: "40.00",
      allocations: [{ invoiceId: paidInvoiceId, amount: "40.00" }],
    });
    const key = "route-test-replay";

    const created = await record(receptionistApi, body, key);
    expect(created.status).toBe(201);
    expect(dataOf<{ replayed: boolean }>(created).replayed).toBe(false);

    const replay = await record(receptionistApi, body, key);
    expect(replay.status).toBe(200);
    expect(dataOf<{ replayed: boolean }>(replay).replayed).toBe(true);
    expect(paymentOf(replay).id).toBe(paymentOf(created).id);

    const count = await getTestAdminPool().query(
      "select count(*)::int as count from payments where tenant_id = $1 and idempotency_key = $2",
      [tenantId, key],
    );
    expect((count.rows[0] as { count: number }).count).toBe(1);

    // A key reused with a different request is a conflict, not a second receipt.
    const reused = await record(
      receptionistApi,
      recordingBody({
        amount: "1.00",
        allocations: [{ invoiceId: paidInvoiceId, amount: "1.00" }],
      }),
      key,
    );
    expect(reused.status).toBe(409);
    expect(errorOf(reused).code).toBe("CONFLICT");
  });

  it("requires an idempotency key and rejects a header/body mismatch", async () => {
    const missing = await api.post(`${API}/payments`, { body: recordingBody() });
    expect(missing.status).toBe(422);
    expect(errorOf(missing).code).toBe("VALIDATION_ERROR");

    const mismatch = await api.post(`${API}/payments`, {
      body: recordingBody({ idempotencyKey: "body-key" }),
      headers: { "idempotency-key": "header-key" },
    });
    expect(mismatch.status).toBe(422);
    expect(errorOf(mismatch).code).toBe("VALIDATION_ERROR");

    // The body field alone is enough when no header is sent.
    const fromBody = await api.post(`${API}/payments`, {
      body: recordingBody({
        idempotencyKey: "body-only-key",
        amount: "10.00",
        allocations: [{ invoiceId, amount: "10.00" }],
      }),
    });
    expect(fromBody.status).toBe(201);
  });

  it("rejects malformed bodies, invalid references and server-owned fields", async () => {
    const cases: unknown[] = [
      {},
      { ...recordingBody(), allocations: [] },
      { ...recordingBody(), amount: "0", allocations: [{ invoiceId, amount: "0" }] },
      { ...recordingBody(), amount: "-5.00" },
      { ...recordingBody(), amount: "10.001" },
      { ...recordingBody(), amount: "abc" },
      { ...recordingBody(), method: "CRYPTO" },
      { ...recordingBody(), branchId: "not-a-uuid" },
      { ...recordingBody(), reference: "x".repeat(121) },
      { ...recordingBody(), receivedAt: "2026-01-01T00:00:00" },
      { ...recordingBody(), allocations: [{ invoiceId: "nope", amount: "10.00" }] },
      // Server-owned fields must not be accepted.
      { ...recordingBody(), tenantId: randomUUID() },
      { ...recordingBody(), receivedBy: randomUUID() },
      { ...recordingBody(), paymentStatus: "FAILED" },
      { ...recordingBody(), createdAt: new Date().toISOString() },
    ];

    for (const body of cases) {
      const response = await record(api, body as Record<string, unknown>);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }

    // A future collection date is rejected by the service, not by shape.
    const future = await record(
      api,
      recordingBody({
        receivedAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    expect(future.status).toBe(422);
    expect(errorOf(future).code).toBe("VALIDATION_ERROR");
  });

  it("propagates allocation and relationship errors from the payment service", async () => {
    const sumMismatch = await record(
      api,
      recordingBody({ amount: "60.00", allocations: [{ invoiceId, amount: "50.00" }] }),
    );
    expect(sumMismatch.status).toBe(422);
    expect(errorOf(sumMismatch).code).toBe("VALIDATION_ERROR");

    const duplicateInvoice = await record(
      api,
      recordingBody({
        amount: "20.00",
        allocations: [
          { invoiceId, amount: "10.00" },
          { invoiceId, amount: "10.00" },
        ],
      }),
    );
    expect(duplicateInvoice.status).toBe(422);

    const exceedsBalance = await record(
      api,
      recordingBody({
        amount: "500.00",
        allocations: [{ invoiceId, amount: "500.00" }],
      }),
    );
    expect(exceedsBalance.status).toBe(422);
    expect(errorOf(exceedsBalance).message).toMatch(/outstanding balance/i);

    const wrongPatient = await record(
      api,
      recordingBody({
        amount: "10.00",
        allocations: [{ invoiceId: otherPatientInvoiceId, amount: "10.00" }],
      }),
    );
    expect(wrongPatient.status).toBe(400);

    const wrongBranch = await record(
      api,
      recordingBody({
        amount: "10.00",
        allocations: [{ invoiceId: otherBranchInvoiceId, amount: "10.00" }],
      }),
    );
    expect(wrongBranch.status).toBe(400);
    expect(errorOf(wrongBranch).message).toMatch(/branch/i);

    const duplicateReference = await record(
      api,
      recordingBody({
        reference: firstPaymentReference,
        amount: "1.00",
        allocations: [{ invoiceId, amount: "1.00" }],
      }),
    );
    expect(duplicateReference.status).toBe(409);
    expect(errorOf(duplicateReference).code).toBe("CONFLICT");
  });

  it("reads one payment with its allocations and hides another tenant's receipt", async () => {
    const detail = await api.get(`${API}/payments/${firstPaymentId}`);
    expect(detail.status).toBe(200);

    const payment = paymentOf(detail);
    expect(payment.id).toBe(firstPaymentId);
    expect(payment.notes).toBeNull();
    expect(payment.allocations).toHaveLength(1);

    const allocations = await api.get(`${API}/payments/${firstPaymentId}/allocations`);
    expect(allocations.status).toBe(200);
    expect(dataOf<{ allocations: PaymentShape["allocations"] }>(allocations).allocations).toEqual(
      payment.allocations,
    );

    const unknown = await api.get(`${API}/payments/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("NOT_FOUND");

    const malformed = await api.get(`${API}/payments/not-a-payment-id`);
    expect(malformed.status).toBe(422);
    expect(errorOf(malformed).code).toBe("VALIDATION_ERROR");

    // Same hospital, different tenant: the receipt does not exist for them.
    const foreign = await otherApi.get(`${API}/payments/${firstPaymentId}`);
    expect(foreign.status).toBe(404);
    const foreignAllocations = await otherApi.get(
      `${API}/payments/${firstPaymentId}/allocations`,
    );
    expect(foreignAllocations.status).toBe(404);
  });

  it("lists payments with pagination metadata and filters", async () => {
    const all = await api.get(`${API}/payments?page=1&limit=1`);
    expect(all.status).toBe(200);

    const body = all.body as Envelope<{ payments: PaymentShape[] }>;
    expect(body.data.payments).toHaveLength(1);
    expect(body.meta?.pagination).toMatchObject({ page: 1, pageSize: 1 });
    expect(body.meta?.pagination?.total).toBeGreaterThanOrEqual(3);
    expect(body.meta?.pagination?.totalPages).toBe(body.meta?.pagination?.total);

    const second = await api.get(`${API}/payments?page=2&limit=1`);
    expect(second.status).toBe(200);
    expect(dataOf<{ payments: PaymentShape[] }>(second).payments[0]?.id).not.toBe(
      body.data.payments[0]?.id,
    );

    const byReference = await api.get(
      `${API}/payments?reference=${encodeURIComponent(firstPaymentReference)}`,
    );
    expect(byReference.status).toBe(200);
    const filtered = dataOf<{ payments: PaymentShape[] }>(byReference).payments;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(firstPaymentId);

    const byPatient = await api.get(`${API}/payments?patientId=${patientId}`);
    expect(
      dataOf<{ payments: PaymentShape[] }>(byPatient).payments.every(
        (payment) => payment.patientId === patientId,
      ),
    ).toBe(true);

    const byMethod = await api.get(`${API}/payments?method=CARD`);
    expect(dataOf<{ payments: PaymentShape[] }>(byMethod).payments).toEqual([]);

    const byOtherBranch = await api.get(`${API}/payments?branchId=${otherBranchId}`);
    expect(dataOf<{ payments: PaymentShape[] }>(byOtherBranch).payments).toEqual([]);

    const byStatus = await api.get(`${API}/payments?status=SUCCESSFUL`);
    expect(
      dataOf<{ payments: PaymentShape[] }>(byStatus).payments.every(
        (payment) => payment.paymentStatus === "SUCCESSFUL",
      ),
    ).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const byDate = await api.get(`${API}/payments?fromDate=${today}&toDate=${today}`);
    expect(byDate.status).toBe(200);
    expect(dataOf<{ payments: PaymentShape[] }>(byDate).payments.length).toBeGreaterThan(0);

    const inverted = await api.get(`${API}/payments?fromDate=${today}&toDate=2000-01-01`);
    expect(inverted.status).toBe(422);

    const badMethod = await api.get(`${API}/payments?method=CRYPTO`);
    expect(badMethod.status).toBe(422);

    const badPage = await api.get(`${API}/payments?limit=500`);
    expect(badPage.status).toBe(422);

    // List rows are summaries: no notes, no tenant id, no request hash.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/tenantId|requestHash|request_hash/);
    expect(body.data.payments[0]).not.toHaveProperty("notes");
    expect(body.data.payments[0]).not.toHaveProperty("requestHash");
  });

  it("enforces authentication and payment permissions", async () => {
    const anonymousList = await anonymousApi.get(`${API}/payments`);
    expect(anonymousList.status).toBe(401);

    const anonymousRecord = await anonymousApi.post(`${API}/payments`, {
      body: recordingBody(),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(anonymousRecord.status).toBe(401);

    // An authenticated cookie session without the double-submit CSRF header
    // cannot move money.
    const withoutCsrf = await api.post(`${API}/payments`, {
      body: recordingBody({
        amount: "1.00",
        allocations: [{ invoiceId, amount: "1.00" }],
      }),
      headers: { "idempotency-key": randomUUID() },
      csrf: false,
    });
    expect(withoutCsrf.status).toBe(403);
    expect(errorOf(withoutCsrf).code).toBe("FORBIDDEN");
    expect(errorOf(withoutCsrf).message).toMatch(/csrf/i);

    // A doctor has no payment:read/payment:create.
    const doctorList = await doctorApi.get(`${API}/payments`);
    expect(doctorList.status).toBe(403);
    expect(errorOf(doctorList).code).toBe("FORBIDDEN");

    const doctorRecord = await record(doctorApi, recordingBody());
    expect(doctorRecord.status).toBe(403);

    // A member with no role holds no payment keys either.
    const unprivilegedList = await unprivilegedApi.get(`${API}/payments`);
    expect(unprivilegedList.status).toBe(403);
    const unprivilegedRecord = await record(unprivilegedApi, recordingBody());
    expect(unprivilegedRecord.status).toBe(403);

    // The front desk may both read and collect.
    const receptionistList = await receptionistApi.get(`${API}/payments`);
    expect(receptionistList.status).toBe(200);
    const receptionistRead = await receptionistApi.get(`${API}/payments/${firstPaymentId}`);
    expect(receptionistRead.status).toBe(200);
  });

  it("prevents cross-tenant recording with foreign patients, branches or invoices", async () => {
    const foreignPatient = await record(
      otherApi,
      {
        branchId,
        patientId,
        method: "CASH",
        amount: "5.00",
        allocations: [{ invoiceId, amount: "5.00" }],
      },
      randomUUID(),
    );
    expect(foreignPatient.status).toBe(400);
    expect(errorOf(foreignPatient).message).toMatch(/patient/i);

    const foreignInvoice = await record(
      otherApi,
      {
        branchId: otherTenantBranchId,
        patientId: otherTenantPatientId,
        method: "CASH",
        amount: "5.00",
        allocations: [{ invoiceId, amount: "5.00" }],
      },
      randomUUID(),
    );
    expect(foreignInvoice.status).toBe(400);

    // Sanity check that the isolation assertions below use a real tenant.
    expect(otherTenantId).not.toBe(tenantId);

    // Nothing was written for the other hospital.
    const leaked = await otherApi.get(`${API}/payments`);
    expect(dataOf<{ payments: PaymentShape[] }>(leaked).payments).toEqual([]);

    // A receipt recorded legally in the other hospital is invisible here.
    otherTenantPaymentReference = `FOREIGN-${randomUUID().slice(0, 8)}`;
    const own = await record(
      otherApi,
      {
        branchId: otherTenantBranchId,
        patientId: otherTenantPatientId,
        method: "CARD",
        amount: "25.00",
        reference: otherTenantPaymentReference,
        allocations: [{ invoiceId: otherTenantInvoiceId, amount: "25.00" }],
      },
      randomUUID(),
    );
    expect(own.status).toBe(201);
    otherTenantPaymentId = paymentOf(own).id;

    const foreignRead = await api.get(`${API}/payments/${otherTenantPaymentId}`);
    expect(foreignRead.status).toBe(404);
  });
});

describe("payment API hardening", () => {
  it("gives a read-only role payment:read without allowing collection", async () => {
    const list = await branchAdminApi.get(`${API}/payments`);
    expect(list.status).toBe(200);

    const detail = await branchAdminApi.get(`${API}/payments/${firstPaymentId}`);
    expect(detail.status).toBe(200);
    expect(paymentOf(detail).id).toBe(firstPaymentId);

    const before = await paymentCount();
    const attempt = await record(
      branchAdminApi,
      recordingBody({ amount: "1.00", allocations: [{ invoiceId, amount: "1.00" }] }),
    );
    expect(attempt.status).toBe(403);
    expect(errorOf(attempt).code).toBe("FORBIDDEN");
    expect(await paymentCount()).toBe(before);
  });

  it("does not leak another tenant's payments through query parameters", async () => {
    expect(otherTenantPaymentId).not.toBeNull();

    const total = await paymentCount(tenantId);
    const foreignQueries = [
      `patientId=${otherTenantPatientId}`,
      `branchId=${otherTenantBranchId}`,
      `reference=${encodeURIComponent(otherTenantPaymentReference)}`,
      `page=1&limit=100&patientId=${otherTenantPatientId}`,
    ];

    for (const query of foreignQueries) {
      const response = await api.get(`${API}/payments?${query}`);
      expect(response.status, query).toBe(200);
      expect(dataOf<{ payments: PaymentShape[] }>(response).payments, query).toEqual([]);
    }

    // Filtering never widens the tenant scope, even when the tenant has rows.
    expect(total).toBeGreaterThan(0);
    const filtered = await api.get(`${API}/payments?page=1&limit=100`);
    expect(filtered.status).toBe(200);
    const filteredBody = filtered.body as Envelope<{ payments: PaymentShape[] }>;
    expect(filteredBody.meta?.pagination?.total).toBe(total);
    expect(
      filteredBody.data.payments.every((payment) => payment.patientId !== otherTenantPatientId),
    ).toBe(true);
  });

  it("creates no financial records when a recording request is rejected", async () => {
    const beforeCount = await paymentCount();
    const beforeHeader = await invoiceHeader(invoiceId);
    const beforeLedger = await getTestAdminPool().query(
      `select
         (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
         (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
      [tenantId],
    );

    const rejected: Array<{ response: TestResponse; status: number }> = [];

    // Unauthorized: no permission, no CSRF, no session.
    rejected.push({
      response: await record(doctorApi, recordingBody()),
      status: 403,
    });
    rejected.push({
      response: await api.post(`${API}/payments`, {
        body: recordingBody(),
        headers: { "idempotency-key": randomUUID() },
        csrf: false,
      }),
      status: 403,
    });
    rejected.push({
      response: await anonymousApi.post(`${API}/payments`, {
        body: recordingBody(),
        headers: { "idempotency-key": randomUUID() },
      }),
      status: 401,
    });

    // Invalid shape and service-level rejections.
    rejected.push({
      response: await api.post(`${API}/payments`, { body: recordingBody() }),
      status: 422,
    });
    rejected.push({
      response: await record(
        api,
        recordingBody({ amount: "500.00", allocations: [{ invoiceId, amount: "500.00" }] }),
      ),
      status: 422,
    });
    rejected.push({
      response: await record(
        api,
        recordingBody({ amount: "5.00", allocations: [{ invoiceId: otherBranchInvoiceId, amount: "5.00" }] }),
      ),
      status: 400,
    });
    rejected.push({
      response: await record(
        api,
        recordingBody({ reference: firstPaymentReference, amount: "1.00", allocations: [{ invoiceId, amount: "1.00" }] }),
      ),
      status: 409,
    });

    for (const { response } of rejected) {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    expect(await paymentCount()).toBe(beforeCount);
    expect(await invoiceHeader(invoiceId)).toEqual(beforeHeader);
    expect(
      (await getTestAdminPool().query(
        `select
           (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
           (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
        [tenantId],
      )).rows[0],
    ).toEqual(beforeLedger.rows[0]);
  });

  it("rolls back an HTTP recording when one of its allocations fails", async () => {
    const invoiceA = await createIssuedInvoice(tenantId, adminUserId, patientId, branchId);
    const invoiceB = await createIssuedInvoice(tenantId, adminUserId, patientId, branchId);
    const reference = `ROLLBACK-${randomUUID().slice(0, 8)}`;

    const beforeLedger = await getTestAdminPool().query(
      `select
         (select count(*)::int from payments where tenant_id = $1) as payments,
         (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
         (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
      [tenantId],
    );

    const failed = await record(
      api,
      {
        branchId,
        patientId,
        method: "CASH",
        amount: "300.00",
        reference,
        allocations: [
          { invoiceId: invoiceA, amount: "100.00" },
          { invoiceId: invoiceB, amount: "200.00" },
        ],
      },
      randomUUID(),
    );

    expect(failed.status).toBe(422);
    expect(errorOf(failed).code).toBe("VALIDATION_ERROR");

    // Neither the receipt nor any of its ledger rows survived.
    expect(await paymentCount()).toBe((beforeLedger.rows[0] as { payments: number }).payments);
    expect(
      (await getTestAdminPool().query(
        `select
           (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
           (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
        [tenantId],
      )).rows[0],
    ).toEqual({
      allocations: (beforeLedger.rows[0] as { allocations: number }).allocations,
      settlements: (beforeLedger.rows[0] as { settlements: number }).settlements,
    });

    for (const invoice of [invoiceA, invoiceB]) {
      expect(await invoiceHeader(invoice)).toEqual({
        invoice_status: "ISSUED",
        amount_paid: "0.00",
        balance_due: "100.00",
      });
    }

    // A rejected reference is not consumed: the corrected request succeeds.
    const retried = await record(
      api,
      {
        branchId,
        patientId,
        method: "CASH",
        amount: "100.00",
        reference,
        allocations: [{ invoiceId: invoiceA, amount: "100.00" }],
      },
      randomUUID(),
    );
    expect(retried.status).toBe(201);
    expect(await invoiceHeader(invoiceA)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });

  it("refuses payments against draft and cancelled invoices", async () => {
    const draft = await createInvoice(tenantId, {
      branchId,
      patientId,
      createdBy: adminUserId,
      items: [
        { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice: "50.00" },
      ],
    });
    const cancellable = await createIssuedInvoice(tenantId, adminUserId, patientId, branchId);
    await cancelInvoice(tenantId, cancellable, {}, { userId: adminUserId });

    const beforeCount = await paymentCount();

    for (const [invoice, message] of [
      [draft.id, /draft/i],
      [cancellable, /cancelled/i],
    ] as const) {
      const response = await record(
        api,
        {
          branchId,
          patientId,
          method: "CASH",
          amount: "10.00",
          allocations: [{ invoiceId: invoice, amount: "10.00" }],
        },
        randomUUID(),
      );
      expect(response.status).toBe(409);
      expect(errorOf(response).code).toBe("CONFLICT");
      expect(errorOf(response).message).toMatch(message);
    }

    expect(await paymentCount()).toBe(beforeCount);
    expect(await invoiceHeader(draft.id)).toEqual({
      invoice_status: "DRAFT",
      amount_paid: "0.00",
      balance_due: "50.00",
    });
    expect((await invoiceHeader(cancellable)).invoice_status).toBe("CANCELLED");
  });
});
