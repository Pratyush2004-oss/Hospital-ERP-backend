import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { authSessions } from "./auth-sessions.js";

/**
 * Every refresh token ever issued, stored only as a SHA-256 hash.
 *
 * Rotation inserts a new row and stamps `rotated_at` on the old one. Presenting
 * an already-rotated token is treated as theft: the whole session is revoked.
 * Tokens are opaque random strings (not JWTs), so a database leak alone never
 * yields a usable credential.
 */
export const authRefreshTokens = pgTable(
  "auth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => authSessions.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_refresh_tokens_hash_unique").on(table.tokenHash),
    index("auth_refresh_tokens_session_idx").on(table.sessionId, table.createdAt),
  ],
);

export type AuthRefreshToken = typeof authRefreshTokens.$inferSelect;
export type NewAuthRefreshToken = typeof authRefreshTokens.$inferInsert;
