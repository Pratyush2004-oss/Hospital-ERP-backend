import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  branches,
  departmentBranches,
  departments,
  doctorBranches,
  doctorDepartments,
  doctorSchedules,
  doctors,
  membershipRoles,
  roles,
  tenantMemberships,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import type {
  CreateDoctorInput,
  DoctorBranchAssignmentInput,
  DoctorBranchSummary,
  DoctorDepartmentSummary,
  DoctorDto,
  DoctorListResult,
  DoctorSortField,
  EligibleDoctorMemberFilters,
  EligibleDoctorMemberListResult,
  ListDoctorsFilters,
  UpdateDoctorInput,
} from "./doctor.types.js";

/**
 * Doctor management service (Task 15.2).
 *
 * Business rules:
 * - A doctor profile is tenant-owned and always linked to an existing global
 *   user. This service never creates accounts or invitations.
 * - The user must hold an ACTIVE `tenant_memberships` row for this hospital and
 *   their global account must be active.
 * - `doctor_code` is normalised to upper case and is unique per tenant for the
 *   lifetime of the tenant: soft-deleted codes stay reserved (see Task 15.1).
 * - A doctor may only work at a branch where at least one of their assigned
 *   departments operates (`department_branches`). Branch-only profiles are
 *   allowed while the doctor has no department assignments, which keeps
 *   department-independent OPD doctors possible; once a department is assigned,
 *   branch coverage becomes mandatory.
 * - All reads and writes are tenant-scoped in SQL and additionally protected by
 *   the RLS transaction context.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_CURRENCY = "USD";
const DOCTOR_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,49}$/;
const REGISTRATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{2,79}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const MAX_LANGUAGES = 20;

interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** Drizzle wraps driver errors, so walk the `cause` chain for SQLSTATE data. */
function pgErrorInfo(error: unknown): PgErrorInfo {
  const info: { code?: string; constraint?: string } = {};
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (info.code === undefined && typeof candidate.code === "string") {
      info.code = candidate.code;
    }
    if (info.constraint === undefined && typeof candidate.constraint === "string") {
      info.constraint = candidate.constraint;
    }

    current = candidate.cause;
  }

  return info;
}

/**
 * Translates database constraint violations into safe application errors.
 * Anything that is not a recognised SQLSTATE is rethrown unchanged.
 */
function mapDoctorWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23505") {
    if (constraint === "doctors_tenant_user_unique") {
      throw AppError.conflict("This user already has a doctor profile in this hospital");
    }
    if (constraint === "doctors_tenant_code_unique") {
      throw AppError.conflict("A doctor with this code already exists in this hospital");
    }
    if (constraint === "doctors_tenant_registration_unique") {
      throw AppError.conflict(
        "A doctor with this registration number already exists in this hospital",
      );
    }
    if (
      constraint === "doctor_departments_unique" ||
      constraint === "doctor_branches_doctor_branch_unique"
    ) {
      throw AppError.conflict("This assignment already exists");
    }

    throw AppError.conflict("A doctor with these details already exists in this hospital");
  }

  if (code === "23514") {
    throw AppError.validation("Doctor data violates a database constraint");
  }

  if (code === "23503") {
    throw AppError.badRequest(
      "A referenced department, branch or user does not belong to this hospital",
    );
  }

  throw error;
}

function normalizeDoctorCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-");

  if (!DOCTOR_CODE_PATTERN.test(code)) {
    throw AppError.validation(
      "Doctor code must be 1-50 characters using letters, digits, dots, hyphens or underscores",
    );
  }

  return code;
}

function normalizeRegistrationNumber(value: string): string {
  const registrationNumber = value.trim();

  if (!REGISTRATION_PATTERN.test(registrationNumber)) {
    throw AppError.validation("Enter a valid medical registration number");
  }

  return registrationNumber;
}

function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  if (trimmed.length === 0) return null;

  if (trimmed.length > maxLength) {
    throw AppError.validation(`${field} must be at most ${maxLength} characters`);
  }

  return trimmed;
}

function normalizeExperienceYears(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  if (!Number.isInteger(value) || value < 0 || value > 70) {
    throw AppError.validation("Experience years must be an integer between 0 and 70");
  }

  return value;
}

function normalizeProfileImageUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  if (trimmed.length === 0) return null;

  if (trimmed.length > 2048) {
    throw AppError.validation("Profile image URL must be at most 2048 characters");
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw AppError.validation("Profile image URL must be an absolute http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw AppError.validation("Profile image URL must be an absolute http(s) URL");
  }

  return trimmed;
}

