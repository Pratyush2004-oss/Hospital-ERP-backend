import { and, eq } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
  type DbExecutor,
} from "../../database/context.js";
import {
  invoiceItems,
  invoicePayments,
  invoiceRefunds,
  invoices,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { recordInvoiceAudit } from "./billing.audit.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { enqueueBillingNotificationIntegrated } from "./notifications/billing-notification.bridge.js";
import { calculateInvoiceBalance } from "./invoice-calculation.js";
import type {
  CalculatedInvoiceBalance,
  InvoicePaymentInput,
  InvoiceRefundInput,
} from "./invoice-calculation.types.js";
import { loadInvoice, mapInvoiceWriteError } from "./invoice.service.js";
import type {
  CancelInvoiceInput,
  InvoiceActorContext,
  InvoiceBalanceDto,
  InvoiceDto,
  InvoiceLifecycleResult,
  InvoiceReconciliationResult,
  InvoiceStatus,
  ManualInvoiceStatus,
  UpdateInvoiceStatusInput,
} from "./invoice.types.js";

/**
 * Invoice status and balance management (Tasks 19.3.1 and 19.3.2).
 *
 * Only paid, staff-issued statuses are set explicitly; payment-driven statuses
 * are derived. `INVOICE_TRANSITIONS` below is the single transition authority
 * consulted by every mutating path, including reconciliation, so a status
 * cannot be reached through a less-guarded method.
 *
 * Status is derived from money, not from the caller:
 *
 *   DRAFT        -> ISSUED (validated) | CANCELLED
 *   ISSUED       -> OVERDUE (past due) | CANCELLED | PARTIALLY_PAID | PAID
 *   OVERDUE      -> CANCELLED | PARTIALLY_PAID | PAID
 *   PARTIALLY_PAID -> PAID (balance reaches zero)
 *   PAID         -> PARTIALLY_PAID (partial refund) | REFUNDED (all held money returned)
 *   CANCELLED / REFUNDED are terminal.
 *
 * - `issueInvoice` and `cancelInvoice` are explicit staff actions.
 * - `updateInvoiceStatus` only accepts ISSUED, OVERDUE, CANCELLED and REFUNDED.
 *   PARTIALLY_PAID and PAID are payment-derived and rejected (422), so a client
 *   can never mark an unpaid invoice as paid.
 * - `recalculateInvoiceBalance` is the single write path for payment-derived
 *   state. The future payment/refund task calls it after recording a
 *   transaction; this task records no money itself.
 * - `reconcileInvoiceBalance` repairs header drift from the payment/refund
 *   ledger under the same transition table; it is idempotent and writes
 *   nothing when the header already matches.
 *
 * Balance rules:
 * - `amount_paid` is net held money: SUCCESSFUL payments minus SUCCESSFUL
 *   refunds. PENDING/FAILED payments and refunds change nothing.
 * - `balance_due` is `total_amount - amount_paid`, never negative.
 * - Refunds may never exceed collected money (`calculateInvoiceBalance`).
 * - CANCELLED and REFUNDED close the balance (`balance_due = 0.00`) so no
 *   further allocation is possible; the full financial history stays on the
 *   header and in the payment/refund rows.
 *
 * Concurrency: every write locks the invoice row with `SELECT ... FOR UPDATE`
 * inside the tenant transaction, so two concurrent recalculations (or a
 * cancellation racing a payment) serialize instead of writing a balance from a
 * stale read. Money arithmetic is done by `calculateInvoiceBalance` (BigInt),
 * never with JavaScript floats.
 *
 * The lock is also the contract for the future payment/refund writer: it must
 * lock the invoice row before inserting a payment or refund, so a concurrent
 * recalculation cannot read money that is about to change. This task only
 * reads those tables.
 */

const MANUAL_STATUSES: ReadonlySet<string> = new Set<ManualInvoiceStatus>([
  "ISSUED",
  "OVERDUE",
  "CANCELLED",
  "REFUNDED",
]);

const DERIVED_STATUSES: ReadonlySet<string> = new Set<InvoiceStatus>([
  "PARTIALLY_PAID",
  "PAID",
]);

/**
 * Single authority for invoice status transitions (Task 19.3.2).
 *
 * Every mutating path - explicit staff actions, payment-derived recalculation
 * and reconciliation repair - consults this table, so a status can never be
 * reached through a less-guarded method. Terminal states have no exits.
 */
export const INVOICE_TRANSITIONS: Readonly<
  Record<InvoiceStatus, readonly InvoiceStatus[]>
> = {
  DRAFT: ["ISSUED", "CANCELLED"],
  ISSUED: ["OVERDUE", "CANCELLED", "PARTIALLY_PAID", "PAID", "REFUNDED"],
  OVERDUE: ["CANCELLED", "PARTIALLY_PAID", "PAID", "REFUNDED"],
  PARTIALLY_PAID: ["PAID", "REFUNDED"],
  PAID: ["PARTIALLY_PAID", "REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

/**
 * Throws `409` when `from -> to` is not in the central table. Repeating the
 * current status is a no-op handled by the caller before this check.
 */
function assertInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  action: string,
): void {
  const allowed = INVOICE_TRANSITIONS[from];

  if (!allowed.includes(to)) {
    throw AppError.conflict(
      `Invoice cannot ${action} from ${from} to ${to}`,
      { from, to, allowedTransitions: allowed },
    );
  }
}

interface LockedInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly currency: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
}

interface SettledMoney {
  readonly payments: readonly InvoicePaymentInput[];
  readonly refunds: readonly InvoiceRefundInput[];
}

function invalid(field: string, message: string): AppError {
  return AppError.validation(message, { field });
}

function assertActor(actor: InvoiceActorContext): InvoiceActorContext {
  if (actor === null || typeof actor !== "object" || typeof actor.userId !== "string") {
    throw AppError.unauthorized("An authenticated user is required for invoice changes");
  }

  return actor;
}

function assertInvoiceId(invoiceId: string): string {
  if (typeof invoiceId !== "string" || invoiceId.trim().length === 0) {
    throw invalid("invoiceId", "Invoice id is required");
  }

  return invoiceId;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const reason = value.trim();

  return reason.length === 0 ? null : reason;
}

function invoiceHeaderQuery(tx: DbExecutor, tenantId: string, invoiceId: string) {
  return tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceStatus: invoices.invoiceStatus,
      currency: invoices.currency,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      subtotal: invoices.subtotal,
      discountTotal: invoices.discountTotal,
      taxTotal: invoices.taxTotal,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1);
}

