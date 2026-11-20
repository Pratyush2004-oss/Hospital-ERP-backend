import type {
  AppointmentActorContext,
  AppointmentBookingDto,
  AppointmentStatus,
} from "./appointment-booking.types.js";

/**
 * Appointment rescheduling types (Phase 18.4).
 *
 * Rescheduling uses the documented replacement model: the superseded row is
 * marked RESCHEDULED (releasing its slot) and a new CONFIRMED appointment is
 * created with `rescheduled_from_appointment_id` pointing at the original.
 * Appointment identity is therefore never mutated in place, history keeps the
 * exact previous interval, and exactly one active reservation remains.
 */

export interface RescheduleAppointmentInput {
  /** Appointment to supersede. Must belong to the caller's tenant. */
  readonly appointmentId: string;
  /** Target doctor; omit to keep the current doctor. */
  readonly doctorId?: string;
  /** Target branch; omit to keep the current branch. */
  readonly branchId?: string;
  /** Omit to keep the current department; `null` clears it. */
  readonly departmentId?: string | null;
  /** New absolute start instant (ISO 8601 with offset, or `Date`). */
  readonly startAt: string | Date;
  /**
   * New absolute end instant. Mutually exclusive with `durationMinutes`; when
   * both are omitted the target working window's slot duration is used.
   */
  readonly endAt?: string | Date;
  /** Explicit duration override in minutes (5-480). */
  readonly durationMinutes?: number;
  /** Rescheduling reason; recorded in the event metadata only. */
  readonly reason?: string | null;
  /** Client retry key (1-200 characters), reused verbatim on a retry. */
  readonly idempotencyKey?: string;
  /** Clock used to reject past slots; defaults to the current time. */
  readonly now?: Date;
}

/**
 * Read-only result of `validateRescheduleRequest`. Everything the caller needs
 * to confirm the move, including server-resolved fee, currency and timezone.
 */
export interface RescheduleValidation {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly currentStatus: AppointmentStatus;
  readonly currentDoctorId: string;
  readonly currentBranchId: string;
  readonly currentDepartmentId: string | null;
  readonly currentStartAt: Date;
  readonly currentEndAt: Date;
  readonly targetDoctorId: string;
  readonly targetBranchId: string;
  readonly targetDepartmentId: string | null;
  readonly targetStartAt: Date;
  readonly targetEndAt: Date;
  readonly durationMinutes: number;
  /** Resolved from the target doctor-branch assignment, never from the caller. */
  readonly consultationFee: string;
  readonly currency: string;
  readonly branchTimezone: string;
  readonly reason: string | null;
}

export interface RescheduleAppointmentResult {
  /** Superseded appointment, now RESCHEDULED. */
  readonly original: AppointmentBookingDto;
  /** New CONFIRMED appointment that now holds the slot. */
  readonly replacement: AppointmentBookingDto;
  readonly replayed: boolean;
}

export type RescheduleActorContext = AppointmentActorContext;
