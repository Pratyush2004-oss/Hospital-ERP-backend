import type {
  DecimalInput,
  InvoicePaymentStatus,
} from "./invoice-calculation.types.js";
import type { InvoiceActorContext, InvoiceBalanceDto } from "./invoice.types.js";

/**
 * Payment recording contracts (Task 19.4.1).
 *
 * A payment is a receipt-level record of money taken at the desk. Amounts are
 * decimal strings (or numbers for convenience) and are normalized to the same
 * fixed 2-decimal form as the `NUMERIC(12, 2)` columns; they are never treated
 * as floats.
 *
 * `receivedBy` is deliberately absent: it comes from the authenticated actor,
 * never from the request body.
 */

/** Methods supported by the `payment_method` enum. */
export type PaymentMethod =
  | "CASH"
  | "CARD"
  | "UPI"
  | "BANK_TRANSFER"
  | "CHEQUE"
  | "OTHER";

/** Manual collections are stored as SUCCESSFUL; the other states stay readable. */
export type PaymentStatus = InvoicePaymentStatus;

/** Authenticated staff member receiving the money. */
export type PaymentActorContext = InvoiceActorContext;

export interface PaymentAllocationInput {
  readonly invoiceId: string;
  /** Amount applied to this invoice; must be positive. */
  readonly amount: DecimalInput;
}

export interface RecordPaymentInput {
  readonly branchId: string;
  readonly patientId: string;
  readonly method: PaymentMethod;
  /** Total collected; must equal the sum of `allocations` exactly. */
  readonly amount: DecimalInput;
  /** Optional ISO 4217 code; must match every allocated invoice. */
  readonly currency?: string | null;
  /** Receipt number, UPI/bank reference or cheque number. Unique per tenant. */
  readonly reference?: string | null;
  readonly notes?: string | null;
  /** When the money was received; defaults to now and cannot be in the future. */
  readonly receivedAt?: Date | string | null;
  /** Client retry key; a repeated request replays the original payment. */
  readonly idempotencyKey?: string | null;
  readonly allocations: readonly PaymentAllocationInput[];
}

export interface PaymentAllocationDto {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly amount: string;
}

export interface PaymentDto {
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
  readonly allocations: readonly PaymentAllocationDto[];
}

/** List rows omit allocation detail and free-text notes. */
export type PaymentSummaryDto = Omit<PaymentDto, "allocations" | "notes">;

export interface ListPaymentsFilters {
  readonly patientId?: string;
  readonly branchId?: string;
  readonly method?: PaymentMethod;
  readonly status?: InvoicePaymentStatus;
  /** Exact receipt/UTR/cheque reference match. */
  readonly reference?: string;
  /** Inclusive lower bound on the received date (`YYYY-MM-DD`, UTC). */
  readonly fromDate?: string;
  /** Inclusive upper bound on the received date (`YYYY-MM-DD`, UTC). */
  readonly toDate?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PaymentListResult {
  readonly payments: readonly PaymentSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface RecordPaymentResult {
  /** `true` when a retried idempotency key replayed an existing payment. */
  readonly replayed: boolean;
  readonly payment: PaymentDto;
  /** Post-payment balance of every allocated invoice. */
  readonly invoiceBalances: readonly InvoiceBalanceDto[];
}

/**
 * Integrity problems `reconcilePayment` can find (Task 19.4.2). Codes, not
 * messages, are the stable contract; amounts are echoed for investigation.
 */
export type PaymentReconciliationIssueCode =
  /** A receipt that is not SUCCESSFUL still holds allocations or settlements. */
  | "INELIGIBLE_PAYMENT_STATUS"
  /** Allocations do not add up to the receipt amount. */
  | "ALLOCATION_TOTAL_MISMATCH"
  /** A payment-linked settlement is not SUCCESSFUL and settles nothing. */
  | "INELIGIBLE_SETTLEMENT_STATUS"
  /** An allocation has no settlement row on its invoice. */
  | "MISSING_SETTLEMENT"
  /** The settlement recorded a different amount than the allocation. */
  | "SETTLEMENT_AMOUNT_MISMATCH"
  /** More than one settlement exists for the same receipt and invoice. */
  | "DUPLICATE_SETTLEMENT"
  /** A settlement points at an invoice the receipt did not allocate. */
  | "ORPHAN_SETTLEMENT"
  /** An allocated invoice is no longer visible in this tenant. */
  | "INVOICE_NOT_FOUND"
  /** The invoice belongs to a different patient than the receipt. */
  | "PATIENT_MISMATCH"
  /** The invoice belongs to a different branch than the receipt. */
  | "BRANCH_MISMATCH"
  /** The invoice header cannot be repaired under the lifecycle rules. */
  | "INVOICE_RECONCILIATION_FAILED";

export interface PaymentReconciliationIssue {
  readonly code: PaymentReconciliationIssueCode;
  readonly invoiceId?: string;
  /** Amount involved, as a fixed 2-decimal string. */
  readonly amount?: string;
  readonly expected?: string;
  readonly actual?: string;
  /** Safe, non-identifying explanation. */
  readonly message: string;
  /** HTTP status the equivalent operation would fail with, when applicable. */
  readonly statusCode?: number;
}

/**
 * Outcome of reconciling one receipt against its allocations, settlements and
 * invoice headers. `consistent: false` means the ledgers disagree and a human
 * must investigate; header drift on invoices is repaired in place.
 */
export interface PaymentReconciliationResult {
  readonly paymentId: string;
  readonly patientId: string;
  readonly branchId: string;
  readonly paymentMethod: PaymentMethod;
  readonly paymentStatus: PaymentStatus;
  readonly currency: string;
  /** Receipt amount. */
  readonly amount: string;
  /** Sum of `payment_allocations`. */
  readonly allocatedTotal: string;
  /** Sum of settlement rows linked to this receipt. */
  readonly settledTotal: string;
  readonly consistent: boolean;
  readonly issues: readonly PaymentReconciliationIssue[];
  /** Post-reconciliation balance of every invoice the receipt touches. */
  readonly invoiceBalances: readonly InvoiceBalanceDto[];
  /** Number of invoice headers this call repaired (idempotent when 0). */
  readonly repairedInvoices: number;
}
