import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { createdAt } from "./columns.js";
import { appointmentIdempotencyStatusEnum } from "./enums.js";
import { tenants } from "./tenants.js";

/**
 * Replay protection for booking requests. A client that retries after a network
 * timeout sends the same `idempotency_key`; the unique key below makes the
 * second insert fail, so the booking service can return the original
 * appointment instead of creating a duplicate.
 *
 * Scope: uniqueness is `(tenant_id, operation, idempotency_key)`. `operation`
 * exists so the same key may be reused for a different command later (for
 * example a future cancellation) without colliding with the booking. Hospital
 * tenants are independent, so the same client-generated key is legal in another
 * tenant.
 *
 * `request_hash` is a SHA-256 hex digest of the canonical request body. It lets
 * the future service reject reuse of a key with a different payload (HTTP 409)
 * rather than returning an unrelated appointment. `appointment_id` stays NULL
 * until the booking commits; if the client never retries, `expires_at` makes
 * the row collectable by a future cleanup job. No service logic is implemented
 * in this phase.
 */
export const appointmentIdempotencyKeys = pgTable(
  "appointment_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Command the key is scoped to; the booking operation is `appointment.create`. */
    operation: varchar("operation", { length: 50 }).notNull().default("appointment.create"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    /** SHA-256 hex digest (64 characters) of the canonical request. */
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    appointmentId: uuid("appointment_id"),
    status: appointmentIdempotencyStatusEnum("status").notNull().default("IN_PROGRESS"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("appointment_idempotency_keys_unique").on(
      table.tenantId,
      table.operation,
      table.idempotencyKey,
    ),
    // Lookup of the appointment a completed key produced.
    index("appointment_idempotency_keys_appointment_idx").on(
      table.tenantId,
      table.appointmentId,
    ),
    // Future expiry sweep.
    index("appointment_idempotency_keys_expiry_idx").on(table.tenantId, table.expiresAt),
    foreignKey({
      name: "appointment_idempotency_keys_appointment_fk",
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }).onDelete("cascade"),
  ],
);

export type AppointmentIdempotencyKey = typeof appointmentIdempotencyKeys.$inferSelect;
export type NewAppointmentIdempotencyKey = typeof appointmentIdempotencyKeys.$inferInsert;
