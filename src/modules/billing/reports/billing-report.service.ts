import { and, asc, eq, gte, lte, notInArray, sql, type Column, type SQL } from "drizzle-orm";
import { withTenantTransaction, type DatabaseTransaction } from "../../../database/context.js";
import {
  appointments,
  branches,
  departments,
  doctors,
  invoicePayments,
  invoiceRefunds,
  invoices,
  paymentAllocations,
  payments,
  tenants,
  users,
} from "../../../database/schema/index.js";
import { AppError } from "../../../lib/http-error.js";
import type {
  BillingReportFilters,
  BranchRevenueRow,
  CurrencyAmount,
  DatedBillingReportFilters,
  DepartmentBillingRow,
  DoctorBillingRow,
  InvoiceTypeRevenueRow,
  OutstandingBalanceSummary,
  OutstandingInvoiceListFilters,
  OutstandingInvoicePage,
  PaymentMethodRevenueRow,
  PaymentRefundSummary,
  PendingOverdueSummary,
  ReportGranularity,
  RevenuePoint,
  RevenueSummary,
  RevenueTimeSeries,
  StatusDistributionRow,
} from "./billing-report.types.js";

/**
 * Billing reporting and financial aggregation (Phase 19.9.1).
 *
 * Design rules:
 * - Every number is produced by a PostgreSQL aggregate over persisted records;
 *   rows are never loaded into application memory to be summed.
 * - Money stays `NUMERIC`/decimal: aggregates are cast to text and only added or
 *   subtracted in application code as fixed-point integers (`BigInt` cents), and
 *   totals are grouped by currency so different currencies are never mixed.
 * - Invoice dates (`issue_date`) are already branch-local calendar dates. Payment
 *   and refund timestamps are absolute instants, so their range is resolved with
 *   the branch/hospital IANA timezone: `[from 00:00, to+1 00:00)`.
 * - "Collected" is receipt-level successful payments, so one receipt that pays
 *   several invoices is counted once. When an invoice-type filter is supplied,
 *   collected/refunded money is attributed through payment allocations / refund
 *   invoice links instead, so each part of a receipt is counted exactly once.
 * - Draft and cancelled invoices are not revenue. Only SUCCESSFUL payments count
 *   as collected and only SUCCESSFUL refunds reduce net collections.
 * - All reads run inside `withTenantTransaction`, so both the explicit
 *   `tenant_id` predicates and RLS constrain every query.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_RANGE_DAYS = 366;
const MAX_REPORT_PAGE_SIZE = 5_000;

const GRANULARITIES: readonly ReportGranularity[] = ["day", "week", "month"];
const PAYMENT_METHODS = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"] as const;
const INVOICE_TYPES = [
  "CONSULTATION",
  "PHARMACY",
  "LABORATORY",
  "PROCEDURE",
  "ADMISSION",
  "OTHER",
] as const;

type MoneyRow = { readonly currency: string; readonly amount: string; readonly count: number };
type NamedMoneyRow = MoneyRow & {
  readonly key: string;
  readonly code: string;
  readonly name: string | null;
};
type MoneyMap = Map<string, bigint>;

const ZERO = "0.00";

function validation(message: string, field: string): AppError {
  return AppError.validation(message, { field });
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    throw validation("tenantId must be a UUID", "tenantId");
  }
}

function assertUuid(value: string | undefined, field: string): void {
  if (value !== undefined && (typeof value !== "string" || !UUID_PATTERN.test(value))) {
    throw validation(`${field} must be a UUID`, field);
  }
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertDate(value: string | undefined, field: string): asserts value is string {
  if (value === undefined) throw validation(`${field} is required`, field);
  if (!isRealDate(value)) throw validation(`${field} must be a valid YYYY-MM-DD date`, field);
}

function assertRange(filters: BillingReportFilters): asserts filters is DatedBillingReportFilters {
  assertDate(filters.fromDate, "fromDate");
  assertDate(filters.toDate, "toDate");
  if (filters.fromDate > filters.toDate) {
    throw validation("fromDate must not be after toDate", "fromDate");
  }

  const days = Math.floor(
    (Date.parse(`${filters.toDate}T00:00:00Z`) - Date.parse(`${filters.fromDate}T00:00:00Z`)) /
      86_400_000,
  );
  if (days > MAX_REPORT_RANGE_DAYS - 1) {
    throw validation(`Report range must not exceed ${MAX_REPORT_RANGE_DAYS} days`, "toDate");
  }
}

function assertGranularity(value: string): asserts value is ReportGranularity {
  if (!GRANULARITIES.includes(value as ReportGranularity)) {
    throw validation("granularity must be day, week or month", "granularity");
  }
}

function assertFilters(filters: BillingReportFilters): void {
  assertUuid(filters.branchId, "branchId");
  assertUuid(filters.doctorId, "doctorId");
  assertUuid(filters.departmentId, "departmentId");

  if (filters.paymentMethod !== undefined && !PAYMENT_METHODS.includes(filters.paymentMethod)) {
    throw validation("paymentMethod is not supported", "paymentMethod");
  }
  if (filters.invoiceType !== undefined && !INVOICE_TYPES.includes(filters.invoiceType)) {
    throw validation("invoiceType is not supported", "invoiceType");
  }
  if (filters.timezone !== undefined) assertTimezone(filters.timezone);
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw validation("timezone must be a valid IANA timezone", "timezone");
  }
}

/** Fixed-point cents; PostgreSQL `NUMERIC(12,2)` always arrives with 2 decimals. */
function toCents(amount: string): bigint {
  const normalized = String(amount ?? ZERO).trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = `${whole || "0"}${fraction.padEnd(2, "0").slice(0, 2)}`;
  return BigInt(cents) * (negative ? -1n : 1n);
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

function addToMap(map: MoneyMap, currency: string, amount: string): void {
  map.set(currency, (map.get(currency) ?? 0n) + toCents(amount));
}

function mapToAmounts(map: MoneyMap): CurrencyAmount[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, amount: fromCents(cents) }));
}

