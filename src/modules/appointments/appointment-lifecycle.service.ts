import { and, asc, eq } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import { appointmentEvents, appointments } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import type {
  AppointmentActorContext,
  AppointmentBookingDto,
  AppointmentStatus,
} from "./appointment-booking.types.js";
import type {
  AppointmentLifecycleEventDto,
  AppointmentLifecycleHistory,
  AppointmentLifecycleInput,
  AppointmentLifecycleResult,
  AppointmentNoShowInput,
} from "./appointment-lifecycle.types.js";
import {
  assertAppointmentTransition,
  assertDoctorAppointmentScope,
  assertUuid,
  authorizeAppointmentAction,
  authorizeStaffAppointmentAction,
  loadAppointmentDto,
  loadAppointmentSnapshot,
  lockAppointment,
  mapAppointmentError,
  normalizeNow,
  normalizeOptionalText,
  type LockedAppointment,
} from "./appointment-service.shared.js";

/**
 * Appointment lifecycle service (Phase 18.5).
 *
 * Normal flow:
 *   CONFIRMED --checkIn--> CHECKED_IN --start--> IN_PROGRESS --complete--> COMPLETED
 *   CONFIRMED --noShow--> NO_SHOW          (only after the scheduled end time)
 *
 * Every method:
 * - runs in a tenant-scoped transaction and locks the appointment row;
 * - validates the transition against the central `APPOINTMENT_TRANSITIONS` table;
 * - requires an ACTIVE staff membership and `appointment:update` (history uses
 *   `appointment:read`; a patient may read their own history);
 * - restricts a caller who is a doctor in this tenant to their own appointments;
 * - writes the status, its lifecycle timestamp and one event atomically;
 * - treats a repeat of the exact target status as an idempotent no-op
 *   (`applied: false`) without a second event.
 *
 * Payment state is intentionally untouched. There is no automatic no-show job,
 * medical record, consultation note or notification in this phase.
 */

const UPDATE_PERMISSION = "appointment:update";
const READ_PERMISSION = "appointment:read";
const MAX_NO_SHOW_REASON_LENGTH = 500;

type LifecycleTimestampColumn =
  | "checkedInAt"
  | "consultationStartedAt"
  | "completedAt"
  | "noShowAt";

interface TransitionOptions {
  readonly appointmentId: string;
  readonly target: AppointmentStatus;
  readonly action: string;
  readonly eventAction: string;
  readonly eventType: "STATUS_CHANGED" | "NO_SHOW";
  readonly timestampColumn: LifecycleTimestampColumn;
  readonly now: Date;
  readonly metadata?: Record<string, unknown>;
  readonly beforeWrite?: (locked: LockedAppointment) => Promise<void> | void;
}

function normalizeAppointmentId(value: string): string {
  return assertUuid(value, "Appointment id");
}

async function applyTransition(
  tx: DatabaseTransaction,
  tenantId: string,
  options: TransitionOptions,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  try {
    return await applyTransitionCore(tx, tenantId, options, actor);
  } catch (error) {
    mapAppointmentError(error);
  }
}

async function applyTransitionCore(
  tx: DatabaseTransaction,
  tenantId: string,
  options: TransitionOptions,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  const locked = await lockAppointment(tx, tenantId, options.appointmentId);

  // Lifecycle actions are staff operations; a patient cannot check themselves
  // in or complete their own consultation.
  await authorizeStaffAppointmentAction(
    tx,
    tenantId,
    actor,
    UPDATE_PERMISSION,
    "You do not have permission to update appointments",
  );
  await assertDoctorAppointmentScope(
    tx,
    tenantId,
    locked.appointment.doctorId,
    actor,
  );

  const current = locked.appointment.appointmentStatus;

  // Idempotent repeat: already in the requested state. No write, no event.
  if (current === options.target) {
    const existing = await loadAppointmentDto(tx, tenantId, locked.appointment.id);
    return { appointment: { ...existing, replayed: true }, applied: false };
  }

  assertAppointmentTransition(current, options.target, options.action);

  if (options.beforeWrite) await options.beforeWrite(locked);

  const [updated] = await tx
    .update(appointments)
    .set({
      appointmentStatus: options.target,
      [options.timestampColumn]: options.now,
    })
    .where(
      and(
        eq(appointments.id, locked.appointment.id),
        eq(appointments.tenantId, tenantId),
      ),
    )
    .returning();

  if (!updated) {
    throw AppError.internal("Failed to update the appointment status");
  }

  await tx.insert(appointmentEvents).values({
    tenantId,
    appointmentId: updated.id,
    eventType: options.eventType,
    previousStatus: current,
    newStatus: options.target,
    actorUserId: actor.userId,
    metadata: { action: options.eventAction, ...options.metadata },
    createdAt: options.now,
  });

  await recordAuditSafely(tx, {
    tenantId,
    branchId: updated.branchId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.APPOINTMENT_STATUS_CHANGED,
    module: "appointments",
    resourceType: "appointment",
    resourceId: updated.id,
    description: "Appointment status changed",
    previousState: { status: current },
    newState: { status: options.target },
    metadata: { eventAction: options.eventAction },
  });

  const appointment = await loadAppointmentDto(tx, tenantId, updated.id);

  return { appointment, applied: true };
}

