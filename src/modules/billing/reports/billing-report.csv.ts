import type { Response } from "express";
import { stringify } from "csv-stringify/sync";
import type {
  BranchRevenueRow,
  DepartmentBillingRow,
  DoctorBillingRow,
  InvoiceTypeRevenueRow,
  OutstandingBalanceSummary,
  OutstandingInvoicePage,
  PaymentMethodRevenueRow,
  PendingOverdueSummary,
  RevenueSummary,
  RevenueTimeSeries,
  StatusDistributionRow,
} from "./billing-report.types.js";

/**
 * CSV projections of the billing reports (Phase 19.9.2).
 *
 * These functions only reshape results already produced by the reporting
 * service. They never query, aggregate or recalculate money, so a CSV can never
 * disagree with the JSON report for the same filters.
 *
 * Output is bounded by construction: every aggregate report has at most one row
 * per status/currency/dimension member, and the record-level outstanding export
 * is capped by the service page size (5,000 rows) in the controller.
 */

interface CsvColumn {
  readonly key: string;
  readonly header: string;
}

type CsvRow = Record<string, string | number | null>;

function serialize(columns: readonly CsvColumn[], rows: readonly CsvRow[]): string {
  return stringify([...rows], {
    header: true,
    columns: columns.map((column) => ({ key: column.key, header: column.header })),
  });
}

