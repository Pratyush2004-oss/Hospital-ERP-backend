import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { withGatewayTimeout } from "./gateway/payment-gateway.registry.js";
import {
  PaymentGatewayTimeoutError,
  type GatewayCheckoutOrder,
  type PaymentGateway,
} from "./gateway/payment-gateway.types.js";
import { cancelInvoice, issueInvoice } from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import { initiatePayment } from "./payment-initiation.service.js";
import type { PaymentInitiationDto } from "./payment-initiation.types.js";

/**
 * HTTP and service integration tests for Phase 19.6.1 online initiation.
 *
 * The HTTP suite proves the public contract: routing, RBAC, CSRF, strict body
 * validation, tenant isolation, idempotent replay and persistence. The service
 * suite injects failing/slow/malformed gateways to prove that provider problems
 * roll back completely and never leak provider artifacts.
 *
 * Fixtures use the admin pool only for tenant/branch setup; invoices are created
 * through the billing services and the API under test runs as the restricted
 * `hospitalos_app` role inside tenant-scoped transactions (RLS included).
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface InitiationShape {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentStatus: string;
  amount: string;
  currency: string;
  provider: string;
  providerOrderId: string;
  checkoutUrl: string;
  expiresAt: string | null;
  createdAt: string;
  replayed: boolean;
}

interface Envelope<T> {
  data: T;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

function initiationOf(response: TestResponse): InitiationShape {
  return dataOf<{ initiation: InitiationShape }>(response).initiation;
}

let api: TestApi;
let doctorApi: TestApi;
let branchAdminApi: TestApi;
let anonymousApi: TestApi;
let otherApi: TestApi;

let tenantId: string;
let branchId: string;
let adminUserId: string;
let patientId: string;

let payableInvoiceId: string;
let replayInvoiceId: string;
let draftInvoiceId: string;
let cancelledInvoiceId: string;
let paidInvoiceId: string;
let otherTenantId: string;
let otherTenantInvoiceId: string;
let otherTenantBranchId: string;
let otherTenantPatientId: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@initiation.test`;
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

function initiateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { invoiceId: payableInvoiceId, method: "CARD", ...overrides };
}

function initiate(
  client: TestApi,
  body: Record<string, unknown>,
  idempotencyKey: string | null = randomUUID(),
): Promise<TestResponse> {
  const headers: Record<string, string> =
    idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey };

  return client.post(`${API}/payments/initiate`, {
    body,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

async function counts(tenant: string): Promise<{
  payments: number;
  allocations: number;
  orders: number;
  settlements: number;
}> {
  const result = await getTestAdminPool().query(
    `select
       (select count(*)::int from payments where tenant_id = $1) as payments,
       (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
       (select count(*)::int from payment_gateway_orders where tenant_id = $1) as orders,
       (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
    [tenant],
  );

  return result.rows[0] as {
    payments: number;
    allocations: number;
    orders: number;
    settlements: number;
  };
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

function fakeGateway(
  createOrder: (request: { amount: string }) => Promise<GatewayCheckoutOrder>,
): PaymentGateway {
  return {
    provider: "mock",
    createOrder,
    async refund() {
      return {
        provider: "mock",
        refundId: `fake_refund_${randomUUID().replaceAll("-", "")}`,
        status: "SUCCESSFUL",
        transactionReference: null,
      };
    },
  };
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  doctorApi = await createTestApi(createApp());
  branchAdminApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);
  const adminEmail = `billing-admin-${suffix}@initiation.test`;
  const registered = await api.post(`${API}/auth/register`, {
    body: { fullName: "Billing Admin", email: adminEmail, password: PASSWORD },
  });
  expect(registered.status).toBe(201);

  adminUserId = dataOf<{ user: { id: string } }>(registered).user.id;
  createdUserIds.push(adminUserId);

  await loginAs(api, adminEmail);
  const tenant = await registerTenant(api, `Initiation ${suffix}`);
  tenantId = tenant.id;
  await selectTenant(api, tenant.slug);

  branchId = await createBranch(tenantId, "MAIN");
  patientId = await createPatient(api, "Ada Initiation");

  payableInvoiceId = await createIssuedInvoice(
    tenantId,
    adminUserId,
    patientId,
    branchId,
    "100.00",
  );
  replayInvoiceId = await createIssuedInvoice(
    tenantId,
    adminUserId,
    patientId,
    branchId,
    "100.00",
  );

  const draft = await createInvoice(tenantId, {
    branchId,
    patientId,
    createdBy: adminUserId,
    items: [
      { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice: "50.00" },
    ],
  });
  draftInvoiceId = draft.id;

  cancelledInvoiceId = await createIssuedInvoice(
    tenantId,
    adminUserId,
    patientId,
    branchId,
    "50.00",
  );
  await cancelInvoice(tenantId, cancelledInvoiceId, {}, { userId: adminUserId });

  // Settle one invoice fully through the manual API so initiation sees PAID.
  paidInvoiceId = await createIssuedInvoice(tenantId, adminUserId, patientId, branchId, "40.00");
  const manual = await api.post(`${API}/payments`, {
    body: {
      branchId,
      patientId,
      method: "CASH",
      amount: "40.00",
      reference: `PAID-${randomUUID().slice(0, 8)}`,
      allocations: [{ invoiceId: paidInvoiceId, amount: "40.00" }],
    },
    headers: { "idempotency-key": randomUUID() },
  });
  expect(manual.status).toBe(201);

  const doctor = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctor.id, "doctor");
  await loginAs(doctorApi, doctor.email);
  await selectTenant(doctorApi, tenant.slug);

  const branchAdmin = await createAccount(`branch-admin-${suffix}`);
  await addMembership(tenantId, branchAdmin.id, "branch_admin");
  await loginAs(branchAdminApi, branchAdmin.email);
  await selectTenant(branchAdminApi, tenant.slug);

  const otherAdminEmail = `other-initiation-${suffix}@initiation.test`;
  const otherRegistered = await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Billing Admin", email: otherAdminEmail, password: PASSWORD },
  });
  expect(otherRegistered.status).toBe(201);

  const otherAdminId = dataOf<{ user: { id: string } }>(otherRegistered).user.id;
  createdUserIds.push(otherAdminId);

  await loginAs(otherApi, otherAdminEmail);
  const otherTenant = await registerTenant(otherApi, `Other Initiation ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherTenantBranchId = await createBranch(otherTenantId, "MAIN");
  otherTenantPatientId = await createPatient(otherApi, "Foreign Initiation Patient");
  otherTenantInvoiceId = await createIssuedInvoice(
    otherTenantId,
    otherAdminId,
    otherTenantPatientId,
    otherTenantBranchId,
    "100.00",
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
  await doctorApi.close();
  await branchAdminApi.close();
  await anonymousApi.close();
  await otherApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("payment initiation API", () => {
  it("creates a pending receipt and checkout without settling the invoice", async () => {
    const beforeHeader = await invoiceHeader(payableInvoiceId);
    const response = await initiate(api, initiateBody());

    expect(response.status).toBe(201);

    const initiation = initiationOf(response);
    expect(initiation).toMatchObject({
      invoiceId: payableInvoiceId,
      invoiceNumber: expect.stringMatching(/^INV-/),
      paymentStatus: "PENDING",
      amount: "100.00",
      currency: "USD",
      provider: "mock",
      replayed: false,
    });
    expect(initiation.paymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initiation.providerOrderId).toMatch(/^mock_order_/);
    expect(initiation.checkoutUrl).toContain(initiation.providerOrderId);
    expect(initiation.expiresAt).not.toBeNull();

    // The receipt exists PENDING, is allocated to the invoice, and has an order.
    const stored = await getTestAdminPool().query(
      `select p.payment_status, p.amount, p.currency, p.branch_id, p.patient_id,
              a.invoice_id, a.amount as allocated,
              o.provider, o.provider_order_id, o.status as order_status
         from payments p
         join payment_allocations a on a.tenant_id = p.tenant_id and a.payment_id = p.id
         join payment_gateway_orders o on o.tenant_id = p.tenant_id and o.payment_id = p.id
        where p.id = $1`,
      [initiation.paymentId],
    );
    expect(stored.rows[0]).toMatchObject({
      payment_status: "PENDING",
      amount: "100.00",
      currency: "USD",
      branch_id: branchId,
      patient_id: patientId,
      invoice_id: payableInvoiceId,
      allocated: "100.00",
      provider: "mock",
      provider_order_id: initiation.providerOrderId,
      order_status: "PENDING",
    });

    // No settlement row was written, so nothing about the balance moved.
    expect(await invoiceHeader(payableInvoiceId)).toEqual(beforeHeader);
    expect((await counts(tenantId)).settlements).toBeGreaterThanOrEqual(1); // the manual fixture above
    const initiations = await getTestAdminPool().query(
      `select count(*)::int as count from invoice_payments where tenant_id = $1 and invoice_id = $2`,
      [tenantId, payableInvoiceId],
    );
    expect((initiations.rows[0] as { count: number }).count).toBe(0);
  });

  it("replays the same open order for an idempotent retry", async () => {
    const key = `init-replay-${randomUUID()}`;
    const body = initiateBody({ invoiceId: replayInvoiceId });
    const before = await counts(tenantId);

    const created = await initiate(api, body, key);
    expect(created.status).toBe(201);

    const replay = await initiate(api, body, key);
    expect(replay.status).toBe(200);

    const original = initiationOf(created);
    const repeated = initiationOf(replay);
    expect(repeated.replayed).toBe(true);
    expect(repeated.paymentId).toBe(original.paymentId);
    expect(repeated.providerOrderId).toBe(original.providerOrderId);
    expect(repeated.checkoutUrl).toBe(original.checkoutUrl);

    const after = await counts(tenantId);
    expect(after.payments).toBe(before.payments + 1);
    expect(after.orders).toBe(before.orders + 1);
    expect(after.allocations).toBe(before.allocations + 1);

    // Reusing the key for a different invoice is a conflict, not a new order.
    const conflict = await initiate(
      api,
      initiateBody({ invoiceId: payableInvoiceId }),
      key,
    );
    expect(conflict.status).toBe(409);
    expect(errorOf(conflict).code).toBe("CONFLICT");
  });

  it("requires an idempotency key and rejects client-owned or unknown fields", async () => {
    const missing = await initiate(api, initiateBody(), null);
    expect(missing.status).toBe(422);
    expect(errorOf(missing).code).toBe("VALIDATION_ERROR");

    const invalidBodies: Record<string, unknown>[] = [
      { ...initiateBody(), invoiceId: "not-a-uuid" },
      { ...initiateBody(), method: "CASH" },
      { ...initiateBody(), amount: "1.00" },
      { ...initiateBody(), currency: "USD" },
      { ...initiateBody(), patientId },
      { ...initiateBody(), branchId },
      { ...initiateBody(), tenantId: randomUUID() },
      { ...initiateBody(), paymentStatus: "SUCCESSFUL" },
      { ...initiateBody(), providerOrderId: "forged-order" },
      { ...initiateBody(), transactionReference: "forged-txn" },
      { ...initiateBody(), provider: "unknown" },
    ];

    const before = await counts(tenantId);

    for (const body of invalidBodies) {
      const response = await initiate(api, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }

    expect(await counts(tenantId)).toEqual(before);
  });

  it("refuses unknown, draft, cancelled and fully paid invoices", async () => {
    const noRows = await counts(tenantId);

    const unknown = await initiate(api, initiateBody({ invoiceId: randomUUID() }));
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("NOT_FOUND");

    for (const [invoiceId, status, message] of [
      [draftInvoiceId, 409, /draft/i],
      [cancelledInvoiceId, 409, /cancel/i],
      [paidInvoiceId, 409, /outstanding balance/i],
    ] as const) {
      const response = await initiate(api, initiateBody({ invoiceId }));
      expect(response.status).toBe(status);
      expect(errorOf(response).code).toBe("CONFLICT");
      expect(errorOf(response).message).toMatch(message);
    }

    expect(await counts(tenantId)).toEqual(noRows);
    expect((await invoiceHeader(draftInvoiceId)).invoice_status).toBe("DRAFT");
    expect((await invoiceHeader(cancelledInvoiceId)).invoice_status).toBe("CANCELLED");
    expect((await invoiceHeader(paidInvoiceId)).invoice_status).toBe("PAID");
  });

  it("enforces authentication, CSRF and payment:create", async () => {
    const before = await counts(tenantId);

    const anonymous = await anonymousApi.post(`${API}/payments/initiate`, {
      body: initiateBody(),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(anonymous.status).toBe(401);

    const noCsrf = await api.post(`${API}/payments/initiate`, {
      body: initiateBody(),
      headers: { "idempotency-key": randomUUID() },
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);

    const doctor = await initiate(doctorApi, initiateBody());
    expect(doctor.status).toBe(403);
    expect(errorOf(doctor).code).toBe("FORBIDDEN");

    // Branch admins may read payments but do not hold payment:create.
    const branchAdmin = await initiate(branchAdminApi, initiateBody());
    expect(branchAdmin.status).toBe(403);

    expect(await counts(tenantId)).toEqual(before);
  });

  it("does not let another hospital initiate against this tenant's invoice", async () => {
    const before = await counts(tenantId);
    const beforeOther = await counts(otherTenantId);

    const foreign = await initiate(otherApi, initiateBody());
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe("NOT_FOUND");

    expect(await counts(tenantId)).toEqual(before);
    expect(await counts(otherTenantId)).toEqual(beforeOther);

    // The other hospital can initiate its own invoice normally.
    const own = await initiate(
      otherApi,
      { invoiceId: otherTenantInvoiceId, method: "UPI" },
    );
    expect(own.status).toBe(201);
    expect(initiationOf(own).invoiceId).toBe(otherTenantInvoiceId);
  });
});

describe("gateway failure handling", () => {
  it("rolls back and returns 502 when the provider rejects initiation", async () => {
    const invoiceId = await createIssuedInvoice(
      tenantId,
      adminUserId,
      patientId,
      branchId,
      "75.00",
    );
    const before = await counts(tenantId);

    await expect(
      initiatePayment(
        tenantId,
        { invoiceId, method: "CARD", idempotencyKey: randomUUID() },
        { userId: adminUserId },
        {
          gateway: fakeGateway(async () => {
            throw new Error("provider down");
          }),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: "PAYMENT_GATEWAY_ERROR" });

    expect(await counts(tenantId)).toEqual(before);
    expect(await invoiceHeader(invoiceId)).toEqual({
      invoice_status: "ISSUED",
      amount_paid: "0.00",
      balance_due: "75.00",
    });
  });

  it("returns 504 for a provider timeout and leaves no pending rows", async () => {
    const invoiceId = await createIssuedInvoice(
      tenantId,
      adminUserId,
      patientId,
      branchId,
      "65.00",
    );
    const before = await counts(tenantId);

    await expect(
      initiatePayment(
        tenantId,
        { invoiceId, method: "UPI", idempotencyKey: randomUUID() },
        { userId: adminUserId },
        {
          gateway: fakeGateway(async () => {
            throw new PaymentGatewayTimeoutError("mock", 10);
          }),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 504, code: "PAYMENT_GATEWAY_TIMEOUT" });

    expect(await counts(tenantId)).toEqual(before);
  });

  it("enforces the configured deadline on a hanging provider call", async () => {
    await expect(
      withGatewayTimeout(new Promise<GatewayCheckoutOrder>(() => {}), "mock", 20),
    ).rejects.toBeInstanceOf(PaymentGatewayTimeoutError);
  });

  it("rejects a malformed provider order without persisting anything", async () => {
    const invoiceId = await createIssuedInvoice(
      tenantId,
      adminUserId,
      patientId,
      branchId,
      "55.00",
    );
    const before = await counts(tenantId);

    await expect(
      initiatePayment(
        tenantId,
        { invoiceId, method: "BANK_TRANSFER", idempotencyKey: randomUUID() },
        { userId: adminUserId },
        {
          gateway: fakeGateway(async () => ({
            provider: "mock",
            orderId: "",
            transactionReference: null,
            checkoutUrl: "not-a-url",
            expiresAt: null,
            metadata: {},
          })),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: "PAYMENT_GATEWAY_ERROR" });

    expect(await counts(tenantId)).toEqual(before);
  });

  it("stores only non-secret provider metadata and replays one order", async () => {
    const invoiceId = await createIssuedInvoice(
      tenantId,
      adminUserId,
      patientId,
      branchId,
      "80.00",
    );
    const key = `metadata-${randomUUID()}`;
    let calls = 0;

    const gateway = fakeGateway(async (request) => {
      calls += 1;
      return {
        provider: "mock",
        orderId: `fake_order_${randomUUID().replaceAll("-", "")}`,
        transactionReference: null,
        checkoutUrl: "https://checkout.example.test/order",
        expiresAt: null,
        metadata: {
          mode: "sandbox",
          apiKey: "must-never-be-stored",
          nested: { token: "must-never-be-stored" },
          amount: request.amount,
        } as unknown as GatewayCheckoutOrder["metadata"],
      };
    });

    const dependencies = { gateway };

    const created = await initiatePayment(
      tenantId,
      { invoiceId, method: "CARD", idempotencyKey: key },
      { userId: adminUserId },
      dependencies,
    );
    expect(created.replayed).toBe(false);

    const stored = await getTestAdminPool().query(
      "select metadata from payment_gateway_orders where payment_id = $1",
      [created.paymentId],
    );
    const metadata = (stored.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({ mode: "sandbox", amount: "80.00" });
    expect(metadata).not.toHaveProperty("apiKey");
    expect(metadata).not.toHaveProperty("nested");
    expect(JSON.stringify(metadata)).not.toMatch(/must-never-be-stored/);

    // Two concurrent retries are serialized by the advisory lock; one replays
    // and the provider is called exactly once.
    const retries = await Promise.all([
      initiatePayment(
        tenantId,
        { invoiceId, method: "CARD", idempotencyKey: key },
        { userId: adminUserId },
        dependencies,
      ),
      initiatePayment(
        tenantId,
        { invoiceId, method: "CARD", idempotencyKey: key },
        { userId: adminUserId },
        dependencies,
      ),
    ]);

    for (const retry of retries) {
      expect(retry.replayed).toBe(true);
      expect(retry.paymentId).toBe(created.paymentId);
    }
    expect(calls).toBe(1);
  });
});

describe("initiation tenant isolation", () => {
  it("hides another hospital's invoice from initiation", async () => {
    const before = await counts(tenantId);
    const beforeOther = await counts(otherTenantId);

    await expect(
      initiatePayment(
        tenantId,
        {
          invoiceId: otherTenantInvoiceId,
          method: "CARD",
          idempotencyKey: randomUUID(),
        },
        { userId: adminUserId },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await counts(tenantId)).toEqual(before);
    expect(await counts(otherTenantId)).toEqual(beforeOther);
  });

  it("enforces gateway-order RLS on the restricted database role", async () => {
    const order = await getTestAdminPool().query(
      "select id from payment_gateway_orders where tenant_id = $1 limit 1",
      [tenantId],
    );
    expect(order.rows).toHaveLength(1);
    const orderId = (order.rows[0] as { id: string }).id;

    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      // No tenant context: the policy hides every order and FORCE applies even
      // though the test role owns nothing special.
      const unscoped = await client.query(
        "select count(*)::int as count from payment_gateway_orders",
      );
      expect(unscoped.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        otherTenantId,
      ]);
      const foreign = await client.query(
        "select count(*)::int as count from payment_gateway_orders where id = $1",
        [orderId],
      );
      expect(foreign.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        tenantId,
      ]);
      const owned = await client.query(
        "select count(*)::int as count from payment_gateway_orders where id = $1",
        [orderId],
      );
      expect(owned.rows[0]).toEqual({ count: 1 });
    } finally {
      await client.end();
    }
  });
});

// Type-only assertion that the exported DTO still matches the HTTP shape used
// above; it keeps a careless field rename from silently weakening the tests.
const _typeCheck: PaymentInitiationDto["paymentStatus"] = "PENDING";
void _typeCheck;
