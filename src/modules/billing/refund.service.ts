import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import {
  invoicePayments,
  invoiceRefunds,
  invoices,
  paymentGatewayOrders,
  payments,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { recordRefundAudit } from "./billing.audit.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { enqueueBillingNotificationIntegrated } from "./notifications/billing-notification.bridge.js";
import {
  createPaymentGateway,
  paymentGatewayConfigFromEnv,
  withGatewayTimeout,
} from "./gateway/payment-gateway.registry.js";
import {
  PaymentGatewayTimeoutError,
  type GatewayRefundResult,
  type PaymentGateway,
  type PaymentGatewayProviderName,
} from "./gateway/payment-gateway.types.js";
import { addMoney, compareMoney, normalizeMoney } from "./invoice-calculation.js";
import { recalculateInvoiceBalanceInTransaction } from "./invoice.lifecycle.service.js";
import { pgErrorInfo } from "./invoice.service.js";
import type {
  CreateRefundRequestInput,
  CreateRefundRequestResult,
  ListRefundsFilters,
  ProcessRefundDependencies,
  ProcessRefundInput,
  RefundActorContext,
  RefundChannel,
  RefundDecisionInput,
  RefundDto,
  RefundListResult,
  RefundStatus,
  RefundSummaryDto,
} from "./refund.types.js";

/**
 * Refund processing service (Phase 19.7.1).
 *
 * Lifecycle (central, not caller-controlled):
 *
 *   PENDING -> APPROVED -> PROCESSING -> SUCCESSFUL
 *                                  \--> FAILED -> PROCESSING (retry)
 *   PENDING -> REJECTED
 *
 * Rules:
 * - a refund always reverses one SUCCESSFUL `invoice_payments` capture, and the
 *   invoice, receipt, patient, branch and currency are derived from that
 *   capture - none of them is accepted from the caller;
 * - cumulative refunds (pending, approved, processing and successful) cannot
 *   exceed the captured amount, so two open requests can never promise the same
 *   money twice;
 * - only SUCCESSFUL reduces the invoice. Failed, rejected, pending or
 *   unverified gateway outcomes move no money;
 * - offline refunds are confirmed by the authorised desk actor; gateway
 *   refunds call the adapter, and a timeout leaves the refund PROCESSING because
 *   the provider outcome is unknown - it is never optimistically successful;
 * - success updates the refund and recalculates the invoice header in one
 *   transaction through `recalculateInvoiceBalanceInTransaction`, the existing
 *   lifecycle write path. No invoice column is written here directly;
 * - the refund is append-only history: statuses change, rows are never deleted;
 * - idempotency uses a unique tenant+key and a canonical request hash, so a
 *   retry replays and a different request with the same key is a 409.
 *
 * Authorization is enforced by the route/controller layer (`payment:refund`).
 * The service enforces the business approval rule that a requester cannot
 * approve their own refund.
 */

const REFUND_STATUSES: readonly RefundStatus[] = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
  "FAILED",
  "REJECTED",
];

const RESERVED_REFUND_STATUSES: readonly RefundStatus[] = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 2_000;
const MAX_REFERENCE_LENGTH = 120;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROVIDER_REFUND_ID_LENGTH = 120;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field: string, message: string): AppError {
  return AppError.validation(message, { field });
}

function assertActor(actor: RefundActorContext): RefundActorContext {
  if (!actor || typeof actor.userId !== "string" || actor.userId.length === 0) {
    throw AppError.internal("A refund action requires an authenticated actor");
  }

  return actor;
}

function assertUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalid(field, `${field} must be a UUID`);
  }

  return value;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    throw invalid(field, `${field} must be text`);
  }

  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) {
    throw invalid(field, `${field} must be at most ${maxLength} characters`);
  }

  return text;
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  return optionalText(value, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
}

function requestHashOf(input: {
  readonly invoicePaymentId: string;
  readonly amount: string;
  readonly reason: string | null;
  readonly reference: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        invoicePaymentId: input.invoicePaymentId,
        amount: input.amount,
        reason: input.reason,
        reference: input.reference,
      }),
    )
    .digest("hex");
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

const refundSelection = {
  id: invoiceRefunds.id,
  invoiceId: invoiceRefunds.invoiceId,
  invoiceNumber: invoices.invoiceNumber,
  invoicePaymentId: invoiceRefunds.paymentId,
  receiptId: invoicePayments.paymentId,
  branchId: invoices.branchId,
  patientId: invoices.patientId,
  amount: invoiceRefunds.amount,
  currency: invoiceRefunds.currency,
  refundStatus: invoiceRefunds.refundStatus,
  reason: invoiceRefunds.reason,
  decisionReason: invoiceRefunds.decisionReason,
  reference: invoiceRefunds.reference,
  provider: invoiceRefunds.provider,
  gatewayProvider: paymentGatewayOrders.provider,
  providerRefundId: invoiceRefunds.providerRefundId,
  failureReason: invoiceRefunds.failureReason,
  requestedBy: invoiceRefunds.createdBy,
  approvedBy: invoiceRefunds.approvedBy,
  approvedAt: invoiceRefunds.approvedAt,
  processedAt: invoiceRefunds.processedAt,
  refundedAt: invoiceRefunds.refundedAt,
  createdAt: invoiceRefunds.createdAt,
  updatedAt: invoiceRefunds.updatedAt,
  gatewayOrderId: paymentGatewayOrders.id,
} as const;

