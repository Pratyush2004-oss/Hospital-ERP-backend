import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import type { BillingAuditEvent, BillingAuditSink } from "./billing.audit.js";
import { addMoney } from "./invoice-calculation.js";
import {
  cancelInvoice,
  getInvoiceBalance,
  issueInvoice,
} from "./invoice.lifecycle.service.js";
import { createInvoice } from "./invoice.service.js";
import {
  getPaymentById,
  listPayments,
  recordPayment,
} from "./payment.service.js";
import type {
  PaymentActorContext,
  RecordPaymentInput,
} from "./payment.types.js";

/**
 * Service-level tests for Task 19.4.1 (payment recording and allocation).
 *
 * Fixtures are written with the admin connection; the payment service runs as
 * the restricted `hospitalos_app` role inside tenant-scoped transactions, so
 * RLS is exercised on every call. Every fixture tenant is deleted afterwards,
 * which cascades its invoices, payments and allocations.
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
    [userId, "Cashier", `payments-${suffix}@billing.test`],
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

function actor(fixture: Fixture, audit?: BillingAuditSink): PaymentActorContext {
  return { userId: fixture.userId, audit };
}

async function issuedInvoice(
  fixture: Fixture,
  unitPrice = "100.00",
  patientId: string = fixture.patientId,
): Promise<string> {
  const draft = await createInvoice(fixture.tenantId, {
    branchId: fixture.branchId,
    patientId,
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

async function countPayments(tenantId: string): Promise<number> {
  const result = await getTestAdminPool().query(
    "select count(*)::int as count from payments where tenant_id = $1",
    [tenantId],
  );

  return (result.rows[0] as { count: number }).count;
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

describe("recording offline payments", () => {
  it("records a full cash payment, settles the invoice and audits it", async () => {
    const fixture = await createFixture("payfull");
    const invoiceId = await issuedInvoice(fixture);
    const { sink, events } = auditSink();

    const result = await recordPayment(
      fixture.tenantId,
      paymentInput(
        fixture,
        [{ invoiceId, amount: "100.00" }],
        { method: "CASH", reference: `RCPT-${randomUUID().slice(0, 8)}` },
      ),
      actor(fixture, sink),
    );

    expect(result.replayed).toBe(false);
    expect(result.payment).toMatchObject({
      branchId: fixture.branchId,
      patientId: fixture.patientId,
      paymentMethod: "CASH",
      amount: "100.00",
      currency: "USD",
      paymentStatus: "SUCCESSFUL",
      receivedBy: fixture.userId,
    });
    expect(result.payment.allocations).toHaveLength(1);
    expect(result.payment.allocations[0]).toMatchObject({ invoiceId, amount: "100.00" });
    expect(result.invoiceBalances[0]).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
      balanceDue: "0.00",
    });

    // Persisted header, not just the in-memory result.
    const stored = await getInvoiceBalance(fixture.tenantId, invoiceId);
    expect(stored).toMatchObject({ invoiceStatus: "PAID", balanceDue: "0.00" });

    const detail = await getPaymentById(fixture.tenantId, result.payment.id);
    expect(detail).toEqual(result.payment);

    const list = await listPayments(fixture.tenantId, {
      patientId: fixture.patientId,
      method: "CASH",
    });
    expect(list.total).toBe(1);
    expect(list.payments[0]?.id).toBe(result.payment.id);

    expect(events.map((event) => event.event)).toContain("payment.recorded");
    expect(events.map((event) => event.event)).toContain("invoice.balance_recalculated");
    const recorded = events.find((event) => event.event === "payment.recorded");
    expect(recorded?.details).toMatchObject({
      paymentId: result.payment.id,
      invoiceIds: [invoiceId],
    });
  });

  it("supports partial payments and completes the invoice later", async () => {
    const fixture = await createFixture("partial");
    const invoiceId = await issuedInvoice(fixture);

    const first = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "40.00" }]),
      actor(fixture),
    );

    expect(first.invoiceBalances[0]).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      amountPaid: "40.00",
      balanceDue: "60.00",
    });

    const second = await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "60.00" }], { method: "UPI" }),
      actor(fixture),
    );

    expect(second.invoiceBalances[0]).toMatchObject({
      invoiceStatus: "PAID",
      amountPaid: "100.00",
      balanceDue: "0.00",
    });

    expect(await countPayments(fixture.tenantId)).toBe(2);
  });

  it("splits one payment across several invoices", async () => {
    const fixture = await createFixture("split");
    const firstInvoice = await issuedInvoice(fixture, "100.00");
    const secondInvoice = await issuedInvoice(fixture, "100.00");

    const result = await recordPayment(
      fixture.tenantId,
      paymentInput(
        fixture,
        [
          { invoiceId: firstInvoice, amount: "70.00" },
          { invoiceId: secondInvoice, amount: "80.00" },
        ],
        { amount: "150.00", method: "CARD" },
      ),
      actor(fixture),
    );

    expect(result.payment.amount).toBe("150.00");
    expect(result.payment.allocations).toHaveLength(2);

    const balances = new Map(
      result.invoiceBalances.map((balance) => [balance.invoiceId, balance]),
    );
    expect(balances.get(firstInvoice)).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      balanceDue: "30.00",
    });
    expect(balances.get(secondInvoice)).toMatchObject({
      invoiceStatus: "PARTIALLY_PAID",
      balanceDue: "20.00",
    });
  });

  it("rejects invalid amounts before writing anything", async () => {
    const fixture = await createFixture("invalid");
    const invoiceId = await issuedInvoice(fixture);

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "10.00" }], { amount: "0.00" }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "10.00" }], { amount: "9.00" }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: expect.objectContaining({ reason: "ALLOCATION_TOTAL_MISMATCH" }),
    });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "0.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(
          fixture,
          [
            { invoiceId, amount: "5.00" },
            { invoiceId, amount: "5.00" },
          ],
          { amount: "10.00" },
        ),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "10.001" }], { amount: "10.00" }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await countPayments(fixture.tenantId)).toBe(0);
  });

  it("prevents over-allocation, including above a remaining balance", async () => {
    const fixture = await createFixture("over");
    const invoiceId = await issuedInvoice(fixture, "100.00");

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "120.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: expect.objectContaining({ reason: "ALLOCATION_EXCEEDS_BALANCE" }),
    });

    expect(await countPayments(fixture.tenantId)).toBe(0);
    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      amountPaid: "0.00",
      balanceDue: "100.00",
    });

    await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId, amount: "90.00" }]),
      actor(fixture),
    );

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "20.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await countPayments(fixture.tenantId)).toBe(1);
  });

  it("refuses draft and cancelled invoices", async () => {
    const fixture = await createFixture("state");
    const draft = await createInvoice(fixture.tenantId, {
      branchId: fixture.branchId,
      patientId: fixture.patientId,
      createdBy: fixture.userId,
      items: [
        { itemType: "CONSULTATION", description: "Consultation", quantity: 1, unitPrice: "50.00" },
      ],
    });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId: draft.id, amount: "50.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const cancelledId = await issuedInvoice(fixture, "50.00");
    await cancelInvoice(fixture.tenantId, cancelledId, {}, { userId: fixture.userId });

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId: cancelledId, amount: "50.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await countPayments(fixture.tenantId)).toBe(0);
  });

  it("rejects an invoice that belongs to another patient", async () => {
    const fixture = await createFixture("patientmatch");
    const invoiceId = await issuedInvoice(fixture, "100.00", fixture.otherPatientId);

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId, amount: "100.00" }]),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await countPayments(fixture.tenantId)).toBe(0);
  });
});

describe("idempotent recording", () => {
  it("replays the original payment for a repeated key and rejects a changed request", async () => {
    const fixture = await createFixture("idem");
    const invoiceId = await issuedInvoice(fixture);
    const key = `idem-${randomUUID()}`;
    const input = paymentInput(fixture, [{ invoiceId, amount: "100.00" }], {
      idempotencyKey: key,
      reference: `RCPT-${randomUUID().slice(0, 8)}`,
    });

    const first = await recordPayment(fixture.tenantId, input, actor(fixture));
    const second = await recordPayment(fixture.tenantId, input, actor(fixture));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.invoiceBalances[0]).toMatchObject({ invoiceStatus: "PAID" });
    expect(await countPayments(fixture.tenantId)).toBe(1);

    await expect(
      recordPayment(
        fixture.tenantId,
        { ...input, amount: "50.00", allocations: [{ invoiceId, amount: "50.00" }] },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await countPayments(fixture.tenantId)).toBe(1);
  });

  it("replays under concurrent duplicate requests", async () => {
    const fixture = await createFixture("idemrace");
    const invoiceId = await issuedInvoice(fixture, "200.00");
    const input = paymentInput(fixture, [{ invoiceId, amount: "200.00" }], {
      idempotencyKey: `race-${randomUUID()}`,
    });

    const results = await Promise.all([
      recordPayment(fixture.tenantId, input, actor(fixture)),
      recordPayment(fixture.tenantId, input, actor(fixture)),
    ]);

    const [first, second] = results;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.payment.id).toBe(second?.payment.id);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await countPayments(fixture.tenantId)).toBe(1);
    expect(await getInvoiceBalance(fixture.tenantId, invoiceId)).toMatchObject({
      invoiceStatus: "PAID",
      balanceDue: "0.00",
    });
  });
});

describe("atomicity and isolation", () => {
  it("rolls back the whole payment when a later allocation fails", async () => {
    const fixture = await createFixture("rollback");
    const firstInvoice = await issuedInvoice(fixture, "100.00");
    const secondInvoice = await issuedInvoice(fixture, "100.00");

    // Leave only 10.00 outstanding on the second invoice.
    await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId: secondInvoice, amount: "90.00" }]),
      actor(fixture),
    );

    const reference = `ROLLBACK-${randomUUID().slice(0, 8)}`;

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(
          fixture,
          [
            { invoiceId: firstInvoice, amount: "100.00" },
            { invoiceId: secondInvoice, amount: "50.00" },
          ],
          { amount: "150.00", reference },
        ),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Neither the receipt nor the first invoice's settlement row survived.
    expect(await countPayments(fixture.tenantId)).toBe(1);
    expect(await getInvoiceBalance(fixture.tenantId, firstInvoice)).toMatchObject({
      invoiceStatus: "ISSUED",
      amountPaid: "0.00",
      balanceDue: "100.00",
    });

    const orphan = await getTestAdminPool().query(
      `select count(*)::int as count
         from invoice_payments ip
         join invoices i on i.id = ip.invoice_id and i.tenant_id = ip.tenant_id
        where ip.tenant_id = $1 and i.id = $2`,
      [fixture.tenantId, firstInvoice],
    );
    expect((orphan.rows[0] as { count: number }).count).toBe(0);
  });

  it("enforces tenant isolation for recording, retrieval and listing", async () => {
    const alpha = await createFixture("alpha");
    const beta = await createFixture("beta");
    const betaInvoice = await issuedInvoice(beta);

    await expect(
      recordPayment(
        alpha.tenantId,
        paymentInput(alpha, [{ invoiceId: betaInvoice, amount: "100.00" }]),
        actor(alpha),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      recordPayment(
        alpha.tenantId,
        paymentInput(alpha, [{ invoiceId: betaInvoice, amount: "100.00" }], {
          patientId: beta.patientId,
          branchId: beta.branchId,
        }),
        actor(alpha),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const betaPayment = await recordPayment(
      beta.tenantId,
      paymentInput(beta, [{ invoiceId: betaInvoice, amount: "100.00" }]),
      actor(beta),
    );

    await expect(getPaymentById(alpha.tenantId, betaPayment.payment.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    const alphaList = await listPayments(alpha.tenantId);
    expect(alphaList.total).toBe(0);

    const betaList = await listPayments(beta.tenantId);
    expect(betaList.total).toBe(1);
    expect(betaList.payments[0]?.id).toBe(betaPayment.payment.id);

    await expect(getInvoiceBalance(alpha.tenantId, betaInvoice)).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(await countPayments(alpha.tenantId)).toBe(0);
  });

  it("keeps receipt references unique per tenant", async () => {
    const fixture = await createFixture("reference");
    const firstInvoice = await issuedInvoice(fixture);
    const secondInvoice = await issuedInvoice(fixture);
    const reference = `RCPT-${randomUUID().slice(0, 8)}`;

    await recordPayment(
      fixture.tenantId,
      paymentInput(fixture, [{ invoiceId: firstInvoice, amount: "100.00" }], { reference }),
      actor(fixture),
    );

    await expect(
      recordPayment(
        fixture.tenantId,
        paymentInput(fixture, [{ invoiceId: secondInvoice, amount: "100.00" }], { reference }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await countPayments(fixture.tenantId)).toBe(1);
  });
});
