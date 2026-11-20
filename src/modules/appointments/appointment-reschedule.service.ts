import { and, eq } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import {
  appointmentEvents,
  appointments,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { enqueueAppointmentRescheduledNotification } from "../notifications/notification.appointment.service.js";
import { evaluateSlotBooking } from "./appointment-availability.service.js";
import type { AppointmentActorContext } from "./appointment-booking.types.js";
import type {
  RescheduleAppointmentInput,
  RescheduleAppointmentResult,
  RescheduleValidation,
} from "./appointment-reschedule.types.js";
import {
  APPOINTMENT_OPERATIONS,
  assertAppointmentTransition,
  assertDoctorAppointmentScope,
  assertUsableDepartment,
  assertUuid,
  authorizeAppointmentAction,
  findIdempotencyRecord,
  hashCanonicalRequest,
  idempotencyReuseError,
  insertAppointmentRow,
  insertCompletedIdempotencyKey,
  loadAppointmentDto,
  loadAppointmentSnapshot,
  lockAppointment,
  mapAppointmentError,
  normalizeIdempotencyKey,
  normalizeInstant,
  normalizeNow,
  normalizeOptionalText,
  slotUnavailableError,
  type LockedAppointment,
} from "./appointment-service.shared.js";

/**
 * Appointment rescheduling service (Phase 18.4).
 *
 * Model: replacement appointment (documented in Phase 18.1 and kept here).
 *   1. lock the existing appointment row (`SELECT ... FOR UPDATE`);
 *   2. resolve an idempotent replay, if the same key was already completed;
 *   3. authorize the caller (patient self-service or staff with
 *      `appointment:update`);
 *   4. validate patient/status and the target slot through the Phase 18.2
 *      availability model, ignoring the appointment's own interval;
 *   5. mark the original RESCHEDULED (this releases its slot inside the
 *      transaction), insert the replacement CONFIRMED appointment linked by
 *      `rescheduled_from_appointment_id`, and append both events.
 *
 * Marking the original first is what makes an in-place move (for example
 * 09:00 -> 09:15 with the same doctor) possible without a transient overlap.
 * Nothing is visible outside the transaction until commit, and any failure
 * rolls the original back to CONFIRMED, so the old slot is never lost.
 *
 * Concurrency:
 * - the row lock serializes reschedule-vs-reschedule and reschedule-vs-cancel;
 *   the second caller sees the new status and is rejected;
 * - the `appointments_no_overlap` GiST exclusion constraint remains the
 *   authoritative guard when two different appointments target the same slot;
 * - the partial unique index `appointments_rescheduled_from_unique` makes a
 *   second replacement for one original impossible even under a race.
 */

const OPERATION = APPOINTMENT_OPERATIONS.reschedule;
const REQUIRED_PERMISSION = "appointment:update";
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const MAX_REASON_LENGTH = 1000;

interface NormalizedReschedule {
  readonly appointmentId: string;
  readonly doctorId: string | null;
  readonly branchId: string | null;
  /** `undefined` = keep the current department; `null` = clear it. */
  readonly departmentId: string | null | undefined;
  readonly startAt: Date;
  readonly durationMinutes: number | null;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

function normalizeDuration(value: number, field: string): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_DURATION_MINUTES ||
    value > MAX_DURATION_MINUTES
  ) {
    throw AppError.validation(
      `${field} must be an integer between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes`,
    );
  }

  return value;
}

