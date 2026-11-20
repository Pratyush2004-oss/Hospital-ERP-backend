import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { patientContactTypeEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";

/**
 * How to reach a patient: phone and/or email, grouped by purpose.
 *
 * A contact row must carry at least one reachable value (CHECK), may be marked
 * primary, and at most one contact per patient may be primary (partial unique
 * index). Verification is a separate flag so staff can see unconfirmed numbers
 * without deleting them.
 *
 * `(tenant_id, patient_id) -> patient_profiles(tenant_id, id)` keeps the row in
 * the patient's tenant; a patient id from another hospital cannot be attached.
 */
export const patientContacts = pgTable(
  "patient_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    contactType: patientContactTypeEnum("contact_type").notNull().default("MOBILE"),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 320 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    isVerified: boolean("is_verified").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("patient_contacts_patient_idx").on(table.tenantId, table.patientId),
    // One reachable value may only appear once per patient. Phone numbers are
    // normalised by the application layer before they reach the database;
    // email comparison is case-insensitive.
    uniqueIndex("patient_contacts_patient_phone_unique")
      .on(table.tenantId, table.patientId, table.phone)
      .where(sql`${table.phone} is not null`),
    uniqueIndex("patient_contacts_patient_email_unique")
      .on(table.tenantId, table.patientId, sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
    // A single primary contact row carries the patient's primary phone and/or
    // email; further rows are secondary.
    uniqueIndex("patient_contacts_primary_unique")
      .on(table.tenantId, table.patientId)
      .where(sql`${table.isPrimary}`),
    check(
      "patient_contacts_reachable_check",
      sql`${table.phone} is not null or ${table.email} is not null`,
    ),
    foreignKey({
      name: "patient_contacts_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("cascade"),
  ],
);

export type PatientContact = typeof patientContacts.$inferSelect;
export type NewPatientContact = typeof patientContacts.$inferInsert;
