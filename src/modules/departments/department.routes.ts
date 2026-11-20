import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  createDepartmentHandler,
  deleteDepartmentHandler,
  getDepartmentHandler,
  listDepartmentsHandler,
  updateDepartmentBranchesHandler,
  updateDepartmentHandler,
  updateDepartmentStatusHandler,
} from "./department.controller.js";
import {
  createDepartmentSchema,
  departmentIdParamsSchema,
  listDepartmentsQuerySchema,
  updateDepartmentBranchesSchema,
  updateDepartmentSchema,
  updateDepartmentStatusSchema,
} from "./department.schemas.js";

/**
 * Hospital plane department management. Tenant identity is taken from the
 * verified session by `requireTenant`; RLS is the second isolation boundary.
 * Permission keys are the ones already seeded in the RBAC catalogue.
 */
export const departmentRouter: Router = Router();

departmentRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("department:create"),
  validate({ body: createDepartmentSchema }),
  createDepartmentHandler,
);

departmentRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("department:read"),
  validate({ query: listDepartmentsQuerySchema }),
  listDepartmentsHandler,
);

departmentRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("department:read"),
  validate({ params: departmentIdParamsSchema }),
  getDepartmentHandler,
);

departmentRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("department:update"),
  validate({ params: departmentIdParamsSchema, body: updateDepartmentSchema }),
  updateDepartmentHandler,
);

departmentRouter.put(
  "/:id/branches",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("department:update"),
  validate({ params: departmentIdParamsSchema, body: updateDepartmentBranchesSchema }),
  updateDepartmentBranchesHandler,
);

departmentRouter.patch(
  "/:id/status",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("department:update"),
  validate({ params: departmentIdParamsSchema, body: updateDepartmentStatusSchema }),
  updateDepartmentStatusHandler,
);

departmentRouter.delete(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("department:delete"),
  validate({ params: departmentIdParamsSchema }),
  deleteDepartmentHandler,
);
