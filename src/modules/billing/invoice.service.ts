import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  appointments,
  branches,
  invoiceItems,
  invoiceNumberSequences,
  invoices,
  patientProfiles,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { calculateInvoice } from "./invoice-calculation.js";
import type { InvoiceLineInput } from "./invoice-calculation.types.js";
import type {
  CreateInvoiceInput,
  CreateInvoiceLineInput,
  InvoiceDiscountType,
  InvoiceDto,
  InvoiceItemDto,
  InvoiceItemType,
  InvoiceListResult,
  InvoiceStatus,
  InvoiceSummaryDto,
  InvoiceType,
  ListInvoicesFilters,
} from "./invoice.types.js";

/**
 * Invoice generation and management service (Task 19.2.2).
 *
 * Business rules:
 * - An invoice is always owned by one tenant. The patient, branch, appointment
 *   and creator must all exist inside that tenant; composite foreign keys make
 *   a cross-tenant link impossible even if a service check is bypassed.
 * - Line items are persisted with the calculator's output. The service never
 *   trusts client totals: `calculateInvoice` (Task 19.2.1) produces subtotal,
 *   discounts, tax and the final amount with decimal-safe arithmetic.
 * - New invoices are DRAFT. Issuing and payment/refund-driven status changes
 *   live in `invoice.lifecycle.service.ts`; recording money and PDF rendering
 *   are separate tasks.
 * - `invoice_number` is unique per tenant. Unless the caller supplies its own
 *   number, it is allocated from `invoice_number_sequences` inside the same
 *   transaction, which row-locks the counter; the unique index is the final
 *   guard.
 * - Header and lines are written in one transaction. A failure anywhere rolls
 *   back the whole invoice, including the number allocation.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_CURRENCY = "USD";
const DEFAULT_INVOICE_TYPE: InvoiceType = "OTHER";
const DEFAULT_ITEM_TYPE: InvoiceItemType = "OTHER";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const INVOICE_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NOTES_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NUMBER_ATTEMPTS = 25;

const INVOICE_STATUSES: ReadonlySet<string> = new Set<InvoiceStatus>([
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REFUNDED",
]);
const INVOICE_TYPES: ReadonlySet<string> = new Set<InvoiceType>([
  "CONSULTATION",
  "PHARMACY",
  "LABORATORY",
  "PROCEDURE",
  "ADMISSION",
  "OTHER",
]);
const ITEM_TYPES: ReadonlySet<string> = new Set<InvoiceItemType>([
  "CONSULTATION",
  "REGISTRATION",
  "PROCEDURE",
  "LABORATORY",
  "PHARMACY",
  "ROOM_CHARGE",
  "OTHER",
]);
const DISCOUNT_TYPES: ReadonlySet<string> = new Set<InvoiceDiscountType>([
  "AMOUNT",
  "PERCENTAGE",
]);

interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** Drizzle wraps driver errors, so walk the `cause` chain for SQLSTATE data. */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  const info: { code?: string; constraint?: string } = {};
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (info.code === undefined && typeof candidate.code === "string") {
      info.code = candidate.code;
    }
    if (info.constraint === undefined && typeof candidate.constraint === "string") {
      info.constraint = candidate.constraint;
    }

    current = candidate.cause;
  }

  return info;
}

/**
 * Translates database constraint violations into safe application errors.
 * Shared with the invoice lifecycle service so both write paths fail alike.
 */
export function mapInvoiceWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23505") {
    if (constraint === "invoices_tenant_number_unique") {
      throw AppError.conflict("An invoice with this number already exists in this hospital");
    }

    throw AppError.conflict("An invoice with these details already exists in this hospital");
  }

  if (code === "23514") {
    throw AppError.validation("Invoice data violates a database constraint");
  }

  if (code === "23503") {
    throw AppError.badRequest(
      "A referenced patient, branch, appointment or user does not belong to this hospital",
    );
  }

  if (code === "22P02") {
    throw AppError.badRequest("One or more identifiers are not valid UUIDs");
  }

  throw error;
}

function invalid(field: string, message: string): AppError {
  return AppError.validation(message, { field });
}

function normalizeCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined) return DEFAULT_CURRENCY;

  const currency = value.trim().toUpperCase();

  if (!CURRENCY_PATTERN.test(currency)) {
    throw invalid("currency", "Currency must be a three-letter ISO 4217 code");
  }

  return currency;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Accepts only a real `YYYY-MM-DD` calendar date, not a rolled-over one. */
