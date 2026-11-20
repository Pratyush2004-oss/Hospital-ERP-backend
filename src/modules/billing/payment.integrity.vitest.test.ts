import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import type { BillingAuditEvent, BillingAuditSink } from "./billing.audit.js";
import { addMoney } from "./invoice-calculation.js";
import { getInvoiceBalance, issueInvoice } from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import {
  getPaymentById,
  reconcilePayment,
  recordPayment,
} from "./payment.service.js";
import type { PaymentActorContext, RecordPaymentInput } from "./payment.types.js";

/**
 * Phase 19.4.2 integrity tests for payment recording.
 *
 * Fixtures are written through the admin connection; the service under test
 * always runs as the restricted `hospitalos_app` role inside a tenant-scoped
 * transaction, so every assertion also exercises RLS. Raw SQL that deliberately
 * corrupts or bypasses the service uses the admin pool and only ever touches
 * fixture rows. Tenants are deleted afterwards, cascading invoices, payments,
 * allocations and settlements.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly patientId: string;
  readonly otherPatientId: string;
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
  const otherPatientId = randomUUID();

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
     values ($1, $2, $3, 'payment-test-hash')`,
    [userId, "Cashier", `integrity-${suffix}@billing.test`],
  );
  createdUserIds.push(userId);

  for (const [id, name, code] of [
    [patientId, "Ada Patient", `P-${suffix}`],
    [otherPatientId, "Grace Patient", `Q-${suffix}`],
  ] as const) {
    await pool.query(
      `insert into patient_profiles (id, tenant_id, patient_code, full_name)
       values ($1, $2, $3, $4)`,
      [id, tenantId, code, name],
    );
  }

  const fixture = { tenantId, branchId, userId, patientId, otherPatientId };
  fixtures.push(fixture);
  return fixture;
}

async function createBranch(fixture: Fixture, code: string): Promise<string> {
  const branchId = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, $3, $4, 'UTC')`,
    [branchId, fixture.tenantId, code, `${code}-${suffix}`.slice(0, 20)],
  );

  return branchId;
}

function actor(fixture: Fixture, audit?: BillingAuditSink): PaymentActorContext {
  return { userId: fixture.userId, audit };
}

async function issuedInvoice(
  fixture: Fixture,
  unitPrice = "100.00",
  overrides: { patientId?: string; branchId?: string } = {},
): Promise<string> {
  const draft = await createInvoice(fixture.tenantId, {
    branchId: overrides.branchId ?? fixture.branchId,
    patientId: overrides.patientId ?? fixture.patientId,
    createdBy: fixture.userId,
    items: [
      {
        itemType: "CONSULTATION",
        description: "Consultation",
        quantity: 1,
        unitPrice,
      },
    ],
  });

  await issueInvoice(fixture.tenantId, draft.id, { userId: fixture.userId });

  return draft.id;
}

function paymentInput(
  fixture: Fixture,
  allocations: readonly { invoiceId: string; amount: string }[],
  overrides: Partial<RecordPaymentInput> = {},
): RecordPaymentInput {
  const amount =
    overrides.amount !== undefined
      ? overrides.amount
      : addMoney(allocations.map((allocation) => allocation.amount));

  return {
    branchId: fixture.branchId,
    patientId: fixture.patientId,
    method: "CASH",
    amount,
    allocations,
    ...overrides,
  };
}

async function countByReference(tenantId: string, reference: string): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from payments where tenant_id = $1 and reference = $2",
    [tenantId, reference],
  );

  return (result.rows[0] as { count: number }).count;
}

interface LedgerCounts {
  readonly allocations: number;
  readonly settlements: number;
}

async function ledgerCounts(paymentId: string): Promise<LedgerCounts> {
  const result = await getTestAdminPool().query(
    `select
       (select count(*)::int from payment_allocations where payment_id = $1) as allocations,
       (select count(*)::int from invoice_payments where payment_id = $1) as settlements`,
    [paymentId],
  );

  return result.rows[0] as LedgerCounts;
}

interface InvoiceRow {
  readonly invoice_status: string;
  readonly amount_paid: string;
  readonly balance_due: string;
}

async function invoiceRow(invoiceId: string): Promise<InvoiceRow> {
  const result = await getTestAdminPool().query(
    "select invoice_status, amount_paid, balance_due from invoices where id = $1",
    [invoiceId],
  );

  return result.rows[0] as InvoiceRow;
}

/** Asserts the promise rejects with a PostgreSQL error of the given SQLSTATE. */
async function expectPostgresError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }

  throw new Error(`expected PostgreSQL error ${code}, but the statement succeeded`);
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

