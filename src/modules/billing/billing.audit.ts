import { logger } from "../../lib/logger.js";

/**
 * Billing audit sink (Task 19.3.1).
 *
 * The project's existing audit mechanism is the structured logger, shared with
 * the patient module (`patient.audit.ts`). Invoice issue, cancellation, status
 * changes and payment-derived balance recalculations are recorded here so every
 * billing lifecycle event uses one vocabulary instead of ad-hoc log lines.
 *
 * Privacy rules for details:
 * - identifiers and statuses only (tenant, actor, invoice, previous/new status);
 * - a list of changed field NAMES, never their values or amounts;
 * - never a patient name, contact detail, card reference or provider secret.
 *
 * Audit must never fail a completed financial operation, so
 * `recordInvoiceAudit` swallows sink errors and logs a warning instead of
 * propagating them.
 */

export type BillingAuditEvent =
  | "invoice.issued"
  | "invoice.cancelled"
  | "invoice.status_changed"
  | "invoice.balance_recalculated"
  | "invoice.reconciled"
  | "payment.recorded"
  | "payment.replayed"
  | "payment.reconciled"
  | "payment.initiated"
  | "payment.initiation_replayed"
  | "payment.initiation_failed"
  | "refund.requested"
  | "refund.approved"
  | "refund.rejected"
  | "refund.processing"
  | "refund.succeeded"
  | "refund.failed"
  | "billing_document.generated"
  | "billing_document.reused"
  | "billing_document.generation_failed"
  | "billing_document.download_url_issued"
  | "billing_document.downloaded";

/** Non-identifying audit context. See the privacy rules above. */
export interface BillingAuditDetails {
  readonly tenantId?: string;
  readonly actorUserId?: string | null;
  readonly invoiceId?: string;
  readonly invoiceNumber?: string;
  readonly paymentId?: string;
  /** Refund request/transaction id. */
  readonly refundId?: string;
  /** Generated billing document id and kind; never its storage key. */
  readonly documentId?: string;
  readonly documentType?: string;
  readonly patientId?: string;
  readonly branchId?: string;
  readonly paymentMethod?: string;
  /** Gateway registry key; never an endpoint, key or provider payload. */
  readonly provider?: string;
  /** Invoices settled by a payment. Identifiers only, never amounts. */
  readonly invoiceIds?: readonly string[];
  readonly from?: string | null;
  readonly to?: string | null;
  /** Names of the fields that changed, never their values. */
  readonly fields?: readonly string[];
  /** Payment reconciliation outcome; issue codes only, never amounts. */
  readonly consistent?: boolean;
  readonly issueCodes?: readonly string[];
  readonly reason?: string | null;
}

export interface BillingAuditSink {
  record(event: BillingAuditEvent, details?: BillingAuditDetails): void;
}

/** Default sink: one structured log line per event. */
export const loggerBillingAuditSink: BillingAuditSink = {
  record(event, details) {
    logger.info({ event, ...details }, "billing audit event");
  },
};

export function resolveBillingAuditSink(sink?: BillingAuditSink): BillingAuditSink {
  return sink ?? loggerBillingAuditSink;
}

/** Records an event, never letting an audit failure break the caller. */
export function recordBillingAudit(
  sink: BillingAuditSink | undefined,
  event: BillingAuditEvent,
  details: BillingAuditDetails,
): void {
  try {
    resolveBillingAuditSink(sink).record(event, details);
  } catch {
    logger.warn({ event }, "billing audit sink failed");
  }
}

/** Invoice lifecycle events (kept as a named alias for existing call sites). */
export const recordInvoiceAudit = recordBillingAudit;

/** Payment receipt events; same sink and privacy rules as invoice events. */
export const recordPaymentAudit = recordBillingAudit;

/** Refund lifecycle events; same sink and privacy rules as invoice events. */
export const recordRefundAudit = recordBillingAudit;
