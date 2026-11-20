import { z } from "zod";

/**
 * Request validation for the payment API (Phase 19.5.1).
 *
 * These schemas only check transport-level shape. Allocation arithmetic,
 * invoice ownership, branch and patient boundaries, currency resolution,
 * balance limits, idempotency replay and every other financial rule stay in
 * `payment.service.ts`, so validation cannot drift from the rules the service
 * actually enforces.
 *
 * Every body schema is `.strict()`: `tenantId`, `receivedBy`, `paymentStatus`,
 * `createdAt`, `requestHash` and any other server-owned field is a 422 instead
 * of being silently ignored. Money is a decimal string; a JSON float is
 * accepted only because it is converted back to its decimal text form before
 * the service parses it with `BigInt`.
 */

export const PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "CHEQUE",
  "OTHER",
] as const;

/**
 * Every status the column can hold. Recording a manual collection always
 * stores `SUCCESSFUL`; the other values are listed so history can be filtered,
 * and no endpoint can write them.
 */
export const PAYMENT_STATUSES = ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Same instant model as appointments: an explicit offset is required. */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MONEY_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

const MAX_REFERENCE_LENGTH = 120;
const MAX_NOTES_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ALLOCATIONS = 50;

/** Accepts `""` as "not supplied" so optional fields can be cleared. */
const emptyStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

export const paymentDateSchema = z
  .string()
  .trim()
  .regex(DATE_PATTERN, "Date must be an ISO calendar date (YYYY-MM-DD)")
  .refine((value) => {
    const match = DATE_PATTERN.exec(value);
    if (!match) return false;

    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Date must be a valid calendar date");

export const paymentInstantSchema = z
  .string()
  .trim()
  .regex(INSTANT_PATTERN, "Timestamp must be ISO 8601 with an explicit offset (Z or ±HH:MM)");

/** Cents of a 2-decimal string, computed with `BigInt` to avoid float math. */
function centsOf(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** Zod runs every check in a chain, so the shape must be proven before parsing. */
function isPositiveMoney(value: string): boolean {
  return MONEY_PATTERN.test(value) && centsOf(value) > 0n;
}

/**
 * A positive monetary amount with at most 2 decimals. Decimal strings are the
 * canonical form; a finite JSON number is accepted for convenience and
 * normalized to its decimal text before parsing.
 */
const moneySchema = z
  .union([z.string(), z.number()], "Amount must be a decimal string")
  .transform((value) => (typeof value === "number" ? String(value) : value.trim()))
  .pipe(
    z
      .string()
      .regex(MONEY_PATTERN, "Amount must be a plain decimal with at most 2 decimal places")
      .refine(isPositiveMoney, "Amount must be greater than zero"),
  );

const optionalText = (maxLength: number) =>
  z.preprocess(
    emptyStringToNull,
    z
      .string()
      .trim()
      .max(maxLength, `Must be at most ${maxLength} characters`)
      .nullable()
      .optional(),
  );

const currencySchema = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a three-letter ISO 4217 code")
    .nullable()
    .optional(),
);

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1, "Idempotency key cannot be empty")
  .max(
    MAX_IDEMPOTENCY_KEY_LENGTH,
    `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
  );

export const paymentIdParamsSchema = z.object({
  paymentId: z.uuid("Payment id must be a UUID"),
});

export const allocationInputSchema = z
  .object({
    invoiceId: z.uuid("Invoice id must be a UUID"),
    amount: moneySchema,
  })
  .strict();

/**
 * Recording body. `receivedBy` and `paymentStatus` are absent on purpose: the
 * cashier comes from the verified session and a manual collection is stored
 * `SUCCESSFUL`. `receivedAt` may be backdated but never future-dated.
 */
export const recordPaymentSchema = z
  .object({
    branchId: z.uuid("Branch id must be a UUID"),
    patientId: z.uuid("Patient id must be a UUID"),
    method: z.enum(PAYMENT_METHODS, "Unknown payment method"),
    amount: moneySchema,
    currency: currencySchema,
    reference: optionalText(MAX_REFERENCE_LENGTH),
    notes: optionalText(MAX_NOTES_LENGTH),
    receivedAt: paymentInstantSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    allocations: z
      .array(allocationInputSchema)
      .min(1, "At least one invoice allocation is required")
      .max(MAX_ALLOCATIONS, `A payment can settle at most ${MAX_ALLOCATIONS} invoices`),
  })
  .strict();

/**
 * Payment history query. Filters are additive and every date bound is an
 * inclusive UTC calendar date; page size is capped at 100 like the other lists.
 */
export const listPaymentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
    patientId: z.uuid("Patient id must be a UUID").optional(),
    branchId: z.uuid("Branch id must be a UUID").optional(),
    method: z.enum(PAYMENT_METHODS, "Unknown payment method").optional(),
    status: z.enum(PAYMENT_STATUSES, "Unknown payment status").optional(),
    reference: z
      .string()
      .trim()
      .min(1, "Reference cannot be empty")
      .max(MAX_REFERENCE_LENGTH, `Reference must be at most ${MAX_REFERENCE_LENGTH} characters`)
      .optional(),
    fromDate: paymentDateSchema.optional(),
    toDate: paymentDateSchema.optional(),
  })
  .refine(
    (value) =>
      value.fromDate === undefined ||
      value.toDate === undefined ||
      value.fromDate <= value.toDate,
    { message: "fromDate must be on or before toDate", path: ["toDate"] },
  );

/**
 * Online initiation body (Task 19.6.1). Deliberately minimal: there is no
 * amount, currency, patient, branch, status, provider order id or transaction
 * reference. All of those are derived from the tenant-scoped invoice, so a
 * client cannot choose what to charge or forge a gateway artifact.
 */
export const GATEWAY_PAYMENT_METHODS = ["CARD", "UPI", "BANK_TRANSFER", "OTHER"] as const;

export const initiatePaymentSchema = z
  .object({
    invoiceId: z.uuid("Invoice id must be a UUID"),
    method: z.enum(GATEWAY_PAYMENT_METHODS, "Unknown online payment method"),
    provider: z.enum(["mock"], "Unknown payment gateway provider").optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

export type InitiatePaymentBody = z.infer<typeof initiatePaymentSchema>;
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
export type PaymentIdParams = z.infer<typeof paymentIdParamsSchema>;
