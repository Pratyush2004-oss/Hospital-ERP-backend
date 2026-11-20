/**
 * Invoice calculation contracts (Task 19.2.1).
 *
 * The billing tables (`invoices`, `invoice_items`, `invoice_payments`,
 * `invoice_refunds`) are part of the Drizzle schema; these contracts follow the
 * money conventions the project already uses for every `NUMERIC(12, 2)` column:
 *
 * - monetary amounts are `NUMERIC(12, 2)`: at most 10 integer digits and two
 *   decimals, held as decimal strings so no JavaScript float is ever involved
 * - currency is an uppercase ISO 4217 code; USD is the column default
 * - line quantities are `NUMERIC(12, 3)`: at most 9 integer digits and three
 *   decimals
 * - tax rates are percentages with at most four decimals (`19.5` = 19.5%)
 *
 * Amounts produced by the calculator are always plain decimal strings with a
 * fixed number of decimals, so they can be written straight into NUMERIC
 * columns and compared as strings across clients without re-formatting.
 */

/** A decimal value exactly as PostgreSQL NUMERIC round-trips it. */
export type DecimalInput = string | number;

/** Item-level discount: a fixed amount in the invoice currency or a percentage. */
export interface InvoiceLineDiscountInput {
  readonly type: "AMOUNT" | "PERCENTAGE";
  /** `AMOUNT` is a currency amount (2 decimals); `PERCENTAGE` is a percent (4 decimals). */
  readonly value: DecimalInput;
}

/**
 * One billable line. Prices, discounts and tax rates are supplied by the
 * server-side invoice service from `invoice_items` / catalogue data, never
 * taken from a client request body.
 */
export interface InvoiceLineInput {
  /** Optional correlation back to an `invoice_items` row. */
  readonly lineId?: string;
  readonly description?: string;
  readonly quantity: DecimalInput;
  /** Price per unit, 2 decimals. */
  readonly unitPrice: DecimalInput;
  /** Defaults to no discount. */
  readonly discount?: InvoiceLineDiscountInput | null;
  /** Tax percentage applied to the discounted amount. Defaults to 0. */
  readonly taxRate?: DecimalInput | null;
}

/** Computed line values; every monetary field is a fixed 2-decimal string. */
export interface CalculatedInvoiceLine {
  readonly lineId: string | null;
  readonly description: string | null;
  /** 3-decimal string, e.g. `"2.500"`. */
  readonly quantity: string;
  readonly unitPrice: string;
  /** Quantity x unit price, before discount and tax. */
  readonly grossAmount: string;
  readonly discountAmount: string;
  /** Gross amount minus discount; the base the tax is applied to. */
  readonly taxableAmount: string;
  /** 4-decimal percentage string, e.g. `"7.5000"`. */
  readonly taxRate: string;
  readonly taxAmount: string;
  /** Taxable amount plus tax. */
  readonly lineTotal: string;
}

/**
 * Payment states. Only `SUCCESSFUL` money settles an invoice; `PENDING`,
 * `FAILED` and `REFUNDED` payments must never reduce the balance due.
 */
export type InvoicePaymentStatus = "PENDING" | "SUCCESSFUL" | "FAILED" | "REFUNDED";

export interface InvoicePaymentInput {
  readonly paymentId?: string;
  readonly amount: DecimalInput;
  readonly status: InvoicePaymentStatus;
  /** Must match the invoice currency when supplied. */
  readonly currency?: string | null;
}

/**
 * Refund lifecycle. Only `SUCCESSFUL` money reduces the net amount paid; a
 * pending, approved, processing, failed or rejected refund changes no balance.
 */
export type InvoiceRefundStatus =
  | "PENDING"
  | "APPROVED"
  | "PROCESSING"
  | "SUCCESSFUL"
  | "FAILED"
  | "REJECTED";

export interface InvoiceRefundInput {
  readonly refundId?: string;
  readonly amount: DecimalInput;
  readonly status: InvoiceRefundStatus;
  /** Must match the invoice currency when supplied. */
  readonly currency?: string | null;
}

/**
 * Balance inputs for an already-issued invoice: the persisted total plus every
 * payment attempt and refund transaction recorded against it, in any state.
 */
export interface InvoiceBalanceInput {
  readonly totalAmount: DecimalInput;
  readonly currency?: string | null;
  readonly payments?: readonly InvoicePaymentInput[];
  readonly refunds?: readonly InvoiceRefundInput[];
}

/**
 * Net balance state. `amountPaid` is the settled money still held (successful
 * payments minus successful refunds); `refundedAmount` is the part of it that
 * was returned.
 */
export interface CalculatedInvoiceBalance {
  readonly currency: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly refundedAmount: string;
  /** Never negative. */
  readonly balanceDue: string;
}

export interface InvoiceCalculationInput {
  /** ISO 4217 code. Defaults to USD, matching the schema defaults. */
  readonly currency?: string | null;
  readonly lines: readonly InvoiceLineInput[];
  /** All payment attempts for the invoice, in any state. */
  readonly payments?: readonly InvoicePaymentInput[];
}

export interface CalculatedInvoice {
  readonly currency: string;
  readonly lines: readonly CalculatedInvoiceLine[];
  /** Sum of line gross amounts, before any discount or tax. */
  readonly subtotal: string;
  readonly totalDiscount: string;
  readonly totalTax: string;
  /** Subtotal - total discount + total tax. */
  readonly totalAmount: string;
  /** Sum of SUCCESSFUL payments only. */
  readonly amountPaid: string;
  /** total amount - amount paid, never negative. */
  readonly balanceDue: string;
}
