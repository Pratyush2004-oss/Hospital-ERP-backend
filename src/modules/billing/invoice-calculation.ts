import { AppError } from "../../lib/http-error.js";
import type {
  CalculatedInvoice,
  CalculatedInvoiceBalance,
  CalculatedInvoiceLine,
  DecimalInput,
  InvoiceBalanceInput,
  InvoiceCalculationInput,
  InvoiceLineInput,
  InvoicePaymentInput,
  InvoicePaymentStatus,
  InvoiceRefundInput,
  InvoiceRefundStatus,
} from "./invoice-calculation.types.js";

/**
 * Decimal-safe invoice calculations (Task 19.2.1).
 *
 * Financial values are never computed with JavaScript floating point. Every
 * input is parsed into a `BigInt` at a fixed internal scale of 6 decimals, all
 * intermediate products are integer math, and every monetary result is rounded
 * once to 2 decimals with half-up rounding before it is summed. That matches
 * the `NUMERIC(12, 2)` columns in the billing schema and keeps the totals
 * reproducible for the same input on every run and platform.
 *
 * Rounding policy: per line, the gross amount, the discount, the tax and the
 * line total are each rounded half-up to cents, and the invoice totals are the
 * sums of those rounded line values. Totals therefore always reconcile with
 * the stored line items (`subtotal - totalDiscount + totalTax === totalAmount`).
 *
 * Validation policy: this is server-side code, so it never trusts a caller's
 * arithmetic. Negative quantities, prices, discounts or tax rates, more
 * decimals than the database column can hold, malformed decimals, unknown
 * discount types, discounts larger than the amount they apply to, tax rates
 * above 100%, and totals that would overflow `NUMERIC(12, 2)` are all rejected
 * with an `AppError` before any value is returned.
 */

const INTERNAL_SCALE = 6;
const MONEY_SCALE = 2;
const QUANTITY_SCALE = 3;
const TAX_RATE_SCALE = 4;

const DEFAULT_CURRENCY = "USD";
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

const MAX_MONEY_INTEGER_DIGITS = 10;
const MAX_QUANTITY_INTEGER_DIGITS = 9;
const MAX_TAX_RATE_INTEGER_DIGITS = 3;

const SCALE_FACTOR = 10n ** BigInt(INTERNAL_SCALE);
const MONEY_FACTOR = 10n ** BigInt(INTERNAL_SCALE - MONEY_SCALE);
/** `NUMERIC(12, 2)` maximum: 9999999999.99, expressed in internal units. */
const MAX_MONEY_UNITS = 999_999_999_999n * 10_000n;
/** Divisors for percentage math: value / 100 where both sides carry 6 decimals. */
const PERCENT_DIVISOR = 100n * SCALE_FACTOR;
/** 100% in internal units. */
const MAX_PERCENT_UNITS = 100n * SCALE_FACTOR;

const PAYMENT_STATUSES: ReadonlySet<string> = new Set<InvoicePaymentStatus>([
  "PENDING",
  "SUCCESSFUL",
  "FAILED",
  "REFUNDED",
]);

const REFUND_STATUSES: ReadonlySet<string> = new Set<InvoiceRefundStatus>([
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
  "FAILED",
  "REJECTED",
]);

interface LineUnits {
  readonly quantity: bigint;
  readonly unitPrice: bigint;
  readonly grossAmount: bigint;
  readonly discountAmount: bigint;
  readonly taxableAmount: bigint;
  readonly taxRate: bigint;
  readonly taxAmount: bigint;
  readonly lineTotal: bigint;
}

function invalid(field: string, message: string): AppError {
  return AppError.validation(message, { field });
}

