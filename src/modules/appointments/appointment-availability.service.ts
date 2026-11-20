import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  appointments,
  branches,
  doctorBranches,
  doctorBreaks,
  doctorLeaves,
  doctorSchedules,
  doctors,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import {
  addDaysToIsoDate,
  getZonedDateParts,
  isIanaTimeZone,
  isoWeekday,
  normalizeIsoDate,
  parseIsoDate,
  parseTimeToMinutes,
  zonedWallTimeToInstant,
} from "./appointment-availability.time.js";
import type {
  AvailabilityDay,
  AvailabilitySlot,
  DoctorAvailabilityQuery,
  DoctorAvailabilityResult,
  GetAvailableSlotsInput,
  IsSlotAvailableInput,
} from "./appointment-availability.types.js";

/**
 * Appointment availability service (Phase 18.2).
 *
 * Generates bookable slots from the existing scheduling entities; it does not
 * introduce a second availability model.
 *
 * - Working windows come from active `doctor_schedules` rows effective on the
 *   requested branch-local date. Times are wall-clock values in the branch
 *   timezone and may not span midnight (Phase 16 rule).
 * - Slots advance by the configured slot duration plus the configured pause
 *   after each slot. The last slot must fit entirely inside the window.
 * - Breaks and schedule windows are compared as local wall-clock minutes.
 *   Approved leave and appointments are compared as absolute TIMESTAMPTZ
 *   intervals.
 * - Only APPROVED leave blocks availability. PENDING leave is not approved and
 *   is deliberately non-blocking; REJECTED and CANCELLED never block.
 * - Appointments block when their status is active (PENDING, CONFIRMED,
 *   CHECKED_IN, IN_PROGRESS), matching the `appointments_no_overlap` exclusion
 *   constraint. CANCELLED, COMPLETED, NO_SHOW and RESCHEDULED are terminal and
 *   release the slot. NO_SHOW is historical and does not block future slots.
 * - The doctor's configured buffer is applied both when stepping slots and as
 *   the pause required after an existing appointment.
 * - Availability is advisory: the booking transaction must revalidate, because
 *   a slot can be taken between this read and the reservation.
 *
 * All reads run in a tenant-scoped transaction and filter `tenant_id` in SQL.
 * No patient information is selected or returned.
 */

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const MAX_RANGE_DAYS = 31;
/** Conservative padding so timezone offsets can never exclude a real slot. */
const QUERY_PADDING_MS = 36 * 60 * 60 * 1000;
const BLOCKING_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
] as const;

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeDate(value: string, field: string): string {
  try {
    return normalizeIsoDate(value, field);
  } catch (error) {
    throw AppError.validation((error as Error).message);
  }
}

function normalizeDuration(value: number | undefined): number | null {
  if (value === undefined) return null;

  if (
    !Number.isInteger(value) ||
    value < MIN_DURATION_MINUTES ||
    value > MAX_DURATION_MINUTES
  ) {
    throw AppError.validation(
      `Appointment duration must be an integer between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes`,
    );
  }

  return value;
}

function normalizeNow(value: Date | undefined): Date {
  if (value === undefined) return new Date();

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw AppError.validation("Reference time must be a valid Date");
  }

  return value;
}

function normalizeStartInstant(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw AppError.validation("Appointment start must be a valid timestamp");
    }

    return new Date(value.getTime());
  }

  const text = value.trim();

  if (!INSTANT_PATTERN.test(text)) {
    throw AppError.validation(
      'Appointment start must be an ISO 8601 timestamp with an explicit offset, e.g. "2026-12-07T09:00:00Z"',
    );
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation("Appointment start must be a valid timestamp");
  }

  return parsed;
}

function assertTimeZone(value: string): void {
  if (!isIanaTimeZone(value)) {
    throw AppError.unprocessable(
      `Branch timezone "${value}" is not a valid IANA timezone; availability cannot be calculated`,
    );
  }
}

