/**
 * Doctor break service types (Task 16.3).
 *
 * Breaks are recurring pauses inside one weekly schedule window. Times are
 * branch-local wall-clock strings shared with the parent schedule; no UTC
 * conversion is performed here.
 */

/** Parent window context returned with every break. */
export interface DoctorBreakScheduleSummary {
  readonly id: string;
  readonly doctorId: string;
  readonly branchId: string;
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMinutes: number;
  readonly bufferMinutes: number;
  readonly isActive: boolean;
  readonly doctorCode: string;
  readonly doctorFullName: string;
  readonly branchName: string;
  readonly branchCode: string;
  /** IANA zone in which the break times are interpreted. */
  readonly timezone: string;
}

export interface DoctorBreakDto {
  readonly id: string;
  readonly scheduleId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly schedule: DoctorBreakScheduleSummary;
}

export interface DoctorBreakListFilters {
  readonly scheduleId?: string;
  readonly doctorId?: string;
  readonly branchId?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DoctorBreakListResult {
  readonly breaks: readonly DoctorBreakDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface CreateDoctorBreakInput {
  readonly scheduleId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly reason?: string | null;
}

/** Partial update; null clears the reason. */
export interface UpdateDoctorBreakInput {
  readonly startTime?: string;
  readonly endTime?: string;
  readonly reason?: string | null;
}
