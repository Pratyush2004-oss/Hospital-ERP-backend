import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { env } from "../../../config/env.js";
import { withTenantTransaction, type DatabaseTransaction } from "../../../database/context.js";
import {
  billingDocuments,
  invoiceRefunds,
  invoices,
  paymentAllocations,
  payments,
  tenantMemberships,
} from "../../../database/schema/index.js";
import { AppError } from "../../../lib/http-error.js";
import { logger } from "../../../lib/logger.js";
import { getStorageProvider } from "../../../lib/storage/index.js";
import {
  StorageObjectNotFoundError,
  StorageOperationError,
  type StorageProvider,
} from "../../../lib/storage/storage.types.js";
import { recordBillingAudit } from "../billing.audit.js";
import {
  buildCreditNoteDocument,
  buildInvoiceDocument,
  buildPaymentReceiptDocument,
  isBillingUuid,
  type BuiltBillingDocument,
} from "./billing-document.model.js";
import { pdfKitBillingDocumentRenderer } from "./billing-document.template.js";
import type {
  BillingDocumentActor,
  BillingDocumentDto,
  BillingDocumentServiceOptions,
  BillingDocumentType,
} from "./billing-document.types.js";

/**
 * Billing document generation service (Phase 19.8.1).
 *
 * Security and integrity rules:
 * - the caller must have an ACTIVE membership and the `payment:read` key;
 * - only persisted records are rendered: the caller supplies identifiers, never
 *   amounts, totals, line items or document numbers;
 * - invoice documents require a non-draft, non-cancelled invoice whose totals
 *   reconcile with its lines and successful ledger;
 * - receipts require `payments.payment_status = SUCCESSFUL` and allocations that
 *   reconcile with the receipt amount, branch, patient and currency;
 * - credit notes require `invoice_refunds.refund_status = SUCCESSFUL` with a
 *   positive amount and matching currency;
 * - every query repeats `tenant_id` on top of RLS, so another hospital's record
 *   is a 404;
 * - a stored valid document is reused unless `regenerate` is set; regenerating
 *   never rewrites financial rows, it stores a new object and links the version
 *   via `regenerated_from_id`;
 * - rendering/storage failures write no metadata and never touch billing rows;
 *   a metadata failure removes the just-written object (compensation);
 * - audit events contain identifiers only: no patient name, amount or key.
 */

/** Billing documents are financial evidence and use the payment read grant. */
const DOCUMENT_READ_PERMISSION = "payment:read";
const PDF_SIGNATURE = "%PDF-";

interface GenerateOptions extends BillingDocumentServiceOptions {
  /** Forces a new artifact instead of reusing the latest stored version. */
  readonly regenerate?: boolean;
}

interface SourceRef {
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly refundId: string | null;
}

/** Generation result: whether an existing valid artifact was reused. */
export interface GenerateBillingDocumentResult {
  readonly document: BillingDocumentDto;
  readonly reused: boolean;
}

interface StoredDocumentRow extends BillingDocumentDto {
  readonly storageKey: string;
}

function assertTenantContext(tenantId: string): void {
  if (!isBillingUuid(tenantId)) {
    throw AppError.forbidden("A verified tenant context is required");
  }
}

function assertActor(actor: BillingDocumentActor): void {
  if (!actor || typeof actor.userId !== "string" || !isBillingUuid(actor.userId)) {
    throw AppError.forbidden("A verified user context is required");
  }
}

function assertDocumentPermission(actor: BillingDocumentActor): void {
  if (!actor.permissions?.has(DOCUMENT_READ_PERMISSION)) {
    throw AppError.forbidden("You do not have permission to access billing documents");
  }
}

function assertSourceId(value: string, field: string): string {
  if (!isBillingUuid(value)) {
    throw AppError.validation(`${field} must be a UUID`, { field });
  }

  return value;
}

async function assertActiveMembership(
  tx: DatabaseTransaction,
  tenantId: string,
  actor: BillingDocumentActor,
): Promise<void> {
  const [membership] = await tx
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, actor.userId),
        eq(tenantMemberships.status, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw AppError.forbidden("You are not an active member of this hospital");
  }
}

/** Server-generated, tenant-scoped key. Client input never names an object. */
function buildStorageKey(
  tenantId: string,
  documentType: BillingDocumentType,
  sourceId: string,
  objectId: string,
): string {
  const segment = documentType.toLowerCase().replaceAll("_", "-");
  return `tenants/${tenantId}/billing/${segment}/${sourceId}/${objectId}.pdf`;
}

function buildFileName(documentNumber: string): string {
  const safe = documentNumber
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);

  return `${safe.length > 0 ? safe : "billing-document"}.pdf`;
}

