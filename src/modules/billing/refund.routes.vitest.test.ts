import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { issueInvoice, recalculateInvoiceBalance } from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";

/**
 * HTTP-level tests for the Phase 19.7.2 refund API.
 *
 * `refund.service.vitest.test.ts` already proves the financial and gateway
 * rules (cumulative limits, provider rejection, timeout, retry). These tests
 * prove the HTTP layer and its security boundary: routing, strict Zod
 * validation, session-derived tenant and actor, RBAC, CSRF, tenant isolation,
 * approval permissions, idempotent retries, repeated processing, invoice
 * consistency and RLS under the restricted `hospitalos_app` role the API uses.
 *
 * Invoices still have no API, so fixtures are created through the invoice
 * services (the same functions the app calls); everything a client can do goes
 * through HTTP. A verified gateway capture is seeded with the admin pool, and
 * the configured `mock` adapter acknowledges the refund.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface RefundShape {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  invoicePaymentId: string | null;
  receiptId: string | null;
  branchId: string;
  patientId: string;
  amount: string;
  currency: string;
  refundStatus: string;
  channel: string;
  reference: string | null;
  provider: string | null;
  providerRefundId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  processedAt: string | null;
  refundedAt: string | null;
  reason?: string | null;
  decisionReason?: string | null;
  failureReason?: string | null;
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
    details?: unknown;
  };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

function refundOf(response: TestResponse): RefundShape {
  return dataOf<{ refund: RefundShape }>(response).refund;
}

interface Capture {
  invoiceId: string;
  invoicePaymentId: string;
  receiptId: string;
  amount: string;
}

let api: TestApi;
let accountantApi: TestApi;
let receptionistApi: TestApi;
let doctorApi: TestApi;
let branchAdminApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let adminUserId: string;
let accountantUserId: string;
let tenantId: string;
let branchId: string;
let otherBranchId: string;
let patientId: string;
let otherTenantId: string;
let otherTenantBranchId: string;
let otherTenantPatientId: string;

let fullCapture: Capture;
let partialCapture: Capture;
let rejectCapture: Capture;
let pendingCapture: Capture;
let gatewayCapture: Capture;
let otherTenantCapture: Capture;

let fullRefundId: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@refunds-api.test`;
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

/** Records a real offline capture through the payment HTTP API. */
async function recordOfflineCapture(
  client: TestApi,
  tenant: string,
  branch: string,
  patient: string,
  amount: string,
): Promise<Capture> {
  const invoiceId = await createIssuedInvoice(
    tenant,
    adminUserId,
    patient,
    branch,
    amount,
  );

  const response = await client.post(`${API}/payments`, {
    body: {
      branchId: branch,
      patientId: patient,
      method: "CASH",
      amount,
      reference: `RCPT-${randomUUID().slice(0, 8)}`,
      allocations: [{ invoiceId, amount }],
    },
    headers: { "idempotency-key": randomUUID() },
  });
  expect(response.status).toBe(201);

  const receiptId = dataOf<{ payment: { id: string } }>(response).payment.id;
  const capture = await getTestAdminPool().query(
    "select id from invoice_payments where tenant_id = $1 and payment_id = $2",
    [tenant, receiptId],
  );

  return {
    invoiceId,
    invoicePaymentId: (capture.rows[0] as { id: string }).id,
    receiptId,
    amount,
  };
}

