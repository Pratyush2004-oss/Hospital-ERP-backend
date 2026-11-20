import { and, asc, desc, eq, exists, ilike, isNull, ne, or, sql } from "drizzle-orm";
import {
  branches,
  departmentBranches,
  departments,
  doctorBranches,
} from "../../database/schema/index.js";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import type {
  Branch,
} from "../../database/schema/branches.js";
import type {
  BranchDto,
  BranchListResult,
} from "./branch.types.js";
import type {
  CreateBranchInput,
  ListBranchesQuery,
  UpdateBranchInput,
} from "./branch.schemas.js";

function toDto(branch: Branch): BranchDto {
  return {
    id: branch.id,
    name: branch.name,
    branchCode: branch.branchCode,
    contactEmail: branch.email,
    contactPhone: branch.phone,
    addressLine1: branch.addressLine1,
    addressLine2: branch.addressLine2,
    city: branch.city,
    state: branch.state,
    postalCode: branch.postalCode,
    country: branch.country,
    timezone: branch.timezone,
    isActive: branch.isActive,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function findLiveBranch(
  tx: DbExecutor,
  tenantId: string,
  branchId: string,
): Promise<Branch> {
  const [branch] = await tx
    .select()
    .from(branches)
    .where(
      and(
        eq(branches.id, branchId),
        eq(branches.tenantId, tenantId),
        isNull(branches.deletedAt),
      ),
    )
    .limit(1);

  if (!branch) throw AppError.notFound("Branch not found");
  return branch;
}

async function assertCodeAvailable(
  tx: DbExecutor,
  tenantId: string,
  branchCode: string,
  excludeBranchId?: string,
): Promise<void> {
  const conditions = and(
    eq(branches.tenantId, tenantId),
    eq(branches.branchCode, branchCode),
    excludeBranchId === undefined ? undefined : ne(branches.id, excludeBranchId),
  );

  const [existing] = await tx
    .select({ id: branches.id, deletedAt: branches.deletedAt })
    .from(branches)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw AppError.conflict(
      existing.deletedAt
        ? "A branch with this code already exists, including a soft-deleted branch"
        : "A branch with this code already exists in this hospital",
    );
  }
}

export async function createBranch(
  tenantId: string,
  input: CreateBranchInput,
): Promise<BranchDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertCodeAvailable(tx, tenantId, input.branchCode);

      const [created] = await tx
        .insert(branches)
        .values({
          tenantId,
          name: input.name,
          branchCode: input.branchCode,
          email: input.contactEmail ?? null,
          phone: input.contactPhone ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          timezone: input.timezone ?? "UTC",
          isActive: input.isActive ?? true,
        })
        .returning();

      if (!created) throw AppError.internal("Failed to create branch");

      await recordAuditSafely(tx, {
        tenantId,
        branchId: created.id,
        action: AUDIT_ACTIONS.BRANCH_CREATED,
        module: "branches",
        resourceType: "branch",
        resourceId: created.id,
        description: "Branch created",
        newState: {
          name: created.name,
          branchCode: created.branchCode,
          timezone: created.timezone,
          isActive: created.isActive,
        },
      });

      return toDto(created);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("A branch with this code already exists in this hospital");
    }
    throw error;
  }
}

