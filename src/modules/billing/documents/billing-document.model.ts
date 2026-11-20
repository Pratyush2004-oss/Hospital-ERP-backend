import { and, asc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../../database/context.js";
import {
  branches,
  invoiceItems,
  invoicePayments,
  invoiceRefunds,
  invoices,
  patientProfiles,
  paymentAllocations,
  payments,
  tenants,
  users,
} from "../../../database/schema/index.js";
import { AppError } from "../../../lib/http-error.js";
import {
  addMoney,
  calculateInvoiceBalance,
  compareMoney,
  normalizeMoney,
} from "../invoice-calculation.js";
import type { BillingDocumentBranding, BillingDocumentType } from "./billing-document.types.js";

/**
 * Document view model and record loaders (Phase 19.8.1).
 *
 * The model is a plain, renderer-independent description of one document. The
 * PDF template only draws it, so layout changes never touch financial logic and
 * tests can assert values/formatting without parsing PDF bytes.
 *
 * Money rules:
 * - every amount is read from a NUMERIC column as a decimal string and
 *   formatted with `normalizeMoney`; no JavaScript float arithmetic is used;
 * - sums use `addMoney`; invoice balances are re-derived with
 *   `calculateInvoiceBalance`, so a stale header is detected instead of printed.
 *
 * Privacy rules:
 * - documents contain the patient name and MRN only: no date of birth, gender,
 *   blood group, diagnosis, notes or free-text refund reason;
 * - tenant/storage identifiers and provider secrets never reach the PDF.
 */

export interface DocumentParty {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface DocumentMetaRow {
  readonly label: string;
  readonly value: string;
}

export interface DocumentTableColumn {
  readonly key: string;
  readonly label: string;
  readonly align: "left" | "right";
  readonly width: number;
}

export interface DocumentTable {
  readonly title?: string;
  readonly columns: readonly DocumentTableColumn[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export interface DocumentSummaryRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface BillingDocumentModel {
  readonly documentType: BillingDocumentType;
  readonly title: string;
  readonly subtitle: string;
  readonly documentNumber: string;
  readonly currency: string;
  readonly status: string;
  readonly generatedAt: Date;
  readonly hospitalName: string;
  readonly hospitalLegalName: string | null;
  readonly hospitalContact: readonly string[];
  readonly logo: Buffer | null;
  readonly parties: readonly DocumentParty[];
  readonly metadata: readonly DocumentMetaRow[];
  readonly tables: readonly DocumentTable[];
  readonly summary: readonly DocumentSummaryRow[];
  readonly footerNote: string;
}

/** Document snapshot plus the identifiers the service needs for metadata. */
export interface BuiltBillingDocument {
  readonly model: BillingDocumentModel;
  readonly documentNumber: string;
  readonly branchId: string;
  readonly invoiceId: string;
}

const MAX_PDF_TEXT = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isBillingUuid(value: string): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Plain grouped 2-decimal money. Currency is rendered separately. */
export function formatDocumentMoney(value: string): string {
  const normalized = normalizeMoney(value);
  const [whole = "0", fraction = "00"] = normalized.split(".");

  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** Quantities are NUMERIC(12,3); trailing zeros are display noise. */
export function formatDocumentQuantity(value: string): string {
  const text = value.trim();

  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(text)) {
    throw AppError.internal("A line quantity is not a valid decimal");
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");

  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

/** `YYYY-MM-DD` printed as `05 Jan 2026`; a date is never timezone-shifted. */
export function formatDocumentDate(value: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw AppError.internal("A document date is not a valid calendar date");
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw AppError.internal("A document date is not a valid calendar date");
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Absolute instants are shown in the branch timezone, falling back to UTC. */
export function formatDocumentInstant(value: Date, timeZone: string): string {
  let zone = timeZone;

  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(value);
  } catch {
    zone = "UTC";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  }).format(value);
}

/** Trims free text to a printable width; arbitrary length is never echoed. */
function printable(value: string | null | undefined, maxLength = MAX_PDF_TEXT): string | null {
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (text.length === 0) return null;

  return text.slice(0, maxLength);
}

function addressLines(source: {
  readonly addressLine1?: string | null;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}): string[] {
  const locality = [source.city, source.state, source.postalCode]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  const lines = [source.addressLine1, source.addressLine2, locality || null, source.country];

  return lines
    .map((line) => printable(line, 200))
    .filter((line): line is string => line !== null);
}

function contactLines(source: {
  readonly phone?: string | null;
  readonly email?: string | null;
}): string[] {
  return [source.phone, source.email]
    .map((line) => printable(line, 200))
    .filter((line): line is string => line !== null);
}

/** A server-side fallback keeps documents readable without branding. */
function displayName(name: string, legalName: string | null): string {
  return printable(name, 200) ?? printable(legalName, 200) ?? "Hospital";
}

interface DocumentTenant {
  readonly name: string;
  readonly legalName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

interface DocumentBranch {
  readonly id: string;
  readonly name: string;
  readonly branchCode: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly timezone: string;
}

interface DocumentPatient {
  readonly fullName: string;
  readonly patientCode: string;
}

interface InvoiceContext {
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly invoiceStatus: string;
    readonly issueDate: string;
    readonly dueDate: string | null;
    readonly currency: string;
    readonly subtotal: string;
    readonly discountTotal: string;
    readonly taxTotal: string;
    readonly totalAmount: string;
    readonly amountPaid: string;
    readonly balanceDue: string;
  };
  readonly patient: DocumentPatient;
  readonly branch: DocumentBranch;
  readonly tenant: DocumentTenant;
}

interface ModelBaseInput {
  readonly documentType: BillingDocumentType;
  readonly title: string;
  readonly subtitle: string;
  readonly documentNumber: string;
  readonly currency: string;
  readonly status: string;
  readonly generatedAt: Date;
  readonly tenant: DocumentTenant;
  readonly branch: DocumentBranch;
  readonly patient: DocumentPatient;
  readonly metadata: readonly DocumentMetaRow[];
  readonly parties?: readonly DocumentParty[];
  readonly tables: readonly DocumentTable[];
  readonly summary: readonly DocumentSummaryRow[];
  readonly branding: BillingDocumentBranding;
  readonly footerNote: string;
}

function baseModel(input: ModelBaseInput): BillingDocumentModel {
  return {
    documentType: input.documentType,
    title: input.title,
    subtitle: input.subtitle,
    documentNumber: input.documentNumber,
    currency: input.currency,
    status: input.status,
    generatedAt: input.generatedAt,
    hospitalName: displayName(input.tenant.name, input.tenant.legalName),
    hospitalLegalName: printable(input.tenant.legalName, 255),
    hospitalContact: contactLines(input.tenant),
    logo: input.branding.logo ?? null,
    parties: [
      {
        heading: "Billed to",
        lines: [
          printable(input.patient.fullName, 200) ?? "Patient",
          `Patient ID ${printable(input.patient.patientCode, 40) ?? "-"}`,
        ],
      },
      {
        heading: "Issued by",
        lines: [
          printable(input.branch.name, 200) ?? "Branch",
          `Branch ${printable(input.branch.branchCode, 50) ?? "-"}`,
          ...addressLines(input.branch),
          ...contactLines(input.branch),
        ],
      },
      ...(input.parties ?? []),
    ],
    metadata: input.metadata,
    tables: input.tables,
    summary: input.summary,
    footerNote: input.footerNote,
  };
}

async function loadInvoiceContext(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceContext> {
  const [row] = await tx
    .select({
      invoiceNumber: invoices.invoiceNumber,
      invoiceStatus: invoices.invoiceStatus,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      currency: invoices.currency,
      subtotal: invoices.subtotal,
      discountTotal: invoices.discountTotal,
      taxTotal: invoices.taxTotal,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      patientName: patientProfiles.fullName,
      patientCode: patientProfiles.patientCode,
      branchId: branches.id,
      branchName: branches.name,
      branchCode: branches.branchCode,
      addressLine1: branches.addressLine1,
      addressLine2: branches.addressLine2,
      city: branches.city,
      state: branches.state,
      postalCode: branches.postalCode,
      country: branches.country,
      branchPhone: branches.phone,
      branchEmail: branches.email,
      branchTimezone: branches.timezone,
      tenantName: tenants.name,
      tenantLegalName: tenants.legalName,
      tenantPhone: tenants.phone,
      tenantEmail: tenants.email,
    })
    .from(invoices)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.id, invoices.patientId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.tenantId, tenantId), eq(branches.id, invoices.branchId)),
    )
    .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
    .limit(1);

  if (!row) throw AppError.notFound("Invoice not found");

  return {
    invoice: {
      id: invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceStatus: row.invoiceStatus,
      issueDate: row.issueDate,
      dueDate: row.dueDate,
      currency: row.currency,
      subtotal: row.subtotal,
      discountTotal: row.discountTotal,
      taxTotal: row.taxTotal,
      totalAmount: row.totalAmount,
      amountPaid: row.amountPaid,
      balanceDue: row.balanceDue,
    },
    patient: { fullName: row.patientName, patientCode: row.patientCode },
    branch: {
      id: row.branchId,
      name: row.branchName,
      branchCode: row.branchCode,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
      phone: row.branchPhone,
      email: row.branchEmail,
      timezone: row.branchTimezone,
    },
    tenant: {
      name: row.tenantName,
      legalName: row.tenantLegalName,
      phone: row.tenantPhone,
      email: row.tenantEmail,
    },
  };
}

/**
 * A draft has not been issued and a cancelled invoice is void: neither may be
 * presented as an issued financial document.
 */
function assertInvoicePublishable(status: string): void {
  if (status === "DRAFT") {
    throw AppError.conflict("A draft invoice cannot be generated as a financial document");
  }

  if (status === "CANCELLED") {
    throw AppError.conflict("A cancelled invoice cannot be generated as a financial document");
  }
}

interface InvoiceLineRow {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly grossAmount: string;
  readonly discountAmount: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
}

async function loadInvoiceLines(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  return tx
    .select({
      description: invoiceItems.description,
      quantity: invoiceItems.quantity,
      unitPrice: invoiceItems.unitPrice,
      grossAmount: invoiceItems.grossAmount,
      discountAmount: invoiceItems.discountAmount,
      taxAmount: invoiceItems.taxAmount,
      lineTotal: invoiceItems.lineTotal,
    })
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.tenantId, tenantId),
        eq(invoiceItems.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id));
}

/**
 * Verifies the stored header against its lines and successful ledger. A
 * mismatch means the record is corrupt or stale, so no document is produced.
 *
 * `balance_due` is not compared because a fully refunded invoice is closed to
 * `0.00` by the lifecycle service; the ledger-derived paid amount is the
 * invariant that must hold for every non-cancelled state.
 */
async function assertInvoiceConsistent(
  tx: DatabaseTransaction,
  tenantId: string,
  context: InvoiceContext,
  lines: readonly InvoiceLineRow[],
): Promise<void> {
  if (lines.length === 0) {
    throw AppError.conflict("The invoice has no line items");
  }

  const gross = addMoney(lines.map((line) => line.grossAmount));
  const discounts = addMoney(lines.map((line) => line.discountAmount));
  const taxes = addMoney(lines.map((line) => line.taxAmount));
  const total = addMoney(lines.map((line) => line.lineTotal));

  if (
    compareMoney(gross, context.invoice.subtotal) !== 0 ||
    compareMoney(discounts, context.invoice.discountTotal) !== 0 ||
    compareMoney(taxes, context.invoice.taxTotal) !== 0 ||
    compareMoney(total, context.invoice.totalAmount) !== 0
  ) {
    throw AppError.conflict("The invoice totals do not reconcile with its line items");
  }

  const settled = await tx
    .select({
      amount: invoicePayments.amount,
      status: invoicePayments.paymentStatus,
      currency: invoicePayments.currency,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.tenantId, tenantId),
        eq(invoicePayments.invoiceId, context.invoice.id),
      ),
    );

  const refunded = await tx
    .select({
      amount: invoiceRefunds.amount,
      status: invoiceRefunds.refundStatus,
      currency: invoiceRefunds.currency,
    })
    .from(invoiceRefunds)
    .where(
      and(
        eq(invoiceRefunds.tenantId, tenantId),
        eq(invoiceRefunds.invoiceId, context.invoice.id),
      ),
    );

  const balance = calculateInvoiceBalance({
    totalAmount: context.invoice.totalAmount,
    currency: context.invoice.currency,
    payments: settled,
    refunds: refunded,
  });

  if (compareMoney(balance.amountPaid, context.invoice.amountPaid) !== 0) {
    throw AppError.conflict("The invoice balance does not reconcile with its payment ledger");
  }
}

