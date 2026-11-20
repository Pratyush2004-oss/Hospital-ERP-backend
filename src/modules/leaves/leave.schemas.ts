import { z } from "zod";

/**
 * Request validation for the doctor leave API (Task 16.5).
 *
 * Leave is an absolute instant, so `startAt` / `endAt` must be ISO 8601
 * timestamps carrying an explicit offset (`Z` or `±HH:MM`). Client-controlled
 * workflow metadata (`createdBy`, `approvedBy`, `approvedAt`, `status`,
 * `rejectedBy`, ...) is never part of these schemas and `.strict()` makes an
 * attempt to supply it a 422 instead of silently ignoring it.
 */

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;

export const leaveInstantSchema = z
  .string()
  .trim()
  .regex(
    INSTANT_PATTERN,
    'Leave timestamps must be ISO 8601 with an explicit timezone offset, e.g. "2026-02-02T09:00:00Z" or "2026-02-02T14:30:00+05:30"',
  )
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "Leave timestamps must be valid instants",
  );

export const leaveDateSchema = z
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

const leaveReasonSchema = z
  .string()
  .trim()
  .max(1000, "Leave reason must be at most 1000 characters")
  .nullable()
  .optional();

function assertInstantOrder(startAt: string | undefined, endAt: string | undefined): boolean {
  if (startAt === undefined || endAt === undefined) return true;
  return new Date(startAt).getTime() < new Date(endAt).getTime();
}

export const createDoctorLeaveSchema = z
  .object({
    doctorId: z.uuid("Doctor id must be a UUID"),
    /** Omit or send null for leave that affects every branch. */
    branchId: z.uuid("Branch id must be a UUID").nullable().optional(),
    startAt: leaveInstantSchema,
    endAt: leaveInstantSchema,
    reason: leaveReasonSchema,
  })
  .strict()
  .refine((value) => assertInstantOrder(value.startAt, value.endAt), {
    message: "Leave end must be later than its start",
    path: ["endAt"],
  });

export const updateDoctorLeaveSchema = z
  .object({
    branchId: z.uuid("Branch id must be a UUID").nullable().optional(),
    startAt: leaveInstantSchema.optional(),
    endAt: leaveInstantSchema.optional(),
    reason: leaveReasonSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  })
  .refine((value) => assertInstantOrder(value.startAt, value.endAt), {
    message: "Leave end must be later than its start",
    path: ["endAt"],
  });

export const rejectDoctorLeaveSchema = z
  .object({
    rejectionReason: z
      .string()
      .trim()
      .min(1, "A rejection reason is required")
      .max(1000, "Rejection reason must be at most 1000 characters"),
  })
  .strict();

export const doctorLeaveIdParamsSchema = z.object({
  id: z.uuid("Leave id must be a UUID"),
});

export const listDoctorLeavesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  doctorId: z.uuid("Doctor id must be a UUID").optional(),
  branchId: z.uuid("Branch id must be a UUID").optional(),
  status: z.enum(STATUSES, "Unknown leave status").optional(),
  startDate: leaveDateSchema.optional(),
  endDate: leaveDateSchema.optional(),
});

export type CreateDoctorLeaveBody = z.infer<typeof createDoctorLeaveSchema>;
export type UpdateDoctorLeaveBody = z.infer<typeof updateDoctorLeaveSchema>;
export type RejectDoctorLeaveBody = z.infer<typeof rejectDoctorLeaveSchema>;
export type DoctorLeaveIdParams = z.infer<typeof doctorLeaveIdParamsSchema>;
export type ListDoctorLeavesQuery = z.infer<typeof listDoctorLeavesQuerySchema>;
