import type {
  AppointmentActorContext,
  AppointmentBookingDto,
  AppointmentStatus,
} from "./appointment-booking.types.js";

/**
 * Appointment lifecycle service types (Phase 18.5).
 *
 * Check-in, consultation start, completion and no-show are status transitions
 * on the existing appointment row. They use the shared transition table, the
 * same tenant/actor conventions as booking and cancellation, and write exactly
 * one append-only event per applied transition.
 */

export interface AppointmentLifecycleInput {
  readonly appointmentId: string;
  /** Clock used for timestamps and the no-show time gate; defaults to now. */
  readonly now?: Date;
}

export interface AppointmentNoShowInput extends AppointmentLifecycleInput {
  /** Optional operational reason; stored in the event metadata only. */
  readonly reason?: string | null;
}

export interface AppointmentLifecycleResult {
  readonly appointment: AppointmentBookingDto;
  /**
   * `true` when this call performed the transition. `false` means the
   * appointment was already in the target state (an idempotent repeat) and no
   * second event was written.
   */
  readonly applied: boolean;
}

export type AppointmentEventType =
  | "CREATED"
  | "STATUS_CHANGED"
  | "UPDATED"
  | "RESCHEDULED"
  | "CANCELLED"
  | "NO_SHOW";

export interface AppointmentLifecycleEventDto {
  readonly id: string;
  readonly eventType: AppointmentEventType;
  readonly previousStatus: AppointmentStatus | null;
  readonly newStatus: AppointmentStatus | null;
  readonly actorUserId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface AppointmentLifecycleHistory {
  readonly appointment: AppointmentBookingDto;
  /** Chronological, oldest first. */
  readonly events: readonly AppointmentLifecycleEventDto[];
}

export type AppointmentLifecycleActorContext = AppointmentActorContext;