export async function buildInvoiceDocument(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
  generatedAt: Date,
  branding: BillingDocumentBranding,
): Promise<BuiltBillingDocument> {
  const context = await loadInvoiceContext(tx, tenantId, invoiceId);
  assertInvoicePublishable(context.invoice.invoiceStatus);

  const lines = await loadInvoiceLines(tx, tenantId, invoiceId);
  await assertInvoiceConsistent(tx, tenantId, context, lines);

  const model = baseModel({
    documentType: "INVOICE",
    title: "Invoice",
    subtitle: "Hospital billing statement",
    documentNumber: context.invoice.invoiceNumber,
    currency: context.invoice.currency,
    status: context.invoice.invoiceStatus,
    generatedAt,
    tenant: context.tenant,
    branch: context.branch,
    patient: context.patient,
    metadata: [
      { label: "Invoice number", value: context.invoice.invoiceNumber },
      { label: "Issue date", value: formatDocumentDate(context.invoice.issueDate) },
      ...(context.invoice.dueDate === null
        ? []
        : [{ label: "Due date", value: formatDocumentDate(context.invoice.dueDate) }]),
      { label: "Currency", value: context.invoice.currency },
    ],
    tables: [
      {
        title: "Charges",
        columns: [
          { key: "description", label: "Description", align: "left", width: 34 },
          { key: "quantity", label: "Qty", align: "right", width: 9 },
          { key: "unitPrice", label: "Unit price", align: "right", width: 15 },
          { key: "discount", label: "Discount", align: "right", width: 13 },
          { key: "tax", label: "Tax", align: "right", width: 13 },
          { key: "total", label: "Amount", align: "right", width: 16 },
        ],
        rows: lines.map((line) => ({
          description: printable(line.description, 500) ?? "Charge",
          quantity: formatDocumentQuantity(line.quantity),
          unitPrice: formatDocumentMoney(line.unitPrice),
          discount: formatDocumentMoney(line.discountAmount),
          tax: formatDocumentMoney(line.taxAmount),
          total: formatDocumentMoney(line.lineTotal),
        })),
      },
    ],
    summary: [
      { label: "Subtotal", value: formatDocumentMoney(context.invoice.subtotal) },
      { label: "Discounts", value: formatDocumentMoney(context.invoice.discountTotal) },
      { label: "Tax", value: formatDocumentMoney(context.invoice.taxTotal) },
      {
        label: "Total",
        value: formatDocumentMoney(context.invoice.totalAmount),
        emphasis: true,
      },
      { label: "Amount paid", value: formatDocumentMoney(context.invoice.amountPaid) },
      {
        label: "Balance due",
        value: formatDocumentMoney(context.invoice.balanceDue),
        emphasis: true,
      },
    ],
    branding,
    footerNote:
      context.invoice.invoiceStatus === "REFUNDED"
        ? "This invoice has been fully refunded. Retain for your records."
        : "Please retain this document for your records.",
  });

  return {
    model,
    documentNumber: context.invoice.invoiceNumber,
    branchId: context.branch.id,
    invoiceId: context.invoice.id,
  };
}

