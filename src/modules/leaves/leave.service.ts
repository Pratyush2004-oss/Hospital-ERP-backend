import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  branches,
  doctorBranches,
  doctorLeaves,
  doctors,
  tenantMemberships,
  tenantSettings,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import type {
  CreateDoctorLeaveInput,
  DoctorLeaveActorContext,
  DoctorLeaveBranchSummary,
  DoctorLeaveDoctorSummary,
  DoctorLeaveDto,
  DoctorLeaveListResult,
  DoctorLeaveSortField,
  DoctorLeaveStatus,
  DoctorLeaveUserSummary,
  ListDoctorLeavesFilters,
  UpdateDoctorLeaveInput,
} from "./leave.types.js";

/**
 * Doctor leave service (Task 16.4).
 *
 * Rules:
 * - A leave is an absolute `[start_at, end_at)` interval. Branch-specific rows
 *   point at a `doctor_branches` assignment (composite FK); a NULL branch means
 *   the doctor is unavailable everywhere.
 * - Only PENDING and APPROVED rows participate in conflict detection. Two rows
 *   conflict when the same doctor's intervals overlap AND either row is
 *   all-branch or both name the same branch. Different branches may therefore
 *   be on leave independently.
 * - Concurrent writes for one doctor are serialized with a transaction-scoped
 *   advisory lock before the conflict SELECT, so two requests cannot both pass
 *   the pre-check. There is no exclusion constraint: its simple predicate cannot
 *   express "all-branch conflicts with everything".
 * - `created_by`, `approved_by` and `rejected_by` come from the verified actor;
 *   the service never reads approval fields from input.
 * - Rejections are recorded in the dedicated rejection columns added by
 *   migration 0011; the doctor's original reason is never overwritten.
 * - No audit table, appointment table or notification module exists yet. Leave
 *   history is preserved by status transitions (nothing is deleted), and
 *   appointment-overlap reporting is deferred to the appointment module.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 1000;
const MAX_REJECTION_REASON_LENGTH = 1000;
const SELF_APPROVAL_SETTING_KEY = "doctor_leave.allow_self_approval";
// Management of *another* doctor's leave is signalled by the review keys or
// the doctor-profile update key. The per-action keys (create/update/cancel) are
// also held by the doctor role for its own requests, so they cannot be used to
// distinguish self-service from management.
const MANAGE_PERMISSIONS = [
  "doctor.leave.approve",
  "doctor.leave.reject",
  "doctor:update",
] as const;
const APPROVE_PERMISSION = "doctor.leave.approve";
const REJECT_PERMISSION = "doctor.leave.reject";
const CANCEL_PERMISSION = "doctor.leave.cancel";
const CONFLICTING_STATUSES: readonly DoctorLeaveStatus[] = ["PENDING", "APPROVED"];
const LEAVE_STATUSES: readonly DoctorLeaveStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
];

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
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

function mapLeaveWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23514") {
    if (constraint === "doctor_leaves_rejection_check") {
      throw AppError.validation("A rejected leave request must record who rejected it and when");
    }

    if (constraint === "doctor_leaves_approval_check") {
      throw AppError.validation("An approved leave request must record who approved it and when");
    }

    throw AppError.validation("Leave data violates a database constraint");
  }

  if (code === "23503") {
    throw AppError.badRequest(
      "The doctor or branch is no longer available for this leave request",
    );
  }

  if (code === "22P02" || code === "22007" || code === "22008") {
    throw AppError.validation("Invalid date, time or identifier value in leave data");
  }

  throw error;
}

/** Accepts `HH:MM`/`HH:MM:SS`-style ISO instants only when an offset is present. */
function normalizeInstant(value: string | Date, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw AppError.validation(`${field} must be a valid timestamp`);
    }

    return new Date(value.getTime());
  }

  const text = value.trim();

  if (!INSTANT_PATTERN.test(text)) {
    throw AppError.validation(
      `${field} must be an ISO 8601 timestamp with an explicit timezone offset, e.g. "2026-02-02T09:00:00Z"`,
    );
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation(`${field} must be a valid timestamp`);
  }

  return parsed;
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

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const reason = value.trim();

  if (reason.length === 0) return null;

  if (reason.length > MAX_REASON_LENGTH) {
    throw AppError.validation(`Leave reason must be at most ${MAX_REASON_LENGTH} characters`);
  }

  return reason;
}