describe("payment allocation under concurrency", () => {
  it("lets only one of two racing payments take the last balance", async () => {
    const fixture = await createFixture("race-last");
    const invoiceId = await issuedInvoice(fixture, "100.00");

    const attempts = await Promise.allSettled([
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
          reference: `RACE-A-${randomUUID().slice(0, 8)}`,
        }),
        actor(fixture),
      ),
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
          reference: `RACE-B-${randomUUID().slice(0, 8)}`,
        }),
        actor(fixture),
      ),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ statusCode: 422 });

    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });

    const payments = await getTestAdminPool().query(
      "select count(*)::int as count from payments where tenant_id = $1",
      [fixture.tenantId],
    );
    expect(payments.rows[0]).toEqual({ count: 1 });

    // The losing transaction left nothing behind: no allocation and no
    // settlement row for it.
    const ledger = await getTestAdminPool().query(
      `select
         (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
         (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
      [fixture.tenantId],
    );
    expect(ledger.rows[0]).toEqual({ allocations: 1, settlements: 1 });
  });

  it("serializes many concurrent partial payments without over-allocating", async () => {
    const fixture = await createFixture("race-partial");
    const invoiceId = await issuedInvoice(fixture, "100.00");

    // 8 x 12.50 = 100.00 exactly; each runs in its own transaction and locks
    // the invoice row, so they must queue rather than read a stale balance.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordPayment(
          fixture.tenantId,
          paymentInput(fixture, [{ invoiceId, amount: "12.50" }], {
            reference: `PART-${index}-${randomUUID().slice(0, 8)}`,
          }),
          actor(fixture),
        ),
      ),
    );

    expect(results).toHaveLength(8);
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });

    const totals = await getTestAdminPool().query(
      `select
         (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
         (select count(*)::int from invoice_payments where tenant_id = $1) as settlements,
         (select coalesce(sum(amount), 0)::text from payment_allocations where tenant_id = $1) as allocated`,
      [fixture.tenantId],
    );
    expect(totals.rows[0]).toEqual({
      allocations: 8,
      settlements: 8,
      allocated: "100.00",
    });
  });

  it("keeps concurrent multi-invoice payments deadlock-free and consistent", async () => {
    const fixture = await createFixture("race-split");
    const invoiceA = await issuedInvoice(fixture, "100.00");
    const invoiceB = await issuedInvoice(fixture, "100.00");

    // Every payment touches both invoices, in opposite caller order, so the
    // service's deterministic lock ordering is what prevents a deadlock.
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        recordPayment(
          fixture.tenantId,
          paymentInput(
            fixture,
            [
              { invoiceId: index % 2 === 0 ? invoiceA : invoiceB, amount: "30.00" },
              { invoiceId: index % 2 === 0 ? invoiceB : invoiceA, amount: "30.00" },
            ],
            { reference: `SPLIT-${index}-${randomUUID().slice(0, 8)}` },
          ),
          actor(fixture),
        ),
      ),
    );

    expect(results).toHaveLength(3);
    expect(await invoiceRow(invoiceA)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "90.00",
      balance_due: "10.00",
    });
    expect(await invoiceRow(invoiceB)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "90.00",
      balance_due: "10.00",
    });

    for (const result of results) {
      const reconciliation = await reconcilePayment(
        fixture.tenantId,
        result.payment.id,
        actor(fixture),
      );
      expect(reconciliation.issues).toEqual([]);
      expect(reconciliation.consistent).toBe(true);
      expect(reconciliation.allocatedTotal).toBe("60.00");
      expect(reconciliation.settledTotal).toBe("60.00");
    }
  });

  it("returns the same consistency report from concurrent reconciliations", async () => {
    const fixture = await createFixture("race-reconcile");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "40.00" }], {
        reference: `REC-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    const reports = await Promise.all(
      Array.from({ length: 4 }, () =>
        reconcilePayment(fixture.tenantId, payment.payment.id, actor(fixture)),
      ),
    );

    for (const report of reports) {
      expect(report.consistent).toBe(true);
      expect(report.repairedInvoices).toBe(0);
      expect(report.invoiceBalances[0]).toMatchObject({
        amountPaid: "40.00",
        balanceDue: "60.00",
      });
    }

    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "40.00",
      balance_due: "60.00",
    });
  });
});