/**
 * Reads and locks the invoice row for the rest of the transaction. The lock is
 * what keeps concurrent status/balance writes from computing on stale money.
 */
async function lockInvoice(
  tx: DbExecutor,
  tenantId: string,
  invoiceId: string,
): Promise<LockedInvoice> {
  const [row] = await invoiceHeaderQuery(tx, tenantId, invoiceId).for("update");

  if (!row) throw AppError.notFound("Invoice not found");

  return row;
}

async function readSettledMoney(
  tx: DbExecutor,
  tenantId: string,
  invoiceId: string,
): Promise<SettledMoney> {
  const [paymentRows, refundRows] = await Promise.all([
    tx
      .select({
        id: invoicePayments.id,
        amount: invoicePayments.amount,
        currency: invoicePayments.currency,
        status: invoicePayments.paymentStatus,
      })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.tenantId, tenantId),
          eq(invoicePayments.invoiceId, invoiceId),
        ),
      ),
    tx
      .select({
        id: invoiceRefunds.id,
        amount: invoiceRefunds.amount,
        currency: invoiceRefunds.currency,
        status: invoiceRefunds.refundStatus,
      })
      .from(invoiceRefunds)
      .where(
        and(
          eq(invoiceRefunds.tenantId, tenantId),
          eq(invoiceRefunds.invoiceId, invoiceId),
        ),
      ),
  ]);

  return {
    payments: paymentRows.map((row) => ({
      paymentId: row.id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
    })),
    refunds: refundRows.map((row) => ({
      refundId: row.id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
    })),
  };
}

function calculateBalance(
  invoice: LockedInvoice,
  money: SettledMoney,
): CalculatedInvoiceBalance {
  return calculateInvoiceBalance({
    totalAmount: invoice.totalAmount,
    currency: invoice.currency,
    payments: money.payments,
    refunds: money.refunds,
  });
}