function normalizeLanguages(value: readonly string[] | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;

  const languages = [...new Set(value.map((item) => item.trim().toLowerCase()))].filter(
    (item) => item.length > 0,
  );

  if (languages.length === 0) return null;

  if (languages.length > MAX_LANGUAGES) {
    throw AppError.validation(`At most ${MAX_LANGUAGES} consultation languages are allowed`);
  }

  const invalid = languages.filter((item) => !LANGUAGE_PATTERN.test(item));

  if (invalid.length > 0) {
    throw AppError.validation(
      'Consultation languages must be language codes such as "en" or "pt-BR"',
      { languages: invalid },
    );
  }

  return languages;
}

/**
 * Money stays a decimal string end to end so no floating-point rounding can
 * occur. `NUMERIC(12, 2)` allows at most 10 integer digits and 2 decimals.
 */
function normalizeConsultationFee(value: string | number | undefined): string {
  if (value === undefined) return "0.00";

  const text = typeof value === "number" ? String(value) : value.trim();

  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw AppError.validation(
      "Consultation fee must be a non-negative amount with at most two decimal places",
    );
  }

  const [whole, fraction = ""] = text.split(".");

  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
}

function normalizeCurrency(value: string | undefined): string {
  if (value === undefined) return DEFAULT_CURRENCY;

  const currency = value.trim().toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw AppError.validation("Currency must be a three-letter ISO 4217 code");
  }

  return currency;
}