describe("duplicate prevention", () => {
  it("does not duplicate allocations or settlements when a request is replayed", async () => {
    const fixture = await createFixture("dup-replay");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const key = `idem-${randomUUID()}`;
    const input = paymentInput(fixture, [{ invoiceId, amount: "60.00" }], {
      idempotencyKey: key,
      reference: `IDEM-${randomUUID().slice(0, 8)}`,
    });

    const first = await recordPayment(fixture.tenantId, input, actor(fixture));
    const second = await recordPayment(fixture.tenantId, input, actor(fixture));

    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(await ledgerCounts(first.payment.id)).toEqual({
      allocations: 1,
      settlements: 1,
    });
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "60.00",
      balance_due: "40.00",
    });
  });

  it("rejects a duplicate allocation row even when it bypasses the service", async () => {
    const fixture = await createFixture("dup-allocation");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "50.00" }], {
        reference: `DUP-A-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await expectPostgresError(
      () =>
        getTestAdminPool().query(
          `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount)
           values ($1, $2, $3, '10.00')`,
          [fixture.tenantId, payment.payment.id, invoiceId],
        ),
      "23505",
    );

    expect(await ledgerCounts(payment.payment.id)).toEqual({
      allocations: 1,
      settlements: 1,
    });
  });

  it("rejects a duplicate settlement row for the same payment and invoice", async () => {
    const fixture = await createFixture("dup-settlement");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "50.00" }], {
        reference: `DUP-S-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await expectPostgresError(
      () =>
        getTestAdminPool().query(
          `insert into invoice_payments
             (tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at)
           values ($1, $2, $3, '50.00', 'USD', 'SUCCESSFUL', now())`,
          [fixture.tenantId, invoiceId, payment.payment.id],
        ),
      "23505",
    );

    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "50.00",
      balance_due: "50.00",
    });
  });
});

