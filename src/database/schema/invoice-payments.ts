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
import { createdAt, updatedAt } from "./columns.js";
import { invoicePaymentStatusEnum } from "./enums.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * One payment attempt against an invoice (Task 19.3.1).
 *
 * This table is the source of truth for how much of an invoice has actually
 * been settled, so the invoice header is never trusted on its own:
 *
 * - only `paymentStatus = 'SUCCESSFUL'` rows count toward `invoices.amount_paid`
 *   and reduce `invoices.balance_due`;
 * - `PENDING` and `FAILED` attempts are kept for history but settle nothing;
 * - `REFUNDED` marks an attempt whose money was returned outside the refund
 *   ledger. When the reversal is recorded in `invoice_refunds`, keep the
 *   payment `SUCCESSFUL`: the balance is `successful payments - successful
 *   refunds`, so flipping it to REFUNDED as well would double count.
 *
 * Recording a payment or refund is deliberately out of scope here (no gateway
 * integration, no processing service). The lifecycle service only reads these
 * rows to derive balances and status. Writes are expected from the later
 * payment task, inside the same tenant transaction.
 *
 * Amounts are `NUMERIC(12, 2)` like every other money column. The composite
 * foreign key to `invoices` makes a cross-tenant payment impossible even if a
 * service check is bypassed. Nothing is ever hard deleted: payments are
 * financial history.
 */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull(),
    /**
     * The receipt-level collection that created this settlement (Task 19.4.2).
     * NULL for gateway or directly-seeded attempts; a manual payment always
     * writes its id so reconciliation can prove the allocation and settlement
     * ledgers agree and so a receipt cannot be deleted from under its money.
     */
    paymentId: uuid("payment_id"),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    paymentStatus: invoicePaymentStatusEnum("payment_status").notNull().default("PENDING"),
    /** Free-form provider/clerk reference; never a card number or secret. */
    reference: varchar("reference", { length: 120 }),
    /** Set when the attempt succeeds; informational, not a gate. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** NULL for system/gateway-created attempts; SET NULL when a user leaves. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Targets of the composite keys from invoice_refunds. The three-column key
    // also proves that a refund points at a payment of the same invoice, not
    // merely at a payment of the same tenant.
    unique("invoice_payments_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("invoice_payments_tenant_invoice_id_unique").on(
      table.tenantId,
      table.invoiceId,
      table.id,
    ),
    // Balance derivation and per-invoice history.
    index("invoice_payments_invoice_idx").on(
      table.tenantId,
      table.invoiceId,
      table.paymentStatus,
    ),
    // One manual payment settles one invoice at most once. The service already
    // refuses duplicate allocations; this index makes a duplicate settlement
    // impossible even if a future writer bypasses it.
    uniqueIndex("invoice_payments_tenant_payment_invoice_unique")
      .on(table.tenantId, table.paymentId, table.invoiceId)
      .where(sql`${table.paymentId} is not null`),
    check("invoice_payments_amount_check", sql`${table.amount} >= 0`),
    // Only money that was actually collected may settle an invoice: a
    // payment-linked settlement is always SUCCESSFUL and can never be flipped
    // to PENDING/FAILED/REFUNDED (refunds are recorded in invoice_refunds).
    check(
      "invoice_payments_manual_payment_status_check",
      sql`${table.paymentId} is null or ${table.paymentStatus} = 'SUCCESSFUL'`,
    ),
    check(
      "invoice_payments_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    foreignKey({
      name: "invoice_payments_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
    // NO ACTION (checked at end of statement) protects financial history: a
    // receipt with settlements cannot be deleted on its own, while a tenant
    // purge still cascades payments and invoices together in one statement.
    foreignKey({
      name: "invoice_payments_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete("no action"),
  ],
);

export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