function normalizeBranchAssignments(
  assignments: readonly DoctorBranchAssignmentInput[],
): NormalizedBranchAssignment[] {
  const byBranch = new Map<string, NormalizedBranchAssignment>();

  for (const assignment of assignments) {
    // Last entry wins when a branch is listed twice; duplicates never reach SQL.
    byBranch.set(assignment.branchId, {
      branchId: assignment.branchId,
      consultationFee: normalizeConsultationFee(assignment.consultationFee),
      currency: normalizeCurrency(assignment.currency),
      isActive: assignment.isActive ?? true,
    });
  }

  return [...byBranch.values()];
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return [];

  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

interface NormalizedBranchAssignment {
  readonly branchId: string;
  readonly consultationFee: string;
  readonly currency: string;
  readonly isActive: boolean;
}

const doctorSelection = {
  id: doctors.id,
  userId: doctors.userId,
  doctorCode: doctors.doctorCode,
  registrationNumber: doctors.registrationNumber,
  registrationCouncil: doctors.registrationCouncil,
  qualification: doctors.qualification,
  specialization: doctors.specialization,
  experienceYears: doctors.experienceYears,
  biography: doctors.biography,
  profileImageUrl: doctors.profileImageUrl,
  consultationLanguage: doctors.consultationLanguage,
  isActive: doctors.isActive,
  createdAt: doctors.createdAt,
  updatedAt: doctors.updatedAt,
  userFullName: users.fullName,
  userEmail: users.email,
  userPhone: users.phone,
  userIsActive: users.isActive,
};

interface DoctorRow {
  id: string;
  userId: string;
  doctorCode: string;
  registrationNumber: string;
  registrationCouncil: string | null;
  qualification: string | null;
  specialization: string | null;
  experienceYears: number | null;
  biography: string | null;
  profileImageUrl: string | null;
  consultationLanguage: string[] | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userFullName: string;
  userEmail: string;
  userPhone: string | null;
  userIsActive: boolean;
}

function toDto(
  row: DoctorRow,
  departmentRows: readonly DoctorDepartmentSummary[],
  branchRows: readonly DoctorBranchSummary[],
): DoctorDto {
  return {
    id: row.id,
    userId: row.userId,
    doctorCode: row.doctorCode,
    registrationNumber: row.registrationNumber,
    registrationCouncil: row.registrationCouncil,
    qualification: row.qualification,
    specialization: row.specialization,
    experienceYears: row.experienceYears,
    biography: row.biography,
    profileImageUrl: row.profileImageUrl,
    consultationLanguage: row.consultationLanguage,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Only display identity leaves the service; never password hashes or tokens.
    user: {
      id: row.userId,
      fullName: row.userFullName,
      email: row.userEmail,
      phone: row.userPhone,
      isActive: row.userIsActive,
    },
    departments: departmentRows,
    branches: branchRows,
  };
}

async function findLiveDoctor(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
): Promise<DoctorRow> {
  const [row] = await tx
    .select(doctorSelection)
    .from(doctors)
    .innerJoin(users, eq(users.id, doctors.userId))
    .where(
      and(
        eq(doctors.id, doctorId),
        eq(doctors.tenantId, tenantId),
        isNull(doctors.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Doctor not found");

  return row;
}

async function loadDepartments(
  tx: DbExecutor,
  tenantId: string,
  doctorIds: readonly string[],
): Promise<Map<string, DoctorDepartmentSummary[]>> {
  const grouped = new Map<string, DoctorDepartmentSummary[]>();
  if (doctorIds.length === 0) return grouped;

  const rows = await tx
    .select({
      doctorId: doctorDepartments.doctorId,
      id: departments.id,
      name: departments.name,
      slug: departments.slug,
      branchId: departments.branchId,
      isActive: departments.isActive,
    })
    .from(doctorDepartments)
    .innerJoin(
      departments,
      and(
        eq(departments.id, doctorDepartments.departmentId),
        eq(departments.tenantId, doctorDepartments.tenantId),
      ),
    )
    .where(
      and(
        eq(doctorDepartments.tenantId, tenantId),
        inArray(doctorDepartments.doctorId, [...doctorIds]),
      ),
    )
    .orderBy(asc(departments.name), asc(departments.id));

  for (const row of rows) {
    const list = grouped.get(row.doctorId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      branchId: row.branchId,
      isActive: row.isActive,
    });
    grouped.set(row.doctorId, list);
  }

  return grouped;
}

async function loadBranches(
  tx: DbExecutor,
  tenantId: string,
  doctorIds: readonly string[],
): Promise<Map<string, DoctorBranchSummary[]>> {
  const grouped = new Map<string, DoctorBranchSummary[]>();
  if (doctorIds.length === 0) return grouped;

  const rows = await tx
    .select({
      doctorId: doctorBranches.doctorId,
      id: doctorBranches.id,
      branchId: doctorBranches.branchId,
      branchName: branches.name,
      branchCode: branches.branchCode,
      branchIsActive: branches.isActive,
      consultationFee: doctorBranches.consultationFee,
      currency: doctorBranches.currency,
      isActive: doctorBranches.isActive,
    })
    .from(doctorBranches)
    .innerJoin(
      branches,
      and(
        eq(branches.id, doctorBranches.branchId),
        eq(branches.tenantId, doctorBranches.tenantId),
      ),
    )
    .where(
      and(
        eq(doctorBranches.tenantId, tenantId),
        inArray(doctorBranches.doctorId, [...doctorIds]),
      ),
    )
    .orderBy(asc(branches.name), asc(doctorBranches.branchId));

  for (const row of rows) {
    const list = grouped.get(row.doctorId) ?? [];
    list.push({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branchName,
      branchCode: row.branchCode,
      branchIsActive: row.branchIsActive,
      consultationFee: row.consultationFee,
      currency: row.currency,
      isActive: row.isActive,
    });
    grouped.set(row.doctorId, list);
  }

  return grouped;
}

async function loadDoctor(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
): Promise<DoctorDto> {
  const row = await findLiveDoctor(tx, tenantId, doctorId);
  const [departmentRows, branchRows] = await Promise.all([
    loadDepartments(tx, tenantId, [row.id]),
    loadBranches(tx, tenantId, [row.id]),
  ]);

  return toDto(row, departmentRows.get(row.id) ?? [], branchRows.get(row.id) ?? []);
}

/**
 * A doctor profile may only be attached to an existing, active global user who
 * is an ACTIVE member of this hospital. INVITED, SUSPENDED and REMOVED
 * memberships are not eligible.
 */
async function assertUserEligibleForDoctor(
  tx: DbExecutor,
  tenantId: string,
  userId: string,
): Promise<void> {
  const [user] = await tx
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw AppError.notFound("User not found");

  if (!user.isActive) {
    throw AppError.badRequest("This user account is inactive");
  }

  const [membership] = await tx
    .select({ id: tenantMemberships.id, status: tenantMemberships.status })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw AppError.badRequest("User does not belong to this hospital");
  }

  if (membership.status !== "ACTIVE") {
    throw AppError.badRequest(
      `User membership must be ACTIVE before a doctor profile can be created (current: ${membership.status})`,
    );
  }

  const [doctorRole] = await tx
    .select({ id: roles.id })
    .from(membershipRoles)
    .innerJoin(
      roles,
      and(
        eq(roles.id, membershipRoles.roleId),
        eq(roles.tenantId, membershipRoles.tenantId),
      ),
    )
    .where(
      and(
        eq(membershipRoles.tenantId, tenantId),
        eq(membershipRoles.tenantMembershipId, membership.id),
        eq(roles.scope, "HOSPITAL"),
        eq(roles.slug, "doctor"),
      ),
    )
    .limit(1);

  if (!doctorRole) {
    throw AppError.badRequest(
      "User must have the doctor role before a doctor profile can be created",
    );
  }
}

async function assertDepartmentsAssignable(
  tx: DbExecutor,
  tenantId: string,
  departmentIds: readonly string[],
): Promise<void> {
  if (departmentIds.length === 0) return;

  const rows = await tx
    .select({ id: departments.id, isActive: departments.isActive, deletedAt: departments.deletedAt })
    .from(departments)
    .where(
      and(eq(departments.tenantId, tenantId), inArray(departments.id, [...departmentIds])),
    );

  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = departmentIds.filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw AppError.badRequest("One or more departments do not belong to this hospital", {
      departmentIds: missing,
    });
  }

  const unavailable = departmentIds.filter((id) => {
    const row = found.get(id);
    return row !== undefined && (row.deletedAt !== null || !row.isActive);
  });

  if (unavailable.length > 0) {
    throw AppError.unprocessable("One or more departments are inactive or deleted", {
      departmentIds: unavailable,
    });
  }
}

async function assertBranchesAssignable(
  tx: DbExecutor,
  tenantId: string,
  branchIds: readonly string[],
): Promise<void> {
  if (branchIds.length === 0) return;

  const rows = await tx
    .select({ id: branches.id, isActive: branches.isActive, deletedAt: branches.deletedAt })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, [...branchIds])));

  const found = new Map(rows.map((row) => [row.id, row]));

  const missing = branchIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw AppError.badRequest("One or more branches do not belong to this hospital", {
      branchIds: missing,
    });
  }

  const unavailable = branchIds.filter((id) => {
    const row = found.get(id);
    return row !== undefined && (row.deletedAt !== null || !row.isActive);
  });

  if (unavailable.length > 0) {
    throw AppError.unprocessable("One or more branches are inactive or deleted", {
      branchIds: unavailable,
    });
  }
}

