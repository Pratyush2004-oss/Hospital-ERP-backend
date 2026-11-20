import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";

/**
 * Allocation of one payment to one invoice (Task 19.4.1).
 *
 * A front-desk collection may settle several invoices at once (for example one
 * payment covering a consultation and a laboratory bill). Each row is the exact
 * amount applied to one invoice; the amounts of a payment must add up to its
 * `payments.amount`.
 *
 * - `amount` is positive and cannot exceed the invoice balance at recording
 *   time; that rule needs the invoice total and the payment ledger, so it is
 *   enforced by the payment service inside the locked transaction.
 * - `(tenant_id, payment_id, invoice_id)` is unique: one allocation per invoice
 *   per payment. Splitting the same invoice across two rows would make the
 *   per-invoice ledger ambiguous.
 * - Both parents are referenced through composite tenant keys, so an allocation
 *   can never point at another hospital's payment or invoice.
 * - Rows are financial history and are never hard deleted. The payment link is
 *   `NO ACTION`, so a receipt that has been allocated cannot be deleted on its
 *   own (a tenant purge still cascades payments and invoices together).
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("payment_allocations_payment_invoice_unique").on(
      table.tenantId,
      table.paymentId,
      table.invoiceId,
    ),
    // Invoice payment history and reconciliation lookups.
    index("payment_allocations_invoice_idx").on(table.tenantId, table.invoiceId),
    // Payment detail (all allocations of one receipt).
    index("payment_allocations_payment_idx").on(table.tenantId, table.paymentId),
    check("payment_allocations_amount_check", sql`${table.amount} > 0`),
    foreignKey({
      name: "payment_allocations_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete("no action"),
    foreignKey({
      name: "payment_allocations_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
  ],
);

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type NewPaymentAllocation = typeof paymentAllocations.$inferInsert;
