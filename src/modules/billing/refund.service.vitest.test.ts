import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import {
  PaymentGatewayTimeoutError,
  type GatewayRefundRequest,
  type PaymentGateway,
} from "./gateway/payment-gateway.types.js";
import { issueInvoice, recalculateInvoiceBalance } from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import { recordPayment } from "./payment.service.js";
import {
  approveRefund,
  createRefundRequest,
  getRefundById,
  listRefunds,
  processRefund,
  rejectRefund,
} from "./refund.service.js";

/**
 * Integration tests for Phase 19.7.1 refunds.
 *
 * Fixtures use the admin pool for tenants/branches/patients and for seeding a
 * verified gateway capture; invoice creation and manual payment recording go
 * through the real billing services. Tests for offline refunds use the real
 * service path; gateway tests inject a `PaymentGateway` so no credentials or
 * network are involved. Every service call runs as the restricted
 * `hospitalos_app` role inside a tenant-scoped transaction, so RLS is exercised
 * throughout.
 */

const PASSWORD_HASH = "refund-test-hash";

interface Fixture {
  tenantId: string;
  branchId: string;
  patientId: string;
  requesterId: string;
  approverId: string;
}

interface Capture {
  invoiceId: string;
  invoicePaymentId: string;
  receiptId: string;
  amount: string;
}

let fixture: Fixture;
let outsiderFixture: Fixture;

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const patientId = randomUUID();
  const requesterId = randomUUID();
  const approverId = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);
  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'UTC')`,
    [branchId, tenantId, `CEN-${suffix}`],
  );
  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, 'Refund Patient')`,
    [patientId, tenantId, `P-${suffix}`],
  );

  for (const [id, role] of [
    [requesterId, "Requester"],
    [approverId, "Approver"],
  ] as const) {
    await pool.query(
      `insert into users (id, full_name, email, password_hash)
       values ($1, $2, $3, $4)`,
      [id, role, `${label}-${role}-${suffix}@refund.test`, PASSWORD_HASH],
    );
  }

  return { tenantId, branchId, patientId, requesterId, approverId };
}

async function createIssuedInvoice(
  target: Fixture,
  unitPrice: string,
): Promise<string> {
  const draft = await createInvoice(target.tenantId, {
    branchId: target.branchId,
    patientId: target.patientId,
    createdBy: target.requesterId,
    items: [
      { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice },
    ],
  });

  await issueInvoice(target.tenantId, draft.id, { userId: target.requesterId });

  return draft.id;
}

async function makeOfflineCapture(
  target: Fixture,
  amount = "100.00",
): Promise<Capture> {
  const invoiceId = await createIssuedInvoice(target, amount);

  const result = await recordPayment(
    target.tenantId,
    {
      branchId: target.branchId,
      patientId: target.patientId,
      method: "CASH",
      amount,
      reference: `RCPT-${randomUUID().slice(0, 8)}`,
      allocations: [{ invoiceId, amount }],
    },
    { userId: target.requesterId },
  );

  const capture = await getTestAdminPool().query(
    "select id from invoice_payments where tenant_id = $1 and payment_id = $2",
    [target.tenantId, result.payment.id],
  );

  return {
    invoiceId,
    invoicePaymentId: (capture.rows[0] as { id: string }).id,
    receiptId: result.payment.id,
    amount,
  };
}

/** Seeds a verified online capture: successful receipt, settlement and order. */
async function makeGatewayCapture(
  target: Fixture,
  amount = "100.00",
): Promise<Capture> {
  const pool = getTestAdminPool();
  const invoiceId = await createIssuedInvoice(target, amount);
  const receiptId = randomUUID();
  const invoicePaymentId = randomUUID();

  await pool.query(
    `insert into payments
       (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
        payment_status, reference, received_by, received_at)
     values ($1, $2, $3, $4, 'CARD', $5, 'USD', 'SUCCESSFUL', $6, $7, now())`,
    [
      receiptId,
      target.tenantId,
      target.branchId,
      target.patientId,
      amount,
      `GW-${randomUUID().slice(0, 8)}`,
      target.requesterId,
    ],
  );
  await pool.query(
    `insert into invoice_payments
       (id, tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at, created_by)
     values ($1, $2, $3, $4, $5, 'USD', 'SUCCESSFUL', now(), $6)`,
    [invoicePaymentId, target.tenantId, invoiceId, receiptId, amount, target.requesterId],
  );
  await pool.query(
    `insert into payment_gateway_orders
       (tenant_id, payment_id, invoice_id, provider, provider_order_id,
        provider_transaction_reference, amount, currency, status, metadata)
     values ($1, $2, $3, 'mock', $4, $5, $6, 'USD', 'SUCCEEDED', '{}'::jsonb)`,
    [
      target.tenantId,
      receiptId,
      invoiceId,
      `mock_order_${randomUUID().replaceAll("-", "")}`,
      `mock_txn_${randomUUID().replaceAll("-", "")}`,
      amount,
    ],
  );

  await recalculateInvoiceBalance(target.tenantId, invoiceId, {
    userId: target.requesterId,
  });

  return { invoiceId, invoicePaymentId, receiptId, amount };
}