function refundQuery(tx: DatabaseTransaction, tenantId: string) {
  return tx
    .select(refundSelection)
    .from(invoiceRefunds)
    .innerJoin(
      invoices,
      and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
    )
    .leftJoin(
      invoicePayments,
      and(
        eq(invoicePayments.tenantId, tenantId),
        eq(invoicePayments.id, invoiceRefunds.paymentId),
      ),
    )
    .leftJoin(
      payments,
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.id, invoicePayments.paymentId),
      ),
    )
    .leftJoin(
      paymentGatewayOrders,
      and(
        eq(paymentGatewayOrders.tenantId, tenantId),
        eq(paymentGatewayOrders.paymentId, payments.id),
      ),
    );
}

function toRefundDto(row: {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoicePaymentId: string | null;
  readonly receiptId: string | null;
  readonly branchId: string;
  readonly patientId: string;
  readonly amount: string;
  readonly currency: string;
  readonly refundStatus: RefundStatus;
  readonly reason: string | null;
  readonly decisionReason: string | null;
  readonly reference: string | null;
  readonly provider: string | null;
  readonly gatewayProvider: string | null;
  readonly providerRefundId: string | null;
  readonly failureReason: string | null;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly processedAt: Date | null;
  readonly refundedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly gatewayOrderId: string | null;
}): RefundDto {
  const channel: RefundChannel = row.gatewayOrderId === null ? "OFFLINE" : "GATEWAY";

  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    invoicePaymentId: row.invoicePaymentId,
    receiptId: row.receiptId,
    branchId: row.branchId,
    patientId: row.patientId,
    amount: row.amount,
    currency: row.currency,
    refundStatus: row.refundStatus,
    channel,
    reason: row.reason,
    decisionReason: row.decisionReason,
    reference: row.reference,
    provider: row.provider ?? row.gatewayProvider,
    providerRefundId: row.providerRefundId,
    failureReason: row.failureReason,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    processedAt: row.processedAt,
    refundedAt: row.refundedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSummary(dto: RefundDto): RefundSummaryDto {
  const { reason: _reason, decisionReason: _decision, failureReason: _failure, ...summary } =
    dto;
  return summary;
}

async function loadRefundDto(
  tx: DatabaseTransaction,
  tenantId: string,
  refundId: string,
): Promise<RefundDto | null> {
  const [row] = await refundQuery(tx, tenantId)
    .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, refundId)))
    .limit(1);

  return row ? toRefundDto(row) : null;
}

async function requireRefundDto(
  tx: DatabaseTransaction,
  tenantId: string,
  refundId: string,
): Promise<RefundDto> {
  const dto = await loadRefundDto(tx, tenantId, refundId);

  if (!dto) {
    throw AppError.internal("Failed to load the refund");
  }

  return dto;
}

interface RefundRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly refundStatus: RefundStatus;
  readonly reason: string | null;
  readonly reference: string | null;
  readonly provider: string | null;
  readonly providerRefundId: string | null;
  readonly requestedBy: string | null;
}

async function lockRefund(
  tx: DatabaseTransaction,
  tenantId: string,
  refundId: string,
): Promise<RefundRecord> {
  const [row] = await tx
    .select({
      id: invoiceRefunds.id,
      invoiceId: invoiceRefunds.invoiceId,
      paymentId: invoiceRefunds.paymentId,
      amount: invoiceRefunds.amount,
      currency: invoiceRefunds.currency,
      refundStatus: invoiceRefunds.refundStatus,
      reason: invoiceRefunds.reason,
      reference: invoiceRefunds.reference,
      provider: invoiceRefunds.provider,
      providerRefundId: invoiceRefunds.providerRefundId,
      requestedBy: invoiceRefunds.createdBy,
    })
    .from(invoiceRefunds)
    .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, refundId)))
    .for("update")
    .limit(1);

  if (!row) {
    throw AppError.notFound("Refund not found");
  }

  return row;
}

