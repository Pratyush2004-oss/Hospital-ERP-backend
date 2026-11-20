import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { withTenantTransaction } from "../../database/context.js";
import {
  appointments,
  doctorBranches,
  doctors,
  patientProfiles,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import {
  assertDatedBillingReportFilters,
  assertReportBranchAccess,
  getOutstandingBalances,
  getRevenueSummary,
  instantRange,
  resolveTimezone,
} from "../billing/reports/billing-report.service.js";
import type { DatedBillingReportFilters } from "../billing/reports/billing-report.types.js";
import type {
  AppointmentDashboardStats,
  DashboardActorContext,
  DashboardAnalytics,
  DashboardAnalyticsFilters,
  DoctorDashboardStats,
  PatientDashboardStats,
} from "./dashboard.types.js";

/**
 * Dashboard analytics aggregation (Phase 22.1).
 *
 * - Appointment, patient and doctor metrics are produced by grouped/counting
 *   PostgreSQL queries. No appointment, patient or doctor history is loaded into
 *   application memory.
 * - All financial metrics are delegated to the Phase 19.9 billing reports, so
 *   revenue/collection/refund definitions, currency grouping and decimal
 *   handling have one implementation.
 * - Every query runs in `withTenantTransaction`; the explicit `tenant_id`
 *   predicate and forced RLS both constrain access. A branch from another
 *   hospital resolves as 404 before metrics run.
 * - Patient identities are never selected. Doctor workload exposes only the
 *   professional identity needed for a dashboard label, never patient data.
 * - Aggregated report access requires `reports:read`.
 *
 * Patient totals are hospital-wide: `patient_profiles` has no branch column, so
 * a branch filter cannot narrow patient registration counts. Appointment,
 * doctor and financial metrics do honor the branch filter. This is documented
 * and covered by tests.
 */

const REQUIRED_PERMISSION = "reports:read";

function assertDashboardPermission(actor: DashboardActorContext): void {
  if (!actor.permissions.has(REQUIRED_PERMISSION)) {
    throw AppError.forbidden("You do not have permission to view dashboard analytics");
  }
}

const EMPTY_APPOINTMENTS: AppointmentDashboardStats = {
  total: 0,
  completed: 0,
  cancelled: 0,
  upcoming: 0,
  noShows: 0,
};

const EMPTY_PATIENTS: PatientDashboardStats = {
  total: 0,
  newlyRegistered: 0,
};

async function getOperationalStats(
  tenantId: string,
  filters: DatedBillingReportFilters,
  asOf: Date,
): Promise<{
  readonly timezone: string;
  readonly appointments: AppointmentDashboardStats;
  readonly patients: PatientDashboardStats;
  readonly doctors: DoctorDashboardStats;
}> {
  return withTenantTransaction(tenantId, async (tx) => {
    const timezone = await resolveTimezone(tx, tenantId, filters);

    const appointmentConditions = [
      eq(appointments.tenantId, tenantId),
      instantRange(appointments.startAt, filters.fromDate, filters.toDate, timezone),
    ];
    if (filters.branchId !== undefined) {
      appointmentConditions.push(eq(appointments.branchId, filters.branchId));
    }

    const workloadConditions = [
      eq(appointments.tenantId, tenantId),
      instantRange(appointments.startAt, filters.fromDate, filters.toDate, timezone),
      filters.branchId !== undefined ? eq(appointments.branchId, filters.branchId) : undefined,
    ];

    const patientConditions = [
      eq(patientProfiles.tenantId, tenantId),
      isNull(patientProfiles.deletedAt),
    ];
    const newPatientConditions = [
      ...patientConditions,
      instantRange(patientProfiles.createdAt, filters.fromDate, filters.toDate, timezone),
    ];

    const activeDoctorConditions = [
      eq(doctors.tenantId, tenantId),
      eq(doctors.isActive, true),
      isNull(doctors.deletedAt),
    ];

    const activeDoctorsQuery =
      filters.branchId === undefined
        ? tx
            .select({ activeDoctors: sql<number>`count(*)::int` })
            .from(doctors)
            .where(and(...activeDoctorConditions))
        : tx
            .select({ activeDoctors: sql<number>`count(distinct ${doctors.id})::int` })
            .from(doctors)
            .innerJoin(
              doctorBranches,
              and(
                eq(doctorBranches.tenantId, tenantId),
                eq(doctorBranches.doctorId, doctors.id),
                eq(doctorBranches.branchId, filters.branchId),
                eq(doctorBranches.isActive, true),
              ),
            )
            .where(and(...activeDoctorConditions));

    const [
      appointmentRows,
      patientTotalRows,
      newPatientRows,
      activeDoctorRows,
      workloadRows,
    ] = await Promise.all([
      tx
        .select({
          total: sql<number>`count(*)::int`,
          completed: sql<number>`(count(*) filter (where ${appointments.appointmentStatus} = 'COMPLETED'))::int`,
          cancelled: sql<number>`(count(*) filter (where ${appointments.appointmentStatus} = 'CANCELLED'))::int`,
          noShows: sql<number>`(count(*) filter (where ${appointments.appointmentStatus} = 'NO_SHOW'))::int`,
          upcoming: sql<number>`(count(*) filter (
            where ${appointments.appointmentStatus} in ('PENDING', 'CONFIRMED')
              and ${appointments.startAt} >= ${asOf}
          ))::int`,
        })
        .from(appointments)
        .where(and(...appointmentConditions)),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(patientProfiles)
        .where(and(...patientConditions)),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(patientProfiles)
        .where(and(...newPatientConditions)),
      activeDoctorsQuery,
      tx
        .select({
          doctorId: appointments.doctorId,
          doctorCode: doctors.doctorCode,
          doctorName: users.fullName,
          appointmentCount: sql<number>`count(*)::int`,
          completedCount: sql<number>`(count(*) filter (where ${appointments.appointmentStatus} = 'COMPLETED'))::int`,
          upcomingCount: sql<number>`(count(*) filter (
            where ${appointments.appointmentStatus} in ('PENDING', 'CONFIRMED')
              and ${appointments.startAt} >= ${asOf}
          ))::int`,
        })
        .from(appointments)
        .innerJoin(
          doctors,
          and(eq(doctors.tenantId, tenantId), eq(doctors.id, appointments.doctorId)),
        )
        .innerJoin(users, eq(users.id, doctors.userId))
        .where(and(...workloadConditions))
        .groupBy(appointments.doctorId, doctors.doctorCode, users.fullName)
        .orderBy(desc(sql`count(*)`), asc(users.fullName), asc(appointments.doctorId)),
    ]);

    return {
      timezone,
      appointments: appointmentRows[0] ?? EMPTY_APPOINTMENTS,
      patients: {
        total: patientTotalRows[0]?.total ?? EMPTY_PATIENTS.total,
        newlyRegistered: newPatientRows[0]?.total ?? EMPTY_PATIENTS.newlyRegistered,
      },
      doctors: {
        activeDoctors: activeDoctorRows[0]?.activeDoctors ?? 0,
        workload: workloadRows,
      },
    };
  });
}

/** Complete, read-only dashboard snapshot for one hospital (optionally one branch). */
export async function getDashboardAnalytics(
  tenantId: string,
  filters: DashboardAnalyticsFilters,
  actor: DashboardActorContext,
): Promise<DashboardAnalytics> {
  assertDashboardPermission(actor);

  // Same branch and date/timezone rules as Phase 19.9, applied before any
  // dashboard query so invalid input cannot partially execute.
  await assertReportBranchAccess(tenantId, filters.branchId);
  assertDatedBillingReportFilters(filters);

  const asOf = new Date();
  const datedFilters: DatedBillingReportFilters = {
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
    timezone: filters.timezone,
  };

  const [operational, revenue, outstanding] = await Promise.all([
    getOperationalStats(tenantId, datedFilters, asOf),
    getRevenueSummary(tenantId, datedFilters),
    getOutstandingBalances(tenantId, {
      ...datedFilters,
      asOf: filters.toDate,
    }),
  ]);

  return {
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId ?? null,
    timezone: revenue.timezone,
    asOf: asOf.toISOString(),
    appointments: operational.appointments,
    patients: operational.patients,
    doctors: operational.doctors,
    financial: {
      fromDate: revenue.fromDate,
      toDate: revenue.toDate,
      timezone: revenue.timezone,
      invoiceCount: revenue.invoiceCount,
      revenue: revenue.invoiced,
      collections: revenue.collected,
      refunds: revenue.refunded,
      netCollections: revenue.netCollected,
      pendingInvoices: {
        invoiceCount: outstanding.invoiceCount,
        outstanding: outstanding.outstanding,
      },
    },
  };
}
