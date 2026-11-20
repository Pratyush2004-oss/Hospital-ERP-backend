import type { RequestHandler } from "express";
import { AppError } from "../../../lib/http-error.js";
import { sendSuccess } from "../../../lib/api-response.js";
import { requireTenantScope } from "../../../lib/request-context.js";
import { getValidated } from "../../../middleware/validate.js";
import {
  branchBreakdownCsv,
  departmentBreakdownCsv,
  doctorBreakdownCsv,
  invoiceTypeBreakdownCsv,
  outstandingCsv,
  outstandingInvoicesCsv,
  paymentMethodBreakdownCsv,
  pendingOverdueCsv,
  revenueCsv,
  revenueTrendCsv,
  sendReportCsv,
  statusDistributionCsv,
} from "./billing-report.csv.js";
import {
  assertReportBranchAccess,
  getBranchRevenueBreakdown,
  getDepartmentBillingSummary,
  getDoctorBillingSummary,
  getInvoiceStatusDistribution,
  getInvoiceTypeRevenueBreakdown,
  getOutstandingBalances,
  getPaymentMethodRevenueBreakdown,
  getPaymentStatusDistribution,
  getPendingAndOverdueInvoices,
  getRefundStatusDistribution,
  getRevenueSummary,
  getRevenueTimeSeries,
  listOutstandingInvoices,
} from "./billing-report.service.js";
import type {
  BillingReportFilters,
  DatedBillingReportFilters,
} from "./billing-report.types.js";
import {
  datedReportQuerySchema,
  outstandingInvoiceQuerySchema,
  outstandingReportQuerySchema,
  revenueTrendQuerySchema,
  type DatedReportQuery,
} from "./billing-report.schemas.js";

/**
 * HTTP layer for billing reports (Phase 19.9.2).
 *
 * Controllers only validate/translate query parameters and shape the response.
 * Every aggregation, currency separation, timezone boundary and tenant filter
 * remains in the Phase 19.9.1 service. CSV responses are projections of the
 * same service result, never a second calculation path.
 *
 * Authorization:
 * - `reports:read` is enforced on the router;
 * - `format=csv` additionally requires `reports:export`;
 * - the tenant always comes from the session, and an explicit `branchId` is
 *   verified to belong to that tenant before any query runs.
 */

interface ReportQueryBase {
  readonly branchId?: string;
  readonly paymentMethod?: BillingReportFilters["paymentMethod"];
  readonly invoiceType?: BillingReportFilters["invoiceType"];
  readonly invoiceStatus?: BillingReportFilters["invoiceStatus"];
  readonly paymentStatus?: BillingReportFilters["paymentStatus"];
  readonly refundStatus?: BillingReportFilters["refundStatus"];
  readonly doctorId?: string;
  readonly departmentId?: string;
  readonly timezone?: string;
  readonly format: "json" | "csv";
}

function commonFilters(query: ReportQueryBase): BillingReportFilters {
  return {
    branchId: query.branchId,
    paymentMethod: query.paymentMethod,
    invoiceType: query.invoiceType,
    invoiceStatus: query.invoiceStatus,
    paymentStatus: query.paymentStatus,
    refundStatus: query.refundStatus,
    doctorId: query.doctorId,
    departmentId: query.departmentId,
    timezone: query.timezone,
  };
}

function datedFilters(query: DatedReportQuery): DatedBillingReportFilters {
  return { ...commonFilters(query), fromDate: query.fromDate, toDate: query.toDate };
}

function canExport(query: ReportQueryBase): boolean {
  return query.format === "csv";
}

function assertExportPermission(permissions: ReadonlySet<string>): void {
  if (!permissions.has("reports:export")) {
    throw AppError.forbidden("You do not have permission to export reports");
  }
}

/** Resolves and authorizes the optional branch filter before any report read. */
async function authorizeQuery(tenantId: string, query: ReportQueryBase): Promise<void> {
  if (canExport(query)) assertExportPermission(requireTenantScope().permissions);
  await assertReportBranchAccess(tenantId, query.branchId);
}

