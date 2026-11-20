import { and, eq } from "drizzle-orm";
import {
  withTenantTransaction,
  type DatabaseTransaction,
} from "../../database/context.js";
import {
  appointmentEvents,
  patientProfiles,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { enqueueAppointmentConfirmedNotification } from "../notifications/notification.appointment.service.js";
import { evaluateSlotBooking } from "./appointment-availability.service.js";
import type {
  AppointmentBookingActorContext,
  AppointmentBookingDto,
  AppointmentSource,
  AppointmentType,
  CreateAppointmentBookingInput,
} from "./appointment-booking.types.js";
import {
  APPOINTMENT_OPERATIONS,
  assertUsableDepartment,
  assertUuid,
  authorizeAppointmentAction,
  findIdempotencyRecord,
  hashCanonicalRequest,
  idempotencyReuseError,
  insertAppointmentRow,
  insertCompletedIdempotencyKey,
  loadAppointmentDto,
  mapAppointmentError,
  normalizeIdempotencyKey,
  normalizeInstant,
  normalizeNow,
  normalizeOptionalText,
  slotUnavailableError,
  toAppointmentDto,
} from "./appointment-service.shared.js";

/**
 * Appointment booking service (Phase 18.3).
 *
 * A booking is a single transaction that:
 *   1. proves the patient belongs to the tenant and is active;
 *   2. authorizes the caller (patient self-booking or active staff member);
 *   3. resolves an idempotent replay, if the client retries with the same key;
 *   4. revalidates the slot with the Phase 18.2 scheduling model (no second
 *      availability implementation);
 *   5. inserts the appointment, its CREATED history event and the idempotency
 *      record, then commits.
 *
 * Double-booking is prevented by the existing `appointments_no_overlap` GiST
 * exclusion constraint, not by the read-time check. Two concurrent requests can
 * both pass step 4; only one can commit, and the loser receives a 409
 * `SLOT_UNAVAILABLE`. `40P01`/`40001` (serialization/deadlock) and `23P01`
 * (exclusion violation) are both mapped to that safe conflict response.
 *
 * Fees and currency are always read from `doctor_branches`; the caller cannot
 * supply them. Status is `CONFIRMED` because the slot is reserved inside the
 * transaction, matching the Phase 18.1 status model.
 */

const REQUIRED_PERMISSION = "appointment:create";
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const MAX_REASON_LENGTH = 1000;
const MAX_NOTES_LENGTH = 2000;

const APPOINTMENT_SOURCES: readonly AppointmentSource[] = [
  "ONLINE",
  "RECEPTIONIST",
  "WALK_IN",
  "VOICE_AGENT",
];
const APPOINTMENT_TYPES: readonly AppointmentType[] = [
  "CONSULTATION",
  "FOLLOW_UP",
  "PROCEDURE",
  "EMERGENCY",
];

interface NormalizedBooking {
  readonly patientId: string;
  readonly doctorId: string;
  readonly branchId: string;
  readonly departmentId: string | null;
  readonly startAt: Date;
  readonly durationMinutes: number | null;
  readonly appointmentSource: AppointmentSource | null;
  readonly appointmentType: AppointmentType;
  readonly reason: string | null;
  readonly notes: string | null;
  readonly idempotencyKey: string | null;
  readonly now: Date;
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

function normalizeBookingInput(input: CreateAppointmentBookingInput): NormalizedBooking {
  const departmentId =
    input.departmentId === undefined || input.departmentId === null
      ? null
      : assertUuid(input.departmentId, "Department id");

  if (
    input.appointmentSource !== undefined &&
    !APPOINTMENT_SOURCES.includes(input.appointmentSource)
  ) {
    throw AppError.validation("Unknown appointment source");
  }

  const appointmentType = input.appointmentType ?? "CONSULTATION";

  if (!APPOINTMENT_TYPES.includes(appointmentType)) {
    throw AppError.validation("Unknown appointment type");
  }

  return {
    patientId: assertUuid(input.patientId, "Patient id"),
    doctorId: assertUuid(input.doctorId, "Doctor id"),
    branchId: assertUuid(input.branchId, "Branch id"),
    departmentId,
    startAt: normalizeInstant(input.startAt),
    durationMinutes: normalizeDuration(input.durationMinutes),
    appointmentSource: input.appointmentSource ?? null,
    appointmentType,
    reason: normalizeOptionalText(input.reason, "Appointment reason", MAX_REASON_LENGTH),
    notes: normalizeOptionalText(input.notes, "Appointment notes", MAX_NOTES_LENGTH),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    now: normalizeNow(input.now),
  };
}

/**
 * SHA-256 of the canonical request. Only caller-controlled booking fields are
 * hashed: derived values (status, fee, currency, resolved source) are excluded
 * so a legitimate retry always produces the same digest.
 */
function hashBookingRequest(booking: NormalizedBooking): string {
  return hashCanonicalRequest({
    patientId: booking.patientId,
    doctorId: booking.doctorId,
    branchId: booking.branchId,
    departmentId: booking.departmentId,
    startAt: booking.startAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    appointmentSource: booking.appointmentSource,
    appointmentType: booking.appointmentType,
    reason: booking.reason,
    notes: booking.notes,
  });
}

async function loadBookablePatient(
  tx: DatabaseTransaction,
  tenantId: string,
  patientId: string,
) {
  const [patient] = await tx
    .select({
      id: patientProfiles.id,
      userId: patientProfiles.userId,
      status: patientProfiles.status,
      deletedAt: patientProfiles.deletedAt,
    })
    .from(patientProfiles)
    .where(and(eq(patientProfiles.id, patientId), eq(patientProfiles.tenantId, tenantId)))
    .limit(1);

  if (!patient || patient.deletedAt !== null) {
    throw AppError.notFound("Patient not found");
  }

  if (patient.status !== "ACTIVE") {
    throw AppError.badRequest(
      `Appointments cannot be booked for a patient with status ${patient.status}`,
    );
  }

  return patient;
}

async function bookAppointmentCore(
  tx: DatabaseTransaction,
  tenantId: string,
  input: CreateAppointmentBookingInput,
  actor: AppointmentBookingActorContext,
): Promise<AppointmentBookingDto> {
  const booking = normalizeBookingInput(input);
  const requestHash = hashBookingRequest(booking);

  const patient = await loadBookablePatient(tx, tenantId, booking.patientId);

  // A patient may book their own profile; everyone else must be active staff.
  await authorizeAppointmentAction(
    tx,
    tenantId,
    patient.userId,
    actor,
    REQUIRED_PERMISSION,
    "You do not have permission to book appointments",
  );

  const isSelfService = patient.userId !== null && patient.userId === actor.userId;
  const appointmentSource: AppointmentSource =
    booking.appointmentSource ?? (isSelfService ? "ONLINE" : "RECEPTIONIST");

  if (booking.idempotencyKey !== null) {
    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      APPOINTMENT_OPERATIONS.create,
      booking.idempotencyKey,
    );

    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyReuseError();

      if (existing.status === "COMPLETED" && existing.appointmentId !== null) {
        const replayed = await loadAppointmentDto(tx, tenantId, existing.appointmentId);
        return { ...replayed, replayed: true };
      }

      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "This idempotency key is already in use; retry the request",
      );
    }
  }

  if (booking.departmentId !== null) {
    await assertUsableDepartment(tx, tenantId, booking.departmentId);
  }

  // Reuses the Phase 18.2 availability model; never reimplemented here.
  const evaluation = await evaluateSlotBooking(tx, tenantId, {
    doctorId: booking.doctorId,
    branchId: booking.branchId,
    startAt: booking.startAt,
    durationMinutes: booking.durationMinutes ?? undefined,
    now: booking.now,
  });

  if (
    !evaluation.bookable ||
    evaluation.endAt === null ||
    evaluation.durationMinutes === null
  ) {
    throw slotUnavailableError(
      evaluation.reason,
      evaluation,
      booking.doctorId,
      booking.branchId,
    );
  }

  const appointment = await insertAppointmentRow(tx, {
    tenantId,
    patientId: booking.patientId,
    doctorId: booking.doctorId,
    branchId: booking.branchId,
    departmentId: booking.departmentId,
    appointmentSource,
    appointmentType: booking.appointmentType,
    appointmentStatus: "CONFIRMED",
    startAt: booking.startAt,
    endAt: evaluation.endAt,
    // Fees are authoritative server-side values, never request fields.
    consultationFee: evaluation.consultationFee,
    currency: evaluation.currency,
    reason: booking.reason,
    notes: booking.notes,
    createdBy: actor.userId,
  });

  await tx.insert(appointmentEvents).values({
    tenantId,
    appointmentId: appointment.id,
    eventType: "CREATED",
    previousStatus: null,
    newStatus: appointment.appointmentStatus,
    actorUserId: actor.userId,
    metadata: {
      appointmentCode: appointment.appointmentCode,
      appointmentSource,
      appointmentType: appointment.appointmentType,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      durationMinutes: evaluation.durationMinutes,
    },
  });

  if (booking.idempotencyKey !== null) {
    await insertCompletedIdempotencyKey(tx, {
      tenantId,
      operation: APPOINTMENT_OPERATIONS.create,
      idempotencyKey: booking.idempotencyKey,
      requestHash,
      appointmentId: appointment.id,
      now: booking.now,
    });
  }

  // Savepoint-protected outbox write: a notification failure never rolls back
  // the booking, and a successful write commits with it.
  await enqueueAppointmentConfirmedNotification(tx, tenantId, appointment.id);

  await recordAuditSafely(tx, {
    tenantId,
    branchId: appointment.branchId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.APPOINTMENT_CREATED,
    module: "appointments",
    resourceType: "appointment",
    resourceId: appointment.id,
    description: "Appointment booked",
    metadata: {
      appointmentCode: appointment.appointmentCode,
      doctorId: appointment.doctorId,
      branchId: appointment.branchId,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      appointmentSource,
    },
  });

  return toAppointmentDto(appointment, evaluation.branchTimezone, false);
}

