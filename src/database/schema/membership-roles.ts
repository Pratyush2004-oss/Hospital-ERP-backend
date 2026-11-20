import { foreignKey, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { roles } from "./roles.js";
import { tenantMemberships } from "./tenant-memberships.js";

/**
 * Assigns hospital roles to a tenant membership. A membership may hold many
 * roles, so this is a plain join table rather than a column on
 * `tenant_memberships`.
 *
 * Tenant isolation is enforced by two composite foreign keys that both include
 * `tenant_id`:
 * - `(tenant_id, tenant_membership_id) -> tenant_memberships(tenant_id, id)`
 * - `(tenant_id, role_id)               -> roles(tenant_id, id)`
 *
 * Because `roles.tenant_id` is NULL for platform roles and `tenant_id` here is
 * NOT NULL, a platform role can never be attached to a hospital membership, and
 * a role can never be granted to a membership of a different tenant. Attempting
 * either is a foreign-key violation, not just an application-level check.
 *
 * `tenant_id` is denormalized (it is derivable from the membership) precisely so
 * those composite keys - and the duplicate guard - are possible.
 */
export const membershipRoles = pgTable(
  "membership_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    tenantMembershipId: uuid("tenant_membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    /** Nullable: the assigner may be a system action or a removed account. */
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (membership, role): assigning twice cannot duplicate access.
    uniqueIndex("membership_roles_membership_role_unique").on(
      table.tenantId,
      table.tenantMembershipId,
      table.roleId,
    ),
    index("membership_roles_role_idx").on(table.tenantId, table.roleId),
    index("membership_roles_assigned_by_idx").on(table.assignedBy),
    foreignKey({
      name: "membership_roles_membership_fk",
      columns: [table.tenantId, table.tenantMembershipId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_roles_role_fk",
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete("cascade"),
  ],
);

export type MembershipRole = typeof membershipRoles.$inferSelect;
export type NewMembershipRole = typeof membershipRoles.$inferInsert;