/** Seeds a verified online capture: successful receipt, settlement and order. */
async function seedGatewayCapture(
  tenant: string,
  branch: string,
  patient: string,
  amount = "100.00",
): Promise<Capture> {
  const pool = getTestAdminPool();
  const invoiceId = await createIssuedInvoice(tenant, adminUserId, patient, branch, amount);
  const receiptId = randomUUID();
  const invoicePaymentId = randomUUID();

  await pool.query(
    `insert into payments
       (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
        payment_status, reference, received_by, received_at)
     values ($1, $2, $3, $4, 'CARD', $5, 'USD', 'SUCCESSFUL', $6, $7, now())`,
    [receiptId, tenant, branch, patient, amount, `GW-${randomUUID().slice(0, 8)}`, adminUserId],
  );
  await pool.query(
    `insert into invoice_payments
       (id, tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at, created_by)
     values ($1, $2, $3, $4, $5, 'USD', 'SUCCESSFUL', now(), $6)`,
    [invoicePaymentId, tenant, invoiceId, receiptId, amount, adminUserId],
  );
  await pool.query(
    `insert into payment_gateway_orders
       (tenant_id, payment_id, invoice_id, provider, provider_order_id,
        provider_transaction_reference, amount, currency, status, metadata)
     values ($1, $2, $3, 'mock', $4, $5, $6, 'USD', 'SUCCEEDED', '{}'::jsonb)`,
    [
      tenant,
      receiptId,
      invoiceId,
      `mock_order_${randomUUID().replaceAll("-", "")}`,
      `mock_txn_${randomUUID().replaceAll("-", "")}`,
      amount,
    ],
  );

  await recalculateInvoiceBalance(tenant, invoiceId, { userId: adminUserId });

  return { invoiceId, invoicePaymentId, receiptId, amount };
}

function refundBody(
  capture: Capture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    invoicePaymentId: capture.invoicePaymentId,
    amount: capture.amount,
    reason: "Patient request",
    ...overrides,
  };
}