function normalizeDate(value: string, field: string): string {
  const text = value.trim();
  const match = DATE_PATTERN.exec(text);

  if (!match) {
    throw invalid(field, `${field} must be a date in YYYY-MM-DD format`);
  }

  const parsed = new Date(`${text}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(field, `${field} must be a valid calendar date`);
  }

  return text;
}

function normalizeInvoiceNumber(value: string): string {
  const invoiceNumber = value.trim().toUpperCase();

  if (!INVOICE_NUMBER_PATTERN.test(invoiceNumber)) {
    throw invalid(
      "invoiceNumber",
      "Invoice number must be 1-40 characters using letters, digits, dots, slashes, hyphens or underscores",
    );
  }

  return invoiceNumber;
}

function normalizeNotes(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const notes = value.trim();

  if (notes.length === 0) return null;

  if (notes.length > MAX_NOTES_LENGTH) {
    throw invalid("notes", `Notes must be at most ${MAX_NOTES_LENGTH} characters`);
  }

  return notes;
}

function normalizeDescription(value: string): string {
  const description = value.trim();

  if (description.length === 0) {
    throw invalid("description", "Item description is required");
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw invalid(
      "description",
      `Item description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  return description;
}

function normalizeInvoiceType(value: InvoiceType | undefined): InvoiceType {
  if (value === undefined) return DEFAULT_INVOICE_TYPE;

  if (!INVOICE_TYPES.has(value)) {
    throw invalid("invoiceType", "Unknown invoice type");
  }

  return value;
}

function normalizeItemType(value: InvoiceItemType | undefined): InvoiceItemType {
  if (value === undefined) return DEFAULT_ITEM_TYPE;

  if (!ITEM_TYPES.has(value)) {
    throw invalid("itemType", "Unknown invoice item type");
  }

  return value;
}

/** The stored value keeps the caller's scale; the calculator validates it. */
function normalizeDiscountValue(value: CreateInvoiceLineInput["discountValue"]): string | null {
  if (value === null || value === undefined) return null;

  return typeof value === "number" ? String(value) : value.trim();
}

interface NormalizedLine {
  readonly itemType: InvoiceItemType;
  readonly description: string;
  readonly discountType: InvoiceDiscountType | null;
  readonly discountValue: string | null;
  readonly calculation: InvoiceLineInput;
}

/**
 * Validates one input line and converts it to the calculator contract. The
 * numeric ranges (negative values, excess precision, discount limits, tax
 * rates) are enforced by `calculateInvoice`, so they are not duplicated here.
 */
function normalizeLine(input: CreateInvoiceLineInput): NormalizedLine {
  if (input === null || typeof input !== "object") {
    throw invalid("items", "Each invoice item must be an object");
  }

  const discountType = input.discountType ?? null;

  if (discountType !== null && !DISCOUNT_TYPES.has(discountType)) {
    throw invalid("discountType", "Discount type must be AMOUNT or PERCENTAGE");
  }

  const discountValue = normalizeDiscountValue(input.discountValue);

  if (discountType === null && discountValue !== null) {
    throw invalid("discountType", "A discount value requires a discount type");
  }

  if (discountType !== null && discountValue === null) {
    throw invalid("discountValue", "A discount type requires a discount value");
  }

  const description = normalizeDescription(input.description);

  return {
    itemType: normalizeItemType(input.itemType),
    description,
    discountType,
    discountValue,
    calculation: {
      description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discount:
        discountType === null || discountValue === null
          ? null
          : { type: discountType, value: discountValue },
      taxRate: input.taxRate ?? null,
    },
  };
}

/** Patient must belong to the tenant and not be soft deleted. */
export async function assertPatientInTenant(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
): Promise<void> {
  const [patient] = await tx
    .select({ id: patientProfiles.id, deletedAt: patientProfiles.deletedAt })
    .from(patientProfiles)
    .where(and(eq(patientProfiles.id, patientId), eq(patientProfiles.tenantId, tenantId)))
    .limit(1);

  if (!patient) {
    throw AppError.badRequest("Patient does not belong to this hospital");
  }

  if (patient.deletedAt !== null) {
    throw AppError.badRequest("Patient record is not active");
  }
}

/** Branch must belong to the tenant, be active and not be soft deleted. */
export async function assertBranchInTenant(
  tx: DbExecutor,
  tenantId: string,
  branchId: string,
): Promise<void> {
  const [branch] = await tx
    .select({ id: branches.id, isActive: branches.isActive, deletedAt: branches.deletedAt })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId)))
    .limit(1);

  if (!branch) {
    throw AppError.badRequest("Branch does not belong to this hospital");
  }

  if (branch.deletedAt !== null || !branch.isActive) {
    throw AppError.badRequest("Branch is not active");
  }
}

