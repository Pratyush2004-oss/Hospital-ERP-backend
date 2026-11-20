import { and, asc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  branches,
  doctorBreaks,
  doctorSchedules,
  doctors,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import type {
  CreateDoctorBreakInput,
  DoctorBreakDto,
  DoctorBreakListFilters,
  DoctorBreakListResult,
  UpdateDoctorBreakInput,
} from "./break.types.js";

/**
 * Doctor break service (Task 16.3).
 *
 * Breaks are recurring pauses inside one schedule row and inherit its branch,
 * doctor and weekday. The database already enforces the cross-row rules:
 * migration 0010 installs a containment trigger and a GiST exclusion constraint
 * over the half-open time range. This service adds friendly validation, active
 * schedule checks and tenant scoping, and maps constraint violations to
 * operational errors instead of leaking SQL.
 *
 * No appointment or availability table references a break, so deletion has no
 * historical dependants today. If that changes, retention must move to
 * deactivation or an archival policy before break rows are removed.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 255;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

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

function mapBreakWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23P01" && constraint === "doctor_breaks_no_overlap") {
    // The pre-check lost a race; the exclusion constraint is authoritative.
    throw AppError.conflict("This break overlaps an existing break in the same schedule");
  }

  if (code === "23514") {
    if (constraint === "doctor_breaks_time_order_check") {
      throw AppError.validation("Break end time must be later than its start time");
    }

    // The containment trigger raises 23514 without a named constraint.
    throw AppError.unprocessable("Break must fall entirely within its schedule window");
  }

  if (code === "23503") {
    throw AppError.notFound("Schedule not found");
  }

  if (code === "22007" || code === "22008") {
    throw AppError.validation("Invalid time value in break data");
  }

  throw error;
}

/** Accepts `HH:MM` or `HH:MM:SS` and always stores seconds. */
function normalizeTime(value: string, field: string): string {
  const match = TIME_PATTERN.exec(value.trim());

  if (!match) {
    throw AppError.validation(`${field} must be a 24-hour time such as "10:00" or "10:00:00"`);
  }

  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const reason = value.trim();

  if (reason.length === 0) return null;

  if (reason.length > MAX_REASON_LENGTH) {
    throw AppError.validation(
      `Break reason must be at most ${MAX_REASON_LENGTH} characters`,
    );
  }

  return reason;
}

function assertInterval(
  startTime: string,
  endTime: string,
  windowStart: string,
  windowEnd: string,
): void {
  if (endTime <= startTime) {
    throw AppError.validation("Break end time must be later than its start time");
  }

  if (startTime < windowStart || endTime > windowEnd) {
    throw AppError.unprocessable(
      `Break must fall entirely within its schedule window ${windowStart.slice(0, 5)}-${windowEnd.slice(0, 5)}`,
      { scheduleStartTime: windowStart, scheduleEndTime: windowEnd },
    );
  }
}

const breakSelection = {
  id: doctorBreaks.id,
  scheduleId: doctorBreaks.scheduleId,
  startTime: doctorBreaks.startTime,
  endTime: doctorBreaks.endTime,
  reason: doctorBreaks.reason,
  createdAt: doctorBreaks.createdAt,
  updatedAt: doctorBreaks.updatedAt,
  scheduleStartTime: doctorSchedules.startTime,
  scheduleEndTime: doctorSchedules.endTime,
  scheduleIsActive: doctorSchedules.isActive,
  scheduleDayOfWeek: doctorSchedules.dayOfWeek,
  scheduleSlotDurationMinutes: doctorSchedules.slotDurationMinutes,
  scheduleBufferMinutes: doctorSchedules.bufferMinutes,
  doctorId: doctorSchedules.doctorId,
  branchId: doctorSchedules.branchId,
  doctorCode: doctors.doctorCode,
  doctorFullName: users.fullName,
  branchName: branches.name,
  branchCode: branches.branchCode,
  branchTimezone: branches.timezone,
};

type BreakRow = {
  id: string;
  scheduleId: string;
  startTime: string;
  endTime: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  scheduleStartTime: string;
  scheduleEndTime: string;
  scheduleIsActive: boolean;
  scheduleDayOfWeek: number;
  scheduleSlotDurationMinutes: number;
  scheduleBufferMinutes: number;
  doctorId: string;
  branchId: string;
  doctorCode: string;
  doctorFullName: string;
  branchName: string;
  branchCode: string;
  branchTimezone: string;
};

function toDto(row: BreakRow): DoctorBreakDto {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    startTime: row.startTime,
    endTime: row.endTime,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schedule: {
      id: row.scheduleId,
      doctorId: row.doctorId,
      branchId: row.branchId,
      dayOfWeek: row.scheduleDayOfWeek,
      startTime: row.scheduleStartTime,
      endTime: row.scheduleEndTime,
      slotDurationMinutes: row.scheduleSlotDurationMinutes,
      bufferMinutes: row.scheduleBufferMinutes,
      isActive: row.scheduleIsActive,
      doctorCode: row.doctorCode,
      doctorFullName: row.doctorFullName,
      branchName: row.branchName,
      branchCode: row.branchCode,
      timezone: row.branchTimezone,
    },
  };
}

