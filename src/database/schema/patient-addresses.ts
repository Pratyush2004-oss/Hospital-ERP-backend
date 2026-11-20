import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { patientAddressTypeEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";

/**
 * Postal addresses of a patient (home, work, next of kin's place). Several rows
 * per patient are allowed - a patient may move or keep a billing address apart
 * from a residential one - so there is no uniqueness beyond the id.
 *
 * `country` is an ISO 3166-1 alpha-2 code, matching `branches.country`, so
 * addresses and branches cannot disagree about country format.
 *
 * A patient has at most one primary address per category (HOME/WORK/OTHER),
 * enforced by a partial unique index. `city` and `country` stay nullable for
 * legacy/partial addresses; the write API validates them when creating one.
 */
export const patientAddresses = pgTable(
  "patient_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    addressType: patientAddressTypeEnum("address_type").notNull().default("HOME"),
    addressLine1: varchar("address_line_1", { length: 255 }).notNull(),
    addressLine2: varchar("address_line_2", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 2 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("patient_addresses_patient_idx").on(table.tenantId, table.patientId),
    index("patient_addresses_patient_type_idx").on(
      table.tenantId,
      table.patientId,
      table.addressType,
    ),
    // At most one primary address per patient and address category.
    uniqueIndex("patient_addresses_primary_unique")
      .on(table.tenantId, table.patientId, table.addressType)
      .where(sql`${table.isPrimary}`),
    foreignKey({
      name: "patient_addresses_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("cascade"),
  ],
);

export type PatientAddress = typeof patientAddresses.$inferSelect;
export type NewPatientAddress = typeof patientAddresses.$inferInsert;
