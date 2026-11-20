import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import {
  requirePermission,
  requireTenant,
} from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  createBranchHandler,
  deleteBranchHandler,
  getBranchHandler,
  listBranchesHandler,
  updateBranchHandler,
  updateBranchStatusHandler,
} from "./branch.controller.js";
import {
  branchIdParamsSchema,
  createBranchSchema,
  listBranchesQuerySchema,
  updateBranchSchema,
  updateBranchStatusSchema,
} from "./branch.schemas.js";

/**
 * Hospital plane branch management. The tenant id is always taken from the
 * verified session context by `requireTenant`; no route reads it from the URL
 * or body. RLS provides a second isolation boundary in every service query.
 */
export const branchRouter: Router = Router();

branchRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("branch:create"),
  validate({ body: createBranchSchema }),
  createBranchHandler,
);

branchRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("branch:read"),
  validate({ query: listBranchesQuerySchema }),
  listBranchesHandler,
);

branchRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("branch:read"),
  validate({ params: branchIdParamsSchema }),
  getBranchHandler,
);

branchRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("branch:update"),
  validate({ params: branchIdParamsSchema, body: updateBranchSchema }),
  updateBranchHandler,
);

branchRouter.patch(
  "/:id/status",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("branch:update"),
  validate({ params: branchIdParamsSchema, body: updateBranchStatusSchema }),
  updateBranchStatusHandler,
);

branchRouter.delete(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("branch:delete"),
  validate({ params: branchIdParamsSchema }),
  deleteBranchHandler,
);