function normalizeRejectionReason(value: string): string {
  const reason = value.trim();

  if (reason.length === 0) {
    throw AppError.validation("A rejection reason is required");
  }

  if (reason.length > MAX_REJECTION_REASON_LENGTH) {
    throw AppError.validation(
      `Rejection reason must be at most ${MAX_REJECTION_REASON_LENGTH} characters`,
    );
  }

  return reason;
}

function assertInterval(startAt: Date, endAt: Date): void {
  if (startAt.getTime() >= endAt.getTime()) {
    throw AppError.validation("Leave end must be later than its start");
  }
}

function hasPermission(actor: DoctorLeaveActorContext, permission: string): boolean {
  return actor.permissions?.has(permission) ?? false;
}

function hasAnyManagePermission(actor: DoctorLeaveActorContext): boolean {
  return MANAGE_PERMISSIONS.some((permission) => hasPermission(actor, permission));
}

/**
 * Seeded branch administrators may manage branch-specific leave only. A custom
 * role that was explicitly granted the leave decision keys without the
 * branch_admin role counts as authorized for all-branch leave.
 */
function isBranchAdminOnly(actor: DoctorLeaveActorContext): boolean {
  const roles = actor.roles ?? [];
  return roles.includes("branch_admin") && !roles.includes("hospital_admin");
}

async function assertActiveMembership(
  tx: DbExecutor,
  tenantId: string,
  actor: DoctorLeaveActorContext,
): Promise<void> {
  const [membership] = await tx
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, actor.userId),
        eq(tenantMemberships.status, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw AppError.forbidden("You are not an active member of this hospital");
  }
}

async function isSelfApprovalAllowed(tx: DbExecutor, tenantId: string): Promise<boolean> {
  const [setting] = await tx
    .select({ value: tenantSettings.settingValue })
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, tenantId),
        eq(tenantSettings.settingKey, SELF_APPROVAL_SETTING_KEY),
      ),
    )
    .limit(1);

  return setting?.value === true;
}

interface DoctorRow {
  readonly id: string;
  readonly userId: string;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}

async function loadDoctor(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
): Promise<DoctorRow> {
  const [doctor] = await tx
    .select({
      id: doctors.id,
      userId: doctors.userId,
      isActive: doctors.isActive,
      deletedAt: doctors.deletedAt,
    })
    .from(doctors)
    .where(and(eq(doctors.id, doctorId), eq(doctors.tenantId, tenantId)))
    .limit(1);

  if (!doctor || doctor.deletedAt !== null) {
    throw AppError.notFound("Doctor not found");
  }

  if (!doctor.isActive) {
    throw AppError.badRequest("Leave cannot be requested for an inactive doctor");
  }

  return doctor;
}