describe("lifecycle and financial record protection", () => {
  it("refuses to turn a payment-linked settlement into a non-successful state", async () => {
    const fixture = await createFixture("state-settlement");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
        reference: `STATE-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await expectPostgresError(
      () =>
        getTestAdminPool().query(
          "update invoice_payments set payment_status = 'FAILED' where payment_id = $1",
          [payment.payment.id],
        ),
      "23514",
    );

    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
      balanceDue: "0.00",
    });
  });

  it("counts only successful settlements towards the invoice balance", async () => {
    const fixture = await createFixture("state-eligible");
    const invoiceId = await issuedInvoice(fixture, "100.00");

    // A pending gateway attempt and a failed one are not money.
    const pool = getTestAdminPool();
    for (const status of ["PENDING", "FAILED"] as const) {
      await pool.query(
        `insert into invoice_payments
           (tenant_id, invoice_id, amount, currency, payment_status, reference)
         values ($1, $2, '40.00', 'USD', $3, $4)`,
        [fixture.tenantId, invoiceId, status, `GW-${status}-${randomUUID().slice(0, 8)}`],
      );
    }

    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      invoiceStatus: "ISSUED",
      amountPaid: "0.00",
      balanceDue: "100.00",
    });

    await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "30.00" }], {
        reference: `GOOD-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "30.00",
      balanceDue: "70.00",
    });
  });

  it("blocks deleting a receipt that still has financial history", async () => {
    const fixture = await createFixture("delete-payment");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
        reference: `KEEP-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await expectPostgresError(
      () =>
        getTestAdminPool().query("delete from payments where id = $1", [
          payment.payment.id,
        ]),
      "23503",
    );

    expect(await getPaymentById(fixture.tenantId, payment.payment.id)).toMatchObject({
      id: payment.payment.id,
    });
    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
    });
  });
});

describe("transaction rollback", () => {
  it("restores both invoices when a multi-invoice payment fails on one of them", async () => {
    const fixture = await createFixture("rollback");
    const invoiceA = await issuedInvoice(fixture, "100.00");
    const invoiceB = await issuedInvoice(fixture, "100.00");

    await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId: invoiceB, amount: "90.00" }], {
        reference: `PRE-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    const reference = `ROLL-${randomUUID().slice(0, 8)}`;

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(
          fixture,
          [
            { invoiceId: invoiceA, amount: "100.00" },
            { invoiceId: invoiceB, amount: "20.00" },
          ],
          { reference },
        ),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // No payment, allocation or settlement survives from the failed request.
    expect(await countByReference(fixture.tenantId, reference)).toBe(0);

    const orphanLedger = await getTestAdminPool().query(
      `select
         (select count(*)::int from payment_allocations where tenant_id = $1) as allocations,
         (select count(*)::int from invoice_payments where tenant_id = $1) as settlements`,
      [fixture.tenantId],
    );
    expect(orphanLedger.rows[0]).toEqual({ allocations: 1, settlements: 1 });

    expect(await invoiceRow(invoiceA)).toEqual({
      invoice_status: "ISSUED",
      amount_paid: "0.00",
      balance_due: "100.00",
    });
    expect(await invoiceRow(invoiceB)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "90.00",
      balance_due: "10.00",
    });
  });

  it("does not consume a reference or idempotency key on a failed attempt", async () => {
    const fixture = await createFixture("rollback-retry");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const reference = `RETRY-${randomUUID().slice(0, 8)}`;
    const key = `retry-${randomUUID()}`;

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "200.00" }], {
          reference,
          idempotencyKey: key,
        }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await countByReference(fixture.tenantId, reference)).toBe(0);

    // The rolled-back request released both unique keys, so a corrected retry
    // is not mistaken for a duplicate.
    const retried = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
        reference,
        idempotencyKey: key,
      }),
      actor(fixture),
    );

    expect(retried.replayed).toBe(false);
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PAID",
      amount_paid: "100.00",
      balance_due: "0.00",
    });
  });
});

