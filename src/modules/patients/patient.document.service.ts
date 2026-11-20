import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { env } from "../../config/env.js";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { patientDocuments } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { validateDocumentUpload } from "../../lib/storage/file-validation.js";
import { getStorageProvider } from "../../lib/storage/index.js";
import type { StorageProvider } from "../../lib/storage/storage.types.js";
import { recordPatientAudit, resolvePatientAuditSink } from "./patient.audit.js";
import { assertActiveMembership, isUuid, requireLivePatient, requireMutablePatient } from "./patient.service.js";
import type {
  PatientDocumentActor,
  PatientDocumentAuditSink,
  PatientDocumentDownloadUrl,
  PatientDocumentDto,
  PatientDocumentScanStatus,
  PatientDocumentScanner,
  UploadPatientDocumentInput,
} from "./patient.document.types.js";

/**
 * Patient document service (Task 17.4).
 *
 * Policy decisions:
 * - PostgreSQL stores metadata only. File bytes go through the storage
 *   abstraction, and `storage_key` never leaves this module: callers receive a
 *   short-lived signed URL instead.
 * - The tenant id comes from the verified caller context. Every statement
 *   repeats `tenant_id` and `patient_id` on top of RLS, so a document can only
 *   be reached through the patient that owns it.
 * - Permissions are enforced here, not only in a future route: reading or
 *   downloading requires `patient:document:read`, uploading requires
 *   `patient:document:upload`, and soft deletion requires
 *   `patient:document:delete` (Task 17.7). Generic patient permissions never
 *   grant document access. An actor without a resolved permission set is
 *   denied.
 * - The object key is server-generated (`tenants/<tenant>/patients/<patient>/<uuid>.<ext>`).
 *   Client filenames are metadata that has already been sanitised, never a path.
 * - Uploads are validated against an extension/MIME/signature allow-list; a
 *   malware scanner is an optional injection point and is not configured. New
 *   rows therefore stay `PENDING` and are never described as clean.
 * - Deletion is a soft delete of the metadata row. The stored object is kept:
 *   no retention policy exists that would allow permanent removal. A future
 *   retention job can delete objects for rows whose `deleted_at` is old enough.
 * - If the database insert or commit fails after an object was written, the
 *   object is removed again so a failed upload leaves no orphaned bytes.
 */

/**
 * Document access uses dedicated permissions (Task 17.7). Generic
 * `patient:read` would let every clinical/administrative role download identity
 * proofs and insurance cards; document access is a separate, explicit grant.
 */
/** Listing metadata or signing a download. */
const DOCUMENT_READ_PERMISSION = "patient:document:read";
/** Attaching a document. */
const DOCUMENT_UPLOAD_PERMISSION = "patient:document:upload";
/** Soft-deleting document metadata. */
const DOCUMENT_DELETE_PERMISSION = "patient:document:delete";

const documentSelection = {
  id: patientDocuments.id,
  patientId: patientDocuments.patientId,
  documentType: patientDocuments.documentType,
  fileName: patientDocuments.fileName,
  mimeType: patientDocuments.mimeType,
  fileSize: patientDocuments.fileSize,
  scanStatus: patientDocuments.scanStatus,
  uploadedBy: patientDocuments.uploadedBy,
  createdAt: patientDocuments.createdAt,
};

interface DocumentRow {
  readonly id: string;
  readonly patientId: string;
  readonly documentType: PatientDocumentDto["documentType"];
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly scanStatus: PatientDocumentScanStatus;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
}

/** Injected collaborators, so tests can use an in-memory provider. */
export interface PatientDocumentServiceOptions {
  readonly storage?: StorageProvider;
  /** Optional malware scanner. Unset means `PENDING`; see the type contract. */
  readonly scanner?: PatientDocumentScanner;
  readonly audit?: PatientDocumentAuditSink;
  readonly maxFileSizeBytes?: number;
  readonly signedUrlTtlSeconds?: number;
  /** Overrides the UUID object name; only used by tests to force collisions. */
  readonly generateObjectId?: () => string;
}

/**
 * Rejects a missing or malformed tenant scope before any storage or database
 * work happens. Routes derive this value from the verified session.
 */
function assertTenantContext(tenantId: string): void {
  if (typeof tenantId !== "string" || !isUuid(tenantId)) {
    throw AppError.forbidden("A verified tenant context is required");
  }
}

function assertPermission(
  actor: PatientDocumentActor,
  permission: string,
  message: string,
): void {
  if (!actor.permissions?.has(permission)) {
    throw AppError.forbidden(message);
  }
}