async function createAndApprove(
  target: Fixture,
  capture: Capture,
  amount: string,
  reference?: string,
): Promise<string> {
  const created = await createRefundRequest(
    target.tenantId,
    {
      invoicePaymentId: capture.invoicePaymentId,
      amount,
      reason: "Patient request",
      ...(reference === undefined ? {} : { reference }),
    },
    { userId: target.requesterId },
  );

  await approveRefund(
    target.tenantId,
    created.refund.id,
    { reason: "Approved by finance" },
    { userId: target.approverId },
  );

  return created.refund.id;
}

async function refundRow(refundId: string): Promise<{
  refund_status: string;
  amount: string;
  provider: string | null;
  provider_refund_id: string | null;
  failure_reason: string | null;
  approved_by: string | null;
  refunded_at: Date | null;
}> {
  const result = await getTestAdminPool().query(
    `select refund_status, amount, provider, provider_refund_id, failure_reason,
            approved_by, refunded_at
       from invoice_refunds where id = $1`,
    [refundId],
  );

  return result.rows[0] as {
    refund_status: string;
    amount: string;
    provider: string | null;
    provider_refund_id: string | null;
    failure_reason: string | null;
    approved_by: string | null;
    refunded_at: Date | null;
  };
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

async function refundCount(tenantId: string): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from invoice_refunds where tenant_id = $1",
    [tenantId],
  );

  return (result.rows[0] as { count: number }).count;
}

beforeAll(async () => {
  fixture = await createFixture("refund-main");
  outsiderFixture = await createFixture("refund-outsider");
});