function toBalanceDto(
  invoice: LockedInvoice,
  balance: CalculatedInvoiceBalance,
): InvoiceBalanceDto {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceStatus: invoice.invoiceStatus,
    currency: balance.currency,
    subtotal: invoice.subtotal,
    discountTotal: invoice.discountTotal,
    taxTotal: invoice.taxTotal,
    totalAmount: balance.totalAmount,
    amountPaid: balance.amountPaid,
    refundedAmount: balance.refundedAmount,
    // Terminal invoices owe nothing by policy; report what is persisted.
    balanceDue: closedBalance(invoice.invoiceStatus, balance.balanceDue),
  };
}

/**
 * Status implied by the settled money and due date. CANCELLED and REFUNDED are
 * terminal and never recomputed. PARTIALLY_PAID deliberately wins over OVERDUE:
 * a partly paid, past-due invoice stays in the payment queue the money belongs
 * to instead of the collections queue.
 */
function deriveStatus(
  invoice: LockedInvoice,
  balance: CalculatedInvoiceBalance,
  today: string,
): InvoiceStatus {
  if (invoice.invoiceStatus === "CANCELLED" || invoice.invoiceStatus === "REFUNDED") {
    return invoice.invoiceStatus;
  }

  if (balance.refundedAmount !== "0.00" && balance.amountPaid === "0.00") {
    return "REFUNDED";
  }

  if (balance.balanceDue === "0.00") return "PAID";

  if (balance.amountPaid !== "0.00") return "PARTIALLY_PAID";

  if (invoice.dueDate !== null && invoice.dueDate < today) return "OVERDUE";

  return "ISSUED";
}

/** Terminal statuses close the balance so no further money can be allocated. */
function closedBalance(status: InvoiceStatus, balanceDue: string): string {
  return status === "CANCELLED" || status === "REFUNDED" ? "0.00" : balanceDue;
}

/**
 * Two writes in one transaction: the status/amounts row update and its audit
 * event. Returns the freshly loaded header so callers never see in-memory
 * values that differ from what was committed.
 */
async function persistState(
  tx: DatabaseTransaction,
  tenantId: string,
  invoice: LockedInvoice,
  nextStatus: InvoiceStatus,
  balance: CalculatedInvoiceBalance,
): Promise<{ invoice: InvoiceDto; balance: InvoiceBalanceDto }> {
  const balanceDue = closedBalance(nextStatus, balance.balanceDue);

  const [updated] = await tx
    .update(invoices)
    .set({
      invoiceStatus: nextStatus,
      amountPaid: balance.amountPaid,
      balanceDue,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, tenantId)))
    .returning({ id: invoices.id, updatedAt: invoices.updatedAt });

  if (!updated) throw AppError.internal("Failed to update the invoice");

  const dto = await loadInvoice(tx, tenantId, invoice.id);

  return {
    invoice: dto,
    balance: toBalanceDto(
      { ...invoice, invoiceStatus: nextStatus, amountPaid: balance.amountPaid, balanceDue },
      { ...balance, balanceDue },
    ),
  };
}

async function currentState(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
): Promise<{ invoice: InvoiceDto; balance: InvoiceBalanceDto }> {
  const [row] = await invoiceHeaderQuery(tx, tenantId, invoiceId);

  if (!row) throw AppError.notFound("Invoice not found");

  const money = await readSettledMoney(tx, tenantId, invoiceId);
  const balance = calculateBalance(row, money);

  return {
    invoice: await loadInvoice(tx, tenantId, invoiceId),
    balance: toBalanceDto(row, balance),
  };
}

/**
 * DRAFT -> ISSUED after validation.
 *
 * Validation is intentionally narrow: the invoice must still be a draft and
 * must have at least one line item. Totals are not re-derived from the request
 * because there is no request money - they were computed and persisted by
 * `createInvoice`, and the database reconciliation constraint proves the header
 * still adds up.
 */