function toDto(row: {
  readonly id: string;
  readonly documentType: BillingDocumentType;
  readonly documentNumber: string;
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly branchId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly generatedBy: string | null;
  readonly regeneratedFromId: string | null;
  readonly createdAt: Date;
}): BillingDocumentDto {
  return {
    id: row.id,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    invoiceId: row.invoiceId,
    paymentId: row.paymentId,
    refundId: row.refundId,
    branchId: row.branchId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    generatedBy: row.generatedBy,
    regeneratedFromId: row.regeneratedFromId,
    createdAt: row.createdAt,
  };
}

const documentSelection = {
  id: billingDocuments.id,
  documentType: billingDocuments.documentType,
  documentNumber: billingDocuments.documentNumber,
  invoiceId: billingDocuments.invoiceId,
  paymentId: billingDocuments.paymentId,
  refundId: billingDocuments.refundId,
  branchId: billingDocuments.branchId,
  fileName: billingDocuments.fileName,
  mimeType: billingDocuments.mimeType,
  fileSize: billingDocuments.fileSize,
  generatedBy: billingDocuments.generatedBy,
  regeneratedFromId: billingDocuments.regeneratedFromId,
  createdAt: billingDocuments.createdAt,
};

async function loadLatestDocument(
  tx: DatabaseTransaction,
  tenantId: string,
  documentType: BillingDocumentType,
  source: SourceRef,
): Promise<StoredDocumentRow | null> {
  const condition = (() => {
    switch (documentType) {
      case "INVOICE":
        return eq(billingDocuments.invoiceId, source.invoiceId);
      case "PAYMENT_RECEIPT":
        return eq(billingDocuments.paymentId, source.paymentId as string);
      case "CREDIT_NOTE":
        return eq(billingDocuments.refundId, source.refundId as string);
    }
  })();

  const [row] = await tx
    .select({ ...documentSelection, storageKey: billingDocuments.storageKey })
    .from(billingDocuments)
    .where(
      and(
        eq(billingDocuments.tenantId, tenantId),
        eq(billingDocuments.documentType, documentType),
        condition,
      ),
    )
    .orderBy(desc(billingDocuments.createdAt))
    .limit(1);

  return row ? { ...toDto(row), storageKey: row.storageKey } : null;
}

async function storedObjectExists(
  storage: StorageProvider,
  key: string,
): Promise<boolean> {
  try {
    await storage.getObject(key);
    return true;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) return false;
    throw error;
  }
}

/** Rejects an empty, oversized or non-PDF renderer result before it is stored. */
function assertPdfBytes(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("The renderer returned no PDF bytes");
  }

  if (bytes.length > env.STORAGE_MAX_FILE_SIZE_BYTES) {
    throw new Error("The generated document exceeds the storage size limit");
  }

  if (bytes.subarray(0, PDF_SIGNATURE.length).toString("latin1") !== PDF_SIGNATURE) {
    throw new Error("The renderer did not return a PDF document");
  }
}

interface GenerateContext {
  readonly tenantId: string;
  readonly documentType: BillingDocumentType;
  readonly sourceId: string;
  readonly source: SourceRef;
  readonly actor: BillingDocumentActor;
  readonly options: GenerateOptions;
  readonly build: (
    tx: DatabaseTransaction,
    tenantId: string,
    sourceId: string,
    generatedAt: Date,
  ) => Promise<BuiltBillingDocument>;
}

