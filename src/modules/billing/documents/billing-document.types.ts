import type { BillingAuditSink } from "../billing.audit.js";
import type { StorageProvider } from "../../../lib/storage/storage.types.js";

/**
 * Billing document contracts (Phase 19.8.1).
 *
 * A generated document is a rendering of persisted financial records only. The
 * caller supplies identifiers and an authenticated actor; every amount, line
 * item, patient, branch and number comes from the database.
 */

/** Mirrors the `billing_document_type` database enum. */
export const BILLING_DOCUMENT_TYPES = [
  "INVOICE",
  "PAYMENT_RECEIPT",
  "CREDIT_NOTE",
] as const;

export type BillingDocumentType = (typeof BILLING_DOCUMENT_TYPES)[number];

export interface BillingDocumentActor {
  readonly userId: string;
  /** Resolved RBAC permissions; document access default-denies when absent. */
  readonly permissions: ReadonlySet<string>;
}

/** Metadata returned to callers. `storageKey` is internal and never returned. */
export interface BillingDocumentDto {
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
}

/** Optional branding supplied by a trusted caller; never fetched from a URL. */
export interface BillingDocumentBranding {
  readonly logo?: Buffer;
}

/**
 * Renders a document model to PDF bytes. The default implementation uses
 * PDFKit; tests inject a deterministic or failing renderer.
 */
export interface BillingDocumentRenderer {
  render(model: import("./billing-document.model.js").BillingDocumentModel): Promise<Buffer>;
}

export interface BillingDocumentServiceOptions extends BillingDocumentBranding {
  readonly storage?: StorageProvider;
  readonly renderer?: BillingDocumentRenderer;
  readonly audit?: BillingAuditSink;
  /** Overrides the generated object id; used by tests to force collisions. */
  readonly generateObjectId?: () => string;
  /** Fixed generation timestamp; used by tests for deterministic layout. */
  readonly now?: () => Date;
}