/**
 * Enforces the doctor-department-branch rule: with department assignments in
 * place, every branch must be covered by at least one of those departments
 * (`department_branches`). A doctor without departments may hold branch-only
 * assignments (department-independent OPD).
 */
async function assertBranchCoverage(
  tx: DbExecutor,
  tenantId: string,
  departmentIds: readonly string[],
  branchIds: readonly string[],
): Promise<void> {
  if (departmentIds.length === 0 || branchIds.length === 0) return;

  const rows = await tx
    .select({ branchId: departmentBranches.branchId })
    .from(departmentBranches)
    .where(
      and(
        eq(departmentBranches.tenantId, tenantId),
        inArray(departmentBranches.departmentId, [...departmentIds]),
        inArray(departmentBranches.branchId, [...branchIds]),
      ),
    );

  const covered = new Set(rows.map((row) => row.branchId));
  const uncovered = branchIds.filter((id) => !covered.has(id));

  if (uncovered.length > 0) {
    throw AppError.unprocessable(
      "A doctor can only be assigned to branches where one of their departments operates",
      { branchIds: uncovered },
    );
  }
}

async function assertDoctorCodeAvailable(
  tx: DbExecutor,
  tenantId: string,
  doctorCode: string,
  excludeDoctorId?: string,
): Promise<void> {
  // Soft-deleted profiles keep their code reserved, so no `deleted_at` filter.
  const [existing] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(
      and(
        eq(doctors.tenantId, tenantId),
        eq(doctors.doctorCode, doctorCode),
        excludeDoctorId === undefined ? undefined : ne(doctors.id, excludeDoctorId),
      ),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict("A doctor with this code already exists in this hospital");
  }
}

async function assertRegistrationNumberAvailable(
  tx: DbExecutor,
  tenantId: string,
  registrationNumber: string,
  excludeDoctorId?: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(
      and(
        eq(doctors.tenantId, tenantId),
        eq(doctors.registrationNumber, registrationNumber),
        excludeDoctorId === undefined ? undefined : ne(doctors.id, excludeDoctorId),
      ),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict(
      "A doctor with this registration number already exists in this hospital",
    );
  }
}