function netAmounts(collected: readonly CurrencyAmount[], refunded: readonly CurrencyAmount[]): CurrencyAmount[] {
  const map: MoneyMap = new Map();
  for (const row of collected) addToMap(map, row.currency, row.amount);
  for (const row of refunded) addToMap(map, row.currency, `-${row.amount}`);
  return mapToAmounts(map);
}

function sumCounts(rows: readonly { count: number }[]): number {
  return rows.reduce((total, row) => total + row.count, 0);
}

/** `[fromDate 00:00, toDate+1 00:00)` in the resolved IANA timezone. */
export function instantRange(
  column: SQL | Column,
  fromDate: string,
  toDate: string,
  timezone: string,
): SQL {
  return and(
    sql`${column} >= (${fromDate}::date::timestamp AT TIME ZONE ${timezone})`,
    sql`${column} < ((${toDate}::date + 1)::timestamp AT TIME ZONE ${timezone})`,
  )!;
}

function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: "year" | "month" | "day"): string =>
    parts.find((entry) => entry.type === type)?.value ?? "01";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Verifies an optional branch filter against the caller's tenant before any
 * report query runs. Memberships are tenant-wide (no branch-scoped membership
 * exists), so this is the enforceable branch boundary: a branch that belongs to
 * another hospital cannot be probed through `branchId`.
 */
export async function assertReportBranchAccess(
  tenantId: string,
  branchId: string | undefined,
): Promise<void> {
  assertTenantId(tenantId);
  assertUuid(branchId, "branchId");
  if (branchId === undefined) return;

  await withTenantTransaction(tenantId, async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)))
      .limit(1);

    if (!branch) throw AppError.notFound("Branch not found");
  });
}

export async function resolveTimezone(
  tx: DatabaseTransaction,
  tenantId: string,
  filters: BillingReportFilters,
): Promise<string> {
  if (filters.timezone !== undefined) return filters.timezone;

  if (filters.branchId !== undefined) {
    const [branch] = await tx
      .select({ timezone: branches.timezone })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.id, filters.branchId)))
      .limit(1);
    if (branch) return branch.timezone;
  }

  const [tenant] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  return tenant?.timezone ?? "UTC";
}

/**
 * Shared entry validation for dated billing reports and dashboard analytics.
 * Exported so a composing service validates once, before issuing its own
 * queries, while still using the same rules as Phase 19.9.
 */
export function assertDatedBillingReportFilters(
  filters: BillingReportFilters,
): asserts filters is DatedBillingReportFilters {
  assertRange(filters);
  assertFilters(filters);
}

/** Revenue invoices: no drafts and no cancellations. */
function invoiceConditions(
  tenantId: string,
  filters: BillingReportFilters,
  options: { readonly withDateRange?: boolean } = {},
): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(invoices.tenantId, tenantId),
    notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
  ];

  if (options.withDateRange !== false) {
    assertRange(filters);
    conditions.push(gte(invoices.issueDate, filters.fromDate), lte(invoices.issueDate, filters.toDate));
  }
  if (filters.branchId !== undefined) conditions.push(eq(invoices.branchId, filters.branchId));
  if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));
  if (filters.invoiceStatus !== undefined) {
    conditions.push(eq(invoices.invoiceStatus, filters.invoiceStatus));
  }

  return and(...conditions)!;
}

/**
 * Collected money by currency. Receipt totals are used unless an invoice-type
 * filter requires attribution through allocations.
 */