async function generateDocument(
  context: GenerateContext,
): Promise<GenerateBillingDocumentResult> {
  const { tenantId, documentType, source, actor, options } = context;

  assertTenantContext(tenantId);
  assertActor(actor);
  assertDocumentPermission(actor);

  const storage = options.storage ?? getStorageProvider();
  const renderer = options.renderer ?? pdfKitBillingDocumentRenderer;
  const generatedAt = options.now?.() ?? new Date();
  const objectId = options.generateObjectId?.() ?? randomUUID();

  if (!isBillingUuid(objectId)) {
    throw AppError.internal("Failed to generate a storage object name");
  }

  let storedKey: string | null = null;

  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actor);

      if (options.regenerate !== true) {
        const existing = await loadLatestDocument(tx, tenantId, documentType, source);

        if (existing !== null && (await storedObjectExists(storage, existing.storageKey))) {
          const { storageKey: _key, ...dto } = existing;

          recordBillingAudit(options.audit, "billing_document.reused", {
            tenantId,
            actorUserId: actor.userId,
            invoiceId: source.invoiceId,
            paymentId: source.paymentId ?? undefined,
            refundId: source.refundId ?? undefined,
            documentId: dto.id,
            documentType,
          });

          return { document: dto, reused: true };
        }
      }

      const built = await context.build(tx, tenantId, context.sourceId, generatedAt);

      let pdf: Buffer;

      try {
        pdf = await renderer.render({
          ...built.model,
          logo: options.logo ?? built.model.logo,
        });
        assertPdfBytes(pdf);
      } catch (error) {
        logger.warn(
          {
            event: "billing_document.render_failed",
            tenantId,
            documentType,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "billing document rendering failed",
        );

        recordBillingAudit(options.audit, "billing_document.generation_failed", {
          tenantId,
          actorUserId: actor.userId,
          invoiceId: source.invoiceId,
          paymentId: source.paymentId ?? undefined,
          refundId: source.refundId ?? undefined,
          documentType,
          reason: "RENDER_FAILED",
        });

        throw AppError.serviceUnavailable("Billing document generation is temporarily unavailable");
      }

      const key = buildStorageKey(tenantId, documentType, context.sourceId, objectId);
      const fileName = buildFileName(built.documentNumber);

      try {
        await storage.putObject({ key, body: pdf, contentType: "application/pdf" });
        storedKey = key;
      } catch (error) {
        logger.warn(
          {
            event: "billing_document.storage_failed",
            tenantId,
            documentType,
            storageProvider: storage.name,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "billing document storage failed",
        );

        recordBillingAudit(options.audit, "billing_document.generation_failed", {
          tenantId,
          actorUserId: actor.userId,
          invoiceId: source.invoiceId,
          paymentId: source.paymentId ?? undefined,
          refundId: source.refundId ?? undefined,
          documentType,
          reason: "STORAGE_FAILED",
        });

        throw AppError.serviceUnavailable("Document storage is temporarily unavailable");
      }

      const previous = await loadLatestDocument(tx, tenantId, documentType, source);

      const [created] = await tx
        .insert(billingDocuments)
        .values({
          tenantId,
          branchId: built.branchId,
          documentType,
          documentNumber: built.documentNumber,
          invoiceId: built.invoiceId,
          paymentId: source.paymentId,
          refundId: source.refundId,
          fileName,
          storageKey: key,
          mimeType: "application/pdf",
          fileSize: pdf.length,
          generatedBy: actor.userId,
          regeneratedFromId: previous?.id ?? null,
        })
        .returning(documentSelection);

      if (!created) {
        throw AppError.internal("Failed to save the billing document");
      }

      recordBillingAudit(options.audit, "billing_document.generated", {
        tenantId,
        actorUserId: actor.userId,
        invoiceId: source.invoiceId,
        paymentId: source.paymentId ?? undefined,
        refundId: source.refundId ?? undefined,
        documentId: created.id,
        documentType,
      });

      return { document: toDto(created), reused: false };
    });
  } catch (error) {
    if (storedKey !== null) {
      try {
        await storage.deleteObject(storedKey);
      } catch {
        logger.warn(
          {
            event: "billing_document.cleanup_failed",
            tenantId,
            documentType,
            storageProvider: storage.name,
          },
          "billing document cleanup failed",
        );
      }
    }

    throw error;
  }
}

/** Generates or reuses the issued invoice PDF for one tenant-scoped invoice. */
export async function generateInvoiceDocument(
  tenantId: string,
  invoiceId: string,
  actor: BillingDocumentActor,
  options: GenerateOptions = {},
): Promise<GenerateBillingDocumentResult> {
  const id = assertSourceId(invoiceId, "invoiceId");

  return generateDocument({
    tenantId,
    documentType: "INVOICE",
    sourceId: id,
    source: { invoiceId: id, paymentId: null, refundId: null },
    actor,
    options,
    build: (tx, tenant, source, generatedAt) =>
      buildInvoiceDocument(tx, tenant, source, generatedAt, { logo: options.logo }),
  });
}

/** Generates or reuses the receipt PDF for one successful payment. */
export async function generatePaymentReceiptDocument(
  tenantId: string,
  paymentId: string,
  actor: BillingDocumentActor,
  options: GenerateOptions = {},
): Promise<GenerateBillingDocumentResult> {
  const id = assertSourceId(paymentId, "paymentId");

  // Receipts may settle several invoices; the first allocation identifies the
  // record for metadata/audit, and the builder re-validates every allocation.
  const invoiceId = await withTenantTransaction(tenantId, async (tx) => {
    const [payment] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
      .limit(1);

    if (!payment) throw AppError.notFound("Payment not found");

    const [allocation] = await tx
      .select({ invoiceId: paymentAllocations.invoiceId })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.paymentId, id),
        ),
      )
      .limit(1);

    return allocation?.invoiceId ?? "";
  });

  return generateDocument({
    tenantId,
    documentType: "PAYMENT_RECEIPT",
    sourceId: id,
    source: { invoiceId, paymentId: id, refundId: null },
    actor,
    options,
    build: async (tx, tenant, source, generatedAt) => {
      const built = await buildPaymentReceiptDocument(
        tx,
        tenant,
        source,
        generatedAt,
        { logo: options.logo },
      );

      return { ...built, invoiceId: built.invoiceId || invoiceId };
    },
  });
}