/** Validates that the branch exists and that the doctor is actively assigned. */
async function assertDoctorBranchUsable(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  branchId: string,
): Promise<void> {
  const [branch] = await tx
    .select({
      id: branches.id,
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
    throw AppError.badRequest("Leave cannot be requested at an inactive branch");
  }

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
}

const createdByUser = alias(users, "leave_creator");
const approvedByUser = alias(users, "leave_approver");
const rejectedByUser = alias(users, "leave_rejecter");

const leaveSelection = {
  id: doctorLeaves.id,
  doctorId: doctorLeaves.doctorId,
  branchId: doctorLeaves.branchId,
  startAt: doctorLeaves.startAt,
  endAt: doctorLeaves.endAt,
  reason: doctorLeaves.reason,
  status: doctorLeaves.status,
  createdBy: doctorLeaves.createdBy,
  approvedBy: doctorLeaves.approvedBy,
  approvedAt: doctorLeaves.approvedAt,
  rejectedBy: doctorLeaves.rejectedBy,
  rejectedAt: doctorLeaves.rejectedAt,
  rejectionReason: doctorLeaves.rejectionReason,
  createdAt: doctorLeaves.createdAt,
  updatedAt: doctorLeaves.updatedAt,
  doctorCode: doctors.doctorCode,
  doctorFullName: users.fullName,
  doctorIsActive: doctors.isActive,
  branchName: branches.name,
  branchCode: branches.branchCode,
  branchTimezone: branches.timezone,
  creatorFullName: createdByUser.fullName,
  approverFullName: approvedByUser.fullName,
  rejecterFullName: rejectedByUser.fullName,
};

type LeaveRow = {
  id: string;
  doctorId: string;
  branchId: string | null;
  startAt: Date;
  endAt: Date;
  reason: string | null;
  status: DoctorLeaveStatus;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  doctorCode: string;
  doctorFullName: string;
  doctorIsActive: boolean;
  branchName: string | null;
  branchCode: string | null;
  branchTimezone: string | null;
  creatorFullName: string;
  approverFullName: string | null;
  rejecterFullName: string | null;
};

function toUserSummary(id: string | null, fullName: string | null): DoctorLeaveUserSummary | null {
  return id === null ? null : { id, fullName: fullName ?? "" };
}

function toDto(row: LeaveRow): DoctorLeaveDto {
  const doctor: DoctorLeaveDoctorSummary = {
    id: row.doctorId,
    doctorCode: row.doctorCode,
    fullName: row.doctorFullName,
    isActive: row.doctorIsActive,
  };
  const branch: DoctorLeaveBranchSummary | null =
    row.branchId === null
      ? null
      : {
          id: row.branchId,
          name: row.branchName ?? "",
          branchCode: row.branchCode ?? "",
          timezone: row.branchTimezone ?? "UTC",
        };

  return {
    id: row.id,
    doctorId: row.doctorId,
    branchId: row.branchId,
    isAllBranches: row.branchId === null,
    startAt: row.startAt,
    endAt: row.endAt,
    reason: row.reason,
    status: row.status,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    doctor,
    branch,
    requestedBy: { id: row.createdBy, fullName: row.creatorFullName },
    approvedByUser: toUserSummary(row.approvedBy, row.approverFullName),
    rejectedByUser: toUserSummary(row.rejectedBy, row.rejecterFullName),
  };
}

function leaveQuery(tx: DbExecutor) {
  return tx
    .select(leaveSelection)
    .from(doctorLeaves)
    .innerJoin(
      doctors,
      and(eq(doctors.id, doctorLeaves.doctorId), eq(doctors.tenantId, doctorLeaves.tenantId)),
    )
    .innerJoin(users, eq(users.id, doctors.userId))
    .leftJoin(
      branches,
      and(eq(branches.id, doctorLeaves.branchId), eq(branches.tenantId, doctorLeaves.tenantId)),
    )
    .innerJoin(createdByUser, eq(createdByUser.id, doctorLeaves.createdBy))
    .leftJoin(approvedByUser, eq(approvedByUser.id, doctorLeaves.approvedBy))
    .leftJoin(rejectedByUser, eq(rejectedByUser.id, doctorLeaves.rejectedBy));
}

async function findLeaveRow(
  tx: DbExecutor,
  tenantId: string,
  leaveId: string,
): Promise<LeaveRow> {
  const [row] = await leaveQuery(tx)
    .where(and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)))
    .limit(1);

  if (!row) throw AppError.notFound("Leave request not found");

  return row;
}

interface LockedLeaveRow {
  readonly id: string;
  readonly doctorId: string;
  readonly doctorUserId: string;
  readonly branchId: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly status: DoctorLeaveStatus;
}

/** Row-level lock so two approvals/cancellations cannot both win. */
async function lockLeaveRow(
  tx: DbExecutor,
  tenantId: string,
  leaveId: string,
): Promise<LockedLeaveRow> {
  const [row] = await tx
    .select({
      id: doctorLeaves.id,
      doctorId: doctorLeaves.doctorId,
      doctorUserId: doctors.userId,
      branchId: doctorLeaves.branchId,
      startAt: doctorLeaves.startAt,
      endAt: doctorLeaves.endAt,
      status: doctorLeaves.status,
    })
    .from(doctorLeaves)
    .innerJoin(
      doctors,
      and(eq(doctors.id, doctorLeaves.doctorId), eq(doctors.tenantId, doctorLeaves.tenantId)),
    )
    .where(and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)))
    .limit(1)
    .for("update", { of: doctorLeaves });

  if (!row) throw AppError.notFound("Leave request not found");

  return row;
}

interface ConflictCandidate {
  readonly doctorId: string;
  readonly branchId: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
}