function collectedQuery(
  tx: DatabaseTransaction,
  tenantId: string,
  filters: DatedBillingReportFilters,
  timezone: string,
  extra: { readonly branchId?: string; readonly doctorId?: string; readonly departmentId?: string } = {},
) {
  const conditions: (SQL | undefined)[] = [
    eq(payments.tenantId, tenantId),
    eq(payments.paymentStatus, "SUCCESSFUL"),
    instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
  ];
  const branchId = extra.branchId ?? filters.branchId;
  if (branchId !== undefined) conditions.push(eq(payments.branchId, branchId));
  if (filters.paymentMethod !== undefined) conditions.push(eq(payments.paymentMethod, filters.paymentMethod));

  if (filters.invoiceType !== undefined || extra.doctorId !== undefined || extra.departmentId !== undefined) {
    conditions.push(
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
    );
    if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));

    const query = tx
      .select({
        currency: invoices.currency,
        amount: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::text`,
        count: sql<number>`count(distinct ${payments.id})::int`,
      })
      .from(payments)
      .innerJoin(
        paymentAllocations,
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.paymentId, payments.id),
        ),
      )
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, tenantId), eq(invoices.id, paymentAllocations.invoiceId)),
      );

    if (extra.doctorId !== undefined || extra.departmentId !== undefined) {
      query
        .innerJoin(
          appointments,
          and(eq(appointments.tenantId, tenantId), eq(appointments.id, invoices.appointmentId)),
        );
      if (extra.departmentId !== undefined) {
        conditions.push(eq(appointments.departmentId, extra.departmentId));
      }
      if (extra.doctorId !== undefined) conditions.push(eq(appointments.doctorId, extra.doctorId));
    }

    return query.where(and(...conditions)!).groupBy(invoices.currency);
  }

  return tx
    .select({
      currency: payments.currency,
      amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(...conditions)!)
    .groupBy(payments.currency);
}

/**
 * Successful refunds by currency. `refunded_at` is the business timestamp; the
 * fallbacks cover legacy rows that only have the processing/updated timestamp.
 */
function refundedQuery(
  tx: DatabaseTransaction,
  tenantId: string,
  filters: DatedBillingReportFilters,
  timezone: string,
  extra: { readonly branchId?: string; readonly doctorId?: string; readonly departmentId?: string } = {},
) {
  const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;
  const conditions: (SQL | undefined)[] = [
    eq(invoiceRefunds.tenantId, tenantId),
    eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
    instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
    eq(invoices.tenantId, tenantId),
  ];
  const branchId = extra.branchId ?? filters.branchId;
  if (branchId !== undefined) conditions.push(eq(invoices.branchId, branchId));
  if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));

  const query = tx
    .select({
      currency: invoiceRefunds.currency,
      amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoiceRefunds)
    .innerJoin(
      invoices,
      and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
    );

  if (extra.doctorId !== undefined || extra.departmentId !== undefined) {
    query.innerJoin(
      appointments,
      and(eq(appointments.tenantId, tenantId), eq(appointments.id, invoices.appointmentId)),
    );
    if (extra.departmentId !== undefined) {
      conditions.push(eq(appointments.departmentId, extra.departmentId));
    }
    if (extra.doctorId !== undefined) conditions.push(eq(appointments.doctorId, extra.doctorId));
  }

  return query.where(and(...conditions)!).groupBy(invoiceRefunds.currency);
}

export async function getRevenueSummary(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<RevenueSummary> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);

    const [invoiced, outstanding, collected, refunded] = await Promise.all([
      tx
        .select({
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(invoiceConditions(tenantId, filters))
        .groupBy(invoices.currency),
      tx
        .select({
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(
          and(
            invoiceConditions(tenantId, filters),
            sql`${invoices.balanceDue} > 0`,
          )!,
        )
        .groupBy(invoices.currency),
      collectedQuery(tx, tenantId, filters, timezone),
      refundedQuery(tx, tenantId, filters, timezone),
    ]);

    const collectedAmounts = mapToAmounts(
      collected.reduce((map, row) => {
        addToMap(map, row.currency, row.amount);
        return map;
      }, new Map() as MoneyMap),
    );
    const refundedAmounts = mapToAmounts(
      refunded.reduce((map, row) => {
        addToMap(map, row.currency, row.amount);
        return map;
      }, new Map() as MoneyMap),
    );

    return {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      timezone,
      invoiceCount: sumCounts(invoiced),
      invoiced: invoiced.map((row) => ({ currency: row.currency, amount: row.amount })),
      collected: collectedAmounts,
      refunded: refundedAmounts,
      netCollected: netAmounts(collectedAmounts, refundedAmounts),
      outstanding: outstanding.map((row) => ({ currency: row.currency, amount: row.amount })),
    };
  });
}

export async function getRevenueTimeSeries(
  tenantId: string,
  filters: DatedBillingReportFilters & { readonly granularity: ReportGranularity },
): Promise<RevenueTimeSeries> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);
  assertGranularity(filters.granularity);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    // Whitelisted above, so a literal keeps SELECT and GROUP BY textually
    // identical (separate bind parameters would not compare as the same
    // expression to PostgreSQL).
    const granularity = sql.raw(`'${filters.granularity}'`);

    const invoicePeriod = sql<string>`to_char(date_trunc(${granularity}, ${invoices.issueDate}), 'YYYY-MM-DD')`;
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;
    const paymentPeriod = sql<string>`to_char(date_trunc(${granularity}, ${payments.receivedAt} AT TIME ZONE ${timezone}), 'YYYY-MM-DD')`;
    const refundPeriod = sql<string>`to_char(date_trunc(${granularity}, ${refundInstant} AT TIME ZONE ${timezone}), 'YYYY-MM-DD')`;

    const invoiceType = filters.invoiceType;
    const collectedConditions: (SQL | undefined)[] = [
      eq(payments.tenantId, tenantId),
      eq(payments.paymentStatus, "SUCCESSFUL"),
      instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
    ];
    if (filters.branchId !== undefined) collectedConditions.push(eq(payments.branchId, filters.branchId));
    if (filters.paymentMethod !== undefined) {
      collectedConditions.push(eq(payments.paymentMethod, filters.paymentMethod));
    }

    const invoiceConditionsForSeries: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
      gte(invoices.issueDate, filters.fromDate),
      lte(invoices.issueDate, filters.toDate),
    ];
    if (filters.branchId !== undefined) invoiceConditionsForSeries.push(eq(invoices.branchId, filters.branchId));
    if (invoiceType !== undefined) invoiceConditionsForSeries.push(eq(invoices.invoiceType, invoiceType));
    if (filters.invoiceStatus !== undefined) {
      invoiceConditionsForSeries.push(eq(invoices.invoiceStatus, filters.invoiceStatus));
    }

    const collectedPeriodQuery =
      invoiceType === undefined
        ? tx
            .select({
              period: paymentPeriod,
              currency: payments.currency,
              amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
            })
            .from(payments)
            .where(and(...collectedConditions)!)
            // Ordinal: the timezone bind parameter would otherwise be rendered
            // separately in GROUP BY and not match the SELECT expression.
            .groupBy(sql.raw("1"), payments.currency)
        : tx
            .select({
              period: paymentPeriod,
              currency: invoices.currency,
              amount: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::text`,
            })
            .from(payments)
            .innerJoin(
              paymentAllocations,
              and(
                eq(paymentAllocations.tenantId, tenantId),
                eq(paymentAllocations.paymentId, payments.id),
              ),
            )
            .innerJoin(
              invoices,
              and(eq(invoices.tenantId, tenantId), eq(invoices.id, paymentAllocations.invoiceId)),
            )
            .where(and(...collectedConditions, eq(invoices.invoiceType, invoiceType))!)
            .groupBy(sql.raw("1"), invoices.currency);

    const [invoiced, collected, refunded] = await Promise.all([
      tx
        .select({
          period: invoicePeriod,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
        })
        .from(invoices)
        .where(and(...invoiceConditionsForSeries)!)
        .groupBy(sql.raw("1"), invoices.currency),
      collectedPeriodQuery,
      tx
        .select({
          period: refundPeriod,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .where(
          and(
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
            instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            invoiceType !== undefined ? eq(invoices.invoiceType, invoiceType) : undefined,
          )!,
        )
        .groupBy(sql.raw("1"), invoiceRefunds.currency),
    ]);

    type Point = { invoiced: bigint; collected: bigint; refunded: bigint };
    const points = new Map<string, Point & { period: string; currency: string }>();
    const point = (period: string, currency: string) => {
      const key = `${period}\u0000${currency}`;
      let entry = points.get(key);
      if (!entry) {
        entry = { period, currency, invoiced: 0n, collected: 0n, refunded: 0n };
        points.set(key, entry);
      }
      return entry;
    };

    for (const row of invoiced) point(row.period, row.currency).invoiced += toCents(row.amount);
    for (const row of collected) point(row.period, row.currency).collected += toCents(row.amount);
    for (const row of refunded) point(row.period, row.currency).refunded += toCents(row.amount);

    const result: RevenuePoint[] = [...points.values()]
      .sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency))
      .map((row) => ({
        period: row.period,
        currency: row.currency,
        invoiced: fromCents(row.invoiced),
        collected: fromCents(row.collected),
        refunded: fromCents(row.refunded),
        netCollected: fromCents(row.collected - row.refunded),
      }));

    return {
      granularity: filters.granularity,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      timezone,
      points: result,
    };
  });
}

