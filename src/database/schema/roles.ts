import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { roleScopeEnum } from "./enums.js";
import { tenants } from "./tenants.js";

/**
 * A named bundle of permissions.
 *
 * Scope model:
 * - `PLATFORM` roles have `tenant_id = NULL` and belong to HospitalOS itself
 *   (only `PLATFORM_SUPER_ADMIN` today). They are never referenced by
 *   `membership_roles`, which keeps platform authorization separate from
 *   hospital authorization.
 * - `HOSPITAL` roles always have a `tenant_id` and may be either the seeded
 *   system roles (`is_system = true`) or custom roles created by a hospital.
 *
 * Uniqueness:
 * - hospital role slugs are unique per tenant (`(tenant_id, slug)`), so two
 *   tenants may both own a "doctor" role;
 * - platform role slugs are globally unique (partial index on `slug` where
 *   `tenant_id is null`), since separate NULLs are distinct in a plain unique
 *   index.
 *
 * The `(tenant_id, id)` unique constraint exists only so tenant-scoped tables
 * can point at a role with a composite foreign key and never link across
 * tenants.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    scope: roleScopeEnum("scope").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    description: text("description"),
    /** Seeded roles cannot be renamed, deleted or stripped of permissions. */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Target of membership_roles' composite foreign key.
    unique("roles_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("roles_tenant_slug_unique")
      .on(table.tenantId, table.slug)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("roles_platform_slug_unique")
      .on(table.slug)
      .where(sql`${table.tenantId} is null`),
    index("roles_tenant_scope_idx").on(table.tenantId, table.scope),
    // A role is platform-wide or hospital-owned, never both and never neither.
    check(
      "roles_scope_tenant_check",
      sql`(${table.scope} = 'PLATFORM' and ${table.tenantId} is null)
        or (${table.scope} = 'HOSPITAL' and ${table.tenantId} is not null)`,
    ),
  ],
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
