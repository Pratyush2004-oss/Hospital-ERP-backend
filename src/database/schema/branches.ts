import {
  boolean,
  index,
  pgTable,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, updatedAt } from "./columns.js";
import { tenants } from "./tenants.js";

/**
 * A physical hospital location. Branch codes are unique per tenant only.
 *
 * Soft-delete policy: a branch code stays reserved for the lifetime of the
 * tenant, including after the branch row is soft deleted. `branches_tenant_code_unique`
 * is therefore a plain unique index over `(tenant_id, branch_code)` and not a
 * partial index on `deleted_at IS NULL`. Codes are printed on clinical and
 * financial documents, so silently handing a retired code to a different site
 * would make historic records ambiguous. The branch service enforces the same
 * rule when it checks for an existing code.
 *
 * Index coverage: `branches_tenant_code_unique` leads with `tenant_id`, so it
 * also serves tenant-only lookups as a prefix, and `branches_tenant_active_idx`
 * covers the live-branch listing filter `(tenant_id, is_active)`. Branch reads
 * additionally filter `deleted_at IS NULL`; a dedicated partial index is not
 * warranted at this table's size because the tenant-leading indexes already
 * bound the scan to one hospital's branches. Row level security is enabled and
 * forced by migration 0006 (`tenant_isolation` policy).
 */
export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    branchCode: varchar("branch_code", { length: 50 }).notNull(),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 2 }),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("branches_tenant_code_unique").on(table.tenantId, table.branchCode),
    // Referenced by future tenant-scoped tables via (tenant_id, branch_id) so a
    // child row can never point at a branch in a different tenant.
    unique("branches_tenant_id_id_unique").on(table.tenantId, table.id),
    index("branches_tenant_active_idx").on(table.tenantId, table.isActive),
  ],
);

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
