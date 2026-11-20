import { and, asc, desc, eq, gt, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  branches,
  doctorBreaks,
  doctorBranches,
  doctorSchedules,
  doctors,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { isValidTimeZone } from "../branches/branch.schemas.js";
import type {
  CreateDoctorScheduleInput,
  DoctorScheduleDto,
  DoctorScheduleListResult,
  DoctorScheduleSortField,
  ListDoctorSchedulesFilters,
  UpdateDoctorScheduleInput,
} from "./schedule.types.js";

/**
 * Doctor recurring schedule service (Task 16.2).
 *
 * Rules:
 * - A schedule always belongs to an existing doctor and a branch the doctor is
 *   currently assigned to (active `doctor_branches` row), in the same tenant.
 *   The database enforces the same rule with a composite foreign key.
 * - Times are branch-local wall-clock values; this service performs no UTC
 *   conversion and exposes the branch IANA zone on every DTO.
 * - One row is one weekly working period, so a split shift is two rows. Windows
 *   may not overlap when both their effective dates and wall-clock times
 *   overlap; this is checked here for a clear 409 and enforced by the schema's
 *   GiST exclusion constraint under concurrency.
 * - Inactive rows are history and may overlap; reactivating one re-runs the
 *   overlap check.
 * - Every read/write is tenant-scoped in SQL and inside an RLS transaction.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MIN_SLOT_MINUTES = 5;
const MAX_SLOT_MINUTES = 480;
const MAX_BUFFER_MINUTES = 32_767;
const DEFAULT_SLOT_MINUTES = 15;
const DAY_OF_WEEK_MIN = 1;
const DAY_OF_WEEK_MAX = 7;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** Drizzle wraps driver errors, so walk the `cause` chain for SQLSTATE data. */
function pgErrorInfo(error: unknown): PgErrorInfo {
  const info: { code?: string; constraint?: string } = {};
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (info.code === undefined && typeof candidate.code === "string") {
      info.code = candidate.code;
    }
    if (info.constraint === undefined && typeof candidate.constraint === "string") {
      info.constraint = candidate.constraint;
    }

    current = candidate.cause;
  }

  return info;
}

function mapScheduleWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23P01" && constraint === "doctor_schedules_no_overlap") {
    // The application pre-check lost a race: the exclusion constraint is the
    // authoritative guard against concurrent overlapping inserts.
    throw AppError.conflict(
      "The doctor already has an overlapping active schedule window for this branch and weekday",
    );
  }

  if (code === "23514") {
    throw AppError.validation("Schedule data violates a database constraint");
  }

  if (code === "23503") {
    throw AppError.badRequest(
      "The doctor is no longer assigned to this branch, or the branch no longer exists",
    );
  }

  if (code === "22007" || code === "22008") {
    throw AppError.validation("Invalid date or time value in schedule data");
  }

  throw error;
}

function normalizeDayOfWeek(value: number): number {
  if (!Number.isInteger(value) || value < DAY_OF_WEEK_MIN || value > DAY_OF_WEEK_MAX) {
    throw AppError.validation(
      "Day of week must be an integer between 1 (Monday) and 7 (Sunday)",
    );
  }

  return value;
}

/** Accepts `HH:MM` or `HH:MM:SS` and always stores seconds (`HH:MM:SS`). */
function normalizeTime(value: string, field: string): string {
  const match = TIME_PATTERN.exec(value.trim());

  if (!match) {
    throw AppError.validation(`${field} must be a 24-hour time such as "09:00" or "09:00:00"`);
  }

  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

/** Strict ISO calendar date validation (rejects 2026-02-30). */
function normalizeDate(value: string, field: string): string {
  const match = DATE_PATTERN.exec(value.trim());

  if (!match) {
    throw AppError.validation(`${field} must be an ISO date (YYYY-MM-DD)`);
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw AppError.validation(`${field} must be a valid calendar date`);
  }

  return `${yearText}-${monthText}-${dayText}`;
}

function normalizeSlotDuration(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SLOT_MINUTES;

  if (
    !Number.isInteger(value) ||
    value < MIN_SLOT_MINUTES ||
    value > MAX_SLOT_MINUTES
  ) {
    throw AppError.validation(
      `Slot duration must be an integer between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES} minutes`,
    );
  }

  return value;
}

function normalizeBuffer(value: number | undefined): number {
  if (value === undefined) return 0;

  if (!Number.isInteger(value) || value < 0 || value > MAX_BUFFER_MINUTES) {
    throw AppError.validation(
      `Buffer duration must be an integer between 0 and ${MAX_BUFFER_MINUTES} minutes`,
    );
  }

  return value;
}

function minutesBetween(startTime: string, endTime: string): number {
  const [startHour, startMinute, startSecond = "0"] = startTime.split(":");
  const [endHour, endMinute, endSecond = "0"] = endTime.split(":");

  const startSeconds =
    Number(startHour) * 3600 + Number(startMinute) * 60 + Number(startSecond);
  const endSeconds = Number(endHour) * 3600 + Number(endMinute) * 60 + Number(endSecond);

  return Math.floor((endSeconds - startSeconds) / 60);
}

/** Today's calendar date in the branch zone (effective dates are local). */
function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function assertValidBranchTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw AppError.unprocessable(
      `Branch timezone "${timeZone}" is not a valid IANA timezone; schedules cannot be interpreted`,
    );
  }
}