async function replaceDepartmentAssignments(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  departmentIds: readonly string[],
): Promise<void> {
  await tx
    .delete(doctorDepartments)
    .where(
      and(
        eq(doctorDepartments.tenantId, tenantId),
        eq(doctorDepartments.doctorId, doctorId),
      ),
    );

  if (departmentIds.length === 0) return;

  await tx
    .insert(doctorDepartments)
    .values(departmentIds.map((departmentId) => ({ tenantId, doctorId, departmentId })))
    .onConflictDoNothing();
}

async function replaceBranchAssignments(
  tx: DbExecutor,
  tenantId: string,
  doctorId: string,
  assignments: readonly NormalizedBranchAssignment[],
): Promise<void> {
  await tx
    .delete(doctorBranches)
    .where(
      and(eq(doctorBranches.tenantId, tenantId), eq(doctorBranches.doctorId, doctorId)),
    );

  if (assignments.length === 0) return;

  await tx.insert(doctorBranches).values(
    assignments.map((assignment) => ({
      tenantId,
      doctorId,
      branchId: assignment.branchId,
      consultationFee: assignment.consultationFee,
      currency: assignment.currency,
      isActive: assignment.isActive,
    })),
  );
}

/**
 * Creates a doctor profile with its initial department and branch assignments
 * atomically. The global account must already exist and be an active member of
 * this hospital; no user account or invitation is created here.
 */
export async function createDoctor(
  tenantId: string,
  input: CreateDoctorInput,
): Promise<DoctorDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertUserEligibleForDoctor(tx, tenantId, input.userId);

      const doctorCode = normalizeDoctorCode(input.doctorCode);
      const registrationNumber = normalizeRegistrationNumber(input.registrationNumber);
      const departmentIds = uniqueIds(input.departmentIds);
      const branchAssignments = normalizeBranchAssignments(input.branches ?? []);

      await assertDoctorCodeAvailable(tx, tenantId, doctorCode);
      await assertRegistrationNumberAvailable(tx, tenantId, registrationNumber);
      await assertDepartmentsAssignable(tx, tenantId, departmentIds);
      await assertBranchesAssignable(
        tx,
        tenantId,
        branchAssignments.map((assignment) => assignment.branchId),
      );
      await assertBranchCoverage(
        tx,
        tenantId,
        departmentIds,
        branchAssignments.map((assignment) => assignment.branchId),
      );

      const [created] = await tx
        .insert(doctors)
        .values({
          tenantId,
          userId: input.userId,
          doctorCode,
          registrationNumber,
          registrationCouncil: normalizeOptionalText(
            input.registrationCouncil,
            "Registration council",
            150,
          ),
          qualification: normalizeOptionalText(input.qualification, "Qualification", 200),
          specialization: normalizeOptionalText(input.specialization, "Specialization", 150),
          experienceYears: normalizeExperienceYears(input.experienceYears),
          biography: normalizeOptionalText(input.biography, "Biography", 5000),
          profileImageUrl: normalizeProfileImageUrl(input.profileImageUrl),
          consultationLanguage: normalizeLanguages(input.consultationLanguage),
          isActive: input.isActive ?? true,
        })
        .returning({ id: doctors.id });

      if (!created) throw AppError.internal("Failed to create doctor");

      await replaceDepartmentAssignments(tx, tenantId, created.id, departmentIds);
      await replaceBranchAssignments(tx, tenantId, created.id, branchAssignments);

      const doctor = await loadDoctor(tx, tenantId, created.id);

      await recordAuditSafely(tx, {
        tenantId,
        action: AUDIT_ACTIONS.DOCTOR_CREATED,
        module: "doctors",
        resourceType: "doctor",
        resourceId: doctor.id,
        description: "Doctor profile created",
        metadata: {
          userId: doctor.userId,
          doctorCode: doctor.doctorCode,
          departmentIds,
          branchIds: branchAssignments.map((assignment) => assignment.branchId),
        },
      });

      return doctor;
    });
  } catch (error) {
    mapDoctorWriteError(error);
  }
}

/**
 * Members the Add Doctor workflow can attach a profile to: ACTIVE membership,
 * active global account, doctor role, and no existing doctor row (including a
 * soft-deleted row, because the tenant/user uniqueness constraint still reserves
 * that membership).
 */