export async function getOutstandingBalances(
  tenantId: string,
  filters: BillingReportFilters & { readonly asOf?: string } = {},
): Promise<OutstandingBalanceSummary> {
  assertTenantId(tenantId);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const asOf = filters.asOf ?? todayInTimezone(timezone);
    assertDate(asOf, "asOf");

    const conditions: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
      lte(invoices.issueDate, asOf),
      sql`${invoices.balanceDue} > 0`,
    ];
    if (filters.fromDate !== undefined) {
      assertDate(filters.fromDate, "fromDate");
      conditions.push(gte(invoices.issueDate, filters.fromDate));
    }
    if (filters.branchId !== undefined) conditions.push(eq(invoices.branchId, filters.branchId));
    if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));

    const rows = await tx
      .select({
        currency: invoices.currency,
        amount: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(and(...conditions)!)
      .groupBy(invoices.currency);

    return {
      asOf,
      timezone,
      invoiceCount: sumCounts(rows),
      outstanding: rows.map((row) => ({ currency: row.currency, amount: row.amount })),
    };
  });
}

export async function listOutstandingInvoices(
  tenantId: string,
  filters: OutstandingInvoiceListFilters = {},
): Promise<OutstandingInvoicePage> {
  assertTenantId(tenantId);
  assertFilters(filters);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1) {
    throw validation("page must be a positive integer", "page");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_REPORT_PAGE_SIZE) {
    throw validation(`pageSize must be between 1 and ${MAX_REPORT_PAGE_SIZE}`, "pageSize");
  }
  if (filters.fromDate !== undefined) assertDate(filters.fromDate, "fromDate");
  if (filters.asOf !== undefined) assertDate(filters.asOf, "asOf");
  if (
    filters.fromDate !== undefined &&
    filters.asOf !== undefined &&
    filters.fromDate > filters.asOf
  ) {
    throw validation("fromDate must not be after asOf", "fromDate");
  }

  const state = filters.state ?? "ALL";

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const asOf = filters.asOf ?? todayInTimezone(timezone);

    const conditions: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED", "PAID", "REFUNDED"]),
      lte(invoices.issueDate, asOf),
      sql`${invoices.balanceDue} > 0`,
    ];
    if (filters.fromDate !== undefined) conditions.push(gte(invoices.issueDate, filters.fromDate));
    if (filters.branchId !== undefined) conditions.push(eq(invoices.branchId, filters.branchId));
    if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));
    if (filters.invoiceStatus !== undefined) {
      conditions.push(eq(invoices.invoiceStatus, filters.invoiceStatus));
    }

    const overdueCondition = sql`(
      ${invoices.invoiceStatus} = 'OVERDUE'
      or (${invoices.dueDate} is not null and ${invoices.dueDate} < ${asOf}::date)
    )`;
    if (state === "OVERDUE") conditions.push(overdueCondition);
    if (state === "PENDING") conditions.push(sql`not ${overdueCondition}`);

    const where = and(...conditions)!;

    const [countRows, rows] = await Promise.all([
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .where(where),
      tx
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          branchId: invoices.branchId,
          branchName: sql<string>`coalesce(${branches.name}, 'Unknown branch')`,
          invoiceStatus: invoices.invoiceStatus,
          invoiceType: invoices.invoiceType,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          currency: invoices.currency,
          totalAmount: invoices.totalAmount,
          amountPaid: invoices.amountPaid,
          balanceDue: invoices.balanceDue,
        })
        .from(invoices)
        .leftJoin(
          branches,
          and(eq(branches.tenantId, tenantId), eq(branches.id, invoices.branchId)),
        )
        .where(where)
        .orderBy(sql`${invoices.dueDate} asc nulls last`, asc(invoices.issueDate), asc(invoices.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      asOf,
      timezone,
      state,
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      invoices: rows,
    };
  });
}

