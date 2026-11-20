import type { RequestHandler } from "express";
import { sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  getAuditLog,
  listAuditLogs,
  listRecentAuditActivity,
} from "./audit.query.service.js";
import {
  auditLogIdParamsSchema,
  listAuditLogsQuerySchema,
  recentAuditActivityQuerySchema,
} from "./audit.schemas.js";

/**
 * HTTP layer for read-only audit history.
 *
 * The tenant always comes from the verified session via `requireTenantScope`;
 * no handler reads a tenant id from the request. Services repeat the tenant
 * predicate in SQL, so an application mistake cannot widen the result set.
 */

export const listAuditLogsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listAuditLogsQuerySchema>(req, "query");

  const result = await listAuditLogs(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    actorUserId: query.actorUserId,
    branchId: query.branchId,
    module: query.module,
    action: query.action,
    resourceType: query.resourceType,
    resourceId: query.resourceId,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
    sortOrder: query.sortOrder,
  });

  sendSuccess(res, { auditLogs: result.auditLogs }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const recentAuditActivityHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof recentAuditActivityQuerySchema>(req, "query");

  const activity = await listRecentAuditActivity(actor.tenantId, {
    branchId: query.branchId,
    limit: query.limit,
  });

  sendSuccess(res, { activity });
};

export const getAuditLogHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof auditLogIdParamsSchema>(req, "params");
  const auditLog = await getAuditLog(actor.tenantId, params.auditLogId);

  sendSuccess(res, { auditLog });
};