function normalizeRescheduleInput(input: RescheduleAppointmentInput): NormalizedReschedule {
  if (input.durationMinutes !== undefined && input.endAt !== undefined) {
    throw AppError.validation(
      "Provide either endAt or durationMinutes for the new appointment, not both",
    );
  }

  const startAt = normalizeInstant(input.startAt, "New appointment start");
  let durationMinutes: number | null = null;

  if (input.durationMinutes !== undefined) {
    durationMinutes = normalizeDuration(input.durationMinutes, "Appointment duration");
  } else if (input.endAt !== undefined) {
    const endAt = normalizeInstant(input.endAt, "New appointment end");
    const difference = endAt.getTime() - startAt.getTime();

    if (difference <= 0) {
      throw AppError.validation("New appointment end must be later than its start");
    }

    if (difference % 60_000 !== 0) {
      throw AppError.validation("New appointment end must align to a whole minute");
    }

    durationMinutes = normalizeDuration(
      difference / 60_000,
      "Appointment duration",
    );
  }

  return {
    appointmentId: assertUuid(input.appointmentId, "Appointment id"),
    doctorId:
      input.doctorId === undefined ? null : assertUuid(input.doctorId, "Doctor id"),
    branchId:
      input.branchId === undefined ? null : assertUuid(input.branchId, "Branch id"),
    departmentId:
      input.departmentId === undefined || input.departmentId === null
        ? input.departmentId
        : assertUuid(input.departmentId, "Department id"),
    startAt,
    durationMinutes,
    reason: normalizeOptionalText(
      input.reason,
      "Rescheduling reason",
      MAX_REASON_LENGTH,
    ),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    now: normalizeNow(input.now),
  };
}

function hashRescheduleRequest(booking: NormalizedReschedule): string {
  return hashCanonicalRequest({
    operation: OPERATION,
    appointmentId: booking.appointmentId,
    doctorId: booking.doctorId,
    branchId: booking.branchId,
    departmentId:
      booking.departmentId === undefined ? "keep-current" : booking.departmentId,
    startAt: booking.startAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    reason: booking.reason,
  });
}

/**
 * Validates the move and returns the resolved plan. Pure reads: the caller
 * decides whether to authorize, write or only report.
 */
async function computeReschedulePlan(
  tx: DatabaseTransaction,
  tenantId: string,
  current: LockedAppointment,
  normalized: NormalizedReschedule,
): Promise<RescheduleValidation> {
  const appointment = current.appointment;

  if (current.patientDeletedAt !== null) {
    throw AppError.badRequest("The patient record is no longer available");
  }

  if (current.patientStatus !== "ACTIVE") {
    throw AppError.badRequest(
      `This appointment belongs to a patient with status ${current.patientStatus}`,
    );
  }

  assertAppointmentTransition(
    appointment.appointmentStatus,
    "RESCHEDULED",
    "be rescheduled",
  );

  const targetDoctorId = normalized.doctorId ?? appointment.doctorId;
  const targetBranchId = normalized.branchId ?? appointment.branchId;
  const targetDepartmentId =
    normalized.departmentId === undefined
      ? appointment.departmentId
      : normalized.departmentId;

  if (targetDepartmentId !== null) {
    await assertUsableDepartment(tx, tenantId, targetDepartmentId);
  }

  // Same Phase 18.2 evaluation used by booking. The appointment's own interval
  // is ignored so an overlapping move is not treated as conflicting with
  // itself; every other reservation still blocks it.
  const evaluation = await evaluateSlotBooking(
    tx,
    tenantId,
    {
      doctorId: targetDoctorId,
      branchId: targetBranchId,
      startAt: normalized.startAt,
      durationMinutes: normalized.durationMinutes ?? undefined,
      now: normalized.now,
    },
    { excludeAppointmentId: appointment.id },
  );

  if (
    !evaluation.bookable ||
    evaluation.endAt === null ||
    evaluation.durationMinutes === null
  ) {
    throw slotUnavailableError(
      evaluation.reason,
      evaluation,
      targetDoctorId,
      targetBranchId,
    );
  }

  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    currentStatus: appointment.appointmentStatus,
    currentDoctorId: appointment.doctorId,
    currentBranchId: appointment.branchId,
    currentDepartmentId: appointment.departmentId,
    currentStartAt: appointment.startAt,
    currentEndAt: appointment.endAt,
    targetDoctorId,
    targetBranchId,
    targetDepartmentId,
    targetStartAt: normalized.startAt,
    targetEndAt: evaluation.endAt,
    durationMinutes: evaluation.durationMinutes,
    consultationFee: evaluation.consultationFee,
    currency: evaluation.currency,
    branchTimezone: evaluation.branchTimezone,
    reason: normalized.reason,
  };
}

