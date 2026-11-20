/**
 * Doctor leave service types (Task 16.4).
 *
 * Service inputs and outputs only: HTTP transport schemas, routes and
 * controllers are deliberately out of scope. `startAt`/`endAt` accept an ISO
 * 8601 timestamp with an explicit offset (`Z` or `±HH:MM`) so an absence is
 * always an absolute instant, never an ambiguous local wall-clock value.
 */

export type DoctorLeaveStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface DoctorLeaveDoctorSummary {
  readonly id: string;
  readonly doctorCode: string;
  readonly fullName: string;
  readonly isActive: boolean;
}

export interface DoctorLeaveBranchSummary {
  readonly id: string;
  readonly name: string;
  readonly branchCode: string;
  readonly timezone: string;
}

/** Minimal user identity; never exposes email, phone or credential columns. */
export interface DoctorLeaveUserSummary {
  readonly id: string;
  readonly fullName: string;
}

export interface DoctorLeaveDto {
  readonly id: string;
  readonly doctorId: string;
  /** `null` means the absence applies to every branch. */
  readonly branchId: string | null;
  readonly isAllBranches: boolean;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason: string | null;
  readonly status: DoctorLeaveStatus;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly doctor: DoctorLeaveDoctorSummary;
  readonly branch: DoctorLeaveBranchSummary | null;
  readonly requestedBy: DoctorLeaveUserSummary;
  readonly approvedByUser: DoctorLeaveUserSummary | null;
  readonly rejectedByUser: DoctorLeaveUserSummary | null;
}

/**
 * Verified caller identity. `userId` must come from the authenticated request
 * context, never from a request body. `permissions` is the resolved RBAC set and
 * `roles` the hospital role slugs; both are optional so internal/test callers
 * can represent a plain doctor who only acts on their own profile.
 */
export interface DoctorLeaveActorContext {
  readonly userId: string;
  readonly permissions?: ReadonlySet<string>;
  readonly roles?: readonly string[];
}

export interface CreateDoctorLeaveInput {
  readonly doctorId: string;
  /** Omit or pass `null` for leave that affects all branches. */
  readonly branchId?: string | null;
  /** ISO 8601 timestamp with an explicit offset. */
  readonly startAt: string | Date;
  readonly endAt: string | Date;
  readonly reason?: string | null;
}

/**
 * Partial update of a PENDING request. Omitting `branchId` keeps the current
 * scope; passing `null` widens it to all branches.
 */
export interface UpdateDoctorLeaveInput {
  readonly branchId?: string | null;
  readonly startAt?: string | Date;
  readonly endAt?: string | Date;
  readonly reason?: string | null;
}

export type DoctorLeaveSortField = "startAt" | "endAt" | "createdAt" | "status";

export interface ListDoctorLeavesFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly doctorId?: string;
  readonly branchId?: string;
  /** When true, only leave with `branch_id IS NULL` is returned. */
  readonly allBranches?: boolean;
  readonly status?: DoctorLeaveStatus;
  /** ISO calendar date; leaves ending on or after its UTC midnight. */
  readonly startDate?: string;
  /** ISO calendar date; leaves starting before the following UTC midnight. */
  readonly endDate?: string;
  readonly sortBy?: DoctorLeaveSortField;
  readonly sortOrder?: "asc" | "desc";
}

export interface DoctorLeaveListResult {
  readonly leaves: readonly DoctorLeaveDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}
