import { index, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, updatedAt } from "./columns.js";
import { tenantStatusEnum } from "./enums.js";

/** A hospital (tenant). Every tenant-scoped row carries this table's id. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    /** URL-safe identifier; globally unique across all tenants. */
    slug: varchar("slug", { length: 100 }).notNull(),
    legalName: varchar("legal_name", { length: 255 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),
    logoUrl: text("logo_url"),
    status: tenantStatusEnum("status").notNull().default("PENDING"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("tenants_slug_unique").on(table.slug),
    index("tenants_status_idx").on(table.status),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