function breakQuery(tx: DbExecutor) {
  return tx
    .select(breakSelection)
    .from(doctorBreaks)
    .innerJoin(
      doctorSchedules,
      and(
        eq(doctorSchedules.id, doctorBreaks.scheduleId),
        eq(doctorSchedules.tenantId, doctorBreaks.tenantId),
      ),
    )
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
    );
}

async function findBreakRow(
  tx: DbExecutor,
  tenantId: string,
  breakId: string,
): Promise<BreakRow> {
  const [row] = await breakQuery(tx)
    .where(and(eq(doctorBreaks.tenantId, tenantId), eq(doctorBreaks.id, breakId)))
    .limit(1);

  if (!row) throw AppError.notFound("Break not found");

  return row;
}

async function loadScheduleForBreak(
  tx: DbExecutor,
  tenantId: string,
  scheduleId: string,
): Promise<{ id: string; startTime: string; endTime: string; isActive: boolean }> {
  const [row] = await tx
    .select({
      id: doctorSchedules.id,
      startTime: doctorSchedules.startTime,
      endTime: doctorSchedules.endTime,
      isActive: doctorSchedules.isActive,
    })
    .from(doctorSchedules)
    .where(
      and(eq(doctorSchedules.id, scheduleId), eq(doctorSchedules.tenantId, tenantId)),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Schedule not found");

  return row;
}

/** One break overlapping the candidate inside the same schedule. */
async function findOverlappingBreak(
  tx: DbExecutor,
  tenantId: string,
  scheduleId: string,
  startTime: string,
  endTime: string,
  excludeBreakId?: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: doctorBreaks.id })
    .from(doctorBreaks)
    .where(
      and(
        eq(doctorBreaks.tenantId, tenantId),
        eq(doctorBreaks.scheduleId, scheduleId),
        excludeBreakId === undefined ? undefined : ne(doctorBreaks.id, excludeBreakId),
        lt(doctorBreaks.startTime, endTime),
        gt(doctorBreaks.endTime, startTime),
      ),
    )
    .limit(1);

  return row;
}

async function assertNoBreakOverlap(
  tx: DbExecutor,
  tenantId: string,
  scheduleId: string,
  startTime: string,
  endTime: string,
  excludeBreakId?: string,
): Promise<void> {
  const existing = await findOverlappingBreak(
    tx,
    tenantId,
    scheduleId,
    startTime,
    endTime,
    excludeBreakId,
  );

  if (existing) {
    throw AppError.conflict("This break overlaps an existing break in the same schedule", {
      breakId: existing.id,
    });
  }
}

