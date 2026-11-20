/**
 * Patient document service types (Task 17.4).
 *
 * Service inputs and outputs only: HTTP routes, controllers and multipart
 * parsing are deliberately out of scope. Document metadata crosses this
 * boundary, never file bytes on the way out and never a storage key, because a
 * caller must obtain a short-lived signed URL instead.
 */

import type { PatientAuditDetails, PatientAuditEvent, PatientAuditSink } from "./patient.audit.js";
import type { PatientActorContext } from "./patient.types.js";

/** Mirrors the `patient_document_type` database enum. */
export const PATIENT_DOCUMENT_TYPES = [
  "IDENTITY_PROOF",
  "INSURANCE",
  "REFERRAL",
  "MEDICAL_HISTORY",
  "CONSENT",
  "OTHER",
] as const;

export type PatientDocumentType = (typeof PATIENT_DOCUMENT_TYPES)[number];

/** Mirrors the `patient_document_scan_status` database enum. */
export type PatientDocumentScanStatus = "PENDING" | "CLEAN" | "INFECTED" | "FAILED";

/**
 * Metadata returned to callers. It deliberately omits `storageKey`: a storage
 * path is internal and must never become a document identifier or URL.
 */
export interface PatientDocumentDto {
  readonly id: string;
  readonly patientId: string;
  readonly documentType: PatientDocumentType;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly scanStatus: PatientDocumentScanStatus;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
}

/** Untrusted upload input. `data` is the raw buffer after multipart parsing. */
export interface UploadPatientDocumentInput {
  readonly documentType: PatientDocumentType;
  readonly fileName: string;
  readonly mimeType: string;
  readonly data: Buffer;
}

/** Result of authorizing and signing one download. */
export interface PatientDocumentDownloadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * Malware scanner integration point.
 *
 * No scanner is configured in this task, so uploads are stored with `PENDING`
 * and are never reported as clean. A future adapter may be synchronous (as
 * this interface assumes) or move to an asynchronous worker that updates
 * `scan_status` after upload; either way the interface stays here rather than
 * inside the service.
 */
export interface PatientDocumentScanner {
  scan(input: {
    readonly data: Buffer;
    readonly mimeType: string;
  }): Promise<"CLEAN" | "INFECTED">;
}

/**
 * Audit types are the shared patient audit vocabulary, narrowed to document
 * events. Task 17.7 moved the logger sink into `patient.audit.ts` so profile,
 * child-record and document operations use one mechanism instead of parallel
 * ones. Details remain identifiers only: no filename, signed URL, storage key,
 * file content or patient-identifying value is ever recorded.
 */
export type PatientDocumentAuditDetails = PatientAuditDetails;
export type PatientDocumentAuditEvent = Extract<PatientAuditEvent, `patient_document.${string}`>;
export type PatientDocumentAuditSink = PatientAuditSink;

export interface PatientDocumentActor extends PatientActorContext {
  /** Resolved RBAC permissions; documents default-deny when absent. */
  readonly permissions: ReadonlySet<string>;
}