interface CaptureContext {
  readonly attempt: {
    readonly id: string;
    readonly invoiceId: string;
    readonly amount: string;
    readonly currency: string;
    readonly receiptId: string | null;
  };
  readonly invoice: {
    readonly id: string;
    readonly branchId: string;
    readonly patientId: string;
    readonly currency: string;
    readonly invoiceStatus: string;
  };
  readonly receipt: {
    readonly id: string;
    readonly branchId: string;
    readonly patientId: string;
    readonly currency: string;
    readonly paymentStatus: string;
  };
  readonly gatewayOrder: {
    readonly id: string;
    readonly provider: string;
    readonly providerOrderId: string;
    readonly providerTransactionReference: string | null;
    readonly status: string;
  } | null;
}

/**
 * Re-reads and validates the capture a refund reverses. Used by creation and
 * again by processing so a stale request cannot outlive a changed relationship.
 */
async function loadCaptureContext(
  tx: DatabaseTransaction,
  tenantId: string,
  refund: Pick<RefundRecord, "invoiceId" | "paymentId" | "currency">,
): Promise<CaptureContext> {
  if (refund.paymentId === null) {
    throw AppError.conflict("This refund is not linked to a successful payment capture");
  }

  const [attempt] = await tx
    .select({
      id: invoicePayments.id,
      invoiceId: invoicePayments.invoiceId,
      amount: invoicePayments.amount,
      currency: invoicePayments.currency,
      paymentStatus: invoicePayments.paymentStatus,
      receiptId: invoicePayments.paymentId,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.tenantId, tenantId),
        eq(invoicePayments.id, refund.paymentId),
        eq(invoicePayments.invoiceId, refund.invoiceId),
      ),
    )
    .limit(1);

  if (!attempt) {
    throw AppError.notFound("Payment capture not found");
  }

  if (attempt.paymentStatus !== "SUCCESSFUL") {
    throw AppError.conflict("Only a successfully captured payment can be refunded");
  }

  if (attempt.currency !== refund.currency) {
    throw AppError.conflict("Refund currency does not match the captured payment");
  }

  const [invoice] = await tx
    .select({
      id: invoices.id,
      branchId: invoices.branchId,
      patientId: invoices.patientId,
      currency: invoices.currency,
      invoiceStatus: invoices.invoiceStatus,
    })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, refund.invoiceId)))
    .limit(1);

  if (!invoice) {
    throw AppError.notFound("Invoice not found");
  }

  if (invoice.currency !== refund.currency) {
    throw AppError.conflict("Refund currency does not match the invoice");
  }

  if (invoice.invoiceStatus === "CANCELLED" || invoice.invoiceStatus === "DRAFT") {
    throw AppError.conflict("This invoice cannot carry a refund in its current state");
  }

  if (attempt.receiptId === null) {
    throw AppError.conflict("This payment capture is not linked to a receipt");
  }

  const [receipt] = await tx
    .select({
      id: payments.id,
      branchId: payments.branchId,
      patientId: payments.patientId,
      currency: payments.currency,
      paymentStatus: payments.paymentStatus,
    })
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, attempt.receiptId)))
    .limit(1);

  if (!receipt) {
    throw AppError.notFound("Payment receipt not found");
  }

  if (receipt.paymentStatus !== "SUCCESSFUL") {
    throw AppError.conflict("Only a successful receipt can be refunded");
  }

  if (receipt.branchId !== invoice.branchId || receipt.patientId !== invoice.patientId) {
    throw AppError.conflict(
      "The payment receipt does not match the invoice branch and patient",
    );
  }

  if (receipt.currency !== invoice.currency) {
    throw AppError.conflict("Receipt currency does not match the invoice currency");
  }

  const [gatewayOrder] = await tx
    .select({
      id: paymentGatewayOrders.id,
      provider: paymentGatewayOrders.provider,
      providerOrderId: paymentGatewayOrders.providerOrderId,
      providerTransactionReference: paymentGatewayOrders.providerTransactionReference,
      status: paymentGatewayOrders.status,
    })
    .from(paymentGatewayOrders)
    .where(
      and(
        eq(paymentGatewayOrders.tenantId, tenantId),
        eq(paymentGatewayOrders.paymentId, receipt.id),
      ),
    )
    .limit(1);

  if (gatewayOrder && gatewayOrder.status !== "SUCCEEDED") {
    throw AppError.conflict("The gateway capture is not confirmed; it cannot be refunded");
  }

  return {
    attempt: {
      id: attempt.id,
      invoiceId: attempt.invoiceId,
      amount: attempt.amount,
      currency: attempt.currency,
      receiptId: attempt.receiptId,
    },
    invoice,
    receipt,
    gatewayOrder: gatewayOrder ?? null,
  };
}