/**
 * Half-open overlap against PENDING/APPROVED leave:
 *   existing.start < candidate.end AND existing.end > candidate.start
 * An all-branch row conflicts with every branch; a branch-specific row only
 * conflicts with the same branch (or an all-branch row) for the same doctor.
 */
async function findConflictingLeave(
  tx: DbExecutor,
  tenantId: string,
  candidate: ConflictCandidate,
  excludeLeaveId?: string,
): Promise<{ id: string; branchId: string | null; startAt: Date; endAt: Date } | undefined> {
  const [row] = await tx
    .select({
      id: doctorLeaves.id,
      branchId: doctorLeaves.branchId,
      startAt: doctorLeaves.startAt,
      endAt: doctorLeaves.endAt,
    })
    .from(doctorLeaves)
    .where(
      and(
        eq(doctorLeaves.tenantId, tenantId),
        eq(doctorLeaves.doctorId, candidate.doctorId),
        inArray(doctorLeaves.status, [...CONFLICTING_STATUSES]),
        excludeLeaveId === undefined ? undefined : ne(doctorLeaves.id, excludeLeaveId),
        lt(doctorLeaves.startAt, candidate.endAt),
        gt(doctorLeaves.endAt, candidate.startAt),
        candidate.branchId === null
          ? undefined
          : or(
              isNull(doctorLeaves.branchId),
              eq(doctorLeaves.branchId, candidate.branchId),
            ),
      ),
    )
    .limit(1);

  return row;
}

