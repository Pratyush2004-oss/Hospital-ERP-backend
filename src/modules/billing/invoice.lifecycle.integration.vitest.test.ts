import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import type { BillingAuditEvent, BillingAuditSink } from "./billing.audit.js";
import {
  cancelInvoice,
  getInvoiceBalance,
  INVOICE_TRANSITIONS,
  issueInvoice,
  recalculateInvoiceBalance,
  reconcileInvoiceBalance,
  updateInvoiceStatus,
} from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import type {
  CreateInvoiceInput,
  InvoiceActorContext,
  InvoiceStatus,
} from "./invoice.types.js";

/**
 * Integration tests for Task 19.3.2 (lifecycle integration, reconciliation and
 * final verification).
 *
 * Fixtures and payment/refund rows are written with the admin connection; the
 * service runs as the restricted `hospitalos_app` role inside a tenant-scoped
 * transaction. Payment and refund *processing* is out of scope, so the tests
 * seed those ledger rows directly, exactly as the future payment task will.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly patientId: string;
}

interface RecordedAudit {
  readonly event: BillingAuditEvent;
  readonly details: Record<string, unknown>;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const patientId = randomUUID();

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
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'invoice-integration-test-hash')`,
    [userId, "Billing Clerk", `integration-${suffix}@invoices.test`],
  );
  createdUserIds.push(userId);
  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, 'Ada Patient')`,
    [patientId, tenantId, `P-${suffix}`],
  );

  const fixture = { tenantId, branchId, userId, patientId };
  fixtures.push(fixture);
  return fixture;
}

function newInvoice(
  fixture: Fixture,
  overrides: Partial<CreateInvoiceInput> = {},
): CreateInvoiceInput {
  return {
    branchId: fixture.branchId,
    patientId: fixture.patientId,
    createdBy: fixture.userId,
    items: [
      {
        itemType: "CONSULTATION",
        description: "Consultation",
        quantity: 1,
        unitPrice: "100.00",
      },
    ],
    ...overrides,
  };
}

function actor(fixture: Fixture, audit?: BillingAuditSink): InvoiceActorContext {
  return { userId: fixture.userId, audit };
}

function auditSink(): { readonly sink: BillingAuditSink; readonly events: RecordedAudit[] } {
  const events: RecordedAudit[] = [];

  return {
    events,
    sink: {
      record(event, details) {
        events.push({ event, details: { ...(details ?? {}) } as Record<string, unknown> });
      },
    },
  };
}

async function issue(fixture: Fixture, invoiceId: string): Promise<void> {
  await issueInvoice(fixture.tenantId, invoiceId, actor(fixture));
}

async function addPayment(
  fixture: Fixture,
  invoiceId: string,
  amount: string,
  status: "PENDING" | "SUCCESSFUL" | "FAILED" | "REFUNDED" = "SUCCESSFUL",
): Promise<string> {
  const result = await getTestAdminPool().query(
    `insert into invoice_payments
       (tenant_id, invoice_id, amount, currency, payment_status, created_by)
     values ($1, $2, $3, 'USD', $4, $5)
     returning id`,
    [fixture.tenantId, invoiceId, amount, status, fixture.userId],
  );

  const row = result.rows[0] as { id: string } | undefined;
  if (!row) throw new Error("Failed to insert test payment");
  return row.id;
}

async function addRefund(
  fixture: Fixture,
  invoiceId: string,
  amount: string,
  status: "PENDING" | "SUCCESSFUL" | "FAILED",
  paymentId: string | null = null,
): Promise<string> {
  const result = await getTestAdminPool().query(
    `insert into invoice_refunds
       (tenant_id, invoice_id, payment_id, amount, currency, refund_status, created_by)
     values ($1, $2, $3, $4, 'USD', $5, $6)
     returning id`,
    [fixture.tenantId, invoiceId, paymentId, amount, status, fixture.userId],
  );

  const row = result.rows[0] as { id: string } | undefined;
  if (!row) throw new Error("Failed to insert test refund");
  return row.id;
}

async function persistedHeader(
  fixture: Fixture,
  invoiceId: string,
): Promise<{ invoice_status: InvoiceStatus; amount_paid: string; balance_due: string }> {
  const result = await getTestAdminPool().query(
    `select invoice_status, amount_paid, balance_due
       from invoices where tenant_id = $1 and id = $2`,
    [fixture.tenantId, invoiceId],
  );

  const row = result.rows[0] as
    | { invoice_status: InvoiceStatus; amount_paid: string; balance_due: string }
    | undefined;

  if (!row) throw new Error("Invoice not found in fixture");
  return row;
}

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("complete invoice lifecycle", () => {
  it("walks DRAFT -> ISSUED -> PARTIALLY_PAID -> PAID with consistent balances", async () => {
    const fixture = await createFixture("full-lifecycle");
    const { sink, events } = auditSink();
    const staff = actor(fixture, sink);
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    expect(draft.invoiceStatus).toBe("DRAFT");

    const issued = await issueInvoice(fixture.tenantId, draft.id, staff);
    expect(issued.invoice.invoiceStatus).toBe("ISSUED");
    expect(issued.balance.balanceDue).toBe("100.00");

    // Pending and failed attempts leave the invoice untouched.
    await addPayment(fixture, draft.id, "40.00", "PENDING");
    await addPayment(fixture, draft.id, "40.00", "FAILED");
    const stillIssued = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(stillIssued).toMatchObject({ invoiceStatus: "ISSUED", amountPaid: "0.00" });

    await addPayment(fixture, draft.id, "40.00");
    const partial = await recalculateInvoiceBalance(fixture.tenantId, draft.id, staff);
    expect(partial).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "40.00",
      balanceDue: "60.00",
    });

    await addPayment(fixture, draft.id, "60.00");
    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, staff);
    expect(paid).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
      balanceDue: "0.00",
    });

    expect(events.map((event) => event.event)).toEqual([
      "invoice.issued",
      "invoice.balance_recalculated",
      "invoice.balance_recalculated",
    ]);
    expect(events[1]?.details).toMatchObject({ from: "ISSUED", to: "PARTIALLY_PAID" });
    expect(events[2]?.details).toMatchObject({ from: "PARTIALLY_PAID", to: "PAID" });

    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });

  it("pays an ISSUED invoice in one settlement", async () => {
    const fixture = await createFixture("issue-paid");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    await addPayment(fixture, draft.id, "100.00");

    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));
    expect(paid.invoiceStatus).toBe("PAID");
  });

  it("applies a successful refund to a PAID invoice and reaches REFUNDED", async () => {
    const fixture = await createFixture("refund-lifecycle");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    const paymentId = await addPayment(fixture, draft.id, "100.00");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));

    await addRefund(fixture, draft.id, "30.00", "SUCCESSFUL", paymentId);

    const adjusted = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(adjusted).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "70.00",
      refundedAmount: "30.00",
      balanceDue: "30.00",
    });

    await addRefund(fixture, draft.id, "70.00", "SUCCESSFUL", paymentId);

    const refunded = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(refunded).toMatchObject({
      invoiceStatus: "REFUNDED",
      amountPaid: "0.00",
      refundedAmount: "100.00",
      balanceDue: "0.00",
    });
  });
});

describe("central transition enforcement", () => {
  it("publishes a table that makes CANCELLED and REFUNDED terminal", () => {
    expect(INVOICE_TRANSITIONS.CANCELLED).toEqual([]);
    expect(INVOICE_TRANSITIONS.REFUNDED).toEqual([]);
    expect(INVOICE_TRANSITIONS.DRAFT).toEqual(["ISSUED", "CANCELLED"]);
  });

  it("cannot cancel a PAID-status invoice through any path", async () => {
    const fixture = await createFixture("bypass");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);

    // Simulate a corrupted header: PAID without any payment records. The
    // central table must still refuse cancellation (a less-guarded method
    // previously only looked at settled money).
    await getTestAdminPool().query(
      `update invoices
          set invoice_status = 'PAID', amount_paid = '0.00', balance_due = '100.00'
        where tenant_id = $1 and id = $2`,
      [fixture.tenantId, draft.id],
    );

    await expect(
      cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture)),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ from: "PAID", to: "CANCELLED" }),
    });

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "CANCELLED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await persistedHeader(fixture, draft.id)).invoice_status).toBe("PAID");
  });

  it("rejects invalid refund transitions and derived status injection", async () => {
    const fixture = await createFixture("invalid-refund");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "REFUNDED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    await issue(fixture, draft.id);
    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "PAID" as never }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("financial reconciliation", () => {
  it("repairs header drift from payment records and is idempotent", async () => {
    const fixture = await createFixture("reconcile");
    const { sink, events } = auditSink();
    const staff = actor(fixture, sink);
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    await addPayment(fixture, draft.id, "40.00");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, staff);

    // Corrupt the persisted header; records remain the source of truth.
    await getTestAdminPool().query(
      `update invoices
          set amount_paid = '5.00', balance_due = '95.00'
        where tenant_id = $1 and id = $2`,
      [fixture.tenantId, draft.id],
    );

    // A balance read already derives correctly and exposes the drift.
    const read = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(read).toMatchObject({ amountPaid: "40.00", balanceDue: "60.00" });

    const reconciliation = await reconcileInvoiceBalance(fixture.tenantId, draft.id, staff);

    expect(reconciliation).toMatchObject({
      repaired: true,
      persisted: { invoiceStatus: "PARTIALLY_PAID", amountPaid: "5.00", balanceDue: "95.00" },
      expected: { invoiceStatus: "PARTIALLY_PAID", amountPaid: "40.00", balanceDue: "60.00" },
    });
    expect(reconciliation.balance).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "40.00",
      balanceDue: "60.00",
    });
    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "40.00",
      balance_due: "60.00",
    });

    const repeated = await reconcileInvoiceBalance(fixture.tenantId, draft.id, staff);
    expect(repeated.repaired).toBe(false);
    expect(events.filter((event) => event.event === "invoice.reconciled")).toHaveLength(1);
  });

  it("repairs a drifted status when the transition is legal", async () => {
    const fixture = await createFixture("reconcile-status");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    await addPayment(fixture, draft.id, "100.00");

    const reconciliation = await reconcileInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );

    expect(reconciliation.repaired).toBe(true);
    expect(reconciliation.expected.invoiceStatus).toBe("PAID");
    expect((await persistedHeader(fixture, draft.id)).invoice_status).toBe("PAID");
  });

  it("refuses to hide settled money on a terminal invoice", async () => {
    const fixture = await createFixture("reconcile-terminal");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture));
    const before = await persistedHeader(fixture, draft.id);

    await addPayment(fixture, draft.id, "10.00");

    await expect(
      reconcileInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await persistedHeader(fixture, draft.id)).toEqual(before);
  });

  it("rolls back completely when reconciliation would be an illegal transition", async () => {
    const fixture = await createFixture("reconcile-rollback");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);

    // PAID without money is not reachable from the records (expected: ISSUED),
    // and PAID -> ISSUED is not a legal transition. The repair must not write
    // anything at all.
    await getTestAdminPool().query(
      `update invoices
          set invoice_status = 'PAID', amount_paid = '0.00', balance_due = '100.00'
        where tenant_id = $1 and id = $2`,
      [fixture.tenantId, draft.id],
    );

    await expect(
      reconcileInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "PAID",
      amount_paid: "0.00",
      balance_due: "100.00",
    });
  });

  it("fails a recalculation on over-refunded records and leaves the header untouched", async () => {
    const fixture = await createFixture("over-refund");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    const paymentId = await addPayment(fixture, draft.id, "100.00");
    await addRefund(fixture, draft.id, "150.00", "SUCCESSFUL", paymentId);

    await expect(
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });

    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "ISSUED",
      amount_paid: "0.00",
      balance_due: "100.00",
    });
  });

  it("rejects a refund that points at another invoice's payment", async () => {
    const fixture = await createFixture("payment-integrity");
    const first = await createInvoice(fixture.tenantId, newInvoice(fixture));
    const second = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, first.id);
    await issue(fixture, second.id);
    const paymentId = await addPayment(fixture, first.id, "100.00");

    await expect(
      addRefund(fixture, second.id, "10.00", "SUCCESSFUL", paymentId),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps cent precision through payment, refund and reconciliation", async () => {
    const fixture = await createFixture("precision");
    const draft = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        items: [
          {
            itemType: "LABORATORY",
            description: "Reagent",
            quantity: 3,
            unitPrice: "0.10",
            taxRate: "5",
          },
        ],
      }),
    );

    await issue(fixture, draft.id);
    expect(draft.totalAmount).toBe("0.32");

    await addPayment(fixture, draft.id, "0.10");
    await addPayment(fixture, draft.id, "0.11");

    const partial = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(partial).toMatchObject({ amountPaid: "0.21", balanceDue: "0.11" });

    const paymentId = await addPayment(fixture, draft.id, "0.11");
    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));
    expect(paid).toMatchObject({ amountPaid: "0.32", balanceDue: "0.00" });

    await addRefund(fixture, draft.id, "0.02", "SUCCESSFUL", paymentId);

    const refunded = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(refunded).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "0.30",
      refundedAmount: "0.02",
      balanceDue: "0.02",
    });

    // Corrupt and repair at cent scale.
    await getTestAdminPool().query(
      `update invoices set amount_paid = '0.31', balance_due = '0.01'
        where tenant_id = $1 and id = $2`,
      [fixture.tenantId, draft.id],
    );

    const repaired = await reconcileInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(repaired).toMatchObject({
      repaired: true,
      expected: { amountPaid: "0.30", balanceDue: "0.02" },
    });
  });
});

describe("transaction and concurrency safety", () => {
  it("duplicate recalculations are idempotent and audit once", async () => {
    const fixture = await createFixture("duplicate");
    const { sink, events } = auditSink();
    const staff = actor(fixture, sink);
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    await addPayment(fixture, draft.id, "40.00");

    const results = await Promise.all([
      recalculateInvoiceBalance(fixture.tenantId, draft.id, staff),
      recalculateInvoiceBalance(fixture.tenantId, draft.id, staff),
      recalculateInvoiceBalance(fixture.tenantId, draft.id, staff),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        invoiceStatus: "PARTIALLY_PAID",
        amountPaid: "40.00",
        balanceDue: "60.00",
      });
    }

    expect(events.filter((event) => event.event === "invoice.balance_recalculated")).toHaveLength(1);
    expect((await persistedHeader(fixture, draft.id)).amount_paid).toBe("40.00");
  });

  it("serializes a cancellation race with a balance recalculation", async () => {
    const fixture = await createFixture("race");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);

    const results = await Promise.allSettled([
      cancelInvoice(fixture.tenantId, draft.id, { reason: "Race" }, actor(fixture)),
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const header = await persistedHeader(fixture, draft.id);
    expect(header.invoice_status).toBe("CANCELLED");
    expect(header.balance_due).toBe("0.00");

    // Once cancelled, allocations are refused; no late recalculation resurrects
    // the invoice or reopens the balance.
    await expect(
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "CANCELLED",
      amount_paid: "0.00",
      balance_due: "0.00",
    });
  });

  it("rolls back a failed cancellation without touching the header", async () => {
    const fixture = await createFixture("rollback-cancel");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issue(fixture, draft.id);
    await addPayment(fixture, draft.id, "40.00");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));

    await expect(
      cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await persistedHeader(fixture, draft.id)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "40.00",
      balance_due: "60.00",
    });
  });

  it("keeps the lifecycle consistent across a multi-invoice tenant", async () => {
    const fixture = await createFixture("multi");
    const first = await createInvoice(fixture.tenantId, newInvoice(fixture));
    const second = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        items: [
          {
            itemType: "PHARMACY",
            description: "Medication",
            quantity: 2,
            unitPrice: "12.34",
          },
        ],
      }),
    );

    await issue(fixture, first.id);
    await issue(fixture, second.id);
    await addPayment(fixture, first.id, "100.00");
    await recalculateInvoiceBalance(fixture.tenantId, first.id, actor(fixture));

    const [firstBalance, secondBalance] = await Promise.all([
      getInvoiceBalance(fixture.tenantId, first.id),
      getInvoiceBalance(fixture.tenantId, second.id),
    ]);

    expect(firstBalance).toMatchObject({ invoiceStatus: "PAID", amountPaid: "100.00" });
    expect(secondBalance).toMatchObject({
      invoiceStatus: "ISSUED",
      totalAmount: "24.68",
      amountPaid: "0.00",
      balanceDue: "24.68",
    });
  });
});

describe("tenant isolation and RLS", () => {
  it("cannot reach another tenant's invoice or money through any method", async () => {
    const owner = await createFixture("tenant-owner");
    const outsider = await createFixture("tenant-outsider");
    const draft = await createInvoice(owner.tenantId, newInvoice(owner));

    await issue(owner, draft.id);
    await addPayment(owner, draft.id, "25.00");

    await expect(
      getInvoiceBalance(outsider.tenantId, draft.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      recalculateInvoiceBalance(outsider.tenantId, draft.id, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      reconcileInvoiceBalance(outsider.tenantId, draft.id, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The owner's data is unchanged and still correct.
    expect(await getInvoiceBalance(owner.tenantId, draft.id)).toMatchObject({
      amountPaid: "25.00",
      balanceDue: "75.00",
    });
  });

  it("enforces RLS for the restricted application role", async () => {
    const owner = await createFixture("rls-owner");
    const outsider = await createFixture("rls-outsider");
    const draft = await createInvoice(owner.tenantId, newInvoice(owner));

    await issue(owner, draft.id);
    await addPayment(owner, draft.id, "25.00");

    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      const unscoped = await client.query("select count(*)::int as count from invoices");
      expect(unscoped.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        outsider.tenantId,
      ]);
      const outsiderInvoices = await client.query(
        "select count(*)::int as count from invoices",
      );
      expect(outsiderInvoices.rows[0]).toEqual({ count: 0 });

      const outsiderPayments = await client.query(
        "select count(*)::int as count from invoice_payments",
      );
      expect(outsiderPayments.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        owner.tenantId,
      ]);
      const ownerInvoices = await client.query(
        "select count(*)::int as count from invoices where id = $1",
        [draft.id],
      );
      expect(ownerInvoices.rows[0]).toEqual({ count: 1 });

      const ownerPayments = await client.query(
        "select count(*)::int as count from invoice_payments where invoice_id = $1",
        [draft.id],
      );
      expect(ownerPayments.rows[0]).toEqual({ count: 1 });
    } finally {
      await client.end();
    }
  });

  it("does not expose amounts or patient data in audit events", async () => {
    const fixture = await createFixture("audit-privacy");
    const { sink, events } = auditSink();
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture, sink));
    await addPayment(fixture, draft.id, "25.00");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture, sink));

    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(event.details).not.toHaveProperty("amountPaid");
      expect(event.details).not.toHaveProperty("balanceDue");
      expect(event.details).not.toHaveProperty("patientId");
      expect(event.details).not.toHaveProperty("totalAmount");
      expect(event.details).not.toHaveProperty("reason");
    }
  });
});