function assertTimeWindow(
  startTime: string,
  endTime: string,
  slotDurationMinutes: number,
): void {
  if (endTime <= startTime) {
    // ISO time strings compare correctly and this also rules out overnight
    // windows, which must be modelled as two weekday rows.
    throw AppError.validation("Schedule end time must be later than its start time");
  }

  if (minutesBetween(startTime, endTime) < slotDurationMinutes) {
    throw AppError.validation(
      "Schedule window must be long enough for at least one slot of the configured duration",
    );
  }
}

function assertEffectiveRange(effectiveFrom: string, effectiveUntil: string | null): void {
  if (effectiveUntil !== null && effectiveUntil < effectiveFrom) {
    throw AppError.validation("Effective until date cannot be earlier than effective from date");
  }
}

const scheduleSelection = {
  id: doctorSchedules.id,
  doctorId: doctorSchedules.doctorId,
  branchId: doctorSchedules.branchId,
  dayOfWeek: doctorSchedules.dayOfWeek,
  startTime: doctorSchedules.startTime,
  endTime: doctorSchedules.endTime,
  slotDurationMinutes: doctorSchedules.slotDurationMinutes,
  bufferMinutes: doctorSchedules.bufferMinutes,
  effectiveFrom: doctorSchedules.effectiveFrom,
  effectiveUntil: doctorSchedules.effectiveUntil,
  isActive: doctorSchedules.isActive,
  createdAt: doctorSchedules.createdAt,
  updatedAt: doctorSchedules.updatedAt,
  doctorCode: doctors.doctorCode,
  doctorFullName: users.fullName,
  branchName: branches.name,
  branchCode: branches.branchCode,
  branchTimezone: branches.timezone,
};

type ScheduleRow = {
  id: string;
  doctorId: string;
  branchId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  doctorCode: string;
  doctorFullName: string;
  branchName: string;
  branchCode: string;
  branchTimezone: string;
};

function toDto(row: ScheduleRow): DoctorScheduleDto {
  return {
    id: row.id,
    doctorId: row.doctorId,
    branchId: row.branchId,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    slotDurationMinutes: row.slotDurationMinutes,
    bufferMinutes: row.bufferMinutes,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    doctor: {
      id: row.doctorId,
      doctorCode: row.doctorCode,
      fullName: row.doctorFullName,
    },
    branch: {
      id: row.branchId,
      name: row.branchName,
      branchCode: row.branchCode,
      timezone: row.branchTimezone,
    },
  };
}

