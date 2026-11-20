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
import { invoiceRefundStatusEnum } from "./enums.js";
import { invoicePayments } from "./invoice-payments.js";
import { invoices } from "./invoices.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * One refund transaction against an invoice (Task 19.3.1).
 *
 * Only `refundStatus = 'SUCCESSFUL'` rows reduce the net amount paid; a
 * `PENDING` or `FAILED` refund changes nothing. `payment_id` optionally points
 * at the payment attempt being reversed, and its three-column composite key
 * keeps a refund from referencing another tenant's payment or a payment that
 * belongs to a different invoice.
 *
 * Phase 19.7.1 adds the request/approval/processing lifecycle and the
 * gateways fields needed to refund an online capture:
 *
 * - PENDING -> APPROVED -> PROCESSING -> SUCCESSFUL | FAILED;
 *   PENDING -> REJECTED; FAILED -> PROCESSING (retry);
 * - only SUCCESSFUL reduces the invoice's net paid money, so unverified or
 *   failed attempts never mark an invoice refunded;
 * - provider/provider_refund_id/reference preserve the external evidence, and
 *   `failure_reason` records a safe, non-secret failure summary;
 * - `idempotency_key` is unique per tenant, so a retried request replays the
 *   original refund instead of creating a second one;
 * - `request_hash` makes a key reused for a different request a conflict.
 *
 * Rows are financial history and are never hard deleted. Refunds stay tied to
 * one `invoice_payments` attempt through the three-column composite key, so a
 * refund can never exceed or point outside the capture it reverses.
 */
export const invoiceRefunds = pgTable(
  "invoice_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull(),
    /** The payment attempt being reversed, when known. */
    paymentId: uuid("payment_id"),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    refundStatus: invoiceRefundStatusEnum("refund_status").notNull().default("PENDING"),
    /** Requester's reason; preserved for the full history. */
    reason: text("reason"),
    /** Approval/rejection note; kept separately from the request reason. */
    decisionReason: text("decision_reason"),
    /** External refund reference (gateway or desk voucher). Never a secret. */
    reference: varchar("reference", { length: 120 }),
    /** Registry key of the gateway that processed this refund, when online. */
    provider: varchar("provider", { length: 40 }),
    providerRefundId: varchar("provider_refund_id", { length: 120 }),
    failureReason: text("failure_reason"),
    /** Client retry key; unique per tenant when supplied. */
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    requestHash: varchar("request_hash", { length: 64 }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Set when the refund reaches SUCCESSFUL/FAILED (terminal processing). */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("invoice_refunds_tenant_id_id_unique").on(table.tenantId, table.id),
    index("invoice_refunds_invoice_idx").on(
      table.tenantId,
      table.invoiceId,
      table.refundStatus,
    ),
    // Successful-refund reporting by date. The partial predicate keeps the
    // index small and matches the report's `refund_status = 'SUCCESSFUL'`.
    index("invoice_refunds_tenant_refunded_idx")
      .on(table.tenantId, table.refundedAt)
      .where(sql`${table.refundStatus} = 'SUCCESSFUL'`),
    // Refund history for one capture; also the lock target for cumulative limits.
    index("invoice_refunds_payment_idx").on(
      table.tenantId,
      table.paymentId,
      table.refundStatus,
    ),
    // A retried request can never create a second refund.
    uniqueIndex("invoice_refunds_tenant_idempotency_key_unique")
      .on(table.tenantId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    // External evidence is unique: one refund cannot be recorded twice.
    uniqueIndex("invoice_refunds_tenant_reference_unique")
      .on(table.tenantId, table.reference)
      .where(sql`${table.reference} is not null`),
    uniqueIndex("invoice_refunds_provider_refund_unique")
      .on(table.tenantId, table.provider, table.providerRefundId)
      .where(sql`${table.providerRefundId} is not null`),
    check("invoice_refunds_amount_check", sql`${table.amount} >= 0`),
    check("invoice_refunds_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    foreignKey({
      name: "invoice_refunds_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "invoice_refunds_payment_fk",
      columns: [table.tenantId, table.invoiceId, table.paymentId],
      foreignColumns: [
        invoicePayments.tenantId,
        invoicePayments.invoiceId,
        invoicePayments.id,
      ],
    }).onDelete("restrict"),
  ],
);

export type InvoiceRefund = typeof invoiceRefunds.$inferSelect;
export type NewInvoiceRefund = typeof invoiceRefunds.$inferInsert;