async function reservedRefundTotal(
  tx: DatabaseTransaction,
  tenantId: string,
  paymentId: string,
  excludeRefundId?: string,
): Promise<string> {
  const conditions: SQL[] = [
    eq(invoiceRefunds.tenantId, tenantId),
    eq(invoiceRefunds.paymentId, paymentId),
    inArray(invoiceRefunds.refundStatus, RESERVED_REFUND_STATUSES),
  ];

  if (excludeRefundId !== undefined) {
    conditions.push(sql`${invoiceRefunds.id} <> ${excludeRefundId}`);
  }

  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
    })
    .from(invoiceRefunds)
    .where(and(...conditions));

  return row?.total ?? "0.00";
}

async function finalizeSuccess(
  tx: DatabaseTransaction,
  tenantId: string,
  refund: RefundRecord,
  actor: RefundActorContext,
  evidence: {
    readonly provider: string | null;
    readonly providerRefundId: string | null;
    readonly reference: string | null;
  },
  now: Date,
): Promise<RefundDto> {
  await tx
    .update(invoiceRefunds)
    .set({
      refundStatus: "SUCCESSFUL",
      provider: evidence.provider,
      providerRefundId: evidence.providerRefundId,
      reference: evidence.reference,
      failureReason: null,
      refundedAt: now,
      processedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, refund.id)),
    );

  // The existing lifecycle path locks the invoice, re-reads the ledger and
  // derives PAID/PARTIALLY_PAID/REFUNDED. No invoice column is written directly.
  await recalculateInvoiceBalanceInTransaction(
    tx,
    tenantId,
    refund.invoiceId,
    actor,
    now,
  );

  recordRefundAudit(actor.audit, "refund.succeeded", {
    tenantId,
    actorUserId: actor.userId,
    refundId: refund.id,
    invoiceId: refund.invoiceId,
    paymentId: refund.paymentId ?? undefined,
    provider: evidence.provider ?? undefined,
  });

  await recordAuditSafely(tx, {
    tenantId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.REFUND_SUCCEEDED,
    module: "billing",
    resourceType: "refund",
    resourceId: refund.id,
    description: "Refund processed successfully",
    previousState: { status: refund.refundStatus },
    newState: { status: "SUCCESSFUL" },
    metadata: { invoiceId: refund.invoiceId, paymentId: refund.paymentId },
  });

  await enqueueBillingNotificationIntegrated(tx, tenantId, {
    event: "REFUND_SUCCEEDED",
    invoiceId: refund.invoiceId,
    paymentId: refund.paymentId ?? undefined,
    refundId: refund.id,
    dedupeKey: `refund-succeeded:${refund.id}`,
  });

  return requireRefundDto(tx, tenantId, refund.id);
}

async function finalizeFailure(
  tx: DatabaseTransaction,
  tenantId: string,
  refund: RefundRecord,
  actor: RefundActorContext,
  failureReason: string,
  evidence: {
    readonly provider: string | null;
    readonly providerRefundId: string | null;
    readonly reference: string | null;
  },
  now: Date,
): Promise<RefundDto> {
  await tx
    .update(invoiceRefunds)
    .set({
      refundStatus: "FAILED",
      provider: evidence.provider,
      providerRefundId: evidence.providerRefundId,
      reference: evidence.reference,
      failureReason,
      processedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, refund.id)),
    );

  recordRefundAudit(actor.audit, "refund.failed", {
    tenantId,
    actorUserId: actor.userId,
    refundId: refund.id,
    invoiceId: refund.invoiceId,
    paymentId: refund.paymentId ?? undefined,
    provider: evidence.provider ?? undefined,
    reason: failureReason,
  });

  await recordAuditSafely(tx, {
    tenantId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.REFUND_FAILED,
    module: "billing",
    resourceType: "refund",
    resourceId: refund.id,
    description: "Refund processing failed",
    previousState: { status: refund.refundStatus },
    newState: { status: "FAILED" },
    metadata: { invoiceId: refund.invoiceId, paymentId: refund.paymentId },
  });

  await enqueueBillingNotificationIntegrated(tx, tenantId, {
    event: "REFUND_FAILED",
    invoiceId: refund.invoiceId,
    paymentId: refund.paymentId ?? undefined,
    refundId: refund.id,
    dedupeKey: `refund-failed:${refund.id}`,
  });

  return requireRefundDto(tx, tenantId, refund.id);
}

/**
 * Creates a refund request after validating the capture and reserving the
 * amount. A retried idempotency key replays the original request.
 */
