import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  createDoctorHandler,
  deleteDoctorHandler,
  getDoctorHandler,
  listDoctorsHandler,
  listEligibleDoctorMembersHandler,
  updateDoctorBranchesHandler,
  updateDoctorDepartmentsHandler,
  updateDoctorHandler,
  updateDoctorStatusHandler,
} from "./doctor.controller.js";
import {
  createDoctorSchema,
  doctorIdParamsSchema,
  eligibleDoctorMembersQuerySchema,
  listDoctorsQuerySchema,
  updateDoctorBranchesSchema,
  updateDoctorDepartmentsSchema,
  updateDoctorSchema,
  updateDoctorStatusSchema,
} from "./doctor.schemas.js";

/**
 * Hospital plane doctor management. The tenant id is always taken from the
 * verified session context by `requireTenant`; no route reads it from the URL
 * or body. Permission keys are the ones already seeded in the RBAC catalogue.
 */
export const doctorRouter: Router = Router();

doctorRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:create"),
  validate({ body: createDoctorSchema }),
  createDoctorHandler,
);

doctorRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("doctor:read"),
  validate({ query: listDoctorsQuerySchema }),
  listDoctorsHandler,
);

doctorRouter.get(
  "/eligible-members",
  authenticate,
  requireTenant,
  requirePermission("doctor:create"),
  validate({ query: eligibleDoctorMembersQuerySchema }),
  listEligibleDoctorMembersHandler,
);

doctorRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("doctor:read"),
  validate({ params: doctorIdParamsSchema }),
  getDoctorHandler,
);

doctorRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:update"),
  validate({ params: doctorIdParamsSchema, body: updateDoctorSchema }),
  updateDoctorHandler,
);

doctorRouter.put(
  "/:id/departments",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:update"),
  validate({ params: doctorIdParamsSchema, body: updateDoctorDepartmentsSchema }),
  updateDoctorDepartmentsHandler,
);

doctorRouter.put(
  "/:id/branches",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:update"),
  validate({ params: doctorIdParamsSchema, body: updateDoctorBranchesSchema }),
  updateDoctorBranchesHandler,
);

doctorRouter.patch(
  "/:id/status",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:update"),
  validate({ params: doctorIdParamsSchema, body: updateDoctorStatusSchema }),
  updateDoctorStatusHandler,
);

doctorRouter.delete(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor:delete"),
  validate({ params: doctorIdParamsSchema }),
  deleteDoctorHandler,
);