export function revenueCsv(report: RevenueSummary): string {
  const currencies = [
    ...new Set([
      ...report.invoiced.map((row) => row.currency),
      ...report.collected.map((row) => row.currency),
      ...report.refunded.map((row) => row.currency),
      ...report.outstanding.map((row) => row.currency),
    ]),
  ].sort();

  const invoiced = new Map(report.invoiced.map((row) => [row.currency, row.amount]));
  const collected = new Map(report.collected.map((row) => [row.currency, row.amount]));
  const refunded = new Map(report.refunded.map((row) => [row.currency, row.amount]));
  const net = new Map(report.netCollected.map((row) => [row.currency, row.amount]));
  const outstanding = new Map(report.outstanding.map((row) => [row.currency, row.amount]));

  return serialize(
    [
      { key: "from_date", header: "from_date" },
      { key: "to_date", header: "to_date" },
      { key: "timezone", header: "timezone" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
      { key: "outstanding", header: "outstanding" },
    ],
    currencies.map((currency) => ({
      from_date: report.fromDate,
      to_date: report.toDate,
      timezone: report.timezone,
      currency,
      invoice_count: report.invoiceCount,
      invoiced: invoiced.get(currency) ?? "0.00",
      collected: collected.get(currency) ?? "0.00",
      refunded: refunded.get(currency) ?? "0.00",
      net_collected: net.get(currency) ?? "0.00",
      outstanding: outstanding.get(currency) ?? "0.00",
    })),
  );
}

export function revenueTrendCsv(report: RevenueTimeSeries): string {
  return serialize(
    [
      { key: "period", header: "period" },
      { key: "granularity", header: "granularity" },
      { key: "currency", header: "currency" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
    ],
    report.points.map((point) => ({
      period: point.period,
      granularity: report.granularity,
      currency: point.currency,
      invoiced: point.invoiced,
      collected: point.collected,
      refunded: point.refunded,
      net_collected: point.netCollected,
    })),
  );
}

export function outstandingCsv(report: OutstandingBalanceSummary): string {
  return serialize(
    [
      { key: "as_of", header: "as_of" },
      { key: "timezone", header: "timezone" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "outstanding", header: "outstanding" },
    ],
    report.outstanding.map((row) => ({
      as_of: report.asOf,
      timezone: report.timezone,
      currency: row.currency,
      invoice_count: report.invoiceCount,
      outstanding: row.amount,
    })),
  );
}

export function outstandingInvoicesCsv(report: OutstandingInvoicePage): string {
  return serialize(
    [
      { key: "invoice_number", header: "invoice_number" },
      { key: "status", header: "status" },
      { key: "invoice_type", header: "invoice_type" },
      { key: "issue_date", header: "issue_date" },
      { key: "due_date", header: "due_date" },
      { key: "branch", header: "branch" },
      { key: "currency", header: "currency" },
      { key: "total_amount", header: "total_amount" },
      { key: "amount_paid", header: "amount_paid" },
      { key: "balance_due", header: "balance_due" },
      { key: "as_of", header: "as_of" },
    ],
    report.invoices.map((invoice) => ({
      invoice_number: invoice.invoiceNumber,
      status: invoice.invoiceStatus,
      invoice_type: invoice.invoiceType,
      issue_date: invoice.issueDate,
      due_date: invoice.dueDate,
      branch: invoice.branchName,
      currency: invoice.currency,
      total_amount: invoice.totalAmount,
      amount_paid: invoice.amountPaid,
      balance_due: invoice.balanceDue,
      as_of: report.asOf,
    })),
  );
}

export function pendingOverdueCsv(report: PendingOverdueSummary): string {
  const rows: CsvRow[] = [];
  for (const [category, group] of [
    ["PENDING", report.pending],
    ["OVERDUE", report.overdue],
  ] as const) {
    for (const row of group.outstanding) {
      rows.push({
        category,
        from_date: report.fromDate,
        to_date: report.toDate,
        currency: row.currency,
        invoice_count: group.invoiceCount,
        outstanding: row.amount,
      });
    }
  }

  return serialize(
    [
      { key: "category", header: "category" },
      { key: "from_date", header: "from_date" },
      { key: "to_date", header: "to_date" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "outstanding", header: "outstanding" },
    ],
    rows,
  );
}

export function statusDistributionCsv(
  category: "invoice" | "payment" | "refund",
  rows: readonly StatusDistributionRow[],
): string {
  return serialize(
    [
      { key: "category", header: "category" },
      { key: "status", header: "status" },
      { key: "currency", header: "currency" },
      { key: "count", header: "count" },
      { key: "amount", header: "amount" },
    ],
    rows.flatMap((row) =>
      row.totals.map((total) => ({
        category,
        status: row.status,
        currency: total.currency,
        count: row.count,
        amount: total.amount,
      })),
    ),
  );
}

export function branchBreakdownCsv(rows: readonly BranchRevenueRow[]): string {
  return serialize(
    [
      { key: "branch_id", header: "branch_id" },
      { key: "branch", header: "branch" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
      { key: "outstanding", header: "outstanding" },
    ],
    rows.map((row) => ({
      branch_id: row.branchId,
      branch: row.branchName,
      currency: row.currency,
      invoice_count: row.invoiceCount,
      invoiced: row.invoiced,
      collected: row.collected,
      refunded: row.refunded,
      net_collected: row.netCollected,
      outstanding: row.outstanding,
    })),
  );
}

export function paymentMethodBreakdownCsv(rows: readonly PaymentMethodRevenueRow[]): string {
  return serialize(
    [
      { key: "payment_method", header: "payment_method" },
      { key: "currency", header: "currency" },
      { key: "payment_count", header: "payment_count" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
    ],
    rows.map((row) => ({
      payment_method: row.paymentMethod,
      currency: row.currency,
      payment_count: row.paymentCount,
      collected: row.collected,
      refunded: row.refunded,
      net_collected: row.netCollected,
    })),
  );
}

export function invoiceTypeBreakdownCsv(rows: readonly InvoiceTypeRevenueRow[]): string {
  return serialize(
    [
      { key: "invoice_type", header: "invoice_type" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "outstanding", header: "outstanding" },
    ],
    rows.map((row) => ({
      invoice_type: row.invoiceType,
      currency: row.currency,
      invoice_count: row.invoiceCount,
      invoiced: row.invoiced,
      collected: row.collected,
      refunded: row.refunded,
      outstanding: row.outstanding,
    })),
  );
}

export function doctorBreakdownCsv(rows: readonly DoctorBillingRow[]): string {
  return serialize(
    [
      { key: "doctor_id", header: "doctor_id" },
      { key: "doctor_code", header: "doctor_code" },
      { key: "doctor_name", header: "doctor_name" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
    ],
    rows.map((row) => ({
      doctor_id: row.doctorId,
      doctor_code: row.doctorCode,
      doctor_name: row.doctorName,
      currency: row.currency,
      invoice_count: row.invoiceCount,
      invoiced: row.invoiced,
      collected: row.collected,
      refunded: row.refunded,
      net_collected: row.netCollected,
    })),
  );
}

export function departmentBreakdownCsv(rows: readonly DepartmentBillingRow[]): string {
  return serialize(
    [
      { key: "department_id", header: "department_id" },
      { key: "department", header: "department" },
      { key: "currency", header: "currency" },
      { key: "invoice_count", header: "invoice_count" },
      { key: "invoiced", header: "invoiced" },
      { key: "collected", header: "collected" },
      { key: "refunded", header: "refunded" },
      { key: "net_collected", header: "net_collected" },
    ],
    rows.map((row) => ({
      department_id: row.departmentId,
      department: row.departmentName,
      currency: row.currency,
      invoice_count: row.invoiceCount,
      invoiced: row.invoiced,
      collected: row.collected,
      refunded: row.refunded,
      net_collected: row.netCollected,
    })),
  );
}

/** Sends a CSV attachment; never cached because it contains financial data. */
export function sendReportCsv(res: Response, name: string, csv: string): Response {
  const stamp = new Date().toISOString().slice(0, 10);
  return res
    .status(200)
    .type("text/csv; charset=utf-8")
    .set("Cache-Control", "no-store")
    .set("Content-Disposition", `attachment; filename="${name}-${stamp}.csv"`)
    .send(csv);
}