export async function issueInvoice(
  tenantId: string,
  invoiceId: string,
  actor: InvoiceActorContext,
): Promise<InvoiceLifecycleResult> {
  try {
    const staff = assertActor(actor);
    const id = assertInvoiceId(invoiceId);

    return await withTenantTransaction(tenantId, async (tx) => {
      const invoice = await lockInvoice(tx, tenantId, id);

      if (invoice.invoiceStatus === "ISSUED") {
        return { ...(await currentState(tx, tenantId, id)), applied: false };
      }

      assertInvoiceTransition(invoice.invoiceStatus, "ISSUED", "be issued");

      const [line] = await tx
        .select({ id: invoiceItems.id })
        .from(invoiceItems)
        .where(and(eq(invoiceItems.tenantId, tenantId), eq(invoiceItems.invoiceId, id)))
        .limit(1);

      if (!line) {
        throw AppError.unprocessable(
          "An invoice needs at least one line item before it can be issued",
        );
      }

      const money = await readSettledMoney(tx, tenantId, id);
      const balance = calculateBalance(invoice, money);

      // A draft cannot have settled money; if it does, the records are already
      // inconsistent and issuing must not paper over it.
      if (balance.amountPaid !== "0.00" || balance.refundedAmount !== "0.00") {
        throw AppError.conflict(
          "The invoice already has payment or refund records and cannot be issued as a draft",
        );
      }

      const state = await persistState(tx, tenantId, invoice, "ISSUED", balance);

      recordInvoiceAudit(staff.audit, "invoice.issued", {
        tenantId,
        actorUserId: staff.userId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        from: invoice.invoiceStatus,
        to: "ISSUED",
      });

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: staff.userId,
        action: AUDIT_ACTIONS.INVOICE_ISSUED,
        module: "billing",
        resourceType: "invoice",
        resourceId: invoice.id,
        description: "Invoice issued",
        previousState: { status: invoice.invoiceStatus },
        newState: { status: "ISSUED" },
        metadata: { invoiceNumber: invoice.invoiceNumber },
      });

      // Phase 20.2: billing outbox + central in-app, savepoint protected.
      await enqueueBillingNotificationIntegrated(tx, tenantId, {
        event: "INVOICE_ISSUED",
        invoiceId: invoice.id,
        dedupeKey: `invoice-issued:${invoice.id}`,
      });

      return { ...state, applied: true };
    });
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

/**
 * Cancels a draft or unpaid invoice. Invoices with settled money are refused:
 * refund the payments first, then cancel, so the money trail stays honest.
 * Cancelled invoices keep their total and history but owe nothing.
 */
export async function cancelInvoice(
  tenantId: string,
  invoiceId: string,
  input: CancelInvoiceInput,
  actor: InvoiceActorContext,
): Promise<InvoiceLifecycleResult> {
  try {
    const staff = assertActor(actor);
    const id = assertInvoiceId(invoiceId);
    const reason = normalizeReason(input?.reason);

    return await withTenantTransaction(tenantId, async (tx) => {
      const invoice = await lockInvoice(tx, tenantId, id);

      if (invoice.invoiceStatus === "CANCELLED") {
        return { ...(await currentState(tx, tenantId, id)), applied: false };
      }

      assertInvoiceTransition(invoice.invoiceStatus, "CANCELLED", "be cancelled");

      const money = await readSettledMoney(tx, tenantId, id);
      const balance = calculateBalance(invoice, money);

      if (balance.amountPaid !== "0.00" || balance.refundedAmount !== "0.00") {
        throw AppError.conflict(
          "The invoice has payments or refunds recorded; refund them before cancelling",
        );
      }

      const state = await persistState(tx, tenantId, invoice, "CANCELLED", balance);

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: staff.userId,
        action: AUDIT_ACTIONS.INVOICE_CANCELLED,
        module: "billing",
        resourceType: "invoice",
        resourceId: invoice.id,
        description: "Invoice cancelled",
        previousState: { status: invoice.invoiceStatus },
        newState: { status: "CANCELLED" },
        metadata: { invoiceNumber: invoice.invoiceNumber },
      });

      recordInvoiceAudit(staff.audit, "invoice.cancelled", {
        tenantId,
        actorUserId: staff.userId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        from: invoice.invoiceStatus,
        to: "CANCELLED",
        reason,
      });

      return { ...state, applied: true };
    });
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

