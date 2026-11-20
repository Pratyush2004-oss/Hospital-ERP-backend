import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import {
  getAuditLogHandler,
  listAuditLogsHandler,
  recentAuditActivityHandler,
} from "./audit.controller.js";
import {
  auditLogIdParamsSchema,
  listAuditLogsQuerySchema,
  recentAuditActivityQuerySchema,
} from "./audit.schemas.js";

/**
 * Read-only audit log API (Phase 21.2).
 *
 * Every route requires an authenticated hospital member with `audit:read`
 * (`hospital_admin` and `branch_admin` by default) and takes the tenant from
 * the verified session. There are intentionally no POST, PATCH, PUT or DELETE
 * routes: audit records remain append-only and can only be written by the
 * server-side audit service.
 */
export const auditRouter: Router = Router();

/* Literal route before `/:auditLogId`, so "recent" is never parsed as an id. */
auditRouter.get(
  "/recent",
  authenticate,
  requireTenant,
  requirePermission("audit:read"),
  validate({ query: recentAuditActivityQuerySchema }),
  recentAuditActivityHandler,
);

auditRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("audit:read"),
  validate({ query: listAuditLogsQuerySchema }),
  listAuditLogsHandler,
);

auditRouter.get(
  "/:auditLogId",
  authenticate,
  requireTenant,
  requirePermission("audit:read"),
  validate({ params: auditLogIdParamsSchema }),
  getAuditLogHandler,
);
