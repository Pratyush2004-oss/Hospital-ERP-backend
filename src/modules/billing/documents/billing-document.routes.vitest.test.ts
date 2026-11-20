import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../app.js";
import { closePool } from "../../../database/connection.js";
import { getStorageProvider } from "../../../lib/storage/index.js";
import { StorageOperationError } from "../../../lib/storage/storage.types.js";
import { closeTestAdminPool, getTestAdminPool } from "../../../test/database.js";
import { testAppDatabaseUrl } from "../../../test/database-config.js";
import {
  createTestApi,
  type TestApi,
  type TestResponse,
} from "../../../test/http-client.js";
import { cancelInvoice, issueInvoice } from "../invoice.lifecycle.service.js";
import { createInvoice } from "../invoice.service.js";
import {
  formatDocumentMoney,
  formatDocumentQuantity,
} from "./billing-document.model.js";
import { generateInvoiceDocument } from "./billing-document.service.js";

/**
 * HTTP integration tests for the Phase 19.8.2 billing document API.
 *
 * They exercise the real Express app, the restricted `hospitalos_app` role and
 * the real local storage adapter, so tenant RLS, RBAC, CSRF, PDF bytes and
 * private-file behaviour are all covered end to end. Fixtures use the billing
 * services (invoices and refunds have services, not fixture APIs).
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface DocumentShape {
  id: string;
  documentType: string;
  documentNumber: string;
  invoiceId: string;
  paymentId: string | null;
  refundId: string | null;
  branchId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  generatedBy: string | null;
  regeneratedFromId: string | null;
  createdAt: string;
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

function documentOf(response: TestResponse): DocumentShape {
  return dataOf<{ document: DocumentShape }>(response).document;
}

interface Fixture {
  tenantId: string;
  slug: string;
  branchId: string;
  otherBranchId: string;
  patientId: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  captureId: string;
  refundId: string;
  pendingRefundId: string;
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
let otherTenantId: string;
let fixture: Fixture;

let invoiceDocumentId: string;
let regeneratedDocumentId: string;
let receiptDocumentId: string;
let creditNoteDocumentId: string;

let draftInvoiceId: string;
let cancelledInvoiceId: string;
let failedPaymentId: string;
let otherTenantInvoiceId: string;

const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@billing-docs.test`;
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
  unitPrice = "82.50",
): Promise<{ id: string; invoiceNumber: string }> {
  const draft = await createInvoice(tenant, {
    branchId: branch,
    patientId: patient,
    createdBy: actorUserId,
    items: [
      { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice },
    ],
  });

  await issueInvoice(tenant, draft.id, { userId: actorUserId });

  return { id: draft.id, invoiceNumber: draft.invoiceNumber };
}

async function recordPayment(
  client: TestApi,
  branch: string,
  patient: string,
  invoiceId: string,
  amount: string,
): Promise<{ id: string; reference: string }> {
  const reference = `RCPT-${randomUUID().slice(0, 8)}`;
  const response = await client.post(`${API}/payments`, {
    body: {
      branchId: branch,
      patientId: patient,
      method: "CASH",
      amount,
      reference,
      allocations: [{ invoiceId, amount }],
    },
    headers: { "idempotency-key": randomUUID() },
  });
  expect(response.status).toBe(201);

  return { id: dataOf<{ payment: { id: string } }>(response).payment.id, reference };
}

async function captureOf(paymentId: string): Promise<string> {
  const result = await getTestAdminPool().query(
    "select id from invoice_payments where payment_id = $1",
    [paymentId],
  );
  return (result.rows[0] as { id: string }).id;
}

async function approveAndProcess(refundId: string, approver: TestApi): Promise<void> {
  expect((await approver.post(`${API}/refunds/${refundId}/approve`, { body: {} })).status).toBe(
    200,
  );
  expect(
    (await api.post(`${API}/refunds/${refundId}/process`, { body: {} })).status,
  ).toBe(200);
}

function generateInvoice(
  client: TestApi,
  invoiceId: string,
  regenerate = false,
): Promise<TestResponse> {
  return client.post(
    `${API}/billing-documents/invoices/${invoiceId}${regenerate ? "?regenerate=true" : ""}`,
    { body: {} },
  );
}

async function documentCount(): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from billing_documents where tenant_id = $1",
    [tenantId],
  );
  return (result.rows[0] as { count: number }).count;
}

async function invoiceSnapshot(invoiceId: string): Promise<Record<string, unknown>> {
  const result = await getTestAdminPool().query(
    `select invoice_status, amount_paid, balance_due, updated_at
       from invoices where id = $1`,
    [invoiceId],
  );
  const row = result.rows[0] as Record<string, unknown>;
  return { ...row, updated_at: (row.updated_at as Date).toISOString() };
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
  const adminEmail = `admin-${suffix}@billing-docs.test`;

  const registered = await api.post(`${API}/auth/register`, {
    body: { fullName: "Billing Doc Admin", email: adminEmail, password: PASSWORD },
  });
  expect(registered.status).toBe(201);
  adminUserId = dataOf<{ user: { id: string } }>(registered).user.id;
  createdUserIds.push(adminUserId);

  await loginAs(api, adminEmail);
  const tenant = await registerTenant(api, `Billing Docs ${suffix}`);
  tenantId = tenant.id;
  await selectTenant(api, tenant.slug);

  const branchId = await createBranch(tenantId, "MAIN");
  const otherBranchId = await createBranch(tenantId, "EAST");
  const patientId = await createPatient(api, "Ada Billing");

  const invoice = await createIssuedInvoice(tenantId, adminUserId, patientId, branchId);
  const payment = await recordPayment(
    api,
    branchId,
    patientId,
    invoice.id,
    "82.50",
  );
  const captureId = await captureOf(payment.id);

  // One successful partial refund for the credit note fixture.
  const refund = await api.post(`${API}/refunds`, {
    body: {
      invoicePaymentId: captureId,
      amount: "20.00",
      reason: "Service not rendered",
      reference: `CN-${randomUUID().slice(0, 8)}`,
    },
    headers: { "idempotency-key": randomUUID() },
  });
  expect(refund.status).toBe(201);
  const refundId = dataOf<{ refund: { id: string } }>(refund).refund.id;

  const pendingRefund = await api.post(`${API}/refunds`, {
    body: { invoicePaymentId: captureId, amount: "5.00" },
    headers: { "idempotency-key": randomUUID() },
  });
  expect(pendingRefund.status).toBe(201);

  fixture = {
    tenantId,
    slug: tenant.slug,
    branchId,
    otherBranchId,
    patientId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    paymentId: payment.id,
    captureId,
    refundId,
    pendingRefundId: dataOf<{ refund: { id: string } }>(pendingRefund).refund.id,
  };

  const draft = await createInvoice(tenantId, {
    branchId,
    patientId,
    createdBy: adminUserId,
    items: [
      { itemType: "CONSULTATION", description: "Draft consultation", quantity: 1, unitPrice: "10.00" },
    ],
  });
  draftInvoiceId = draft.id;

  const cancellable = await createIssuedInvoice(
    tenantId,
    adminUserId,
    patientId,
    branchId,
    "10.00",
  );
  cancelledInvoiceId = cancellable.id;
  await cancelInvoice(tenantId, cancellable.id, {}, { userId: adminUserId });

  // A payment row in a non-successful state, to prove receipts are gated.
  failedPaymentId = randomUUID();
  await getTestAdminPool().query(
    `insert into payments
       (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
        payment_status, reference, received_by, received_at)
     values ($1, $2, $3, $4, 'CASH', '10.00', 'USD', 'FAILED', $5, $6, now())`,
    [failedPaymentId, tenantId, branchId, patientId, `FAIL-${suffix}`, adminUserId],
  );

  // Roles: accountant and receptionist hold payment:read; doctor does not.
  const accountant = await createAccount(`accountant-${suffix}`);
  accountantUserId = accountant.id;
  await addMembership(tenantId, accountant.id, "accountant");
  await loginAs(accountantApi, accountant.email);
  await selectTenant(accountantApi, tenant.slug);

  // The requester (admin) cannot approve its own refund, so the accountant
  // decides it; processing is then done by the admin.
  await approveAndProcess(refundId, accountantApi);

  const receptionist = await createAccount(`receptionist-${suffix}`);
  await addMembership(tenantId, receptionist.id, "receptionist");
  await loginAs(receptionistApi, receptionist.email);
  await selectTenant(receptionistApi, tenant.slug);

  const doctor = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctor.id, "doctor");
  await loginAs(doctorApi, doctor.email);
  await selectTenant(doctorApi, tenant.slug);

  const branchAdmin = await createAccount(`branch-admin-${suffix}`);
  await addMembership(tenantId, branchAdmin.id, "branch_admin");
  await loginAs(branchAdminApi, branchAdmin.email);
  await selectTenant(branchAdminApi, tenant.slug);

  // A second hospital with its own invoice.
  const otherAdminEmail = `other-admin-${suffix}@billing-docs.test`;
  const otherRegistered = await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Billing Admin", email: otherAdminEmail, password: PASSWORD },
  });
  expect(otherRegistered.status).toBe(201);
  const otherAdminId = dataOf<{ user: { id: string } }>(otherRegistered).user.id;
  createdUserIds.push(otherAdminId);

  await loginAs(otherApi, otherAdminEmail);
  const otherTenant = await registerTenant(otherApi, `Other Billing Docs ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  const foreignBranchId = await createBranch(otherTenant.id, "MAIN");
  const otherPatientId = await createPatient(otherApi, "Foreign Billing Patient");
  otherTenantInvoiceId = (
    await createIssuedInvoice(
      otherTenant.id,
      otherAdminId,
      otherPatientId,
      foreignBranchId,
      "30.00",
    )
  ).id;
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const id of createdTenantIds) {
    await pool.query("delete from tenants where id = $1", [id]);
  }
  for (const id of createdUserIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  // Remove generated PDFs so repeated local runs never accumulate files.
  for (const id of createdTenantIds) {
    await rm(resolve(process.cwd(), "storage/private/tenants", id), {
      recursive: true,
      force: true,
    });
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

describe("billing document generation API", () => {
  it("generates an invoice PDF and reuses it without regenerating", async () => {
    const created = await generateInvoice(accountantApi, fixture.invoiceId);
    expect(created.status).toBe(201);

    const document = documentOf(created);
    expect(document).toMatchObject({
      documentType: "INVOICE",
      documentNumber: fixture.invoiceNumber,
      invoiceId: fixture.invoiceId,
      paymentId: null,
      refundId: null,
      branchId: fixture.branchId,
      mimeType: "application/pdf",
      generatedBy: accountantUserId,
      regeneratedFromId: null,
    });
    expect(document.fileSize).toBeGreaterThan(500);
    expect(document.fileName).toMatch(/^INV-.+\.pdf$/);

    // The DTO never exposes the private storage key or a URL.
    const raw = JSON.stringify(created.body);
    expect(raw).not.toMatch(/storageKey|storage_key|https?:\/\//);

    invoiceDocumentId = document.id;

    const reused = await generateInvoice(api, fixture.invoiceId);
    expect(reused.status).toBe(200);
    expect(dataOf<{ reused: boolean }>(reused).reused).toBe(true);
    expect(documentOf(reused).id).toBe(invoiceDocumentId);
    expect(await documentCount()).toBe(1);
  });

  it("creates a linked new version on explicit regeneration", async () => {
    const before = await invoiceSnapshot(fixture.invoiceId);
    const regenerated = await generateInvoice(accountantApi, fixture.invoiceId, true);

    expect(regenerated.status).toBe(201);
    const document = documentOf(regenerated);
    expect(document.id).not.toBe(invoiceDocumentId);
    expect(document.regeneratedFromId).toBe(invoiceDocumentId);
    expect(document.documentNumber).toBe(fixture.invoiceNumber);
    expect(document.fileSize).toBeGreaterThan(500);

    regeneratedDocumentId = document.id;

    // Generation never rewrites financial rows.
    expect(await invoiceSnapshot(fixture.invoiceId)).toEqual(before);
    expect(await documentCount()).toBe(2);
  });

  it("generates a receipt for a successful payment and its allocations", async () => {
    const response = await accountantApi.post(
      `${API}/billing-documents/payments/${fixture.paymentId}/receipt`,
      { body: {} },
    );

    expect(response.status).toBe(201);
    const document = documentOf(response);
    expect(document.documentType).toBe("PAYMENT_RECEIPT");
    expect(document.paymentId).toBe(fixture.paymentId);
    expect(document.invoiceId).toBe(fixture.invoiceId);
    expect(document.documentNumber).toMatch(/^RCPT-/);
    expect(document.fileSize).toBeGreaterThan(500);

    receiptDocumentId = document.id;
  });

  it("generates a credit note only for a successful refund", async () => {
    const response = await accountantApi.post(
      `${API}/billing-documents/refunds/${fixture.refundId}/credit-note`,
      { body: {} },
    );

    expect(response.status).toBe(201);
    const document = documentOf(response);
    expect(document.documentType).toBe("CREDIT_NOTE");
    expect(document.refundId).toBe(fixture.refundId);
    expect(document.invoiceId).toBe(fixture.invoiceId);
    expect(document.documentNumber).toMatch(/^CN-/);
    expect(document.fileSize).toBeGreaterThan(500);

    creditNoteDocumentId = document.id;

    const pending = await accountantApi.post(
      `${API}/billing-documents/refunds/${fixture.pendingRefundId}/credit-note`,
      { body: {} },
    );
    expect(pending.status).toBe(409);
    expect(errorOf(pending).code).toBe("CONFLICT");
    expect(await documentCount()).toBe(4);
  });

  it("rejects draft and cancelled invoices as financial documents", async () => {
    for (const invoiceId of [draftInvoiceId, cancelledInvoiceId]) {
      const response = await generateInvoice(api, invoiceId);
      expect(response.status).toBe(409);
      expect(errorOf(response).code).toBe("CONFLICT");
      expect(errorOf(response).message).toMatch(/draft|cancelled/i);
    }

    const before = await documentCount();
    expect(await documentCount()).toBe(before);
  });

  it("rejects receipts for non-successful payments", async () => {
    const failed = await accountantApi.post(
      `${API}/billing-documents/payments/${failedPaymentId}/receipt`,
      { body: {} },
    );
    expect(failed.status).toBe(409);
    expect(errorOf(failed).message).toMatch(/successful/i);

    const unknown = await accountantApi.post(
      `${API}/billing-documents/payments/${randomUUID()}/receipt`,
      { body: {} },
    );
    expect(unknown.status).toBe(404);
  });

  it("validates ids and the regeneration flag", async () => {
    const malformedInvoice = await generateInvoice(api, "not-an-invoice-id");
    expect(malformedInvoice.status).toBe(422);

    const badFlag = await api.post(
      `${API}/billing-documents/invoices/${fixture.invoiceId}?regenerate=yes`,
      { body: {} },
    );
    expect(badFlag.status).toBe(422);

    const malformedDocument = await api.get(`${API}/billing-documents/not-a-doc`);
    expect(malformedDocument.status).toBe(422);
  });
});

describe("billing document retrieval and streaming", () => {
  it("streams the stored PDF with private cache headers", async () => {
    const response = await api.get(`${API}/billing-documents/${invoiceDocumentId}/file`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(
      /attachment; filename="INV-.+\.pdf"/,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(String(response.body).startsWith("%PDF-")).toBe(true);
  });

  it("returns metadata for one document and hides the storage key", async () => {
    const response = await api.get(`${API}/billing-documents/${receiptDocumentId}`);
    expect(response.status).toBe(200);

    const document = documentOf(response);
    expect(document.id).toBe(receiptDocumentId);
    expect(document.documentType).toBe("PAYMENT_RECEIPT");
    expect(JSON.stringify(response.body)).not.toMatch(/storageKey|storage_key/);

    const credit = await api.get(`${API}/billing-documents/${creditNoteDocumentId}`);
    expect(credit.status).toBe(200);
    expect(documentOf(credit).documentType).toBe("CREDIT_NOTE");
  });

  it("returns 404 when the stored object is missing and regenerates on demand", async () => {
    const keyResult = await getTestAdminPool().query(
      "select storage_key from billing_documents where id = $1",
      [regeneratedDocumentId],
    );
    const storageKey = (keyResult.rows[0] as { storage_key: string }).storage_key;

    await getStorageProvider().deleteObject(storageKey);

    const missing = await api.get(
      `${API}/billing-documents/${regeneratedDocumentId}/file`,
    );
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe("NOT_FOUND");

    // A missing object no longer counts as reusable, so generation recreates it.
    const regenerated = await generateInvoice(api, fixture.invoiceId);
    expect(regenerated.status).toBe(201);
    expect(documentOf(regenerated).id).not.toBe(regeneratedDocumentId);

    const streamed = await api.get(`${API}/billing-documents/${documentOf(regenerated).id}/file`);
    expect(streamed.status).toBe(200);
    expect(String(streamed.body).startsWith("%PDF-")).toBe(true);
  });

  it("verifies the document against its invoice branch before streaming", async () => {
    await getTestAdminPool().query(
      "update billing_documents set branch_id = $1 where id = $2",
      [fixture.otherBranchId, invoiceDocumentId],
    );

    const response = await api.get(`${API}/billing-documents/${invoiceDocumentId}/file`);
    expect(response.status).toBe(409);
    expect(errorOf(response).message).toMatch(/branch/i);

    // Restore the fixture so later download assertions use a valid record.
    await getTestAdminPool().query(
      "update billing_documents set branch_id = $1 where id = $2",
      [fixture.branchId, invoiceDocumentId],
    );
  });
});

describe("billing document access control", () => {
  it("requires authentication, CSRF and payment:read", async () => {
    expect(
      (await anonymousApi.post(`${API}/billing-documents/invoices/${fixture.invoiceId}`, {
        body: {},
      })).status,
    ).toBe(401);
    expect(
      (await anonymousApi.get(`${API}/billing-documents/${invoiceDocumentId}/file`)).status,
    ).toBe(401);

    const withoutCsrf = await accountantApi.post(
      `${API}/billing-documents/invoices/${fixture.invoiceId}`,
      { body: {}, csrf: false },
    );
    expect(withoutCsrf.status).toBe(403);
    expect(errorOf(withoutCsrf).message).toMatch(/csrf/i);

    // A doctor holds no payment keys.
    expect(
      (await doctorApi.post(`${API}/billing-documents/invoices/${fixture.invoiceId}`, {
        body: {},
      })).status,
    ).toBe(403);
    expect(
      (await doctorApi.get(`${API}/billing-documents/${invoiceDocumentId}`)).status,
    ).toBe(403);
    expect(
      (await doctorApi.get(`${API}/billing-documents/${invoiceDocumentId}/file`)).status,
    ).toBe(403);

    // Front desk and branch admin hold payment:read and may read documents.
    expect(
      (await receptionistApi.get(`${API}/billing-documents/${invoiceDocumentId}`)).status,
    ).toBe(200);
    expect(
      (await branchAdminApi.get(`${API}/billing-documents/${invoiceDocumentId}/file`))
        .status,
    ).toBe(200);
  });

  it("does not leak another tenant's documents or source records", async () => {
    expect(
      (await otherApi.post(`${API}/billing-documents/invoices/${fixture.invoiceId}`, {
        body: {},
      })).status,
    ).toBe(404);

    expect(
      (await otherApi.post(
        `${API}/billing-documents/payments/${fixture.paymentId}/receipt`,
        { body: {} },
      )).status,
    ).toBe(404);

    expect(
      (await otherApi.post(
        `${API}/billing-documents/refunds/${fixture.refundId}/credit-note`,
        { body: {} },
      )).status,
    ).toBe(404);

    expect(
      (await otherApi.get(`${API}/billing-documents/${invoiceDocumentId}`)).status,
    ).toBe(404);
    expect(
      (await otherApi.get(`${API}/billing-documents/${invoiceDocumentId}/file`)).status,
    ).toBe(404);

    // This hospital's own invoice generates fine, so isolation is not a 404 wall.
    const own = await otherApi.post(
      `${API}/billing-documents/invoices/${otherTenantInvoiceId}`,
      { body: {} },
    );
    expect(own.status).toBe(201);
    expect(documentOf(own).invoiceId).toBe(otherTenantInvoiceId);
  });

  it("does not serve private documents from a public path", async () => {
    // No static mount exists for the private storage root.
    const publicAttempt = await anonymousApi.get(
      "/storage/private/tenants/anything/billing/invoice/x.pdf",
    );
    expect(publicAttempt.status).toBe(404);

    // The JSON API never returns a permanent URL.
    const metadata = await api.get(`${API}/billing-documents/${invoiceDocumentId}`);
    expect(JSON.stringify(metadata.body)).not.toMatch(/https?:\/\//);
  });
});

describe("generation failure handling", () => {
  it("writes no metadata or billing change when rendering or storage fails", async () => {
    const beforeDocuments = await documentCount();
    const beforeInvoice = await invoiceSnapshot(fixture.invoiceId);

    const actor = {
      userId: accountantUserId,
      permissions: new Set(["payment:read"]),
    };

    await expect(
      generateInvoiceDocument(tenantId, fixture.invoiceId, actor, {
        regenerate: true,
        renderer: {
          render: async () => {
            throw new Error("renderer exploded");
          },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const failingStorage = {
      name: "failing",
      putObject: async () => {
        throw new StorageOperationError("putObject");
      },
      getObject: async () => {
        throw new StorageOperationError("getObject");
      },
      deleteObject: async () => undefined,
      createSignedDownloadUrl: async () => {
        throw new StorageOperationError("sign");
      },
    };

    await expect(
      generateInvoiceDocument(tenantId, fixture.invoiceId, actor, {
        regenerate: true,
        storage: failingStorage,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(await documentCount()).toBe(beforeDocuments);
    expect(await invoiceSnapshot(fixture.invoiceId)).toEqual(beforeInvoice);
  });

  it("formats money and quantities with decimal-safe helpers", () => {
    expect(formatDocumentMoney("1234567.5")).toBe("1,234,567.50");
    expect(formatDocumentMoney("0.00")).toBe("0.00");
    expect(formatDocumentQuantity("1.000")).toBe("1");
    expect(formatDocumentQuantity("2.500")).toBe("2.5");
    expect(() => formatDocumentQuantity("abc")).toThrow();
  });
});

describe("RLS for billing documents", () => {
  it("enforces the restricted application role", async () => {
    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      const unscoped = await client.query(
        "select count(*)::int as count from billing_documents",
      );
      expect(unscoped.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        otherTenantId,
      ]);
      const outsider = await client.query(
        "select count(*)::int as count from billing_documents where id = $1",
        [invoiceDocumentId],
      );
      expect(outsider.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        tenantId,
      ]);
      const owner = await client.query(
        "select count(*)::int as count from billing_documents where id = $1",
        [invoiceDocumentId],
      );
      expect(owner.rows[0]).toEqual({ count: 1 });

      const hiddenWrite = await client.query(
        `update billing_documents set file_name = 'tampered.pdf'
          where tenant_id = $1 and id = $2`,
        [otherTenantId, invoiceDocumentId],
      );
      expect(hiddenWrite.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
