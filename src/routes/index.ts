import { Router } from "express";
import { appointmentRouter } from "../modules/appointments/appointment.routes.js";
import { auditRouter } from "../modules/audit/audit.routes.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { paymentRouter } from "../modules/billing/payment.routes.js";
import { refundRouter } from "../modules/billing/refund.routes.js";
import { billingDocumentRouter } from "../modules/billing/documents/billing-document.routes.js";
import { billingReportRouter } from "../modules/billing/reports/billing-report.routes.js";
import { branchRouter } from "../modules/branches/branch.routes.js";
import { dashboardRouter } from "../modules/dashboard/dashboard.routes.js";
import { departmentRouter } from "../modules/departments/department.routes.js";
import { doctorRouter } from "../modules/doctors/doctor.routes.js";
import { healthRouter } from "../modules/health/health.routes.js";
import { doctorLeaveRouter } from "../modules/leaves/leave.routes.js";
import { notificationRouter } from "../modules/notifications/notification.routes.js";
import { patientRouter } from "../modules/patients/patient.routes.js";
import { patientPortalRouter } from "../modules/patients/patient.portal.routes.js";
import { doctorBreakRouter } from "../modules/schedules/break.routes.js";
import { doctorScheduleRouter } from "../modules/schedules/schedule.routes.js";
import {
  tenantRegistrationRouter,
  tenantScopeRouter,
} from "../modules/tenancy/tenant.routes.js";
import { platformRouter } from "./platform.routes.js";
import { tenantRouter } from "./tenant.routes.js";

/**
 * Single mount point for versioned API routes.
 * Feature modules are registered here, e.g.
 *   apiRouter.use("/patients", patientRouter);
 */
export const apiRouter: Router = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/branches", branchRouter);
apiRouter.use("/departments", departmentRouter);
apiRouter.use("/doctors", doctorRouter);
apiRouter.use("/doctor-schedules", doctorScheduleRouter);
apiRouter.use("/doctor-breaks", doctorBreakRouter);
apiRouter.use("/doctor-leaves", doctorLeaveRouter);
apiRouter.use("/patients", patientRouter);
// Public patient registration plus the self-service portal. These routes do
// not require a tenant membership; a patient login is a global account linked
// to `patient_profiles.user_id`. Mounted at the API root because the public
// registration path (`/registrations`) and the portal paths share one router.
apiRouter.use(patientPortalRouter);
apiRouter.use("/appointments", appointmentRouter);
apiRouter.use("/audit-logs", auditRouter);
apiRouter.use("/notifications", notificationRouter);
apiRouter.use("/payments", paymentRouter);
apiRouter.use("/refunds", refundRouter);
apiRouter.use("/billing-documents", billingDocumentRouter);
apiRouter.use("/billing-reports", billingReportRouter);
apiRouter.use("/dashboard", dashboardRouter);

// Platform (cross-tenant) routes live under their own prefix.
apiRouter.use("/platform", platformRouter);

// Self-service hospital actions (register, memberships, select, settings).
apiRouter.use("/tenants", tenantRegistrationRouter);

// Hospital-scoped management; tenant identity comes from the session context.
apiRouter.use("/tenant", tenantScopeRouter);

// Hospital-scoped routes share one mount point so guards are applied uniformly.
apiRouter.use(tenantRouter);
