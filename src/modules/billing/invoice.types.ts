import type { BillingAuditSink } from "./billing.audit.js";
import type { DecimalInput } from "./invoice-calculation.types.js";

/**
 * Invoice service contracts (Task 19.2.2).
 *
 * Only identifiers, descriptions and pricing inputs are accepted from the
 * caller. Totals, tax amounts, discounts and balances are always computed by
 * `calculateInvoice` from the line items; a client-supplied total is never part
 * of the input contract.
 *
 * Money and quantities are decimal strings (or numbers for convenience) so the
 * caller cannot accidentally pass a JavaScript float as the source of truth.
 */

export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED"
  | "REFUNDED";

/**
 * Statuses a caller may request explicitly (Task 19.3.1). PARTIALLY_PAID and
 * PAID are derived from successful payment records and cannot be set by hand.
 */
export type ManualInvoiceStatus = "ISSUED" | "OVERDUE" | "CANCELLED" | "REFUNDED";

/** Authenticated staff member performing an invoice lifecycle action. */
export interface InvoiceActorContext {
  readonly userId: string;
  /** Optional audit sink override; defaults to the structured logger. */
  readonly audit?: BillingAuditSink;
}

export interface UpdateInvoiceStatusInput {
  readonly status: ManualInvoiceStatus;
  /** Stored on the audit event only; never a clinical note. */
  readonly reason?: string | null;
}

export interface CancelInvoiceInput {
  readonly reason?: string | null;
}

/**
 * Balance state of one invoice. Amounts are fixed 2-decimal strings taken from
 * the persisted header and the successful payment/refund records.
 */
export interface InvoiceBalanceDto {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly currency: string;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly totalAmount: string;
  /** Net settled money: successful payments minus successful refunds. */
  readonly amountPaid: string;
  readonly refundedAmount: string;
  readonly balanceDue: string;
}

export interface InvoiceLifecycleResult {
  readonly invoice: InvoiceDto;
  readonly balance: InvoiceBalanceDto;
  /** `false` when the invoice was already in the requested state. */
  readonly applied: boolean;
}

/** Snapshot of the three header fields reconciliation can repair. */
export interface InvoiceReconciliationState {
  readonly invoiceStatus: InvoiceStatus;
  readonly amountPaid: string;
  readonly balanceDue: string;
}

/**
 * Outcome of reconciling one invoice against its payment/refund records.
 * `repaired: false` means the header already matched and nothing was written.
 */
export interface InvoiceReconciliationResult {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly repaired: boolean;
  readonly persisted: InvoiceReconciliationState;
  readonly expected: InvoiceReconciliationState;
  readonly balance: InvoiceBalanceDto;
}

export type InvoiceType =
  | "CONSULTATION"
  | "PHARMACY"
  | "LABORATORY"
  | "PROCEDURE"
  | "ADMISSION"
  | "OTHER";

export type InvoiceItemType =
  | "CONSULTATION"
  | "REGISTRATION"
  | "PROCEDURE"
  | "LABORATORY"
  | "PHARMACY"
  | "ROOM_CHARGE"
  | "OTHER";

export type InvoiceDiscountType = "AMOUNT" | "PERCENTAGE";

/** One charge to bill. `description` is required; everything else has defaults. */
export interface CreateInvoiceLineInput {
  readonly itemType?: InvoiceItemType;
  readonly description: string;
  readonly quantity: DecimalInput;
  readonly unitPrice: DecimalInput;
  readonly discountType?: InvoiceDiscountType | null;
  /** Currency amount for AMOUNT, percentage for PERCENTAGE. */
  readonly discountValue?: DecimalInput | null;
  /** Tax percentage applied to the discounted amount. Defaults to 0. */
  readonly taxRate?: DecimalInput | null;
}

export interface CreateInvoiceInput {
  readonly branchId: string;
  readonly patientId: string;
  /** Optional appointment this invoice is raised for (walk-in billing omits it). */
  readonly appointmentId?: string | null;
  readonly invoiceType?: InvoiceType;
  /** Optional custom number; generated from the tenant sequence when omitted. */
  readonly invoiceNumber?: string | null;
  /** `YYYY-MM-DD`; defaults to today in UTC. */
  readonly issueDate?: string | null;
  /** `YYYY-MM-DD`; must not be before the issue date. */
  readonly dueDate?: string | null;
  /** ISO 4217 code; defaults to USD. */
  readonly currency?: string | null;
  readonly notes?: string | null;
  /** Authenticated user raising the invoice; never taken from the request body. */
  readonly createdBy: string;
  readonly items: readonly CreateInvoiceLineInput[];
}

export interface InvoiceItemDto {
  readonly id: string;
  readonly itemType: InvoiceItemType;
  readonly description: string;
  /** 3-decimal string. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountType: InvoiceDiscountType | null;
  readonly discountValue: string | null;
  readonly grossAmount: string;
  readonly discountAmount: string;
  readonly taxRate: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
  readonly sortOrder: number;
}

/** Full invoice with its stored line items. */
export interface InvoiceDto {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly invoiceType: InvoiceType;
  readonly branchId: string;
  readonly patientId: string;
  readonly appointmentId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly notes: string | null;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly InvoiceItemDto[];
}

/** List rows omit line items: summaries are for queues and reports only. */
export type InvoiceSummaryDto = Omit<InvoiceDto, "items" | "notes">;

export interface ListInvoicesFilters {
  readonly patientId?: string;
  readonly branchId?: string;
  readonly status?: InvoiceStatus;
  readonly invoiceType?: InvoiceType;
  /** Inclusive lower bound on the issue date (`YYYY-MM-DD`). */
  readonly fromDate?: string;
  /** Inclusive upper bound on the issue date (`YYYY-MM-DD`). */
  readonly toDate?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface InvoiceListResult {
  readonly invoices: readonly InvoiceSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}