export async function getPendingAndOverdueInvoices(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<PendingOverdueSummary> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);

    const base: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED", "PAID", "REFUNDED"]),
      gte(invoices.issueDate, filters.fromDate),
      lte(invoices.issueDate, filters.toDate),
      sql`${invoices.balanceDue} > 0`,
    ];
    if (filters.branchId !== undefined) base.push(eq(invoices.branchId, filters.branchId));
    if (filters.invoiceType !== undefined) base.push(eq(invoices.invoiceType, filters.invoiceType));
    if (filters.invoiceStatus !== undefined) base.push(eq(invoices.invoiceStatus, filters.invoiceStatus));

    const overdueCondition = sql`(
      ${invoices.invoiceStatus} = 'OVERDUE'
      or (${invoices.dueDate} is not null and ${invoices.dueDate} < ${filters.toDate}::date)
    )`;

    const totals = (where: SQL) =>
      tx
        .select({
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(where)
        .groupBy(invoices.currency);

    const [pending, overdue] = await Promise.all([
      totals(and(...base, sql`not ${overdueCondition}`)!),
      totals(and(...base, overdueCondition)!),
    ]);

    return {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      timezone,
      pending: {
        invoiceCount: sumCounts(pending),
        outstanding: pending.map((row) => ({ currency: row.currency, amount: row.amount })),
      },
      overdue: {
        invoiceCount: sumCounts(overdue),
        outstanding: overdue.map((row) => ({ currency: row.currency, amount: row.amount })),
      },
    };
  });
}

export async function getInvoiceStatusDistribution(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<StatusDistributionRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      gte(invoices.issueDate, filters.fromDate),
      lte(invoices.issueDate, filters.toDate),
    ];
    if (filters.branchId !== undefined) conditions.push(eq(invoices.branchId, filters.branchId));
    if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));
    if (filters.invoiceStatus !== undefined) {
      conditions.push(eq(invoices.invoiceStatus, filters.invoiceStatus));
    }

    const rows = await tx
      .select({
        status: invoices.invoiceStatus,
        currency: invoices.currency,
        amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(and(...conditions)!)
      .groupBy(invoices.invoiceStatus, invoices.currency);

    return groupStatusRows(rows);
  });
}

export async function getPaymentStatusDistribution(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<StatusDistributionRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const conditions: (SQL | undefined)[] = [
      eq(payments.tenantId, tenantId),
      instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
    ];
    if (filters.branchId !== undefined) conditions.push(eq(payments.branchId, filters.branchId));
    if (filters.paymentMethod !== undefined) conditions.push(eq(payments.paymentMethod, filters.paymentMethod));
    if (filters.paymentStatus !== undefined) {
      conditions.push(eq(payments.paymentStatus, filters.paymentStatus));
    }

    const rows = await tx
      .select({
        status: payments.paymentStatus,
        currency: payments.currency,
        amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .where(and(...conditions)!)
      .groupBy(payments.paymentStatus, payments.currency);

    return groupStatusRows(rows);
  });
}

export async function getRefundStatusDistribution(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<StatusDistributionRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const conditions: (SQL | undefined)[] = [
      eq(invoiceRefunds.tenantId, tenantId),
      instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
      eq(invoices.tenantId, tenantId),
    ];
    if (filters.branchId !== undefined) conditions.push(eq(invoices.branchId, filters.branchId));
    if (filters.invoiceType !== undefined) conditions.push(eq(invoices.invoiceType, filters.invoiceType));
    if (filters.refundStatus !== undefined) {
      conditions.push(eq(invoiceRefunds.refundStatus, filters.refundStatus));
    }

    const rows = await tx
      .select({
        status: invoiceRefunds.refundStatus,
        currency: invoiceRefunds.currency,
        amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoiceRefunds)
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
      )
      .where(and(...conditions)!)
      .groupBy(invoiceRefunds.refundStatus, invoiceRefunds.currency);

    return groupStatusRows(rows);
  });
}

function groupStatusRows(
  rows: readonly { status: string; currency: string; amount: string; count: number }[],
): StatusDistributionRow[] {
  const groups = new Map<string, { count: number; totals: { currency: string; amount: string }[] }>();
  for (const row of rows) {
    const group = groups.get(row.status) ?? { count: 0, totals: [] };
    group.count += row.count;
    group.totals.push({ currency: row.currency, amount: row.amount });
    groups.set(row.status, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, group]) => ({
      status,
      count: group.count,
      totals: group.totals.sort((a, b) => a.currency.localeCompare(b.currency)),
    }));
}

