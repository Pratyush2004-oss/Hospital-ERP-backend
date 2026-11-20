import { z } from "zod";

/**
 * Query validation for the billing report API (Phase 19.9.2).
 *
 * Schemas validate transport shape only: dates, identifiers, enums and paging.
 * Every amount, currency, timezone boundary and aggregation rule remains in the
 * Phase 19.9.1 reporting service, so controllers and CSV export cannot drift
 * from the report calculations.
 *
 * A range may span at most 366 days. Reports are aggregate queries, but this
 * still bounds a request-driven scan and prevents unbounded exports.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 366;

/**
 * Strict `YYYY-MM-DD` calendar date. Exported so composing modules (dashboard)
 * validate dates exactly like the Phase 19.9 reports they reuse.
 */
export const dateSchema = z
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

const PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "CHEQUE",
  "OTHER",
] as const;
const INVOICE_TYPES = [
  "CONSULTATION",
  "PHARMACY",
  "LABORATORY",
  "PROCEDURE",
  "ADMISSION",
  "OTHER",
] as const;
const INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REFUNDED",
] as const;
const PAYMENT_STATUSES = ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"] as const;
const REFUND_STATUSES = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
  "FAILED",
  "REJECTED",
] as const;

const filterShape = {
  branchId: z.uuid("Branch id must be a UUID").optional(),
  paymentMethod: z.enum(PAYMENT_METHODS, "Unknown payment method").optional(),
  invoiceType: z.enum(INVOICE_TYPES, "Unknown invoice type").optional(),
  invoiceStatus: z.enum(INVOICE_STATUSES, "Unknown invoice status").optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES, "Unknown payment status").optional(),
  refundStatus: z.enum(REFUND_STATUSES, "Unknown refund status").optional(),
  doctorId: z.uuid("Doctor id must be a UUID").optional(),
  departmentId: z.uuid("Department id must be a UUID").optional(),
  timezone: z
    .string()
    .trim()
    .min(1, "Timezone cannot be empty")
    .max(64, "Timezone must be at most 64 characters")
    .optional(),
  format: z.enum(["json", "csv"], "format must be json or csv").default("json"),
} as const;

/** Inclusive local-date range; 366 days is a deliberate upper bound. */
export function assertRange(
  value: { readonly fromDate?: string; readonly toDate?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.fromDate === undefined || value.toDate === undefined) return;

  if (value.fromDate > value.toDate) {
    ctx.addIssue({
      code: "custom",
      path: ["toDate"],
      message: "fromDate must be on or before toDate",
    });
    return;
  }

  const days = Math.floor(
    (Date.parse(`${value.toDate}T00:00:00Z`) - Date.parse(`${value.fromDate}T00:00:00Z`)) /
      86_400_000,
  );
  if (days > MAX_RANGE_DAYS - 1) {
    ctx.addIssue({
      code: "custom",
      path: ["toDate"],
      message: `Report range must not exceed ${MAX_RANGE_DAYS} days`,
    });
  }
}

export const datedReportQuerySchema = z
  .object({
    ...filterShape,
    fromDate: dateSchema,
    toDate: dateSchema,
  })
  .superRefine(assertRange);

export const revenueTrendQuerySchema = z
  .object({
    ...filterShape,
    fromDate: dateSchema,
    toDate: dateSchema,
    granularity: z.enum(["day", "week", "month"], "granularity must be day, week or month"),
  })
  .superRefine(assertRange);

export const outstandingReportQuerySchema = z
  .object({
    ...filterShape,
    fromDate: dateSchema.optional(),
    asOf: dateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.fromDate !== undefined &&
      value.asOf !== undefined &&
      value.fromDate > value.asOf
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fromDate"],
        message: "fromDate must be on or before asOf",
      });
    }
  });

export const outstandingInvoiceQuerySchema = z
  .object({
    ...filterShape,
    fromDate: dateSchema.optional(),
    asOf: dateSchema.optional(),
    state: z.enum(["ALL", "PENDING", "OVERDUE"], "state must be ALL, PENDING or OVERDUE")
      .default("ALL"),
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
  })
  .superRefine((value, ctx) => {
    if (
      value.fromDate !== undefined &&
      value.asOf !== undefined &&
      value.fromDate > value.asOf
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fromDate"],
        message: "fromDate must be on or before asOf",
      });
    }
  });

export type DatedReportQuery = z.infer<typeof datedReportQuerySchema>;
export type RevenueTrendQuery = z.infer<typeof revenueTrendQuerySchema>;
export type OutstandingReportQuery = z.infer<typeof outstandingReportQuerySchema>;
export type OutstandingInvoiceQuery = z.infer<typeof outstandingInvoiceQuerySchema>;