function createRefund(
  client: TestApi,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> {
  return client.post(`${API}/refunds`, {
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

async function approveAs(client: TestApi, refundId: string): Promise<TestResponse> {
  return client.post(`${API}/refunds/${refundId}/approve`, { body: {} });
}

async function processAs(client: TestApi, refundId: string): Promise<TestResponse> {
  return client.post(`${API}/refunds/${refundId}/process`, { body: {} });
}

async function invoiceHeader(invoiceId: string): Promise<{
  invoice_status: string;
  amount_paid: string;
  balance_due: string;
}> {
  const result = await getTestAdminPool().query(
    "select invoice_status, amount_paid, balance_due from invoices where id = $1",
    [invoiceId],
  );

  return result.rows[0] as {
    invoice_status: string;
    amount_paid: string;
    balance_due: string;
  };
}

/** Refunded total is derived from the refund ledger, not an invoice column. */
async function successfulRefundTotal(invoiceId: string): Promise<string> {
  const result = await getTestAdminPool().query(
    `select coalesce(sum(amount), 0)::numeric(12, 2)::text as total
       from invoice_refunds
      where invoice_id = $1 and refund_status = 'SUCCESSFUL'`,
    [invoiceId],
  );

  return (result.rows[0] as { total: string }).total;
}

async function refundRowCount(tenant: string): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from invoice_refunds where tenant_id = $1",
    [tenant],
  );

  return (result.rows[0] as { count: number }).count;
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  accountantApi = await createTestApi(createApp());
  receptionistApi = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  branchAdminApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);
  const adminEmail = `admin-${suffix}@refunds-api.test`;

  const registered = await api.post(`${API}/auth/register`, {
    body: { fullName: "Refund Admin", email: adminEmail, password: PASSWORD },
  });
  expect(registered.status).toBe(201);
  adminUserId = dataOf<{ user: { id: string } }>(registered).user.id;
  createdUserIds.push(adminUserId);

  await loginAs(api, adminEmail);
  const tenant = await registerTenant(api, `Refunds API ${suffix}`);
  tenantId = tenant.id;
  await selectTenant(api, tenant.slug);

  branchId = await createBranch(tenantId, "MAIN");
  otherBranchId = await createBranch(tenantId, "EAST");
  patientId = await createPatient(api, "Ada Refund");

  // Accountant: payment:read/create/refund. Requests refunds.
  const accountant = await createAccount(`accountant-${suffix}`);
  accountantUserId = accountant.id;
  await addMembership(tenantId, accountant.id, "accountant");
  await loginAs(accountantApi, accountant.email);
  await selectTenant(accountantApi, tenant.slug);

  // Front desk: payment:read/create but no payment:refund.
  const receptionist = await createAccount(`receptionist-${suffix}`);
  await addMembership(tenantId, receptionist.id, "receptionist");
  await loginAs(receptionistApi, receptionist.email);
  await selectTenant(receptionistApi, tenant.slug);

  // Doctor and branch admin: no payment:refund.
  const doctor = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctor.id, "doctor");
  await loginAs(doctorApi, doctor.email);
  await selectTenant(doctorApi, tenant.slug);

  const branchAdmin = await createAccount(`branch-admin-${suffix}`);
  await addMembership(tenantId, branchAdmin.id, "branch_admin");
  await loginAs(branchAdminApi, branchAdmin.email);
  await selectTenant(branchAdminApi, tenant.slug);

  // A second hospital with its own capture.
  const otherAdminEmail = `other-admin-${suffix}@refunds-api.test`;
  const otherRegistered = await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Refund Admin", email: otherAdminEmail, password: PASSWORD },
  });
  expect(otherRegistered.status).toBe(201);
  const otherAdminId = dataOf<{ user: { id: string } }>(otherRegistered).user.id;
  createdUserIds.push(otherAdminId);

  await loginAs(otherApi, otherAdminEmail);
  const otherTenant = await registerTenant(otherApi, `Other Refunds API ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherTenantBranchId = await createBranch(otherTenant.id, "MAIN");
  otherTenantPatientId = await createPatient(otherApi, "Foreign Refund Patient");

  fullCapture = await recordOfflineCapture(
    api,
    tenantId,
    branchId,
    patientId,
    "100.00",
  );
  partialCapture = await recordOfflineCapture(
    api,
    tenantId,
    branchId,
    patientId,
    "40.00",
  );
  rejectCapture = await recordOfflineCapture(
    api,
    tenantId,
    branchId,
    patientId,
    "50.00",
  );
  pendingCapture = await recordOfflineCapture(
    api,
    tenantId,
    branchId,
    patientId,
    "30.00",
  );
  gatewayCapture = await seedGatewayCapture(tenantId, otherBranchId, patientId, "100.00");
  otherTenantCapture = await recordOfflineCapture(
    otherApi,
    otherTenant.id,
    otherTenantBranchId,
    otherTenantPatientId,
    "60.00",
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
  await accountantApi.close();
  await receptionistApi.close();
  await doctorApi.close();
  await branchAdminApi.close();
  await otherApi.close();
  await anonymousApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("refund request API", () => {
  it("creates a refund request and retrieves it", async () => {
    const reference = `VOUCHER-${randomUUID().slice(0, 8)}`;
    const response = await createRefund(
      accountantApi,
      refundBody(fullCapture, { reason: "Treatment cancelled", reference }),
      "refund-api-full",
    );

    expect(response.status).toBe(201);
    expect(dataOf<{ replayed: boolean }>(response).replayed).toBe(false);

    const refund = refundOf(response);
    expect(refund).toMatchObject({
      invoiceId: fullCapture.invoiceId,
      invoicePaymentId: fullCapture.invoicePaymentId,
      receiptId: fullCapture.receiptId,
      branchId,
      patientId,
      amount: "100.00",
      currency: "USD",
      refundStatus: "PENDING",
      channel: "OFFLINE",
      reason: "Treatment cancelled",
      reference,
      requestedBy: accountantUserId,
      approvedBy: null,
    });
    expect(refund.invoiceNumber).toMatch(/^INV-/);

    fullRefundId = refund.id;

    const detail = await api.get(`${API}/refunds/${fullRefundId}`);
    expect(detail.status).toBe(200);
    expect(refundOf(detail)).toMatchObject({
      id: fullRefundId,
      refundStatus: "PENDING",
      reason: "Treatment cancelled",
    });

    // The invoice is untouched by a request: no money has moved yet.
    expect(await invoiceHeader(fullCapture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });
    expect(await successfulRefundTotal(fullCapture.invoiceId)).toBe("0.00");
  });

  it("replays a duplicate request and rejects a key reused for a different request", async () => {
    const body = refundBody(pendingCapture);
    const key = "refund-api-replay";

    const created = await createRefund(accountantApi, body, key);
    expect(created.status).toBe(201);
    expect(refundOf(created).refundStatus).toBe("PENDING");

    const replay = await createRefund(accountantApi, body, key);
    expect(replay.status).toBe(200);
    expect(dataOf<{ replayed: boolean }>(replay).replayed).toBe(true);
    expect(refundOf(replay).id).toBe(refundOf(created).id);

    const count = await getTestAdminPool().query(
      "select count(*)::int as count from invoice_refunds where tenant_id = $1 and idempotency_key = $2",
      [tenantId, key],
    );
    expect((count.rows[0] as { count: number }).count).toBe(1);

    const reused = await createRefund(
      accountantApi,
      refundBody(pendingCapture, { amount: "1.00" }),
      key,
    );
    expect(reused.status).toBe(409);
    expect(errorOf(reused).code).toBe("CONFLICT");
  });

  it("requires an idempotency key and rejects a header/body mismatch", async () => {
    const missing = await accountantApi.post(`${API}/refunds`, {
      body: refundBody(pendingCapture),
    });
    expect(missing.status).toBe(422);
    expect(errorOf(missing).code).toBe("VALIDATION_ERROR");

    const mismatch = await accountantApi.post(`${API}/refunds`, {
      body: refundBody(pendingCapture, { idempotencyKey: "body-key" }),
      headers: { "idempotency-key": "header-key" },
    });
    expect(mismatch.status).toBe(422);
    expect(errorOf(mismatch).code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed amounts, reasons, references and server-owned fields", async () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { invoicePaymentId: fullCapture.invoicePaymentId },
      refundBody(fullCapture, { invoicePaymentId: "not-a-uuid" }),
      refundBody(fullCapture, { amount: "0.00" }),
      refundBody(fullCapture, { amount: "-5.00" }),
      refundBody(fullCapture, { amount: "10.001" }),
      refundBody(fullCapture, { amount: "abc" }),
      refundBody(fullCapture, { reason: "x".repeat(2_001) }),
      refundBody(fullCapture, { reference: "x".repeat(121) }),
      // Server-owned fields must never be accepted from the client.
      refundBody(fullCapture, { tenantId: randomUUID() }),
      refundBody(fullCapture, { branchId: randomUUID() }),
      refundBody(fullCapture, { patientId: randomUUID() }),
      refundBody(fullCapture, { currency: "EUR" }),
      refundBody(fullCapture, { refundStatus: "SUCCESSFUL" }),
      refundBody(fullCapture, { provider: "mock" }),
      refundBody(fullCapture, { providerRefundId: "forged-refund-id" }),
      refundBody(fullCapture, { approvedBy: randomUUID() }),
      refundBody(fullCapture, { refundedAt: new Date().toISOString() }),
    ];

    for (const body of cases) {
      const response = await createRefund(accountantApi, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects refunds that exceed the captured amount or the refundable remainder", async () => {
    const excessive = await createRefund(
      accountantApi,
      refundBody(partialCapture, { amount: "45.00" }),
    );
    expect(excessive.status).toBe(422);
    expect(errorOf(excessive).message).toMatch(/captured/i);

    // A second, open request cannot promise money already reserved.
    const open = await createRefund(
      accountantApi,
      refundBody(partialCapture, { amount: "20.00" }),
    );
    expect(open.status).toBe(201);

    const overlapping = await createRefund(
      accountantApi,
      refundBody(partialCapture, { amount: "21.00" }),
    );
    expect(overlapping.status).toBe(422);
  });

  it("hides another tenant's capture and refund", async () => {
    const foreignCapture = await createRefund(
      otherApi,
      refundBody(fullCapture),
    );
    expect(foreignCapture.status).toBe(404);

    const foreignRefund = await otherApi.get(`${API}/refunds/${fullRefundId}`);
    expect(foreignRefund.status).toBe(404);

    const foreignDecision = await approveAs(otherApi, fullRefundId);
    expect(foreignDecision.status).toBe(404);

    const foreignOwn = await createRefund(otherApi, refundBody(otherTenantCapture));
    expect(foreignOwn.status).toBe(201);

    const ours = await api.get(`${API}/refunds`);
    expect(
      dataOf<{ refunds: RefundShape[] }>(ours).refunds.every(
        (refund) => refund.branchId !== otherTenantBranchId,
      ),
    ).toBe(true);
  });
});

describe("refund approval and processing", () => {
  it("denies approval to the requester and to roles without payment:refund", async () => {
    const requesterApproval = await approveAs(accountantApi, fullRefundId);
    expect(requesterApproval.status).toBe(409);
    expect(errorOf(requesterApproval).message).toMatch(/requester/i);

    const receptionistApproval = await approveAs(receptionistApi, fullRefundId);
    expect(receptionistApproval.status).toBe(403);
    expect(errorOf(receptionistApproval).code).toBe("FORBIDDEN");

    const doctorApproval = await approveAs(doctorApi, fullRefundId);
    expect(doctorApproval.status).toBe(403);

    const branchAdminApproval = await approveAs(branchAdminApi, fullRefundId);
    expect(branchAdminApproval.status).toBe(403);

    // Failed approvals changed nothing.
    expect(refundOf(await api.get(`${API}/refunds/${fullRefundId}`))).toMatchObject({
      refundStatus: "PENDING",
      approvedBy: null,
    });
  });

  it("approves and fully processes an offline refund, updating the invoice once", async () => {
    const approval = await approveAs(api, fullRefundId);
    expect(approval.status).toBe(200);
    expect(refundOf(approval)).toMatchObject({
      refundStatus: "APPROVED",
      approvedBy: adminUserId,
    });
    expect(refundOf(approval).approvedAt).not.toBeNull();

    // No money moves until processing.
    expect((await invoiceHeader(fullCapture.invoiceId)).amount_paid).toBe("100.00");

    const receptionistProcess = await processAs(receptionistApi, fullRefundId);
    expect(receptionistProcess.status).toBe(403);

    const processed = await processAs(accountantApi, fullRefundId);
    expect(processed.status).toBe(200);
    expect(refundOf(processed)).toMatchObject({
      refundStatus: "SUCCESSFUL",
      amount: "100.00",
      providerRefundId: null,
    });
    expect(refundOf(processed).refundedAt).not.toBeNull();

    expect(await invoiceHeader(fullCapture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });
    expect(await successfulRefundTotal(fullCapture.invoiceId)).toBe("100.00");

    const refundsBeforeRetry = await refundRowCount(tenantId);

    // A repeated process call returns the stored success and cannot refund twice.
    const repeated = await processAs(api, fullRefundId);
    expect(repeated.status).toBe(200);
    expect(refundOf(repeated).id).toBe(fullRefundId);
    expect(refundOf(repeated).refundStatus).toBe("SUCCESSFUL");

    expect(await invoiceHeader(fullCapture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });
    expect(await successfulRefundTotal(fullCapture.invoiceId)).toBe("100.00");
    expect(await refundRowCount(tenantId)).toBe(refundsBeforeRetry);
  });

  it("refuses to process a request that is still pending", async () => {
    const pending = await createRefund(
      accountantApi,
      refundBody(rejectCapture, { amount: "10.00" }),
    );
    expect(pending.status).toBe(201);

    const processed = await processAs(api, refundOf(pending).id);
    expect(processed.status).toBe(409);
    expect(errorOf(processed).code).toBe("CONFLICT");

    expect((await invoiceHeader(rejectCapture.invoiceId)).amount_paid).toBe("50.00");
  });

  it("rejects a request without moving money, and the rejection is terminal", async () => {
    const created = await createRefund(
      accountantApi,
      refundBody(rejectCapture, { amount: "10.00" }),
    );
    expect(created.status).toBe(201);

    const rejected = await api.post(`${API}/refunds/${refundOf(created).id}/reject`, {
      body: { reason: "Duplicate request" },
    });
    expect(rejected.status).toBe(200);
    expect(refundOf(rejected)).toMatchObject({
      refundStatus: "REJECTED",
      decisionReason: "Duplicate request",
    });

    const processRejected = await processAs(api, refundOf(created).id);
    expect(processRejected.status).toBe(409);

    expect(await invoiceHeader(rejectCapture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "50.00",
      balance_due: "0.00",
    });
    expect(await successfulRefundTotal(rejectCapture.invoiceId)).toBe("0.00");
  });

  it("processes a partial refund and keeps the remaining balance consistent", async () => {
    const created = await createRefund(
      accountantApi,
      refundBody(partialCapture, { amount: "15.00", reason: "Partial reversal" }),
    );
    expect(created.status).toBe(201);

    expect((await approveAs(api, refundOf(created).id)).status).toBe(200);

    const processed = await processAs(accountantApi, refundOf(created).id);
    expect(processed.status).toBe(200);
    expect(refundOf(processed)).toMatchObject({
      refundStatus: "SUCCESSFUL",
      amount: "15.00",
    });

    // Collected 40.00, refunded 15.00: net held 25.00 against the 40.00 invoice.
    expect(await invoiceHeader(partialCapture.invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "25.00",
      balance_due: "15.00",
    });
    expect(await successfulRefundTotal(partialCapture.invoiceId)).toBe("15.00");
  });
});

describe("gateway refund verification", () => {
  it("marks a gateway refund successful only from the adapter response", async () => {
    const created = await createRefund(
      accountantApi,
      refundBody(gatewayCapture, { reference: "desk-voucher-1" }),
    );
    expect(created.status).toBe(201);
    expect(refundOf(created).channel).toBe("GATEWAY");
    expect(refundOf(created).providerRefundId).toBeNull();

    expect((await approveAs(api, refundOf(created).id)).status).toBe(200);

    const processed = await processAs(api, refundOf(created).id);
    expect(processed.status).toBe(200);

    const refund = refundOf(processed);
    expect(refund.refundStatus).toBe("SUCCESSFUL");
    expect(refund.provider).toBe("mock");
    // The provider id came from the adapter, never from the client.
    expect(refund.providerRefundId).toMatch(/^mock_refund_/);

    expect(await invoiceHeader(gatewayCapture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });
    expect(await successfulRefundTotal(gatewayCapture.invoiceId)).toBe("100.00");

    // A repeated gateway call returns the same verified result.
    const repeated = await processAs(api, refundOf(created).id);
    expect(repeated.status).toBe(200);
    expect(refundOf(repeated).providerRefundId).toBe(refund.providerRefundId);
    expect(await successfulRefundTotal(gatewayCapture.invoiceId)).toBe("100.00");
  });
});

describe("refund history and access control", () => {
  it("lists refunds with pagination and filters without leaking evidence", async () => {
    const all = await accountantApi.get(`${API}/refunds?page=1&limit=2`);
    expect(all.status).toBe(200);

    const body = all.body as Envelope<{ refunds: RefundShape[] }>;
    expect(body.data.refunds).toHaveLength(2);
    expect(body.meta?.pagination).toMatchObject({ page: 1, pageSize: 2 });
    expect(body.meta?.pagination?.total).toBeGreaterThanOrEqual(5);

    const second = await accountantApi.get(`${API}/refunds?page=2&limit=2`);
    expect(second.status).toBe(200);
    expect(dataOf<{ refunds: RefundShape[] }>(second).refunds[0]?.id).not.toBe(
      body.data.refunds[0]?.id,
    );

    const byInvoice = await accountantApi.get(
      `${API}/refunds?invoiceId=${fullCapture.invoiceId}`,
    );
    expect(dataOf<{ refunds: RefundShape[] }>(byInvoice).refunds).toHaveLength(1);

    const byCapture = await accountantApi.get(
      `${API}/refunds?paymentId=${partialCapture.invoicePaymentId}`,
    );
    expect(
      dataOf<{ refunds: RefundShape[] }>(byCapture).refunds.length,
    ).toBeGreaterThanOrEqual(1);

    const byBranch = await accountantApi.get(`${API}/refunds?branchId=${otherBranchId}`);
    expect(
      dataOf<{ refunds: RefundShape[] }>(byBranch).refunds.every(
        (refund) => refund.branchId === otherBranchId,
      ),
    ).toBe(true);

    const byPatient = await accountantApi.get(`${API}/refunds?patientId=${patientId}`);
    expect(
      dataOf<{ refunds: RefundShape[] }>(byPatient).refunds.every(
        (refund) => refund.patientId === patientId,
      ),
    ).toBe(true);

    const byStatus = await accountantApi.get(`${API}/refunds?status=SUCCESSFUL`);
    expect(
      dataOf<{ refunds: RefundShape[] }>(byStatus).refunds.every(
        (refund) => refund.refundStatus === "SUCCESSFUL",
      ),
    ).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const byDate = await accountantApi.get(
      `${API}/refunds?fromDate=${today}&toDate=${today}`,
    );
    expect(
      dataOf<{ refunds: RefundShape[] }>(byDate).refunds.length,
    ).toBeGreaterThan(0);

    expect(
      (await accountantApi.get(`${API}/refunds?fromDate=${today}&toDate=2000-01-01`))
        .status,
    ).toBe(422);
    expect((await accountantApi.get(`${API}/refunds?status=UNKNOWN`)).status).toBe(422);
    expect((await accountantApi.get(`${API}/refunds?limit=500`)).status).toBe(422);

    // List rows are summaries: no free-text evidence, tenant id or request hash.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/tenantId|requestHash|request_hash/);
    expect(body.data.refunds[0]).not.toHaveProperty("reason");
    expect(body.data.refunds[0]).not.toHaveProperty("failureReason");
  });

  it("enforces authentication, CSRF and payment permissions", async () => {
    expect((await anonymousApi.get(`${API}/refunds`)).status).toBe(401);
    expect(
      (
        await anonymousApi.post(`${API}/refunds`, {
          body: refundBody(pendingCapture),
          headers: { "idempotency-key": randomUUID() },
        })
      ).status,
    ).toBe(401);

    const withoutCsrf = await accountantApi.post(`${API}/refunds`, {
      body: refundBody(pendingCapture, { amount: "1.00" }),
      headers: { "idempotency-key": randomUUID() },
      csrf: false,
    });
    expect(withoutCsrf.status).toBe(403);
    expect(errorOf(withoutCsrf).message).toMatch(/csrf/i);

    // Read-only roles can audit refunds but cannot request one.
    expect((await branchAdminApi.get(`${API}/refunds`)).status).toBe(200);
    expect((await receptionistApi.get(`${API}/refunds`)).status).toBe(200);
    expect((await receptionistApi.get(`${API}/refunds/${fullRefundId}`)).status).toBe(200);

    const receptionistCreate = await createRefund(
      receptionistApi,
      refundBody(pendingCapture),
    );
    expect(receptionistCreate.status).toBe(403);
    expect(errorOf(receptionistCreate).code).toBe("FORBIDDEN");

    expect((await doctorApi.get(`${API}/refunds`)).status).toBe(403);
    expect((await createRefund(doctorApi, refundBody(pendingCapture))).status).toBe(403);
  });

  it("does not leak another tenant's refunds through query parameters", async () => {
    const foreignQueries = [
      `patientId=${otherTenantPatientId}`,
      `branchId=${otherTenantBranchId}`,
      `invoiceId=${otherTenantCapture.invoiceId}`,
      `paymentId=${otherTenantCapture.invoicePaymentId}`,
    ];

    for (const query of foreignQueries) {
      const response = await api.get(`${API}/refunds?${query}`);
      expect(response.status, query).toBe(200);
      expect(dataOf<{ refunds: RefundShape[] }>(response).refunds, query).toEqual([]);
    }
  });

  it("enforces RLS for the restricted application role", async () => {
    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      const unscoped = await client.query(
        "select count(*)::int as count from invoice_refunds",
      );
      expect(unscoped.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        otherTenantId,
      ]);
      // The other tenant has its own refund, but can never see ours.
      const outsider = await client.query(
        "select count(*)::int as count from invoice_refunds where id = $1",
        [fullRefundId],
      );
      expect(outsider.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        tenantId,
      ]);
      const owner = await client.query(
        "select count(*)::int as count from invoice_refunds where id = $1",
        [fullRefundId],
      );
      expect(owner.rows[0]).toEqual({ count: 1 });

      const rejectedWrite = await client.query(
        `update invoice_refunds set refund_status = 'SUCCESSFUL'
          where tenant_id = $1 and id = $2`,
        [otherTenantId, fullRefundId],
      );
      expect(rejectedWrite.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
