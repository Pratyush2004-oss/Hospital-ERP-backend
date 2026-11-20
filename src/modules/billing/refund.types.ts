import type { BillingAuditSink } from "./billing.audit.js";
import type { PaymentGateway } from "./gateway/payment-gateway.types.js";
import type { DecimalInput } from "./invoice-calculation.types.js";
import type { InvoiceActorContext } from "./invoice.types.js";

/**
 * Refund service contracts (Phase 19.7.1).
 *
 * A refund is always tied to one successful `invoice_payments` capture. The
 * client supplies only that id, an amount and free-text evidence; tenant,
 * invoice, patient, branch, currency and channel are derived from the stored
 * capture. `SUCCESSFUL` is the schema's name for the business "SUCCESS" state.
 */
export type RefundStatus =
  | "PENDING"
  | "APPROVED"
  | "PROCESSING"
  | "SUCCESSFUL"
  | "FAILED"
  | "REJECTED";

/** How the money is returned. Derived from whether the capture has a gateway order. */
export type RefundChannel = "GATEWAY" | "OFFLINE";

export type RefundActorContext = InvoiceActorContext;

export interface CreateRefundRequestInput {
  /** The successful `invoice_payments` capture being reversed. */
  readonly invoicePaymentId: string;
  /** Full or partial amount; must be positive and within the refundable remainder. */
  readonly amount: DecimalInput;
  /** Why the refund is requested; preserved verbatim (never clinical data). */
  readonly reason?: string | null;
  /** External/desk refund reference, when known at request time. */
  readonly reference?: string | null;
  /** Client retry key; a repeated request replays the original refund. */
  readonly idempotencyKey?: string | null;
}

export interface RefundDecisionInput {
  readonly reason?: string | null;
}

export interface ProcessRefundInput {
  /** Final desk voucher / provider reference, when the caller already has it. */
  readonly reference?: string | null;
}

export interface RefundDto {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** The `invoice_payments` capture this refund reverses. */
  readonly invoicePaymentId: string | null;
  /** The receipt-level `payments` row behind the capture, when linked. */
  readonly receiptId: string | null;
  readonly branchId: string;
  readonly patientId: string;
  readonly amount: string;
  readonly currency: string;
  readonly refundStatus: RefundStatus;
  readonly channel: RefundChannel;
  readonly reason: string | null;
  readonly decisionReason: string | null;
  readonly reference: string | null;
  readonly provider: string | null;
  readonly providerRefundId: string | null;
  readonly failureReason: string | null;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly processedAt: Date | null;
  readonly refundedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** List rows omit free-text decision/failure detail. */
export type RefundSummaryDto = Omit<
  RefundDto,
  "reason" | "decisionReason" | "failureReason"
>;

export interface ListRefundsFilters {
  readonly invoiceId?: string;
  /** One `invoice_payments` capture. */
  readonly paymentId?: string;
  readonly branchId?: string;
  readonly patientId?: string;
  readonly status?: RefundStatus;
  /** Inclusive lower bound on the request date (`YYYY-MM-DD`, UTC). */
  readonly fromDate?: string;
  /** Inclusive upper bound on the request date (`YYYY-MM-DD`, UTC). */
  readonly toDate?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface RefundListResult {
  readonly refunds: readonly RefundSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface CreateRefundRequestResult {
  readonly replayed: boolean;
  readonly refund: RefundDto;
}

/** Injection seam for tests; production resolves the configured gateway. */
export interface ProcessRefundDependencies {
  readonly gateway?: PaymentGateway;
  readonly audit?: BillingAuditSink;
}