/** Stable printed receipt number: the reference when present, else the id. */
export function receiptDocumentNumber(payment: {
  readonly id: string;
  readonly reference: string | null;
}): string {
  const reference = printable(payment.reference, 120);

  return reference ?? `PAY-${payment.id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

/** Stable printed credit-note number: the reference when present, else the id. */
export function creditNoteDocumentNumber(refund: {
  readonly id: string;
  readonly reference: string | null;
}): string {
  const reference = printable(refund.reference, 120);

  return reference ?? `CN-${refund.id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

interface ReceiptContext {
  readonly payment: {
    readonly id: string;
    readonly amount: string;
    readonly currency: string;
    readonly paymentStatus: string;
    readonly paymentMethod: string;
    readonly reference: string | null;
    readonly receivedAt: Date;
  };
  readonly receivedByName: string | null;
  readonly patient: DocumentPatient;
  readonly branch: DocumentBranch;
  readonly tenant: DocumentTenant;
  readonly allocations: readonly {
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly amount: string;
    readonly invoiceBalanceDue: string;
  }[];
}

async function loadReceiptContext(
  tx: DatabaseTransaction,
  tenantId: string,
  paymentId: string,
): Promise<ReceiptContext> {
  const [row] = await tx
    .select({
      amount: payments.amount,
      currency: payments.currency,
      paymentStatus: payments.paymentStatus,
      paymentMethod: payments.paymentMethod,
      reference: payments.reference,
      receivedAt: payments.receivedAt,
      receivedByName: users.fullName,
      patientId: payments.patientId,
      patientName: patientProfiles.fullName,
      patientCode: patientProfiles.patientCode,
      branchId: branches.id,
      branchName: branches.name,
      branchCode: branches.branchCode,
      addressLine1: branches.addressLine1,
      addressLine2: branches.addressLine2,
      city: branches.city,
      state: branches.state,
      postalCode: branches.postalCode,
      country: branches.country,
      branchPhone: branches.phone,
      branchEmail: branches.email,
      branchTimezone: branches.timezone,
      tenantName: tenants.name,
      tenantLegalName: tenants.legalName,
      tenantPhone: tenants.phone,
      tenantEmail: tenants.email,
    })
    .from(payments)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.id, payments.patientId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.tenantId, tenantId), eq(branches.id, payments.branchId)),
    )
    .innerJoin(tenants, eq(tenants.id, payments.tenantId))
    .leftJoin(users, eq(users.id, payments.receivedBy))
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
    .limit(1);

  if (!row) throw AppError.notFound("Payment not found");

  if (row.paymentStatus !== "SUCCESSFUL") {
    throw AppError.conflict("Only a successful payment can be issued as a receipt");
  }

  const allocations = await tx
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      amount: paymentAllocations.amount,
      invoiceBalanceDue: invoices.balanceDue,
      invoiceBranchId: invoices.branchId,
      invoicePatientId: invoices.patientId,
      invoiceCurrency: invoices.currency,
    })
    .from(paymentAllocations)
    .innerJoin(
      invoices,
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.id, paymentAllocations.invoiceId),
      ),
    )
    .where(
      and(
        eq(paymentAllocations.tenantId, tenantId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    )
    .orderBy(asc(invoices.invoiceNumber));

  if (allocations.length === 0) {
    throw AppError.conflict("The receipt has no invoice allocations");
  }

  for (const allocation of allocations) {
    // A receipt may only be issued when every allocation agrees with the
    // receipt-level branch, patient and currency it was recorded under.
    if (
      allocation.invoiceBranchId !== row.branchId ||
      allocation.invoicePatientId !== row.patientId ||
      allocation.invoiceCurrency !== row.currency
    ) {
      throw AppError.conflict(
        "The receipt does not match its allocated invoices' branch, patient and currency",
      );
    }
  }

  const allocated = addMoney(allocations.map((allocation) => allocation.amount));

  if (compareMoney(allocated, row.amount) !== 0) {
    throw AppError.conflict("The receipt amount does not reconcile with its allocations");
  }

  return {
    payment: {
      id: paymentId,
      amount: row.amount,
      currency: row.currency,
      paymentStatus: row.paymentStatus,
      paymentMethod: row.paymentMethod,
      reference: row.reference,
      receivedAt: row.receivedAt,
    },
    receivedByName: printable(row.receivedByName, 200),
    patient: { fullName: row.patientName, patientCode: row.patientCode },
    branch: {
      id: row.branchId,
      name: row.branchName,
      branchCode: row.branchCode,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
      phone: row.branchPhone,
      email: row.branchEmail,
      timezone: row.branchTimezone,
    },
    tenant: {
      name: row.tenantName,
      legalName: row.tenantLegalName,
      phone: row.tenantPhone,
      email: row.tenantEmail,
    },
    allocations,
  };
}

export async function buildPaymentReceiptDocument(
  tx: DatabaseTransaction,
  tenantId: string,
  paymentId: string,
  generatedAt: Date,
  branding: BillingDocumentBranding,
): Promise<BuiltBillingDocument> {
  const context = await loadReceiptContext(tx, tenantId, paymentId);
  const documentNumber = receiptDocumentNumber(context.payment);
  const reference = printable(context.payment.reference, 120);
  const allocations = context.allocations.map((allocation) => ({
    invoice: allocation.invoiceNumber,
    amount: formatDocumentMoney(allocation.amount),
    balance: formatDocumentMoney(allocation.invoiceBalanceDue),
  }));

  const model = baseModel({
    documentType: "PAYMENT_RECEIPT",
    title: "Payment Receipt",
    subtitle: "Acknowledgement of payment received",
    documentNumber,
    currency: context.payment.currency,
    status: context.payment.paymentStatus,
    generatedAt,
    tenant: context.tenant,
    branch: context.branch,
    patient: context.patient,
    metadata: [
      { label: "Receipt number", value: documentNumber },
      {
        label: "Payment date",
        value: formatDocumentInstant(context.payment.receivedAt, context.branch.timezone),
      },
      { label: "Payment method", value: context.payment.paymentMethod },
      ...(reference === null ? [] : [{ label: "Reference", value: reference }]),
      ...(context.receivedByName === null
        ? []
        : [{ label: "Received by", value: context.receivedByName }]),
      { label: "Currency", value: context.payment.currency },
    ],
    tables: [
      {
        title: "Allocations",
        columns: [
          { key: "invoice", label: "Invoice", align: "left", width: 46 },
          { key: "amount", label: "Amount paid", align: "right", width: 27 },
          { key: "balance", label: "Balance due", align: "right", width: 27 },
        ],
        rows: allocations,
      },
    ],
    summary: [
      {
        label: "Total received",
        value: formatDocumentMoney(context.payment.amount),
        emphasis: true,
      },
    ],
    branding,
    footerNote: "Payment has been received in full for the allocations shown above.",
  });

  return {
    model,
    documentNumber,
    branchId: context.branch.id,
    invoiceId: context.allocations[0]?.invoiceId ?? "",
  };
}

interface CreditNoteContext {
  readonly refund: {
    readonly id: string;
    readonly amount: string;
    readonly currency: string;
    readonly refundStatus: string;
    readonly reference: string | null;
    readonly provider: string | null;
    readonly providerRefundId: string | null;
    readonly refundedAt: Date | null;
    readonly processedAt: Date | null;
    readonly createdAt: Date;
  };
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly totalAmount: string;
    readonly amountPaid: string;
    readonly balanceDue: string;
    readonly currency: string;
  };
  readonly receiptReference: string | null;
  readonly captureReference: string | null;
  readonly patient: DocumentPatient;
  readonly branch: DocumentBranch;
  readonly tenant: DocumentTenant;
}

