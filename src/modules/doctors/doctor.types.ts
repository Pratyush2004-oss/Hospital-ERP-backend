/** Minimal user identity exposed on a doctor profile (never credentials). */
export interface DoctorUserSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly isActive: boolean;
}

/** Department a doctor covers. `branchId` is the department's home branch. */
export interface DoctorDepartmentSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly branchId: string;
  readonly isActive: boolean;
}

/** One doctor-branch assignment, including the fee charged at that branch. */
export interface DoctorBranchSummary {
  readonly id: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly branchCode: string;
  readonly branchIsActive: boolean;
  readonly consultationFee: string;
  readonly currency: string;
  readonly isActive: boolean;
}

/** Public doctor shape. Tenant id is implied by the caller's verified scope. */
export interface DoctorDto {
  readonly id: string;
  readonly userId: string;
  readonly doctorCode: string;
  readonly registrationNumber: string;
  readonly registrationCouncil: string | null;
  readonly qualification: string | null;
  readonly specialization: string | null;
  readonly experienceYears: number | null;
  readonly biography: string | null;
  readonly profileImageUrl: string | null;
  readonly consultationLanguage: readonly string[] | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user: DoctorUserSummary;
  readonly departments: readonly DoctorDepartmentSummary[];
  readonly branches: readonly DoctorBranchSummary[];
}

export type DoctorSortField =
  | "fullName"
  | "doctorCode"
  | "registrationNumber"
  | "createdAt"
  | "updatedAt";

export interface ListDoctorsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly departmentId?: string;
  readonly branchId?: string;
  readonly isActive?: boolean;
  readonly specialization?: string;
  readonly sortBy?: DoctorSortField;
  readonly sortOrder?: "asc" | "desc";
}

export interface DoctorListResult {
  readonly doctors: readonly DoctorDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

/**
 * An ACTIVE hospital member who holds the doctor role and has no live doctor
 * profile yet. This is the only membership state that can create a profile
 * under the ONB-07A invitation lifecycle.
 */
export interface EligibleDoctorMember {
  readonly userId: string;
  readonly membershipId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly joinedAt: Date | null;
  readonly branchIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly roles: readonly { id: string; slug: string; name: string }[];
}

export interface EligibleDoctorMemberFilters {
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface EligibleDoctorMemberListResult {
  readonly members: readonly EligibleDoctorMember[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

/** Input shape for one branch assignment. */
export interface DoctorBranchAssignmentInput {
  readonly branchId: string;
  /** Decimal string or number; stored as NUMERIC(12, 2). Defaults to "0.00". */
  readonly consultationFee?: string | number;
  /** ISO 4217 code. Defaults to the project's USD column default. */
  readonly currency?: string;
  readonly isActive?: boolean;
}

export interface CreateDoctorInput {
  /** Existing global user; a doctor profile never creates an account. */
  readonly userId: string;
  readonly doctorCode: string;
  readonly registrationNumber: string;
  readonly registrationCouncil?: string | null;
  readonly qualification?: string | null;
  readonly specialization?: string | null;
  readonly experienceYears?: number | null;
  readonly biography?: string | null;
  readonly profileImageUrl?: string | null;
  readonly consultationLanguage?: readonly string[] | null;
  readonly isActive?: boolean;
  readonly departmentIds?: readonly string[];
  readonly branches?: readonly DoctorBranchAssignmentInput[];
}

export interface UpdateDoctorInput {
  readonly doctorCode?: string;
  readonly registrationNumber?: string;
  readonly registrationCouncil?: string | null;
  readonly qualification?: string | null;
  readonly specialization?: string | null;
  readonly experienceYears?: number | null;
  readonly biography?: string | null;
  readonly profileImageUrl?: string | null;
  readonly consultationLanguage?: readonly string[] | null;
}
