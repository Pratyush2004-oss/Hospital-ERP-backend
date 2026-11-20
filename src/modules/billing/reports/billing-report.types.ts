/**
 * Billing reporting contracts (Phase 19.9.1).
 *
 * Every amount is a decimal string produced by a PostgreSQL `NUMERIC` aggregate
 * and grouped by currency: invoices, payments and refunds may legitimately use
 * different currencies, and adding them together would be meaningless.
 */

export type ReportGranularity = "day" | "week" | "month";

export type PaymentMethod =
  | "CASH"
  | "CARD"
  | "UPI"
  | "BANK_TRANSFER"
  | "CHEQUE"
  | "OTHER";

export type InvoiceType =
  | "CONSULTATION"
  | "PHARMACY"
  | "LABORATORY"
  | "PROCEDURE"
  | "ADMISSION"
  | "OTHER";

export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED"
  | "REFUNDED";

export type PaymentStatus = "PENDING" | "SUCCESSFUL" | "FAILED" | "REFUNDED";

export type RefundStatus =
  | "PENDING"
  | "APPROVED"
  | "PROCESSING"
  | "SUCCESSFUL"
  | "FAILED"
  | "REJECTED";

export interface BillingReportFilters {
  /** Inclusive local calendar date (YYYY-MM-DD); required by range reports. */
  readonly fromDate?: string;
  /** Inclusive local calendar date (YYYY-MM-DD); required by range reports. */
  readonly toDate?: string;
  readonly branchId?: string;
  readonly paymentMethod?: PaymentMethod;
  readonly invoiceType?: InvoiceType;
  readonly invoiceStatus?: InvoiceStatus;
  readonly paymentStatus?: PaymentStatus;
  readonly refundStatus?: RefundStatus;
  readonly doctorId?: string;
  readonly departmentId?: string;
  /** IANA zone for instant boundaries/grouping; defaults to branch/hospital. */
  readonly timezone?: string;
}

export interface DatedBillingReportFilters extends BillingReportFilters {
  readonly fromDate: string;
  readonly toDate: string;
}

export interface CurrencyAmount {
  readonly currency: string;
  readonly amount: string;
}

export interface CurrencyCount {
  readonly currency: string;
  readonly count: number;
  readonly amount: string;
}

export interface RevenueSummary {
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly invoiceCount: number;
  readonly invoiced: readonly CurrencyAmount[];
  readonly collected: readonly CurrencyAmount[];
  readonly refunded: readonly CurrencyAmount[];
  readonly netCollected: readonly CurrencyAmount[];
  readonly outstanding: readonly CurrencyAmount[];
}

export interface RevenuePoint {
  readonly period: string;
  readonly currency: string;
  readonly invoiced: string;
  readonly collected: string;
  readonly refunded: string;
  readonly netCollected: string;
}

export interface RevenueTimeSeries {
  readonly granularity: ReportGranularity;
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly points: readonly RevenuePoint[];
}

export interface OutstandingBalanceSummary {
  readonly asOf: string;
  readonly timezone: string;
  readonly invoiceCount: number;
  readonly outstanding: readonly CurrencyAmount[];
}

export interface PendingOverdueSummary {
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly pending: {
    readonly invoiceCount: number;
    readonly outstanding: readonly CurrencyAmount[];
  };
  readonly overdue: {
    readonly invoiceCount: number;
    readonly outstanding: readonly CurrencyAmount[];
  };
}

export interface StatusDistributionRow {
  readonly status: string;
  readonly count: number;
  readonly totals: readonly CurrencyAmount[];
}

export interface BranchRevenueRow {
  readonly branchId: string;
  readonly branchName: string;
  readonly currency: string;
  readonly invoiceCount: number;
  readonly invoiced: string;
  readonly collected: string;
  readonly refunded: string;
  readonly netCollected: string;
  readonly outstanding: string;
}

export interface PaymentMethodRevenueRow {
  readonly paymentMethod: string;
  readonly currency: string;
  readonly paymentCount: number;
  readonly collected: string;
  readonly refunded: string;
  readonly netCollected: string;
}

export interface InvoiceTypeRevenueRow {
  readonly invoiceType: string;
  readonly currency: string;
  readonly invoiceCount: number;
  readonly invoiced: string;
  readonly collected: string;
  readonly refunded: string;
  readonly outstanding: string;
}

export interface DoctorBillingRow {
  readonly doctorId: string;
  readonly doctorCode: string;
  readonly doctorName: string | null;
  readonly currency: string;
  readonly invoiceCount: number;
  readonly invoiced: string;
  readonly collected: string;
  readonly refunded: string;
  readonly netCollected: string;
}

export interface DepartmentBillingRow {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly currency: string;
  readonly invoiceCount: number;
  readonly invoiced: string;
  readonly collected: string;
  readonly refunded: string;
  readonly netCollected: string;
}

export type OutstandingInvoiceState = "ALL" | "PENDING" | "OVERDUE";

export interface OutstandingInvoiceListFilters extends BillingReportFilters {
  readonly asOf?: string;
  readonly state?: OutstandingInvoiceState;
  readonly page?: number;
  readonly pageSize?: number;
}

/** Record-level report row; deliberately contains no patient identity. */
export interface OutstandingInvoiceRow {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly invoiceStatus: string;
  readonly invoiceType: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
}

export interface OutstandingInvoicePage {
  readonly asOf: string;
  readonly timezone: string;
  readonly state: OutstandingInvoiceState;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly invoices: readonly OutstandingInvoiceRow[];
}

export interface PaymentRefundSummary {
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly payments: readonly StatusDistributionRow[];
  readonly refunds: readonly StatusDistributionRow[];
}
