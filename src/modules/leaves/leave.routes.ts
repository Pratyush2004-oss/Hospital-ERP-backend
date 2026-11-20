import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  approveDoctorLeaveHandler,
  cancelDoctorLeaveHandler,
  createDoctorLeaveHandler,
  getDoctorLeaveHandler,
  listDoctorLeavesHandler,
  rejectDoctorLeaveHandler,
  updateDoctorLeaveHandler,
} from "./leave.controller.js";
import {
  createDoctorLeaveSchema,
  doctorLeaveIdParamsSchema,
  listDoctorLeavesQuerySchema,
  rejectDoctorLeaveSchema,
  updateDoctorLeaveSchema,
} from "./leave.schemas.js";

/**
 * Hospital plane doctor leave workflows.
 *
 * Each action is guarded by its own Task 16.6 permission key. A doctor holds
 * `doctor.leave.create/update/cancel` and acts only on their own requests -
 * that ownership rule (and the management override) is enforced by the leave
 * service from the verified actor. Approval and rejection require
 * `doctor.leave.approve` / `doctor.leave.reject` at the route *and* the
 * service's own decision rules (all-branch scope, self-approval policy,
 * pending-only).
 */
export const doctorLeaveRouter: Router = Router();

doctorLeaveRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor.leave.create"),
  validate({ body: createDoctorLeaveSchema }),
  createDoctorLeaveHandler,
);

doctorLeaveRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("doctor.leave.read"),
  validate({ query: listDoctorLeavesQuerySchema }),
  listDoctorLeavesHandler,
);

doctorLeaveRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("doctor.leave.read"),
  validate({ params: doctorLeaveIdParamsSchema }),
  getDoctorLeaveHandler,
);

doctorLeaveRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor.leave.update"),
  validate({ params: doctorLeaveIdParamsSchema, body: updateDoctorLeaveSchema }),
  updateDoctorLeaveHandler,
);

doctorLeaveRouter.patch(
  "/:id/approve",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor.leave.approve"),
  validate({ params: doctorLeaveIdParamsSchema }),
  approveDoctorLeaveHandler,
);

doctorLeaveRouter.patch(
  "/:id/reject",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor.leave.reject"),
  validate({ params: doctorLeaveIdParamsSchema, body: rejectDoctorLeaveSchema }),
  rejectDoctorLeaveHandler,
);

doctorLeaveRouter.patch(
  "/:id/cancel",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("doctor.leave.cancel"),
  validate({ params: doctorLeaveIdParamsSchema }),
  cancelDoctorLeaveHandler,
);
