import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { invoiceDiscountTypeEnum, invoiceItemTypeEnum } from "./enums.js";
import { invoices } from "./invoices.js";

/**
 * One billable line of an invoice (Phase 19).
 *
 * The stored amounts are the calculator's output, not client input: the invoice
 * service runs `calculateInvoice` over every line inside the same transaction
 * and writes `gross_amount`, `discount_amount`, `tax_amount` and `line_total`.
 * Keeping the computed values alongside quantity, unit price, discount and tax
 * rate makes the invoice reproducible without re-deriving the rounding rules
 * when the rate tables change later.
 *
 * `discount_value` is a percentage when `discount_type` is PERCENTAGE and a
 * currency amount when it is AMOUNT; `NUMERIC(12, 4)` holds both shapes.
 * `tax_rate` is a percentage with at most four decimals (7.5 = 7.5%).
 *
 * `(tenant_id, invoice_id)` is a composite foreign key to the invoice, so a
 * line can never belong to another hospital's invoice; the pair cascades only
 * when the whole tenant is purged, because invoices are never hard deleted.
 */
export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    itemType: invoiceItemTypeEnum("item_type").notNull().default("OTHER"),
    description: varchar("description", { length: 500 }).notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    discountType: invoiceDiscountTypeEnum("discount_type"),
    discountValue: numeric("discount_value", { precision: 12, scale: 4 }),
    /** Quantity x unit price, before discount and tax. */
    grossAmount: numeric("gross_amount", { precision: 12, scale: 2 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    /** Percentage applied to the discounted amount. */
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull().default("0.0000"),
    taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    /** Display order on the printed invoice; ties fall back to id. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("invoice_items_invoice_idx").on(table.tenantId, table.invoiceId, table.sortOrder),
    check("invoice_items_quantity_check", sql`${table.quantity} >= 0`),
    check("invoice_items_unit_price_check", sql`${table.unitPrice} >= 0`),
    check("invoice_items_gross_amount_check", sql`${table.grossAmount} >= 0`),
    check("invoice_items_discount_amount_check", sql`${table.discountAmount} >= 0`),
    check(
      "invoice_items_discount_within_gross_check",
      sql`${table.discountAmount} <= ${table.grossAmount}`,
    ),
    check(
      "invoice_items_discount_value_check",
      sql`${table.discountValue} is null or ${table.discountValue} >= 0`,
    ),
    check(
      "invoice_items_tax_rate_check",
      sql`${table.taxRate} >= 0 and ${table.taxRate} <= 100`,
    ),
    check("invoice_items_tax_amount_check", sql`${table.taxAmount} >= 0`),
    check("invoice_items_line_total_check", sql`${table.lineTotal} >= 0`),
    check(
      "invoice_items_total_reconciliation_check",
      sql`${table.grossAmount} - ${table.discountAmount} + ${table.taxAmount} = ${table.lineTotal}`,
    ),
    foreignKey({
      name: "invoice_items_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
  ],
);

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
