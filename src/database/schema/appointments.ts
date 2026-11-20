import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt, updatedAt } from "./columns.js";
import { departments } from "./departments.js";
import { doctorBranches } from "./doctor-branches.js";
import { doctors } from "./doctors.js";
import { appointmentSourceEnum, appointmentStatusEnum, appointmentTypeEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * A booked consultation. This is the root record of the appointment engine; it
 * stores the reservation itself and never payment, clinical notes or audit
 * history (those live in their own modules / `appointment_events`).
 *
 * Relationships are tenant-aware through composite foreign keys:
 * - `(tenant_id, patient_id)`  -> patient_profiles(tenant_id, id)
 * - `(tenant_id, doctor_id, branch_id)` -> doctor_branches(...) proves the
 *   doctor is actually assigned to the booked branch and keeps the tenant in
 *   every lookup
 * - `(tenant_id, department_id)` -> departments(tenant_id, id), nullable because
 *   walk-in and general-practice bookings may not choose a department. Whether
 *   the department operates at the branch and is covered by the doctor is a
 *   service rule: PostgreSQL has no composite key across those two tables.
 *
 * Status is deliberately independent of payment. A booking created inside the
 * transaction that reserves the slot is immediately CONFIRMED (the column
 * default); PENDING exists for imported/intake flows only and is not an
 * approval step. `RESCHEDULED`, `CANCELLED`, `NO_SHOW` and `COMPLETED` are
 * terminal states: a reschedule is recorded as a new appointment plus a
 * RESCHEDULED marker on the superseded row, so the old slot is released.
 *
 * Double-booking is prevented in the database, not only in application code:
 * migration 0015 adds the `appointments_no_overlap` GiST exclusion constraint
 * over `(tenant_id, doctor_id, branch_id)` and the half-open
 * `tstzrange(start_at, end_at, '[)')`, filtered to active statuses. Two active
 * appointments for the same doctor at the same branch may therefore never
 * overlap, even under concurrent bookings; cancelled, no-show, completed and
 * rescheduled rows free their slot. See `docs/appointment-schema.md`.
 *
 * Timestamps are TIMESTAMPTZ (absolute instants). A local booking request is
 * interpreted in `branches.timezone` before it is stored; recurring schedule
 * windows remain branch-local TIME values, as established in Phase 16.
 *
 * `notes` is private operational free text (for example a mobility or
 * interpreter request). It is not a clinical record: read/write access is
 * gated by the appointment permissions and the column must never be returned by
 * list endpoints or written to logs. `created_by` is required and restricts
 * hard deletion of the account (accounts are deactivated in normal operation);
 * `cancelled_by` is nullable so a system cancellation (for example an approved
 * doctor leave) can be recorded without inventing a user.
 *
 * No `deleted_at`: cancellation is the deletion concept for an appointment and
 * the row must remain for history and audit. There is also no hard-delete
 * path; `appointment_events` cascades only if the whole tenant is purged.
 */
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    /** NULL = no department was selected for the booking. */
    departmentId: uuid("department_id"),
    /** Operational identifier printed on slips; unique per hospital. */
    appointmentCode: varchar("appointment_code", { length: 40 }).notNull(),
    /** Channel that created the booking (voice-agent integration is future work). */
    appointmentSource: appointmentSourceEnum("appointment_source").notNull(),
    appointmentType: appointmentTypeEnum("appointment_type").notNull().default("CONSULTATION"),
    appointmentStatus: appointmentStatusEnum("appointment_status").notNull().default("CONFIRMED"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    /** Exclusive end of the slot; computed from the schedule slot duration. */
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    consultationFee: numeric("consultation_fee", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    reason: text("reason"),
    /** Private operational note; never a clinical record and never logged. */
    notes: text("notes"),
    /**
     * Replacement model (Phase 18.4): when this row was created by rescheduling,
     * it points at the superseded appointment. NULL for a normal booking. The
     * original row is marked RESCHEDULED and releases its slot, so exactly one
     * active appointment remains. The partial unique index below makes a second
     * replacement for the same appointment impossible.
     */
    rescheduledFromAppointmentId: uuid("rescheduled_from_appointment_id"),
    /**
     * Lifecycle timestamps (Phase 18.5). NULL until the corresponding
     * transition happens; each one is written in the same transaction as the
     * status change and its `appointment_events` row. They are operational
     * timestamps, not a second status model: the status column stays
     * authoritative.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    consultationStartedAt: timestamp("consultation_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** NULL when the appointment was cancelled by a system process. */
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancellationReason: text("cancellation_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Target of the composite keys in appointment_events / idempotency keys.
    unique("appointments_tenant_id_id_unique").on(table.tenantId, table.id),
    // Codes are reserved for the lifetime of the tenant, including cancelled rows.
    uniqueIndex("appointments_tenant_code_unique").on(table.tenantId, table.appointmentCode),
    // At most one replacement appointment may point at a superseded row.
    uniqueIndex("appointments_rescheduled_from_unique")
      .on(table.tenantId, table.rescheduledFromAppointmentId)
      .where(sql`${table.rescheduledFromAppointmentId} is not null`),
    // Patient history (newest first when read with `order by start_at desc`).
    index("appointments_patient_history_idx").on(
      table.tenantId,
      table.patientId,
      table.startAt,
    ),
    // Doctor calendar and branch calendar.
    index("appointments_doctor_calendar_idx").on(table.tenantId, table.doctorId, table.startAt),
    index("appointments_branch_calendar_idx").on(table.tenantId, table.branchId, table.startAt),
    // Operational queues and reports by state.
    index("appointments_status_idx").on(table.tenantId, table.appointmentStatus, table.startAt),
    // Date-range scans, e.g. "everything booked this week".
    index("appointments_range_idx").on(table.tenantId, table.startAt, table.endAt),
    check("appointments_time_order_check", sql`${table.endAt} > ${table.startAt}`),
    check("appointments_fee_check", sql`${table.consultationFee} >= 0`),
    check(
      "appointments_cancellation_check",
      sql`${table.appointmentStatus} <> 'CANCELLED' or ${table.cancellationReason} is not null`,
    ),

    foreignKey({
      name: "appointments_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "appointments_doctor_fk",
      columns: [table.tenantId, table.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "appointments_doctor_branch_fk",
      columns: [table.tenantId, table.doctorId, table.branchId],
      foreignColumns: [
        doctorBranches.tenantId,
        doctorBranches.doctorId,
        doctorBranches.branchId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "appointments_department_fk",
      columns: [table.tenantId, table.departmentId],
      foreignColumns: [departments.tenantId, departments.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "appointments_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    // Self-reference: the replacement belongs to the same tenant as its source.
    // NO ACTION keeps a whole-tenant purge working (all rows are removed in the
    // same statement); normal operation never deletes an appointment.
    foreignKey({
      name: "appointments_rescheduled_from_fk",
      columns: [table.tenantId, table.rescheduledFromAppointmentId],
      foreignColumns: [table.tenantId, table.id],
    }).onDelete("no action"),
  ],
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
