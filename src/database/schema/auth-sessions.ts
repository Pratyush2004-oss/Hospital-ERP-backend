import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * A sign-in session (one per login on one device/browser).
 *
 * The session is the revocation unit: logging out, reusing a rotated refresh
 * token, or changing a password revokes sessions here. Refresh tokens are
 * stored as hashes in `auth_refresh_tokens` and rotate independently.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Tenant selected for this session. Selection is a server-side action that
     * validates an ACTIVE membership; the client never supplies a tenant id on
     * authenticated hospital requests.
     */
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    userAgent: varchar("user_agent", { length: 512 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Until when this session may be refreshed. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** `logout`, `logout_all`, `password_change`, `token_reuse`, `password_reset`. */
    revokedReason: varchar("revoked_reason", { length: 64 }),
  },
  (table) => [
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expires_idx").on(table.expiresAt),
  ],
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