async function replayCompletedReschedule(
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<RescheduleAppointmentResult | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const record = await findIdempotencyRecord(tx, tenantId, OPERATION, idempotencyKey);

    if (!record) return null;

    if (record.requestHash !== requestHash) throw idempotencyReuseError();

    if (record.status !== "COMPLETED" || record.appointmentId === null) return null;

    const replacement = await loadAppointmentDto(tx, tenantId, record.appointmentId);
    const originalId = replacement.rescheduledFromAppointmentId;

    if (originalId === null) {
      throw AppError.conflict(
        "The idempotency key does not reference a reschedule replacement",
      );
    }

    const original = await loadAppointmentDto(tx, tenantId, originalId);

    return {
      original: { ...original, replayed: true },
      replacement: { ...replacement, replayed: true },
      replayed: true,
    };
  });
}

async function rescheduleCore(
  tx: DatabaseTransaction,
  tenantId: string,
  normalized: NormalizedReschedule,
  actor: AppointmentActorContext,
): Promise<RescheduleAppointmentResult> {
  const requestHash = hashRescheduleRequest(normalized);
  const current = await lockAppointment(tx, tenantId, normalized.appointmentId);

  // Authorize before any replay: a retried key must never return an appointment
  // the caller could not otherwise act on.
  await authorizeAppointmentAction(
    tx,
    tenantId,
    current.patientUserId,
    actor,
    REQUIRED_PERMISSION,
    "You do not have permission to reschedule appointments",
  );
  await assertDoctorAppointmentScope(tx, tenantId, current.appointment.doctorId, actor);

  if (normalized.idempotencyKey !== null) {
    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      OPERATION,
      normalized.idempotencyKey,
    );

    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyReuseError();

      if (existing.status === "COMPLETED" && existing.appointmentId !== null) {
        const replacement = await loadAppointmentDto(
          tx,
          tenantId,
          existing.appointmentId,
        );
        const originalId = replacement.rescheduledFromAppointmentId;

        if (originalId === null) {
          throw AppError.conflict(
            "The idempotency key does not reference a reschedule replacement",
          );
        }

        const original = await loadAppointmentDto(tx, tenantId, originalId);
        return {
          original: { ...original, replayed: true },
          replacement: { ...replacement, replayed: true },
          replayed: true,
        };
      }

      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "This idempotency key is already in use; retry the request",
      );
    }
  }

  const plan = await computeReschedulePlan(tx, tenantId, current, normalized);

  // Release the old interval inside the transaction, then reserve the new one.
  // The rollback on any later failure restores the original CONFIRMED row.
  const [released] = await tx
    .update(appointments)
    .set({ appointmentStatus: "RESCHEDULED" })
    .where(
      and(
        eq(appointments.id, current.appointment.id),
        eq(appointments.tenantId, tenantId),
      ),
    )
    .returning();

  if (!released) {
    throw AppError.internal("Failed to release the superseded appointment");
  }

  const replacement = await insertAppointmentRow(tx, {
    tenantId,
    patientId: released.patientId,
    doctorId: plan.targetDoctorId,
    branchId: plan.targetBranchId,
    departmentId: plan.targetDepartmentId,
    appointmentSource: released.appointmentSource,
    appointmentType: released.appointmentType,
    appointmentStatus: "CONFIRMED",
    startAt: plan.targetStartAt,
    endAt: plan.targetEndAt,
    // Fees always come from the target doctor-branch assignment.
    consultationFee: plan.consultationFee,
    currency: plan.currency,
    reason: released.reason,
    notes: released.notes,
    createdBy: actor.userId,
    rescheduledFromAppointmentId: released.id,
  });

  await tx.insert(appointmentEvents).values({
    tenantId,
    appointmentId: released.id,
    eventType: "RESCHEDULED",
    previousStatus: plan.currentStatus,
    newStatus: "RESCHEDULED",
    actorUserId: actor.userId,
    metadata: {
      reason: plan.reason,
      previousStartAt: plan.currentStartAt.toISOString(),
      previousEndAt: plan.currentEndAt.toISOString(),
      newStartAt: plan.targetStartAt.toISOString(),
      newEndAt: plan.targetEndAt.toISOString(),
      previousDoctorId: plan.currentDoctorId,
      previousBranchId: plan.currentBranchId,
      newDoctorId: plan.targetDoctorId,
      newBranchId: plan.targetBranchId,
      durationMinutes: plan.durationMinutes,
      replacementAppointmentId: replacement.id,
    },
  });

  await tx.insert(appointmentEvents).values({
    tenantId,
    appointmentId: replacement.id,
    eventType: "CREATED",
    previousStatus: null,
    newStatus: "CONFIRMED",
    actorUserId: actor.userId,
    metadata: {
      appointmentCode: replacement.appointmentCode,
      rescheduledFromAppointmentId: released.id,
      startAt: plan.targetStartAt.toISOString(),
      endAt: plan.targetEndAt.toISOString(),
      durationMinutes: plan.durationMinutes,
      appointmentSource: replacement.appointmentSource,
      appointmentType: replacement.appointmentType,
    },
  });

  if (normalized.idempotencyKey !== null) {
    await insertCompletedIdempotencyKey(tx, {
      tenantId,
      operation: OPERATION,
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      // The replacement is the current appointment for this key.
      appointmentId: replacement.id,
      now: normalized.now,
    });
  }

  // Only the replacement carries the new time; suppressing a reminder for the
  // superseded appointment is handled by its RESCHEDULED status.
  await enqueueAppointmentRescheduledNotification(tx, tenantId, replacement.id);

  await recordAuditSafely(tx, {
    tenantId,
    branchId: replacement.branchId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
    module: "appointments",
    resourceType: "appointment",
    resourceId: replacement.id,
    description: "Appointment rescheduled",
    previousState: {
      status: plan.currentStatus,
      appointmentId: released.id,
      startAt: plan.currentStartAt.toISOString(),
      doctorId: plan.currentDoctorId,
    },
    newState: {
      status: "CONFIRMED",
      appointmentId: replacement.id,
      startAt: plan.targetStartAt.toISOString(),
      doctorId: plan.targetDoctorId,
    },
  });

  const originalDto = await loadAppointmentDto(tx, tenantId, released.id);
  const replacementDto = await loadAppointmentDto(tx, tenantId, replacement.id);

  return { original: originalDto, replacement: replacementDto, replayed: false };
}

