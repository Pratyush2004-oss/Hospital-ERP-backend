/** Public branch shape. Contact columns are named email/phone in the database. */
export interface BranchDto {
  readonly id: string;
  readonly name: string;
  readonly branchCode: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BranchListResult {
  readonly branches: readonly BranchDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
