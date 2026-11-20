import { and, asc, desc, eq, exists, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  branches,
  departmentBranches,
  departments,
  doctorDepartments,
  type Department,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { slugify } from "../../lib/slug.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import type {
  CreateDepartmentInput,
  DepartmentBranchSummary,
  DepartmentDto,
  DepartmentListResult,
  ListDepartmentsFilters,
  UpdateDepartmentInput,
} from "./department.types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function normalizeName(value: string): string {
  const name = value.trim();

  if (name.length < 2 || name.length > 150) {
    throw AppError.validation("Department name must be between 2 and 150 characters");
  }

  return name;
}

function normalizeSlug(value: string): string {
  const slug = slugify(value);

  if (slug.length < 2 || slug.length > 120) {
    throw AppError.validation("Enter a valid department slug");
  }

  return slug;
}

function normalizeBranchIds(branchIds: readonly string[] | undefined): string[] | undefined {
  if (branchIds === undefined) return undefined;

  return [...new Set(branchIds)];
}

function toDto(row: Department, branchRows: readonly DepartmentBranchSummary[]): DepartmentDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isActive: row.isActive,
    branchId: row.branchId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    branches: branchRows,
  };
}

async function findLiveDepartment(
  tx: DbExecutor,
  tenantId: string,
  departmentId: string,
): Promise<Department> {
  const [row] = await tx
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.id, departmentId),
        eq(departments.tenantId, tenantId),
        isNull(departments.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Department not found");
  return row;
}

async function loadBranchSummaries(
  tx: DbExecutor,
  tenantId: string,
  departmentIds: readonly string[],
): Promise<Map<string, DepartmentBranchSummary[]>> {
  const grouped = new Map<string, DepartmentBranchSummary[]>();
  if (departmentIds.length === 0) return grouped;

  const rows = await tx
    .select({
      departmentId: departmentBranches.departmentId,
      id: branches.id,
      name: branches.name,
      branchCode: branches.branchCode,
      isActive: branches.isActive,
    })
    .from(departmentBranches)
    .innerJoin(
      branches,
      and(
        eq(branches.id, departmentBranches.branchId),
        eq(branches.tenantId, departmentBranches.tenantId),
      ),
    )
    .where(
      and(
        eq(departmentBranches.tenantId, tenantId),
        inArray(departmentBranches.departmentId, [...departmentIds]),
      ),
    )
    .orderBy(asc(branches.name), asc(branches.id));

  for (const row of rows) {
    const list = grouped.get(row.departmentId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      branchCode: row.branchCode,
      isActive: row.isActive,
    });
    grouped.set(row.departmentId, list);
  }

  return grouped;
}

async function loadDepartment(
  tx: DbExecutor,
  tenantId: string,
  departmentId: string,
): Promise<DepartmentDto> {
  const row = await findLiveDepartment(tx, tenantId, departmentId);
  const summaries = await loadBranchSummaries(tx, tenantId, [row.id]);

  return toDto(row, summaries.get(row.id) ?? []);
}

async function assertBranchesBelongToTenant(
  tx: DbExecutor,
  tenantId: string,
  branchIds: readonly string[],
): Promise<void> {
  if (branchIds.length === 0) return;

  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(
        eq(branches.tenantId, tenantId),
        inArray(branches.id, [...branchIds]),
        isNull(branches.deletedAt),
      ),
    );

  const found = new Set(rows.map((row) => row.id));
  const missing = branchIds.filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw AppError.badRequest("One or more branches do not belong to this hospital", {
      branchIds: missing,
    });
  }
}

async function firstLiveBranchId(tx: DbExecutor, tenantId: string): Promise<string> {
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), isNull(branches.deletedAt)))
    .orderBy(asc(branches.createdAt), asc(branches.id))
    .limit(1);

  if (!branch) {
    throw AppError.badRequest("Create a branch before creating a department");
  }

  return branch.id;
}

async function assertSlugAvailable(
  tx: DbExecutor,
  tenantId: string,
  slug: string,
  excludeDepartmentId?: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(
        eq(departments.tenantId, tenantId),
        eq(departments.slug, slug),
        excludeDepartmentId === undefined ? undefined : ne(departments.id, excludeDepartmentId),
      ),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict("A department with this slug already exists in this hospital");
  }
}

async function replaceBranchAssociations(
  tx: DbExecutor,
  tenantId: string,
  departmentId: string,
  branchIds: readonly string[],
): Promise<void> {
  await tx
    .delete(departmentBranches)
    .where(
      and(
        eq(departmentBranches.tenantId, tenantId),
        eq(departmentBranches.departmentId, departmentId),
      ),
    );

  if (branchIds.length === 0) return;

  await tx
    .insert(departmentBranches)
    .values(branchIds.map((branchId) => ({ tenantId, departmentId, branchId })))
    .onConflictDoNothing();
}

