import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, updatedAt } from "./columns.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Clinical profile of a doctor inside one hospital.
 *
 * A doctor is a tenant-owned profile, not a user account: the same user may be
 * a doctor at two hospitals with different registrations and specialties, so
 * the profile is unique per `(tenant_id, user_id)` rather than per user. No
 * authentication data is stored here.
 *
 * Soft-delete policy: `doctor_code` stays reserved for the lifetime of the
 * tenant, even after the profile is soft deleted, because the code appears on
 * clinical documents. `doctors_tenant_code_unique` is therefore a plain unique
 * index and not a partial index on `deleted_at IS NULL`, so a retired code can
 * never be handed to a different doctor.
 *
 * `experience_years` is nullable: an imported or newly onboarded profile can
 * exist before the hospital confirms the doctor's history. When present it must
 * be between 0 and 70 (the same range as the original NOT NULL column).
 *
 * Cross-tenant safety: `user_id` points at the global `users` table, which has
 * no tenant. The database therefore cannot prove that the user holds a
 * membership here; that check belongs to the service layer (a doctor must
 * reference a user with an ACTIVE/INVITED `tenant_memberships` row for the same
 * tenant). Every branch, department, schedule and leave reference is
 * tenant-checked at the database level through composite keys.
 */
export const doctors = pgTable(
  "doctors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Operational, human-readable identifier; unique within the hospital. */
    doctorCode: varchar("doctor_code", { length: 50 }).notNull(),
    /** Medical council registration; unique within the hospital. */
    registrationNumber: varchar("registration_number", { length: 80 }).notNull(),
    registrationCouncil: varchar("registration_council", { length: 150 }),
    qualification: varchar("qualification", { length: 200 }),
    experienceYears: smallint("experience_years"),
    biography: text("biography"),
    profileImageUrl: text("profile_image_url"),
    specialization: varchar("specialization", { length: 150 }),
    /** JSON array of language codes, e.g. ["en", "hi"]. */
    consultationLanguage: jsonb("consultation_language").$type<string[]>(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Target of composite keys in doctor_departments, doctor_branches, leaves.
    unique("doctors_tenant_id_id_unique").on(table.tenantId, table.id),
    // One profile per user per hospital.
    uniqueIndex("doctors_tenant_user_unique").on(table.tenantId, table.userId),
    uniqueIndex("doctors_tenant_code_unique").on(table.tenantId, table.doctorCode),
    uniqueIndex("doctors_tenant_registration_unique").on(
      table.tenantId,
      table.registrationNumber,
    ),
    index("doctors_tenant_active_idx").on(table.tenantId, table.isActive),
    index("doctors_user_idx").on(table.userId),
    check(
      "doctors_experience_years_check",
      sql`${table.experienceYears} >= 0 and ${table.experienceYears} <= 70`,
    ),
  ],
);

export type Doctor = typeof doctors.$inferSelect;
export type NewDoctor = typeof doctors.$inferInsert;