function resolveDateRange(query: DoctorAvailabilityQuery): {
  fromDate: string;
  toDate: string;
} {
  const hasRange = query.fromDate !== undefined || query.toDate !== undefined;

  if (query.date !== undefined) {
    if (hasRange) {
      throw AppError.validation(
        "Provide either date or fromDate/toDate, not both",
      );
    }

    const date = normalizeDate(query.date, "Requested date");
    return { fromDate: date, toDate: date };
  }

  if (query.fromDate === undefined || query.toDate === undefined) {
    throw AppError.validation(
      "Provide a requested date, or both fromDate and toDate",
    );
  }

  const fromDate = normalizeDate(query.fromDate, "Range start date");
  const toDate = normalizeDate(query.toDate, "Range end date");

  if (toDate < fromDate) {
    throw AppError.validation("Range end date cannot be earlier than range start date");
  }

  const fromUtc = utcDayStart(fromDate);
  const toUtc = utcDayStart(toDate);
  const days = Math.round((toUtc - fromUtc) / 86_400_000) + 1;

  if (days > MAX_RANGE_DAYS) {
    throw AppError.validation(
      `Availability can be requested for at most ${MAX_RANGE_DAYS} days at a time`,
    );
  }

  return { fromDate, toDate };
}

function utcDayStart(date: string): number {
  const { year, month, day } = parseIsoDate(date);
  return Date.UTC(year, month - 1, day);
}

interface AvailabilityContext {
  readonly branchTimezone: string;
  readonly consultationFee: string;
  readonly currency: string;
}

/**
 * Verifies tenant ownership, doctor and branch activity, assignment and the
 * branch timezone. Consumers get 404 for missing/cross-tenant resources and 400
 * for inactive or unassigned ones, matching the schedule/leave services.
 */
async function loadAvailabilityContext(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  branchId: string,
): Promise<AvailabilityContext> {
  const [doctor] = await tx
    .select({ id: doctors.id, isActive: doctors.isActive, deletedAt: doctors.deletedAt })
    .from(doctors)
    .where(and(eq(doctors.id, doctorId), eq(doctors.tenantId, tenantId)))
    .limit(1);

  if (!doctor || doctor.deletedAt !== null) {
    throw AppError.notFound("Doctor not found");
  }

  if (!doctor.isActive) {
    throw AppError.badRequest("Availability is not offered for an inactive doctor");
  }

  const [branch] = await tx
    .select({
      id: branches.id,
      timezone: branches.timezone,
      isActive: branches.isActive,
      deletedAt: branches.deletedAt,
    })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)))
    .limit(1);

  if (!branch || branch.deletedAt !== null) {
    throw AppError.notFound("Branch not found");
  }

  if (!branch.isActive) {
    throw AppError.badRequest("Availability is not offered at an inactive branch");
  }

  assertTimeZone(branch.timezone);

  const [assignment] = await tx
    .select({
      isActive: doctorBranches.isActive,
      consultationFee: doctorBranches.consultationFee,
      currency: doctorBranches.currency,
    })
    .from(doctorBranches)
    .where(
      and(
        eq(doctorBranches.tenantId, tenantId),
        eq(doctorBranches.doctorId, doctorId),
        eq(doctorBranches.branchId, branchId),
      ),
    )
    .limit(1);

  if (!assignment) {
    throw AppError.badRequest("Doctor is not assigned to this branch");
  }

  if (!assignment.isActive) {
    throw AppError.badRequest("Doctor's assignment to this branch is inactive");
  }

  return {
    branchTimezone: branch.timezone,
    consultationFee: assignment.consultationFee,
    currency: assignment.currency,
  };
}

