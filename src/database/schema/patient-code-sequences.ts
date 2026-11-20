import { sql } from "drizzle-orm";
import { check, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Per-tenant counter behind patient code (MRN) generation.
 *
 * The counter exists so registration never derives the next code from
 * `count(*)` or `max(patient_code)`, both of which race under concurrent
 * registrations. Allocation is a single `insert ... on conflict do update ...
 * returning last_value`, which takes a row lock and therefore serialises
 * allocators inside the registration transaction.
 *
 * The counter is *not* the uniqueness guarantee: `patient_profiles` keeps its
 * `(tenant_id, patient_code)` unique index as the final protection. A rollback
 * returns the number to the pool, which is safe because every candidate is
 * probed against `patient_profiles` before use.
 *
 * Not exposed through any API; `last_value` is internal and never returned to
 * clients.
 */
export const patientCodeSequences = pgTable(
  "patient_code_sequences",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lastValue: integer("last_value").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("patient_code_sequences_last_value_check", sql`${table.lastValue} >= 0`)],
);

export type PatientCodeSequence = typeof patientCodeSequences.$inferSelect;
export type NewPatientCodeSequence = typeof patientCodeSequences.$inferInsert;
