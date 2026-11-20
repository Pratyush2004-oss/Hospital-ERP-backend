import { foreignKey, index, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { patientProfiles } from "./patient-profiles.js";

/**
 * Person to call in an emergency. Deliberately free text and tenant-scoped: an
 * emergency contact is often not a patient and has no account here.
 *
 * A patient may list several contacts, so no uniqueness beyond the composite
 * patient key.
 */
export const patientEmergencyContacts = pgTable(
  "patient_emergency_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    relationship: varchar("relationship", { length: 60 }).notNull(),
    phone: varchar("phone", { length: 32 }).notNull(),
    /** Optional; format validation happens in the write API. */
    email: varchar("email", { length: 320 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("patient_emergency_contacts_patient_idx").on(table.tenantId, table.patientId),
    foreignKey({
      name: "patient_emergency_contacts_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("cascade"),
  ],
);

export type PatientEmergencyContact = typeof patientEmergencyContacts.$inferSelect;
export type NewPatientEmergencyContact = typeof patientEmergencyContacts.$inferInsert;
