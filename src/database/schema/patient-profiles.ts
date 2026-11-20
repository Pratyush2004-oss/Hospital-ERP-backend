import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, updatedAt } from "./columns.js";
import {
  bloodGroupEnum,
  patientGenderEnum,
  patientMaritalStatusEnum,
  patientStatusEnum,
} from "./enums.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Demographic identity of a patient inside one hospital.
 *
 * Two independent identities meet here:
 * - `patient_code` is the hospital's own identifier (MRN). It is unique per
 *   tenant only, so two hospitals can independently allocate "000123".
 * - `user_id` links the record to a global login account and is optional,
 *   because most patients are registered at a desk without ever signing up.
 *   `ON DELETE SET NULL` keeps the clinical record when an account is deleted;
 *   the patient does not disappear with their login.
 *
 * The same person receiving care at two hospitals has two unrelated rows, one
 * per tenant. There is intentionally no global patient identity table: sharing
 * one would leak the existence of a patient across hospitals.
 *
 * Soft-delete and reuse rules: `(tenant_id, patient_code)` is a plain unique
 * index, not a partial one, so a soft-deleted patient never releases its MRN.
 * Reusing an MRN would make historical documents, invoices and audit records
 * ambiguous, so a new patient always receives a new code. The same applies to
 * `(tenant_id, user_id)`: an archived profile still reserves its linked account
 * for that hospital until the row is physically removed.
 */
export const patientProfiles = pgTable(
  "patient_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    patientCode: varchar("patient_code", { length: 40 }).notNull(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    /** Nullable: unknown birth dates are normal at emergency intake. */
    dateOfBirth: date("date_of_birth"),
    gender: patientGenderEnum("gender").notNull().default("UNKNOWN"),
    bloodGroup: bloodGroupEnum("blood_group"),
    /** Optional; NULL means the patient chose not to record it. */
    maritalStatus: patientMaritalStatusEnum("marital_status"),
    /**
     * Private object-storage key for the profile photo. Never a public URL;
     * the API issues short-lived signed URLs after an authorization check.
     */
    profileImageKey: varchar("profile_image_key", { length: 512 }),
    status: patientStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Target of the composite keys used by every patient_* child table.
    unique("patient_profiles_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("patient_profiles_tenant_code_unique").on(table.tenantId, table.patientCode),
    // A login account maps to at most one patient per hospital.
    uniqueIndex("patient_profiles_tenant_user_unique")
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} is not null`),
    index("patient_profiles_tenant_status_idx").on(table.tenantId, table.status),
    index("patient_profiles_tenant_name_idx").on(table.tenantId, table.fullName),
    check(
      "patient_profiles_birth_date_check",
      sql`${table.dateOfBirth} is null or ${table.dateOfBirth} <= current_date`,
    ),
  ],
);

export type PatientProfile = typeof patientProfiles.$inferSelect;
export type NewPatientProfile = typeof patientProfiles.$inferInsert;
