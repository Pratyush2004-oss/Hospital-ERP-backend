import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { users } from "./users.js";

/**
 * Single-use password reset tokens (hashed), short lived and never logged.
 * Issuing a replacement revokes outstanding unused tokens for the account, so
 * only the newest reset link can be used. `used_at` records consumption and
 * `revoked_at` records supersession without changing consumption history.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(table.tokenHash),
    index("password_reset_tokens_user_idx").on(table.userId, table.createdAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