afterAll(async () => {
  const pool = getTestAdminPool();
  const tenantIds = [fixture.tenantId, outsiderFixture.tenantId];
  const userIds = [
    fixture.requesterId,
    fixture.approverId,
    outsiderFixture.requesterId,
    outsiderFixture.approverId,
  ];

  for (const id of tenantIds) {
    await pool.query("delete from tenants where id = $1", [id]);
  }
  for (const id of userIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("refund request lifecycle", () => {
  it("creates, retrieves and fully refunds an offline capture", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");

    const created = await createRefundRequest(
      fixture.tenantId,
      {
        invoicePaymentId: capture.invoicePaymentId,
        amount: "100.00",
        reason: "Treatment cancelled",
        reference: `VOUCHER-${randomUUID().slice(0, 8)}`,
      },
      { userId: fixture.requesterId },
    );

    expect(created.replayed).toBe(false);
    expect(created.refund).toMatchObject({
      invoiceId: capture.invoiceId,
      invoicePaymentId: capture.invoicePaymentId,
      receiptId: capture.receiptId,
      amount: "100.00",
      currency: "USD",
      refundStatus: "PENDING",
      channel: "OFFLINE",
      reason: "Treatment cancelled",
      requestedBy: fixture.requesterId,
      approvedBy: null,
    });

    // The requester sees the request but cannot approve it themselves.
    await expect(
      approveRefund(
        fixture.tenantId,
        created.refund.id,
        {},
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const approved = await approveRefund(
      fixture.tenantId,
      created.refund.id,
      { reason: "Approved" },
      { userId: fixture.approverId },
    );
    expect(approved.refundStatus).toBe("APPROVED");
    expect(approved.approvedBy).toBe(fixture.approverId);
    expect(approved.approvedAt).not.toBeNull();

    // Nothing has moved yet.
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });

    const processed = await processRefund(
      fixture.tenantId,
      created.refund.id,
      {},
      { userId: fixture.requesterId },
    );

    expect(processed.refundStatus).toBe("SUCCESSFUL");
    expect(processed.refundedAt).not.toBeNull();
    expect(processed.processedAt).not.toBeNull();

    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });

    // The capture stays successful; only the refund ledger moves money.
    const settlement = await getTestAdminPool().query(
      "select payment_status from invoice_payments where id = $1",
      [capture.invoicePaymentId],
    );
    expect(settlement.rows[0]).toEqual({ payment_status: "SUCCESSFUL" });
  });

  it("supports a partial refund and leaves the invoice partially paid", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "40.00");

    const processed = await processRefund(
      fixture.tenantId,
      refundId,
      { reference: `CASH-${randomUUID().slice(0, 8)}` },
      { userId: fixture.approverId },
    );

    expect(processed.refundStatus).toBe("SUCCESSFUL");
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "60.00",
      balance_due: "40.00",
    });

    const stored = await refundRow(refundId);
    expect(stored.refund_status).toBe("SUCCESSFUL");
    expect(stored.amount).toBe("40.00");
    expect(stored.refunded_at).not.toBeNull();
  });

  it("rejects excessive and cumulative over-refunds without writing money", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");

    const first = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "70.00" },
      { userId: fixture.requesterId },
    );
    expect(first.refund.refundStatus).toBe("PENDING");

    await expect(
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "40.00" },
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: expect.objectContaining({ reason: "REFUND_EXCEEDS_CAPTURED_AMOUNT" }),
    });

    await expect(
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "0.00" },
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await invoiceHeader(capture.invoiceId)).toMatchObject({
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });

  it("replays an idempotent request and rejects key reuse for a different request", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const key = `refund-idem-${randomUUID()}`;
    const before = await refundCount(fixture.tenantId);

    const first = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "30.00", idempotencyKey: key },
      { userId: fixture.requesterId },
    );
    expect(first.replayed).toBe(false);

    const replay = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "30.00", idempotencyKey: key },
      { userId: fixture.requesterId },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.refund.id).toBe(first.refund.id);
    expect(await refundCount(fixture.tenantId)).toBe(before + 1);

    await expect(
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "31.00", idempotencyKey: key },
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows only one of two concurrent full-amount requests", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");

    const results = await Promise.allSettled([
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "100.00" },
        { userId: fixture.requesterId },
      ),
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "100.00" },
        { userId: fixture.requesterId },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ statusCode: 422 });

    const reserved = await getTestAdminPool().query(
      `select coalesce(sum(amount), 0)::text as total
         from invoice_refunds
        where tenant_id = $1 and payment_id = $2
          and refund_status in ('PENDING','APPROVED','PROCESSING','SUCCESSFUL')`,
      [fixture.tenantId, capture.invoicePaymentId],
    );
    expect(reserved.rows[0]).toEqual({ total: "100.00" });
  });

  it("rejects a request and refuses to process it", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const created = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "50.00" },
      { userId: fixture.requesterId },
    );

    const rejected = await rejectRefund(
      fixture.tenantId,
      created.refund.id,
      { reason: "Outside policy" },
      { userId: fixture.approverId },
    );
    expect(rejected.refundStatus).toBe("REJECTED");
    expect(rejected.decisionReason).toBe("Outside policy");

    await expect(
      approveRefund(fixture.tenantId, created.refund.id, {}, { userId: fixture.approverId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      processRefund(fixture.tenantId, created.refund.id, {}, { userId: fixture.approverId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await invoiceHeader(capture.invoiceId)).toMatchObject({
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });

  it("processes a refund only once even when called repeatedly", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "100.00");

    const first = await processRefund(fixture.tenantId, refundId, {}, {
      userId: fixture.approverId,
    });
    expect(first.refundStatus).toBe("SUCCESSFUL");

    const second = await processRefund(fixture.tenantId, refundId, {}, {
      userId: fixture.approverId,
    });
    expect(second.refundStatus).toBe("SUCCESSFUL");
    expect(second.refundedAt).toEqual(first.refundedAt);

    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });

    const refunds = await getTestAdminPool().query(
      "select count(*)::int as count from invoice_refunds where tenant_id = $1 and payment_id = $2",
      [fixture.tenantId, capture.invoicePaymentId],
    );
    expect((refunds.rows[0] as { count: number }).count).toBe(1);
  });
});

