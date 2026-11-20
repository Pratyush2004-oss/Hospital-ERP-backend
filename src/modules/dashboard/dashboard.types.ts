import type { CurrencyAmount } from "../billing/reports/billing-report.types.js";

/**
 * Dashboard analytics contracts (Phase 22.1).
 *
 * Every financial amount is a decimal string produced by the Phase 19.9
 * billing aggregates and grouped by currency. No amount is converted to a
 * JavaScript float.
 */

export interface DashboardAnalyticsFilters {
  /** Inclusive local calendar date (YYYY-MM-DD). */
  readonly fromDate: string;
  /** Inclusive local calendar date (YYYY-MM-DD). */
  readonly toDate: string;
  readonly branchId?: string;
  /** IANA zone; defaults to the branch, then hospital, timezone. */
  readonly timezone?: string;
}

/** Aggregated dashboard inputs are reports-only; no patient records are read. */
export interface DashboardActorContext {
  readonly permissions: ReadonlySet<string>;
}

export interface AppointmentDashboardStats {
  readonly total: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly upcoming: number;
  readonly noShows: number;
}

export interface PatientDashboardStats {
  /** All non-deleted patient profiles in the hospital, independent of branch. */
  readonly total: number;
  /** Registrations created inside the selected range and timezone. */
  readonly newlyRegistered: number;
}

export interface DoctorWorkloadRow {
  readonly doctorId: string;
  readonly doctorCode: string;
  readonly doctorName: string | null;
  readonly appointmentCount: number;
  readonly completedCount: number;
  readonly upcomingCount: number;
}

export interface DoctorDashboardStats {
  readonly activeDoctors: number;
  /** One aggregated row per doctor with appointments in the range. */
  readonly workload: readonly DoctorWorkloadRow[];
}

export interface PendingInvoiceDashboardStats {
  readonly invoiceCount: number;
  readonly outstanding: readonly CurrencyAmount[];
}

export interface FinancialDashboardStats {
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly invoiceCount: number;
  /** Billed revenue, excluding DRAFT and CANCELLED invoices. */
  readonly revenue: readonly CurrencyAmount[];
  /** Successful receipt-level collections. */
  readonly collections: readonly CurrencyAmount[];
  /** Successful refunds. */
  readonly refunds: readonly CurrencyAmount[];
  readonly netCollections: readonly CurrencyAmount[];
  /** Open balances on invoices issued in the range, as of `toDate`. */
  readonly pendingInvoices: PendingInvoiceDashboardStats;
}

export interface DashboardAnalytics {
  readonly fromDate: string;
  readonly toDate: string;
  readonly branchId: string | null;
  readonly timezone: string;
  readonly asOf: string;
  readonly appointments: AppointmentDashboardStats;
  readonly patients: PatientDashboardStats;
  readonly doctors: DoctorDashboardStats;
  readonly financial: FinancialDashboardStats;
}
