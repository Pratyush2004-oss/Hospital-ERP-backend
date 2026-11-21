import {
  index,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { membershipStatusEnum } from "./enums.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Join table between global users and tenants. There is deliberately no unique
 * constraint on user_id alone: one account may belong to many hospitals.
 */
export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: membershipStatusEnum("status").notNull().default("INVITED"),
    /** Validated branch/department assignments carried from the invitation. */
    branchIds: jsonb("branch_ids").$type<string[]>().notNull().default([]),
    departmentIds: jsonb("department_ids").$type<string[]>().notNull().default([]),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Prevent duplicate memberships for the same user in the same tenant.
    uniqueIndex("tenant_memberships_tenant_user_unique").on(table.tenantId, table.userId),
    // Composite key so tenant-scoped tables can reference memberships with
    // (tenant_id, id) and never link across tenants.
    unique("tenant_memberships_tenant_id_id_unique").on(table.tenantId, table.id),
    index("tenant_memberships_user_idx").on(table.userId),
    index("tenant_memberships_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;