interface ScheduleRow {
  readonly id: string;
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMinutes: number;
  readonly bufferMinutes: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

interface BreakRow {
  readonly scheduleId: string;
  readonly startMinutes: number;
  readonly endMinutes: number;
}

interface IntervalRow {
  readonly startAt: Date;
  readonly endAt: Date;
}

interface AvailabilityData {
  readonly schedules: readonly ScheduleRow[];
  readonly breaksBySchedule: ReadonlyMap<string, readonly BreakRow[]>;
  readonly leaves: readonly IntervalRow[];
  readonly appointments: readonly IntervalRow[];
}

/**
 * Fetches everything needed for the range in fixed queries (no per-slot or
 * per-day queries): schedules, their breaks, approved leave and blocking
 * appointments.
 */
async function loadAvailabilityData(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  branchId: string,
  fromDate: string,
  toDate: string,
  excludeAppointmentId?: string,
): Promise<AvailabilityData> {
  const schedules = await tx
    .select({
      id: doctorSchedules.id,
      dayOfWeek: doctorSchedules.dayOfWeek,
      startTime: doctorSchedules.startTime,
      endTime: doctorSchedules.endTime,
      slotDurationMinutes: doctorSchedules.slotDurationMinutes,
      bufferMinutes: doctorSchedules.bufferMinutes,
      effectiveFrom: doctorSchedules.effectiveFrom,
      effectiveUntil: doctorSchedules.effectiveUntil,
    })
    .from(doctorSchedules)
    .where(
      and(
        eq(doctorSchedules.tenantId, tenantId),
        eq(doctorSchedules.doctorId, doctorId),
        eq(doctorSchedules.branchId, branchId),
        eq(doctorSchedules.isActive, true),
        lte(doctorSchedules.effectiveFrom, toDate),
        or(
          isNull(doctorSchedules.effectiveUntil),
          gte(doctorSchedules.effectiveUntil, fromDate),
        ),
      ),
    )
    .orderBy(doctorSchedules.dayOfWeek, doctorSchedules.startTime);

  const scheduleIds = schedules.map((schedule) => schedule.id);
  const breakRows =
    scheduleIds.length === 0
      ? []
      : await tx
          .select({
            scheduleId: doctorBreaks.scheduleId,
            startTime: doctorBreaks.startTime,
            endTime: doctorBreaks.endTime,
          })
          .from(doctorBreaks)
          .where(
            and(
              eq(doctorBreaks.tenantId, tenantId),
              inArray(doctorBreaks.scheduleId, scheduleIds),
            ),
          );

  const breaksBySchedule = new Map<string, BreakRow[]>();
  for (const row of breakRows) {
    const list = breaksBySchedule.get(row.scheduleId) ?? [];
    list.push({
      scheduleId: row.scheduleId,
      startMinutes: parseTimeToMinutes(row.startTime),
      endMinutes: parseTimeToMinutes(row.endTime),
    });
    breaksBySchedule.set(row.scheduleId, list);
  }

  const rangeStart = new Date(utcDayStart(fromDate) - QUERY_PADDING_MS);
  const rangeEnd = new Date(utcDayStart(addDaysToIsoDate(toDate, 1)) + QUERY_PADDING_MS);

  const leaveRows = await tx
    .select({ startAt: doctorLeaves.startAt, endAt: doctorLeaves.endAt })
    .from(doctorLeaves)
    .where(
      and(
        eq(doctorLeaves.tenantId, tenantId),
        eq(doctorLeaves.doctorId, doctorId),
        eq(doctorLeaves.status, "APPROVED"),
        or(isNull(doctorLeaves.branchId), eq(doctorLeaves.branchId, branchId)),
        lt(doctorLeaves.startAt, rangeEnd),
        gt(doctorLeaves.endAt, rangeStart),
      ),
    );

  const appointmentRows = await tx
    .select({ startAt: appointments.startAt, endAt: appointments.endAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.doctorId, doctorId),
        eq(appointments.branchId, branchId),
        excludeAppointmentId === undefined
          ? undefined
          : ne(appointments.id, excludeAppointmentId),
        inArray(appointments.appointmentStatus, [...BLOCKING_STATUSES]),
        lt(appointments.startAt, rangeEnd),
        gt(appointments.endAt, rangeStart),
      ),
    );

  return {
    schedules,
    breaksBySchedule,
    leaves: leaveRows,
    appointments: appointmentRows,
  };
}

interface GenerateDayOptions {
  readonly date: string;
  readonly timezone: string;
  readonly durationOverride: number | null;
  readonly now: Date;
  readonly data: AvailabilityData;
}

