import { z } from "zod";
import { paymentDateSchema } from "./payment.schemas.js";

/**
 * Request validation for the refund API (Phase 19.7.2).
 *
 * These schemas only check transport-level shape. Capture ownership, tenant and
 * branch relationships, cumulative refund limits, approval rules, idempotency
 * replay and gateway verification all stay in `refund.service.ts`, so validation
 * cannot drift from the rules the service actually enforces.
 *
 * Every body schema is `.strict()`: `tenantId`, `invoiceId`, `status`,
 * `approvedBy`, `providerRefundId`, `refundedAt` and every other server-owned
 * field is a 422 instead of being silently ignored. A channel, provider or
 * refund status is never accepted from the client - the service derives them
 * from the stored capture.
 */

export const REFUND_STATUSES = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
  "FAILED",
  "REJECTED",
] as const;

const MONEY_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;
const MAX_REASON_LENGTH = 2_000;
const MAX_REFERENCE_LENGTH = 120;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Accepts `""` as "not supplied" so optional fields can be cleared. */
const emptyStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** Cents of a 2-decimal string, computed with `BigInt` to avoid float math. */
function centsOf(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function isPositiveMoney(value: string): boolean {
  return MONEY_PATTERN.test(value) && centsOf(value) > 0n;
}

/**
 * A positive monetary amount with at most 2 decimals. The service still checks
 * the amount against the captured payment and the refundable remainder; this
 * only rejects shapes no money column could store.
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

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1, "Idempotency key cannot be empty")
  .max(
    MAX_IDEMPOTENCY_KEY_LENGTH,
    `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
  );

export const refundIdParamsSchema = z.object({
  refundId: z.uuid("Refund id must be a UUID"),
});

/**
 * Refund request body. There is deliberately no invoice, patient, branch,
 * currency, channel, status or provider field: all of them are derived from the
 * successful `invoice_payments` capture named by `invoicePaymentId`.
 */
export const createRefundRequestSchema = z
  .object({
    invoicePaymentId: z.uuid("Payment capture id must be a UUID"),
    amount: moneySchema,
    reason: optionalText(MAX_REASON_LENGTH),
    reference: optionalText(MAX_REFERENCE_LENGTH),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

/** Approval/rejection body. A decision note is optional and never required. */
export const refundDecisionSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      reason: optionalText(MAX_REASON_LENGTH),
    })
    .strict(),
);

/**
 * Processing body. Empty is valid: an offline refund needs no reference, and a
 * gateway refund takes its evidence from the adapter response. A supplied
 * reference can only be desk/operational text, never a provider id or status.
 */
export const processRefundSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      reference: optionalText(MAX_REFERENCE_LENGTH),
    })
    .strict(),
);

/**
 * Refund history query. Filters are additive and every date bound is an
 * inclusive UTC calendar date; page size is capped at 100 like the other lists.
 */
export const listRefundsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
    invoiceId: z.uuid("Invoice id must be a UUID").optional(),
    paymentId: z.uuid("Payment capture id must be a UUID").optional(),
    branchId: z.uuid("Branch id must be a UUID").optional(),
    patientId: z.uuid("Patient id must be a UUID").optional(),
    status: z.enum(REFUND_STATUSES, "Unknown refund status").optional(),
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

export type CreateRefundRequestBody = z.infer<typeof createRefundRequestSchema>;
export type RefundDecisionBody = z.infer<typeof refundDecisionSchema>;
export type ProcessRefundBody = z.infer<typeof processRefundSchema>;
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;
export type RefundIdParams = z.infer<typeof refundIdParamsSchema>;