export async function getPaymentAndRefundSummary(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<PaymentRefundSummary> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const paymentConditions: (SQL | undefined)[] = [
      eq(payments.tenantId, tenantId),
      instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(payments.branchId, filters.branchId) : undefined,
      filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
      filters.paymentStatus !== undefined ? eq(payments.paymentStatus, filters.paymentStatus) : undefined,
    ];

    const refundConditions: (SQL | undefined)[] = [
      eq(invoiceRefunds.tenantId, tenantId),
      eq(invoices.tenantId, tenantId),
      instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
      filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
      filters.refundStatus !== undefined ? eq(invoiceRefunds.refundStatus, filters.refundStatus) : undefined,
    ];

    const [paymentRows, refundRows] = await Promise.all([
      tx
        .select({
          status: payments.paymentStatus,
          currency: payments.currency,
          amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(payments)
        .where(and(...paymentConditions)!)
        .groupBy(payments.paymentStatus, payments.currency),
      tx
        .select({
          status: invoiceRefunds.refundStatus,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .where(and(...refundConditions)!)
        .groupBy(invoiceRefunds.refundStatus, invoiceRefunds.currency),
    ]);

    return {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      timezone,
      payments: groupStatusRows(paymentRows),
      refunds: groupStatusRows(refundRows),
    };
  });
}

export async function getBranchRevenueBreakdown(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<BranchRevenueRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const conditions: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
      gte(invoices.issueDate, filters.fromDate),
      lte(invoices.issueDate, filters.toDate),
      filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
      filters.invoiceStatus !== undefined ? eq(invoices.invoiceStatus, filters.invoiceStatus) : undefined,
      filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
    ];
    const paymentConditions: (SQL | undefined)[] = [
      eq(payments.tenantId, tenantId),
      eq(payments.paymentStatus, "SUCCESSFUL"),
      instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(payments.branchId, filters.branchId) : undefined,
      filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
    ];
    const refundConditions: (SQL | undefined)[] = [
      eq(invoiceRefunds.tenantId, tenantId),
      eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
      eq(invoices.tenantId, tenantId),
      instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
      filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
    ];

    const [invoiceRows, paymentRows, refundRows, branchRows] = await Promise.all([
      tx
        .select({
          key: invoices.branchId,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
          count: sql<number>`count(*)::int`,
          outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text`,
        })
        .from(invoices)
        .where(and(...conditions)!)
        .groupBy(invoices.branchId, invoices.currency),
      tx
        .select({
          key: payments.branchId,
          currency: payments.currency,
          amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(payments)
        .where(and(...paymentConditions)!)
        .groupBy(payments.branchId, payments.currency),
      tx
        .select({
          key: invoices.branchId,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .where(and(...refundConditions)!)
        .groupBy(invoices.branchId, invoiceRefunds.currency),
      tx
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(eq(branches.tenantId, tenantId)),
    ]);

    const names = new Map(branchRows.map((row) => [row.id, row.name]));
    const groups = new Map<
      string,
      {
        branchId: string;
        currency: string;
        invoiceCount: number;
        invoiced: bigint;
        collected: bigint;
        refunded: bigint;
        outstanding: bigint;
      }
    >();

    const group = (branchId: string, currency: string) => {
      const key = `${branchId}\u0000${currency}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          branchId,
          currency,
          invoiceCount: 0,
          invoiced: 0n,
          collected: 0n,
          refunded: 0n,
          outstanding: 0n,
        };
        groups.set(key, entry);
      }
      return entry;
    };

    for (const row of invoiceRows) {
      const entry = group(row.key, row.currency);
      entry.invoiced += toCents(row.amount);
      entry.outstanding += toCents(row.outstanding);
      entry.invoiceCount += row.count;
    }
    for (const row of paymentRows) group(row.key, row.currency).collected += toCents(row.amount);
    for (const row of refundRows) group(row.key, row.currency).refunded += toCents(row.amount);

    return [...groups.values()]
      .map((row) => ({
        branchId: row.branchId,
        branchName: names.get(row.branchId) ?? "Unknown branch",
        currency: row.currency,
        invoiceCount: row.invoiceCount,
        invoiced: fromCents(row.invoiced),
        collected: fromCents(row.collected),
        refunded: fromCents(row.refunded),
        netCollected: fromCents(row.collected - row.refunded),
        outstanding: fromCents(row.outstanding),
      }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName) || a.currency.localeCompare(b.currency));
  });
}

