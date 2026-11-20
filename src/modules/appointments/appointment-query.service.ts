import { and, asc, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { withTenantTransaction, type DatabaseTransaction } from "../../database/context.js";
import {
  appointments,
  branches,
  doctors,
  patientProfiles,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import type {
  AppointmentActorContext,
  AppointmentBookingDto,
  AppointmentSource,
  AppointmentStatus,
  AppointmentType,
} from "./appointment-booking.types.js";
import {
  assertDoctorAppointmentScope,
  assertUuid,
  loadAppointmentDto,
  loadAppointmentSnapshot,
} from "./appointment-service.shared.js";

/**
 * Appointment read model (Phase 18.6).
 *
 * Listing, code lookup and detail reads for the appointment API. This is a
 * query layer only: availability, booking, rescheduling, cancellation and
 * lifecycle transitions remain in their Phase 18.2-18.5 services.
 *
 * - Every statement filters `tenant_id` in SQL on top of the RLS transaction
 *   context, so a cross-tenant appointment is a 404, never a 403.
 * - A caller who holds a doctor profile in this hospital is restricted to their
 *   own appointments, matching the Phase 18.5 lifecycle rule. Reception, admin
 *   and nursing staff are governed by their RBAC permissions instead.
 * - The list projection joins patients, doctors, their account names and
 *   branches in one query (no per-row lookups), and never selects the private
 *   `notes` column.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

export interface AppointmentListFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly patientId?: string;
  readonly doctorId?: string;
  readonly branchId?: string;
  readonly departmentId?: string;
  readonly status?: AppointmentStatus;
  readonly source?: AppointmentSource;
  /** Inclusive UTC calendar-date bounds on the appointment start instant. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

/** Operational list row: identity, scheduling and booking context only. */
export interface AppointmentSummaryDto {
  readonly id: string;
  readonly appointmentCode: string;
  readonly patientId: string;
  readonly patientCode: string;
  readonly patientName: string;
  readonly doctorId: string;
  readonly doctorCode: string;
  readonly doctorName: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly departmentId: string | null;
  readonly appointmentType: AppointmentType;
  readonly appointmentStatus: AppointmentStatus;
  readonly appointmentSource: AppointmentSource;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly durationMinutes: number;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AppointmentListResult {
  readonly appointments: readonly AppointmentSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

function utcDayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Read-path doctor scope, shared with the write services. */
function assertDoctorScope(
  tx: DatabaseTransaction,
  tenantId: string,
  doctorId: string,
  actor: AppointmentActorContext,
): Promise<void> {
  return assertDoctorAppointmentScope(
    tx,
    tenantId,
    doctorId,
    actor,
    "Doctors may only view appointments assigned to them",
  );
}

/**
 * Returns the caller's doctor profile id when they are a doctor in this
 * hospital, or `null` for other staff.
 */
async function resolveDoctorScope(
  tx: DatabaseTransaction,
  tenantId: string,
  actor: AppointmentActorContext,
): Promise<string | null> {
  const [profile] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(and(eq(doctors.tenantId, tenantId), eq(doctors.userId, actor.userId)))
    .limit(1);

  return profile?.id ?? null;
}

/** Paginated, tenant-scoped appointment list with joined display names. */
export async function listAppointments(
  tenantId: string,
  filters: AppointmentListFilters,
  actor: AppointmentActorContext,
): Promise<AppointmentListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(appointments.tenantId, tenantId)];
    const doctorScope = await resolveDoctorScope(tx, tenantId, actor);

    if (doctorScope !== null) {
      if (filters.doctorId !== undefined && filters.doctorId !== doctorScope) {
        throw AppError.forbidden("Doctors may only view appointments assigned to them");
      }

      conditions.push(eq(appointments.doctorId, doctorScope));
    } else if (filters.doctorId !== undefined) {
      conditions.push(eq(appointments.doctorId, filters.doctorId));
    }

    if (filters.patientId !== undefined) {
      conditions.push(eq(appointments.patientId, filters.patientId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(appointments.branchId, filters.branchId));
    }
    if (filters.departmentId !== undefined) {
      conditions.push(eq(appointments.departmentId, filters.departmentId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(appointments.appointmentStatus, filters.status));
    }
    if (filters.source !== undefined) {
      conditions.push(eq(appointments.appointmentSource, filters.source));
    }
    if (filters.dateFrom !== undefined) {
      conditions.push(gte(appointments.startAt, utcDayStart(filters.dateFrom)));
    }
    if (filters.dateTo !== undefined) {
      conditions.push(
        lt(appointments.startAt, new Date(utcDayStart(filters.dateTo).getTime() + DAY_MS)),
      );
    }

    if (filters.search !== undefined && filters.search.trim().length > 0) {
      const pattern = `%${filters.search.trim()}%`;
      const searchClause = or(
        ilike(appointments.appointmentCode, pattern),
        ilike(patientProfiles.fullName, pattern),
        ilike(patientProfiles.patientCode, pattern),
      );

      if (searchClause) conditions.push(searchClause);
    }

    const where = and(...conditions);

    // Both queries share the same joins so the count matches the filtered rows.
    const totals = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(appointments)
      .innerJoin(
        patientProfiles,
        and(
          eq(patientProfiles.id, appointments.patientId),
          eq(patientProfiles.tenantId, appointments.tenantId),
        ),
      )
      .innerJoin(
        doctors,
        and(eq(doctors.id, appointments.doctorId), eq(doctors.tenantId, appointments.tenantId)),
      )
      .where(where);

    const rows = await tx
      .select({
        id: appointments.id,
        appointmentCode: appointments.appointmentCode,
        patientId: appointments.patientId,
        patientCode: patientProfiles.patientCode,
        patientName: patientProfiles.fullName,
        doctorId: appointments.doctorId,
        doctorCode: doctors.doctorCode,
        doctorName: users.fullName,
        branchId: appointments.branchId,
        branchName: branches.name,
        departmentId: appointments.departmentId,
        appointmentType: appointments.appointmentType,
        appointmentStatus: appointments.appointmentStatus,
        appointmentSource: appointments.appointmentSource,
        startAt: appointments.startAt,
        endAt: appointments.endAt,
        reason: appointments.reason,
        createdAt: appointments.createdAt,
        updatedAt: appointments.updatedAt,
      })
      .from(appointments)
      .innerJoin(
        patientProfiles,
        and(
          eq(patientProfiles.id, appointments.patientId),
          eq(patientProfiles.tenantId, appointments.tenantId),
        ),
      )
      .innerJoin(
        doctors,
        and(eq(doctors.id, appointments.doctorId), eq(doctors.tenantId, appointments.tenantId)),
      )
      .innerJoin(users, eq(users.id, doctors.userId))
      .innerJoin(
        branches,
        and(eq(branches.id, appointments.branchId), eq(branches.tenantId, appointments.tenantId)),
      )
      .where(where)
      .orderBy(desc(appointments.startAt), asc(appointments.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const total = totals[0]?.total ?? 0;

    const items: AppointmentSummaryDto[] = rows.map((row) => ({
      ...row,
      durationMinutes: Math.round(
        (row.endAt.getTime() - row.startAt.getTime()) / 60_000,
      ),
    }));

    return {
      appointments: items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

/** Detail read by id. Missing and cross-tenant ids are indistinguishable. */
export async function getAppointmentById(
  tenantId: string,
  appointmentId: string,
  actor: AppointmentActorContext,
): Promise<AppointmentBookingDto> {
  const id = assertUuid(appointmentId, "Appointment id");

  return withTenantTransaction(tenantId, async (tx) => {
    const snapshot = await loadAppointmentSnapshot(tx, tenantId, id);
    await assertDoctorScope(tx, tenantId, snapshot.appointment.doctorId, actor);

    return loadAppointmentDto(tx, tenantId, id);
  });
}

/** Detail read by the tenant-unique operational appointment code. */
export async function getAppointmentByCode(
  tenantId: string,
  appointmentCode: string,
  actor: AppointmentActorContext,
): Promise<AppointmentBookingDto> {
  const code = appointmentCode.trim().toUpperCase();

  return withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: appointments.id, doctorId: appointments.doctorId })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, tenantId),
          eq(appointments.appointmentCode, code),
        ),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Appointment not found");

    await assertDoctorScope(tx, tenantId, row.doctorId, actor);

    return loadAppointmentDto(tx, tenantId, row.id);
  });
}