async function findScheduleRow(
  tx: DbExecutor,
  tenantId: string,
  scheduleId: string,
): Promise<ScheduleRow> {
  const [row] = await tx
    .select(scheduleSelection)
    .from(doctorSchedules)
    .innerJoin(
      doctors,
      and(eq(doctors.id, doctorSchedules.doctorId), eq(doctors.tenantId, doctorSchedules.tenantId)),
    )
    .innerJoin(users, eq(users.id, doctors.userId))
    .innerJoin(
      branches,
      and(
        eq(branches.id, doctorSchedules.branchId),
        eq(branches.tenantId, doctorSchedules.tenantId),
      ),
    )
    .where(
      and(eq(doctorSchedules.id, scheduleId), eq(doctorSchedules.tenantId, tenantId)),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Schedule not found");

  return row;
}

/**
 * Validates the doctor, the branch and the doctor's assignment to that branch,
 * returning the branch's timezone. Re-run on every write so a schedule can never
 * outlive an assignment that was later deactivated.
 */
async function assertDoctorBranchUsable(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  branchId: string,
): Promise<{ timezone: string }> {
  const [doctor] = await tx
    .select({ id: doctors.id, isActive: doctors.isActive, deletedAt: doctors.deletedAt })
    .from(doctors)
    .where(and(eq(doctors.id, doctorId), eq(doctors.tenantId, tenantId)))
    .limit(1);

  if (!doctor || doctor.deletedAt !== null) {
    throw AppError.notFound("Doctor not found");
  }

  if (!doctor.isActive) {
    throw AppError.badRequest("Schedules cannot be added for an inactive doctor");
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
    throw AppError.badRequest("Schedules cannot be added at an inactive branch");
  }

  assertValidBranchTimeZone(branch.timezone);

  const [assignment] = await tx
    .select({ isActive: doctorBranches.isActive })
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

  return { timezone: branch.timezone };
}

interface OverlapCandidate {
  readonly doctorId: string;
  readonly branchId: string;
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

/**
 * Finds one active window for the same doctor/branch/weekday whose effective
 * dates AND wall-clock times both intersect the candidate. This mirrors the
 * `doctor_schedules_no_overlap` exclusion constraint, including its inclusive
 * closed date bounds and half-open time bounds.
 */
async function findOverlappingSchedule(
  tx: DbExecutor,
  tenantId: string,
  candidate: OverlapCandidate,
  excludeScheduleId?: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: doctorSchedules.id })
    .from(doctorSchedules)
    .where(
      and(
        eq(doctorSchedules.tenantId, tenantId),
        eq(doctorSchedules.doctorId, candidate.doctorId),
        eq(doctorSchedules.branchId, candidate.branchId),
        eq(doctorSchedules.dayOfWeek, candidate.dayOfWeek),
        eq(doctorSchedules.isActive, true),
        excludeScheduleId === undefined
          ? undefined
          : ne(doctorSchedules.id, excludeScheduleId),
        candidate.effectiveUntil === null
          ? undefined
          : lte(doctorSchedules.effectiveFrom, candidate.effectiveUntil),
        or(
          isNull(doctorSchedules.effectiveUntil),
          gte(doctorSchedules.effectiveUntil, candidate.effectiveFrom),
        ),
        lt(doctorSchedules.startTime, candidate.endTime),
        gt(doctorSchedules.endTime, candidate.startTime),
      ),
    )
    .limit(1);

  return row;
}

/**
 * A schedule window may only shrink if every existing break still fits. Breaks
 * are never silently deleted or shifted; the caller must adjust them first.
 */
async function assertBreaksFitWindow(
  tx: DbExecutor,
  tenantId: string,
  scheduleId: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  const [breakRow] = await tx
    .select({ id: doctorBreaks.id, startTime: doctorBreaks.startTime, endTime: doctorBreaks.endTime })
    .from(doctorBreaks)
    .where(
      and(
        eq(doctorBreaks.tenantId, tenantId),
        eq(doctorBreaks.scheduleId, scheduleId),
        or(lt(doctorBreaks.startTime, startTime), gt(doctorBreaks.endTime, endTime)),
      ),
    )
    .limit(1);

  if (breakRow) {
    throw AppError.conflict(
      "Schedule update would leave existing breaks outside the new window; adjust the breaks first",
      { breakId: breakRow.id, startTime: breakRow.startTime, endTime: breakRow.endTime },
    );
  }
}

async function assertNoOverlap(
  tx: DbExecutor,
  tenantId: string,
  candidate: OverlapCandidate,
  excludeScheduleId?: string,
): Promise<void> {
  const existing = await findOverlappingSchedule(tx, tenantId, candidate, excludeScheduleId);

  if (existing) {
    throw AppError.conflict(
      "The doctor already has an overlapping active schedule window for this branch and weekday",
      { scheduleId: existing.id },
    );
  }
}

