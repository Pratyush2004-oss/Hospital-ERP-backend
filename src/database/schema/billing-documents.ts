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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt } from "./columns.js";
import { billingDocumentTypeEnum } from "./enums.js";
import { invoiceRefunds } from "./invoice-refunds.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Metadata for generated billing PDFs (Phase 19.8.1).
 *
 * The bytes live in the private storage abstraction; this table keeps only the
 * opaque `storage_key`, the document kind, the financial record it renders and
 * a link to the document it was regenerated from. No public URL is stored.
 *
 * Rules:
 * - one row per generated artifact, never overwritten: regenerating a document
 *   inserts a new row/object and sets `regenerated_from_id`, so the original
 *   version and its financial snapshot remain auditable;
 * - each type points at exactly one persisted record (`invoice_id`,
 *   `payment_id` for a receipt, `refund_id` for a credit note) through
 *   tenant-composite foreign keys, so a document can never reference another
 *   hospital's money;
 * - `document_number` is the printed number (invoice number, receipt
 *   reference/derived number, credit-note reference) and is unique per
 *   tenant + type + source record, so duplicate artifacts are visible;
 * - `storage_key` is unique, which makes key collisions and accidental
 *   overwrites impossible;
 * - `generated_by` is nullable and `ON DELETE SET NULL`: staff turnover must
 *   not delete financial documents.
 *
 * Generated documents are financial evidence and are never hard deleted while
 * the hospital exists; a tenant purge cascades them with the invoice.
 */
export const billingDocuments = pgTable(
  "billing_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    documentType: billingDocumentTypeEnum("document_type").notNull(),
    documentNumber: varchar("document_number", { length: 60 }).notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    /** Set for PAYMENT_RECEIPT documents. */
    paymentId: uuid("payment_id"),
    /** Set for CREDIT_NOTE documents. */
    refundId: uuid("refund_id"),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    /** Private object-storage path, e.g. `tenants/<id>/billing/<uuid>.pdf`. */
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 150 }).notNull().default("application/pdf"),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    generatedBy: uuid("generated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The earlier artifact this version supersedes; NULL on first generation. */
    regeneratedFromId: uuid("regenerated_from_id").references(
      (): AnyPgColumn => billingDocuments.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("billing_documents_storage_key_unique").on(table.storageKey),
    // Lookup of the versions of one printed number; regeneration shares the
    // number and links the versions through `regenerated_from_id`.
    index("billing_documents_tenant_number_idx").on(
      table.tenantId,
      table.documentType,
      table.documentNumber,
    ),
    index("billing_documents_invoice_idx").on(
      table.tenantId,
      table.invoiceId,
      table.documentType,
      table.createdAt,
    ),
    index("billing_documents_payment_idx")
      .on(table.tenantId, table.paymentId)
      .where(sql`${table.paymentId} is not null`),
    index("billing_documents_refund_idx")
      .on(table.tenantId, table.refundId)
      .where(sql`${table.refundId} is not null`),
    check("billing_documents_file_size_check", sql`${table.fileSize} > 0`),
    check(
      "billing_documents_source_check",
      sql`(${table.documentType} = 'INVOICE' and ${table.paymentId} is null and ${table.refundId} is null)
        or (${table.documentType} = 'PAYMENT_RECEIPT' and ${table.paymentId} is not null and ${table.refundId} is null)
        or (${table.documentType} = 'CREDIT_NOTE' and ${table.refundId} is not null)`,
    ),
    foreignKey({
      name: "billing_documents_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "billing_documents_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
    // NO ACTION (end of statement) so a tenant purge that removes payments and
    // invoices together still succeeds, while an orphaned document cannot.
    foreignKey({
      name: "billing_documents_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }).onDelete("no action"),
    foreignKey({
      name: "billing_documents_refund_fk",
      columns: [table.tenantId, table.refundId],
      foreignColumns: [invoiceRefunds.tenantId, invoiceRefunds.id],
    }).onDelete("no action"),
    // `id` is globally unique, so a single-column self reference is enough and
    // lets a deleted predecessor leave the newer version intact.
    index("billing_documents_regenerated_from_idx")
      .on(table.regeneratedFromId)
      .where(sql`${table.regeneratedFromId} is not null`),
  ],
);

export type BillingDocument = typeof billingDocuments.$inferSelect;
export type NewBillingDocument = typeof billingDocuments.$inferInsert;
