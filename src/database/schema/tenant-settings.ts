import { jsonb, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { tenants } from "./tenants.js";

/** Per-tenant configuration. One row per key, enforced by the unique index. */
export const tenantSettings = pgTable(
  "tenant_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    settingKey: varchar("setting_key", { length: 100 }).notNull(),
    settingValue: jsonb("setting_value").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("tenant_settings_tenant_key_unique").on(table.tenantId, table.settingKey),
  ],
);

export type TenantSetting = typeof tenantSettings.$inferSelect;
export type NewTenantSetting = typeof tenantSettings.$inferInsert;
