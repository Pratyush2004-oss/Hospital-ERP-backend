import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, time, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { doctorSchedules } from "./doctor-schedules.js";

/**
 * A recurring pause inside one working period (lunch, ward round, prayer).
 *
 * Breaks hang off a schedule row, not off a doctor: their validity is relative
 * to that window, and the composite `(tenant_id, schedule_id)` foreign key keeps
 * them in the same tenant and removes them when the period is deleted.
 *
 * `end_time > start_time` is enforced here. Containment inside the parent
 * window is a cross-row rule, so migration 0010 enforces it with a BEFORE
 * INSERT/UPDATE trigger (`doctor_breaks_within_schedule`). Overlapping breaks
 * for the same schedule are rejected by a GiST exclusion constraint on the
 * time-of-day range; adjacent breaks (11:00-11:15 then 11:15-11:30) remain
 * legal because ranges are half-open. Shrinking a schedule window does not
 * retroactively validate existing breaks - the service must revalidate them.
 */
export const doctorBreaks = pgTable(
  "doctor_breaks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    reason: varchar("reason", { length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("doctor_breaks_schedule_idx").on(table.tenantId, table.scheduleId),
    check("doctor_breaks_time_order_check", sql`${table.endTime} > ${table.startTime}`),
    foreignKey({
      name: "doctor_breaks_schedule_fk",
      columns: [table.tenantId, table.scheduleId],
      foreignColumns: [doctorSchedules.tenantId, doctorSchedules.id],
    }).onDelete("cascade"),
  ],
);

export type DoctorBreak = typeof doctorBreaks.$inferSelect;
export type NewDoctorBreak = typeof doctorBreaks.$inferInsert;