async function loadCreditNoteContext(
  tx: DatabaseTransaction,
  tenantId: string,
  refundId: string,
): Promise<CreditNoteContext> {
  const [row] = await tx
    .select({
      refundAmount: invoiceRefunds.amount,
      refundCurrency: invoiceRefunds.currency,
      refundStatus: invoiceRefunds.refundStatus,
      refundReference: invoiceRefunds.reference,
      provider: invoiceRefunds.provider,
      providerRefundId: invoiceRefunds.providerRefundId,
      refundedAt: invoiceRefunds.refundedAt,
      processedAt: invoiceRefunds.processedAt,
      refundCreatedAt: invoiceRefunds.createdAt,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceTotal: invoices.totalAmount,
      invoiceAmountPaid: invoices.amountPaid,
      invoiceBalanceDue: invoices.balanceDue,
      invoiceCurrency: invoices.currency,
      receiptReference: payments.reference,
      captureReference: invoicePayments.reference,
      patientName: patientProfiles.fullName,
      patientCode: patientProfiles.patientCode,
      branchId: branches.id,
      branchName: branches.name,
      branchCode: branches.branchCode,
      addressLine1: branches.addressLine1,
      addressLine2: branches.addressLine2,
      city: branches.city,
      state: branches.state,
      postalCode: branches.postalCode,
      country: branches.country,
      branchPhone: branches.phone,
      branchEmail: branches.email,
      branchTimezone: branches.timezone,
      tenantName: tenants.name,
      tenantLegalName: tenants.legalName,
      tenantPhone: tenants.phone,
      tenantEmail: tenants.email,
    })
    .from(invoiceRefunds)
    .innerJoin(
      invoices,
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.id, invoiceRefunds.invoiceId),
      ),
    )
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.id, invoices.patientId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.tenantId, tenantId), eq(branches.id, invoices.branchId)),
    )
    .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .leftJoin(
      invoicePayments,
      and(
        eq(invoicePayments.tenantId, tenantId),
        eq(invoicePayments.id, invoiceRefunds.paymentId),
        eq(invoicePayments.invoiceId, invoiceRefunds.invoiceId),
      ),
    )
    .leftJoin(
      payments,
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.id, invoicePayments.paymentId),
      ),
    )
    .where(
      and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, refundId)),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Refund not found");

  if (row.refundStatus !== "SUCCESSFUL") {
    throw AppError.conflict("Only a successful refund can be issued as a credit note");
  }

  if (row.refundCurrency !== row.invoiceCurrency) {
    throw AppError.conflict("The refund currency does not match the invoice");
  }

  if (compareMoney(row.refundAmount, "0.00") <= 0) {
    throw AppError.conflict("A credit note requires a positive refund amount");
  }

  return {
    refund: {
      id: refundId,
      amount: row.refundAmount,
      currency: row.refundCurrency,
      refundStatus: row.refundStatus,
      reference: row.refundReference,
      provider: printable(row.provider, 40),
      providerRefundId: printable(row.providerRefundId, 120),
      refundedAt: row.refundedAt,
      processedAt: row.processedAt,
      createdAt: row.refundCreatedAt,
    },
    invoice: {
      id: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      totalAmount: row.invoiceTotal,
      amountPaid: row.invoiceAmountPaid,
      balanceDue: row.invoiceBalanceDue,
      currency: row.invoiceCurrency,
    },
    receiptReference: printable(row.receiptReference, 120),
    captureReference: printable(row.captureReference, 120),
    patient: { fullName: row.patientName, patientCode: row.patientCode },
    branch: {
      id: row.branchId,
      name: row.branchName,
      branchCode: row.branchCode,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
      phone: row.branchPhone,
      email: row.branchEmail,
      timezone: row.branchTimezone,
    },
    tenant: {
      name: row.tenantName,
      legalName: row.tenantLegalName,
      phone: row.tenantPhone,
      email: row.tenantEmail,
    },
  };
}

