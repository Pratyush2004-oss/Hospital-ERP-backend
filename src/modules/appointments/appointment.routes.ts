import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  cancelAppointmentHandler,
  checkInAppointmentHandler,
  completeAppointmentHandler,
  createAppointmentHandler,
  getAppointmentByCodeHandler,
  getAppointmentHandler,
  getAppointmentHistoryHandler,
  getAvailabilityHandler,
  getDoctorAvailabilityHandler,
  listAppointmentsHandler,
  noShowAppointmentHandler,
  rescheduleAppointmentHandler,
  startAppointmentHandler,
} from "./appointment.controller.js";
import {
  appointmentCodeParamsSchema,
  appointmentIdParamsSchema,
  availabilityQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  doctorAvailabilityParamsSchema,
  doctorAvailabilityQuerySchema,
  listAppointmentsQuerySchema,
  noShowSchema,
  rescheduleAppointmentSchema,
} from "./appointment.schemas.js";

/**
 * Hospital plane appointment API (Phase 18.6).
 *
 * The tenant and actor always come from the verified session context via
 * `requireTenant`; no route accepts a `tenantId` from the URL, query or body.
 * Permission keys are the ones already seeded in the RBAC catalogue:
 *
 *   appointment:read   - availability, list, detail, code lookup, history
 *   appointment:create - booking (requires an Idempotency-Key)
 *   appointment:update - reschedule and lifecycle transitions
 *   appointment:cancel - cancellation
 *
 * There is deliberately no generic status/update endpoint: status changes only
 * happen through the lifecycle operations, and the services enforce the
 * transition table, doctor scope and tenant ownership.
 */
export const appointmentRouter: Router = Router();

/* Read-only availability; never creates or reserves an appointment. */
appointmentRouter.get(
  "/availability",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({ query: availabilityQuerySchema }),
  getAvailabilityHandler,
);

appointmentRouter.get(
  "/availability/:doctorId",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({
    params: doctorAvailabilityParamsSchema,
    query: doctorAvailabilityQuerySchema,
  }),
  getDoctorAvailabilityHandler,
);

/* Registered before `/:appointmentId` so "code" is never parsed as an id. */
appointmentRouter.get(
  "/code/:appointmentCode",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({ params: appointmentCodeParamsSchema }),
  getAppointmentByCodeHandler,
);

appointmentRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:create"),
  validate({ body: createAppointmentSchema }),
  createAppointmentHandler,
);

appointmentRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({ query: listAppointmentsQuerySchema }),
  listAppointmentsHandler,
);

appointmentRouter.get(
  "/:appointmentId",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({ params: appointmentIdParamsSchema }),
  getAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/reschedule",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:update"),
  validate({
    params: appointmentIdParamsSchema,
    body: rescheduleAppointmentSchema,
  }),
  rescheduleAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/cancel",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:cancel"),
  validate({
    params: appointmentIdParamsSchema,
    body: cancelAppointmentSchema,
  }),
  cancelAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/check-in",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:update"),
  validate({ params: appointmentIdParamsSchema }),
  checkInAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/start",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:update"),
  validate({ params: appointmentIdParamsSchema }),
  startAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/complete",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:update"),
  validate({ params: appointmentIdParamsSchema }),
  completeAppointmentHandler,
);

appointmentRouter.post(
  "/:appointmentId/no-show",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("appointment:update"),
  validate({ params: appointmentIdParamsSchema, body: noShowSchema }),
  noShowAppointmentHandler,
);

appointmentRouter.get(
  "/:appointmentId/history",
  authenticate,
  requireTenant,
  requirePermission("appointment:read"),
  validate({ params: appointmentIdParamsSchema }),
  getAppointmentHistoryHandler,
);