describe("refund gateway processing", () => {
  it("verifies a gateway refund and synchronises the invoice", async () => {
    const capture = await makeGatewayCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "100.00");
    const calls: GatewayRefundRequest[] = [];

    const gateway: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund(request) {
        calls.push(request);
        return {
          provider: "mock",
          refundId: `gw_refund_${randomUUID().replaceAll("-", "")}`,
          status: "SUCCESSFUL",
          transactionReference: `gw_txn_${randomUUID().replaceAll("-", "")}`,
        };
      },
    };

    const processed = await processRefund(
      fixture.tenantId,
      refundId,
      {},
      { userId: fixture.approverId },
      { gateway },
    );

    expect(processed.refundStatus).toBe("SUCCESSFUL");
    expect(processed.channel).toBe("GATEWAY");
    expect(processed.provider).toBe("mock");
    expect(processed.providerRefundId).toMatch(/^gw_refund_/);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenantId: fixture.tenantId,
      refundId,
      paymentId: capture.invoicePaymentId,
      amount: "100.00",
      currency: "USD",
    });
    expect(String(calls[0]?.providerOrderId)).toMatch(/^mock_order_/);

    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "REFUNDED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });
  });

  it("records a provider rejection as FAILED and permits a retry", async () => {
    const capture = await makeGatewayCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "40.00");

    const failing: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund() {
        return {
          provider: "mock",
          refundId: `gw_refund_${randomUUID().replaceAll("-", "")}`,
          status: "FAILED",
          transactionReference: null,
        };
      },
    };

    const failed = await processRefund(
      fixture.tenantId,
      refundId,
      {},
      { userId: fixture.approverId },
      { gateway: failing },
    );

    expect(failed.refundStatus).toBe("FAILED");
    expect(failed.failureReason).toMatch(/declined/i);
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });

    const succeeding: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund() {
        return {
          provider: "mock",
          refundId: `gw_refund_${randomUUID().replaceAll("-", "")}`,
          status: "SUCCESSFUL",
          transactionReference: null,
        };
      },
    };

    const retried = await processRefund(
      fixture.tenantId,
      refundId,
      {},
      { userId: fixture.approverId },
      { gateway: succeeding },
    );

    expect(retried.refundStatus).toBe("SUCCESSFUL");
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "60.00",
      balance_due: "40.00",
    });
  });

  it("keeps an unverified timeout as PROCESSING and never marks the invoice refunded", async () => {
    const capture = await makeGatewayCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "25.00");

    const timingOut: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund() {
        throw new PaymentGatewayTimeoutError("mock", 10);
      },
    };

    const pending = await processRefund(
      fixture.tenantId,
      refundId,
      {},
      { userId: fixture.approverId },
      { gateway: timingOut },
    );

    expect(pending.refundStatus).toBe("PROCESSING");
    expect(pending.failureReason).toMatch(/timeout|unverified/i);
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });

    // A PROCESSING refund cannot be fired at the provider again until its
    // outcome has been reconciled.
    await expect(
      processRefund(fixture.tenantId, refundId, {}, { userId: fixture.approverId }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rolls back a verified success when the invoice lifecycle write fails", async () => {
    const capture = await makeGatewayCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "100.00");

    // The provider succeeds, but the invoice is cancelled underneath the final
    // transaction. The refund update and the balance recalculation must roll
    // back together: money is not marked returned and the header is untouched.
    const racing: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund() {
        await getTestAdminPool().query(
          "update invoices set invoice_status = 'CANCELLED' where id = $1",
          [capture.invoiceId],
        );

        return {
          provider: "mock",
          refundId: `gw_refund_${randomUUID().replaceAll("-", "")}`,
          status: "SUCCESSFUL",
          transactionReference: null,
        };
      },
    };

    await expect(
      processRefund(
        fixture.tenantId,
        refundId,
        {},
        { userId: fixture.approverId },
        { gateway: racing },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const stored = await refundRow(refundId);
    expect(stored.refund_status).toBe("PROCESSING");
    expect(stored.refunded_at).toBeNull();
    expect((await invoiceHeader(capture.invoiceId)).invoice_status).toBe("CANCELLED");
  });

  it("treats a malformed provider response as a failed, non-settling outcome", async () => {
    const capture = await makeGatewayCapture(fixture, "100.00");
    const refundId = await createAndApprove(fixture, capture, "100.00");

    const malformed: PaymentGateway = {
      provider: "mock",
      async createOrder() {
        throw new Error("not used");
      },
      async refund() {
        return {
          provider: "mock",
          refundId: "",
          status: "SUCCESSFUL",
          transactionReference: null,
        };
      },
    };

    const result = await processRefund(
      fixture.tenantId,
      refundId,
      {},
      { userId: fixture.approverId },
      { gateway: malformed },
    );

    expect(result.refundStatus).toBe("FAILED");
    expect(result.failureReason).toMatch(/invalid/i);
    expect(await invoiceHeader(capture.invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });
});