function formatUnits(units: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const internalDivisor = 10n ** BigInt(INTERNAL_SCALE - scale);
  const negative = units < 0n;
  // Values are already rounded to their target scale, so this division is exact.
  const scaled = (negative ? -units : units) / internalDivisor;
  const whole = scaled / factor;
  const fraction = (scaled % factor).toString().padStart(scale, "0");

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Guards every monetary leaf against overflowing `NUMERIC(12, 2)`. */
function assertMoneyRange(units: bigint, field: string): bigint {
  if (units > MAX_MONEY_UNITS) {
    throw invalid(field, `${field} exceeds the maximum supported amount`);
  }

  return units;
}

/**
 * Parses a decimal string (or a number) into internal units, rejecting
 * negative values, exponent notation, excess precision and overflow of the
 * target column instead of silently truncating.
 */
function toInternalUnits(
  value: DecimalInput,
  field: string,
  allowedScale: number,
  maxIntegerDigits: number,
): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(field, `${field} must be a finite number`);
    }
  }

  const text = typeof value === "number" ? String(value) : value.trim();

  if (text.startsWith("-")) {
    throw invalid(field, `${field} must not be negative`);
  }

  const match = DECIMAL_PATTERN.exec(text);

  if (!match) {
    throw invalid(field, `${field} must be a plain decimal number`);
  }

  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";

  if (whole.replace(/^0+(?=\d)/, "").length > maxIntegerDigits) {
    throw invalid(field, `${field} exceeds the maximum supported value`);
  }

  if (fraction.length > allowedScale) {
    throw invalid(
      field,
      `${field} must have at most ${allowedScale} decimal place${allowedScale === 1 ? "" : "s"}`,
    );
  }

  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");

  return BigInt(`${normalizedWhole}${fraction.padEnd(INTERNAL_SCALE, "0")}`);
}

/** Half-up rounding to cents; invoice amounts are never negative. */
function roundToMoney(units: bigint): bigint {
  return ((units + MONEY_FACTOR / 2n) / MONEY_FACTOR) * MONEY_FACTOR;
}

/** `(a * b) / divisor` with half-up rounding, for percentage math. */
function mulDivRounded(a: bigint, b: bigint, divisor: bigint): bigint {
  return (a * b + divisor / 2n) / divisor;
}

function normalizeCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined) return DEFAULT_CURRENCY;

  const currency = value.trim().toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw invalid("currency", "Currency must be a three-letter ISO 4217 code");
  }

  return currency;
}

function parseMoney(value: DecimalInput, field: string): bigint {
  return toInternalUnits(value, field, MONEY_SCALE, MAX_MONEY_INTEGER_DIGITS);
}

/**
 * Validates a monetary input and returns it in the fixed 2-decimal form the
 * NUMERIC(12, 2) columns round-trip. Shared by the payment service so payment
 * and allocation amounts use the same parsing rules as invoice money.
 */
export function normalizeMoney(value: DecimalInput, field = "amount"): string {
  return formatUnits(assertMoneyRange(parseMoney(value, field), field), MONEY_SCALE);
}

/** Exact decimal-safe sum of monetary inputs, returned as a 2-decimal string. */
export function addMoney(amounts: readonly DecimalInput[], field = "amount"): string {
  let total = 0n;

  for (const amount of amounts) {
    total += parseMoney(amount, field);
  }

  return formatUnits(assertMoneyRange(total, field), MONEY_SCALE);
}

/** Compares two monetary inputs; negative when `left < right`. */
export function compareMoney(left: DecimalInput, right: DecimalInput): number {
  const a = parseMoney(left, "amount");
  const b = parseMoney(right, "amount");

  return a === b ? 0 : a < b ? -1 : 1;
}

function parseTaxRate(value: DecimalInput, field: string): bigint {
  const rate = toInternalUnits(value, field, TAX_RATE_SCALE, MAX_TAX_RATE_INTEGER_DIGITS);

  if (rate > MAX_PERCENT_UNITS) {
    throw invalid(field, `${field} cannot exceed 100 percent`);
  }

  return rate;
}