async function transitionOverdue(
  tx: DatabaseTransaction,
  tenantId: string,
  invoice: LockedInvoice,
  actor: InvoiceActorContext,
  today: string,
): Promise<InvoiceLifecycleResult> {
  if (invoice.invoiceStatus === "OVERDUE") {
    return { ...(await currentState(tx, tenantId, invoice.id)), applied: false };
  }

  assertInvoiceTransition(invoice.invoiceStatus, "OVERDUE", "become overdue");

  if (invoice.dueDate === null) {
    throw AppError.unprocessable("The invoice has no due date and cannot become overdue");
  }

  if (invoice.dueDate >= today) {
    throw AppError.unprocessable("The invoice is not past its due date");
  }

  const money = await readSettledMoney(tx, tenantId, invoice.id);
  const balance = calculateBalance(invoice, money);

  if (balance.balanceDue === "0.00") {
    throw AppError.conflict("A fully paid invoice cannot be marked overdue");
  }

  const state = await persistState(tx, tenantId, invoice, "OVERDUE", balance);

  recordInvoiceAudit(actor.audit, "invoice.status_changed", {
    tenantId,
    actorUserId: actor.userId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    from: invoice.invoiceStatus,
    to: "OVERDUE",
  });

  await recordAuditSafely(tx, {
    tenantId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.INVOICE_STATUS_CHANGED,
    module: "billing",
    resourceType: "invoice",
    resourceId: invoice.id,
    description: "Invoice marked overdue",
    previousState: { status: invoice.invoiceStatus },
    newState: { status: "OVERDUE" },
    metadata: { invoiceNumber: invoice.invoiceNumber },
  });

  await enqueueBillingNotificationIntegrated(tx, tenantId, {
    event: "INVOICE_OVERDUE",
    invoiceId: invoice.id,
    dedupeKey: `invoice-overdue:${invoice.id}`,
  });

  return { ...state, applied: true };
}

/**
 * Marks an invoice REFUNDED. This is only possible when successful refund
 * records exist and all collected money has been returned; a bare status flag
 * without refund transactions is rejected.
 */
async function transitionRefunded(
  tx: DatabaseTransaction,
  tenantId: string,
  invoice: LockedInvoice,
  actor: InvoiceActorContext,
  reason: string | null,
): Promise<InvoiceLifecycleResult> {
  if (invoice.invoiceStatus === "REFUNDED") {
    return { ...(await currentState(tx, tenantId, invoice.id)), applied: false };
  }

  assertInvoiceTransition(invoice.invoiceStatus, "REFUNDED", "be refunded");

  const money = await readSettledMoney(tx, tenantId, invoice.id);
  const balance = calculateBalance(invoice, money);

  if (balance.refundedAmount === "0.00") {
    throw AppError.unprocessable(
      "REFUNDED requires at least one successful refund recorded against the invoice",
    );
  }

  if (balance.amountPaid !== "0.00") {
    throw AppError.unprocessable(
      "Only an invoice whose collected money has been fully refunded can be marked REFUNDED",
    );
  }

  const state = await persistState(tx, tenantId, invoice, "REFUNDED", balance);

  recordInvoiceAudit(actor.audit, "invoice.status_changed", {
    tenantId,
    actorUserId: actor.userId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    from: invoice.invoiceStatus,
    to: "REFUNDED",
    reason,
  });

  await recordAuditSafely(tx, {
    tenantId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.INVOICE_STATUS_CHANGED,
    module: "billing",
    resourceType: "invoice",
    resourceId: invoice.id,
    description: "Invoice marked refunded",
    previousState: { status: invoice.invoiceStatus },
    newState: { status: "REFUNDED" },
    metadata: { invoiceNumber: invoice.invoiceNumber },
  });

  return { ...state, applied: true };
}

/**
 * Explicit status change entry point.
 *
 * ISSUED and CANCELLED delegate to the dedicated methods. OVERDUE and REFUNDED
 * have their own guards. PARTIALLY_PAID and PAID are rejected because they are
 * derived from successful payments through `recalculateInvoiceBalance`.
 */
