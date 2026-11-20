import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  approveRefundHandler,
  createRefundHandler,
  getRefundHandler,
  listRefundsHandler,
  processRefundHandler,
  rejectRefundHandler,
} from "./refund.controller.js";
import {
  createRefundRequestSchema,
  listRefundsQuerySchema,
  processRefundSchema,
  refundDecisionSchema,
  refundIdParamsSchema,
} from "./refund.schemas.js";

/**
 * Hospital plane refund API (Phase 19.7.2).
 *
 * The tenant and actor always come from the verified session via `requireTenant`;
 * no route accepts a `tenantId` from the URL, query or body. The refund service
 * resolves the invoice, patient, branch and currency from the stored payment
 * capture, so a refund against another hospital's money is unreachable (the
 * service scopes every read and write by tenant and RLS enforces it again).
 *
 * Permission keys are the ones already seeded in the RBAC catalogue:
 *
 *   payment:refund - request, approve, reject and process a refund
 *                    (hospital_admin, accountant)
 *   payment:read   - list refund history and read one refund
 *                    (hospital_admin, branch_admin, receptionist, accountant)
 *
 * The approval model is the service's: a refund starts PENDING and the caller
 * that requested it cannot approve it. There is no status, update or delete
 * route - a refund is append-only financial history, and its status only moves
 * through the approve/reject/process actions.
 *
 * Branch scope: hospital memberships are tenant-scoped, not branch-scoped (see
 * the documented limitation), so `branchId` is a read filter. The service still
 * checks that the capture's receipt and invoice agree on branch and patient.
 */
export const refundRouter: Router = Router();

refundRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:refund"),
  validate({ body: createRefundRequestSchema }),
  createRefundHandler,
);

refundRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ query: listRefundsQuerySchema }),
  listRefundsHandler,
);

refundRouter.get(
  "/:refundId",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ params: refundIdParamsSchema }),
  getRefundHandler,
);

refundRouter.post(
  "/:refundId/approve",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:refund"),
  validate({ params: refundIdParamsSchema, body: refundDecisionSchema }),
  approveRefundHandler,
);

refundRouter.post(
  "/:refundId/reject",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:refund"),
  validate({ params: refundIdParamsSchema, body: refundDecisionSchema }),
  rejectRefundHandler,
);

refundRouter.post(
  "/:refundId/process",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:refund"),
  validate({ params: refundIdParamsSchema, body: processRefundSchema }),
  processRefundHandler,
);
