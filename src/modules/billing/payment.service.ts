import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
  type DbExecutor,
} from "../../database/context.js";
import {
  invoicePayments,
  invoices,
  paymentAllocations,
  payments,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { recordPaymentAudit } from "./billing.audit.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { enqueueBillingNotificationIntegrated } from "./notifications/billing-notification.bridge.js";
import { addMoney, compareMoney, normalizeMoney } from "./invoice-calculation.js";
import {
  getInvoiceBalance,
  recalculateInvoiceBalanceInTransaction,
  reconcileInvoiceBalance,
} from "./invoice.lifecycle.service.js";
import {
  assertBranchInTenant,
  assertPatientInTenant,
  pgErrorInfo,
} from "./invoice.service.js";
import type { InvoiceBalanceDto } from "./invoice.types.js";
import type {
  ListPaymentsFilters,
  PaymentAllocationInput,
  PaymentActorContext,
  PaymentDto,
  PaymentListResult,
  PaymentMethod,
  PaymentReconciliationIssue,
  PaymentReconciliationResult,
  PaymentStatus,
  PaymentSummaryDto,
  RecordPaymentInput,
  RecordPaymentResult,
} from "./payment.types.js";

/**
 * Payment recording and allocation (Task 19.4.1).
 *
 * One call records one receipt-level `payments` row plus one
 * `payment_allocations` row per invoice and, for every allocation, the
 * `invoice_payments` settlement row the balance lifecycle reads. Everything
 * happens in a single tenant transaction:
 *
 *   validate relationships -> lock invoices -> insert payment, settlements and
 *   allocations -> recalculate each invoice balance -> audit -> return
 *
 * Money is `NUMERIC(12, 2)` end to end. Inputs are normalized through
 * `normalizeMoney` and summed with `addMoney` (BigInt), never with JS floats.
 *
 * Allocation rules:
 * - at least one allocation, each positive, one per invoice;
 * - allocation amounts must sum exactly to `payments.amount`;
 * - an allocation may not exceed the invoice's outstanding balance, so the
 *   invoice can never be over-paid (partial payments are first-class);
 * - every invoice must belong to the tenant and to the paying patient, and all
 *   allocated invoices must share one currency;
 * - DRAFT and CANCELLED invoices are refused by the lifecycle recalculation.
 *
 * Idempotency: an optional client key is unique per tenant. Repeating the same
 * request replays the original payment (and its balances) instead of collecting
 * twice; reusing the key with a different request is a `409`. A concurrent
 * duplicate that loses the unique-index race is caught and replayed the same
 * way. `reference` (receipt/UTR/cheque) is also unique per tenant when present.
 *
 * Financial history is append-only: the payment service never updates or
 * deletes a recorded payment, allocation or settlement row. Refunds and gateway
 * processing are deliberately out of scope.
 *
 * Task 19.4.2 adds the integrity half:
 * - a settlement row is linked to the receipt that created it, so the payment
 *   ledger and the invoice ledger can be reconciled against each other;
 * - every allocated invoice must sit in the payment's own branch, not merely
 *   in the tenant and under the same patient;
 * - `reconcilePayment` proves the two ledgers agree and reuses the invoice
 *   reconciliation to repair any header drift it finds.
 */

const PAYMENT_METHODS: ReadonlySet<string> = new Set<PaymentMethod>([
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "CHEQUE",
  "OTHER",
]);

const PAYMENT_STATUSES: ReadonlySet<string> = new Set<PaymentStatus>([
  "PENDING",
  "SUCCESSFUL",
  "FAILED",
  "REFUNDED",
]);

/**
 * Only a successful collection may settle invoices (Task 19.4.2). Manual
 * payments are recorded SUCCESSFUL because the cashier already holds the
 * money; a PENDING/FAILED/REFUNDED receipt must never move `amount_paid`.
 */
export const SETTLING_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  "SUCCESSFUL",
]);

