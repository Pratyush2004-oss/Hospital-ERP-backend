import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { branches } from "./branches.js";
import { createdAt, updatedAt } from "./columns.js";
import { invoiceStatusEnum, invoiceTypeEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * A hospital invoice header (Phase 19).
 *
 * The row owns the money for one bill; the individual charges live in
 * `invoice_items`. Every amount is a `NUMERIC(12, 2)` column, never a float,
 * and is computed by `calculateInvoice` from the line items — a client-supplied
 * total is never accepted.
 *
 * Relationships are tenant-aware through composite foreign keys:
 * - `(tenant_id, patient_id)` -> patient_profiles(tenant_id, id)
 * - `(tenant_id, branch_id)`  -> branches(tenant_id, id)
 * - `(tenant_id, appointment_id)` -> appointments(tenant_id, id), nullable
 *   because walk-in and non-appointment billing is supported. Whether the
 *   appointment belongs to the same patient and branch is a service rule;
 *   PostgreSQL has no composite key spanning those columns.
 *
 * `invoice_number` is unique per tenant for the lifetime of the tenant and is
 * allocated from `invoice_number_sequences` inside the creation transaction,
 * so concurrent invoices cannot receive the same number. The unique index is
 * the final guarantee, not the application check.
 *
 * Status starts as DRAFT. Issuing and status/balance transitions are owned by
 * `invoice.lifecycle.service.ts`, which derives them from successful
 * `invoice_payments` / `invoice_refunds`; creation writes 0 / total here.
 * Cancellation is the deletion concept: an invoice is never hard deleted, and
 * `invoice_items` cascade only if the tenant is purged. There is deliberately
 * no `deleted_at`.
 *
 * `notes` is operational free text billing remarks, not a clinical record.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    /** NULL for walk-in or non-appointment billing. */
    appointmentId: uuid("appointment_id"),
    invoiceNumber: varchar("invoice_number", { length: 40 }).notNull(),
    invoiceType: invoiceTypeEnum("invoice_type").notNull().default("OTHER"),
    invoiceStatus: invoiceStatusEnum("invoice_status").notNull().default("DRAFT"),
    /** Date printed on the invoice (billing date), not a creation timestamp. */
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date"),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    notes: text("notes"),
    /** Sum of line gross amounts before discount and tax. */
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0.00"),
    discountTotal: numeric("discount_total", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    taxTotal: numeric("tax_total", { precision: 12, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
    /** Maintained by the payment tasks; invoice creation always writes 0. */
    amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }).notNull().default("0.00"),
    balanceDue: numeric("balance_due", { precision: 12, scale: 2 }).notNull().default("0.00"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Target of the composite key from invoice_items.
    unique("invoices_tenant_id_id_unique").on(table.tenantId, table.id),
    // Numbers stay reserved for the tenant, including cancelled invoices.
    uniqueIndex("invoices_tenant_number_unique").on(table.tenantId, table.invoiceNumber),
    // Patient billing history.
    index("invoices_patient_history_idx").on(table.tenantId, table.patientId, table.issueDate),
    // Branch billing and daily reports.
    index("invoices_branch_history_idx").on(table.tenantId, table.branchId, table.issueDate),
    // Status queues ("all drafts", "all unpaid") and date-range reports.
    index("invoices_status_idx").on(table.tenantId, table.invoiceStatus, table.issueDate),
    index("invoices_issue_date_idx").on(table.tenantId, table.issueDate, table.id),
    // Appointment billing lookup. Not unique: one visit may legitimately be
    // billed in more than one invoice (for example consultation then pharmacy).
    index("invoices_appointment_idx")
      .on(table.tenantId, table.appointmentId)
      .where(sql`${table.appointmentId} is not null`),
    check("invoices_subtotal_check", sql`${table.subtotal} >= 0`),
    check("invoices_discount_total_check", sql`${table.discountTotal} >= 0`),
    check("invoices_tax_total_check", sql`${table.taxTotal} >= 0`),
    check("invoices_total_amount_check", sql`${table.totalAmount} >= 0`),
    check("invoices_amount_paid_check", sql`${table.amountPaid} >= 0`),
    check("invoices_balance_due_check", sql`${table.balanceDue} >= 0`),
    check(
      "invoices_discount_within_subtotal_check",
      sql`${table.discountTotal} <= ${table.subtotal}`,
    ),
    check(
      "invoices_total_reconciliation_check",
      sql`${table.subtotal} - ${table.discountTotal} + ${table.taxTotal} = ${table.totalAmount}`,
    ),
    check(
      "invoices_due_date_check",
      sql`${table.dueDate} is null or ${table.dueDate} >= ${table.issueDate}`,
    ),
    foreignKey({
      name: "invoices_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "invoices_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "invoices_appointment_fk",
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }).onDelete("restrict"),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