/** Generates or reuses the credit note PDF for one successful refund. */
export async function generateCreditNoteDocument(
  tenantId: string,
  refundId: string,
  actor: BillingDocumentActor,
  options: GenerateOptions = {},
): Promise<GenerateBillingDocumentResult> {
  const id = assertSourceId(refundId, "refundId");

  const invoiceId = await withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ invoiceId: invoiceRefunds.invoiceId })
      .from(invoiceRefunds)
      .where(
        and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, id)),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Refund not found");

    return row.invoiceId;
  });

  return generateDocument({
    tenantId,
    documentType: "CREDIT_NOTE",
    sourceId: id,
    source: { invoiceId, paymentId: null, refundId: id },
    actor,
    options,
    build: (tx, tenant, source, generatedAt) =>
      buildCreditNoteDocument(tx, tenant, source, generatedAt, { logo: options.logo }),
  });
}

/** Loads one stored billing document's metadata, tenant-scoped. */
export async function getBillingDocumentById(
  tenantId: string,
  documentId: string,
  actor: BillingDocumentActor,
): Promise<BillingDocumentDto> {
  assertTenantContext(tenantId);
  assertActor(actor);
  assertDocumentPermission(actor);

  const id = assertSourceId(documentId, "documentId");

  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);

    const [row] = await tx
      .select(documentSelection)
      .from(billingDocuments)
      .where(
        and(eq(billingDocuments.tenantId, tenantId), eq(billingDocuments.id, id)),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Billing document not found");

    return toDto(row);
  });
}

/**
 * Branch consistency for a document is derived from the persisted record; a
 * tenant membership is hospital-wide today, so no caller-supplied branch id is
 * trusted or accepted.
 */
export async function assertDocumentInvoiceScope(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
  branchId: string,
): Promise<void> {
  const [invoice] = await tx
    .select({ branchId: invoices.branchId })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
    .limit(1);

  if (!invoice || invoice.branchId !== branchId) {
    throw AppError.conflict("The billing document does not match its invoice branch");
  }
}

/** A downloaded artifact: metadata plus the stored bytes. */
export interface BillingDocumentFile {
  readonly document: BillingDocumentDto;
  readonly bytes: Buffer;
}

/**
 * Reads one stored PDF for authenticated streaming.
 *
 * Order matters: tenant scope, permission and active membership are checked
 * before the storage key is read, and the row is loaded with `tenant_id` in the
 * predicate on top of RLS. A metadata row whose object is gone returns `404`
 * and never falls back to regenerating implicitly, so a download can never
 * change financial records or create a surprise artifact.
 */
export async function readBillingDocumentFile(
  tenantId: string,
  documentId: string,
  actor: BillingDocumentActor,
  options: Pick<BillingDocumentServiceOptions, "storage" | "audit"> = {},
): Promise<BillingDocumentFile> {
  assertTenantContext(tenantId);
  assertActor(actor);
  assertDocumentPermission(actor);

  const id = assertSourceId(documentId, "documentId");
  const storage = options.storage ?? getStorageProvider();

  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);

    const [row] = await tx
      .select({ ...documentSelection, storageKey: billingDocuments.storageKey })
      .from(billingDocuments)
      .where(
        and(eq(billingDocuments.tenantId, tenantId), eq(billingDocuments.id, id)),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Billing document not found");

    try {
      await assertDocumentInvoiceScope(tx, tenantId, row.invoiceId, row.branchId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.internal("Failed to verify the billing document scope");
    }

    let bytes: Buffer;

    try {
      bytes = await storage.getObject(row.storageKey);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw AppError.notFound("Billing document file not found");
      }

      if (error instanceof StorageOperationError) {
        throw AppError.serviceUnavailable("Document storage is temporarily unavailable");
      }

      throw error;
    }

    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw AppError.internal("The stored billing document is empty");
    }

    recordBillingAudit(options.audit, "billing_document.downloaded", {
      tenantId,
      actorUserId: actor.userId,
      invoiceId: row.invoiceId,
      paymentId: row.paymentId ?? undefined,
      refundId: row.refundId ?? undefined,
      documentId: row.id,
      documentType: row.documentType,
    });

    const { storageKey: _key, ...document } = row;

    return { document, bytes };
  });
}
