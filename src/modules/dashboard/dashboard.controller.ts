import type { RequestHandler } from "express";
import { sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import { getDashboardAnalytics } from "./dashboard.service.js";
import { dashboardQuerySchema, type DashboardQuery } from "./dashboard.schemas.js";
import type { DashboardAnalytics } from "./dashboard.types.js";

/**
 * HTTP layer for dashboard analytics (Phase 22.2).
 *
 * Every handler delegates to the single Phase 22.1 aggregation, so metric
 * definitions, timezone boundaries and financial reuse live in one place. The
 * controller only translates the validated query with the verified tenant and
 * produces the section-specific response envelope.
 *
 * Authorization:
 * - `reports:read` is enforced on the router for every endpoint.
 * - Module read permissions are enforced per endpoint (appointment, patient,
 *   doctor, payment) and, for the composed operational view, applied as a
 *   response filter. A caller therefore never receives a section its effective
 *   permission set does not cover.
 * - The branch is verified to belong to the caller's hospital by the service
 *   before any aggregate runs.
 */

type SectionPermissions = {
  readonly appointments: boolean;
  readonly patients: boolean;
  readonly doctors: boolean;
};

function filtersOf(query: DashboardQuery) {
  return {
    fromDate: query.fromDate,
    toDate: query.toDate,
    branchId: query.branchId,
    timezone: query.timezone,
  };
}

/** Range and snapshot metadata shared by every dashboard response. */
function rangeMeta(analytics: DashboardAnalytics) {
  return {
    fromDate: analytics.fromDate,
    toDate: analytics.toDate,
    branchId: analytics.branchId,
    timezone: analytics.timezone,
    asOf: analytics.asOf,
  };
}

async function analyticsFor(query: DashboardQuery): Promise<DashboardAnalytics> {
  const scope = requireTenantScope();

  return getDashboardAnalytics(scope.tenantId, filtersOf(query), {
    permissions: scope.permissions,
  });
}

export const getOperationalDashboardHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof dashboardQuerySchema>(res.req, "query");
  const analytics = await analyticsFor(query);

  const sectionPermissions: SectionPermissions = {
    appointments: scope.permissions.has("appointment:read"),
    patients: scope.permissions.has("patient:read"),
    doctors: scope.permissions.has("doctor:read"),
  };

  const operational: Record<string, unknown> = { ...rangeMeta(analytics) };
  if (sectionPermissions.appointments) operational.appointments = analytics.appointments;
  if (sectionPermissions.patients) operational.patients = analytics.patients;
  if (sectionPermissions.doctors) operational.doctors = analytics.doctors;

  sendSuccess(res, { operational });
};

export const getAppointmentDashboardHandler: RequestHandler = async (_req, res) => {
  const query = getValidated<typeof dashboardQuerySchema>(res.req, "query");
  const analytics = await analyticsFor(query);

  sendSuccess(res, {
    appointments: { ...rangeMeta(analytics), ...analytics.appointments },
  });
};

export const getPatientDashboardHandler: RequestHandler = async (_req, res) => {
  const query = getValidated<typeof dashboardQuerySchema>(res.req, "query");
  const analytics = await analyticsFor(query);

  sendSuccess(res, {
    patients: { ...rangeMeta(analytics), ...analytics.patients },
  });
};

export const getDoctorDashboardHandler: RequestHandler = async (_req, res) => {
  const query = getValidated<typeof dashboardQuerySchema>(res.req, "query");
  const analytics = await analyticsFor(query);

  sendSuccess(res, {
    doctors: { ...rangeMeta(analytics), ...analytics.doctors },
  });
};

export const getFinancialDashboardHandler: RequestHandler = async (_req, res) => {
  const query = getValidated<typeof dashboardQuerySchema>(res.req, "query");
  const analytics = await analyticsFor(query);

  sendSuccess(res, {
    financial: { ...rangeMeta(analytics), ...analytics.financial },
  });
};