function toDto(row: DocumentRow): PatientDocumentDto {
  return {
    id: row.id,
    patientId: row.patientId,
    documentType: row.documentType,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    scanStatus: row.scanStatus,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

/**
 * Server-generated object key. The tenant and patient segments keep objects
 * grouped for future retention/accounting work; the filename and the UUID are
 * the only unpredictable parts that identify one object.
 */
function buildStorageKey(
  tenantId: string,
  patientId: string,
  extension: string,
  objectId: string,
): string {
  return `tenants/${tenantId}/patients/${patientId}/${objectId}.${extension}`;
}

function resolveObjectId(options: PatientDocumentServiceOptions): string {
  const candidate = options.generateObjectId ? options.generateObjectId() : randomUUID();

  if (!isUuid(candidate)) {
    throw AppError.internal("Failed to generate a storage object name");
  }

  return candidate.toLowerCase();
}

/**
 * Optional scanner integration. Returning `INFECTED` refuses the upload before
 * anything is stored; a scanner outage also refuses it rather than storing an
 * unchecked file. With no scanner configured the status is `PENDING`, which is
 * an honest "not scanned" value, not a clean bill of health.
 */
async function resolveScanStatus(
  scanner: PatientDocumentScanner | undefined,
  data: Buffer,
  mimeType: string,
  audit: PatientDocumentAuditSink,
  provider: string,
): Promise<PatientDocumentScanStatus> {
  if (scanner === undefined) return "PENDING";

  try {
    return await scanner.scan({ data, mimeType });
  } catch {
    recordPatientAudit(audit, "patient_document.scan_failed", { storageProvider: provider });
    throw AppError.serviceUnavailable("Document scanning is temporarily unavailable");
  }
}

async function loadDocument(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  documentId: string,
): Promise<DocumentRow> {
  if (!isUuid(documentId)) throw AppError.notFound("Document not found");

  const [row] = await tx
    .select(documentSelection)
    .from(patientDocuments)
    .where(
      and(
        eq(patientDocuments.id, documentId),
        eq(patientDocuments.patientId, patientId),
        eq(patientDocuments.tenantId, tenantId),
        isNull(patientDocuments.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Document not found");

  return row;
}

/**
 * Validates and stores one patient document.
 *
 * Order matters: permission and file validation happen before the transaction;
 * membership, patient ownership and mutable status are checked before an object
 * is written. Only after the object exists is the metadata row inserted, and a
 * failure after the write triggers compensating removal.
 */
export async function uploadPatientDocument(
  tenantId: string,
  patientId: string,
  input: UploadPatientDocumentInput,
  actor: PatientDocumentActor,
  options: PatientDocumentServiceOptions = {},
): Promise<PatientDocumentDto> {
  assertTenantContext(tenantId);
  assertPermission(
    actor,
    DOCUMENT_UPLOAD_PERMISSION,
    "You do not have permission to upload patient documents",
  );

  const storage = options.storage ?? getStorageProvider();
  const audit = resolvePatientAuditSink(options.audit);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? env.STORAGE_MAX_FILE_SIZE_BYTES;

  // Pure validation: extension allow-list, MIME match, magic-byte signature and
  // the configurable size ceiling. Nothing is written on failure.
  const validated = validateDocumentUpload(
    { fileName: input.fileName, mimeType: input.mimeType, data: input.data },
    maxFileSizeBytes,
  );

  let storageKey: string | null = null;
  let stored = false;

  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actor);
      await requireMutablePatient(tx, tenantId, patientId, actor);

      const scanStatus = await resolveScanStatus(
        options.scanner,
        input.data,
        validated.mimeType,
        audit,
        storage.name,
      );

      if (scanStatus === "INFECTED") {
        recordPatientAudit(audit, "patient_document.rejected_infected", {
          tenantId,
          actorUserId: actor.userId,
          patientId,
          storageProvider: storage.name,
        });
        throw AppError.validation("The uploaded file failed a security scan");
      }

      const key = buildStorageKey(
        tenantId,
        patientId,
        validated.extension,
        resolveObjectId(options),
      );

      storageKey = key;

      try {
        await storage.putObject({
          key,
          body: input.data,
          contentType: validated.mimeType,
        });
      } catch {
        recordPatientAudit(audit, "patient_document.storage_failed", {
          tenantId,
          actorUserId: actor.userId,
          patientId,
          storageProvider: storage.name,
        });
        throw AppError.serviceUnavailable("Document storage is temporarily unavailable");
      }

      stored = true;

      const [created] = await tx
        .insert(patientDocuments)
        .values({
          tenantId,
          patientId,
          documentType: input.documentType,
          fileName: validated.fileName,
          storageKey: key,
          mimeType: validated.mimeType,
          fileSize: validated.fileSize,
          uploadedBy: actor.userId,
          scanStatus,
        })
        .returning(documentSelection);

      if (!created) {
        throw AppError.internal("Failed to save the patient document");
      }

      recordPatientAudit(audit, "patient_document.uploaded", {
        tenantId,
        actorUserId: actor.userId,
        patientId,
        documentId: created.id,
        storageProvider: storage.name,
      });

      return toDto(created);
    });
  } catch (error) {
    if (stored && storageKey !== null) {
      try {
        await storage.deleteObject(storageKey);
      } catch {
        recordPatientAudit(audit, "patient_document.upload_cleanup_failed", {
          storageProvider: storage.name,
        });
      }
    }

    throw error;
  }
}

/**
 * Lists live documents of one patient, newest first. Soft-deleted metadata is
 * excluded; the storage objects are retained until a retention policy allows
 * removal.
 */
export async function getPatientDocuments(
  tenantId: string,
  patientId: string,
  actor: PatientDocumentActor,
): Promise<PatientDocumentDto[]> {
  assertTenantContext(tenantId);
  assertPermission(
    actor,
    DOCUMENT_READ_PERMISSION,
    "You do not have permission to view patient documents",
  );

  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);
    await requireLivePatient(tx, tenantId, patientId);

    const rows = await tx
      .select(documentSelection)
      .from(patientDocuments)
      .where(
        and(
          eq(patientDocuments.tenantId, tenantId),
          eq(patientDocuments.patientId, patientId),
          isNull(patientDocuments.deletedAt),
        ),
      )
      .orderBy(desc(patientDocuments.createdAt), asc(patientDocuments.id));

    return rows.map(toDto);
  });
}