export async function createDoctorBreak(
  tenantId: string,
  input: CreateDoctorBreakInput,
): Promise<DoctorBreakDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const schedule = await loadScheduleForBreak(tx, tenantId, input.scheduleId);

      if (!schedule.isActive) {
        throw AppError.badRequest("Breaks cannot be added to an inactive schedule");
      }

      const startTime = normalizeTime(input.startTime, "Break start time");
      const endTime = normalizeTime(input.endTime, "Break end time");
      const reason = normalizeReason(input.reason);

      assertInterval(startTime, endTime, schedule.startTime, schedule.endTime);
      await assertNoBreakOverlap(tx, tenantId, schedule.id, startTime, endTime);

      const [created] = await tx
        .insert(doctorBreaks)
        .values({
          tenantId,
          scheduleId: schedule.id,
          startTime,
          endTime,
          reason,
        })
        .returning({ id: doctorBreaks.id });

      if (!created) throw AppError.internal("Failed to create break");

      return toDto(await findBreakRow(tx, tenantId, created.id));
    });
  } catch (error) {
    mapBreakWriteError(error);
  }
}

export async function listDoctorBreaks(
  tenantId: string,
  filters: DoctorBreakListFilters = {},
): Promise<DoctorBreakListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(doctorBreaks.tenantId, tenantId)];

    if (filters.scheduleId !== undefined) {
      conditions.push(eq(doctorBreaks.scheduleId, filters.scheduleId));
    }
    if (filters.doctorId !== undefined) {
      conditions.push(eq(doctorSchedules.doctorId, filters.doctorId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(doctorSchedules.branchId, filters.branchId));
    }

    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      breakQuery(tx)
        .where(where)
        .orderBy(asc(doctorBreaks.startTime), asc(doctorBreaks.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(doctorBreaks)
        .innerJoin(
          doctorSchedules,
          and(
            eq(doctorSchedules.id, doctorBreaks.scheduleId),
            eq(doctorSchedules.tenantId, doctorBreaks.tenantId),
          ),
        )
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      breaks: rows.map(toDto),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function getDoctorBreakById(
  tenantId: string,
  breakId: string,
): Promise<DoctorBreakDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    toDto(await findBreakRow(tx, tenantId, breakId)),
  );
}

export async function updateDoctorBreak(
  tenantId: string,
  breakId: string,
  input: UpdateDoctorBreakInput,
): Promise<DoctorBreakDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findBreakRow(tx, tenantId, breakId);

      const startTime =
        input.startTime === undefined
          ? current.startTime
          : normalizeTime(input.startTime, "Break start time");
      const endTime =
        input.endTime === undefined
          ? current.endTime
          : normalizeTime(input.endTime, "Break end time");
      const reason =
        input.reason === undefined ? current.reason : normalizeReason(input.reason);

      // Validate the complete resulting interval, not just the patched fields.
      assertInterval(
        startTime,
        endTime,
        current.scheduleStartTime,
        current.scheduleEndTime,
      );
      await assertNoBreakOverlap(
        tx,
        tenantId,
        current.scheduleId,
        startTime,
        endTime,
        breakId,
      );

      await tx
        .update(doctorBreaks)
        .set({ startTime, endTime, reason })
        .where(and(eq(doctorBreaks.id, breakId), eq(doctorBreaks.tenantId, tenantId)));

      return toDto(await findBreakRow(tx, tenantId, breakId));
    });
  } catch (error) {
    mapBreakWriteError(error);
  }
}

/**
 * Deletes a break. Nothing references breaks yet (no appointment or availability
 * tables), so hard deletion is safe. Idempotent: deleting an already-removed
 * break succeeds without error and without revealing other tenants' records.
 */
export async function deleteDoctorBreak(
  tenantId: string,
  breakId: string,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: doctorBreaks.id })
      .from(doctorBreaks)
      .where(and(eq(doctorBreaks.id, breakId), eq(doctorBreaks.tenantId, tenantId)))
      .limit(1);

    if (!existing) return;

    await tx
      .delete(doctorBreaks)
      .where(and(eq(doctorBreaks.id, breakId), eq(doctorBreaks.tenantId, tenantId)));
  });
}
