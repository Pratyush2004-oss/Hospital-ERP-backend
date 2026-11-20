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
import { enqueueAppointmentCancelledNotification } from "../notifications/notification.appointment.service.js";
import type { AppointmentActorContext } from "./appointment-booking.types.js";
import type {
  CancelAppointmentInput,
  CancelAppointmentResult,
} from "./appointment-cancel.types.js";
import {
  APPOINTMENT_OPERATIONS,
  assertAppointmentTransition,
  assertDoctorAppointmentScope,
  assertUuid,
  authorizeAppointmentAction,
  findIdempotencyRecord,
  hashCanonicalRequest,
  idempotencyReuseError,
  insertCompletedIdempotencyKey,
  loadAppointmentDto,
  lockAppointment,
  mapAppointmentError,
  normalizeIdempotencyKey,
  normalizeNow,
  normalizeRequiredText,
  type LockedAppointment,
} from "./appointment-service.shared.js";

/**
 * Appointment cancellation service (Phase 18.4).
 *
 * Valid transitions (Phase 18.1 status model):
 *   PENDING -> CANCELLED
 *   CONFIRMED -> CANCELLED
 *   CHECKED_IN -> CANCELLED
 *
 * IN_PROGRESS, COMPLETED, NO_SHOW, RESCHEDULED and an already CANCELLED row are
 * not cancellable through this service. Repeating a cancellation is a
 * consistent no-op: the existing cancelled row is returned and **no second
 * event** is written. Payment state is untouched; refunds belong to the
 * Billing/Payments module.
 *
 * The row is locked `FOR UPDATE`, so a cancellation racing a reschedule (or
 * another cancellation) is serialized and always observes the committed state.
 * The slot becomes bookable as soon as the update commits because the exclusion
 * constraint only covers active statuses.
 */

const OPERATION = APPOINTMENT_OPERATIONS.cancel;
const REQUIRED_PERMISSION = "appointment:cancel";
const MAX_REASON_LENGTH = 1000;

