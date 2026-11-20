import { z } from "zod";

/**
 * Request validation for the appointment API (Phase 18.6).
 *
 * These schemas only check transport-level shape. Tenant ownership, actor
 * identity, availability, fee resolution, transitions and idempotency replay
 * stay in the Phase 18.2-18.5 services, so validation cannot drift from the
 * rules the services actually enforce.
 *
 * Every body schema is `.strict()`: `tenantId`, `createdBy`, `appointmentCode`,
 * `appointmentStatus` and `consultationFee` are rejected with a 422 instead of
 * being silently ignored. Status is never client-writable: lifecycle endpoints
 * apply the transition table.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Mirrors the service's accepted instant format (explicit offset required). */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const APPOINTMENT_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
] as const;

export const APPOINTMENT_SOURCES = [
  "ONLINE",
  "RECEPTIONIST",
  "WALK_IN",
  "VOICE_AGENT",
] as const;

export const APPOINTMENT_TYPES = [
  "CONSULTATION",
  "FOLLOW_UP",
  "PROCEDURE",
  "EMERGENCY",
] as const;

/**
 * Sources a hospital staff member may record. `ONLINE` is the patient
 * self-service channel and is derived by the booking service, so accepting it
 * here would let staff misattribute a booking's origin.
 */
export const STAFF_BOOKING_SOURCES = ["RECEPTIONIST", "WALK_IN", "VOICE_AGENT"] as const;

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const MAX_REASON_LENGTH = 1000;
const MAX_NOTES_LENGTH = 2000;
const MAX_CANCELLATION_REASON_LENGTH = 1000;
const MAX_NO_SHOW_REASON_LENGTH = 500;

/** Accepts `""` as "not supplied" so optional text can be cleared. */
const emptyStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** ISO calendar date that must exist (rejects 2026-02-30 and 12/04/2026). */
export const appointmentDateSchema = z
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

/** Absolute timestamp with an explicit offset; the service re-checks this. */
export const appointmentInstantSchema = z
  .string()
  .trim()
  .regex(
    INSTANT_PATTERN,
    'Timestamp must be ISO 8601 with an explicit offset, e.g. "2026-12-07T09:00:00Z"',
  )
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Timestamp must be valid");

const durationMinutesSchema = z
  .number()
  .int("Duration must be a whole number of minutes")
  .min(MIN_DURATION_MINUTES, `Duration must be at least ${MIN_DURATION_MINUTES} minutes`)
  .max(MAX_DURATION_MINUTES, `Duration must be at most ${MAX_DURATION_MINUTES} minutes`);

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1, "Idempotency key cannot be empty")
  .max(200, "Idempotency key must be at most 200 characters");

const optionalText = (maxLength: number) =>
  z.preprocess(
    emptyStringToNull,
    z.string().trim().max(maxLength, `Must be at most ${maxLength} characters`).nullable().optional(),
  );

export const appointmentIdParamsSchema = z.object({
  appointmentId: z.uuid("Appointment id must be a UUID"),
});

export const appointmentCodeParamsSchema = z.object({
  appointmentCode: z
    .string()
    .trim()
    .min(1, "Appointment code is required")
    .max(40, "Appointment code must be at most 40 characters")
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9-]*$/,
      "Appointment code may only contain letters, digits and dashes",
    ),
});

export const doctorAvailabilityParamsSchema = z.object({
  doctorId: z.uuid("Doctor id must be a UUID"),
});

/**
 * Availability query. A single `date` is mutually exclusive with the inclusive
 * `fromDate`/`toDate` range; the service enforces the same rules and range cap.
 */
const availabilityQueryFields = {
  branchId: z.uuid("Branch id must be a UUID"),
  date: appointmentDateSchema.optional(),
  fromDate: appointmentDateSchema.optional(),
  toDate: appointmentDateSchema.optional(),
  durationMinutes: durationMinutesSchema.optional(),
};

/** Shared date/range rules; zod 4 does not allow `.omit()` after refinements. */
function withAvailabilityRefinements<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema
    .refine(
      (value) =>
        value.date === undefined ||
        (value.fromDate === undefined && value.toDate === undefined),
      {
        message: "Provide either date or fromDate/toDate, not both",
        path: ["date"],
      },
    )
    .refine(
      (value) =>
        value.date !== undefined ||
        (value.fromDate !== undefined && value.toDate !== undefined),
      {
        message: "Provide a date, or both fromDate and toDate",
        path: ["date"],
      },
    )
    .refine(
      (value) => {
        const from = value.fromDate as string | undefined;
        const to = value.toDate as string | undefined;

        return from === undefined || to === undefined || from <= to;
      },
      { message: "fromDate must be on or before toDate", path: ["toDate"] },
    );
}

