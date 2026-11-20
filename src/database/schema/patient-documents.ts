import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt } from "./columns.js";
import { patientDocumentScanStatusEnum, patientDocumentTypeEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";
import { users } from "./users.js";

/**
 * Metadata for files attached to a patient: identity proofs, insurance cards,
 * referral letters.
 *
 * Storage model: the bytes live in a private object bucket and this table keeps
 * only the `storage_key` (the object path) plus descriptive fields. No public
 * URL is stored, because a patient document must never be reachable without an
 * authorization check - the API issues short-lived signed URLs after verifying
 * permission. `storage_key` is unique so two rows cannot claim one object, which
 * also makes deletes and audits unambiguous.
 *
 * `uploaded_by` is nullable and `ON DELETE SET NULL`: deleting a staff account
 * must not delete the patient's documents or orphan the row.
 *
 * Documents are soft deleted (`deleted_at`) so the metadata audit trail and the
 * reserved storage key survive removal from the patient's active file.
 */
export const patientDocuments = pgTable(
  "patient_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    documentType: patientDocumentTypeEnum("document_type").notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    /** Private object-storage path, e.g. `tenants/<id>/patients/<id>/<uuid>.pdf`. */
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 150 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Scan state from the malware-scanner integration point. No scanner is
     * configured today, so new rows stay `PENDING` and are never described as
     * clean. Replace via a trusted scanner process, not a client request.
     */
    scanStatus: patientDocumentScanStatusEnum("scan_status").notNull().default("PENDING"),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("patient_documents_storage_key_unique").on(table.storageKey),
    index("patient_documents_patient_type_idx").on(
      table.tenantId,
      table.patientId,
      table.documentType,
      table.createdAt,
    ),
    index("patient_documents_uploaded_by_idx").on(table.uploadedBy),
    check("patient_documents_file_size_check", sql`${table.fileSize} > 0`),
    foreignKey({
      name: "patient_documents_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("cascade"),
  ],
);

export type PatientDocument = typeof patientDocuments.$inferSelect;
export type NewPatientDocument = typeof patientDocuments.$inferInsert;
