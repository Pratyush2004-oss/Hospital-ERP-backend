import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  createDoctorBreakHandler,
  deleteDoctorBreakHandler,
  getDoctorBreakHandler,
  listDoctorBreaksHandler,
  updateDoctorBreakHandler,
} from "./break.controller.js";
import {
  createDoctorBreakSchema,
  doctorBreakIdParamsSchema,
  listDoctorBreaksQuerySchema,
  updateDoctorBreakSchema,
} from "./break.schemas.js";

/**
 * Hospital plane doctor break management. Breaks inherit their doctor and
 * branch from the parent schedule, so no tenant or doctor id is accepted from
 * the client beyond the schedule reference the service validates. Each action
 * is guarded by its own `schedule.break.*` permission (Task 16.6).
 */
export const doctorBreakRouter: Router = Router();

doctorBreakRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.break.create"),
  validate({ body: createDoctorBreakSchema }),
  createDoctorBreakHandler,
);

doctorBreakRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("schedule.break.read"),
  validate({ query: listDoctorBreaksQuerySchema }),
  listDoctorBreaksHandler,
);

doctorBreakRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("schedule.break.read"),
  validate({ params: doctorBreakIdParamsSchema }),
  getDoctorBreakHandler,
);

doctorBreakRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.break.update"),
  validate({ params: doctorBreakIdParamsSchema, body: updateDoctorBreakSchema }),
  updateDoctorBreakHandler,
);

doctorBreakRouter.delete(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.break.delete"),
  validate({ params: doctorBreakIdParamsSchema }),
  deleteDoctorBreakHandler,
);