function calculateLineUnits(input: InvoiceLineInput): LineUnits {
  const quantity = toInternalUnits(
    input.quantity,
    "Line quantity",
    QUANTITY_SCALE,
    MAX_QUANTITY_INTEGER_DIGITS,
  );
  const unitPrice = parseMoney(input.unitPrice, "Line unit price");

  // Quantity (3 dp) x unit price (2 dp) is exact at the internal 6 dp scale.
  const grossAmount = assertMoneyRange(
    roundToMoney((quantity * unitPrice) / SCALE_FACTOR),
    "Line amount",
  );

  let discountAmount = 0n;
  const discount = input.discount ?? null;

  if (discount !== null) {
    if (discount.type === "PERCENTAGE") {
      const percentage = parseTaxRate(discount.value, "Line discount percentage");
      discountAmount = assertMoneyRange(
        roundToMoney(mulDivRounded(grossAmount, percentage, PERCENT_DIVISOR)),
        "Line discount amount",
      );
    } else if (discount.type === "AMOUNT") {
      discountAmount = assertMoneyRange(
        roundToMoney(parseMoney(discount.value, "Line discount amount")),
        "Line discount amount",
      );
    } else {
      throw invalid("discount", "Line discount type must be AMOUNT or PERCENTAGE");
    }
  }

  if (discountAmount > grossAmount) {
    throw invalid("discount", "Line discount cannot exceed the line amount");
  }

  const taxableAmount = grossAmount - discountAmount;
  const taxRate =
    input.taxRate === null || input.taxRate === undefined
      ? 0n
      : parseTaxRate(input.taxRate, "Line tax rate");
  const taxAmount = assertMoneyRange(
    roundToMoney(mulDivRounded(taxableAmount, taxRate, PERCENT_DIVISOR)),
    "Line tax amount",
  );

  // A rate of at most 100% can never tax more than the base; this keeps the
  // invariant explicit if the ceiling above ever changes.
  const boundedTax = taxAmount > taxableAmount ? taxableAmount : taxAmount;

  return {
    quantity,
    unitPrice,
    grossAmount,
    discountAmount,
    taxableAmount,
    taxRate,
    taxAmount: boundedTax,
    lineTotal: taxableAmount + boundedTax,
  };
}

function toCalculatedLine(
  input: InvoiceLineInput,
  units: LineUnits,
): CalculatedInvoiceLine {
  return {
    lineId: input.lineId ?? null,
    description: input.description ?? null,
    quantity: formatUnits(units.quantity, QUANTITY_SCALE),
    unitPrice: formatUnits(units.unitPrice, MONEY_SCALE),
    grossAmount: formatUnits(units.grossAmount, MONEY_SCALE),
    discountAmount: formatUnits(units.discountAmount, MONEY_SCALE),
    taxableAmount: formatUnits(units.taxableAmount, MONEY_SCALE),
    taxRate: formatUnits(units.taxRate, TAX_RATE_SCALE),
    taxAmount: formatUnits(units.taxAmount, MONEY_SCALE),
    lineTotal: formatUnits(units.lineTotal, MONEY_SCALE),
  };
}

/** Sum of the payments that actually settled money against the invoice. */
function settledPayments(payments: readonly InvoicePaymentInput[], currency: string): bigint {
  let paid = 0n;

  for (const payment of payments) {
    if (typeof payment.status !== "string" || !PAYMENT_STATUSES.has(payment.status)) {
      throw invalid("payments", "Payment status must be PENDING, SUCCESSFUL, FAILED or REFUNDED");
    }

    if (payment.currency !== null && payment.currency !== undefined) {
      const paymentCurrency = normalizeCurrency(payment.currency);

      if (paymentCurrency !== currency) {
        throw invalid("currency", "Payment currency must match the invoice currency");
      }
    }

    const amount = parseMoney(payment.amount, "Payment amount");

    // Pending, failed and refunded payments must not reduce the balance due.
    if (payment.status === "SUCCESSFUL") {
      paid += amount;
    }
  }

  return paid;
}

/**
 * Calculates one invoice line: gross amount, item discount, tax and total.
 * Throws `AppError` for invalid input; never returns a partial result.
 */
export function calculateInvoiceLine(input: InvoiceLineInput): CalculatedInvoiceLine {
  return toCalculatedLine(input, calculateLineUnits(input));
}

/** Sum of the refund transactions whose money actually left the hospital. */
function settledRefunds(refunds: readonly InvoiceRefundInput[], currency: string): bigint {
  let refunded = 0n;

  for (const refund of refunds) {
    if (typeof refund.status !== "string" || !REFUND_STATUSES.has(refund.status)) {
      throw invalid(
        "refunds",
        "Refund status must be PENDING, APPROVED, PROCESSING, SUCCESSFUL, FAILED or REJECTED",
      );
    }

    if (refund.currency !== null && refund.currency !== undefined) {
      const refundCurrency = normalizeCurrency(refund.currency);

      if (refundCurrency !== currency) {
        throw invalid("currency", "Refund currency must match the invoice currency");
      }
    }

    const amount = parseMoney(refund.amount, "Refund amount");

    // Pending and failed refunds move no money and change no balance.
    if (refund.status === "SUCCESSFUL") {
      refunded += amount;
    }
  }

  return refunded;
}

