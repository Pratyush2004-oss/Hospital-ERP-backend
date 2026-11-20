import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import {
  getAppointmentDashboardHandler,
  getDoctorDashboardHandler,
  getFinancialDashboardHandler,
  getOperationalDashboardHandler,
  getPatientDashboardHandler,
} from "./dashboard.controller.js";
import { dashboardQuerySchema } from "./dashboard.schemas.js";

/**
 * Dashboard analytics API (Phase 22.2).
 *
 * Read-only endpoints over the Phase 22.1 aggregation. All routes require an
 * authenticated member of the current hospital and the seeded `reports:read`
 * permission. Each summary additionally requires the read permission of the
 * data it exposes:
 *
 * | Endpoint | Extra permission |
 * | --- | --- |
 * | `GET /dashboard/operational` | sections filtered by `appointment:read`, `patient:read`, `doctor:read` |
 * | `GET /dashboard/appointments` | `appointment:read` |
 * | `GET /dashboard/patients` | `patient:read` |
 * | `GET /dashboard/doctors` | `doctor:read` |
 * | `GET /dashboard/financial` | `payment:read` |
 *
 * The tenant is never accepted from request input, and a supplied `branchId`
 * is verified against that tenant before aggregation (foreign branch = 404).
 */
export const dashboardRouter: Router = Router();

const reportGuard = [
  authenticate,
  requireTenant,
  requirePermission("reports:read"),
] as const;

dashboardRouter.get(
  "/operational",
  ...reportGuard,
  validate({ query: dashboardQuerySchema }),
  getOperationalDashboardHandler,
);

dashboardRouter.get(
  "/appointments",
  ...reportGuard,
  requirePermission("appointment:read"),
  validate({ query: dashboardQuerySchema }),
  getAppointmentDashboardHandler,
);

dashboardRouter.get(
  "/patients",
  ...reportGuard,
  requirePermission("patient:read"),
  validate({ query: dashboardQuerySchema }),
  getPatientDashboardHandler,
);

dashboardRouter.get(
  "/doctors",
  ...reportGuard,
  requirePermission("doctor:read"),
  validate({ query: dashboardQuerySchema }),
  getDoctorDashboardHandler,
);

dashboardRouter.get(
  "/financial",
  ...reportGuard,
  requirePermission("payment:read"),
  validate({ query: dashboardQuerySchema }),
  getFinancialDashboardHandler,
);