export async function listEligibleDoctorMembers(
  tenantId: string,
  filters: EligibleDoctorMemberFilters = {},
): Promise<EligibleDoctorMemberListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [
      eq(tenantMemberships.tenantId, tenantId),
      eq(tenantMemberships.status, "ACTIVE"),
      eq(users.isActive, true),
      exists(
        tx
          .select({ one: sql`1` })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(
              eq(roles.id, membershipRoles.roleId),
              eq(roles.tenantId, membershipRoles.tenantId),
            ),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.tenantMembershipId, tenantMemberships.id),
              eq(roles.scope, "HOSPITAL"),
              eq(roles.slug, "doctor"),
            ),
          ),
      ),
      notExists(
        tx
          .select({ one: sql`1` })
          .from(doctors)
          .where(
            and(
              eq(doctors.tenantId, tenantId),
              eq(doctors.userId, tenantMemberships.userId),
            ),
          ),
      ),
    ];

    if (filters.search) {
      const pattern = `%${filters.search.trim()}%`;
      const searchClause = or(ilike(users.fullName, pattern), ilike(users.email, pattern));
      if (searchClause) conditions.push(searchClause);
    }

    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      tx
        .select({
          userId: users.id,
          membershipId: tenantMemberships.id,
          fullName: users.fullName,
          email: users.email,
          phone: users.phone,
          joinedAt: tenantMemberships.joinedAt,
          branchIds: tenantMemberships.branchIds,
          departmentIds: tenantMemberships.departmentIds,
        })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .where(where)
        .orderBy(asc(users.fullName), asc(tenantMemberships.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .where(where),
    ]);

    const membershipIds = rows.map((row) => row.membershipId);
    const grants = membershipIds.length
      ? await tx
          .select({
            membershipId: membershipRoles.tenantMembershipId,
            id: roles.id,
            slug: roles.slug,
            name: roles.name,
          })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(
              eq(roles.id, membershipRoles.roleId),
              eq(roles.tenantId, membershipRoles.tenantId),
            ),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              inArray(membershipRoles.tenantMembershipId, membershipIds),
            ),
          )
          .orderBy(asc(roles.name))
      : [];

    const rolesByMembership = new Map<
      string,
      { id: string; slug: string; name: string }[]
    >();

    for (const grant of grants) {
      const list = rolesByMembership.get(grant.membershipId) ?? [];
      list.push({ id: grant.id, slug: grant.slug, name: grant.name });
      rolesByMembership.set(grant.membershipId, list);
    }

    const total = totals[0]?.total ?? 0;

    return {
      members: rows.map((row) => ({
        ...row,
        roles: rolesByMembership.get(row.membershipId) ?? [],
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function listDoctors(
  tenantId: string,
  filters: ListDoctorsFilters = {},
): Promise<DoctorListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(doctors.tenantId, tenantId), isNull(doctors.deletedAt)];

    if (filters.isActive !== undefined) {
      conditions.push(eq(doctors.isActive, filters.isActive));
    }

    if (filters.search) {
      const pattern = `%${filters.search.trim()}%`;
      const searchClause = or(
        ilike(users.fullName, pattern),
        ilike(doctors.doctorCode, pattern),
        ilike(doctors.registrationNumber, pattern),
      );
      if (searchClause) conditions.push(searchClause);
    }

    if (filters.specialization) {
      // ilike without wildcards is a case-insensitive equality check.
      conditions.push(ilike(doctors.specialization, filters.specialization.trim()));
    }

    if (filters.departmentId) {
      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(doctorDepartments)
            .where(
              and(
                eq(doctorDepartments.tenantId, tenantId),
                eq(doctorDepartments.doctorId, doctors.id),
                eq(doctorDepartments.departmentId, filters.departmentId),
              ),
            ),
        ),
      );
    }

    if (filters.branchId) {
      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(doctorBranches)
            .where(
              and(
                eq(doctorBranches.tenantId, tenantId),
                eq(doctorBranches.doctorId, doctors.id),
                eq(doctorBranches.branchId, filters.branchId),
              ),
            ),
        ),
      );
    }

    const where = and(...conditions);
    const sortColumns: Record<DoctorSortField, typeof doctors.doctorCode | typeof users.fullName | typeof doctors.createdAt | typeof doctors.updatedAt | typeof doctors.registrationNumber> = {
      fullName: users.fullName,
      doctorCode: doctors.doctorCode,
      registrationNumber: doctors.registrationNumber,
      createdAt: doctors.createdAt,
      updatedAt: doctors.updatedAt,
    };
    const sortColumn = sortColumns[filters.sortBy ?? "fullName"];
    const direction = filters.sortOrder ?? "asc";

    const [rows, totals] = await Promise.all([
      tx
        .select(doctorSelection)
        .from(doctors)
        .innerJoin(users, eq(users.id, doctors.userId))
        .where(where)
        .orderBy(direction === "desc" ? desc(sortColumn) : asc(sortColumn), asc(doctors.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(doctors)
        .innerJoin(users, eq(users.id, doctors.userId))
        .where(where),
    ]);

    const doctorIds = rows.map((row) => row.id);
    const [departmentRows, branchRows] = await Promise.all([
      loadDepartments(tx, tenantId, doctorIds),
      loadBranches(tx, tenantId, doctorIds),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      doctors: rows.map((row) =>
        toDto(row, departmentRows.get(row.id) ?? [], branchRows.get(row.id) ?? []),
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function getDoctorById(
  tenantId: string,
  doctorId: string,
): Promise<DoctorDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    loadDoctor(tx, tenantId, doctorId),
  );
}

export async function updateDoctor(
  tenantId: string,
  doctorId: string,
  input: UpdateDoctorInput,
): Promise<DoctorDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findLiveDoctor(tx, tenantId, doctorId);
      const patch: Partial<typeof doctors.$inferInsert> = {};

      if (input.doctorCode !== undefined) {
        const doctorCode = normalizeDoctorCode(input.doctorCode);

        if (doctorCode !== current.doctorCode) {
          await assertDoctorCodeAvailable(tx, tenantId, doctorCode, doctorId);
        }

        patch.doctorCode = doctorCode;
      }

      if (input.registrationNumber !== undefined) {
        const registrationNumber = normalizeRegistrationNumber(input.registrationNumber);

        if (registrationNumber !== current.registrationNumber) {
          await assertRegistrationNumberAvailable(tx, tenantId, registrationNumber, doctorId);
        }

        patch.registrationNumber = registrationNumber;
      }

      if (input.registrationCouncil !== undefined) {
        patch.registrationCouncil = normalizeOptionalText(
          input.registrationCouncil,
          "Registration council",
          150,
        );
      }

      if (input.qualification !== undefined) {
        patch.qualification = normalizeOptionalText(input.qualification, "Qualification", 200);
      }

      if (input.specialization !== undefined) {
        patch.specialization = normalizeOptionalText(
          input.specialization,
          "Specialization",
          150,
        );
      }

      if (input.experienceYears !== undefined) {
        patch.experienceYears = normalizeExperienceYears(input.experienceYears);
      }

      if (input.biography !== undefined) {
        patch.biography = normalizeOptionalText(input.biography, "Biography", 5000);
      }

      if (input.profileImageUrl !== undefined) {
        patch.profileImageUrl = normalizeProfileImageUrl(input.profileImageUrl);
      }

      if (input.consultationLanguage !== undefined) {
        patch.consultationLanguage = normalizeLanguages(input.consultationLanguage);
      }

      if (Object.keys(patch).length > 0) {
        await tx
          .update(doctors)
          .set(patch)
          .where(
            and(
              eq(doctors.id, doctorId),
              eq(doctors.tenantId, tenantId),
              isNull(doctors.deletedAt),
            ),
          );
      }

      const doctor = await loadDoctor(tx, tenantId, doctorId);

      await recordAuditSafely(tx, {
        tenantId,
        action: AUDIT_ACTIONS.DOCTOR_UPDATED,
        module: "doctors",
        resourceType: "doctor",
        resourceId: doctor.id,
        description: "Doctor profile updated",
        metadata: { changedFields: Object.keys(patch) },
        previousState: { doctorCode: current.doctorCode, isActive: current.isActive },
        newState: { doctorCode: doctor.doctorCode, isActive: doctor.isActive },
      });

      return doctor;
    });
  } catch (error) {
    mapDoctorWriteError(error);
  }
}

