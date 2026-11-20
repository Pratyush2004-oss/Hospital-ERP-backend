import { index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { permissions } from "./permissions.js";
import { roles } from "./roles.js";

/**
 * Grants a catalogue permission to a role. Permissions are global, so this join
 * table needs no `tenant_id`: a row belongs to a tenant only through its role.
 *
 * The unique index makes granting the same permission twice a no-op rather than
 * a duplicate row; both sides cascade so deleting a role or retiring a
 * permission cleans up its grants.
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("role_permissions_role_permission_unique").on(table.roleId, table.permissionId),
    index("role_permissions_permission_idx").on(table.permissionId),
  ],
);

export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