/**
 * Books one appointment inside an existing tenant transaction.
 *
 * Exposed so callers that already own a transaction (and concurrency tests)
 * can book without nesting one. The transaction must already carry the
 * `app.current_tenant_id` setting — `withTenantTransaction` does that. Database
 * failures are mapped to operational errors here too, so a concurrent loser
 * sees the same 409 as a caller of `createAppointmentBooking`.
 */
export async function bookAppointmentInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  input: CreateAppointmentBookingInput,
  actor: AppointmentBookingActorContext,
): Promise<AppointmentBookingDto> {
  try {
    return await bookAppointmentCore(tx, tenantId, input, actor);
  } catch (error) {
    mapAppointmentError(error);
  }
}

/**
 * Returns a committed booking for a key that completed while this request was
 * in flight, or `null` when the key has no completed booking.
 */
async function replayCompletedKey(
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<AppointmentBookingDto | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const record = await findIdempotencyRecord(
      tx,
      tenantId,
      APPOINTMENT_OPERATIONS.create,
      idempotencyKey,
    );

    if (!record) return null;

    if (record.requestHash !== requestHash) throw idempotencyReuseError();

    if (record.status !== "COMPLETED" || record.appointmentId === null) return null;

    const appointment = await loadAppointmentDto(tx, tenantId, record.appointmentId);
    return { ...appointment, replayed: true };
  });
}

/**
 * Books an appointment for one tenant in its own transaction.
 *
 * Concurrent requests for the same slot cannot both succeed: the transaction
 * that loses gets a 409 `SLOT_UNAVAILABLE`. A request that loses the race for
 * the same idempotency key gets the winner's committed appointment instead.
 */
export async function createAppointmentBooking(
  tenantId: string,
  input: CreateAppointmentBookingInput,
  actor: AppointmentBookingActorContext,
): Promise<AppointmentBookingDto> {
  const booking = normalizeBookingInput(input);
  const requestHash = hashBookingRequest(booking);

  try {
    return await withTenantTransaction(tenantId, (tx) =>
      bookAppointmentInTransaction(tx, tenantId, input, actor),
    );
  } catch (error) {
    // Any failure may mean a concurrent request with the same key committed
    // first. Looking the key up is one indexed read on the error path only.
    if (booking.idempotencyKey !== null) {
      const replayed = await replayCompletedKey(
        tenantId,
        booking.idempotencyKey,
        requestHash,
      );

      if (replayed) return replayed;
    }

    mapAppointmentError(error);
  }
}
