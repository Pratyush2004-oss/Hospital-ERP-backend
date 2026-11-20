import { and, asc, eq } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { patientEmergencyContacts } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { recordPatientAudit } from "./patient.audit.js";
import {
  isUuid,
  mapPatientWriteError,
  normalizeEmail,
  normalizeOptionalText,
  normalizePhone,
  requireLivePatient,
  requireMutablePatient,
} from "./patient.service.js";
import type {
  AddPatientEmergencyContactInput,
  PatientActorContext,
  PatientEmergencyContactDto,
  UpdatePatientEmergencyContactInput,
} from "./patient.types.js";

/**
 * Emergency contact management service (Task 17.3).
 *
 * Emergency contacts are plain tenant-scoped records, not patients and not
 * global users: name, relationship, phone and optional email are validated
 * here (the database only enforces presence and length). A patient may hold
 * several, and none is "primary" - there is no such concept in the schema.
 *
 * `patient_emergency_contacts` has no soft-delete column, so deletion is a
 * physical removal of the contact row only.
 */

interface EmergencyContactRow {
  readonly id: string;
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const emergencyContactSelection = {
  id: patientEmergencyContacts.id,
  name: patientEmergencyContacts.name,
  relationship: patientEmergencyContacts.relationship,
  phone: patientEmergencyContacts.phone,
  email: patientEmergencyContacts.email,
  createdAt: patientEmergencyContacts.createdAt,
  updatedAt: patientEmergencyContacts.updatedAt,
};

function requireName(value: string | null | undefined): string {
  const name = normalizeOptionalText(value, "Emergency contact name", 200);

  if (name === null) {
    throw AppError.validation("Emergency contact name is required");
  }

  return name;
}

function requireRelationship(value: string | null | undefined): string {
  const relationship = normalizeOptionalText(
    value,
    "Emergency contact relationship",
    60,
  );

  if (relationship === null) {
    throw AppError.validation("Emergency contact relationship is required");
  }

  return relationship;
}

function requirePhone(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw AppError.validation("Emergency contact phone is required");
  }

  return normalizePhone(value, "Emergency contact phone");
}

function optionalEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;

  return normalizeEmail(value, "Emergency contact email");
}

async function loadEmergencyContact(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  contactId: string,
): Promise<EmergencyContactRow> {
  if (!isUuid(contactId)) throw AppError.notFound("Emergency contact not found");

  const [row] = await tx
    .select(emergencyContactSelection)
    .from(patientEmergencyContacts)
    .where(
      and(
        eq(patientEmergencyContacts.id, contactId),
        eq(patientEmergencyContacts.patientId, patientId),
        eq(patientEmergencyContacts.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Emergency contact not found");

  return row;
}

export async function addPatientEmergencyContact(
  tenantId: string,
  patientId: string,
  input: AddPatientEmergencyContactInput,
  actorContext?: PatientActorContext,
): Promise<PatientEmergencyContactDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const [created] = await tx
        .insert(patientEmergencyContacts)
        .values({
          tenantId,
          patientId,
          name: requireName(input.name),
          relationship: requireRelationship(input.relationship),
          phone: requirePhone(input.phone),
          email: optionalEmail(input.email),
        })
        .returning(emergencyContactSelection);

      if (!created) throw AppError.internal("Failed to add emergency contact");

      recordPatientAudit(actorContext?.audit, "patient_emergency_contact.created", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        emergencyContactId: created.id,
      });

      return created;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/** Emergency contacts of one live patient, oldest first. */
export async function listPatientEmergencyContacts(
  tenantId: string,
  patientId: string,
): Promise<PatientEmergencyContactDto[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    await requireLivePatient(tx, tenantId, patientId);

    return tx
      .select(emergencyContactSelection)
      .from(patientEmergencyContacts)
      .where(
        and(
          eq(patientEmergencyContacts.tenantId, tenantId),
          eq(patientEmergencyContacts.patientId, patientId),
        ),
      )
      .orderBy(asc(patientEmergencyContacts.createdAt));
  });
}

/** Partial update; required fields may not be emptied. */
export async function updatePatientEmergencyContact(
  tenantId: string,
  patientId: string,
  contactId: string,
  input: UpdatePatientEmergencyContactInput,
  actorContext?: PatientActorContext,
): Promise<PatientEmergencyContactDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const current = await loadEmergencyContact(tx, tenantId, patientId, contactId);

      const [updated] = await tx
        .update(patientEmergencyContacts)
        .set({
          name: input.name === undefined ? current.name : requireName(input.name),
          relationship:
            input.relationship === undefined
              ? current.relationship
              : requireRelationship(input.relationship),
          phone: input.phone === undefined ? current.phone : requirePhone(input.phone),
          email:
            input.email === undefined ? current.email : optionalEmail(input.email),
        })
        .where(
          and(
            eq(patientEmergencyContacts.id, contactId),
            eq(patientEmergencyContacts.patientId, patientId),
            eq(patientEmergencyContacts.tenantId, tenantId),
          ),
        )
        .returning(emergencyContactSelection);

      if (!updated) throw AppError.notFound("Emergency contact not found");

      recordPatientAudit(actorContext?.audit, "patient_emergency_contact.updated", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        emergencyContactId: updated.id,
        // Submitted field names only; contact values are never audited.
        fields: Object.keys(input),
      });

      return updated;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Deletes one emergency contact. Physical delete, because the table has no
 * soft-delete column; repeated deletion reports the row as not found.
 */
export async function deletePatientEmergencyContact(
  tenantId: string,
  patientId: string,
  contactId: string,
  actorContext?: PatientActorContext,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await requireMutablePatient(tx, tenantId, patientId, actorContext);

    if (!isUuid(contactId)) throw AppError.notFound("Emergency contact not found");

    const [deleted] = await tx
      .delete(patientEmergencyContacts)
      .where(
        and(
          eq(patientEmergencyContacts.id, contactId),
          eq(patientEmergencyContacts.patientId, patientId),
          eq(patientEmergencyContacts.tenantId, tenantId),
        ),
      )
      .returning({ id: patientEmergencyContacts.id });

    if (!deleted) throw AppError.notFound("Emergency contact not found");

    recordPatientAudit(actorContext?.audit, "patient_emergency_contact.deleted", {
      tenantId,
      actorUserId: actorContext?.userId ?? null,
      patientId,
      emergencyContactId: deleted.id,
    });
  });
}