/**
 * Calculates the balance state of an invoice from its persisted total and its
 * payment/refund history.
 *
 * Only successful payments settle money and only successful refunds return it,
 * so pending or failed attempts leave every figure unchanged. A refund may
 * never exceed the money actually collected, which keeps `amountPaid` (net
 * held money) and `balanceDue` non-negative without silently clamping real
 * financial data. An overpayment reports a zero balance rather than a negative
 * amount due.
 */
export function calculateInvoiceBalance(input: InvoiceBalanceInput): CalculatedInvoiceBalance {
  const currency = normalizeCurrency(input.currency);
  const total = assertMoneyRange(parseMoney(input.totalAmount, "Invoice total"), "Invoice total");
  const paid = assertMoneyRange(
    settledPayments(input.payments ?? [], currency),
    "Amount paid",
  );
  const refunded = assertMoneyRange(
    settledRefunds(input.refunds ?? [], currency),
    "Refunded amount",
  );

  if (refunded > paid) {
    throw invalid(
      "refunds",
      "Refunds cannot exceed the successful payments recorded for this invoice",
    );
  }

  const amountPaid = paid - refunded;
  const balance = total - amountPaid;

  return {
    currency,
    totalAmount: formatUnits(total, MONEY_SCALE),
    amountPaid: formatUnits(amountPaid, MONEY_SCALE),
    refundedAmount: formatUnits(refunded, MONEY_SCALE),
    balanceDue: formatUnits(balance > 0n ? balance : 0n, MONEY_SCALE),
  };
}

/**
 * Calculates the outstanding balance from the invoice total and every payment
 * attempt recorded against it. Delegates to `calculateInvoiceBalance` so the
 * settled-money rules live in exactly one place.
 */
export function calculateBalanceDue(
  totalAmount: DecimalInput,
  payments: readonly InvoicePaymentInput[] = [],
  currency = DEFAULT_CURRENCY,
): string {
  return calculateInvoiceBalance({ totalAmount, payments, currency }).balanceDue;
}

/**
 * Calculates a whole invoice from its line items and payment history.
 *
 * Returns fixed-scale decimal strings ready for the `invoices` /
 * `invoice_items` NUMERIC columns, plus the balance due after successful
 * payments only.
 */
export function calculateInvoice(input: InvoiceCalculationInput): CalculatedInvoice {
  const currency = normalizeCurrency(input.currency);

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw invalid("lines", "An invoice must contain at least one line item");
  }

  const calculatedLines: CalculatedInvoiceLine[] = [];
  let subtotal = 0n;
  let totalDiscount = 0n;
  let totalTax = 0n;
  let totalAmount = 0n;

  for (const [index, line] of input.lines.entries()) {
    // Every individual line amount is already range-checked by calculateLineUnits.
    const units = calculateLineUnits(line);
    calculatedLines.push(toCalculatedLine(line, units));

    subtotal += units.grossAmount;
    totalDiscount += units.discountAmount;
    totalTax += units.taxAmount;
    totalAmount += units.lineTotal;

    if (
      subtotal > MAX_MONEY_UNITS ||
      totalDiscount > MAX_MONEY_UNITS ||
      totalTax > MAX_MONEY_UNITS ||
      totalAmount > MAX_MONEY_UNITS
    ) {
      throw invalid(
        "lines",
        `Invoice total exceeds the maximum supported amount at line ${index + 1}`,
      );
    }
  }

  const amountPaid = settledPayments(input.payments ?? [], currency);
  const balance = totalAmount - amountPaid;

  return {
    currency,
    lines: calculatedLines,
    subtotal: formatUnits(subtotal, MONEY_SCALE),
    totalDiscount: formatUnits(totalDiscount, MONEY_SCALE),
    totalTax: formatUnits(totalTax, MONEY_SCALE),
    totalAmount: formatUnits(totalAmount, MONEY_SCALE),
    amountPaid: formatUnits(amountPaid, MONEY_SCALE),
    balanceDue: formatUnits(balance > 0n ? balance : 0n, MONEY_SCALE),
  };
}
