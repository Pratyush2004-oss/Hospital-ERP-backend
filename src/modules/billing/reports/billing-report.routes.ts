import { Router } from "express";
import { authenticate } from "../../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../../middleware/authorization.js";
import { validate } from "../../../middleware/validate.js";
import {
  getBranchBreakdownHandler,
  getDepartmentBreakdownHandler,
  getDoctorBreakdownHandler,
  getInvoiceStatusReportHandler,
  getInvoiceTypeBreakdownHandler,
  getOutstandingReportHandler,
  getPaymentMethodBreakdownHandler,
  getPaymentSummaryHandler,
  getPendingOverdueReportHandler,
  getRefundSummaryHandler,
  getRevenueReportHandler,
  getRevenueTrendHandler,
  listOutstandingInvoicesHandler,
} from "./billing-report.controller.js";
import {
  datedReportQuerySchema,
  outstandingInvoiceQuerySchema,
  outstandingReportQuerySchema,
  revenueTrendQuerySchema,
} from "./billing-report.schemas.js";

/**
 * Billing reporting API (Phase 19.9.2).
 *
 * Every route is authenticated, requires hospital (tenant) context and the
 * seeded `reports:read` permission. CSV is selected with `format=csv`, which
 * additionally requires `reports:export` in the controller. The tenant is never
 * accepted from request input, and a supplied `branchId` is verified against
 * that tenant before the service runs.
 *
 * Reports are aggregate queries except `/outstanding/invoices`, which is the
 * only record-level endpoint and is paginated (`page`, `limit`). CSV for that
 * endpoint is capped at 5,000 rows by the service.
 */
export const billingReportRouter: Router = Router();

const readGuard = [
  authenticate,
  requireTenant,
  requirePermission("reports:read"),
] as const;

billingReportRouter.get(
  "/revenue",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getRevenueReportHandler,
);

billingReportRouter.get(
  "/revenue/trends",
  ...readGuard,
  validate({ query: revenueTrendQuerySchema }),
  getRevenueTrendHandler,
);

billingReportRouter.get(
  "/outstanding",
  ...readGuard,
  validate({ query: outstandingReportQuerySchema }),
  getOutstandingReportHandler,
);

billingReportRouter.get(
  "/outstanding/invoices",
  ...readGuard,
  validate({ query: outstandingInvoiceQuerySchema }),
  listOutstandingInvoicesHandler,
);

billingReportRouter.get(
  "/pending-overdue",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getPendingOverdueReportHandler,
);

billingReportRouter.get(
  "/payment-summary",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getPaymentSummaryHandler,
);

billingReportRouter.get(
  "/refund-summary",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getRefundSummaryHandler,
);

billingReportRouter.get(
  "/invoice-status",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getInvoiceStatusReportHandler,
);

billingReportRouter.get(
  "/branches",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getBranchBreakdownHandler,
);

billingReportRouter.get(
  "/payment-methods",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getPaymentMethodBreakdownHandler,
);

billingReportRouter.get(
  "/invoice-types",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getInvoiceTypeBreakdownHandler,
);

billingReportRouter.get(
  "/doctors",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getDoctorBreakdownHandler,
);

billingReportRouter.get(
  "/departments",
  ...readGuard,
  validate({ query: datedReportQuerySchema }),
  getDepartmentBreakdownHandler,
);
