import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../database/context.js";
import {
  appointmentIdempotencyKeys,
  appointments,
  branches,
  departments,
  doctors,
  patientProfiles,
  tenantMemberships,
} from "../../database/schema/index.js";
import type {
  Appointment,
  NewAppointment,
} from "../../database/schema/appointments.js";
import { AppError } from "../../lib/http-error.js";
import type {
  SlotEvaluation,
  SlotUnavailabilityReason,
} from "./appointment-availability.service.js";
import type {
  AppointmentBookingActorContext,
  AppointmentBookingDto,
  AppointmentStatus,
} from "./appointment-booking.types.js";

/**
 * Shared appointment-service primitives (Phase 18.3/18.4).
 *
 * Booking, rescheduling and cancellation share exactly one implementation of:
 * identifier/timestamp normalization, canonical request hashing, idempotency
 * lookup and completion, appointment DTO mapping, caller authorization and
 * PostgreSQL error mapping. Keeping them here prevents the lifecycle services
 * from drifting apart.
 */

/** Command scopes stored in `appointment_idempotency_keys.operation`. */
export const APPOINTMENT_OPERATIONS = {
  create: "appointment.create",
  reschedule: "appointment.reschedule",
  cancel: "appointment.cancel",
} as const;

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** Drizzle wraps driver errors, so walk the `cause` chain for SQLSTATE data. */
export function pgErrorInfo(error: unknown): PgErrorInfo {
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

/**
 * Maps database failures to operational errors. AppErrors pass through and
 * unknown errors are rethrown so they stay 500s.
 */
export function mapAppointmentError(error: unknown): never {
  if (error instanceof AppError) throw error;

  const { code, constraint } = pgErrorInfo(error);

  // Exclusion constraint: the slot was reserved by a concurrent transaction.
  if (code === "23P01" || code === "40001" || code === "40P01") {
    throw new AppError(
      409,
      "SLOT_UNAVAILABLE",
      "The selected slot is no longer available; please choose another slot",
    );
  }

  if (code === "23505") {
    if (constraint === "appointment_idempotency_keys_unique") {
      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "This idempotency key is already in use; retry the request",
      );
    }

    if (constraint === "appointments_rescheduled_from_unique") {
      throw AppError.conflict("This appointment has already been rescheduled");
    }

    throw AppError.conflict("The request conflicts with an existing record");
  }

  if (code === "23503") {
    throw AppError.badRequest(
      "The patient, doctor, branch or department is no longer available for this operation",
    );
  }

  if (code === "23514") {
    throw AppError.validation("Appointment data violates a database constraint");
  }

  if (code === "22P02" || code === "22007" || code === "22008") {
    throw AppError.validation("Invalid identifier or timestamp value in the request");
  }

  throw error;
}

export function assertUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw AppError.validation(`${field} must be a valid UUID`);
  }

  return value.toLowerCase();
}

export function normalizeInstant(value: string | Date, field = "Appointment start"): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw AppError.validation(`${field} must be a valid timestamp`);
    }

    return new Date(value.getTime());
  }

  const text = value.trim();

  if (!INSTANT_PATTERN.test(text)) {
    throw AppError.validation(
      `${field} must be an ISO 8601 timestamp with an explicit offset, e.g. "2026-12-07T09:00:00Z"`,
    );
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation(`${field} must be a valid timestamp`);
  }

  return parsed;
}

export function normalizeNow(value: Date | undefined): Date {
  if (value === undefined) return new Date();

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw AppError.validation("Reference time must be a valid Date");
  }

  return value;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;

  const text = value.trim();

  if (text.length === 0) return null;

  if (text.length > maxLength) {
    throw AppError.validation(`${field} must be at most ${maxLength} characters`);
  }

  return text;
}

export function normalizeRequiredText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const text = normalizeOptionalText(value, field, maxLength);

  if (text === null) {
    throw AppError.validation(`${field} is required`);
  }

  return text;
}

export function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;

  const key = value.trim();

  if (key.length === 0 || key.length > 200) {
    throw AppError.validation("Idempotency key must be between 1 and 200 characters");
  }

  return key;
}

/** SHA-256 hex digest of a canonical (fixed key order) request payload. */
export function hashCanonicalRequest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function idempotencyReuseError(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was already used with a different request",
  );
}

export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly appointmentId: string | null;
  readonly status: string;
}