/** Serializes leave writes for one doctor inside the current transaction. */
async function lockDoctorLeaveWrites(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`leave:${tenantId}`}), hashtext(${doctorId}))`,
  );
}

async function assertNoConflict(
  tx: DbExecutor,
  tenantId: string,
  candidate: ConflictCandidate,
  excludeLeaveId?: string,
): Promise<void> {
  const existing = await findConflictingLeave(tx, tenantId, candidate, excludeLeaveId);

  if (existing) {
    throw AppError.conflict(
      "The doctor already has overlapping pending or approved leave for this period",
      {
        leaveId: existing.id,
        branchId: existing.branchId,
        isAllBranches: existing.branchId === null,
        startAt: existing.startAt,
        endAt: existing.endAt,
      },
    );
  }
}

function assertCanManageDoctor(actor: DoctorLeaveActorContext, doctorUserId: string): void {
  if (actor.userId === doctorUserId) return;

  if (!hasAnyManagePermission(actor)) {
    throw AppError.forbidden("You do not have permission to manage leave for this doctor");
  }
}

function assertCanDecide(
  actor: DoctorLeaveActorContext,
  branchId: string | null,
  decisionPermission: string,
): void {
  if (!hasPermission(actor, decisionPermission)) {
    throw AppError.forbidden("You do not have permission to review doctor leave");
  }

  if (branchId === null && isBranchAdminOnly(actor)) {
    throw AppError.forbidden(
      "Branch administrators cannot review all-branch leave without explicit authorization",
    );
  }
}

export async function createDoctorLeave(
  tenantId: string,
  input: CreateDoctorLeaveInput,
  actorContext: DoctorLeaveActorContext,
): Promise<DoctorLeaveDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const doctor = await loadDoctor(tx, tenantId, input.doctorId);
      assertCanManageDoctor(actorContext, doctor.userId);

      const branchId = input.branchId ?? null;

      if (branchId !== null) {
        await assertDoctorBranchUsable(tx, tenantId, doctor.id, branchId);
      }

      const startAt = normalizeInstant(input.startAt, "Leave start");
      const endAt = normalizeInstant(input.endAt, "Leave end");
      const reason = normalizeReason(input.reason);

      assertInterval(startAt, endAt);

      await lockDoctorLeaveWrites(tx, tenantId, doctor.id);
      await assertNoConflict(tx, tenantId, {
        doctorId: doctor.id,
        branchId,
        startAt,
        endAt,
      });

      // Approval fields are never taken from input: a new request always starts
      // PENDING and records the verified actor as its author.
      const [created] = await tx
        .insert(doctorLeaves)
        .values({
          tenantId,
          doctorId: doctor.id,
          branchId,
          startAt,
          endAt,
          reason,
          status: "PENDING",
          createdBy: actorContext.userId,
        })
        .returning({ id: doctorLeaves.id });

      if (!created) throw AppError.internal("Failed to create leave request");

      return toDto(await findLeaveRow(tx, tenantId, created.id));
    });
  } catch (error) {
    mapLeaveWriteError(error);
  }
}

export async function listDoctorLeaves(
  tenantId: string,
  filters: ListDoctorLeavesFilters = {},
): Promise<DoctorLeaveListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  if (filters.status !== undefined && !LEAVE_STATUSES.includes(filters.status)) {
    throw AppError.validation("Unknown leave status");
  }

  if (filters.branchId !== undefined && filters.allBranches === true) {
    throw AppError.badRequest("branchId and allBranches cannot be combined");
  }

  const startDate =
    filters.startDate === undefined
      ? undefined
      : new Date(`${normalizeDate(filters.startDate, "Start date")}T00:00:00.000Z`);
  const endDate =
    filters.endDate === undefined
      ? undefined
      : new Date(`${normalizeDate(filters.endDate, "End date")}T00:00:00.000Z`);
  const endDateExclusive =
    endDate === undefined
      ? undefined
      : new Date(
          Date.UTC(
            endDate.getUTCFullYear(),
            endDate.getUTCMonth(),
            endDate.getUTCDate() + 1,
          ),
        );

  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    throw AppError.validation("Start date cannot be later than end date");
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(doctorLeaves.tenantId, tenantId)];

    if (filters.doctorId !== undefined) {
      conditions.push(eq(doctorLeaves.doctorId, filters.doctorId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(doctorLeaves.branchId, filters.branchId));
    }
    if (filters.allBranches === true) {
      conditions.push(isNull(doctorLeaves.branchId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(doctorLeaves.status, filters.status));
    }
    if (startDate !== undefined) {
      conditions.push(gt(doctorLeaves.endAt, startDate));
    }
    if (endDateExclusive !== undefined) {
      conditions.push(lt(doctorLeaves.startAt, endDateExclusive));
    }

    const where = and(...conditions);
    type SortColumn =
      | typeof doctorLeaves.startAt
      | typeof doctorLeaves.endAt
      | typeof doctorLeaves.createdAt
      | typeof doctorLeaves.status;
    const sortColumns: Record<DoctorLeaveSortField, SortColumn> = {
      startAt: doctorLeaves.startAt,
      endAt: doctorLeaves.endAt,
      createdAt: doctorLeaves.createdAt,
      status: doctorLeaves.status,
    };
    const sortColumn = sortColumns[filters.sortBy ?? "startAt"];
    const direction = filters.sortOrder ?? "asc";

    const [rows, totals] = await Promise.all([
      leaveQuery(tx)
        .where(where)
        .orderBy(
          direction === "desc" ? desc(sortColumn) : asc(sortColumn),
          asc(doctorLeaves.startAt),
          asc(doctorLeaves.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(doctorLeaves)
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      leaves: rows.map(toDto),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function getDoctorLeaveById(
  tenantId: string,
  leaveId: string,
): Promise<DoctorLeaveDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    toDto(await findLeaveRow(tx, tenantId, leaveId)),
  );
}

export async function approveDoctorLeave(
  tenantId: string,
  leaveId: string,
  actorContext: DoctorLeaveActorContext,
): Promise<DoctorLeaveDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const current = await lockLeaveRow(tx, tenantId, leaveId);

      if (current.status !== "PENDING") {
        throw AppError.conflict(
          `Only pending leave requests can be approved; this request is ${current.status}`,
        );
      }

      assertCanDecide(actorContext, current.branchId, APPROVE_PERMISSION);

      if (
        actorContext.userId === current.doctorUserId &&
        !(await isSelfApprovalAllowed(tx, tenantId))
      ) {
        throw AppError.forbidden(
          "Doctors cannot approve their own leave unless the hospital policy allows it",
        );
      }

      await lockDoctorLeaveWrites(tx, tenantId, current.doctorId);
      await assertNoConflict(
        tx,
        tenantId,
        {
          doctorId: current.doctorId,
          branchId: current.branchId,
          startAt: current.startAt,
          endAt: current.endAt,
        },
        current.id,
      );

      await tx
        .update(doctorLeaves)
        .set({
          status: "APPROVED",
          approvedBy: actorContext.userId,
          approvedAt: new Date(),
        })
        .where(
          and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)),
        );

      return toDto(await findLeaveRow(tx, tenantId, leaveId));
    });
  } catch (error) {
    mapLeaveWriteError(error);
  }
}

export async function rejectDoctorLeave(
  tenantId: string,
  leaveId: string,
  actorContext: DoctorLeaveActorContext,
  rejectionReason: string,
): Promise<DoctorLeaveDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const reason = normalizeRejectionReason(rejectionReason);
      const current = await lockLeaveRow(tx, tenantId, leaveId);

      if (current.status !== "PENDING") {
        throw AppError.conflict(
          `Only pending leave requests can be rejected; this request is ${current.status}`,
        );
      }

      assertCanDecide(actorContext, current.branchId, REJECT_PERMISSION);

      await tx
        .update(doctorLeaves)
        .set({
          status: "REJECTED",
          rejectedBy: actorContext.userId,
          rejectedAt: new Date(),
          rejectionReason: reason,
        })
        .where(
          and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)),
        );

      return toDto(await findLeaveRow(tx, tenantId, leaveId));
    });
  } catch (error) {
    mapLeaveWriteError(error);
  }
}

export async function cancelDoctorLeave(
  tenantId: string,
  leaveId: string,
  actorContext: DoctorLeaveActorContext,
): Promise<DoctorLeaveDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const current = await lockLeaveRow(tx, tenantId, leaveId);

      if (current.status === "REJECTED" || current.status === "CANCELLED") {
        throw AppError.conflict(
          `A ${current.status.toLowerCase()} leave request cannot be cancelled`,
        );
      }

      const isOwner = actorContext.userId === current.doctorUserId;

      if (!isOwner) {
        // Cancelling someone else's leave is a management action: the route
        // grants `doctor.leave.cancel`, but the service additionally requires a
        // management key so a doctor can only cancel their own request.
        if (
          !hasPermission(actorContext, CANCEL_PERMISSION) ||
          !hasAnyManagePermission(actorContext)
        ) {
          throw AppError.forbidden("You do not have permission to cancel this leave request");
        }

        if (current.branchId === null && isBranchAdminOnly(actorContext)) {
          throw AppError.forbidden(
            "Branch administrators cannot cancel all-branch leave without explicit authorization",
          );
        }
      }

      // Cancellation preserves the row and any prior approval metadata.
      await tx
        .update(doctorLeaves)
        .set({ status: "CANCELLED" })
        .where(
          and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)),
        );

      return toDto(await findLeaveRow(tx, tenantId, leaveId));
    });
  } catch (error) {
    mapLeaveWriteError(error);
  }
}

export async function updateDoctorLeave(
  tenantId: string,
  leaveId: string,
  input: UpdateDoctorLeaveInput,
  actorContext: DoctorLeaveActorContext,
): Promise<DoctorLeaveDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const current = await lockLeaveRow(tx, tenantId, leaveId);

      if (current.status !== "PENDING") {
        throw AppError.conflict(
          `Only pending leave requests can be edited; this request is ${current.status}`,
        );
      }

      assertCanManageDoctor(actorContext, current.doctorUserId);

      const doctor = await loadDoctor(tx, tenantId, current.doctorId);

      const branchId =
        input.branchId === undefined ? current.branchId : input.branchId;

      if (branchId !== null) {
        await assertDoctorBranchUsable(tx, tenantId, doctor.id, branchId);
      }

      const startAt =
        input.startAt === undefined
          ? current.startAt
          : normalizeInstant(input.startAt, "Leave start");
      const endAt =
        input.endAt === undefined
          ? current.endAt
          : normalizeInstant(input.endAt, "Leave end");
      const reason =
        input.reason === undefined ? undefined : normalizeReason(input.reason);

      assertInterval(startAt, endAt);

      await lockDoctorLeaveWrites(tx, tenantId, doctor.id);
      await assertNoConflict(
        tx,
        tenantId,
        { doctorId: doctor.id, branchId, startAt, endAt },
        current.id,
      );

      await tx
        .update(doctorLeaves)
        .set({
          branchId,
          startAt,
          endAt,
          ...(reason === undefined ? {} : { reason }),
        })
        .where(
          and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.tenantId, tenantId)),
        );

      return toDto(await findLeaveRow(tx, tenantId, leaveId));
    });
  } catch (error) {
    mapLeaveWriteError(error);
  }
}