export async function getPaymentMethodRevenueBreakdown(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<PaymentMethodRevenueRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const paymentConditions: (SQL | undefined)[] = [
      eq(payments.tenantId, tenantId),
      eq(payments.paymentStatus, "SUCCESSFUL"),
      instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(payments.branchId, filters.branchId) : undefined,
      filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
    ];

    const [collected, refunded] = await Promise.all([
      tx
        .select({
          method: payments.paymentMethod,
          currency: payments.currency,
          amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(payments)
        .where(and(...paymentConditions)!)
        .groupBy(payments.paymentMethod, payments.currency),
      // Refunds point at an invoice settlement (`invoice_payments.id`), which in
      // turn points at the receipt that provided the money.
      tx
        .select({
          method: payments.paymentMethod,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .innerJoin(
          invoicePayments,
          and(
            eq(invoicePayments.tenantId, tenantId),
            eq(invoicePayments.id, invoiceRefunds.paymentId),
            eq(invoicePayments.invoiceId, invoiceRefunds.invoiceId),
          ),
        )
        .innerJoin(
          payments,
          and(eq(payments.tenantId, tenantId), eq(payments.id, invoicePayments.paymentId)),
        )
        .where(
          and(
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
            instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
          )!,
        )
        .groupBy(payments.paymentMethod, invoiceRefunds.currency),
    ]);

    const groups = new Map<
      string,
      { method: string; currency: string; count: number; collected: bigint; refunded: bigint }
    >();
    const group = (method: string, currency: string) => {
      const key = `${method}\u0000${currency}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { method, currency, count: 0, collected: 0n, refunded: 0n };
        groups.set(key, entry);
      }
      return entry;
    };

    for (const row of collected) {
      const entry = group(row.method, row.currency);
      entry.collected += toCents(row.amount);
      entry.count += row.count;
    }
    for (const row of refunded) group(row.method, row.currency).refunded += toCents(row.amount);

    return [...groups.values()]
      .map((row) => ({
        paymentMethod: row.method,
        currency: row.currency,
        paymentCount: row.count,
        collected: fromCents(row.collected),
        refunded: fromCents(row.refunded),
        netCollected: fromCents(row.collected - row.refunded),
      }))
      .sort((a, b) => a.paymentMethod.localeCompare(b.paymentMethod) || a.currency.localeCompare(b.currency));
  });
}

export async function getInvoiceTypeRevenueBreakdown(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<InvoiceTypeRevenueRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const base: (SQL | undefined)[] = [
      eq(invoices.tenantId, tenantId),
      notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
      filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
    ];

    const [invoiceRows, collectedRows, refundRows] = await Promise.all([
      tx
        .select({
          type: invoices.invoiceType,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
          outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(
          and(
            ...base,
            gte(invoices.issueDate, filters.fromDate),
            lte(invoices.issueDate, filters.toDate),
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            filters.invoiceStatus !== undefined ? eq(invoices.invoiceStatus, filters.invoiceStatus) : undefined,
          )!,
        )
        .groupBy(invoices.invoiceType, invoices.currency),
      tx
        .select({
          type: invoices.invoiceType,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::text`,
          count: sql<number>`count(distinct ${payments.id})::int`,
        })
        .from(payments)
        .innerJoin(
          paymentAllocations,
          and(
            eq(paymentAllocations.tenantId, tenantId),
            eq(paymentAllocations.paymentId, payments.id),
          ),
        )
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, paymentAllocations.invoiceId)),
        )
        .where(
          and(
            ...base,
            eq(payments.tenantId, tenantId),
            eq(payments.paymentStatus, "SUCCESSFUL"),
            instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
            filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
          )!,
        )
        .groupBy(invoices.invoiceType, invoices.currency),
      tx
        .select({
          type: invoices.invoiceType,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .where(
          and(
            ...base,
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
            instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
          )!,
        )
        .groupBy(invoices.invoiceType, invoiceRefunds.currency),
    ]);

    const groups = new Map<
      string,
      {
        type: string;
        currency: string;
        invoiceCount: number;
        invoiced: bigint;
        collected: bigint;
        refunded: bigint;
        outstanding: bigint;
      }
    >();
    const group = (type: string, currency: string) => {
      const key = `${type}\u0000${currency}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { type, currency, invoiceCount: 0, invoiced: 0n, collected: 0n, refunded: 0n, outstanding: 0n };
        groups.set(key, entry);
      }
      return entry;
    };

    for (const row of invoiceRows) {
      const entry = group(row.type, row.currency);
      entry.invoiced += toCents(row.amount);
      entry.outstanding += toCents(row.outstanding);
      entry.invoiceCount += row.count;
    }
    for (const row of collectedRows) group(row.type, row.currency).collected += toCents(row.amount);
    for (const row of refundRows) group(row.type, row.currency).refunded += toCents(row.amount);

    return [...groups.values()]
      .map((row) => ({
        invoiceType: row.type,
        currency: row.currency,
        invoiceCount: row.invoiceCount,
        invoiced: fromCents(row.invoiced),
        collected: fromCents(row.collected),
        refunded: fromCents(row.refunded),
        outstanding: fromCents(row.outstanding),
      }))
      .sort((a, b) => a.invoiceType.localeCompare(b.invoiceType) || a.currency.localeCompare(b.currency));
  });
}

/**
 * Doctor attribution comes from `invoices.appointment_id -> appointments.doctor_id`.
 * Invoices without an appointment are intentionally excluded; they cannot be
 * attributed to a doctor without inventing a relationship.
 */
export async function getDoctorBillingSummary(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<DoctorBillingRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const doctorJoin = and(
      eq(doctors.tenantId, tenantId),
      eq(doctors.id, appointments.doctorId),
    );
    const appointmentJoin = and(
      eq(appointments.tenantId, tenantId),
      eq(appointments.id, invoices.appointmentId),
    );
    const doctorFilter = filters.doctorId !== undefined ? eq(doctors.id, filters.doctorId) : undefined;

    const [invoiceRows, collectedRows, refundRows] = await Promise.all([
      tx
        .select({
          key: doctors.id,
          code: doctors.doctorCode,
          name: users.fullName,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(doctors, doctorJoin)
        .leftJoin(users, eq(users.id, doctors.userId))
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
            gte(invoices.issueDate, filters.fromDate),
            lte(invoices.issueDate, filters.toDate),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            doctorFilter,
          )!,
        )
        .groupBy(doctors.id, doctors.doctorCode, users.fullName, invoices.currency),
      tx
        .select({
          key: doctors.id,
          code: doctors.doctorCode,
          name: users.fullName,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(payments)
        .innerJoin(
          paymentAllocations,
          and(
            eq(paymentAllocations.tenantId, tenantId),
            eq(paymentAllocations.paymentId, payments.id),
          ),
        )
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, paymentAllocations.invoiceId)),
        )
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(doctors, doctorJoin)
        .leftJoin(users, eq(users.id, doctors.userId))
        .where(
          and(
            eq(payments.tenantId, tenantId),
            eq(payments.paymentStatus, "SUCCESSFUL"),
            instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(payments.branchId, filters.branchId) : undefined,
            filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            doctorFilter,
          )!,
        )
        .groupBy(doctors.id, doctors.doctorCode, users.fullName, invoices.currency),
      tx
        .select({
          key: doctors.id,
          code: doctors.doctorCode,
          name: users.fullName,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(doctors, doctorJoin)
        .leftJoin(users, eq(users.id, doctors.userId))
        .where(
          and(
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
            instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            doctorFilter,
          )!,
        )
        .groupBy(doctors.id, doctors.doctorCode, users.fullName, invoiceRefunds.currency),
    ]);

    return mergeNamedRows(invoiceRows, collectedRows, refundRows).map((row) => ({
      doctorId: row.key,
      doctorCode: row.code,
      doctorName: row.name,
      currency: row.currency,
      invoiceCount: row.invoiceCount,
      invoiced: fromCents(row.invoiced),
      collected: fromCents(row.collected),
      refunded: fromCents(row.refunded),
      netCollected: fromCents(row.collected - row.refunded),
    }));
  });
}

/**
 * Department attribution uses the appointment's chosen department (nullable),
 * not the doctor's department memberships, so a doctor assigned to several
 * departments cannot make one invoice count twice.
 */
export async function getDepartmentBillingSummary(
  tenantId: string,
  filters: DatedBillingReportFilters,
): Promise<DepartmentBillingRow[]> {
  assertTenantId(tenantId);
  assertRange(filters);
  assertFilters(filters);

  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);
    const refundInstant = sql`coalesce(${invoiceRefunds.refundedAt}, ${invoiceRefunds.processedAt}, ${invoiceRefunds.createdAt})`;

    const appointmentJoin = and(
      eq(appointments.tenantId, tenantId),
      eq(appointments.id, invoices.appointmentId),
    );
    const departmentJoin = and(
      eq(departments.tenantId, tenantId),
      eq(departments.id, appointments.departmentId),
    );
    const departmentFilter =
      filters.departmentId !== undefined ? eq(departments.id, filters.departmentId) : undefined;

    const [invoiceRows, collectedRows, refundRows] = await Promise.all([
      tx
        .select({
          key: departments.id,
          code: departments.id,
          name: departments.name,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(departments, departmentJoin)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            notInArray(invoices.invoiceStatus, ["DRAFT", "CANCELLED"]),
            gte(invoices.issueDate, filters.fromDate),
            lte(invoices.issueDate, filters.toDate),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            departmentFilter,
          )!,
        )
        .groupBy(departments.id, departments.name, invoices.currency),
      tx
        .select({
          key: departments.id,
          code: departments.id,
          name: departments.name,
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(payments)
        .innerJoin(
          paymentAllocations,
          and(
            eq(paymentAllocations.tenantId, tenantId),
            eq(paymentAllocations.paymentId, payments.id),
          ),
        )
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, paymentAllocations.invoiceId)),
        )
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(departments, departmentJoin)
        .where(
          and(
            eq(payments.tenantId, tenantId),
            eq(payments.paymentStatus, "SUCCESSFUL"),
            instantRange(payments.receivedAt, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(payments.branchId, filters.branchId) : undefined,
            filters.paymentMethod !== undefined ? eq(payments.paymentMethod, filters.paymentMethod) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            departmentFilter,
          )!,
        )
        .groupBy(departments.id, departments.name, invoices.currency),
      tx
        .select({
          key: departments.id,
          code: departments.id,
          name: departments.name,
          currency: invoiceRefunds.currency,
          amount: sql<string>`coalesce(sum(${invoiceRefunds.amount}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(invoiceRefunds)
        .innerJoin(
          invoices,
          and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRefunds.invoiceId)),
        )
        .innerJoin(appointments, appointmentJoin)
        .innerJoin(departments, departmentJoin)
        .where(
          and(
            eq(invoiceRefunds.tenantId, tenantId),
            eq(invoiceRefunds.refundStatus, "SUCCESSFUL"),
            instantRange(refundInstant, filters.fromDate, filters.toDate, timezone),
            filters.branchId !== undefined ? eq(invoices.branchId, filters.branchId) : undefined,
            filters.invoiceType !== undefined ? eq(invoices.invoiceType, filters.invoiceType) : undefined,
            departmentFilter,
          )!,
        )
        .groupBy(departments.id, departments.name, invoiceRefunds.currency),
    ]);

    return mergeNamedRows(invoiceRows, collectedRows, refundRows).map((row) => ({
      departmentId: row.key,
      departmentName: row.name ?? "Unknown department",
      currency: row.currency,
      invoiceCount: row.invoiceCount,
      invoiced: fromCents(row.invoiced),
      collected: fromCents(row.collected),
      refunded: fromCents(row.refunded),
      netCollected: fromCents(row.collected - row.refunded),
    }));
  });
}