export async function buildCreditNoteDocument(
  tx: DatabaseTransaction,
  tenantId: string,
  refundId: string,
  generatedAt: Date,
  branding: BillingDocumentBranding,
): Promise<BuiltBillingDocument> {
  const context = await loadCreditNoteContext(tx, tenantId, refundId);
  const documentNumber = creditNoteDocumentNumber(context.refund);
  const reference = printable(context.refund.reference, 120);
  const paymentReference =
    context.receiptReference ?? context.captureReference ?? context.refund.providerRefundId;
  const refundedAt =
    context.refund.refundedAt ?? context.refund.processedAt ?? context.refund.createdAt;

  const model = baseModel({
    documentType: "CREDIT_NOTE",
    title: "Credit Note",
    subtitle: "Refund acknowledgement",
    documentNumber,
    currency: context.refund.currency,
    status: context.refund.refundStatus,
    generatedAt,
    tenant: context.tenant,
    branch: context.branch,
    patient: context.patient,
    metadata: [
      { label: "Credit note number", value: documentNumber },
      { label: "Original invoice", value: context.invoice.invoiceNumber },
      { label: "Refund date", value: formatDocumentInstant(refundedAt, context.branch.timezone) },
      ...(reference === null ? [] : [{ label: "Reference", value: reference }]),
      ...(paymentReference === null
        ? []
        : [{ label: "Payment reference", value: paymentReference }]),
      ...(context.refund.provider === null
        ? []
        : [{ label: "Refund channel", value: context.refund.provider }]),
      { label: "Currency", value: context.refund.currency },
    ],
    tables: [
      {
        title: "Refund",
        columns: [
          { key: "description", label: "Description", align: "left", width: 52 },
          { key: "quantity", label: "Qty", align: "right", width: 10 },
          { key: "amount", label: "Amount", align: "right", width: 38 },
        ],
        rows: [
          {
            description: `Refund against invoice ${context.invoice.invoiceNumber}`,
            quantity: "1",
            amount: formatDocumentMoney(context.refund.amount),
          },
        ],
      },
    ],
    summary: [
      {
        label: "Amount refunded",
        value: formatDocumentMoney(context.refund.amount),
        emphasis: true,
      },
      { label: "Invoice total", value: formatDocumentMoney(context.invoice.totalAmount) },
      { label: "Net amount paid", value: formatDocumentMoney(context.invoice.amountPaid) },
      {
        label: "Balance due",
        value: formatDocumentMoney(context.invoice.balanceDue),
        emphasis: true,
      },
    ],
    branding,
    footerNote: "This credit note confirms that the amount above was refunded.",
  });

  return {
    model,
    documentNumber,
    branchId: context.branch.id,
    invoiceId: context.invoice.id,
  };
}
