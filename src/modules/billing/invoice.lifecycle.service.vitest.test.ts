import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import type { BillingAuditEvent, BillingAuditSink } from "./billing.audit.js";
import {
  cancelInvoice,
  getInvoiceBalance,
  issueInvoice,
  recalculateInvoiceBalance,
  updateInvoiceStatus,
} from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import type {
  CreateInvoiceInput,
  InvoiceActorContext,
  InvoiceStatus,
} from "./invoice.types.js";

/**
 * Service-level tests for Task 19.3.1 (invoice status and balance management).
 *
 * Fixtures and payment/refund rows are written with the admin connection; the
 * lifecycle service runs as the restricted `hospitalos_app` role inside a
 * tenant-scoped transaction, so RLS is exercised on every call. Payment and
 * refund recording is out of scope for this task, so the tests seed those rows
 * directly to represent what the future payment service will write.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly patientId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

function daysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
     values ($1, $2, $3, 'invoice-lifecycle-test-hash')`,
    [userId, "Billing Clerk", `lifecycle-${suffix}@invoices.test`],
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

interface RecordedAudit {
  readonly event: BillingAuditEvent;
  readonly details: Record<string, unknown>;
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

async function addPayment(
  fixture: Fixture,
  invoiceId: string,
  amount: string,
  status: "PENDING" | "SUCCESSFUL" | "FAILED" | "REFUNDED",
): Promise<string> {
  const [row] = await getTestAdminPool()
    .query(
      `insert into invoice_payments
         (tenant_id, invoice_id, amount, currency, payment_status, created_by)
       values ($1, $2, $3, 'USD', $4, $5)
       returning id`,
      [fixture.tenantId, invoiceId, amount, status, fixture.userId],
    )
    .then((result) => result.rows as { id: string }[]);

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
  const [row] = await getTestAdminPool()
    .query(
      `insert into invoice_refunds
         (tenant_id, invoice_id, payment_id, amount, currency, refund_status, created_by)
       values ($1, $2, $3, $4, 'USD', $5, $6)
       returning id`,
      [fixture.tenantId, invoiceId, paymentId, amount, status, fixture.userId],
    )
    .then((result) => result.rows as { id: string }[]);

  if (!row) throw new Error("Failed to insert test refund");
  return row.id;
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

describe("issuing draft invoices", () => {
  it("issues a validated draft, keeps the total as the balance and audits once", async () => {
    const fixture = await createFixture("issue");
    const { sink, events } = auditSink();
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    expect(draft.invoiceStatus).toBe("DRAFT");

    const issued = await issueInvoice(fixture.tenantId, draft.id, actor(fixture, sink));

    expect(issued.applied).toBe(true);
    expect(issued.invoice.invoiceStatus).toBe("ISSUED");
    expect(issued.balance).toMatchObject({
      invoiceStatus: "ISSUED",
      subtotal: "100.00",
      discountTotal: "0.00",
      taxTotal: "0.00",
      totalAmount: "100.00",
      amountPaid: "0.00",
      refundedAmount: "0.00",
      balanceDue: "100.00",
    });

    expect(events.map((event) => event.event)).toEqual(["invoice.issued"]);

    // Idempotent repeat: same state, no second audit event.
    const repeated = await issueInvoice(fixture.tenantId, draft.id, actor(fixture, sink));
    expect(repeated.applied).toBe(false);
    expect(events).toHaveLength(1);

    // The persisted header agrees with the reported balance.
    const stored = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(stored).toMatchObject({ invoiceStatus: "ISSUED", balanceDue: "100.00" });
  });

  it("refuses to issue an invoice without line items", async () => {
    const fixture = await createFixture("empty");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await getTestAdminPool().query("delete from invoice_items where invoice_id = $1", [draft.id]);

    await expect(
      issueInvoice(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422, code: "UNPROCESSABLE_ENTITY" });
  });
});

describe("invalid status transitions", () => {
  it("rejects issuing non-draft invoices and setting payment-derived statuses", async () => {
    const fixture = await createFixture("transitions");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture));

    await expect(
      issueInvoice(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      updateInvoiceStatus(
        fixture.tenantId,
        draft.id,
        { status: "PAID" as never },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      updateInvoiceStatus(
        fixture.tenantId,
        draft.id,
        { status: "PARTIALLY_PAID" as never },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Unknown statuses are validation errors, not a silent no-op.
    await expect(
      updateInvoiceStatus(
        fixture.tenantId,
        draft.id,
        { status: "ARCHIVED" as never },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
  });

  it("rejects marking an invoice overdue before its due date", async () => {
    const fixture = await createFixture("overdue-guard");
    const draft = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, { dueDate: daysFromToday(7) }),
    );

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "OVERDUE" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });

    const noDueDate = await createInvoice(fixture.tenantId, newInvoice(fixture));
    await issueInvoice(fixture.tenantId, noDueDate.id, actor(fixture));

    await expect(
      updateInvoiceStatus(fixture.tenantId, noDueDate.id, { status: "OVERDUE" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("derives OVERDUE from a past due date and refuses it from partially paid", async () => {
    const fixture = await createFixture("overdue");
    const draft = await createInvoice(
      fixture.tenantId,
      newInvoice(fixture, {
        issueDate: daysFromToday(-30),
        dueDate: daysFromToday(-5),
      }),
    );

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));

    const balance = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );

    expect(balance).toMatchObject({ invoiceStatus: "OVERDUE", balanceDue: "100.00" });

    // The status queue agrees with the derived status.
    const stored = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(stored.invoiceStatus).toBe("OVERDUE");

    await addPayment(fixture, draft.id, "25.00", "SUCCESSFUL");
    const partial = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));
    expect(partial.invoiceStatus).toBe("PARTIALLY_PAID");

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "OVERDUE" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("payment-driven balances", () => {
  it("counts only successful payments and moves DRAFT -> ISSUED -> PARTIALLY_PAID -> PAID", async () => {
    const fixture = await createFixture("payments");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));

    await addPayment(fixture, draft.id, "30.00", "PENDING");
    await addPayment(fixture, draft.id, "20.00", "FAILED");

    const untouched = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(untouched).toMatchObject({ amountPaid: "0.00", balanceDue: "100.00" });

    await addPayment(fixture, draft.id, "40.00", "SUCCESSFUL");

    const partial = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );

    expect(partial).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      totalAmount: "100.00",
      amountPaid: "40.00",
      refundedAmount: "0.00",
      balanceDue: "60.00",
    });

    await addPayment(fixture, draft.id, "60.00", "SUCCESSFUL");

    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));

    expect(paid).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
      balanceDue: "0.00",
    });

    const stored = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(stored).toMatchObject({ invoiceStatus: "PAID", amountPaid: "100.00" });
  });

  it("never reports a negative balance when the invoice is overpaid", async () => {
    const fixture = await createFixture("overpaid");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));
    await addPayment(fixture, draft.id, "150.00", "SUCCESSFUL");

    const balance = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );

    expect(balance).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "150.00",
      balanceDue: "0.00",
    });
  });

  it("keeps cent-level decimal precision", async () => {
    const fixture = await createFixture("decimals");
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

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));

    expect(draft.totalAmount).toBe("0.32");

    await addPayment(fixture, draft.id, "0.10", "SUCCESSFUL");
    await addPayment(fixture, draft.id, "0.11", "SUCCESSFUL");

    const partial = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );
    expect(partial).toMatchObject({
      amountPaid: "0.21",
      balanceDue: "0.11",
      invoiceStatus: "PARTIALLY_PAID",
    });

    await addPayment(fixture, draft.id, "0.11", "SUCCESSFUL");

    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));
    expect(paid).toMatchObject({ amountPaid: "0.32", balanceDue: "0.00", invoiceStatus: "PAID" });
  });
});

describe("refund-driven balances", () => {
  it("subtracts only successful refunds and closes a fully refunded invoice", async () => {
    const fixture = await createFixture("refunds");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));
    const paymentId = await addPayment(fixture, draft.id, "100.00", "SUCCESSFUL");
    const paid = await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));
    expect(paid.invoiceStatus).toBe("PAID");

    // Pending and failed refunds move no money.
    await addRefund(fixture, draft.id, "10.00", "PENDING", paymentId);
    await addRefund(fixture, draft.id, "10.00", "FAILED", paymentId);

    const unchanged = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(unchanged).toMatchObject({ amountPaid: "100.00", refundedAmount: "0.00" });

    await addRefund(fixture, draft.id, "40.00", "SUCCESSFUL", paymentId);

    const partial = await recalculateInvoiceBalance(
      fixture.tenantId,
      draft.id,
      actor(fixture),
    );

    expect(partial).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "60.00",
      refundedAmount: "40.00",
      balanceDue: "40.00",
    });

    await addRefund(fixture, draft.id, "60.00", "SUCCESSFUL", paymentId);

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

    const stored = await getInvoiceBalance(fixture.tenantId, draft.id);
    expect(stored).toMatchObject({
      invoiceStatus: "REFUNDED",
      amountPaid: "0.00",
      refundedAmount: "100.00",
      balanceDue: "0.00",
    });
  });

  it("refuses REFUNDED without successful refund records", async () => {
    const fixture = await createFixture("refund-guard");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));
    await addPayment(fixture, draft.id, "100.00", "SUCCESSFUL");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "REFUNDED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });

    // A pending refund is still not a real refund.
    await addRefund(fixture, draft.id, "100.00", "PENDING");

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "REFUNDED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });

    // A partial refund does not fully close the invoice.
    await addRefund(fixture, draft.id, "40.00", "SUCCESSFUL");

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "REFUNDED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("cancelled invoice restrictions", () => {
  it("cancels a draft, closes the balance and blocks later allocations", async () => {
    const fixture = await createFixture("cancel");
    const { sink, events } = auditSink();
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    const cancelled = await cancelInvoice(
      fixture.tenantId,
      draft.id,
      { reason: "Raised twice" },
      actor(fixture, sink),
    );

    expect(cancelled.applied).toBe(true);
    expect(cancelled.invoice.invoiceStatus).toBe("CANCELLED");
    expect(cancelled.balance).toMatchObject({
      invoiceStatus: "CANCELLED",
      totalAmount: "100.00",
      amountPaid: "0.00",
      balanceDue: "0.00",
    });
    expect(events).toEqual([
      expect.objectContaining({
        event: "invoice.cancelled",
        details: expect.objectContaining({ reason: "Raised twice", to: "CANCELLED" }),
      }),
    ]);

    // A cancelled invoice refuses payment allocations even if a row exists.
    await addPayment(fixture, draft.id, "10.00", "SUCCESSFUL");

    await expect(
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Repeating the cancellation is harmless and writes no second event.
    const repeated = await cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture, sink));
    expect(repeated.applied).toBe(false);
    expect(repeated.balance.balanceDue).toBe("0.00");
    expect((await getInvoiceBalance(fixture.tenantId, draft.id)).balanceDue).toBe("0.00");
    expect(events).toHaveLength(1);
  });

  it("refuses to cancel an invoice with settled money", async () => {
    const fixture = await createFixture("cancel-paid");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));
    await addPayment(fixture, draft.id, "40.00", "SUCCESSFUL");
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture));

    await expect(
      cancelInvoice(fixture.tenantId, draft.id, {}, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      updateInvoiceStatus(fixture.tenantId, draft.id, { status: "CANCELLED" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("concurrency", () => {
  it("serializes concurrent balance recalculations without double counting", async () => {
    const fixture = await createFixture("concurrent");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture));
    await addPayment(fixture, draft.id, "30.00", "SUCCESSFUL");
    await addPayment(fixture, draft.id, "20.00", "SUCCESSFUL");

    const results = await Promise.all([
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
      recalculateInvoiceBalance(fixture.tenantId, draft.id, actor(fixture)),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        invoiceStatus: "PARTIALLY_PAID",
        amountPaid: "50.00",
        balanceDue: "50.00",
      });
    }

    const [stored] = (
      await getTestAdminPool().query(
        `select invoice_status, amount_paid, balance_due
           from invoices where tenant_id = $1 and id = $2`,
        [fixture.tenantId, draft.id],
      )
    ).rows as { invoice_status: InvoiceStatus; amount_paid: string; balance_due: string }[];

    expect(stored).toMatchObject({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "50.00",
      balance_due: "50.00",
    });
  });
});

describe("cross-tenant access", () => {
  it("cannot read or change another tenant's invoice", async () => {
    const owner = await createFixture("owner");
    const outsider = await createFixture("outsider");
    const draft = await createInvoice(owner.tenantId, newInvoice(owner));

    await expect(
      issueInvoice(outsider.tenantId, draft.id, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getInvoiceBalance(outsider.tenantId, draft.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      recalculateInvoiceBalance(outsider.tenantId, draft.id, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      cancelInvoice(outsider.tenantId, draft.id, {}, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The owner's invoice is untouched.
    expect((await getInvoiceBalance(owner.tenantId, draft.id)).invoiceStatus).toBe("DRAFT");
  });

  it("ignores another tenant's payments when deriving the balance", async () => {
    const owner = await createFixture("rls-owner");
    const outsider = await createFixture("rls-outsider");
    const draft = await createInvoice(owner.tenantId, newInvoice(owner));

    await issueInvoice(owner.tenantId, draft.id, actor(owner));

    // A payment row can never be planted across tenants: the composite key
    // rejects it before any service read is involved.
    await expect(
      getTestAdminPool().query(
        `insert into invoice_payments
           (tenant_id, invoice_id, amount, currency, payment_status)
         values ($1, $2, '75.00', 'USD', 'SUCCESSFUL')`,
        [outsider.tenantId, draft.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const balance = await getInvoiceBalance(owner.tenantId, draft.id);
    expect(balance).toMatchObject({ amountPaid: "0.00", balanceDue: "100.00" });
  });
});

describe("audit trail", () => {
  it("records a balance recalculation only when the status actually changes", async () => {
    const fixture = await createFixture("audit");
    const { sink, events } = auditSink();
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    await issueInvoice(fixture.tenantId, draft.id, actor(fixture, sink));
    expect(events.map((event) => event.event)).toEqual(["invoice.issued"]);

    await addPayment(fixture, draft.id, "100.00", "SUCCESSFUL");

    const staff = actor(fixture, sink);
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, staff);
    await recalculateInvoiceBalance(fixture.tenantId, draft.id, staff);

    // First recalculation PAID, the repeat changes nothing.
    expect(events.map((event) => event.event)).toEqual([
      "invoice.issued",
      "invoice.balance_recalculated",
    ]);
    expect(events[1]?.details).toMatchObject({
      invoiceId: draft.id,
      from: "ISSUED",
      to: "PAID",
    });
    // Audit never carries amounts or patient data.
    expect(events[1]?.details).not.toHaveProperty("amountPaid");
    expect(events[1]?.details).not.toHaveProperty("patientId");
  });

  it("survives a failing audit sink", async () => {
    const fixture = await createFixture("audit-failure");
    const draft = await createInvoice(fixture.tenantId, newInvoice(fixture));

    const failingSink: BillingAuditSink = {
      record() {
        throw new Error("sink down");
      },
    };

    const issued = await issueInvoice(fixture.tenantId, draft.id, actor(fixture, failingSink));
    expect(issued.invoice.invoiceStatus).toBe("ISSUED");
    expect(issued.invoice.invoiceNumber).toMatch(/^INV-/);
  });
});