export async function createDepartment(
  tenantId: string,
  input: CreateDepartmentInput,
): Promise<DepartmentDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const name = normalizeName(input.name);
      const slug = normalizeSlug(input.slug ?? name);
      const branchIds = normalizeBranchIds(input.branchIds) ?? [];

      await assertBranchesBelongToTenant(tx, tenantId, branchIds);
      await assertSlugAvailable(tx, tenantId, slug);

      const homeBranchId = branchIds[0] ?? (await firstLiveBranchId(tx, tenantId));

      const [created] = await tx
        .insert(departments)
        .values({
          tenantId,
          branchId: homeBranchId,
          name,
          slug,
          description: input.description ?? null,
          isActive: input.isActive ?? true,
        })
        .returning({ id: departments.id });

      if (!created) throw AppError.internal("Failed to create department");

      await replaceBranchAssociations(
        tx,
        tenantId,
        created.id,
        branchIds.length > 0 ? branchIds : [homeBranchId],
      );

      const department = await loadDepartment(tx, tenantId, created.id);

      await recordAuditSafely(tx, {
        tenantId,
        branchId: department.branchId,
        action: AUDIT_ACTIONS.DEPARTMENT_CREATED,
        module: "departments",
        resourceType: "department",
        resourceId: department.id,
        description: "Department created",
        newState: {
          name: department.name,
          slug: department.slug,
          isActive: department.isActive,
          branchIds: department.branches.map((branch) => branch.id),
        },
      });

      return department;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("A department with this slug already exists in this hospital");
    }
    throw error;
  }
}

export async function listDepartments(
  tenantId: string,
  filters: ListDepartmentsFilters = {},
): Promise<DepartmentListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const includeBranches = filters.includeBranches ?? true;

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(departments.tenantId, tenantId), isNull(departments.deletedAt)];

    if (filters.isActive !== undefined) {
      conditions.push(eq(departments.isActive, filters.isActive));
    }

    if (filters.search) {
      const pattern = `%${filters.search}%`;
      const searchClause = or(
        ilike(departments.name, pattern),
        ilike(departments.slug, pattern),
      );
      if (searchClause) conditions.push(searchClause);
    }

    if (filters.branchId) {
      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(departmentBranches)
            .where(
              and(
                eq(departmentBranches.tenantId, tenantId),
                eq(departmentBranches.departmentId, departments.id),
                eq(departmentBranches.branchId, filters.branchId),
              ),
            ),
        ),
      );
    }

    const where = and(...conditions);
    const sortColumn = {
      name: departments.name,
      slug: departments.slug,
      createdAt: departments.createdAt,
      updatedAt: departments.updatedAt,
    }[filters.sortBy ?? "name"];
    const direction = filters.sortOrder ?? "asc";

    const [rows, totals] = await Promise.all([
      tx
        .select()
        .from(departments)
        .where(where)
        .orderBy(direction === "desc" ? desc(sortColumn) : asc(sortColumn), asc(departments.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(departments)
        .where(where),
    ]);

    const summaries = includeBranches
      ? await loadBranchSummaries(tx, tenantId, rows.map((row) => row.id))
      : new Map<string, DepartmentBranchSummary[]>();

    const total = totals[0]?.total ?? 0;

    return {
      departments: rows.map((row) => toDto(row, summaries.get(row.id) ?? [])),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

export async function getDepartmentById(
  tenantId: string,
  departmentId: string,
): Promise<DepartmentDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    loadDepartment(tx, tenantId, departmentId),
  );
}

export async function updateDepartment(
  tenantId: string,
  departmentId: string,
  input: UpdateDepartmentInput,
): Promise<DepartmentDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findLiveDepartment(tx, tenantId, departmentId);
      const patch: Partial<typeof departments.$inferInsert> = {};

      if (input.name !== undefined) patch.name = normalizeName(input.name);

      if (input.slug !== undefined) {
        const slug = normalizeSlug(input.slug);
        if (slug !== current.slug) {
          await assertSlugAvailable(tx, tenantId, slug, departmentId);
        }
        patch.slug = slug;
      }

      if (input.description !== undefined) {
        const description = input.description?.trim() ?? "";
        patch.description = description.length > 0 ? description : null;
      }

      if (input.isActive !== undefined) patch.isActive = input.isActive;

      if (Object.keys(patch).length > 0) {
        await tx
          .update(departments)
          .set(patch)
          .where(
            and(
              eq(departments.id, departmentId),
              eq(departments.tenantId, tenantId),
              isNull(departments.deletedAt),
            ),
          );
      }

      if (input.branchIds !== undefined) {
        const branchIds = normalizeBranchIds(input.branchIds) ?? [];
        await assertBranchesBelongToTenant(tx, tenantId, branchIds);
        await replaceBranchAssociations(tx, tenantId, departmentId, branchIds);

        if (branchIds.length > 0 && branchIds[0] !== current.branchId) {
          await tx
            .update(departments)
            .set({ branchId: branchIds[0] })
            .where(
              and(
                eq(departments.id, departmentId),
                eq(departments.tenantId, tenantId),
                isNull(departments.deletedAt),
              ),
            );
        }
      }

      const department = await loadDepartment(tx, tenantId, departmentId);

      await recordAuditSafely(tx, {
        tenantId,
        branchId: department.branchId,
        action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
        module: "departments",
        resourceType: "department",
        resourceId: department.id,
        description: "Department updated",
        previousState: {
          name: current.name,
          slug: current.slug,
          isActive: current.isActive,
          branchId: current.branchId,
        },
        newState: {
          name: department.name,
          slug: department.slug,
          isActive: department.isActive,
          branchId: department.branchId,
          branchIds: department.branches.map((branch) => branch.id),
        },
      });

      return department;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("A department with this slug already exists in this hospital");
    }
    throw error;
  }
}

