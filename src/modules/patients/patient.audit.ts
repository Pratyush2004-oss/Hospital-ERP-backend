import { logger } from "../../lib/logger.js";

/**
 * Patient audit sink (Task 17.7).
 *
 * The project has no audit table yet; the existing mechanism is the structured
 * logger, which is what the patient document service already used (Task 17.4).
 * This module is the single place that mechanism lives so profile, contact,
 * address, emergency-contact and document events share one event vocabulary
 * instead of growing parallel audit helpers.
 *
 * Privacy rules for details:
 * - identifiers only: tenant, actor, patient and child-record ids;
 * - a list of changed field NAMES, never their values;
 * - never a name, phone number, email, address, file name, signed URL,
 *   storage key or file content;
 * - never credentials of any kind.
 *
 * Audit must never fail a completed operation, so `recordPatientAudit` swallows
 * sink errors and logs a warning instead of propagating them.
 */

export type PatientAuditEvent =
  | "patient.created"
  | "patient.updated"
  | "patient.status_changed"
  | "patient.deleted"
  | "patient.account_linked"
  | "patient.account_unlinked"
  | "patient_contact.created"
  | "patient_contact.updated"
  | "patient_contact.primary_changed"
  | "patient_contact.deleted"
  | "patient_address.created"
  | "patient_address.updated"
  | "patient_address.primary_changed"
  | "patient_address.deleted"
  | "patient_emergency_contact.created"
  | "patient_emergency_contact.updated"
  | "patient_emergency_contact.deleted"
  | "patient_document.uploaded"
  | "patient_document.upload_failed"
  | "patient_document.upload_cleanup_failed"
  | "patient_document.storage_failed"
  | "patient_document.scan_failed"
  | "patient_document.rejected_infected"
  | "patient_document.download_url_issued"
  | "patient_document.soft_deleted";

/** Non-identifying audit context. See the privacy rules above. */
export interface PatientAuditDetails {
  readonly tenantId?: string;
  readonly actorUserId?: string | null;
  readonly patientId?: string;
  readonly contactId?: string;
  readonly addressId?: string;
  readonly emergencyContactId?: string;
  readonly documentId?: string;
  readonly storageProvider?: string;
  /** Names of the fields that changed, never their values. */
  readonly fields?: readonly string[];
  readonly from?: string;
  readonly to?: string;
}

export interface PatientAuditSink {
  record(event: PatientAuditEvent, details?: PatientAuditDetails): void;
}

/**
 * Default sink: one structured log line per event. The timestamp is added by
 * the logger; tenant, actor and target resource travel in `details`.
 */
export const loggerAuditSink: PatientAuditSink = {
  record(event, details) {
    logger.info({ event, ...details }, "patient audit event");
  },
};

export function resolvePatientAuditSink(sink?: PatientAuditSink): PatientAuditSink {
  return sink ?? loggerAuditSink;
}

/** Records an event, never letting an audit failure break the caller. */
export function recordPatientAudit(
  sink: PatientAuditSink | undefined,
  event: PatientAuditEvent,
  details: PatientAuditDetails,
): void {
  try {
    resolvePatientAuditSink(sink).record(event, details);
  } catch {
    logger.warn({ event }, "patient audit sink failed");
  }
}