/**
 * Replaces the doctor's department coverage atomically. Every branch the doctor
 * already works at must remain covered by the new department set.
 */
export async function updateDoctorDepartments(
  tenantId: string,
  doctorId: string,
  departmentIds: readonly string[],
): Promise<DoctorDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await findLiveDoctor(tx, tenantId, doctorId);

      const normalized = uniqueIds(departmentIds);
      await assertDepartmentsAssignable(tx, tenantId, normalized);

      const existingBranches = await tx
        .select({ branchId: doctorBranches.branchId })
        .from(doctorBranches)
        .where(
          and(
            eq(doctorBranches.tenantId, tenantId),
            eq(doctorBranches.doctorId, doctorId),
          ),
        );

      await assertBranchCoverage(
        tx,
        tenantId,
        normalized,
        existingBranches.map((row) => row.branchId),
      );

      await replaceDepartmentAssignments(tx, tenantId, doctorId, normalized);

      const doctor = await loadDoctor(tx, tenantId, doctorId);

      await recordAuditSafely(tx, {
        tenantId,
        action: AUDIT_ACTIONS.DOCTOR_ASSIGNMENTS_CHANGED,
        module: "doctors",
        resourceType: "doctor",
        resourceId: doctorId,
        description: "Doctor department assignments replaced",
        metadata: { departmentIds: normalized },
      });

      return doctor;
    });
  } catch (error) {
    mapDoctorWriteError(error);
  }
}