export async function updateDepartmentBranches(
  tenantId: string,
  departmentId: string,
  branchIds: readonly string[],
): Promise<DepartmentDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const current = await findLiveDepartment(tx, tenantId, departmentId);
    const normalized = normalizeBranchIds(branchIds) ?? [];

    await assertBranchesBelongToTenant(tx, tenantId, normalized);
    await replaceBranchAssociations(tx, tenantId, departmentId, normalized);

    if (normalized.length > 0 && normalized[0] !== current.branchId) {
      await tx
        .update(departments)
        .set({ branchId: normalized[0] })
        .where(
          and(
            eq(departments.id, departmentId),
            eq(departments.tenantId, tenantId),
            isNull(departments.deletedAt),
          ),
        );
    }

    const department = await loadDepartment(tx, tenantId, departmentId);

    await recordAuditSafely(tx, {
      tenantId,
      branchId: department.branchId,
      action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
      module: "departments",
      resourceType: "department",
      resourceId: department.id,
      description: "Department branch assignments replaced",
      metadata: { branchIds: normalized },
    });

    return department;
  });
}

export async function updateDepartmentStatus(
  tenantId: string,
  departmentId: string,
  isActive: boolean,
): Promise<DepartmentDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const current = await findLiveDepartment(tx, tenantId, departmentId);

    await tx
      .update(departments)
      .set({ isActive })
      .where(
        and(
          eq(departments.id, departmentId),
          eq(departments.tenantId, tenantId),
          isNull(departments.deletedAt),
        ),
      );

    const department = await loadDepartment(tx, tenantId, departmentId);

    await recordAuditSafely(tx, {
      tenantId,
      branchId: department.branchId,
      action: AUDIT_ACTIONS.DEPARTMENT_STATUS_CHANGED,
      module: "departments",
      resourceType: "department",
      resourceId: department.id,
      description: "Department active status changed",
      previousState: { isActive: current.isActive },
      newState: { isActive: department.isActive },
    });

    return department;
  });
}

/**
 * Soft deletes the department. Repeated calls are no-ops, so a retried request
 * never turns a successful deletion into a 404. Departments with doctor
 * assignments are blocked until those assignments are removed.
 */
export async function deleteDepartment(
  tenantId: string,
  departmentId: string,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: departments.id, deletedAt: departments.deletedAt })
      .from(departments)
      .where(and(eq(departments.id, departmentId), eq(departments.tenantId, tenantId)))
      .limit(1);

    if (!row) throw AppError.notFound("Department not found");
    if (row.deletedAt) return;

    const [dependencies] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(doctorDepartments)
      .where(
        and(
          eq(doctorDepartments.tenantId, tenantId),
          eq(doctorDepartments.departmentId, departmentId),
        ),
      );

    const doctors = dependencies?.total ?? 0;

    if (doctors > 0) {
      throw AppError.conflict("Department cannot be deleted while doctors are assigned to it", {
        doctors,
      });
    }

    await tx
      .update(departments)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(departments.id, departmentId), eq(departments.tenantId, tenantId)));

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.DEPARTMENT_DELETED,
      module: "departments",
      resourceType: "department",
      resourceId: departmentId,
      description: "Department soft deleted",
    });
  });
}