describe("payment reconciliation", () => {
  it("reports a consistent receipt and audits the outcome", async () => {
    const fixture = await createFixture("recon-ok");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const { sink, events } = auditSink();
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `OK-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture, sink),
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture, sink),
    );

    expect(report).toMatchObject({
      paymentId: payment.payment.id,
      amount: "70.00",
      allocatedTotal: "70.00",
      settledTotal: "70.00",
      consistent: true,
      issues: [],
      repairedInvoices: 0,
    });
    expect(report.invoiceBalances[0]).toMatchObject({
      invoiceId,
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "70.00",
      balanceDue: "30.00",
    });

    const reconciled = events.filter((entry) => entry.event === "payment.reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.details).toMatchObject({
      consistent: true,
      issueCodes: [],
      invoiceIds: [invoiceId],
    });

    for (const entry of events) {
      expect(entry.details).not.toHaveProperty("amountPaid");
      expect(entry.details).not.toHaveProperty("balanceDue");
      expect(entry.details).not.toHaveProperty("totalAmount");
      expect(entry.details).not.toHaveProperty("reason");
      expect(entry.details).not.toHaveProperty("amount");
    }
  });

  it("repairs invoice header drift from the settlement ledger", async () => {
    const fixture = await createFixture("recon-drift");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `DRIFT-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      "update invoices set amount_paid = '10.00', balance_due = '20.00' where id = $1",
      [invoiceId],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(true);
    expect(report.repairedInvoices).toBe(1);
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "70.00",
      balance_due: "30.00",
    });

    // Reconciliation is idempotent: a second call repairs nothing.
    const again = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );
    expect(again.repairedInvoices).toBe(0);
    expect(again.consistent).toBe(true);
  });

  it("flags an allocation whose settlement row is missing", async () => {
    const fixture = await createFixture("recon-missing");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `MISS-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      "delete from invoice_payments where payment_id = $1",
      [payment.payment.id],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("MISSING_SETTLEMENT");

    // PARTIALLY_PAID has no transition back to ISSUED, so the header is not
    // rolled back: the report says the invoice cannot be reconciled rather
    // than inventing a state that the ledger never produced.
    expect(report.repairedInvoices).toBe(0);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "INVOICE_RECONCILIATION_FAILED",
    );
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "70.00",
      balance_due: "30.00",
    });
  });

  it("flags a settlement amount that disagrees with its allocation", async () => {
    const fixture = await createFixture("recon-amount");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `AMT-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      "update invoice_payments set amount = '60.00' where payment_id = $1",
      [payment.payment.id],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "SETTLEMENT_AMOUNT_MISMATCH",
    );
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "60.00",
      balance_due: "40.00",
    });
  });

  it("flags a settlement that points at an invoice the payment did not allocate", async () => {
    const fixture = await createFixture("recon-orphan");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const otherInvoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `ORPH-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      `insert into invoice_payments
         (tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at)
       values ($1, $2, $3, '10.00', 'USD', 'SUCCESSFUL', now())`,
      [fixture.tenantId, otherInvoiceId, payment.payment.id],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("ORPHAN_SETTLEMENT");
    expect(report.settledTotal).toBe("80.00");
    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "PARTIALLY_PAID",
      amount_paid: "70.00",
      balance_due: "30.00",
    });
  });

  it("flags a receipt that is no longer in a settling state", async () => {
    const fixture = await createFixture("recon-status");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `STAT-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      "update payments set payment_status = 'PENDING' where id = $1",
      [payment.payment.id],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(false);
    expect(report.paymentStatus).toBe("PENDING");
    expect(report.issues.map((issue) => issue.code)).toContain(
      "INELIGIBLE_PAYMENT_STATUS",
    );
  });

  it("reports an invoice that cannot be reconciled instead of inventing history", async () => {
    const fixture = await createFixture("recon-terminal");
    const invoiceId = await issuedInvoice(fixture, "100.00");
    const payment = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "70.00" }], {
        reference: `TERM-${randomUUID().slice(0, 8)}`,
      }),
      actor(fixture),
    );

    await getTestAdminPool().query(
      "update invoices set invoice_status = 'CANCELLED' where id = $1",
      [invoiceId],
    );

    const report = await reconcilePayment(
      fixture.tenantId,
      payment.payment.id,
      actor(fixture),
    );

    expect(report.consistent).toBe(false);
    const failure = report.issues.find(
      (issue) => issue.code === "INVOICE_RECONCILIATION_FAILED",
    );
    expect(failure).toMatchObject({ invoiceId, statusCode: 409 });
    expect(report.invoiceBalances).toEqual([]);
  });
});