function mergeNamedRows(
  invoiceRows: readonly NamedMoneyRow[],
  collectedRows: readonly NamedMoneyRow[],
  refundedRows: readonly NamedMoneyRow[],
): Array<{
  key: string;
  code: string;
  name: string | null;
  currency: string;
  invoiceCount: number;
  invoiced: bigint;
  collected: bigint;
  refunded: bigint;
}> {
  const groups = new Map<
    string,
    {
      key: string;
      code: string;
      name: string | null;
      currency: string;
      invoiceCount: number;
      invoiced: bigint;
      collected: bigint;
      refunded: bigint;
    }
  >();
  const group = (row: NamedMoneyRow) => {
    const key = `${row.key}\u0000${row.currency}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        key: row.key,
        code: row.code,
        name: row.name,
        currency: row.currency,
        invoiceCount: 0,
        invoiced: 0n,
        collected: 0n,
        refunded: 0n,
      };
      groups.set(key, entry);
    }
    return entry;
  };

  for (const row of invoiceRows) {
    const entry = group(row);
    entry.invoiced += toCents(row.amount);
    entry.invoiceCount += row.count;
    if (row.name !== null) entry.name = row.name;
  }
  for (const row of collectedRows) {
    const entry = group(row);
    entry.collected += toCents(row.amount);
    if (entry.name === null && row.name !== null) entry.name = row.name;
  }
  for (const row of refundedRows) {
    const entry = group(row);
    entry.refunded += toCents(row.amount);
    if (entry.name === null && row.name !== null) entry.name = row.name;
  }

  return [...groups.values()].sort(
    (a, b) =>
      (a.name ?? a.code).localeCompare(b.name ?? b.code) || a.currency.localeCompare(b.currency),
  );
}
