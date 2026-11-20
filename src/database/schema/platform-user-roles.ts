import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { roles } from "./roles.js";
import { users } from "./users.js";

/**
 * Global platform-plane role assignments.
 *
 * `membership_roles` can only reference hospital roles of one tenant, so
 * HospitalOS staff roles (which have `tenant_id = NULL`) are attached to a user
 * here instead. The service layer additionally requires the role's scope to be
 * PLATFORM, keeping the two authorization planes separate.
 */
export const platformUserRoles = pgTable(
  "platform_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("platform_user_roles_user_role_unique").on(table.userId, table.roleId),
    index("platform_user_roles_role_idx").on(table.roleId),
    index("platform_user_roles_user_idx").on(table.userId),
  ],
);

export type PlatformUserRole = typeof platformUserRoles.$inferSelect;
export type NewPlatformUserRole = typeof platformUserRoles.$inferInsert;
