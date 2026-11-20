import { index, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";

/**
 * Global permission catalogue. Permissions are not tenant-scoped: the set of
 * actions the product understands is the same for every hospital, and tenants
 * gain them by attaching them to their own roles through `role_permissions`.
 *
 * `module` is a plain varchar rather than an enum so a future module (e.g.
 * "lab", "inventory") can be added without a migration that rewrites the type.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable machine key in `<module>:<action>` form, e.g. `patient:read`. */
    permissionKey: varchar("permission_key", { length: 120 }).notNull(),
    module: varchar("module", { length: 50 }).notNull(),
    description: varchar("description", { length: 255 }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("permissions_key_unique").on(table.permissionKey),
    index("permissions_module_idx").on(table.module),
  ],
);

export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
