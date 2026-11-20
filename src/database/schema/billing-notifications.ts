import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import {
  billingNotificationChannelEnum,
  billingNotificationEventEnum,
  billingNotificationStatusEnum,
} from "./enums.js";
import { invoiceRefunds } from "./invoice-refunds.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";
import { tenants } from "./tenants.js";

/**
 * Tenant-aware billing notification templates (Phase 19.10).
 *
 * The code ships safe defaults; a tenant may override any event/channel pair by
 * inserting a row here. Templates are plain text (email text body / SMS text),
 * so no HTML or script can be stored, and the renderer only substitutes an
 * explicit allow-list of billing placeholders.
 */
export const billingNotificationTemplates = pgTable(
  "billing_notification_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    event: billingNotificationEventEnum("event").notNull(),
    channel: billingNotificationChannelEnum("channel").notNull(),
    subject: varchar("subject", { length: 200 }),
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("billing_notification_templates_tenant_event_channel_unique").on(
      table.tenantId,
      table.event,
      table.channel,
    ),
  ],
);

/**
 * Transactional outbox and delivery history for billing notifications.
 *
 * Enqueue happens inside the financial transaction through a savepoint: a
 * notification insert failure never rolls back an invoice/payment/refund, while
 * a successful insert commits atomically with that financial event. The
 * scheduler/worker claims rows with `FOR UPDATE SKIP LOCKED`, so repeated or
 * concurrent runs cannot send the same notification twice.
 *
 * `dedupe_key` is unique per tenant and encodes the event + source record +
 * reminder interval; reminders use `ON CONFLICT DO NOTHING`, which is the
 * database-level duplicate prevention guarantee.
 *
 * The row stores the rendered plain-text message snapshot and the recipient.
 * History APIs mask the recipient; logs never include it.
 */
export const billingNotifications = pgTable(
  "billing_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    event: billingNotificationEventEnum("event").notNull(),
    channel: billingNotificationChannelEnum("channel").notNull(),
    status: billingNotificationStatusEnum("status").notNull().default("PENDING"),
    invoiceId: uuid("invoice_id"),
    paymentId: uuid("payment_id"),
    refundId: uuid("refund_id"),
    templateId: uuid("template_id").references(() => billingNotificationTemplates.id, {
      onDelete: "set null",
    }),
    recipient: varchar("recipient", { length: 320 }).notNull(),
    subject: varchar("subject", { length: 300 }),
    body: text("body").notNull(),
    /** Non-sensitive snapshot for history (invoice number, amount, due date...). */
    payload: jsonb("payload").notNull().default({}),
    dedupeKey: varchar("dedupe_key", { length: 220 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    /** Provider/error classification only; never a recipient or API key. */
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("billing_notifications_tenant_dedupe_unique").on(
      table.tenantId,
      table.dedupeKey,
    ),
    index("billing_notifications_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("billing_notifications_tenant_invoice_idx").on(
      table.tenantId,
      table.invoiceId,
      table.event,
    ),
    index("billing_notifications_delivery_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('PENDING', 'FAILED', 'PROCESSING')`),
    check("billing_notifications_attempts_check", sql`${table.attempts} >= 0`),
    check("billing_notifications_max_attempts_check", sql`${table.maxAttempts} > 0`),
    check("billing_notifications_recipient_check", sql`length(${table.recipient}) > 0`),
    foreignKey({
      name: "billing_notifications_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "billing_notifications_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete("no action"),
    foreignKey({
      name: "billing_notifications_refund_fk",
      columns: [table.tenantId, table.refundId],
      foreignColumns: [invoiceRefunds.tenantId, invoiceRefunds.id],
    }).onDelete("no action"),
  ],
);

export type BillingNotification = typeof billingNotifications.$inferSelect;
export type NewBillingNotification = typeof billingNotifications.$inferInsert;
export type BillingNotificationTemplate = typeof billingNotificationTemplates.$inferSelect;
export type NewBillingNotificationTemplate = typeof billingNotificationTemplates.$inferInsert;