/** Whether a payment in this state is allowed to affect invoice balances. */
export function isSettlingPaymentStatus(status: PaymentStatus): boolean {
  return SETTLING_PAYMENT_STATUSES.has(status);
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REFERENCE_LENGTH = 120;
const MAX_NOTES_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ALLOCATIONS = 50;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const paymentSelection = {
  id: payments.id,
  branchId: payments.branchId,
  patientId: payments.patientId,
  paymentMethod: payments.paymentMethod,
  amount: payments.amount,
  currency: payments.currency,
  paymentStatus: payments.paymentStatus,
  reference: payments.reference,
  notes: payments.notes,
  receivedBy: payments.receivedBy,
  receivedAt: payments.receivedAt,
  idempotencyKey: payments.idempotencyKey,
  createdAt: payments.createdAt,
} as const;

interface NormalizedAllocation {
  readonly invoiceId: string;
  readonly amount: string;
}

interface NormalizedPayment {
  readonly branchId: string;
  readonly patientId: string;
  readonly method: PaymentMethod;
  readonly amount: string;
  /** Supplied currency, or `null` when it is derived from the invoices. */
  readonly currency: string | null;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly receivedAt: Date;
  /** Whether the caller supplied the timestamp (see `requestHashOf`). */
  readonly receivedAtExplicit: boolean;
  readonly idempotencyKey: string | null;
  /** Sorted by invoice id so locking order is deterministic. */
  readonly allocations: readonly NormalizedAllocation[];
}

function invalid(field: string, message: string): AppError {
  return AppError.validation(message, { field });
}

function assertActor(actor: PaymentActorContext): PaymentActorContext {
  if (actor === null || typeof actor !== "object" || typeof actor.userId !== "string") {
    throw AppError.unauthorized("An authenticated user is required to record payments");
  }

  return actor;
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field, `${field} is required`);
  }

  return value.trim();
}

function normalizeCurrency(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const currency = value.trim().toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw invalid("currency", "Currency must be a three-letter ISO 4217 code");
  }

  return currency;
}

function normalizeReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const reference = value.trim();

  if (reference.length === 0) return null;

  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw invalid(
      "reference",
      `Reference must be at most ${MAX_REFERENCE_LENGTH} characters`,
    );
  }

  return reference;
}

