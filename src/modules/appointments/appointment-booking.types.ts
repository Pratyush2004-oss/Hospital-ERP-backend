/**
 * Appointment booking service types (Phase 18.3).
 *
 * Service contracts only: no HTTP schemas, routes or controllers. Every input
 * identifier is a tenant-owned UUID and every instant is an absolute timestamp.
 * Fees, currency and statuses are never accepted from the caller; they are
 * resolved from the doctor-branch assignment and the booking rules.
 */

export type AppointmentSource = "ONLINE" | "RECEPTIONIST" | "WALK_IN" | "VOICE_AGENT";

export type AppointmentType = "CONSULTATION" | "FOLLOW_UP" | "PROCEDURE" | "EMERGENCY";

export type AppointmentStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED";

/**
 * Verified caller identity. `userId` comes from the authenticated request
 * context, never from a request body. `permissions` is the resolved RBAC set;
 * when present, staff bookings require `appointment:create`. A patient may book
 * their own profile without a hospital membership.
 */
export interface AppointmentBookingActorContext {
  readonly userId: string;
  readonly permissions?: ReadonlySet<string>;
  readonly roles?: readonly string[];
}

/** Lifecycle operations (reschedule, cancel) use the same verified caller shape. */
export type AppointmentActorContext = AppointmentBookingActorContext;

export interface CreateAppointmentBookingInput {
  readonly patientId: string;
  readonly doctorId: string;
  readonly branchId: string;
  /** Optional department; validated against the tenant when present. */
  readonly departmentId?: string | null;
  /** Absolute instant: a `Date` or an ISO 8601 string with an explicit offset. */
  readonly startAt: string | Date;
  /**
   * Consultation length override in minutes (5-480). When omitted the booked
   * window's configured `slot_duration_minutes` is used.
   */
  readonly durationMinutes?: number;
  /**
   * Booking channel. When omitted it is derived: `ONLINE` for a patient
   * booking their own profile, `RECEPTIONIST` for a staff booking.
   */
  readonly appointmentSource?: AppointmentSource;
  /** Defaults to `CONSULTATION`. */
  readonly appointmentType?: AppointmentType;
  readonly reason?: string | null;
  /** Private operational note; stored but never returned by this service. */
  readonly notes?: string | null;
  /** Client retry key (1-200 characters), reused verbatim on a retry. */
  readonly idempotencyKey?: string;
  /** Clock used to reject past slots; defaults to the current time. */
  readonly now?: Date;
}

/**
 * Safe booking result. Patient demographics, notes, storage keys and other
 * internal columns are deliberately absent.
 */
export interface AppointmentBookingDto {
  readonly id: string;
  readonly appointmentCode: string;
  readonly patientId: string;
  readonly doctorId: string;
  readonly branchId: string;
  readonly departmentId: string | null;
  readonly appointmentSource: AppointmentSource;
  readonly appointmentType: AppointmentType;
  readonly appointmentStatus: AppointmentStatus;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly durationMinutes: number;
  /** Resolved from the doctor-branch assignment; never from the request. */
  readonly consultationFee: string;
  readonly currency: string;
  /** IANA zone used to interpret the doctor's recurring schedule. */
  readonly branchTimezone: string;
  readonly reason: string | null;
  /** Set on a replacement appointment created by rescheduling. */
  readonly rescheduledFromAppointmentId: string | null;
  readonly cancelledBy: string | null;
  readonly cancellationReason: string | null;
  /** Phase 18.5 lifecycle instants; each is set with its status transition. */
  readonly checkedInAt: Date | null;
  readonly consultationStartedAt: Date | null;
  readonly completedAt: Date | null;
  readonly noShowAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** True when an idempotent retry returned an already committed booking. */
  readonly replayed: boolean;
}
