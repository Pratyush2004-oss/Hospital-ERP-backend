import { z } from "zod";

/**
 * Request validation for the doctor schedule API (Task 16.5).
 *
 * These schemas only check transport-level shape. Doctor/branch existence,
 * assignment, overlap and "breaks still fit" rules stay in the schedule
 * service, so validation can never drift from what the service enforces.
 *
 * Important: `startTime` / `endTime` are branch-local wall-clock strings. They
 * are deliberately NOT converted to UTC here — a recurring weekly window must
 * follow the branch clock across DST.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const localTimeSchema = z
  .string()
  .trim()
  .regex(
    TIME_PATTERN,
    'Time must be a 24-hour branch-local time such as "09:00" or "09:00:00"',
  );

export const isoDateSchema = z
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

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0", second = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute) + Number(second) / 60;
}

/** Cross-field checks performed as additive refinements, not field rewrites. */
function assertTimeOrder(
  startTime: string | undefined,
  endTime: string | undefined,
): boolean {
  if (startTime === undefined || endTime === undefined) return true;
  return timeToMinutes(startTime) < timeToMinutes(endTime);
}

function assertDateOrder(
  effectiveFrom: string | undefined,
  effectiveUntil: string | null | undefined,
): boolean {
  if (effectiveFrom === undefined || effectiveUntil === undefined || effectiveUntil === null) {
    return true;
  }
  return effectiveFrom <= effectiveUntil;
}

export const createDoctorScheduleSchema = z
  .object({
    doctorId: z.uuid("Doctor id must be a UUID"),
    branchId: z.uuid("Branch id must be a UUID"),
    dayOfWeek: z
      .number()
      .int("Day of week must be an integer")
      .min(1, "Day of week must be between 1 (Monday) and 7 (Sunday)")
      .max(7, "Day of week must be between 1 (Monday) and 7 (Sunday)"),
    startTime: localTimeSchema,
    endTime: localTimeSchema,
    slotDurationMinutes: z
      .number()
      .int("Slot duration must be an integer")
      .min(5, "Slot duration must be between 5 and 480 minutes")
      .max(480, "Slot duration must be between 5 and 480 minutes")
      .optional(),
    bufferMinutes: z
      .number()
      .int("Buffer duration must be an integer")
      .min(0, "Buffer duration cannot be negative")
      .max(32_767, "Buffer duration is too large")
      .optional(),
    effectiveFrom: isoDateSchema.optional(),
    effectiveUntil: isoDateSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => assertTimeOrder(value.startTime, value.endTime), {
    message: "Schedule end time must be later than its start time",
    path: ["endTime"],
  })
  .refine((value) => assertDateOrder(value.effectiveFrom, value.effectiveUntil), {
    message: "Effective until date cannot be earlier than effective from date",
    path: ["effectiveUntil"],
  });

export const updateDoctorScheduleSchema = z
  .object({
    branchId: z.uuid("Branch id must be a UUID").optional(),
    dayOfWeek: z
      .number()
      .int("Day of week must be an integer")
      .min(1, "Day of week must be between 1 (Monday) and 7 (Sunday)")
      .max(7, "Day of week must be between 1 (Monday) and 7 (Sunday)")
      .optional(),
    startTime: localTimeSchema.optional(),
    endTime: localTimeSchema.optional(),
    slotDurationMinutes: z
      .number()
      .int("Slot duration must be an integer")
      .min(5, "Slot duration must be between 5 and 480 minutes")
      .max(480, "Slot duration must be between 5 and 480 minutes")
      .optional(),
    bufferMinutes: z
      .number()
      .int("Buffer duration must be an integer")
      .min(0, "Buffer duration cannot be negative")
      .max(32_767, "Buffer duration is too large")
      .optional(),
    effectiveFrom: isoDateSchema.optional(),
    effectiveUntil: isoDateSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  })
  .refine((value) => assertTimeOrder(value.startTime, value.endTime), {
    message: "Schedule end time must be later than its start time",
    path: ["endTime"],
  })
  .refine((value) => assertDateOrder(value.effectiveFrom, value.effectiveUntil), {
    message: "Effective until date cannot be earlier than effective from date",
    path: ["effectiveUntil"],
  });


export const updateDoctorScheduleStatusSchema = z.object({
  isActive: z.boolean("isActive must be a boolean"),
});

export const doctorScheduleIdParamsSchema = z.object({
  id: z.uuid("Schedule id must be a UUID"),
});

export const listDoctorSchedulesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  doctorId: z.uuid("Doctor id must be a UUID").optional(),
  branchId: z.uuid("Branch id must be a UUID").optional(),
  dayOfWeek: z.coerce
    .number()
    .int("Day of week must be an integer")
    .min(1, "Day of week must be between 1 (Monday) and 7 (Sunday)")
    .max(7, "Day of week must be between 1 (Monday) and 7 (Sunday)")
    .optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  /** Calendar date the window must be effective on. */
  effectiveDate: isoDateSchema.optional(),
});

export type CreateDoctorScheduleBody = z.infer<typeof createDoctorScheduleSchema>;
export type UpdateDoctorScheduleBody = z.infer<typeof updateDoctorScheduleSchema>;
export type UpdateDoctorScheduleStatusBody = z.infer<
  typeof updateDoctorScheduleStatusSchema
>;
export type DoctorScheduleIdParams = z.infer<typeof doctorScheduleIdParamsSchema>;
export type ListDoctorSchedulesQuery = z.infer<typeof listDoctorSchedulesQuerySchema>;