export async function listBranches(
  tenantId: string,
  query: ListBranchesQuery,
): Promise<BranchListResult> {
  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [
      eq(branches.tenantId, tenantId),
      isNull(branches.deletedAt),
    ];

    if (query.isActive !== undefined) {
      conditions.push(eq(branches.isActive, query.isActive));
    }

    if (query.search) {
      const pattern = `%${query.search}%`;
      const searchClause = or(
        ilike(branches.name, pattern),
        ilike(branches.branchCode, pattern),
      );
      if (searchClause) conditions.push(searchClause);
    }

    const where = and(...conditions);
    const sortColumn = {
      name: branches.name,
      branchCode: branches.branchCode,
      createdAt: branches.createdAt,
      updatedAt: branches.updatedAt,
    }[query.sortBy];

    const [rows, totals] = await Promise.all([
      tx
        .select()
        .from(branches)
        .where(where)
        .orderBy(query.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn), asc(branches.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(branches)
        .where(where),
    ]);

    return {
      branches: rows.map(toDto),
      total: totals[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function getBranch(tenantId: string, branchId: string): Promise<BranchDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    return toDto(await findLiveBranch(tx, tenantId, branchId));
  });
}

export async function updateBranch(
  tenantId: string,
  branchId: string,
  input: UpdateBranchInput,
): Promise<BranchDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      const current = await findLiveBranch(tx, tenantId, branchId);

      if (input.branchCode !== undefined) {
        await assertCodeAvailable(tx, tenantId, input.branchCode, branchId);
      }

      const [updated] = await tx
        .update(branches)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.branchCode === undefined ? {} : { branchCode: input.branchCode }),
          ...(input.contactEmail === undefined ? {} : { email: input.contactEmail }),
          ...(input.contactPhone === undefined ? {} : { phone: input.contactPhone }),
          ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2 }),
          ...(input.city === undefined ? {} : { city: input.city }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
          ...(input.country === undefined ? {} : { country: input.country }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        })
        .where(
          and(
            eq(branches.id, branchId),
            eq(branches.tenantId, tenantId),
            isNull(branches.deletedAt),
          ),
        )
        .returning();

      if (!updated) throw AppError.notFound("Branch not found");

      await recordAuditSafely(tx, {
        tenantId,
        branchId: updated.id,
        action: AUDIT_ACTIONS.BRANCH_UPDATED,
        module: "branches",
        resourceType: "branch",
        resourceId: updated.id,
        description: "Branch updated",
        previousState: {
          name: current.name,
          branchCode: current.branchCode,
          timezone: current.timezone,
          isActive: current.isActive,
        },
        newState: {
          name: updated.name,
          branchCode: updated.branchCode,
          timezone: updated.timezone,
          isActive: updated.isActive,
        },
      });

      return toDto(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("A branch with this code already exists in this hospital");
    }
    throw error;
  }
}

export async function updateBranchStatus(
  tenantId: string,
  branchId: string,
  isActive: boolean,
): Promise<BranchDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const current = await findLiveBranch(tx, tenantId, branchId);

    const [updated] = await tx
      .update(branches)
      .set({ isActive })
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.tenantId, tenantId),
          isNull(branches.deletedAt),
        ),
      )
      .returning();

    if (!updated) throw AppError.notFound("Branch not found");

    await recordAuditSafely(tx, {
      tenantId,
      branchId: updated.id,
      action: AUDIT_ACTIONS.BRANCH_STATUS_CHANGED,
      module: "branches",
      resourceType: "branch",
      resourceId: updated.id,
      description: "Branch active status changed",
      previousState: { isActive: current.isActive },
      newState: { isActive: updated.isActive },
    });

    return toDto(updated);
  });
}

/**
 * Soft deletion is blocked when operational children still point at the branch.
 * Departments and doctor assignments are the current branch dependants; their
 * schedules/leaves cascade from doctor assignments.
 */
export async function deleteBranch(tenantId: string, branchId: string): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    const current = await findLiveBranch(tx, tenantId, branchId);

    const [[departmentCount], [doctorCount]] = await Promise.all([
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(departments)
        .where(
          and(
            eq(departments.tenantId, tenantId),
            isNull(departments.deletedAt),
            or(
              eq(departments.branchId, branchId),
              // A department may operate in this branch without being owned by it.
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(departmentBranches)
                  .where(
                    and(
                      eq(departmentBranches.tenantId, tenantId),
                      eq(departmentBranches.departmentId, departments.id),
                      eq(departmentBranches.branchId, branchId),
                    ),
                  ),
              ),
            ),
          ),
        ),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(doctorBranches)
        .where(
          and(
            eq(doctorBranches.tenantId, tenantId),
            eq(doctorBranches.branchId, branchId),
          ),
        ),
    ]);

    const dependants = (departmentCount?.total ?? 0) + (doctorCount?.total ?? 0);

    if (dependants > 0) {
      throw AppError.conflict(
        "Branch cannot be deleted while departments or doctor assignments reference it",
        {
          departments: departmentCount?.total ?? 0,
          doctorAssignments: doctorCount?.total ?? 0,
        },
      );
    }

    await tx
      .update(branches)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)));

    await recordAuditSafely(tx, {
      tenantId,
      branchId,
      action: AUDIT_ACTIONS.BRANCH_DELETED,
      module: "branches",
      resourceType: "branch",
      resourceId: branchId,
      description: "Branch soft deleted",
      previousState: {
        name: current.name,
        branchCode: current.branchCode,
        isActive: current.isActive,
      },
    });
  });
}