/**
 * Finds a live idempotency record for `(tenant, operation, key)`.
 *
 * Rows expire `IDEMPOTENCY_TTL_MS` after they are written (the documented 24h
 * policy). An expired row is deleted here and treated as absent, so the key can
 * be reused after its retention window instead of being replayed or rejected by
 * the unique index forever. Deletion is tenant-scoped and runs inside the
 * caller's transaction, so no cleanup job is required for correctness (the
 * expiry index remains useful for a bulk sweep).
 */
export async function findIdempotencyRecord(
  tx: DatabaseTransaction,
  tenantId: string,
  operation: string,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<IdempotencyRecord | undefined> {
  const [row] = await tx
    .select({
      requestHash: appointmentIdempotencyKeys.requestHash,
      appointmentId: appointmentIdempotencyKeys.appointmentId,
      status: appointmentIdempotencyKeys.status,
      expiresAt: appointmentIdempotencyKeys.expiresAt,
    })
    .from(appointmentIdempotencyKeys)
    .where(
      and(
        eq(appointmentIdempotencyKeys.tenantId, tenantId),
        eq(appointmentIdempotencyKeys.operation, operation),
        eq(appointmentIdempotencyKeys.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!row) return undefined;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await tx
      .delete(appointmentIdempotencyKeys)
      .where(
        and(
          eq(appointmentIdempotencyKeys.tenantId, tenantId),
          eq(appointmentIdempotencyKeys.operation, operation),
          eq(appointmentIdempotencyKeys.idempotencyKey, idempotencyKey),
        ),
      );

    return undefined;
  }

  return { requestHash: row.requestHash, appointmentId: row.appointmentId, status: row.status };
}

/**
 * A caller who is a doctor in this tenant may only act on their own
 * appointments. Staff without a doctor profile (reception, nursing, admin) are
 * governed by their RBAC permissions instead. Shared by the booking, reschedule,
 * cancel, lifecycle and read paths so the rule cannot drift.
 */
export async function assertDoctorAppointmentScope(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentDoctorId: string,
  actor: AppointmentBookingActorContext,
  message = "Doctors may only act on appointments assigned to them",
): Promise<void> {
  const [profile] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(and(eq(doctors.tenantId, tenantId), eq(doctors.userId, actor.userId)))
    .limit(1);

  if (profile && profile.id !== appointmentDoctorId) {
    throw AppError.forbidden(message);
  }
}

export async function insertCompletedIdempotencyKey(
  tx: DatabaseTransaction,
  values: {
    readonly tenantId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly appointmentId: string;
    readonly now: Date;
  },
): Promise<void> {
  await tx.insert(appointmentIdempotencyKeys).values({
    tenantId: values.tenantId,
    operation: values.operation,
    idempotencyKey: values.idempotencyKey,
    requestHash: values.requestHash,
    appointmentId: values.appointmentId,
    status: "COMPLETED",
    expiresAt: new Date(values.now.getTime() + IDEMPOTENCY_TTL_MS),
  });
}

/** Safe appointment representation: no patient demographics or private notes. */
export function toAppointmentDto(
  appointment: Appointment,
  branchTimezone: string,
  replayed: boolean,
): AppointmentBookingDto {
  return {
    id: appointment.id,
    appointmentCode: appointment.appointmentCode,
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
    branchId: appointment.branchId,
    departmentId: appointment.departmentId,
    appointmentSource: appointment.appointmentSource,
    appointmentType: appointment.appointmentType,
    appointmentStatus: appointment.appointmentStatus,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    durationMinutes: Math.round(
      (appointment.endAt.getTime() - appointment.startAt.getTime()) / 60_000,
    ),
    consultationFee: appointment.consultationFee,
    currency: appointment.currency,
    branchTimezone,
    reason: appointment.reason,
    rescheduledFromAppointmentId: appointment.rescheduledFromAppointmentId,
    cancelledBy: appointment.cancelledBy,
    cancellationReason: appointment.cancellationReason,
    checkedInAt: appointment.checkedInAt,
    consultationStartedAt: appointment.consultationStartedAt,
    completedAt: appointment.completedAt,
    noShowAt: appointment.noShowAt,
    createdBy: appointment.createdBy,
    createdAt: appointment.createdAt,
    updatedAt: appointment.updatedAt,
    replayed,
  };
}

export async function loadAppointmentDto(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentBookingDto> {
  const [row] = await tx
    .select({ appointment: appointments, branchTimezone: branches.timezone })
    .from(appointments)
    .innerJoin(
      branches,
      and(
        eq(branches.id, appointments.branchId),
        eq(branches.tenantId, appointments.tenantId),
      ),
    )
    .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId)))
    .limit(1);

  if (!row) {
    throw AppError.conflict("The appointment referenced by this request is no longer available");
  }

  return toAppointmentDto(row.appointment, row.branchTimezone, false);
}

