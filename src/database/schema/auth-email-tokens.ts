import { index, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { tenantMemberships } from "./tenant-memberships.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Purpose of a single-use auth email token. Both purposes share one table so
 * the creation, hashing, expiry and consumption rules live in one place.
 */
export const authEmailTokenPurposeEnum = pgEnum("auth_email_token_purpose", [
  "EMAIL_VERIFICATION",
  "STAFF_INVITATION",
]);

/**
 * Hashed, expiring, single-use tokens delivered by email.
 *
 * Only the SHA-256 hash of a token is stored; the raw value exists solely in
 * the emailed link. A token can be consumed once (`used_at`) and may be revoked
 * when it is superseded by a newer request (`revoked_at`).
 *
 * Invitations may target an email without an account yet, so `user_id` is
 * nullable. `tenant_id`, `role_ids` and `invited_by_user_id` are only set for
 * staff invitations.
 */
export const authEmailTokens = pgTable(
  "auth_email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: authEmailTokenPurposeEnum("purpose").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    /** Optional display name supplied by the inviter. */
    fullName: varchar("full_name", { length: 200 }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** INVITED membership created for an existing account, when available. */
    membershipId: uuid("membership_id").references(() => tenantMemberships.id, {
      onDelete: "cascade",
    }),
    roleIds: jsonb("role_ids").$type<string[]>().notNull().default([]),
    departmentIds: jsonb("department_ids").$type<string[]>().notNull().default([]),
    branchIds: jsonb("branch_ids").$type<string[]>().notNull().default([]),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_email_tokens_hash_unique").on(table.tokenHash),
    index("auth_email_tokens_user_purpose_idx").on(table.userId, table.purpose, table.createdAt),
    index("auth_email_tokens_email_purpose_idx").on(table.email, table.purpose, table.createdAt),
    index("auth_email_tokens_tenant_idx").on(table.tenantId, table.purpose, table.createdAt),
    index("auth_email_tokens_membership_idx").on(table.membershipId),
  ],
);

export type AuthEmailToken = typeof authEmailTokens.$inferSelect;
export type NewAuthEmailToken = typeof authEmailTokens.$inferInsert;