function normalizeNotes(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const notes = value.trim();

  if (notes.length === 0) return null;

  if (notes.length > MAX_NOTES_LENGTH) {
    throw invalid("notes", `Notes must be at most ${MAX_NOTES_LENGTH} characters`);
  }

  return notes;
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const key = value.trim();

  if (key.length === 0) return null;

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalid(
      "idempotencyKey",
      `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }

  return key;
}

function normalizeReceivedAt(
  value: Date | string | null | undefined,
  now: Date,
): Date {
  if (value === null || value === undefined) return now;

  const receivedAt = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(receivedAt.getTime())) {
    throw invalid("receivedAt", "receivedAt must be a valid timestamp");
  }

  // Small clock tolerance; money cannot be received in the future.
  if (receivedAt.getTime() > now.getTime() + 60_000) {
    throw invalid("receivedAt", "receivedAt cannot be in the future");
  }

  return receivedAt;
}

function normalizeAllocations(
  allocations: readonly PaymentAllocationInput[] | undefined,
): NormalizedAllocation[] {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw invalid("allocations", "At least one invoice allocation is required");
  }

  if (allocations.length > MAX_ALLOCATIONS) {
    throw invalid("allocations", `A payment can settle at most ${MAX_ALLOCATIONS} invoices`);
  }

  const seen = new Set<string>();
  const normalized: NormalizedAllocation[] = [];

  for (const allocation of allocations) {
    if (allocation === null || typeof allocation !== "object") {
      throw invalid("allocations", "Each allocation must be an object");
    }

    const invoiceId = normalizeId(allocation.invoiceId, "allocations.invoiceId");
    const amount = normalizeMoney(allocation.amount, "allocations.amount");

    if (seen.has(invoiceId)) {
      throw invalid(
        "allocations",
        "Each invoice may appear only once; combine the amounts into one allocation",
      );
    }

    if (compareMoney(amount, "0.00") <= 0) {
      throw invalid("allocations.amount", "Allocation amount must be greater than zero");
    }

    seen.add(invoiceId);
    normalized.push({ invoiceId, amount });
  }

  return normalized.sort((left, right) =>
    left.invoiceId === right.invoiceId ? 0 : left.invoiceId < right.invoiceId ? -1 : 1,
  );
}

function normalizeInput(input: RecordPaymentInput, actor: PaymentActorContext): NormalizedPayment {
  if (input === null || typeof input !== "object") {
    throw invalid("payment", "Payment details are required");
  }

  if (!PAYMENT_METHODS.has(input.method)) {
    throw invalid("method", "Unknown payment method");
  }

  const allocations = normalizeAllocations(input.allocations);
  const amount = normalizeMoney(input.amount, "amount");

  if (compareMoney(amount, "0.00") <= 0) {
    throw invalid("amount", "Payment amount must be greater than zero");
  }

  const allocatedTotal = addMoney(
    allocations.map((allocation) => allocation.amount),
    "allocations.amount",
  );

  if (compareMoney(allocatedTotal, amount) !== 0) {
    throw AppError.validation(
      "Allocation amounts must add up exactly to the payment amount",
      {
        field: "allocations",
        reason: "ALLOCATION_TOTAL_MISMATCH",
        amount,
        allocatedTotal,
      },
    );
  }

  if (typeof actor.userId !== "string" || actor.userId.trim().length === 0) {
    throw AppError.unauthorized("An authenticated user is required to record payments");
  }

  return {
    branchId: normalizeId(input.branchId, "branchId"),
    patientId: normalizeId(input.patientId, "patientId"),
    method: input.method,
    amount,
    currency: normalizeCurrency(input.currency),
    reference: normalizeReference(input.reference),
    notes: normalizeNotes(input.notes),
    receivedAt: normalizeReceivedAt(input.receivedAt, new Date()),
    receivedAtExplicit: input.receivedAt !== null && input.receivedAt !== undefined,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    allocations,
  };
}

/**
 * Canonical form of a recording request. It intentionally excludes the
 * idempotency key itself so the same logical request always hashes alike.
 */
function requestHashOf(input: NormalizedPayment, actor: PaymentActorContext): string {
  const canonical = JSON.stringify({
    branchId: input.branchId,
    patientId: input.patientId,
    method: input.method,
    amount: input.amount,
    currency: input.currency,
    reference: input.reference,
    notes: input.notes,
    ...(input.receivedAtExplicit ? { receivedAt: input.receivedAt.toISOString() } : {}),
    receivedBy: actor.userId,
    allocations: input.allocations.map((allocation) => ({
      invoiceId: allocation.invoiceId,
      amount: allocation.amount,
    })),
  });

  return createHash("sha256").update(canonical).digest("hex");
}

function toPaymentDto(
  row: PaymentRow,
  allocations: readonly {
    readonly id: string;
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly amount: string;
  }[],
): PaymentDto {
  return {
    id: row.id,
    branchId: row.branchId,
    patientId: row.patientId,
    paymentMethod: row.paymentMethod,
    amount: row.amount,
    currency: row.currency,
    paymentStatus: row.paymentStatus,
    reference: row.reference,
    notes: row.notes,
    receivedBy: row.receivedBy,
    receivedAt: row.receivedAt,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    allocations: allocations.map((allocation) => ({
      id: allocation.id,
      invoiceId: allocation.invoiceId,
      invoiceNumber: allocation.invoiceNumber,
      amount: allocation.amount,
    })),
  };
}

interface PaymentRow {
  readonly id: string;
  readonly branchId: string;
  readonly patientId: string;
  readonly paymentMethod: PaymentMethod;
  readonly amount: string;
  readonly currency: string;
  readonly paymentStatus: PaymentStatus;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly receivedBy: string;
  readonly receivedAt: Date;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

async function loadPaymentDto(
  tx: DbExecutor,
  tenantId: string,
  paymentId: string,
): Promise<PaymentDto> {
  const [row] = await tx
    .select(paymentSelection)
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.tenantId, tenantId)))
    .limit(1);

  if (!row) throw AppError.notFound("Payment not found");

  const allocationRows = await tx
    .select({
      id: paymentAllocations.id,
      invoiceId: paymentAllocations.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      amount: paymentAllocations.amount,
    })
    .from(paymentAllocations)
    .innerJoin(
      invoices,
      and(
        eq(invoices.id, paymentAllocations.invoiceId),
        eq(invoices.tenantId, paymentAllocations.tenantId),
      ),
    )
    .where(
      and(
        eq(paymentAllocations.tenantId, tenantId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    )
    .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));

  return toPaymentDto(row, allocationRows);
}

/**
 * Replays an existing payment when the idempotency key matches. Returns `null`
 * when the key was never used. Reusing a key with a different request is a
 * conflict, never a second collection.
 */
async function replayIfPresent(
  tenantId: string,
  normalized: NormalizedPayment,
  requestHash: string,
  actor: PaymentActorContext,
): Promise<RecordPaymentResult | null> {
  if (normalized.idempotencyKey === null) return null;

  const existing = await withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: payments.id, requestHash: payments.requestHash })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.idempotencyKey, normalized.idempotencyKey as string),
        ),
      )
      .limit(1);

    return row;
  });

  if (!existing) return null;

  if (existing.requestHash !== requestHash) {
    throw AppError.conflict(
      "This idempotency key was already used to record a different payment",
    );
  }

  const payment = await getPaymentById(tenantId, existing.id);
  const invoiceBalances = await Promise.all(
    payment.allocations.map((allocation) => getInvoiceBalance(tenantId, allocation.invoiceId)),
  );

  recordPaymentAudit(actor.audit, "payment.replayed", {
    tenantId,
    actorUserId: actor.userId,
    paymentId: payment.id,
    patientId: payment.patientId,
    branchId: payment.branchId,
    paymentMethod: payment.paymentMethod,
    invoiceIds: payment.allocations.map((allocation) => allocation.invoiceId),
  });

  return { replayed: true, payment, invoiceBalances };
}

/**
 * Records an offline/manual payment and allocates it to invoices.
 *
 * The whole operation is one tenant transaction; if any invoice is invalid,
 * over-allocated or belongs to another patient, nothing is written.
 */
export async function recordPayment(
  tenantId: string,
  input: RecordPaymentInput,
  actor: PaymentActorContext,
): Promise<RecordPaymentResult> {
  const staff = assertActor(actor);
  const normalized = normalizeInput(input, staff);
  const requestHash = requestHashOf(normalized, staff);

  const replay = await replayIfPresent(tenantId, normalized, requestHash, staff);
  if (replay) return replay;

  try {
    return await withTenantTransaction(tenantId, (tx) =>
      recordPaymentInTransaction(tx, tenantId, normalized, requestHash, staff),
    );
  } catch (error) {
    const { code, constraint } = pgErrorInfo(error);

    if (
      code === "23505" &&
      constraint === "payments_tenant_idempotency_key_unique" &&
      normalized.idempotencyKey !== null
    ) {
      // A concurrent duplicate won the race: replay it if it is the same request.
      const raced = await replayIfPresent(tenantId, normalized, requestHash, staff);
      if (raced) return raced;
    }

    if (code === "23505" && constraint === "payments_tenant_reference_unique") {
      throw AppError.conflict("A payment with this reference already exists in this hospital");
    }

    if (code === "23505") {
      throw AppError.conflict("A payment with these details already exists in this hospital");
    }

    if (code === "23514") {
      throw AppError.validation("Payment data violates a database constraint");
    }

    if (code === "23503") {
      throw AppError.badRequest(
        "A referenced patient, branch, invoice or paying user does not belong to this hospital",
      );
    }

    if (code === "22P02") {
      throw AppError.badRequest("One or more identifiers are not valid UUIDs");
    }

    throw error;
  }
}

async function recordPaymentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: NormalizedPayment,
  requestHash: string,
  actor: PaymentActorContext,
): Promise<RecordPaymentResult> {
  await assertPatientInTenant(tx, tenantId, input.patientId);
  await assertBranchInTenant(tx, tenantId, input.branchId);

  const invoiceIds = input.allocations.map((allocation) => allocation.invoiceId);

  // Relationship checks read the invoices without a lock; the balance checks
  // below take the row locks in deterministic (sorted) allocation order.
  const invoiceRows = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      patientId: invoices.patientId,
      branchId: invoices.branchId,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, invoiceIds)));

  if (invoiceRows.length !== invoiceIds.length) {
    throw AppError.badRequest("One or more invoices do not belong to this hospital");
  }

  const invoiceById = new Map(invoiceRows.map((row) => [row.id, row]));

  const currencies = new Set(invoiceRows.map((row) => row.currency));

  if (currencies.size !== 1) {
    throw AppError.validation(
      "All allocated invoices must use the same currency",
      { field: "allocations" },
    );
  }

  const invoiceCurrency = invoiceRows[0]?.currency ?? "";

  if (input.currency !== null && input.currency !== invoiceCurrency) {
    throw AppError.validation(
      `Payment currency ${input.currency} does not match the invoice currency ${invoiceCurrency}`,
      { field: "currency" },
    );
  }

  for (const allocation of input.allocations) {
    const invoice = invoiceById.get(allocation.invoiceId);

    if (!invoice) {
      throw AppError.badRequest("One or more invoices do not belong to this hospital");
    }

    if (invoice.patientId !== input.patientId) {
      throw AppError.badRequest(
        "Every invoice in a payment must belong to the paying patient",
        { invoiceId: invoice.id },
      );
    }

    // Branch is a financial boundary, not decoration: revenue and cash-desk
    // reports are per branch, so money collected in one branch cannot settle
    // another branch's invoice, even inside the same hospital.
    if (invoice.branchId !== input.branchId) {
      throw AppError.badRequest(
        "Every invoice in a payment must belong to the payment's branch",
        { invoiceId: invoice.id },
      );
    }
  }

  // Insert the receipt before touching invoice balances. A concurrent retry
  // with the same idempotency key blocks on the unique index here and is then
  // replayed by the caller, instead of failing a balance check against money
  // the first request has already collected.
  const [payment] = await tx
    .insert(payments)
    .values({
      tenantId,
      branchId: input.branchId,
      patientId: input.patientId,
      paymentMethod: input.method,
      amount: input.amount,
      currency: invoiceCurrency,
      paymentStatus: "SUCCESSFUL",
      reference: input.reference,
      notes: input.notes,
      receivedBy: actor.userId,
      receivedAt: input.receivedAt,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    .returning({ id: payments.id });

  if (!payment) throw AppError.internal("Failed to record the payment");

  for (const allocation of input.allocations) {
    const invoice = invoiceById.get(allocation.invoiceId);

    if (!invoice) {
      throw AppError.badRequest("One or more invoices do not belong to this hospital");
    }

    // Locks the invoice and proves it is in a state that can receive money:
    // DRAFT and CANCELLED are refused here. The lock is held until commit, so
    // a concurrent payment cannot pass the same balance check.
    const balance = await recalculateInvoiceBalanceInTransaction(
      tx,
      tenantId,
      invoice.id,
      actor,
      input.receivedAt,
    );

    if (compareMoney(balance.balanceDue, allocation.amount) < 0) {
      throw AppError.validation(
        "Allocation exceeds the invoice's outstanding balance",
        {
          field: "allocations.amount",
          reason: "ALLOCATION_EXCEEDS_BALANCE",
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          balanceDue: balance.balanceDue,
          requested: allocation.amount,
        },
      );
    }

    const [settlement] = await tx
      .insert(invoicePayments)
      .values({
        tenantId,
        invoiceId: allocation.invoiceId,
        // Links the settlement to this receipt so the two ledgers reconcile.
        paymentId: payment.id,
        amount: allocation.amount,
        currency: invoiceCurrency,
        paymentStatus: "SUCCESSFUL",
        reference: input.reference,
        paidAt: input.receivedAt,
        createdBy: actor.userId,
      })
      .returning({ id: invoicePayments.id });

    if (!settlement) throw AppError.internal("Failed to record the invoice settlement");

    await tx.insert(paymentAllocations).values({
      tenantId,
      paymentId: payment.id,
      invoiceId: allocation.invoiceId,
      amount: allocation.amount,
    });
  }

  // The settlement rows are now the source of truth; fold them into each
  // invoice header (amount_paid, balance_due and derived status) in this same
  // transaction so a failure above can never leave half-applied money.
  const invoiceBalances: InvoiceBalanceDto[] = [];

  for (const allocation of input.allocations) {
    invoiceBalances.push(
      await recalculateInvoiceBalanceInTransaction(
        tx,
        tenantId,
        allocation.invoiceId,
        actor,
        input.receivedAt,
      ),
    );
  }

  const dto = await loadPaymentDto(tx, tenantId, payment.id);

  recordPaymentAudit(actor.audit, "payment.recorded", {
    tenantId,
    actorUserId: actor.userId,
    paymentId: dto.id,
    patientId: dto.patientId,
    branchId: dto.branchId,
    paymentMethod: dto.paymentMethod,
    invoiceIds: dto.allocations.map((allocation) => allocation.invoiceId),
  });

  await recordAuditSafely(tx, {
    tenantId,
    branchId: dto.branchId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.PAYMENT_RECORDED,
    module: "billing",
    resourceType: "payment",
    resourceId: dto.id,
    description: "Payment recorded",
    metadata: {
      paymentMethod: dto.paymentMethod,
      invoiceIds: dto.allocations.map((allocation) => allocation.invoiceId),
    },
  });

  // One billing/central notification per settled invoice. The stable dedupe key
  // makes a retried or concurrently replayed payment idempotent.
  for (const balance of invoiceBalances) {
    await enqueueBillingNotificationIntegrated(tx, tenantId, {
      event:
        balance.balanceDue === "0.00" ? "PAYMENT_RECEIVED" : "PARTIAL_PAYMENT_RECEIVED",
      invoiceId: balance.invoiceId,
      paymentId: dto.id,
      dedupeKey: `payment-received:${dto.id}:${balance.invoiceId}`,
    });
  }

  return { replayed: false, payment: dto, invoiceBalances };
}

/** Payment retrieval by id, with its allocations and invoice numbers. */
export async function getPaymentById(
  tenantId: string,
  paymentId: string,
): Promise<PaymentDto> {
  const id = normalizeId(paymentId, "paymentId");

  return withTenantTransaction(tenantId, (tx) => loadPaymentDto(tx, tenantId, id));
}

interface ReconciliationSnapshot {
  readonly payment: {
    readonly id: string;
    readonly patientId: string;
    readonly branchId: string;
    readonly paymentMethod: PaymentMethod;
    readonly paymentStatus: PaymentStatus;
    readonly amount: string;
    readonly currency: string;
  };
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: string }[];
  readonly settlements: readonly {
    readonly id: string;
    readonly invoiceId: string;
    readonly amount: string;
    readonly status: PaymentStatus;
  }[];
  readonly invoiceIds: readonly string[];
  readonly invoices: readonly {
    readonly id: string;
    readonly patientId: string;
    readonly branchId: string;
  }[];
}

/**
 * Reads a receipt and both sides of its ledger under one lock. Locking the
 * payment row (financial rows are append-only, but a migration or a future
 * reversal could still change it) keeps the snapshot stable while it is read.
 */
async function loadReconciliationSnapshot(
  tenantId: string,
  paymentId: string,
): Promise<ReconciliationSnapshot> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [payment] = await tx
      .select({
        id: payments.id,
        patientId: payments.patientId,
        branchId: payments.branchId,
        paymentMethod: payments.paymentMethod,
        paymentStatus: payments.paymentStatus,
        amount: payments.amount,
        currency: payments.currency,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1)
      .for("update");

    if (!payment) throw AppError.notFound("Payment not found");

    const allocations = await tx
      .select({ invoiceId: paymentAllocations.invoiceId, amount: paymentAllocations.amount })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(paymentAllocations.invoiceId));

    const settlements = await tx
      .select({
        id: invoicePayments.id,
        invoiceId: invoicePayments.invoiceId,
        amount: invoicePayments.amount,
        status: invoicePayments.paymentStatus,
      })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.tenantId, tenantId),
          eq(invoicePayments.paymentId, paymentId),
        ),
      )
      .orderBy(asc(invoicePayments.id));

    const invoiceIds = [
      ...new Set([
        ...allocations.map((allocation) => allocation.invoiceId),
        ...settlements.map((settlement) => settlement.invoiceId),
      ]),
    ].sort();

    const invoiceRows =
      invoiceIds.length === 0
        ? []
        : await tx
            .select({
              id: invoices.id,
              patientId: invoices.patientId,
              branchId: invoices.branchId,
            })
            .from(invoices)
            .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, invoiceIds)));

    return {
      payment,
      allocations,
      settlements,
      invoiceIds,
      invoices: invoiceRows,
    };
  });
}

/**
 * Reconciles one receipt against its allocations, its settlement rows and the
 * invoice headers (Task 19.4.2).
 *
 * This is the second half of billing reconciliation: `reconcileInvoiceBalance`
 * proves an invoice header matches the money, while this proves a receipt's
 * allocations match the settlement rows that money was written through. Both
 * directions are needed, because a mismatch between the two ledgers would make
 * one invoice look paid while the receipt accounts for a different amount.
 *
 * Detection is read-only and never rewrites money. Invoice header drift is
 * repaired by delegating to `reconcileInvoiceBalance` for every invoice the
 * receipt touches, so the financial calculation and transition rules are not
 * duplicated. A receipt that disagrees with its ledger returns
 * `consistent: false` with issue codes for human investigation; it is not
 * silently "fixed".
 */
export async function reconcilePayment(
  tenantId: string,
  paymentId: string,
  actor: PaymentActorContext,
): Promise<PaymentReconciliationResult> {
  const staff = assertActor(actor);
  const id = normalizeId(paymentId, "paymentId");
  const snapshot = await loadReconciliationSnapshot(tenantId, id);
  const { payment } = snapshot;

  const allocatedTotal = addMoney(
    snapshot.allocations.map((allocation) => allocation.amount),
    "allocations.amount",
  );
  const settledTotal = addMoney(
    snapshot.settlements.map((settlement) => settlement.amount),
    "settlements.amount",
  );

  const issues: PaymentReconciliationIssue[] = [];

  // Only successful collections may move an invoice balance. Anything else
  // holding allocations or settlements is a state-transition violation.
  if (
    !isSettlingPaymentStatus(payment.paymentStatus) &&
    (snapshot.allocations.length > 0 || snapshot.settlements.length > 0)
  ) {
    issues.push({
      code: "INELIGIBLE_PAYMENT_STATUS",
      message: `Payment status ${payment.paymentStatus} cannot settle invoices`,
      actual: payment.paymentStatus,
      expected: "SUCCESSFUL",
    });
  }

  if (compareMoney(allocatedTotal, payment.amount) !== 0) {
    issues.push({
      code: "ALLOCATION_TOTAL_MISMATCH",
      message: "Allocations do not add up to the payment amount",
      amount: payment.amount,
      expected: payment.amount,
      actual: allocatedTotal,
    });
  }

  const settlementsByInvoice = new Map<
    string,
    { id: string; invoiceId: string; amount: string; status: PaymentStatus }[]
  >();

  for (const settlement of snapshot.settlements) {
    const group = settlementsByInvoice.get(settlement.invoiceId) ?? [];
    group.push(settlement);
    settlementsByInvoice.set(settlement.invoiceId, group);
  }

  const allocatedInvoiceIds = new Set(
    snapshot.allocations.map((allocation) => allocation.invoiceId),
  );

  for (const allocation of snapshot.allocations) {
    const group = settlementsByInvoice.get(allocation.invoiceId) ?? [];

    if (group.length === 0) {
      issues.push({
        code: "MISSING_SETTLEMENT",
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
        message: "An allocation has no settlement row on its invoice",
      });
      continue;
    }

    if (group.length > 1) {
      issues.push({
        code: "DUPLICATE_SETTLEMENT",
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
        message: "More than one settlement exists for the same payment and invoice",
      });
      continue;
    }

    const [settlement] = group;

    if (!settlement) continue;

    if (!isSettlingPaymentStatus(settlement.status)) {
      issues.push({
        code: "INELIGIBLE_SETTLEMENT_STATUS",
        invoiceId: allocation.invoiceId,
        amount: settlement.amount,
        message: `Settlement status ${settlement.status} does not reduce the invoice balance`,
        actual: settlement.status,
        expected: "SUCCESSFUL",
      });
    }

    if (compareMoney(settlement.amount, allocation.amount) !== 0) {
      issues.push({
        code: "SETTLEMENT_AMOUNT_MISMATCH",
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
        expected: allocation.amount,
        actual: settlement.amount,
        message: "The settlement amount differs from the allocation amount",
      });
    }
  }

  for (const settlement of snapshot.settlements) {
    if (!allocatedInvoiceIds.has(settlement.invoiceId)) {
      issues.push({
        code: "ORPHAN_SETTLEMENT",
        invoiceId: settlement.invoiceId,
        amount: settlement.amount,
        message: "A settlement points at an invoice this payment did not allocate",
      });
    }
  }

  // Relationship boundaries: an allocation may never cross tenant (checked by
  // RLS and the composite key), patient or branch. Tenant is already enforced
  // by the snapshot query; patient and branch are service rules.
  const invoiceById = new Map(snapshot.invoices.map((invoice) => [invoice.id, invoice]));

  for (const invoiceId of snapshot.invoiceIds) {
    const invoice = invoiceById.get(invoiceId);

    if (!invoice) {
      issues.push({
        code: "INVOICE_NOT_FOUND",
        invoiceId,
        message: "An invoice referenced by this payment is not visible in this hospital",
      });
      continue;
    }

    if (invoice.patientId !== payment.patientId) {
      issues.push({
        code: "PATIENT_MISMATCH",
        invoiceId,
        message: "The invoice belongs to a different patient than the payment",
      });
    }

    if (invoice.branchId !== payment.branchId) {
      issues.push({
        code: "BRANCH_MISMATCH",
        invoiceId,
        message: "The invoice belongs to a different branch than the payment",
      });
    }
  }

  // Reuse the invoice reconciler instead of recomputing balances here. It
  // repairs header drift and enforces the central transition table. Its
  // failures are reported as issues rather than aborting the whole report.
  const invoiceBalances: InvoiceBalanceDto[] = [];
  let repairedInvoices = 0;

  for (const invoiceId of snapshot.invoiceIds) {
    if (invoiceById.has(invoiceId)) {
      try {
        const reconciliation = await reconcileInvoiceBalance(tenantId, invoiceId, actor);
        if (reconciliation.repaired) repairedInvoices += 1;
        invoiceBalances.push(reconciliation.balance);
      } catch (error) {
        const statusCode = error instanceof AppError ? error.statusCode : undefined;

        issues.push({
          code: "INVOICE_RECONCILIATION_FAILED",
          invoiceId,
          message:
            error instanceof AppError
              ? error.message
              : "Invoice reconciliation failed unexpectedly",
          ...(statusCode === undefined ? {} : { statusCode }),
        });
      }
    }
  }

  const consistent = issues.length === 0;

  recordPaymentAudit(staff.audit, "payment.reconciled", {
    tenantId,
    actorUserId: staff.userId,
    paymentId: payment.id,
    patientId: payment.patientId,
    branchId: payment.branchId,
    paymentMethod: payment.paymentMethod,
    invoiceIds: snapshot.invoiceIds,
    consistent,
    issueCodes: issues.map((issue) => issue.code),
  });

  return {
    paymentId: payment.id,
    patientId: payment.patientId,
    branchId: payment.branchId,
    paymentMethod: payment.paymentMethod,
    paymentStatus: payment.paymentStatus,
    currency: payment.currency,
    amount: payment.amount,
    allocatedTotal,
    settledTotal,
    consistent,
    issues,
    invoiceBalances,
    repairedInvoices,
  };
}

function normalizeDate(value: string, field: string): string {
  const text = value.trim();

  if (!DATE_PATTERN.test(text)) {
    throw invalid(field, `${field} must be a date in YYYY-MM-DD format`);
  }

  const parsed = new Date(`${text}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(field, `${field} must be a valid calendar date`);
  }

  return text;
}

