/**
 * Appointment availability service types (Phase 18.2).
 *
 * These are service contracts, not HTTP schemas. Dates are ISO calendar dates
 * interpreted in the branch's IANA timezone; slot boundaries are absolute
 * `Date` instants backed by TIMESTAMPTZ appointment columns.
 */

export interface DoctorAvailabilityQuery {
  readonly doctorId: string;
  readonly branchId: string;
  /** Single day query (`YYYY-MM-DD`). Mutually exclusive with the range fields. */
  readonly date?: string;
  /** Inclusive range start (`YYYY-MM-DD`). */
  readonly fromDate?: string;
  /** Inclusive range end (`YYYY-MM-DD`). */
  readonly toDate?: string;
  /**
   * Consultation length override in minutes. When omitted, each working
   * window's configured `slot_duration_minutes` is used.
   */
  readonly durationMinutes?: number;
  /**
   * Clock used to exclude past slots. Defaults to the current time. Exposed so
   * tests (and later booking retries) can evaluate availability deterministically.
   */
  readonly now?: Date;
}

export interface GetAvailableSlotsInput {
  readonly doctorId: string;
  readonly branchId: string;
  readonly date: string;
  readonly durationMinutes?: number;
  readonly now?: Date;
}

export interface IsSlotAvailableInput {
  readonly doctorId: string;
  readonly branchId: string;
  /** Absolute start instant: a `Date` or ISO 8601 string with an offset. */
  readonly startAt: Date | string;
  readonly durationMinutes?: number;
  readonly now?: Date;
}

export interface AvailabilitySlot {
  readonly startAt: Date;
  readonly endAt: Date;
  readonly durationMinutes: number;
}

export interface AvailabilityDay {
  /** Branch-local calendar date the slots belong to. */
  readonly date: string;
  readonly slots: readonly AvailabilitySlot[];
}

export interface DoctorAvailabilityResult {
  readonly doctorId: string;
  readonly branchId: string;
  /** IANA zone used to interpret the doctor's recurring schedule. */
  readonly branchTimezone: string;
  readonly fromDate: string;
  readonly toDate: string;
  /** `null` means each window's configured slot duration was used. */
  readonly requestedDurationMinutes: number | null;
  /** Doctor-branch consultation fee, as returned by PostgreSQL NUMERIC. */
  readonly consultationFee: string;
  readonly currency: string;
  readonly days: readonly AvailabilityDay[];
}