/** Metadata of one live document, scoped to its patient and tenant. */
export async function getPatientDocumentById(
  tenantId: string,
  patientId: string,
  documentId: string,
  actor: PatientDocumentActor,
): Promise<PatientDocumentDto> {
  assertTenantContext(tenantId);
  assertPermission(
    actor,
    DOCUMENT_READ_PERMISSION,
    "You do not have permission to view patient documents",
  );

  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);
    await requireLivePatient(tx, tenantId, patientId);

    return toDto(await loadDocument(tx, tenantId, patientId, documentId));
  });
}

/**
 * Builds a short-lived signed download URL after re-checking scope, membership,
 * patient ownership and the document/patient/tenant link. The storage key is
 * not returned; only the provider-signed URL is.
 */
export async function generatePatientDocumentDownloadUrl(
  tenantId: string,
  patientId: string,
  documentId: string,
  actor: PatientDocumentActor,
  options: Pick<PatientDocumentServiceOptions, "storage" | "audit" | "signedUrlTtlSeconds"> = {},
): Promise<PatientDocumentDownloadUrl> {
  assertTenantContext(tenantId);
  assertPermission(
    actor,
    DOCUMENT_READ_PERMISSION,
    "You do not have permission to download patient documents",
  );

  const storage = options.storage ?? getStorageProvider();
  const audit = resolvePatientAuditSink(options.audit);
  const expiresInSeconds = options.signedUrlTtlSeconds ?? env.STORAGE_SIGNED_URL_TTL_SECONDS;

  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);
    await requireLivePatient(tx, tenantId, patientId);

    const document = await loadDocument(tx, tenantId, patientId, documentId);

    // The storage key is loaded only here, inside the transaction, after every
    // ownership and permission check has passed.
    const [row] = await tx
      .select({ storageKey: patientDocuments.storageKey })
      .from(patientDocuments)
      .where(
        and(
          eq(patientDocuments.id, document.id),
          eq(patientDocuments.patientId, patientId),
          eq(patientDocuments.tenantId, tenantId),
          isNull(patientDocuments.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Document not found");

    let signed: Awaited<ReturnType<StorageProvider["createSignedDownloadUrl"]>>;

    try {
      signed = await storage.createSignedDownloadUrl({
        key: row.storageKey,
        fileName: document.fileName,
        contentType: document.mimeType,
        expiresInSeconds,
      });
    } catch {
      recordPatientAudit(audit, "patient_document.storage_failed", {
        tenantId,
        actorUserId: actor.userId,
        patientId,
        documentId: document.id,
        storageProvider: storage.name,
      });
      throw AppError.serviceUnavailable("Document storage is temporarily unavailable");
    }

    recordPatientAudit(audit, "patient_document.download_url_issued", {
      tenantId,
      actorUserId: actor.userId,
      patientId,
      documentId: document.id,
      storageProvider: storage.name,
    });

    return { url: signed.url, expiresAt: signed.expiresAt };
  });
}

/**
 * Soft deletes document metadata. The object is intentionally not removed:
 * there is no approved retention policy, and the metadata row is the audit
 * record that the object existed. A later retention job can reconcile objects
 * whose `deleted_at` is past the policy window.
 */
export async function deletePatientDocument(
  tenantId: string,
  patientId: string,
  documentId: string,
  actor: PatientDocumentActor,
  options: Pick<PatientDocumentServiceOptions, "audit"> = {},
): Promise<void> {
  assertTenantContext(tenantId);
  assertPermission(
    actor,
    DOCUMENT_DELETE_PERMISSION,
    "You do not have permission to delete patient documents",
  );

  const audit = resolvePatientAuditSink(options.audit);

  await withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actor);
    await requireMutablePatient(tx, tenantId, patientId, actor);

    const [deleted] = await tx
      .update(patientDocuments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(patientDocuments.id, documentId),
          eq(patientDocuments.patientId, patientId),
          eq(patientDocuments.tenantId, tenantId),
          isNull(patientDocuments.deletedAt),
        ),
      )
      .returning({ id: patientDocuments.id });

    if (!deleted) throw AppError.notFound("Document not found");

    recordPatientAudit(audit, "patient_document.soft_deleted", {
      tenantId,
      actorUserId: actor.userId,
      patientId,
      documentId: deleted.id,
    });
  });
}