function toSummary(row: PaymentRow): PaymentSummaryDto {
  return {
    id: row.id,
    branchId: row.branchId,
    patientId: row.patientId,
    paymentMethod: row.paymentMethod,
    amount: row.amount,
    currency: row.currency,
    paymentStatus: row.paymentStatus,
    reference: row.reference,
    receivedBy: row.receivedBy,
    receivedAt: row.receivedAt,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

/**
 * Payment history for a tenant, newest first. Filters are additive; page
 * numbering is 1-based and bounded like the invoice list.
 */
export async function listPayments(
  tenantId: string,
  filters: ListPaymentsFilters = {},
): Promise<PaymentListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  if (filters.method !== undefined && !PAYMENT_METHODS.has(filters.method)) {
    throw invalid("method", "Unknown payment method");
  }

  if (filters.status !== undefined && !PAYMENT_STATUSES.has(filters.status)) {
    throw invalid("status", "Unknown payment status");
  }

  const fromDate =
    filters.fromDate === undefined ? undefined : normalizeDate(filters.fromDate, "fromDate");
  const toDate =
    filters.toDate === undefined ? undefined : normalizeDate(filters.toDate, "toDate");

  if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
    throw invalid("fromDate", "fromDate cannot be after toDate");
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions: SQL[] = [eq(payments.tenantId, tenantId)];

    if (filters.patientId !== undefined) {
      conditions.push(eq(payments.patientId, filters.patientId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(payments.branchId, filters.branchId));
    }
    if (filters.method !== undefined) {
      conditions.push(eq(payments.paymentMethod, filters.method));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(payments.paymentStatus, filters.status));
    }
    if (filters.reference !== undefined && filters.reference.trim().length > 0) {
      conditions.push(eq(payments.reference, filters.reference.trim()));
    }
    if (fromDate !== undefined) {
      conditions.push(gte(payments.receivedAt, new Date(`${fromDate}T00:00:00.000Z`)));
    }
    if (toDate !== undefined) {
      const exclusive = new Date(`${toDate}T00:00:00.000Z`);
      exclusive.setUTCDate(exclusive.getUTCDate() + 1);
      conditions.push(lt(payments.receivedAt, exclusive));
    }

    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      tx
        .select(paymentSelection)
        .from(payments)
        .where(where)
        .orderBy(desc(payments.receivedAt), desc(payments.createdAt), asc(payments.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(payments)
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      payments: rows.map(toSummary),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}