describe("tenant, branch and patient boundaries", () => {
  it("refuses an invoice from another branch of the same hospital", async () => {
    const fixture = await createFixture("branch-guard");
    const otherBranch = await createBranch(fixture, "NORTH");
    const invoiceId = await issuedInvoice(fixture, "100.00", {
      branchId: otherBranch,
    });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
          reference: `BR-${randomUUID().slice(0, 8)}`,
        }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await invoiceRow(invoiceId)).toEqual({
      invoice_status: "ISSUED",
      amount_paid: "0.00",
      balance_due: "100.00",
    });
  });

  it("reports a legacy cross-branch payment as inconsistent", async () => {
    const fixture = await createFixture("branch-report");
    const otherBranch = await createBranch(fixture, "SOUTH");
    const invoiceId = await issuedInvoice(fixture, "100.00", {
      branchId: otherBranch,
    });

    // Simulate a receipt written before the branch rule existed: the payment
    // and its allocation are in the fixture branch, the invoice is not.
    const paymentId = randomUUID();
    const pool = getTestAdminPool();
    await pool.query(
      `insert into payments
         (id, tenant_id, branch_id, patient_id, payment_method, amount, currency,
          payment_status, reference, received_at, received_by)
       values ($1, $2, $3, $4, 'CASH', '50.00', 'USD', 'SUCCESSFUL', $5, now(), $6)`,
      [
        paymentId,
        fixture.tenantId,
        fixture.branchId,
        fixture.patientId,
        `LEGACY-${randomUUID().slice(0, 8)}`,
        fixture.userId,
      ],
    );
    await pool.query(
      `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount)
       values ($1, $2, $3, '50.00')`,
      [fixture.tenantId, paymentId, invoiceId],
    );
    await pool.query(
      `insert into invoice_payments
         (tenant_id, invoice_id, payment_id, amount, currency, payment_status, paid_at)
       values ($1, $2, $3, '50.00', 'USD', 'SUCCESSFUL', now())`,
      [fixture.tenantId, invoiceId, paymentId],
    );

    const report = await reconcilePayment(fixture.tenantId, paymentId, actor(fixture));

    expect(report.consistent).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("BRANCH_MISMATCH");
  });

  it("hides another hospital's receipts and refuses to reconcile them", async () => {
    const owner = await createFixture("iso-owner");
    const outsider = await createFixture("iso-outsider");
    const invoiceId = await issuedInvoice(owner, "100.00");
    const payment = await recordPayment(
      owner.tenantId,
      paymentInput(owner, [{ invoiceId, amount: "100.00" }], {
        reference: `ISO-${randomUUID().slice(0, 8)}`,
      }),
      actor(owner),
    );

    await expect(
      getPaymentById(outsider.tenantId, payment.payment.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      reconcilePayment(outsider.tenantId, payment.payment.id, actor(outsider)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // An outsider cannot allocate to the owner's invoice either.
    await expect(
      recordPayment(
        outsider.tenantId,
        paymentInput(outsider, [{ invoiceId, amount: "100.00" }], {
          reference: `ISO-ATTACK-${randomUUID().slice(0, 8)}`,
        }),
        actor(outsider),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("enforces RLS for payments, allocations and settlements on the restricted role", async () => {
    const owner = await createFixture("rls-owner");
    const outsider = await createFixture("rls-outsider");
    const invoiceId = await issuedInvoice(owner, "100.00");
    const payment = await recordPayment(
      owner.tenantId,
      paymentInput(owner, [{ invoiceId, amount: "100.00" }], {
        reference: `RLS-${randomUUID().slice(0, 8)}`,
      }),
      actor(owner),
    );

    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();

    try {
      for (const table of ["payments", "payment_allocations", "invoice_payments"]) {
        const unscoped = await client.query(
          `select count(*)::int as count from ${table}`,
        );
        expect(unscoped.rows[0], `${table} without tenant context`).toEqual({ count: 0 });
      }

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        outsider.tenantId,
      ]);

      for (const table of ["payments", "payment_allocations", "invoice_payments"]) {
        const foreign = await client.query(`select count(*)::int as count from ${table}`);
        expect(foreign.rows[0], `${table} for another tenant`).toEqual({ count: 0 });
      }

      // Even knowing the id, the outsider cannot read the owner's receipt.
      const guessing = await client.query(
        "select count(*)::int as count from payments where id = $1",
        [payment.payment.id],
      );
      expect(guessing.rows[0]).toEqual({ count: 0 });

      await client.query("select set_config('app.current_tenant_id', $1, false)", [
        owner.tenantId,
      ]);

      const owned = await client.query(
        `select
           (select count(*)::int from payments where id = $1) as payments,
           (select count(*)::int from payment_allocations where payment_id = $1) as allocations,
           (select count(*)::int from invoice_payments where payment_id = $1) as settlements`,
        [payment.payment.id],
      );
      expect(owned.rows[0]).toEqual({
        payments: 1,
        allocations: 1,
        settlements: 1,
      });
    } finally {
      await client.end();
    }
  });
});