/**
 * Replaces the doctor's branch assignments atomically. The doctor must have at
 * least one department operating at each branch (once departments are set).
 */
export async function updateDoctorBranches(
  tenantId: string,
  doctorId: string,
  branchAssignments: readonly DoctorBranchAssignmentInput[],
): Promise<DoctorDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await findLiveDoctor(tx, tenantId, doctorId);

      const assignments = normalizeBranchAssignments(branchAssignments);
      const branchIds = assignments.map((assignment) => assignment.branchId);

      await assertBranchesAssignable(tx, tenantId, branchIds);

      const departmentRows = await tx
        .select({ departmentId: doctorDepartments.departmentId })
        .from(doctorDepartments)
        .where(
          and(
            eq(doctorDepartments.tenantId, tenantId),
            eq(doctorDepartments.doctorId, doctorId),
          ),
        );

      await assertBranchCoverage(
        tx,
        tenantId,
        departmentRows.map((row) => row.departmentId),
        branchIds,
      );

      await replaceBranchAssignments(tx, tenantId, doctorId, assignments);

      const doctor = await loadDoctor(tx, tenantId, doctorId);

      await recordAuditSafely(tx, {
        tenantId,
        action: AUDIT_ACTIONS.DOCTOR_ASSIGNMENTS_CHANGED,
        module: "doctors",
        resourceType: "doctor",
        resourceId: doctorId,
        description: "Doctor branch assignments replaced",
        metadata: { branchIds },
      });

      return doctor;
    });
  } catch (error) {
    mapDoctorWriteError(error);
  }
}

export async function updateDoctorStatus(
  tenantId: string,
  doctorId: string,
  isActive: boolean,
): Promise<DoctorDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const current = await findLiveDoctor(tx, tenantId, doctorId);

    await tx
      .update(doctors)
      .set({ isActive })
      .where(
        and(
          eq(doctors.id, doctorId),
          eq(doctors.tenantId, tenantId),
          isNull(doctors.deletedAt),
        ),
      );

    const doctor = await loadDoctor(tx, tenantId, doctorId);

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.DOCTOR_STATUS_CHANGED,
      module: "doctors",
      resourceType: "doctor",
      resourceId: doctorId,
      description: "Doctor active status changed",
      previousState: { isActive: current.isActive },
      newState: { isActive: doctor.isActive },
    });

    return doctor;
  });
}

/**
 * Soft deletes the doctor profile.
 *
 * The global user account is never touched, and department/branch assignment
 * rows are kept as history. Deletion is idempotent. Active schedules block the
 * operation so a live roster cannot be deleted by accident; branch and
 * department deletion already refuse to run while assignments exist.
 */
export async function deleteDoctor(tenantId: string, doctorId: string): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: doctors.id, deletedAt: doctors.deletedAt })
      .from(doctors)
      .where(and(eq(doctors.id, doctorId), eq(doctors.tenantId, tenantId)))
      .limit(1);

    if (!row) throw AppError.notFound("Doctor not found");
    if (row.deletedAt) return;

    const [dependencies] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(doctorSchedules)
      .where(
        and(
          eq(doctorSchedules.tenantId, tenantId),
          eq(doctorSchedules.doctorId, doctorId),
          eq(doctorSchedules.isActive, true),
        ),
      );

    const activeSchedules = dependencies?.total ?? 0;

    if (activeSchedules > 0) {
      throw AppError.conflict(
        "Doctor cannot be deleted while active schedules exist",
        { activeSchedules },
      );
    }

    await tx
      .update(doctors)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(doctors.id, doctorId), eq(doctors.tenantId, tenantId)));

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.DOCTOR_DELETED,
      module: "doctors",
      resourceType: "doctor",
      resourceId: doctorId,
      description: "Doctor profile soft deleted",
    });
  });
}
