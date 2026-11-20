import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, uuid } from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { createdAt } from "./columns.js";
import { appointmentEventTypeEnum, appointmentStatusEnum } from "./enums.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Append-only history of an appointment: creation, status transitions,
 * rescheduling, cancellation and non-status edits.
 *
 * One row per event, so cancellation and rescheduling keep their previous and
 * new state instead of being overwritten on `appointments`. `metadata` is a
 * JSONB bag for event-specific detail (old/new start_at on a reschedule, the
 * changed field list on an update, ...); it must not contain clinical notes.
 *
 * `created_at` is the event timestamp. The table has no `updated_at` and no
 * delete path: history is written once and preserved. The `ON DELETE CASCADE`
 * from `appointments` only fires during a deliberate whole-tenant purge, which
 * is not a normal operation - appointments are cancelled, never removed.
 *
 * `previous_status` / `new_status` are nullable because non-status events
 * (CREATED, UPDATED) have no transition, and because an imported appointment
 * may have unknown prior state. `actor_user_id` is nullable and SET NULL so a
 * departing account does not erase history.
 */
export const appointmentEvents = pgTable(
  "appointment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").notNull(),
    eventType: appointmentEventTypeEnum("event_type").notNull(),
    previousStatus: appointmentStatusEnum("previous_status"),
    newStatus: appointmentStatusEnum("new_status"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Event-specific payload; defaults to an empty object, never null. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Also the event timestamp. */
    createdAt: createdAt(),
  },
  (table) => [
    // History is read per appointment in chronological order.
    index("appointment_events_appointment_idx").on(
      table.tenantId,
      table.appointmentId,
      table.createdAt,
    ),
    foreignKey({
      name: "appointment_events_appointment_fk",
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }).onDelete("cascade"),
  ],
);

export type AppointmentEvent = typeof appointmentEvents.$inferSelect;
export type NewAppointmentEvent = typeof appointmentEvents.$inferInsert;