describe("refund validation and isolation", () => {
  it("rejects an unknown capture and a currency mismatch", async () => {
    await expect(
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: randomUUID(), amount: "10.00" },
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    const capture = await makeOfflineCapture(fixture, "100.00");
    await getTestAdminPool().query(
      "update invoice_payments set currency = 'EUR' where id = $1",
      [capture.invoicePaymentId],
    );

    await expect(
      createRefundRequest(
        fixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "10.00" },
        { userId: fixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("hides refunds and captures from another hospital", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const created = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "20.00" },
      { userId: fixture.requesterId },
    );

    await expect(
      getRefundById(outsiderFixture.tenantId, created.refund.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      createRefundRequest(
        outsiderFixture.tenantId,
        { invoicePaymentId: capture.invoicePaymentId, amount: "20.00" },
        { userId: outsiderFixture.requesterId },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      approveRefund(
        outsiderFixture.tenantId,
        created.refund.id,
        {},
        { userId: outsiderFixture.approverId },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("enforces refund RLS on the restricted database role", async () => {
    const capture = await makeOfflineCapture(fixture, "100.00");
    const created = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: capture.invoicePaymentId, amount: "15.00" },
      { userId: fixture.requesterId },
    );

    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      const unscoped = await client.query(
        "select count(*)::int as count from invoice_refunds",
      );
      expect(unscoped.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        outsiderFixture.tenantId,
      ]);
      const foreign = await client.query(
        "select count(*)::int as count from invoice_refunds where id = $1",
        [created.refund.id],
      );
      expect(foreign.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        fixture.tenantId,
      ]);
      const owned = await client.query(
        "select count(*)::int as count from invoice_refunds where id = $1",
        [created.refund.id],
      );
      expect(owned.rows[0]).toEqual({ count: 1 });
    } finally {
      await client.end();
    }
  });

  it("lists refunds with filters and pagination", async () => {
    const captureA = await makeOfflineCapture(fixture, "100.00");
    const captureB = await makeOfflineCapture(fixture, "100.00");

    const pending = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: captureA.invoicePaymentId, amount: "10.00" },
      { userId: fixture.requesterId },
    );
    const rejected = await createRefundRequest(
      fixture.tenantId,
      { invoicePaymentId: captureB.invoicePaymentId, amount: "20.00" },
      { userId: fixture.requesterId },
    );
    await rejectRefund(
      fixture.tenantId,
      rejected.refund.id,
      { reason: "Duplicate request" },
      { userId: fixture.approverId },
    );

    const byStatus = await listRefunds(fixture.tenantId, {
      status: "REJECTED",
      paymentId: captureB.invoicePaymentId,
    });
    expect(byStatus.refunds).toHaveLength(1);
    expect(byStatus.refunds[0]?.id).toBe(rejected.refund.id);

    const page = await listRefunds(fixture.tenantId, { page: 1, pageSize: 1 });
    expect(page.refunds).toHaveLength(1);
    expect(page.pageSize).toBe(1);
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.totalPages).toBe(page.total);

    const forInvoice = await listRefunds(fixture.tenantId, {
      invoiceId: captureA.invoiceId,
    });
    expect(forInvoice.refunds.map((refund) => refund.id)).toEqual([pending.refund.id]);

    await expect(listRefunds(fixture.tenantId, { status: "SUCCESS" as never })).rejects
      .toMatchObject({ statusCode: 422 });
    await expect(
      listRefunds(fixture.tenantId, { fromDate: "2026-05-01", toDate: "2026-04-01" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("applies a full refund to a partially paid invoice through the lifecycle", async () => {
    const invoiceId = await createIssuedInvoice(fixture, "100.00");

    // Two captures settle 40 and 60.
    const first = await recordPayment(
      fixture.tenantId,
      {
        branchId: fixture.branchId,
        patientId: fixture.patientId,
        method: "CASH",
        amount: "40.00",
        allocations: [{ invoiceId, amount: "40.00" }],
      },
      { userId: fixture.requesterId },
    );
    await recordPayment(
      fixture.tenantId,
      {
        branchId: fixture.branchId,
        patientId: fixture.patientId,
        method: "CARD",
        amount: "60.00",
        allocations: [{ invoiceId, amount: "60.00" }],
      },
      { userId: fixture.requesterId },
    );

    const capture = await getTestAdminPool().query(
      "select id from invoice_payments where tenant_id = $1 and payment_id = $2",
      [fixture.tenantId, first.payment.id],
    );
    const captureId = (capture.rows[0] as { id: string }).id;

    const refundId = await createAndApprove(
      fixture,
      { invoiceId, invoicePaymentId: captureId, receiptId: first.payment.id, amount: "40.00" },
      "40.00",
    );
    const processed = await processRefund(fixture.tenantId, refundId, {}, {
      userId: fixture.approverId,
    });

    expect(processed.refundStatus).toBe("SUCCESSFUL");
    expect(await invoiceHeader(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "60.00",
      balance_due: "40.00",
    });
  });
});