function generateDaySlots(options: GenerateDayOptions): AvailabilityDay {
  const { date, timezone, durationOverride, now, data } = options;
  const weekday = isoWeekday(date);
  const slotsByStart = new Map<number, AvailabilitySlot>();

  for (const schedule of data.schedules) {
    if (schedule.dayOfWeek !== weekday) continue;
    if (schedule.effectiveFrom > date) continue;
    if (schedule.effectiveUntil !== null && schedule.effectiveUntil < date) continue;

    const duration = durationOverride ?? schedule.slotDurationMinutes;
    const step = duration + schedule.bufferMinutes;
    const windowStart = parseTimeToMinutes(schedule.startTime);
    const windowEnd = parseTimeToMinutes(schedule.endTime);
    const breaks = data.breaksBySchedule.get(schedule.id) ?? [];

    for (
      let localStart = windowStart;
      localStart + duration <= windowEnd;
      localStart += step
    ) {
      const localEnd = localStart + duration;

      // Breaks are recurring local wall-clock ranges inside the window.
      if (
        breaks.some(
          (entry) => entry.startMinutes < localEnd && entry.endMinutes > localStart,
        )
      ) {
        continue;
      }

      const conversion = zonedWallTimeToInstant(date, localStart, timezone);

      // Spring-forward local times do not exist and are skipped, per the
      // documented Phase 16 policy. Ambiguous fall-back times use the first
      // occurrence.
      if (conversion.instant === null) continue;

      const startAt = conversion.instant;
      const endAt = new Date(startAt.getTime() + duration * 60_000);

      if (startAt.getTime() <= now.getTime()) continue;

      if (
        data.leaves.some(
          (leave) => leave.startAt < endAt && leave.endAt > startAt,
        )
      ) {
        continue;
      }

      // The configured pause applies after an existing appointment too. The
      // appointment table stores exact intervals, so the current window's
      // buffer is the only available margin.
      if (
        data.appointments.some(
          (appointment) =>
            startAt <
              new Date(appointment.endAt.getTime() + schedule.bufferMinutes * 60_000) &&
            endAt > appointment.startAt,
        )
      ) {
        continue;
      }

      if (!slotsByStart.has(startAt.getTime())) {
        slotsByStart.set(startAt.getTime(), {
          startAt,
          endAt,
          durationMinutes: duration,
        });
      }
    }
  }

  return {
    date,
    slots: [...slotsByStart.values()].sort(
      (left, right) => left.startAt.getTime() - right.startAt.getTime(),
    ),
  };
}

/**
 * Returns availability for one day or an inclusive date range. Days with no
 * working window are present with an empty `slots` array so callers do not
 * have to distinguish "no schedule" from "no availability".
 */
export async function getDoctorAvailability(
  tenantId: string,
  query: DoctorAvailabilityQuery,
): Promise<DoctorAvailabilityResult> {
  const { fromDate, toDate } = resolveDateRange(query);
  const durationOverride = normalizeDuration(query.durationMinutes);
  const now = normalizeNow(query.now);

  return withTenantTransaction(tenantId, async (tx) => {
    const context = await loadAvailabilityContext(
      tx,
      tenantId,
      query.doctorId,
      query.branchId,
    );
    const data = await loadAvailabilityData(
      tx,
      tenantId,
      query.doctorId,
      query.branchId,
      fromDate,
      toDate,
    );

    const days: AvailabilityDay[] = [];
    let date = fromDate;

    while (date <= toDate) {
      days.push(
        generateDaySlots({
          date,
          timezone: context.branchTimezone,
          durationOverride,
          now,
          data,
        }),
      );
      date = addDaysToIsoDate(date, 1);
    }

    return {
      doctorId: query.doctorId,
      branchId: query.branchId,
      branchTimezone: context.branchTimezone,
      fromDate,
      toDate,
      requestedDurationMinutes: durationOverride,
      consultationFee: context.consultationFee,
      currency: context.currency,
      days,
    };
  });
}

/** Available slots for a single branch-local date, flattened for convenience. */
export async function getAvailableSlots(
  tenantId: string,
  input: GetAvailableSlotsInput,
): Promise<AvailabilitySlot[]> {
  const result = await getDoctorAvailability(tenantId, {
    doctorId: input.doctorId,
    branchId: input.branchId,
    date: input.date,
    durationMinutes: input.durationMinutes,
    now: input.now,
  });

  return [...(result.days[0]?.slots ?? [])];
}

/** Why a specific interval cannot be booked. Advisory only: booking revalidates. */
export type SlotUnavailabilityReason =
  | "NO_SCHEDULE"
  | "OUTSIDE_SCHEDULE"
  | "DURATION_DOES_NOT_FIT"
  | "PAST"
  | "BREAK"
  | "LEAVE"
  | "OCCUPIED";

/**
 * Outcome of evaluating one concrete interval against the existing scheduling
 * model. `durationMinutes` / `endAt` are `null` only when no working window
 * applies at all, so there is no configured duration to fall back on.
 */
export interface SlotEvaluation {
  readonly bookable: boolean;
  readonly reason: SlotUnavailabilityReason | null;
  readonly startAt: Date;
  readonly endAt: Date | null;
  readonly durationMinutes: number | null;
  readonly branchTimezone: string;
  readonly consultationFee: string;
  readonly currency: string;
}