export async function createRefundRequest(
  tenantId: string,
  input: CreateRefundRequestInput,
  actor: RefundActorContext,
): Promise<CreateRefundRequestResult> {
  const staff = assertActor(actor);
  const invoicePaymentId = assertUuid(input.invoicePaymentId, "invoicePaymentId");
  const amount = normalizeMoney(input.amount, "amount");

  if (compareMoney(amount, "0.00") <= 0) {
    throw invalid("amount", "Refund amount must be greater than zero");
  }

  const reason = optionalText(input.reason, "reason", MAX_REASON_LENGTH);
  const reference = optionalText(input.reference, "reference", MAX_REFERENCE_LENGTH);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestHash = requestHashOf({ invoicePaymentId, amount, reason, reference });

  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      if (idempotencyKey !== null) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`refund-create:${tenantId}:${idempotencyKey}`}, 0))`,
        );

        const [existing] = await tx
          .select({ id: invoiceRefunds.id, requestHash: invoiceRefunds.requestHash })
          .from(invoiceRefunds)
          .where(
            and(
              eq(invoiceRefunds.tenantId, tenantId),
              eq(invoiceRefunds.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);

        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw AppError.conflict(
              "This idempotency key was already used for a different refund request",
            );
          }

          recordRefundAudit(staff.audit, "refund.requested", {
            tenantId,
            actorUserId: staff.userId,
            refundId: existing.id,
            reason: "IDEMPOTENT_REPLAY",
          });

          await recordAuditSafely(tx, {
            tenantId,
            actorUserId: staff.userId,
            action: AUDIT_ACTIONS.REFUND_REQUESTED,
            module: "billing",
            resourceType: "refund",
            resourceId: existing.id,
            description: "Refund request replayed",
            dedupeKey: `refund-requested:${tenantId}:${existing.id}`,
          });

          return {
            replayed: true,
            refund: await requireRefundDto(tx, tenantId, existing.id),
          };
        }
      }

      // Serializes concurrent requests for the same capture so both cannot pass
      // the cumulative limit from a stale read.
      const [attempt] = await tx
        .select({
          id: invoicePayments.id,
          invoiceId: invoicePayments.invoiceId,
          amount: invoicePayments.amount,
          currency: invoicePayments.currency,
          paymentStatus: invoicePayments.paymentStatus,
          receiptId: invoicePayments.paymentId,
        })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.tenantId, tenantId),
            eq(invoicePayments.id, invoicePaymentId),
          ),
        )
        .for("update")
        .limit(1);

      if (!attempt) {
        throw AppError.notFound("Payment capture not found");
      }

      if (attempt.paymentStatus !== "SUCCESSFUL") {
        throw AppError.conflict("Only a successfully captured payment can be refunded");
      }

      if (attempt.receiptId === null) {
        throw AppError.conflict("This payment capture is not linked to a receipt");
      }

      const [invoice] = await tx
        .select({
          id: invoices.id,
          currency: invoices.currency,
          invoiceStatus: invoices.invoiceStatus,
          branchId: invoices.branchId,
          patientId: invoices.patientId,
        })
        .from(invoices)
        .where(
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, attempt.invoiceId)),
        )
        .limit(1);

      if (!invoice) {
        throw AppError.notFound("Invoice not found");
      }

      if (invoice.currency !== attempt.currency) {
        throw AppError.conflict("Payment and invoice currencies do not match");
      }

      if (invoice.invoiceStatus === "CANCELLED" || invoice.invoiceStatus === "DRAFT") {
        throw AppError.conflict("This invoice cannot carry a refund in its current state");
      }

      const [receipt] = await tx
        .select({
          id: payments.id,
          branchId: payments.branchId,
          patientId: payments.patientId,
          currency: payments.currency,
          paymentStatus: payments.paymentStatus,
        })
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), eq(payments.id, attempt.receiptId)))
        .limit(1);

      if (!receipt) {
        throw AppError.notFound("Payment receipt not found");
      }

      if (receipt.paymentStatus !== "SUCCESSFUL") {
        throw AppError.conflict("Only a successful receipt can be refunded");
      }

      if (
        receipt.branchId !== invoice.branchId ||
        receipt.patientId !== invoice.patientId ||
        receipt.currency !== invoice.currency
      ) {
        throw AppError.conflict(
          "The payment receipt does not match the invoice branch, patient and currency",
        );
      }

      const reserved = await reservedRefundTotal(tx, tenantId, attempt.id);

      if (compareMoney(addMoney([reserved, amount]), attempt.amount) > 0) {
        throw AppError.validation(
          "Cumulative refunds would exceed the captured payment amount",
          {
            field: "amount",
            reason: "REFUND_EXCEEDS_CAPTURED_AMOUNT",
            capturedAmount: attempt.amount,
            alreadyRefundedOrReserved: reserved,
            requested: amount,
          },
        );
      }

      const [inserted] = await tx
        .insert(invoiceRefunds)
        .values({
          tenantId,
          invoiceId: attempt.invoiceId,
          paymentId: attempt.id,
          amount,
          currency: attempt.currency,
          refundStatus: "PENDING",
          reason,
          reference,
          idempotencyKey,
          requestHash,
          createdBy: staff.userId,
        })
        .returning({ id: invoiceRefunds.id });

      if (!inserted) {
        throw AppError.internal("Failed to create the refund request");
      }

      recordRefundAudit(staff.audit, "refund.requested", {
        tenantId,
        actorUserId: staff.userId,
        refundId: inserted.id,
        invoiceId: attempt.invoiceId,
        paymentId: attempt.id,
      });

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: staff.userId,
        action: AUDIT_ACTIONS.REFUND_REQUESTED,
        module: "billing",
        resourceType: "refund",
        resourceId: inserted.id,
        description: "Refund requested",
        metadata: { invoiceId: attempt.invoiceId, paymentId: attempt.id },
        dedupeKey: `refund-requested:${tenantId}:${inserted.id}`,
      });

      return {
        replayed: false,
        refund: await requireRefundDto(tx, tenantId, inserted.id),
      };
    });
  } catch (error) {
    const { code, constraint } = pgErrorInfo(error);

    if (code === "23505" && constraint === "invoice_refunds_tenant_reference_unique") {
      throw AppError.conflict("A refund with this reference already exists in this hospital");
    }

    if (code === "23505" && constraint === "invoice_refunds_tenant_idempotency_key_unique") {
      throw AppError.conflict("This idempotency key is already in use");
    }

    throw error;
  }
}

export async function getRefundById(
  tenantId: string,
  refundId: string,
): Promise<RefundDto> {
  const id = assertUuid(refundId, "refundId");

  return withTenantTransaction(tenantId, async (tx) => {
    const refund = await loadRefundDto(tx, tenantId, id);

    if (!refund) {
      throw AppError.notFound("Refund not found");
    }

    return refund;
  });
}

/** Refund history for a tenant, newest request first. */
export async function listRefunds(
  tenantId: string,
  filters: ListRefundsFilters = {},
): Promise<RefundListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  if (filters.status !== undefined && !REFUND_STATUSES.includes(filters.status)) {
    throw invalid("status", "Unknown refund status");
  }

  const fromDate =
    filters.fromDate === undefined ? undefined : normalizeDate(filters.fromDate, "fromDate");
  const toDate =
    filters.toDate === undefined ? undefined : normalizeDate(filters.toDate, "toDate");

  if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
    throw invalid("fromDate", "fromDate cannot be after toDate");
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions: SQL[] = [eq(invoiceRefunds.tenantId, tenantId)];

    if (filters.invoiceId !== undefined) {
      conditions.push(
        eq(invoiceRefunds.invoiceId, assertUuid(filters.invoiceId, "invoiceId")),
      );
    }
    if (filters.paymentId !== undefined) {
      conditions.push(
        eq(invoiceRefunds.paymentId, assertUuid(filters.paymentId, "paymentId")),
      );
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(invoices.branchId, assertUuid(filters.branchId, "branchId")));
    }
    if (filters.patientId !== undefined) {
      conditions.push(eq(invoices.patientId, assertUuid(filters.patientId, "patientId")));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(invoiceRefunds.refundStatus, filters.status));
    }
    if (fromDate !== undefined) {
      conditions.push(
        gte(invoiceRefunds.createdAt, new Date(`${fromDate}T00:00:00.000Z`)),
      );
    }
    if (toDate !== undefined) {
      const exclusive = new Date(`${toDate}T00:00:00.000Z`);
      exclusive.setUTCDate(exclusive.getUTCDate() + 1);
      conditions.push(lt(invoiceRefunds.createdAt, exclusive));
    }

    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      refundQuery(tx, tenantId)
        .where(where)
        .orderBy(desc(invoiceRefunds.createdAt), asc(invoiceRefunds.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(
            eq(invoices.tenantId, tenantId),
            eq(invoices.id, invoiceRefunds.invoiceId),
          ),
        )
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      refunds: rows.map((row) => toSummary(toRefundDto(row))),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

/** Approves a pending request. The requester cannot approve their own refund. */
export async function approveRefund(
  tenantId: string,
  refundId: string,
  input: RefundDecisionInput,
  actor: RefundActorContext,
): Promise<RefundDto> {
  const staff = assertActor(actor);
  const id = assertUuid(refundId, "refundId");
  const decisionReason = optionalText(input.reason, "reason", MAX_REASON_LENGTH);

  return withTenantTransaction(tenantId, async (tx) => {
    const refund = await lockRefund(tx, tenantId, id);

    if (refund.refundStatus !== "PENDING") {
      throw AppError.conflict("Only a pending refund can be approved");
    }

    if (refund.requestedBy !== null && refund.requestedBy === staff.userId) {
      throw AppError.conflict("A refund requester cannot approve their own request");
    }

    // Re-check the live capture and cumulative limit before approving: an
    // expired/corrupted capture must not gain approval. The current refund is
    // included in the reserved total here because it is still PENDING.
    const context = await loadCaptureContext(tx, tenantId, refund);
    const reserved = await reservedRefundTotal(
      tx,
      tenantId,
      refund.paymentId as string,
    );

    if (compareMoney(reserved, context.attempt.amount) > 0) {
      throw AppError.conflict("This refund no longer fits within the captured amount");
    }

    const now = new Date();

    await tx
      .update(invoiceRefunds)
      .set({
        refundStatus: "APPROVED",
        decisionReason,
        approvedBy: staff.userId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)));

    recordRefundAudit(staff.audit, "refund.approved", {
      tenantId,
      actorUserId: staff.userId,
      refundId: id,
      invoiceId: refund.invoiceId,
      paymentId: refund.paymentId ?? undefined,
    });

    await recordAuditSafely(tx, {
      tenantId,
      actorUserId: staff.userId,
      action: AUDIT_ACTIONS.REFUND_APPROVED,
      module: "billing",
      resourceType: "refund",
      resourceId: id,
      description: "Refund approved",
      previousState: { status: "PENDING" },
      newState: { status: "APPROVED" },
      metadata: { invoiceId: refund.invoiceId, paymentId: refund.paymentId },
    });

    return requireRefundDto(tx, tenantId, id);
  });
}

/** Rejects a pending request; terminal and never processed. */
export async function rejectRefund(
  tenantId: string,
  refundId: string,
  input: RefundDecisionInput,
  actor: RefundActorContext,
): Promise<RefundDto> {
  const staff = assertActor(actor);
  const id = assertUuid(refundId, "refundId");
  const decisionReason = optionalText(input.reason, "reason", MAX_REASON_LENGTH);

  return withTenantTransaction(tenantId, async (tx) => {
    const refund = await lockRefund(tx, tenantId, id);

    if (refund.refundStatus !== "PENDING") {
      throw AppError.conflict("Only a pending refund can be rejected");
    }

    const now = new Date();

    await tx
      .update(invoiceRefunds)
      .set({
        refundStatus: "REJECTED",
        decisionReason,
        processedAt: now,
        updatedAt: now,
      })
      .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)));

    recordRefundAudit(staff.audit, "refund.rejected", {
      tenantId,
      actorUserId: staff.userId,
      refundId: id,
      invoiceId: refund.invoiceId,
      paymentId: refund.paymentId ?? undefined,
    });

    await recordAuditSafely(tx, {
      tenantId,
      actorUserId: staff.userId,
      action: AUDIT_ACTIONS.REFUND_REJECTED,
      module: "billing",
      resourceType: "refund",
      resourceId: id,
      description: "Refund rejected",
      previousState: { status: "PENDING" },
      newState: { status: "REJECTED" },
      metadata: { invoiceId: refund.invoiceId, paymentId: refund.paymentId },
    });

    return requireRefundDto(tx, tenantId, id);
  });
}

interface GatewayPreparation {
  readonly refund: RefundRecord;
  readonly provider: PaymentGatewayProviderName;
  readonly providerOrderId: string;
  readonly providerTransactionReference: string | null;
}

/**
 * Processes an approved refund.
 *
 * Offline captures are confirmed by the authorised desk actor. Gateway captures
 * are sent to the provider adapter: a rejection becomes FAILED, a timeout stays
 * PROCESSING (the provider outcome is unknown), and only a verified SUCCESSFUL
 * result updates the invoice through the lifecycle service.
 */
export async function processRefund(
  tenantId: string,
  refundId: string,
  input: ProcessRefundInput,
  actor: RefundActorContext,
  dependencies: ProcessRefundDependencies = {},
): Promise<RefundDto> {
  const staff = assertActor(actor);
  const id = assertUuid(refundId, "refundId");
  const deskReference = optionalText(
    input.reference,
    "reference",
    MAX_REFERENCE_LENGTH,
  );

  const preparation = await withTenantTransaction(tenantId, async (tx) => {
    const refund = await lockRefund(tx, tenantId, id);

    if (refund.refundStatus === "SUCCESSFUL") {
      return { done: true as const, refund: await requireRefundDto(tx, tenantId, id) };
    }

    if (refund.refundStatus !== "APPROVED" && refund.refundStatus !== "FAILED") {
      throw AppError.conflict(
        refund.refundStatus === "PROCESSING"
          ? "This refund is already being processed; verify its outcome before retrying"
          : "Only an approved or failed refund can be processed",
      );
    }

    const context = await loadCaptureContext(tx, tenantId, refund);

    if (!context.gatewayOrder) {
      // Offline desk refund: the authorised actor has handed the money back.
      const completed = await finalizeSuccess(
        tx,
        tenantId,
        refund,
        staff,
        {
          provider: null,
          providerRefundId: null,
          reference: deskReference ?? refund.reference,
        },
        new Date(),
      );

      return { done: true as const, refund: completed };
    }

    const provider = context.gatewayOrder.provider as PaymentGatewayProviderName;
    const now = new Date();

    await tx
      .update(invoiceRefunds)
      .set({
        refundStatus: "PROCESSING",
        provider,
        reference: deskReference ?? refund.reference,
        failureReason: null,
        updatedAt: now,
      })
      .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)));

    recordRefundAudit(staff.audit, "refund.processing", {
      tenantId,
      actorUserId: staff.userId,
      refundId: id,
      invoiceId: refund.invoiceId,
      paymentId: refund.paymentId ?? undefined,
      provider,
    });

    return {
      done: false as const,
      prepared: {
        refund,
        provider,
        providerOrderId: context.gatewayOrder.providerOrderId,
        providerTransactionReference:
          context.gatewayOrder.providerTransactionReference,
      } satisfies GatewayPreparation,
    };
  });

  if (preparation.done) return preparation.refund;

  const prepared = preparation.prepared;
  const config = paymentGatewayConfigFromEnv();
  const gateway: PaymentGateway =
    dependencies.gateway ??
    createPaymentGateway({ ...config, provider: prepared.provider });

  let outcome: GatewayRefundResult | null = null;
  let failureReason: string | null = null;
  let timedOut = false;

  try {
    const raw = await withGatewayTimeout(
      gateway.refund({
        tenantId,
        refundId: id,
        paymentId: prepared.refund.paymentId as string,
        providerOrderId: prepared.providerOrderId,
        providerTransactionReference: prepared.providerTransactionReference,
        amount: prepared.refund.amount,
        currency: prepared.refund.currency,
        reason: prepared.refund.reason,
      }),
      gateway.provider,
      config.timeoutMs,
    );

    if (
      raw.provider !== prepared.provider ||
      typeof raw.refundId !== "string" ||
      raw.refundId.trim().length === 0 ||
      raw.refundId.length > MAX_PROVIDER_REFUND_ID_LENGTH ||
      !["SUCCESSFUL", "PENDING", "FAILED"].includes(raw.status)
    ) {
      failureReason = "Provider returned an invalid refund response";
    } else {
      outcome = raw;
    }
  } catch (error) {
    if (error instanceof PaymentGatewayTimeoutError) {
      timedOut = true;
      failureReason = "Provider timeout; the refund outcome is unverified";
    } else {
      failureReason = "Provider error while processing the refund";
    }

    logger.warn(
      {
        event: "refund.gateway_failed",
        tenantId,
        refundId: id,
        provider: prepared.provider,
        reason: timedOut ? "PAYMENT_GATEWAY_TIMEOUT" : "PAYMENT_GATEWAY_ERROR",
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "refund gateway call failed",
    );
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const refund = await lockRefund(tx, tenantId, id);

    if (refund.refundStatus === "SUCCESSFUL") {
      return requireRefundDto(tx, tenantId, id);
    }

    if (refund.refundStatus !== "PROCESSING") {
      throw AppError.conflict("The refund is no longer in a processable state");
    }

    const now = new Date();
    const reference = deskReference ?? refund.reference;

    if (timedOut) {
      // Unknown provider outcome must not be recorded as success. Keep the row
      // PROCESSING for reconciliation/retry and store the unverified reason.
      await tx
        .update(invoiceRefunds)
        .set({ failureReason, updatedAt: now })
        .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)));

      return requireRefundDto(tx, tenantId, id);
    }

    if (outcome === null) {
      return finalizeFailure(
        tx,
        tenantId,
        refund,
        staff,
        failureReason ?? "Provider refund failed",
        {
          provider: prepared.provider,
          providerRefundId: null,
          reference,
        },
        now,
      );
    }

    if (outcome.status === "PENDING") {
      await tx
        .update(invoiceRefunds)
        .set({
          provider: prepared.provider,
          providerRefundId: outcome.refundId,
          reference: outcome.transactionReference ?? reference,
          failureReason: null,
          updatedAt: now,
        })
        .where(and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)));

      recordRefundAudit(staff.audit, "refund.processing", {
        tenantId,
        actorUserId: staff.userId,
        refundId: id,
        invoiceId: refund.invoiceId,
        paymentId: refund.paymentId ?? undefined,
        provider: prepared.provider,
        reason: "PROVIDER_PENDING",
      });

      return requireRefundDto(tx, tenantId, id);
    }

    if (outcome.status === "FAILED") {
      return finalizeFailure(
        tx,
        tenantId,
        refund,
        staff,
        "Provider declined the refund",
        {
          provider: prepared.provider,
          providerRefundId: outcome.refundId,
          reference: outcome.transactionReference ?? reference,
        },
        now,
      );
    }

    return finalizeSuccess(
      tx,
      tenantId,
      refund,
      staff,
      {
        provider: prepared.provider,
        providerRefundId: outcome.refundId,
        reference: outcome.transactionReference ?? reference,
      },
      now,
    );
  });
}