/**
 * An invoice may only reference an appointment that belongs to the same tenant,
 * the same patient and the same branch. The database proves the tenant link;
 * this check proves the patient and branch link, which PostgreSQL cannot
 * express across those columns.
 */
async function assertAppointmentMatches(
  tx: DbExecutor,
  tenantId: string,
  appointmentId: string,
  patientId: string,
  branchId: string,
): Promise<void> {
  const [appointment] = await tx
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      branchId: appointments.branchId,
    })
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId)))
    .limit(1);

  if (!appointment) {
    throw AppError.badRequest("Appointment does not belong to this hospital");
  }

  if (appointment.patientId !== patientId) {
    throw AppError.badRequest("Appointment belongs to a different patient");
  }

  if (appointment.branchId !== branchId) {
    throw AppError.badRequest("Appointment belongs to a different branch");
  }
}

async function assertInvoiceNumberAvailable(
  tx: DbExecutor,
  tenantId: string,
  invoiceNumber: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(eq(invoices.tenantId, tenantId), eq(invoices.invoiceNumber, invoiceNumber)),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict("An invoice with this number already exists in this hospital");
  }
}

/**
 * Allocates `INV-000001` style numbers from the per-tenant counter.
 *
 * The upsert locks the counter row for the rest of the transaction, so parallel
 * creations cannot read the same value. Numbers already taken (for example a
 * manually entered `INV-000007`) are skipped by probing `invoices`; the unique
 * index remains the final guarantee.
 */