/**
 * Evaluates a concrete interval against the Phase 18.2 scheduling model and
 * reports *why* it is unavailable, so the booking service can produce a safe
 * 409 without recomputing availability.
 *
 * The interval must:
 * - start inside one active, effective working window on the branch-local day;
 * - fit entirely inside that window;
 * - not overlap a break, approved leave or an active appointment (with the
 *   window's buffer applied after the appointment);
 * - start in the future.
 *
 * It accepts any start on the local slot grid, not only generated boundaries.
 * Missing/cross-tenant resources, inactive doctors/branches, invalid
 * assignments and invalid input still throw (404/400/422); availability
 * conflicts are reported as `bookable: false`.
 */
/** Extra options for an evaluation inside another operation. */
export interface SlotEvaluationOptions {
  /**
   * Appointment to ignore as an existing reservation. Rescheduling uses this so
   * a move that overlaps the appointment's own current interval is evaluated
   * against every *other* booking, not against itself.
   */
  readonly excludeAppointmentId?: string;
}

export async function evaluateSlotBooking(
  tx: DbExecutor,
  tenantId: string,
  input: IsSlotAvailableInput,
  options: SlotEvaluationOptions = {},
): Promise<SlotEvaluation> {
  const startAt = normalizeStartInstant(input.startAt);
  const durationOverride = normalizeDuration(input.durationMinutes);
  const now = normalizeNow(input.now);

  const context = await loadAvailabilityContext(
    tx,
    tenantId,
    input.doctorId,
    input.branchId,
  );

  const local = getZonedDateParts(startAt, context.branchTimezone);
  const weekday = isoWeekday(local.date);
  const data = await loadAvailabilityData(
    tx,
    tenantId,
    input.doctorId,
    input.branchId,
    local.date,
    local.date,
    options.excludeAppointmentId,
  );

  const base = {
    startAt,
    branchTimezone: context.branchTimezone,
    consultationFee: context.consultationFee,
    currency: context.currency,
  };

  const unavailable = (
    reason: SlotUnavailabilityReason,
    durationMinutes: number | null,
    endAt: Date | null,
  ): SlotEvaluation => ({ ...base, bookable: false, reason, durationMinutes, endAt });

  const effectiveToday = data.schedules.filter(
    (candidate) =>
      candidate.dayOfWeek === weekday &&
      candidate.effectiveFrom <= local.date &&
      (candidate.effectiveUntil === null || candidate.effectiveUntil >= local.date),
  );

  const schedule = effectiveToday.find(
    (candidate) =>
      local.minutes >= parseTimeToMinutes(candidate.startTime) &&
      local.minutes < parseTimeToMinutes(candidate.endTime),
  );

  if (!schedule) {
    return unavailable(
      effectiveToday.length === 0 ? "NO_SCHEDULE" : "OUTSIDE_SCHEDULE",
      durationOverride,
      null,
    );
  }

  const duration = durationOverride ?? schedule.slotDurationMinutes;
  const endAt = new Date(startAt.getTime() + duration * 60_000);

  if (local.minutes + duration > parseTimeToMinutes(schedule.endTime)) {
    return unavailable("DURATION_DOES_NOT_FIT", duration, endAt);
  }

  if (startAt.getTime() <= now.getTime()) {
    return unavailable("PAST", duration, endAt);
  }

  const breaks = data.breaksBySchedule.get(schedule.id) ?? [];
  const localEnd = local.minutes + duration;

  if (
    breaks.some(
      (entry) => entry.startMinutes < localEnd && entry.endMinutes > local.minutes,
    )
  ) {
    return unavailable("BREAK", duration, endAt);
  }

  if (
    data.leaves.some(
      (leave) => leave.startAt < endAt && leave.endAt > startAt,
    )
  ) {
    return unavailable("LEAVE", duration, endAt);
  }

  if (
    data.appointments.some(
      (appointment) =>
        startAt <
          new Date(appointment.endAt.getTime() + schedule.bufferMinutes * 60_000) &&
        endAt > appointment.startAt,
    )
  ) {
    return unavailable("OCCUPIED", duration, endAt);
  }

  return { ...base, bookable: true, reason: null, durationMinutes: duration, endAt };
}

/**
 * Answers whether a specific absolute interval can be booked.
 *
 * Returns `false` for availability conflicts. Missing/cross-tenant resources,
 * inactive doctors/branches, invalid assignments and invalid input still throw.
 * This is a read-time check only; booking must revalidate transactionally.
 */
export async function isSlotAvailable(
  tenantId: string,
  input: IsSlotAvailableInput,
): Promise<boolean> {
  return withTenantTransaction(tenantId, async (tx) => {
    const evaluation = await evaluateSlotBooking(tx, tenantId, input);
    return evaluation.bookable;
  });
}

