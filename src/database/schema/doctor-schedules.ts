import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { doctorBranches } from "./doctor-branches.js";

/**
 * Recurring weekly working period for a doctor at one branch.
 *
 * One row per period, so a split shift is simply two rows for the same
 * `(doctor, branch, day_of_week)` - e.g. 09:00-12:00 and 16:00-20:00. Times are
 * PostgreSQL `TIME` (wall clock, no zone) because the period repeats weekly;
 * leave and appointment instants use TIMESTAMPTZ instead.
 *
 * `effective_from` / `effective_until` let a roster change be scheduled ahead of
 * time without deleting history: the pair is a closed date range
 * (`effective_until` NULL means "until further notice").
 *
 * The composite foreign key targets `doctor_branches(tenant_id, doctor_id,
 * branch_id)`, so a schedule can only exist for a branch the doctor is assigned
 * to - and, because that key starts with `tenant_id`, never in another tenant.
 *
 * Database-enforced rules: day 1-7 (ISO, Monday = 1), `end_time > start_time`,
 * at least one slot fits inside the window, `slot_duration_minutes` between 5
 * and 480, a non-negative `buffer_minutes`, and a coherent effective range.
 *
 * Overlaps: migration 0010 adds a GiST exclusion constraint over
 * `(tenant_id, doctor_id, branch_id, day_of_week)` with both the effective-date
 * range and the time-of-day range. Two *active* windows conflict only when both
 * ranges overlap, so a split shift (09:00-13:00 and 16:00-20:00) is legal while
 * a genuinely overlapping window is rejected. Inactive rows are excluded from
 * the constraint so history can be retained. Non-overlap is not a unique rule:
 * the same doctor/branch/day may have any number of non-overlapping windows.
 *
 * A schedule's wall-clock times belong to the branch's `timezone`; no UTC
 * conversion is stored, because the rule repeats weekly and must follow the
 * branch's local clock across DST changes.
 */
export const doctorSchedules = pgTable(
  "doctor_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    /** ISO weekday: 1 = Monday ... 7 = Sunday. */
    dayOfWeek: smallint("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    slotDurationMinutes: smallint("slot_duration_minutes").notNull().default(15),
    /** Pause inserted after each slot; not part of the consultation itself. */
    bufferMinutes: smallint("buffer_minutes").notNull().default(0),
    effectiveFrom: date("effective_from").notNull().default(sql`current_date`),
    effectiveUntil: date("effective_until"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Target of doctor_breaks' composite foreign key.
    unique("doctor_schedules_tenant_id_id_unique").on(table.tenantId, table.id),
    index("doctor_schedules_doctor_day_idx").on(
      table.tenantId,
      table.doctorId,
      table.dayOfWeek,
      table.isActive,
    ),
    index("doctor_schedules_branch_day_idx").on(
      table.tenantId,
      table.branchId,
      table.dayOfWeek,
      table.isActive,
    ),
    // Date-range lookups, e.g. "which windows are effective on 2026-03-01?".
    index("doctor_schedules_effective_idx").on(
      table.tenantId,
      table.effectiveFrom,
      table.effectiveUntil,
    ),
    check("doctor_schedules_day_of_week_check", sql`${table.dayOfWeek} between 1 and 7`),
    check("doctor_schedules_time_order_check", sql`${table.endTime} > ${table.startTime}`),
    check(
      "doctor_schedules_slot_duration_check",
      sql`${table.slotDurationMinutes} between 5 and 480`,
    ),
    check(
      "doctor_schedules_window_fits_slot_check",
      sql`extract(epoch from (${table.endTime} - ${table.startTime})) / 60 >= ${table.slotDurationMinutes}`,
    ),
    check("doctor_schedules_buffer_check", sql`${table.bufferMinutes} >= 0`),
    check(
      "doctor_schedules_effective_range_check",
      sql`${table.effectiveUntil} is null or ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
    foreignKey({
      name: "doctor_schedules_doctor_branch_fk",
      columns: [table.tenantId, table.doctorId, table.branchId],
      foreignColumns: [
        doctorBranches.tenantId,
        doctorBranches.doctorId,
        doctorBranches.branchId,
      ],
    }).onDelete("cascade"),
  ],
);

export type DoctorSchedule = typeof doctorSchedules.$inferSelect;
export type NewDoctorSchedule = typeof doctorSchedules.$inferInsert;
