import { sql } from "drizzle-orm";
import { check, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Per-tenant counter behind invoice number generation (Phase 19).
 *
 * Invoice numbers are never derived from `count(*)` or `max(invoice_number)`:
 * both race when two receptionists raise an invoice at the same time. The
 * allocation is a single `insert ... on conflict do update ... returning
 * last_value`, which takes a row lock and serialises allocators for the
 * remainder of the creation transaction.
 *
 * The counter is not the uniqueness guarantee. `invoices.invoice_number` keeps
 * its `(tenant_id, invoice_number)` unique index, and the service also probes
 * for an existing number so manually entered numbers outside the generated
 * range cannot be handed out twice. Because allocation happens inside the
 * invoice transaction, a rollback returns the number to the pool.
 *
 * Not exposed through any API; `last_value` is internal.
 */
export const invoiceNumberSequences = pgTable(
  "invoice_number_sequences",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lastValue: integer("last_value").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("invoice_number_sequences_last_value_check", sql`${table.lastValue} >= 0`)],
);

export type InvoiceNumberSequence = typeof invoiceNumberSequences.$inferSelect;
export type NewInvoiceNumberSequence = typeof invoiceNumberSequences.$inferInsert;