/** CONFIRMED -> CHECKED_IN. Records `checked_in_at`. */
export async function checkInAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return applyTransition(
    tx,
    tenantId,
    {
      appointmentId: normalizeAppointmentId(input.appointmentId),
      target: "CHECKED_IN",
      action: "be checked in",
      eventAction: "CHECK_IN",
      eventType: "STATUS_CHANGED",
      timestampColumn: "checkedInAt",
      now: normalizeNow(input.now),
    },
    actor,
  );
}

/** CHECKED_IN -> IN_PROGRESS. Records `consultation_started_at`. */
export async function startAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return applyTransition(
    tx,
    tenantId,
    {
      appointmentId: normalizeAppointmentId(input.appointmentId),
      target: "IN_PROGRESS",
      action: "be started",
      eventAction: "START_CONSULTATION",
      eventType: "STATUS_CHANGED",
      timestampColumn: "consultationStartedAt",
      now: normalizeNow(input.now),
    },
    actor,
  );
}

/** IN_PROGRESS -> COMPLETED. Records `completed_at`. */
export async function completeAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return applyTransition(
    tx,
    tenantId,
    {
      appointmentId: normalizeAppointmentId(input.appointmentId),
      target: "COMPLETED",
      action: "be completed",
      eventAction: "COMPLETE",
      eventType: "STATUS_CHANGED",
      timestampColumn: "completedAt",
      now: normalizeNow(input.now),
    },
    actor,
  );
}

/**
 * CONFIRMED -> NO_SHOW. Only allowed at or after the scheduled end instant (no
 * automatic policy override in this phase). Records `no_show_at` and the
 * optional reason in the event metadata.
 */
export async function markAppointmentAsNoShowInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: AppointmentNoShowInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  const now = normalizeNow(input.now);
  const reason = normalizeOptionalText(
    input.reason,
    "No-show reason",
    MAX_NO_SHOW_REASON_LENGTH,
  );

  return applyTransition(
    tx,
    tenantId,
    {
      appointmentId: normalizeAppointmentId(input.appointmentId),
      target: "NO_SHOW",
      action: "be marked as a no-show",
      eventAction: "NO_SHOW",
      eventType: "NO_SHOW",
      timestampColumn: "noShowAt",
      now,
      metadata: reason === null ? {} : { reason },
      beforeWrite: (locked) => {
        if (now.getTime() < locked.appointment.endAt.getTime()) {
          throw new AppError(
            409,
            "NO_SHOW_TOO_EARLY",
            "A no-show can only be recorded after the scheduled appointment end time",
            { scheduledEndAt: locked.appointment.endAt },
          );
        }
      },
    },
    actor,
  );
}

/** CONFIRMED -> CHECKED_IN in its own transaction. */
export function checkInAppointment(
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return withTenantTransaction(tenantId, (tx) =>
    checkInAppointmentInTransaction(tx, tenantId, input, actor),
  );
}

/** CHECKED_IN -> IN_PROGRESS in its own transaction. */
export function startAppointment(
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return withTenantTransaction(tenantId, (tx) =>
    startAppointmentInTransaction(tx, tenantId, input, actor),
  );
}

/** IN_PROGRESS -> COMPLETED in its own transaction. */
export function completeAppointment(
  tenantId: string,
  input: AppointmentLifecycleInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return withTenantTransaction(tenantId, (tx) =>
    completeAppointmentInTransaction(tx, tenantId, input, actor),
  );
}

/** CONFIRMED -> NO_SHOW in its own transaction. */
export function markAppointmentAsNoShow(
  tenantId: string,
  input: AppointmentNoShowInput,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleResult> {
  return withTenantTransaction(tenantId, (tx) =>
    markAppointmentAsNoShowInTransaction(tx, tenantId, input, actor),
  );
}

/**
 * Chronological lifecycle history for one appointment.
 *
 * A patient may read their own history; staff need `appointment:read` and a
 * doctor may only read their own appointments. Cross-tenant appointments are a
 * 404, never a 403.
 */
export async function getAppointmentLifecycleHistory(
  tenantId: string,
  appointmentId: string,
  actor: AppointmentActorContext,
): Promise<AppointmentLifecycleHistory> {
  const id = assertUuid(appointmentId, "Appointment id");

  return withTenantTransaction(tenantId, async (tx) => {
    const locked = await loadAppointmentSnapshot(tx, tenantId, id);

    await authorizeAppointmentAction(
      tx,
      tenantId,
      locked.patientUserId,
      actor,
      READ_PERMISSION,
      "You do not have permission to read appointment history",
    );
    await assertDoctorAppointmentScope(
      tx,
      tenantId,
      locked.appointment.doctorId,
      actor,
    );

    const rows = await tx
      .select({
        id: appointmentEvents.id,
        eventType: appointmentEvents.eventType,
        previousStatus: appointmentEvents.previousStatus,
        newStatus: appointmentEvents.newStatus,
        actorUserId: appointmentEvents.actorUserId,
        metadata: appointmentEvents.metadata,
        createdAt: appointmentEvents.createdAt,
      })
      .from(appointmentEvents)
      .where(
        and(
          eq(appointmentEvents.tenantId, tenantId),
          eq(appointmentEvents.appointmentId, id),
        ),
      )
      .orderBy(asc(appointmentEvents.createdAt), asc(appointmentEvents.id));

    const appointment: AppointmentBookingDto = await loadAppointmentDto(tx, tenantId, id);

    const events: AppointmentLifecycleEventDto[] = rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      actorUserId: row.actorUserId,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }));

    return { appointment, events };
  });
}
