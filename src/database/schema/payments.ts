import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt, updatedAt } from "./columns.js";
import { invoicePaymentStatusEnum, paymentMethodEnum } from "./enums.js";
import { patientProfiles } from "./patient-profiles.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * One offline/manual money collection (Task 19.4.1).
 *
 * This is the receipt-level record: the cash, card, UPI, bank transfer or
 * cheque a patient handed over at the front desk. How the money is split across
 * invoices lives in `payment_allocations`; the per-invoice settlement rows read
 * by the balance lifecycle are written in `invoice_payments`, all inside the
 * same transaction.
 *
 * Rules:
 * - only `SUCCESSFUL` collections settle money; manual payments are recorded as
 *   SUCCESSFUL on creation because the cashier has already taken the money;
 * - `amount` must be positive and equal to the sum of its allocations, so no
 *   part of a receipt is unaccounted for;
 * - `reference` (receipt/UTR/cheque number) is unique per tenant when supplied,
 *   and `idempotency_key` is unique per tenant, so a retried request replays the
 *   original payment instead of collecting twice;
 * - `received_by` records the staff member who took the money and is never
 *   rewritten; rows are financial history and are never hard deleted.
 *
 * Composite foreign keys keep the branch and patient inside the tenant, and the
 * `(tenant_id, id)` unique key is the target of `payment_allocations`.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    paymentStatus: invoicePaymentStatusEnum("payment_status").notNull().default("SUCCESSFUL"),
    /** Receipt number, UPI/bank reference or cheque number; never a secret. */
    reference: varchar("reference", { length: 120 }),
    notes: text("notes"),
    /** Staff member who received the money. Set once, never rewritten. */
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Client retry key; NULL when the caller did not send one. */
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    /** SHA-256 of the canonical request, used to replay or reject a retry. */
    requestHash: varchar("request_hash", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Target of the composite key from payment_allocations.
    unique("payments_tenant_id_id_unique").on(table.tenantId, table.id),
    // A retried request can never create a second collection.
    uniqueIndex("payments_tenant_idempotency_key_unique")
      .on(table.tenantId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    // A receipt/UTR/cheque number identifies exactly one collection per tenant.
    uniqueIndex("payments_tenant_reference_unique")
      .on(table.tenantId, table.reference)
      .where(sql`${table.reference} is not null`),
    // Patient, branch and cash-desk history.
    index("payments_patient_history_idx").on(
      table.tenantId,
      table.patientId,
      table.receivedAt,
    ),
    index("payments_branch_history_idx").on(
      table.tenantId,
      table.branchId,
      table.receivedAt,
    ),
    index("payments_status_idx").on(table.tenantId, table.paymentStatus, table.receivedAt),
    // Tenant-wide date-range reporting (status distributions and collected
    // totals without a branch/status prefix).
    index("payments_tenant_received_at_idx").on(table.tenantId, table.receivedAt),
    check("payments_amount_check", sql`${table.amount} > 0`),
    check("payments_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    foreignKey({
      name: "payments_patient_fk",
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patientProfiles.tenantId, patientProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "payments_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
