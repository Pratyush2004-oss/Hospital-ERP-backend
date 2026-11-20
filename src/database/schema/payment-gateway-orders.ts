import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { paymentGatewayOrderStatusEnum } from "./enums.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";
import { tenants } from "./tenants.js";

/**
 * One provider checkout order created while initiating an online payment
 * (Task 19.6.1).
 *
 * The generic billing layer knows only `PaymentGateway`; provider-specific
 * order ids, transaction references and metadata live here, never on the
 * receipt table. This keeps `payments` provider-independent and lets a second
 * provider be added without changing the ledger schema.
 *
 * Rules:
 * - `payments` is the receipt-level attempt and is always `PENDING` while the
 *   checkout order is open. No settlement row is written at initiation, so an
 *   open order never reduces the invoice balance;
 * - `(tenant_id, provider, provider_order_id)` is unique: the same provider
 *   order can never be recorded twice;
 * - `(tenant_id, payment_id)` is unique: one open checkout per payment;
 * - `metadata` holds only non-secret provider data (for example the checkout
 *   mode or an expiry hint). API keys, tokens and card data are never stored;
 * - every parent is referenced through a composite tenant key, so an order can
 *   never link another hospital's payment or invoice.
 *
 * The settlement task will move the order and its payment to their final states
 * after verified provider confirmation. This task creates `PENDING` rows only.
 */
export const paymentGatewayOrders = pgTable(
  "payment_gateway_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    /** Registry key, e.g. `mock`. Never a secret or an API endpoint. */
    provider: varchar("provider", { length: 40 }).notNull(),
    /** Provider-side order/checkout id. */
    providerOrderId: varchar("provider_order_id", { length: 120 }).notNull(),
    /** Provider transaction reference when one exists at initiation. */
    providerTransactionReference: varchar("provider_transaction_reference", {
      length: 120,
    }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: paymentGatewayOrderStatusEnum("status").notNull().default("PENDING"),
    /** Non-secret provider metadata; never credentials or card data. */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    /** Provider checkout expiry, when the provider supplies one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payment_gateway_orders_provider_order_unique").on(
      table.tenantId,
      table.provider,
      table.providerOrderId,
    ),
    uniqueIndex("payment_gateway_orders_payment_unique").on(
      table.tenantId,
      table.paymentId,
    ),
    index("payment_gateway_orders_invoice_idx").on(
      table.tenantId,
      table.invoiceId,
      table.status,
    ),
    check("payment_gateway_orders_amount_check", sql`${table.amount} > 0`),
    check(
      "payment_gateway_orders_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    foreignKey({
      name: "payment_gateway_orders_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete("no action"),
    foreignKey({
      name: "payment_gateway_orders_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
  ],
);

export type PaymentGatewayOrder = typeof paymentGatewayOrders.$inferSelect;
export type NewPaymentGatewayOrder = typeof paymentGatewayOrders.$inferInsert;