export interface LockedAppointment {
  readonly appointment: Appointment;
  readonly patientUserId: string | null;
  readonly patientStatus: string;
  readonly patientDeletedAt: Date | null;
  /** Linked account of the appointment's doctor, for doctor-scoped checks. */
  readonly doctorUserId: string;
}

/**
 * Central appointment state machine (Phase 18.5).
 *
 * The schema documents `CHECKED_IN -> NO_SHOW` as possible; the product rules
 * for this phase deliberately forbid it (a checked-in patient must be started
 * or cancelled instead), so the table below is the single authority the
 * booking, rescheduling, cancellation and lifecycle services consult.
 */
export const APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  PENDING: ["CONFIRMED", "CANCELLED", "RESCHEDULED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  CHECKED_IN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  RESCHEDULED: [],
};

/** Rejects an invalid transition with a safe 409 carrying the allowed targets. */
export function assertAppointmentTransition(
  current: AppointmentStatus,
  next: AppointmentStatus,
  action: string,
): void {
  if (APPOINTMENT_TRANSITIONS[current].includes(next)) return;

  throw new AppError(
    409,
    "INVALID_STATUS_TRANSITION",
    `An appointment with status ${current} cannot ${action}`,
    {
      currentStatus: current,
      targetStatus: next,
      allowedTransitions: APPOINTMENT_TRANSITIONS[current],
    },
  );
}

/**
 * Locks the appointment row for a lifecycle transition and loads the minimum
 * patient state needed to authorize the caller. Missing and cross-tenant rows
 * are both reported as 404, so tenant membership is not leaked.
 */
export async function lockAppointment(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<LockedAppointment> {
  const [row] = await tx
    .select({
      appointment: appointments,
      patientUserId: patientProfiles.userId,
      patientStatus: patientProfiles.status,
      patientDeletedAt: patientProfiles.deletedAt,
      doctorUserId: doctors.userId,
    })
    .from(appointments)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.id, appointments.patientId),
        eq(patientProfiles.tenantId, appointments.tenantId),
      ),
    )
    .innerJoin(
      doctors,
      and(
        eq(doctors.id, appointments.doctorId),
        eq(doctors.tenantId, appointments.tenantId),
      ),
    )
    .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId)))
    .limit(1)
    .for("update", { of: appointments });

  if (!row) throw AppError.notFound("Appointment not found");

  return row;
}

export function assertPatientActive(status: string, deletedAt: Date | null): void {
  if (deletedAt !== null) {
    throw AppError.badRequest("The patient record is no longer available");
  }

  if (status !== "ACTIVE") {
    throw AppError.badRequest(
      `This operation is not available for a patient with status ${status}`,
    );
  }
}

async function assertActiveMembership(
  tx: DatabaseTransaction,
  tenantId: string,
  userId: string,
): Promise<void> {
  const [membership] = await tx
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw AppError.forbidden("You are not an active member of this hospital");
  }
}

const SLOT_REASON_MESSAGES: Record<SlotUnavailabilityReason, string> = {
  NO_SCHEDULE:
    "The doctor has no working schedule at this branch on the requested day",
  OUTSIDE_SCHEDULE: "The requested time is outside the doctor's working hours",
  DURATION_DOES_NOT_FIT:
    "The requested appointment duration does not fit inside the doctor's working window",
  PAST: "Appointments cannot be booked in the past",
  BREAK: "The requested time overlaps a doctor break",
  LEAVE: "The doctor is on approved leave at the requested time",
  OCCUPIED: "The selected slot is no longer available",
};

/** Safe 409 for any unavailable slot, with a machine-readable reason. */
export function slotUnavailableError(
  reason: SlotUnavailabilityReason | null,
  evaluation: SlotEvaluation,
  doctorId: string,
  branchId: string,
): AppError {
  return new AppError(
    409,
    "SLOT_UNAVAILABLE",
    reason === null ? "The selected slot is no longer available" : SLOT_REASON_MESSAGES[reason],
    {
      reason,
      doctorId,
      branchId,
      startAt: evaluation.startAt,
      endAt: evaluation.endAt,
    },
  );
}