export const availabilityQuerySchema = withAvailabilityRefinements(
  z.object({
    doctorId: z.uuid("Doctor id must be a UUID"),
    ...availabilityQueryFields,
  }),
);

/** Same query fields, for the doctor-scoped availability path. */
export const doctorAvailabilityQuerySchema = withAvailabilityRefinements(
  z.object(availabilityQueryFields),
);

export const createAppointmentSchema = z
  .object({
    patientId: z.uuid("Patient id must be a UUID"),
    doctorId: z.uuid("Doctor id must be a UUID"),
    branchId: z.uuid("Branch id must be a UUID"),
    departmentId: z.uuid("Department id must be a UUID").nullable().optional(),
    startAt: appointmentInstantSchema,
    durationMinutes: durationMinutesSchema.optional(),
    appointmentSource: z
      .enum(STAFF_BOOKING_SOURCES, "Online bookings are created through the patient channel")
      .optional(),
    appointmentType: z.enum(APPOINTMENT_TYPES, "Unknown appointment type").optional(),
    reason: optionalText(MAX_REASON_LENGTH),
    notes: optionalText(MAX_NOTES_LENGTH),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

/**
 * Listing/filter query. `dateFrom`/`dateTo` are inclusive UTC calendar-date
 * bounds on the appointment start instant; pagination is bounded to 100 rows.
 */
export const listAppointmentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
    search: z.string().trim().max(100, "Search must be at most 100 characters").optional(),
    patientId: z.uuid("Patient id must be a UUID").optional(),
    doctorId: z.uuid("Doctor id must be a UUID").optional(),
    branchId: z.uuid("Branch id must be a UUID").optional(),
    departmentId: z.uuid("Department id must be a UUID").optional(),
    status: z.enum(APPOINTMENT_STATUSES, "Unknown appointment status").optional(),
    source: z.enum(APPOINTMENT_SOURCES, "Unknown appointment source").optional(),
    dateFrom: appointmentDateSchema.optional(),
    dateTo: appointmentDateSchema.optional(),
  })
  .refine(
    (value) =>
      value.dateFrom === undefined ||
      value.dateTo === undefined ||
      value.dateFrom <= value.dateTo,
    { message: "dateFrom must be on or before dateTo", path: ["dateTo"] },
  );

export const rescheduleAppointmentSchema = z
  .object({
    doctorId: z.uuid("Doctor id must be a UUID").optional(),
    branchId: z.uuid("Branch id must be a UUID").optional(),
    departmentId: z.uuid("Department id must be a UUID").nullable().optional(),
    startAt: appointmentInstantSchema,
    endAt: appointmentInstantSchema.optional(),
    durationMinutes: durationMinutesSchema.optional(),
    reason: optionalText(MAX_REASON_LENGTH),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .refine(
    (value) => !(value.endAt !== undefined && value.durationMinutes !== undefined),
    {
      message: "Provide either endAt or durationMinutes, not both",
      path: ["endAt"],
    },
  );

export const cancelAppointmentSchema = z
  .object({
    cancellationReason: z
      .string()
      .trim()
      .min(1, "Cancellation reason is required")
      .max(
        MAX_CANCELLATION_REASON_LENGTH,
        `Cancellation reason must be at most ${MAX_CANCELLATION_REASON_LENGTH} characters`,
      ),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

/**
 * No-show body is optional; an absent body is treated as `{}`, so a caller can
 * mark a no-show without sending one. Only `reason` is accepted.
 */
export const noShowSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      reason: optionalText(MAX_NO_SHOW_REASON_LENGTH),
    })
    .strict(),
);

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type CreateAppointmentBody = z.infer<typeof createAppointmentSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
export type RescheduleAppointmentBody = z.infer<typeof rescheduleAppointmentSchema>;
export type CancelAppointmentBody = z.infer<typeof cancelAppointmentSchema>;
export type NoShowBody = z.infer<typeof noShowSchema>;
