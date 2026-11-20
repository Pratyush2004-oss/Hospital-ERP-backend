/** Branch coverage shown on a department. Mirrors the branch summary fields. */
export interface DepartmentBranchSummary {
  readonly id: string;
  readonly name: string;
  readonly branchCode: string;
  readonly isActive: boolean;
}

/** Public department shape. `branchId` is the department's home branch. */
export interface DepartmentDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly branchId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Branches the department operates in, sorted by branch name. */
  readonly branches: readonly DepartmentBranchSummary[];
}

export type DepartmentSortField = "name" | "slug" | "createdAt" | "updatedAt";

export interface ListDepartmentsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly isActive?: boolean;
  readonly branchId?: string;
  readonly sortBy?: DepartmentSortField;
  readonly sortOrder?: "asc" | "desc";
  /** When false the branch summaries are not loaded. Defaults to true. */
  readonly includeBranches?: boolean;
}

export interface DepartmentListResult {
  readonly departments: readonly DepartmentDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface CreateDepartmentInput {
  readonly name: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
  /** Branches the department operates in. Defaults to the tenant's first branch. */
  readonly branchIds?: readonly string[];
}

export interface UpdateDepartmentInput {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
  /** When supplied, replaces the department's branch associations. */
  readonly branchIds?: readonly string[];
}