export async function createDoctorSchedule(
  tenantId: string,
  input: CreateDoctorScheduleInput,
): Promise<DoctorScheduleDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const { timezone } = await assertDoctorBranchUsable(
        tx,
        tenantId,
        input.doctorId,
        input.branchId,
      );

      const dayOfWeek = normalizeDayOfWeek(input.dayOfWeek);
      const startTime = normalizeTime(input.startTime, "Start time");
      const endTime = normalizeTime(input.endTime, "End time");
      const slotDurationMinutes = normalizeSlotDuration(input.slotDurationMinutes);
      const bufferMinutes = normalizeBuffer(input.bufferMinutes);
      const effectiveFrom =
        input.effectiveFrom === undefined
          ? todayInTimeZone(timezone)
          : normalizeDate(input.effectiveFrom, "Effective from date");
      const effectiveUntil =
        input.effectiveUntil === undefined || input.effectiveUntil === null
          ? null
          : normalizeDate(input.effectiveUntil, "Effective until date");
      const isActive = input.isActive ?? true;

      assertTimeWindow(startTime, endTime, slotDurationMinutes);
      assertEffectiveRange(effectiveFrom, effectiveUntil);

      if (isActive) {
        await assertNoOverlap(tx, tenantId, {
          doctorId: input.doctorId,
          branchId: input.branchId,
          dayOfWeek,
          startTime,
          endTime,
          effectiveFrom,
          effectiveUntil,
        });
      }

      const [created] = await tx
        .insert(doctorSchedules)
        .values({
          tenantId,
          doctorId: input.doctorId,
          branchId: input.branchId,
          dayOfWeek,
          startTime,
          endTime,
          slotDurationMinutes,
          bufferMinutes,
          effectiveFrom,
          effectiveUntil,
          isActive,
        })
        .returning({ id: doctorSchedules.id });

      if (!created) throw AppError.internal("Failed to create schedule");

      return toDto(await findScheduleRow(tx, tenantId, created.id));
    });
  } catch (error) {
    mapScheduleWriteError(error);
  }
}

export async function listDoctorSchedules(
  tenantId: string,
  filters: ListDoctorSchedulesFilters = {},
): Promise<DoctorScheduleListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  const dayOfWeek =
    filters.dayOfWeek === undefined ? undefined : normalizeDayOfWeek(filters.dayOfWeek);
  const effectiveOn =
    filters.effectiveOn === undefined
      ? undefined
      : normalizeDate(filters.effectiveOn, "Effective on date");

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(doctorSchedules.tenantId, tenantId)];

    if (filters.doctorId !== undefined) {
      conditions.push(eq(doctorSchedules.doctorId, filters.doctorId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(doctorSchedules.branchId, filters.branchId));
    }
    if (dayOfWeek !== undefined) {
      conditions.push(eq(doctorSchedules.dayOfWeek, dayOfWeek));
    }
    if (filters.isActive !== undefined) {
      conditions.push(eq(doctorSchedules.isActive, filters.isActive));
    }
    if (effectiveOn !== undefined) {
      conditions.push(lte(doctorSchedules.effectiveFrom, effectiveOn));
      conditions.push(
        or(
          isNull(doctorSchedules.effectiveUntil),
          gte(doctorSchedules.effectiveUntil, effectiveOn),
        )!,
      );
    }

    const where = and(...conditions);
    type SortColumn =
      | typeof doctorSchedules.dayOfWeek
      | typeof doctorSchedules.startTime
      | typeof doctorSchedules.createdAt
      | typeof doctorSchedules.updatedAt;
    const sortColumns: Record<DoctorScheduleSortField, SortColumn> = {
      dayOfWeek: doctorSchedules.dayOfWeek,
      startTime: doctorSchedules.startTime,
      createdAt: doctorSchedules.createdAt,
      updatedAt: doctorSchedules.updatedAt,
    };
    const sortColumn = sortColumns[filters.sortBy ?? "dayOfWeek"];
    const direction = filters.sortOrder ?? "asc";

    const [rows, totals] = await Promise.all([
      tx
        .select(scheduleSelection)
        .from(doctorSchedules)
        .innerJoin(
          doctors,
          and(
            eq(doctors.id, doctorSchedules.doctorId),
            eq(doctors.tenantId, doctorSchedules.tenantId),
          ),
        )
        .innerJoin(users, eq(users.id, doctors.userId))
        .innerJoin(
          branches,
          and(
            eq(branches.id, doctorSchedules.branchId),
            eq(branches.tenantId, doctorSchedules.tenantId),
          ),
        )
        .where(where)
        .orderBy(
          direction === "desc" ? desc(sortColumn) : asc(sortColumn),
          asc(doctorSchedules.startTime),
          asc(doctorSchedules.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(doctorSchedules)
        .innerJoin(
          doctors,
          and(
            eq(doctors.id, doctorSchedules.doctorId),
            eq(doctors.tenantId, doctorSchedules.tenantId),
          ),
        )
        .innerJoin(users, eq(users.id, doctors.userId))
        .innerJoin(
          branches,
          and(
            eq(branches.id, doctorSchedules.branchId),
            eq(branches.tenantId, doctorSchedules.tenantId),
          ),
        )
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      schedules: rows.map(toDto),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function getDoctorScheduleById(
  tenantId: string,
  scheduleId: string,
): Promise<DoctorScheduleDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    toDto(await findScheduleRow(tx, tenantId, scheduleId)),
  );
}

export async function updateDoctorSchedule(
  tenantId: string,
  scheduleId: string,
  input: UpdateDoctorScheduleInput,
): Promise<DoctorScheduleDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findScheduleRow(tx, tenantId, scheduleId);

      const branchId = input.branchId ?? current.branchId;
      const { timezone } = await assertDoctorBranchUsable(
        tx,
        tenantId,
        current.doctorId,
        branchId,
      );

      const dayOfWeek =
        input.dayOfWeek === undefined
          ? current.dayOfWeek
          : normalizeDayOfWeek(input.dayOfWeek);
      const startTime =
        input.startTime === undefined
          ? current.startTime
          : normalizeTime(input.startTime, "Start time");
      const endTime =
        input.endTime === undefined
          ? current.endTime
          : normalizeTime(input.endTime, "End time");
      const slotDurationMinutes =
        input.slotDurationMinutes === undefined
          ? current.slotDurationMinutes
          : normalizeSlotDuration(input.slotDurationMinutes);
      const bufferMinutes =
        input.bufferMinutes === undefined
          ? current.bufferMinutes
          : normalizeBuffer(input.bufferMinutes);
      const effectiveFrom =
        input.effectiveFrom === undefined
          ? current.effectiveFrom
          : normalizeDate(input.effectiveFrom, "Effective from date");
      const effectiveUntil =
        input.effectiveUntil === undefined
          ? current.effectiveUntil
          : input.effectiveUntil === null
            ? null
            : normalizeDate(input.effectiveUntil, "Effective until date");

      // Validate the timezone even when the branch did not change; the branch
      // settings may have been edited since this window was created.
      assertValidBranchTimeZone(timezone);
      assertTimeWindow(startTime, endTime, slotDurationMinutes);
      assertEffectiveRange(effectiveFrom, effectiveUntil);
      await assertBreaksFitWindow(tx, tenantId, scheduleId, startTime, endTime);

      if (current.isActive) {
        await assertNoOverlap(
          tx,
          tenantId,
          {
            doctorId: current.doctorId,
            branchId,
            dayOfWeek,
            startTime,
            endTime,
            effectiveFrom,
            effectiveUntil,
          },
          scheduleId,
        );
      }

      await tx
        .update(doctorSchedules)
        .set({
          branchId,
          dayOfWeek,
          startTime,
          endTime,
          slotDurationMinutes,
          bufferMinutes,
          effectiveFrom,
          effectiveUntil,
        })
        .where(
          and(
            eq(doctorSchedules.id, scheduleId),
            eq(doctorSchedules.tenantId, tenantId),
          ),
        );

      return toDto(await findScheduleRow(tx, tenantId, scheduleId));
    });
  } catch (error) {
    mapScheduleWriteError(error);
  }
}