export const getRevenueReportHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getRevenueSummary(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-revenue", revenueCsv(report));
    return;
  }

  sendSuccess(res, { revenue: report });
};

export const getRevenueTrendHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof revenueTrendQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getRevenueTimeSeries(scope.tenantId, {
    ...datedFilters(query),
    granularity: query.granularity,
  });
  if (query.format === "csv") {
    sendReportCsv(res, "billing-revenue-trends", revenueTrendCsv(report));
    return;
  }

  sendSuccess(res, { trends: report });
};

export const getOutstandingReportHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof outstandingReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getOutstandingBalances(scope.tenantId, {
    ...commonFilters(query),
    fromDate: query.fromDate,
    asOf: query.asOf,
  });

  if (query.format === "csv") {
    sendReportCsv(res, "billing-outstanding", outstandingCsv(report));
    return;
  }

  sendSuccess(res, { outstanding: report });
};

export const listOutstandingInvoicesHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof outstandingInvoiceQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await listOutstandingInvoices(scope.tenantId, {
    ...commonFilters(query),
    fromDate: query.fromDate,
    asOf: query.asOf,
    state: query.state,
    // Exports are bounded by the service cap instead of the interactive page
    // size; filters are identical, so the CSV matches the JSON report.
    page: query.format === "csv" ? 1 : query.page,
    pageSize: query.format === "csv" ? 5_000 : query.limit,
  });

  if (query.format === "csv") {
    if (report.total > report.pageSize) {
      res.set("X-Report-Truncated", "true");
      res.set("X-Report-Total-Rows", String(report.total));
    }
    sendReportCsv(res, "billing-outstanding-invoices", outstandingInvoicesCsv(report));
    return;
  }

  sendSuccess(res, { invoices: report.invoices, asOf: report.asOf, state: report.state }, 200, {
    pagination: {
      page: report.page,
      pageSize: report.pageSize,
      total: report.total,
      totalPages: report.totalPages,
    },
  });
};

export const getPendingOverdueReportHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getPendingAndOverdueInvoices(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-pending-overdue", pendingOverdueCsv(report));
    return;
  }

  sendSuccess(res, { pendingOverdue: report });
};

export const getPaymentSummaryHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getPaymentStatusDistribution(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-payment-summary", statusDistributionCsv("payment", report));
    return;
  }

  sendSuccess(res, { payments: report });
};

export const getRefundSummaryHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getRefundStatusDistribution(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-refund-summary", statusDistributionCsv("refund", report));
    return;
  }

  sendSuccess(res, { refunds: report });
};

export const getInvoiceStatusReportHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getInvoiceStatusDistribution(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-invoice-status", statusDistributionCsv("invoice", report));
    return;
  }

  sendSuccess(res, { invoiceStatus: report });
};

export const getBranchBreakdownHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getBranchRevenueBreakdown(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-branches", branchBreakdownCsv(report));
    return;
  }

  sendSuccess(res, { branches: report });
};

export const getPaymentMethodBreakdownHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getPaymentMethodRevenueBreakdown(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-payment-methods", paymentMethodBreakdownCsv(report));
    return;
  }

  sendSuccess(res, { paymentMethods: report });
};

export const getInvoiceTypeBreakdownHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getInvoiceTypeRevenueBreakdown(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-invoice-types", invoiceTypeBreakdownCsv(report));
    return;
  }

  sendSuccess(res, { invoiceTypes: report });
};

export const getDoctorBreakdownHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getDoctorBillingSummary(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-doctors", doctorBreakdownCsv(report));
    return;
  }

  sendSuccess(res, { doctors: report });
};

export const getDepartmentBreakdownHandler: RequestHandler = async (_req, res) => {
  const scope = requireTenantScope();
  const query = getValidated<typeof datedReportQuerySchema>(res.req, "query");
  await authorizeQuery(scope.tenantId, query);

  const report = await getDepartmentBillingSummary(scope.tenantId, datedFilters(query));
  if (query.format === "csv") {
    sendReportCsv(res, "billing-departments", departmentBreakdownCsv(report));
    return;
  }

  sendSuccess(res, { departments: report });
};
