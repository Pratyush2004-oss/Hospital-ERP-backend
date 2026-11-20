import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";

/**
 * Global user account. A user is not owned by a tenant: the same account can
 * belong to several hospitals through `tenant_memberships`.
 *
 * Identity policy: email and phone are global, case-insensitive identities.
 * - email is unique on lower(email) because it is the sign-in identifier
 * - phone is unique when present (partial index), since it is nullable
 * Tenant-scoped identifiers (staff numbers, etc.) belong to memberships.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("users_phone_unique")
      .on(table.phone)
      .where(sql`${table.phone} is not null`),
    index("users_created_at_idx").on(table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