/**
 * Reschedules inside a caller-owned tenant transaction (concurrency tests and
 * composable workflows). Database errors are mapped to operational errors.
 */
export async function rescheduleAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: RescheduleAppointmentInput,
  actor: AppointmentActorContext,
): Promise<RescheduleAppointmentResult> {
  const normalized = normalizeRescheduleInput(input);

  try {
    return await rescheduleCore(tx, tenantId, normalized, actor);
  } catch (error) {
    mapAppointmentError(error);
  }
}

/**
 * Read-only validation of a reschedule request: tenant ownership, patient
 * state, status eligibility, target doctor/branch assignment, slot rules and
 * server-resolved fee/currency. It performs no writes and no authorization;
 * `rescheduleAppointment` repeats the validation inside its transaction.
 */
export async function validateRescheduleRequest(
  tenantId: string,
  input: RescheduleAppointmentInput,
): Promise<RescheduleValidation> {
  const normalized = normalizeRescheduleInput(input);

  return withTenantTransaction(tenantId, async (tx) => {
    const current = await loadAppointmentSnapshot(
      tx,
      tenantId,
      normalized.appointmentId,
    );

    return computeReschedulePlan(tx, tenantId, current, normalized);
  });
}

/**
 * Reschedules one appointment, atomically. Retried requests with the same
 * idempotency key return the replacement created by the first attempt; reusing
 * a key with a different payload is a 409.
 */
export async function rescheduleAppointment(
  tenantId: string,
  input: RescheduleAppointmentInput,
  actor: AppointmentActorContext,
): Promise<RescheduleAppointmentResult> {
  const normalized = normalizeRescheduleInput(input);
  const requestHash = hashRescheduleRequest(normalized);

  try {
    return await withTenantTransaction(tenantId, (tx) =>
      rescheduleAppointmentInTransaction(tx, tenantId, input, actor),
    );
  } catch (error) {
    if (normalized.idempotencyKey !== null) {
      const replayed = await replayCompletedReschedule(
        tenantId,
        normalized.idempotencyKey,
        requestHash,
      );

      if (replayed) return replayed;
    }

    mapAppointmentError(error);
  }
}

