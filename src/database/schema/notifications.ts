import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, timestamp, unique, uuid, varchar, text } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { notificationChannelEnum, notificationDeliveryStatusEnum, notificationLocaleEnum } from "./enums.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";
import { patientProfiles } from "./patient-profiles.js";

export const notificationTemplates = pgTable("notification_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 100 }).notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  locale: notificationLocaleEnum("locale").notNull().default("EN"),
  subject: varchar("subject", { length: 300 }),
  body: text("body").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("notification_templates_tenant_event_channel_locale_unique").on(table.tenantId, table.event, table.channel, table.locale),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  patientId: uuid("patient_id"),
  event: varchar("event", { length: 100 }).notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  status: notificationDeliveryStatusEnum("status").notNull().default("PENDING"),
  sourceEventId: varchar("source_event_id", { length: 200 }).notNull(),
  recipient: varchar("recipient", { length: 320 }),
  subject: varchar("subject", { length: 300 }),
  body: text("body").notNull(),
  payload: jsonb("payload").notNull().default({}),
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** In-app acknowledgement; NULL means unread. Never set for external channels. */
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("notifications_tenant_source_channel_unique").on(table.tenantId, table.sourceEventId, table.channel),
  index("notifications_tenant_user_created_idx").on(table.tenantId, table.userId, table.createdAt),
  index("notifications_tenant_user_status_idx").on(
    table.tenantId,
    table.userId,
    table.status,
    table.createdAt,
  ),
  index("notifications_tenant_user_unread_idx")
    .on(table.tenantId, table.userId, table.readAt)
    .where(sql`${table.readAt} is null`),
  index("notifications_delivery_idx").on(table.nextAttemptAt),
  foreignKey({ name: "notifications_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patientProfiles.tenantId, patientProfiles.id] }).onDelete("cascade"),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 100 }),
  channel: notificationChannelEnum("channel").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("notification_preferences_tenant_user_event_channel_unique").on(table.tenantId, table.userId, table.event, table.channel),
]);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
