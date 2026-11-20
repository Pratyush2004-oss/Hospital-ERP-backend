import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  createDoctorScheduleHandler,
  deleteDoctorScheduleHandler,
  getDoctorScheduleHandler,
  listDoctorSchedulesHandler,
  updateDoctorScheduleHandler,
  updateDoctorScheduleStatusHandler,
} from "./schedule.controller.js";
import {
  createDoctorScheduleSchema,
  doctorScheduleIdParamsSchema,
  listDoctorSchedulesQuerySchema,
  updateDoctorScheduleSchema,
  updateDoctorScheduleStatusSchema,
} from "./schedule.schemas.js";

/**
 * Hospital plane doctor schedule management. The tenant id always comes from
 * the verified session context; it is never read from the URL or body.
 * Authorization uses the fine-grained scheduling keys seeded by Task 16.6:
 * `schedule.read` for reads, `schedule.create` to add a window,
 * `schedule.update` for edits/status and `schedule.delete` to remove one.
 */
export const doctorScheduleRouter: Router = Router();

doctorScheduleRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.create"),
  validate({ body: createDoctorScheduleSchema }),
  createDoctorScheduleHandler,
);

doctorScheduleRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("schedule.read"),
  validate({ query: listDoctorSchedulesQuerySchema }),
  listDoctorSchedulesHandler,
);

doctorScheduleRouter.get(
  "/:id",
  authenticate,
  requireTenant,
  requirePermission("schedule.read"),
  validate({ params: doctorScheduleIdParamsSchema }),
  getDoctorScheduleHandler,
);

doctorScheduleRouter.patch(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.update"),
  validate({ params: doctorScheduleIdParamsSchema, body: updateDoctorScheduleSchema }),
  updateDoctorScheduleHandler,
);

doctorScheduleRouter.patch(
  "/:id/status",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.update"),
  validate({
    params: doctorScheduleIdParamsSchema,
    body: updateDoctorScheduleStatusSchema,
  }),
  updateDoctorScheduleStatusHandler,
);

doctorScheduleRouter.delete(
  "/:id",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("schedule.delete"),
  validate({ params: doctorScheduleIdParamsSchema }),
  deleteDoctorScheduleHandler,
);
