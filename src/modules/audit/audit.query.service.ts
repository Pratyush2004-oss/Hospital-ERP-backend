import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { auditLogs, branches } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { redactAuditValue } from "./audit.service.js";
import type { AuditLogEntry, AuditLogPage } from "./audit.types.js";

/**
 * Read-only audit queries (Phase 21.2).
 *
 * Tenant identity is always the verified tenant id supplied by the controller;
 * no tenant id is read from the URL or query. Every statement also carries
 * `tenant_id = $1`, and the database's forced RLS repeats the same isolation.
 * A foreign resource or branch therefore resolves as 404/empty without
 * disclosing that it exists.
 *
 * Reads re-apply the redaction used on write. Stored audit rows are already
 * redacted, but doing it again protects against legacy rows or a future writer
 * that bypasses the service.
 */

export type AuditSortOrder = "asc" | "desc";

export interface ListAuditLogsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly actorUserId?: string;
  readonly branchId?: string;
  readonly module?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly sortOrder?: AuditSortOrder;
}

export interface RecentAuditFilters {
  readonly branchId?: string;
  readonly limit?: number;
}

type AuditRow = typeof auditLogs.$inferSelect;

function validatePagination(page: number | undefined, pageSize: number | undefined) {
  const resolvedPage = page ?? 1;
  const resolvedPageSize = pageSize ?? 20;

  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    throw AppError.validation("page must be a positive integer", { field: "page" });
  }

  if (!Number.isInteger(resolvedPageSize) || resolvedPageSize < 1 || resolvedPageSize > 100) {
    throw AppError.validation("limit must be between 1 and 100", { field: "limit" });
  }

  return { page: resolvedPage, pageSize: resolvedPageSize };
}

function sanitizedMetadata(value: unknown): Readonly<Record<string, unknown>> {
  const redacted = redactAuditValue(value);

  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

function toAuditEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    branchId: row.branchId,
    actorUserId: row.actorUserId,
    actorScope: row.actorScope,
    action: row.action,
    module: row.module,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    description: row.description,
    previousState: redactAuditValue(row.previousState),
    newState: redactAuditValue(row.newState),
    metadata: sanitizedMetadata(row.metadata),
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

async function assertBranchInTenant(
  tx: DbExecutor,
  tenantId: string,
  branchId: string,
): Promise<void> {
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)))
    .limit(1);

  // Soft-deleted branches still have audit history, so `deleted_at` is not
  // filtered here. A branch from another hospital is indistinguishable from a
  // missing one.
  if (!branch) throw AppError.notFound("Branch not found");
}

function auditConditions(tenantId: string, filters: ListAuditLogsFilters): SQL[] {
  const conditions: SQL[] = [eq(auditLogs.tenantId, tenantId)];

  if (filters.actorUserId !== undefined) {
    conditions.push(eq(auditLogs.actorUserId, filters.actorUserId));
  }
  if (filters.branchId !== undefined) {
    conditions.push(eq(auditLogs.branchId, filters.branchId));
  }
  if (filters.module !== undefined) {
    conditions.push(eq(auditLogs.module, filters.module));
  }
  if (filters.action !== undefined) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters.resourceType !== undefined) {
    conditions.push(eq(auditLogs.resourceType, filters.resourceType));
  }
  if (filters.resourceId !== undefined) {
    conditions.push(eq(auditLogs.resourceId, filters.resourceId));
  }
  if (filters.from !== undefined) {
    conditions.push(gte(auditLogs.createdAt, filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(auditLogs.createdAt, filters.to));
  }

  return conditions;
}

/** Paginated tenant activity, newest first unless `sortOrder=asc` is requested. */
export async function listAuditLogs(
  tenantId: string,
  filters: ListAuditLogsFilters = {},
): Promise<AuditLogPage> {
  const { page, pageSize } = validatePagination(filters.page, filters.pageSize);

  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    throw AppError.validation("from must be on or before to", { field: "to" });
  }

  return withTenantTransaction(tenantId, async (tx) => {
    if (filters.branchId !== undefined) {
      await assertBranchInTenant(tx, tenantId, filters.branchId);
    }

    const where = and(...auditConditions(tenantId, filters));
    const direction = filters.sortOrder === "asc" ? asc : desc;

    // A bounded count plus one page is fetched; complete histories are never
    // loaded into application memory.
    const [countRows, rows] = await Promise.all([
      tx.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
      tx
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(direction(auditLogs.createdAt), direction(auditLogs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      auditLogs: rows.map(toAuditEntry),
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  });
}

/** One audit record; a foreign tenant's id is a 404, never a permission leak. */
export async function getAuditLog(
  tenantId: string,
  auditLogId: string,
): Promise<AuditLogEntry> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.id, auditLogId)))
      .limit(1);

    if (!row) throw AppError.notFound("Audit log not found");
    return toAuditEntry(row);
  });
}

/**
 * Recent activity for the hospital or one branch. Kept separate from the list
 * query so a dashboard-style caller does not pay for a full count.
 */
export async function listRecentAuditActivity(
  tenantId: string,
  filters: RecentAuditFilters = {},
): Promise<readonly AuditLogEntry[]> {
  const limit = filters.limit ?? 20;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw AppError.validation("limit must be between 1 and 100", { field: "limit" });
  }

  return withTenantTransaction(tenantId, async (tx) => {
    if (filters.branchId !== undefined) {
      await assertBranchInTenant(tx, tenantId, filters.branchId);
    }

    const conditions = auditConditions(tenantId, { branchId: filters.branchId });
    const rows = await tx
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);

    return rows.map(toAuditEntry);
  });
}