const APPOINTMENT_CODE_ATTEMPTS = 3;

/**
 * Operational code: `APT-YYYYMMDD-XXXXXXXX`. The random suffix avoids a
 * cross-booking counter and the date groups codes per booking day. Uniqueness
 * is still guaranteed by `appointments_tenant_code_unique`; the caller retries
 * on a (statistically extremely unlikely) collision.
 */
function buildAppointmentCode(startAt: Date): string {
  const year = startAt.getUTCFullYear();
  const month = String(startAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(startAt.getUTCDate()).padStart(2, "0");
  const suffix = randomBytes(4).toString("hex").toUpperCase();

  return `APT-${year}${month}${day}-${suffix}`;
}

/**
 * Inserts one appointment row, retrying only an appointment-code collision.
 * Each attempt runs in its own savepoint so a collision does not abort the
 * surrounding booking/reschedule transaction.
 */
export async function insertAppointmentRow(
  tx: DatabaseTransaction,
  values: Omit<NewAppointment, "appointmentCode">,
): Promise<Appointment> {
  for (let attempt = 0; attempt < APPOINTMENT_CODE_ATTEMPTS; attempt += 1) {
    try {
      return await tx.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(appointments)
          .values({
            ...values,
            appointmentCode: buildAppointmentCode(values.startAt as Date),
          })
          .returning();

        if (!row) throw AppError.internal("Failed to create the appointment");

        return row;
      });
    } catch (error) {
      const { code, constraint } = pgErrorInfo(error);

      if (code === "23505" && constraint === "appointments_tenant_code_unique") {
        continue;
      }

      throw error;
    }
  }

  throw AppError.internal("Could not allocate a unique appointment code");
}

/** Department must exist in this tenant and be active; NULL is not validated. */
export async function assertUsableDepartment(
  tx: DatabaseTransaction,
  tenantId: string,
  departmentId: string,
): Promise<void> {
  const [department] = await tx
    .select({
      id: departments.id,
      isActive: departments.isActive,
      deletedAt: departments.deletedAt,
    })
    .from(departments)
    .where(and(eq(departments.id, departmentId), eq(departments.tenantId, tenantId)))
    .limit(1);

  if (!department || department.deletedAt !== null) {
    throw AppError.notFound("Department not found");
  }

  if (!department.isActive) {
    throw AppError.badRequest(
      "Appointments cannot be booked for an inactive department",
    );
  }
}

/** Non-locking appointment read used by read-only validation. */
export async function loadAppointmentSnapshot(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<LockedAppointment> {
  const [row] = await tx
    .select({
      appointment: appointments,
      patientUserId: patientProfiles.userId,
      patientStatus: patientProfiles.status,
      patientDeletedAt: patientProfiles.deletedAt,
      doctorUserId: doctors.userId,
    })
    .from(appointments)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.id, appointments.patientId),
        eq(patientProfiles.tenantId, appointments.tenantId),
      ),
    )
    .innerJoin(
      doctors,
      and(
        eq(doctors.id, appointments.doctorId),
        eq(doctors.tenantId, appointments.tenantId),
      ),
    )
    .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId)))
    .limit(1);

  if (!row) throw AppError.notFound("Appointment not found");

  return row;
}

/**
 * A patient may act on their own appointments without a hospital membership.
 * Everyone else must be an active tenant member and, when the resolved RBAC set
 * is available, hold the operation's permission.
 */
/** Staff-only authorization: active membership plus the resolved permission. */
export async function authorizeStaffAppointmentAction(
  tx: DatabaseTransaction,
  tenantId: string,
  actor: AppointmentBookingActorContext,
  permission: string,
  forbiddenMessage: string,
): Promise<void> {
  await assertActiveMembership(tx, tenantId, actor.userId);

  if (actor.permissions !== undefined && !actor.permissions.has(permission)) {
    throw AppError.forbidden(forbiddenMessage);
  }
}

export async function authorizeAppointmentAction(
  tx: DatabaseTransaction,
  tenantId: string,
  patientUserId: string | null,
  actor: AppointmentBookingActorContext,
  permission: string,
  forbiddenMessage: string,
): Promise<void> {
  if (patientUserId !== null && patientUserId === actor.userId) return;

  await assertActiveMembership(tx, tenantId, actor.userId);

  if (actor.permissions !== undefined && !actor.permissions.has(permission)) {
    throw AppError.forbidden(forbiddenMessage);
  }
}
