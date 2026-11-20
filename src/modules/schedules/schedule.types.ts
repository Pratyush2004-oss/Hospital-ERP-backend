/**
 * Doctor recurring schedule service types (Task 16.2).
 *
 * These are service inputs, not HTTP request schemas: transport validation and
 * Zod stay out of this phase. Times are branch-local wall-clock strings
 * (`HH:MM` or `HH:MM:SS`) and dates are ISO calendar dates (`YYYY-MM-DD`).
 */

export interface DoctorScheduleDoctorSummary {
  readonly id: string;
  readonly doctorCode: string;
  readonly fullName: string;
}

export interface DoctorScheduleBranchSummary {
  readonly id: string;
  readonly name: string;
  readonly branchCode: string;
  /** IANA zone that the wall-clock times are interpreted in. */
  readonly timezone: string;
}

export interface DoctorScheduleDto {
  readonly id: string;
  readonly doctorId: string;
  readonly branchId: string;
  /** ISO weekday: 1 = Monday ... 7 = Sunday, in branch-local time. */
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMinutes: number;
  readonly bufferMinutes: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly doctor: DoctorScheduleDoctorSummary;
  readonly branch: DoctorScheduleBranchSummary;
}

export type DoctorScheduleSortField =
  | "dayOfWeek"
  | "startTime"
  | "createdAt"
  | "updatedAt";

export interface ListDoctorSchedulesFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly doctorId?: string;
  readonly branchId?: string;
  readonly dayOfWeek?: number;
  readonly isActive?: boolean;
  /** Only windows effective on this calendar date (inclusive). */
  readonly effectiveOn?: string;
  readonly sortBy?: DoctorScheduleSortField;
  readonly sortOrder?: "asc" | "desc";
}

export interface DoctorScheduleListResult {
  readonly schedules: readonly DoctorScheduleDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface CreateDoctorScheduleInput {
  readonly doctorId: string;
  readonly branchId: string;
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  /** Consultation length in minutes; 5-480. Defaults to 15. */
  readonly slotDurationMinutes?: number;
  /** Pause after each slot; must be non-negative. Defaults to 0. */
  readonly bufferMinutes?: number;
  /** Defaults to today's date in the branch timezone. */
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
  readonly isActive?: boolean;
}

/**
 * Partial update of one recurring window. The doctor is immutable; moving a
 * window to another branch is allowed when the doctor is assigned there.
 */
export interface UpdateDoctorScheduleInput {
  readonly branchId?: string;
  readonly dayOfWeek?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly slotDurationMinutes?: number;
  readonly bufferMinutes?: number;
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
}