interface NormalizedCancellation {
  readonly appointmentId: string;
  readonly cancellationReason: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

function normalizeCancelInput(input: CancelAppointmentInput): NormalizedCancellation {
  return {
    appointmentId: assertUuid(input.appointmentId, "Appointment id"),
    cancellationReason: normalizeRequiredText(
      input.cancellationReason,
      "Cancellation reason",
      MAX_REASON_LENGTH,
    ),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    now: normalizeNow(input.now),
  };
}

function hashCancelRequest(cancellation: NormalizedCancellation): string {
  return hashCanonicalRequest({
    operation: OPERATION,
    appointmentId: cancellation.appointmentId,
    cancellationReason: cancellation.cancellationReason,
  });
}

async function cancelledResult(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
  replayed: boolean,
): Promise<CancelAppointmentResult> {
  const appointment = await loadAppointmentDto(tx, tenantId, appointmentId);
  return { appointment: { ...appointment, replayed }, replayed };
}

async function cancelCore(
  tx: DatabaseTransaction,
  tenantId: string,
  cancellation: NormalizedCancellation,
  actor: AppointmentActorContext,
): Promise<CancelAppointmentResult> {
  const requestHash = hashCancelRequest(cancellation);
  const current: LockedAppointment = await lockAppointment(
    tx,
    tenantId,
    cancellation.appointmentId,
  );

  // Authorize before any replay: a retried key must never return an appointment
  // the caller could not otherwise act on.
  await authorizeAppointmentAction(
    tx,
    tenantId,
    current.patientUserId,
    actor,
    REQUIRED_PERMISSION,
    "You do not have permission to cancel appointments",
  );
  await assertDoctorAppointmentScope(tx, tenantId, current.appointment.doctorId, actor);

  if (cancellation.idempotencyKey !== null) {
    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      OPERATION,
      cancellation.idempotencyKey,
    );

    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyReuseError();

      if (existing.status === "COMPLETED" && existing.appointmentId !== null) {
        return cancelledResult(tx, tenantId, existing.appointmentId, true);
      }

      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "This idempotency key is already in use; retry the request",
      );
    }
  }

  // Repeating the same cancellation is consistent and never duplicates events.
  if (current.appointment.appointmentStatus === "CANCELLED") {
    return cancelledResult(tx, tenantId, current.appointment.id, true);
  }

  assertAppointmentTransition(
    current.appointment.appointmentStatus,
    "CANCELLED",
    "be cancelled",
  );

  const [cancelled] = await tx
    .update(appointments)
    .set({
      appointmentStatus: "CANCELLED",
      cancellationReason: cancellation.cancellationReason,
      cancelledBy: actor.userId,
    })
    .where(
      and(
        eq(appointments.id, current.appointment.id),
        eq(appointments.tenantId, tenantId),
      ),
    )
    .returning();

  if (!cancelled) {
    throw AppError.internal("Failed to cancel the appointment");
  }

  await tx.insert(appointmentEvents).values({
    tenantId,
    appointmentId: cancelled.id,
    eventType: "CANCELLED",
    previousStatus: current.appointment.appointmentStatus,
    newStatus: "CANCELLED",
    actorUserId: actor.userId,
    metadata: {
      cancellationReason: cancellation.cancellationReason,
      previousStartAt: cancelled.startAt.toISOString(),
      previousEndAt: cancelled.endAt.toISOString(),
    },
  });

  if (cancellation.idempotencyKey !== null) {
    await insertCompletedIdempotencyKey(tx, {
      tenantId,
      operation: OPERATION,
      idempotencyKey: cancellation.idempotencyKey,
      requestHash,
      appointmentId: cancelled.id,
      now: cancellation.now,
    });
  }

  await enqueueAppointmentCancelledNotification(tx, tenantId, cancelled.id);

  await recordAuditSafely(tx, {
    tenantId,
    branchId: cancelled.branchId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.APPOINTMENT_CANCELLED,
    module: "appointments",
    resourceType: "appointment",
    resourceId: cancelled.id,
    description: "Appointment cancelled",
    previousState: { status: current.appointment.appointmentStatus },
    newState: { status: "CANCELLED" },
  });

  return cancelledResult(tx, tenantId, cancelled.id, false);
}

/**
 * Cancels inside a caller-owned tenant transaction (concurrency tests and
 * composable workflows). Database errors are mapped to operational errors.
 */
export async function cancelAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: CancelAppointmentInput,
  actor: AppointmentActorContext,
): Promise<CancelAppointmentResult> {
  const cancellation = normalizeCancelInput(input);

  try {
    return await cancelCore(tx, tenantId, cancellation, actor);
  } catch (error) {
    mapAppointmentError(error);
  }
}

/**
 * Cancels one appointment in its own transaction. A retried request with the
 * same idempotency key, or a plain repeat of the cancellation, returns the
 * already cancelled appointment without creating another event.
 */
export async function cancelAppointment(
  tenantId: string,
  input: CancelAppointmentInput,
  actor: AppointmentActorContext,
): Promise<CancelAppointmentResult> {
  const cancellation = normalizeCancelInput(input);
  const requestHash = hashCancelRequest(cancellation);
  const idempotencyKey = cancellation.idempotencyKey;

  try {
    return await withTenantTransaction(tenantId, (tx) =>
      cancelAppointmentInTransaction(tx, tenantId, input, actor),
    );
  } catch (error) {
    if (idempotencyKey !== null) {
      const replayed = await withTenantTransaction(tenantId, async (tx) => {
        const record = await findIdempotencyRecord(
          tx,
          tenantId,
          OPERATION,
          idempotencyKey,
        );

        if (!record) return null;
        if (record.requestHash !== requestHash) throw idempotencyReuseError();

        const completedAppointmentId = record.appointmentId;

        if (record.status !== "COMPLETED" || completedAppointmentId === null) {
          return null;
        }

        return cancelledResult(tx, tenantId, completedAppointmentId, true);
      });

      if (replayed) return replayed;
    }

    mapAppointmentError(error);
  }
}