export async function updateInvoiceStatus(
  tenantId: string,
  invoiceId: string,
  input: UpdateInvoiceStatusInput,
  actor: InvoiceActorContext,
): Promise<InvoiceLifecycleResult> {
  if (input === null || typeof input !== "object" || typeof input.status !== "string") {
    throw invalid("status", "A target invoice status is required");
  }

  const target = input.status;

  if (DERIVED_STATUSES.has(target)) {
    throw AppError.unprocessable(
      `${target} is derived from successful payments and cannot be set directly`,
      { field: "status" },
    );
  }

  if (!MANUAL_STATUSES.has(target)) {
    throw invalid("status", "Unknown invoice status");
  }

  if (target === "ISSUED") {
    return issueInvoice(tenantId, invoiceId, actor);
  }

  if (target === "CANCELLED") {
    return cancelInvoice(tenantId, invoiceId, { reason: input.reason }, actor);
  }

  try {
    const staff = assertActor(actor);
    const id = assertInvoiceId(invoiceId);
    const reason = normalizeReason(input.reason);

    return await withTenantTransaction(tenantId, async (tx) => {
      const invoice = await lockInvoice(tx, tenantId, id);

      if (target === "OVERDUE") {
        return transitionOverdue(tx, tenantId, invoice, staff, todayUtc());
      }

      return transitionRefunded(tx, tenantId, invoice, staff, reason);
    });
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

/**
 * Re-derives status and amounts after payment/refund records changed.
 *
 * Exported for the future payment task: it records a transaction and calls this
 * inside the same tenant transaction. Draft and cancelled invoices refuse
 * allocations. The invoice row is locked before money is read, so concurrent
 * calls serialize. Only a changed status writes an audit event; repeated calls
 * with no change write nothing.
 */
export async function recalculateInvoiceBalance(
  tenantId: string,
  invoiceId: string,
  actor: InvoiceActorContext,
  now: Date = new Date(),
): Promise<InvoiceBalanceDto> {
  try {
    return await withTenantTransaction(tenantId, (tx) =>
      recalculateInvoiceBalanceInTransaction(tx, tenantId, invoiceId, actor, now),
    );
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

/**
 * Balance recalculation that joins the caller's tenant transaction (Task
 * 19.4.1). The payment service records the payment, its settlement rows and the
 * invoice balances in one atomic operation; calling the public wrapper there
 * would open a second transaction that deadlocks on the invoice row lock the
 * payment transaction already holds.
 *
 * The invoice is locked here as well, so concurrent allocations and
 * recalculations serialize exactly as they do through the public wrapper.
 */
export async function recalculateInvoiceBalanceInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
  actor: InvoiceActorContext,
  now: Date = new Date(),
): Promise<InvoiceBalanceDto> {
  const staff = assertActor(actor);
  const id = assertInvoiceId(invoiceId);
  const invoice = await lockInvoice(tx, tenantId, id);

  if (invoice.invoiceStatus === "DRAFT") {
    throw AppError.conflict("A draft invoice cannot carry payments; issue it first");
  }

  if (invoice.invoiceStatus === "CANCELLED") {
    throw AppError.conflict("Cancelled invoices cannot receive new payment allocations");
  }

  const money = await readSettledMoney(tx, tenantId, id);
  const balance = calculateBalance(invoice, money);
  const nextStatus = deriveStatus(invoice, balance, now.toISOString().slice(0, 10));

  if (nextStatus !== invoice.invoiceStatus) {
    assertInvoiceTransition(invoice.invoiceStatus, nextStatus, "be recalculated");
  }

  const state = await persistState(tx, tenantId, invoice, nextStatus, balance);

  if (nextStatus !== invoice.invoiceStatus) {
    recordInvoiceAudit(staff.audit, "invoice.balance_recalculated", {
      tenantId,
      actorUserId: staff.userId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      from: invoice.invoiceStatus,
      to: nextStatus,
      fields: ["invoiceStatus", "amountPaid", "balanceDue"],
    });
  }

  return state.balance;
}

/**
 * Status that reconciliation considers correct for the current records.
 *
 * DRAFT is never promoted by reconciliation: a draft has not been issued yet,
 * so a past due date must not turn it into OVERDUE. Terminal statuses stay
 * terminal, but settled money on them is an integrity fault that a balance
 * rewrite must not hide - it is reported instead.
 */
function expectedStatusAfterReconciliation(
  invoice: LockedInvoice,
  balance: CalculatedInvoiceBalance,
  today: string,
): InvoiceStatus {
  if (invoice.invoiceStatus === "DRAFT") {
    if (balance.amountPaid !== "0.00" || balance.refundedAmount !== "0.00") {
      throw AppError.conflict(
        "A draft invoice has settled payment or refund records; issue it or reverse them before reconciling",
      );
    }

    return "DRAFT";
  }

  if (
    invoice.invoiceStatus === "CANCELLED" &&
    (balance.amountPaid !== "0.00" || balance.refundedAmount !== "0.00")
  ) {
    throw AppError.conflict(
      "A cancelled invoice has settled payment or refund records; resolve them before reconciling",
    );
  }

  if (invoice.invoiceStatus === "REFUNDED" && balance.amountPaid !== "0.00") {
    throw AppError.conflict(
      "A refunded invoice has new settled money; resolve it before reconciling",
    );
  }

  return deriveStatus(invoice, balance, today);
}

/**
 * Repairs drift between the invoice header and its payment/refund records.
 *
 * The records are the source of truth: reconciliation recomputes
 * `amount_paid`, `balance_due` and (for non-terminal statuses) the derived
 * status under the same transition table as every other writer. It is
 * idempotent - a second call with no drift writes nothing and audits nothing -
 * and it never increments counters, so a duplicate call cannot double apply
 * money. If the header status is not reachable from the records under the
 * allowed transitions (or a terminal invoice carries settled money), the call
 * fails with `409` and rolls back instead of inventing a history.
 */
export async function reconcileInvoiceBalance(
  tenantId: string,
  invoiceId: string,
  actor: InvoiceActorContext,
  now: Date = new Date(),
): Promise<InvoiceReconciliationResult> {
  try {
    const staff = assertActor(actor);
    const id = assertInvoiceId(invoiceId);

    return await withTenantTransaction(tenantId, async (tx) => {
      const invoice = await lockInvoice(tx, tenantId, id);
      const money = await readSettledMoney(tx, tenantId, id);
      const balance = calculateBalance(invoice, money);
      const expectedStatus = expectedStatusAfterReconciliation(
        invoice,
        balance,
        now.toISOString().slice(0, 10),
      );
      const expectedAmountPaid =
        expectedStatus === "CANCELLED" ? "0.00" : balance.amountPaid;
      const expectedBalanceDue = closedBalance(expectedStatus, balance.balanceDue);

      const persisted = {
        invoiceStatus: invoice.invoiceStatus,
        amountPaid: invoice.amountPaid,
        balanceDue: invoice.balanceDue,
      };
      const repaired =
        persisted.invoiceStatus !== expectedStatus ||
        persisted.amountPaid !== expectedAmountPaid ||
        persisted.balanceDue !== expectedBalanceDue;

      if (repaired) {
        if (expectedStatus !== invoice.invoiceStatus) {
          assertInvoiceTransition(
            invoice.invoiceStatus,
            expectedStatus,
            "be reconciled",
          );
        }

        const [updated] = await tx
          .update(invoices)
          .set({
            invoiceStatus: expectedStatus,
            amountPaid: expectedAmountPaid,
            balanceDue: expectedBalanceDue,
            updatedAt: new Date(),
          })
          .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)))
          .returning({ id: invoices.id });

        if (!updated) throw AppError.internal("Failed to reconcile the invoice");

        recordInvoiceAudit(staff.audit, "invoice.reconciled", {
          tenantId,
          actorUserId: staff.userId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          from: persisted.invoiceStatus,
          to: expectedStatus,
          fields: ["invoiceStatus", "amountPaid", "balanceDue"],
        });
      }

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        repaired,
        persisted,
        expected: {
          invoiceStatus: expectedStatus,
          amountPaid: expectedAmountPaid,
          balanceDue: expectedBalanceDue,
        },
        balance: toBalanceDto(
          {
            ...invoice,
            invoiceStatus: expectedStatus,
            amountPaid: expectedAmountPaid,
            balanceDue: expectedBalanceDue,
          },
          { ...balance, amountPaid: expectedAmountPaid, balanceDue: expectedBalanceDue },
        ),
      };
    });
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

/**
 * Read-only balance view for one tenant-scoped invoice.
 *
 * Figures are derived from the persisted total and the SUCCESSFUL payment and
 * refund records, so a stale header can never hide money. The invoice header
 * supplies subtotal/discount/tax, which are server-computed at creation.
 */
export async function getInvoiceBalance(
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceBalanceDto> {
  const id = assertInvoiceId(invoiceId);

  return withTenantTransaction(tenantId, async (tx) => {
    const [invoice] = await invoiceHeaderQuery(tx, tenantId, id);

    if (!invoice) throw AppError.notFound("Invoice not found");

    const money = await readSettledMoney(tx, tenantId, id);

    return toBalanceDto(invoice, calculateBalance(invoice, money));
  });
}
