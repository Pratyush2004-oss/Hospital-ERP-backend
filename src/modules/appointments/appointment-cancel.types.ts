import type {
  AppointmentActorContext,
  AppointmentBookingDto,
} from "./appointment-booking.types.js";

/**
 * Appointment cancellation types (Phase 18.4).
 *
 * Cancellation is a status transition on the existing row: the appointment is
 * preserved (there is no delete path), `cancellation_reason` is recorded, the
 * slot is released by the status predicate of `appointments_no_overlap`, and
 * history is appended to `appointment_events`.
 */

export interface CancelAppointmentInput {
  readonly appointmentId: string;
  /** Required by the schema CHECK when status is CANCELLED. */
  readonly cancellationReason: string;
  /** Client retry key (1-200 characters), reused verbatim on a retry. */
  readonly idempotencyKey?: string;
  /** Clock captured in event/idempotency timestamps; defaults to now. */
  readonly now?: Date;
}

export interface CancelAppointmentResult {
  readonly appointment: AppointmentBookingDto;
  /** True when the request was already satisfied (retry or repeat cancel). */
  readonly replayed: boolean;
}

export type CancelActorContext = AppointmentActorContext;