/**
 * Activates or deactivates a window. Deactivation keeps the row as history and
 * frees the slot for a replacement. Reactivation re-runs the overlap check, so
 * it fails with 409 when a newer active window now occupies the same period.
 */
export async function updateDoctorScheduleStatus(
  tenantId: string,
  scheduleId: string,
  isActive: boolean,
): Promise<DoctorScheduleDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findScheduleRow(tx, tenantId, scheduleId);

      if (isActive && !current.isActive) {
        await assertNoOverlap(
          tx,
          tenantId,
          {
            doctorId: current.doctorId,
            branchId: current.branchId,
            dayOfWeek: current.dayOfWeek,
            startTime: current.startTime,
            endTime: current.endTime,
            effectiveFrom: current.effectiveFrom,
            effectiveUntil: current.effectiveUntil,
          },
          scheduleId,
        );
      }

      if (current.isActive !== isActive) {
        await tx
          .update(doctorSchedules)
          .set({ isActive })
          .where(
            and(
              eq(doctorSchedules.id, scheduleId),
              eq(doctorSchedules.tenantId, tenantId),
            ),
          );
      }

      return toDto(await findScheduleRow(tx, tenantId, scheduleId));
    });
  } catch (error) {
    mapScheduleWriteError(error);
  }
}

/**
 * Hard deletes one recurring window. Breaks cascade. No soft-delete column
 * exists; deactivation is the history-preserving alternative.
 */
export async function deleteDoctorSchedule(
  tenantId: string,
  scheduleId: string,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await findScheduleRow(tx, tenantId, scheduleId);

    await tx
      .delete(doctorSchedules)
      .where(
        and(eq(doctorSchedules.id, scheduleId), eq(doctorSchedules.tenantId, tenantId)),
      );
  });
}