async function allocateInvoiceNumber(tx: DbExecutor, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
    const [row] = await tx
      .insert(invoiceNumberSequences)
      .values({ tenantId, lastValue: 1 })
      .onConflictDoUpdate({
        target: invoiceNumberSequences.tenantId,
        set: {
          lastValue: sql`${invoiceNumberSequences.lastValue} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ lastValue: invoiceNumberSequences.lastValue });

    const sequence = row?.lastValue;

    if (sequence === undefined) {
      throw AppError.internal("Failed to allocate an invoice number");
    }

    const candidate = `INV-${String(sequence).padStart(6, "0")}`;

    const [existing] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenantId), eq(invoices.invoiceNumber, candidate)),
      )
      .limit(1);

    if (!existing) return candidate;
  }

  throw AppError.conflict("Could not allocate a unique invoice number; please try again");
}

const invoiceSelection = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  invoiceStatus: invoices.invoiceStatus,
  invoiceType: invoices.invoiceType,
  branchId: invoices.branchId,
  patientId: invoices.patientId,
  appointmentId: invoices.appointmentId,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  currency: invoices.currency,
  notes: invoices.notes,
  subtotal: invoices.subtotal,
  discountTotal: invoices.discountTotal,
  taxTotal: invoices.taxTotal,
  totalAmount: invoices.totalAmount,
  amountPaid: invoices.amountPaid,
  balanceDue: invoices.balanceDue,
  createdBy: invoices.createdBy,
  createdAt: invoices.createdAt,
  updatedAt: invoices.updatedAt,
};

const invoiceItemSelection = {
  id: invoiceItems.id,
  itemType: invoiceItems.itemType,
  description: invoiceItems.description,
  quantity: invoiceItems.quantity,
  unitPrice: invoiceItems.unitPrice,
  discountType: invoiceItems.discountType,
  discountValue: invoiceItems.discountValue,
  grossAmount: invoiceItems.grossAmount,
  discountAmount: invoiceItems.discountAmount,
  taxRate: invoiceItems.taxRate,
  taxAmount: invoiceItems.taxAmount,
  lineTotal: invoiceItems.lineTotal,
  sortOrder: invoiceItems.sortOrder,
};

type InvoiceHeaderRow = Awaited<ReturnType<typeof selectInvoiceHeaders>>[number];
type InvoiceItemRow = Awaited<ReturnType<typeof selectInvoiceItemRows>>[number];

function selectInvoiceHeaders(tx: DbExecutor, tenantId: string, invoiceId: string) {
  return tx
    .select(invoiceSelection)
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1);
}

function selectInvoiceItemRows(tx: DbExecutor, tenantId: string, invoiceId: string) {
  return tx
    .select(invoiceItemSelection)
    .from(invoiceItems)
    .where(
      and(eq(invoiceItems.tenantId, tenantId), eq(invoiceItems.invoiceId, invoiceId)),
    )
    .orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id));
}

function toInvoiceItemDto(row: InvoiceItemRow): InvoiceItemDto {
  return {
    id: row.id,
    itemType: row.itemType,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    discountType: row.discountType,
    discountValue: row.discountValue,
    grossAmount: row.grossAmount,
    discountAmount: row.discountAmount,
    taxRate: row.taxRate,
    taxAmount: row.taxAmount,
    lineTotal: row.lineTotal,
    sortOrder: row.sortOrder,
  };
}

function toInvoiceDto(row: InvoiceHeaderRow, items: readonly InvoiceItemRow[]): InvoiceDto {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    invoiceStatus: row.invoiceStatus,
    invoiceType: row.invoiceType,
    branchId: row.branchId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    notes: row.notes,
    subtotal: row.subtotal,
    discountTotal: row.discountTotal,
    taxTotal: row.taxTotal,
    totalAmount: row.totalAmount,
    amountPaid: row.amountPaid,
    balanceDue: row.balanceDue,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: items.map(toInvoiceItemDto),
  };
}

function toInvoiceSummaryDto(row: InvoiceHeaderRow): InvoiceSummaryDto {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    invoiceStatus: row.invoiceStatus,
    invoiceType: row.invoiceType,
    branchId: row.branchId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    subtotal: row.subtotal,
    discountTotal: row.discountTotal,
    taxTotal: row.taxTotal,
    totalAmount: row.totalAmount,
    amountPaid: row.amountPaid,
    balanceDue: row.balanceDue,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Loads one tenant-scoped invoice DTO inside an existing transaction. */
export async function loadInvoice(
  tx: DbExecutor,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  const [row] = await selectInvoiceHeaders(tx, tenantId, invoiceId);

  if (!row) throw AppError.notFound("Invoice not found");

  const items = await selectInvoiceItemRows(tx, tenantId, invoiceId);

  return toInvoiceDto(row, items);
}

/**
 * Creates an invoice and its line items atomically.
 *
 * All totals are derived on the server. The appointment is optional, but when
 * present it must match the patient and branch. The returned DTO contains the
 * persisted values, not the in-memory calculation.
 */
export async function createInvoice(
  tenantId: string,
  input: CreateInvoiceInput,
): Promise<InvoiceDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      if (input === null || typeof input !== "object") {
        throw AppError.validation("Invoice input is required");
      }

      if (!Array.isArray(input.items) || input.items.length === 0) {
        throw invalid("items", "An invoice must contain at least one line item");
      }

      await assertPatientInTenant(tx, tenantId, input.patientId);
      await assertBranchInTenant(tx, tenantId, input.branchId);

      if (input.appointmentId !== null && input.appointmentId !== undefined) {
        await assertAppointmentMatches(
          tx,
          tenantId,
          input.appointmentId,
          input.patientId,
          input.branchId,
        );
      }

      const lines = input.items.map(normalizeLine);
      const currency = normalizeCurrency(input.currency);
      const issueDate =
        input.issueDate === null || input.issueDate === undefined
          ? todayUtc()
          : normalizeDate(input.issueDate, "issueDate");
      const dueDate =
        input.dueDate === null || input.dueDate === undefined
          ? null
          : normalizeDate(input.dueDate, "dueDate");

      if (dueDate !== null && dueDate < issueDate) {
        throw invalid("dueDate", "Due date cannot be before the issue date");
      }

      // Server-side money: the calculator validates quantities, prices,
      // discounts and tax rates and returns the only totals we persist.
      const calculation = calculateInvoice({
        currency,
        lines: lines.map((line) => line.calculation),
      });

      const invoiceNumber =
        input.invoiceNumber === null || input.invoiceNumber === undefined
          ? await allocateInvoiceNumber(tx, tenantId)
          : normalizeInvoiceNumber(input.invoiceNumber);

      if (input.invoiceNumber !== null && input.invoiceNumber !== undefined) {
        await assertInvoiceNumberAvailable(tx, tenantId, invoiceNumber);
      }

      const [created] = await tx
        .insert(invoices)
        .values({
          tenantId,
          branchId: input.branchId,
          patientId: input.patientId,
          appointmentId: input.appointmentId ?? null,
          invoiceNumber,
          invoiceType: normalizeInvoiceType(input.invoiceType),
          // New invoices always start as DRAFT; status is never client input.
          invoiceStatus: "DRAFT",
          issueDate,
          dueDate,
          currency: calculation.currency,
          notes: normalizeNotes(input.notes),
          subtotal: calculation.subtotal,
          discountTotal: calculation.totalDiscount,
          taxTotal: calculation.totalTax,
          totalAmount: calculation.totalAmount,
          amountPaid: calculation.amountPaid,
          balanceDue: calculation.balanceDue,
          createdBy: input.createdBy,
        })
        .returning({ id: invoices.id });

      if (!created) throw AppError.internal("Failed to create invoice");

      await tx.insert(invoiceItems).values(
        calculation.lines.map((line, index) => {
          const source = lines[index];

          if (!source) throw AppError.internal("Invoice line mismatch");

          return {
            tenantId,
            invoiceId: created.id,
            itemType: source.itemType,
            description: source.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: source.discountType,
            discountValue: source.discountValue,
            grossAmount: line.grossAmount,
            discountAmount: line.discountAmount,
            taxRate: line.taxRate,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
            sortOrder: index,
          };
        }),
      );

      return await loadInvoice(tx, tenantId, created.id);
    });
  } catch (error) {
    mapInvoiceWriteError(error);
  }
}

/** Full invoice with line items, tenant-scoped. */
export async function getInvoiceById(
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  return withTenantTransaction(tenantId, (tx) => loadInvoice(tx, tenantId, invoiceId));
}

/** Looks an invoice up by its tenant-unique number (case-insensitive input). */
export async function getInvoiceByNumber(
  tenantId: string,
  invoiceNumber: string,
): Promise<InvoiceDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const number = invoiceNumber.trim().toUpperCase();

    if (number.length === 0) throw AppError.notFound("Invoice not found");

    const [row] = await tx
      .select(invoiceSelection)
      .from(invoices)
      .where(and(eq(invoices.invoiceNumber, number), eq(invoices.tenantId, tenantId)))
      .limit(1);

    if (!row) throw AppError.notFound("Invoice not found");

    const items = await selectInvoiceItemRows(tx, tenantId, row.id);

    return toInvoiceDto(row, items);
  });
}

/**
 * Lists invoice summaries for a tenant with pagination and filters.
 *
 * Ordered by issue date (newest first), then creation time, then id so the
 * pagination window is stable. Line items are intentionally not loaded.
 */
export async function listInvoices(
  tenantId: string,
  filters: ListInvoicesFilters = {},
): Promise<InvoiceListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  if (filters.status !== undefined && !INVOICE_STATUSES.has(filters.status)) {
    throw invalid("status", "Unknown invoice status");
  }

  if (filters.invoiceType !== undefined && !INVOICE_TYPES.has(filters.invoiceType)) {
    throw invalid("invoiceType", "Unknown invoice type");
  }

  const fromDate =
    filters.fromDate === undefined ? undefined : normalizeDate(filters.fromDate, "fromDate");
  const toDate =
    filters.toDate === undefined ? undefined : normalizeDate(filters.toDate, "toDate");

  if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
    throw invalid("fromDate", "fromDate cannot be after toDate");
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(invoices.tenantId, tenantId)];

    if (filters.patientId !== undefined) {
      conditions.push(eq(invoices.patientId, filters.patientId));
    }
    if (filters.branchId !== undefined) {
      conditions.push(eq(invoices.branchId, filters.branchId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(invoices.invoiceStatus, filters.status));
    }
    if (filters.invoiceType !== undefined) {
      conditions.push(eq(invoices.invoiceType, filters.invoiceType));
    }
    if (fromDate !== undefined) {
      conditions.push(gte(invoices.issueDate, fromDate));
    }
    if (toDate !== undefined) {
      conditions.push(lte(invoices.issueDate, toDate));
    }

    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      tx
        .select(invoiceSelection)
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.issueDate), desc(invoices.createdAt), asc(invoices.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .where(where),
    ]);

    const total = totals[0]?.total ?? 0;

    return {
      invoices: rows.map(toInvoiceSummaryDto),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}
