import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { patientContacts } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { recordPatientAudit } from "./patient.audit.js";
import {
  isUuid,
  mapPatientWriteError,
  normalizeContactType,
  normalizeEmail,
  normalizePhone,
  requireLivePatient,
  requireMutablePatient,
} from "./patient.service.js";
import type {
  AddPatientContactInput,
  PatientActorContext,
  PatientContactDto,
  PatientContactType,
  UpdatePatientContactInput,
} from "./patient.types.js";

/**
 * Patient contact management service (Task 17.3).
 *
 * Policy decisions:
 * - The schema stores reachability per row: `phone`, `email`, or both. A "phone
 *   contact" is a row with `phone` set, an "email contact" one with `email` set;
 *   `contactType` records the purpose (MOBILE/HOME/WORK/GUARDIAN/OTHER).
 * - Exactly one contact ROW per patient may be primary (database partial unique
 *   index `patient_contacts_primary_unique`). That primary row can carry the
 *   patient's primary phone and primary email together; every other row is
 *   secondary. Marking a row primary clears the previous one inside the same
 *   transaction, so there is never a visible state with two primaries.
 * - Verification is never accepted from a caller. There is no verification
 *   workflow in this task, so new contacts start unverified and editing a phone
 *   or email resets the row to unverified because the verified value is gone.
 * - Identical phone numbers and email addresses (case-insensitive) are rejected
 *   per patient. They are not treated as global patient identities.
 */

interface ContactRow {
  readonly id: string;
  readonly contactType: PatientContactType;
  readonly phone: string | null;
  readonly email: string | null;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const contactSelection = {
  id: patientContacts.id,
  contactType: patientContacts.contactType,
  phone: patientContacts.phone,
  email: patientContacts.email,
  isPrimary: patientContacts.isPrimary,
  isVerified: patientContacts.isVerified,
  createdAt: patientContacts.createdAt,
  updatedAt: patientContacts.updatedAt,
};

/**
 * Verification is a trusted-backend concern. Rather than silently ignoring the
 * flag, any payload that carries it is refused so a caller cannot believe it
 * worked.
 */
function rejectVerificationFlags(input: object): void {
  const candidate = input as { isVerified?: unknown };

  if (candidate.isVerified !== undefined) {
    throw AppError.forbidden(
      "Contact verification is not client-controlled; use the verification workflow",
    );
  }
}

function normalizeOptionalPhone(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;

  return normalizePhone(value, "Contact phone");
}

function normalizeOptionalEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;

  return normalizeEmail(value, "Contact email");
}

async function loadContact(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  contactId: string,
): Promise<ContactRow> {
  if (!isUuid(contactId)) throw AppError.notFound("Contact not found");

  const [row] = await tx
    .select(contactSelection)
    .from(patientContacts)
    .where(
      and(
        eq(patientContacts.id, contactId),
        eq(patientContacts.patientId, patientId),
        eq(patientContacts.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Contact not found");

  return row;
}

/** Duplicate check for the resulting values, ignoring the row being edited. */
async function assertContactAvailable(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  phone: string | null,
  email: string | null,
  excludeContactId?: string,
): Promise<void> {
  const scope = and(
    eq(patientContacts.tenantId, tenantId),
    eq(patientContacts.patientId, patientId),
    excludeContactId === undefined ? undefined : ne(patientContacts.id, excludeContactId),
  );

  if (phone !== null) {
    const [existing] = await tx
      .select({ id: patientContacts.id })
      .from(patientContacts)
      .where(and(scope, eq(patientContacts.phone, phone)))
      .limit(1);

    if (existing) {
      throw AppError.conflict("This phone number is already recorded for this patient");
    }
  }

  if (email !== null) {
    const [existing] = await tx
      .select({ id: patientContacts.id })
      .from(patientContacts)
      .where(and(scope, eq(sql`lower(${patientContacts.email})`, email)))
      .limit(1);

    if (existing) {
      throw AppError.conflict("This email address is already recorded for this patient");
    }
  }
}

async function clearPrimaryContacts(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  excludeContactId?: string,
): Promise<void> {
  await tx
    .update(patientContacts)
    .set({ isPrimary: false })
    .where(
      and(
        eq(patientContacts.tenantId, tenantId),
        eq(patientContacts.patientId, patientId),
        eq(patientContacts.isPrimary, true),
        excludeContactId === undefined ? undefined : ne(patientContacts.id, excludeContactId),
      ),
    );
}

/** Adds a phone and/or email contact to a live patient. */
export async function addPatientContact(
  tenantId: string,
  patientId: string,
  input: AddPatientContactInput,
  actorContext: PatientActorContext,
): Promise<PatientContactDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      rejectVerificationFlags(input);
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const contactType = normalizeContactType(input.contactType);
      const phone = normalizeOptionalPhone(input.phone);
      const email = normalizeOptionalEmail(input.email);

      if (phone === null && email === null) {
        throw AppError.validation("A contact needs a phone number or an email address");
      }

      await assertContactAvailable(tx, tenantId, patientId, phone, email);

      const isPrimary = input.isPrimary ?? false;

      if (isPrimary) {
        await clearPrimaryContacts(tx, tenantId, patientId);
      }

      const [created] = await tx
        .insert(patientContacts)
        .values({
          tenantId,
          patientId,
          contactType,
          phone,
          email,
          isPrimary,
          // New contacts are always unverified; see rejectVerificationFlags.
          isVerified: false,
        })
        .returning(contactSelection);

      if (!created) throw AppError.internal("Failed to add patient contact");

      recordPatientAudit(actorContext.audit, "patient_contact.created", {
        tenantId,
        actorUserId: actorContext.userId,
        patientId,
        contactId: created.id,
      });

      return created;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/** Contacts of one live patient, primary first. */
export async function listPatientContacts(
  tenantId: string,
  patientId: string,
): Promise<PatientContactDto[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    await requireLivePatient(tx, tenantId, patientId);

    return tx
      .select(contactSelection)
      .from(patientContacts)
      .where(
        and(
          eq(patientContacts.tenantId, tenantId),
          eq(patientContacts.patientId, patientId),
        ),
      )
      .orderBy(desc(patientContacts.isPrimary), asc(patientContacts.createdAt));
  });
}

/**
 * Partial update. Changing a phone or email clears the verification flag,
 * because the previously verified value no longer exists; changing only the
 * purpose or primacy leaves verification untouched.
 */
export async function updatePatientContact(
  tenantId: string,
  patientId: string,
  contactId: string,
  input: UpdatePatientContactInput,
  actorContext: PatientActorContext,
): Promise<PatientContactDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      rejectVerificationFlags(input);
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const current = await loadContact(tx, tenantId, patientId, contactId);

      const contactType =
        input.contactType === undefined
          ? current.contactType
          : normalizeContactType(input.contactType);
      const phone =
        input.phone === undefined ? current.phone : normalizeOptionalPhone(input.phone);
      const email =
        input.email === undefined ? current.email : normalizeOptionalEmail(input.email);

      if (phone === null && email === null) {
        throw AppError.validation("A contact needs a phone number or an email address");
      }

      await assertContactAvailable(tx, tenantId, patientId, phone, email, contactId);

      const valueChanged = phone !== current.phone || email !== current.email;
      const isPrimary = input.isPrimary ?? current.isPrimary;

      if (isPrimary) {
        await clearPrimaryContacts(tx, tenantId, patientId, contactId);
      }

      const [updated] = await tx
        .update(patientContacts)
        .set({
          contactType,
          phone,
          email,
          isPrimary,
          // A changed value can never inherit the old verification.
          isVerified: valueChanged ? false : current.isVerified,
        })
        .where(
          and(
            eq(patientContacts.id, contactId),
            eq(patientContacts.patientId, patientId),
            eq(patientContacts.tenantId, tenantId),
          ),
        )        .returning(contactSelection);

      if (!updated) throw AppError.notFound("Contact not found");

      recordPatientAudit(actorContext.audit, "patient_contact.updated", {
        tenantId,
        actorUserId: actorContext.userId,
        patientId,
        contactId: updated.id,
        // Submitted field names only; values are never audited.
        fields: Object.keys(input),
      });

      return updated;
    });

  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Promotes one contact row to primary. The previous primary is demoted in the
 * same transaction, so the unique index never sees two primary rows.
 */
export async function setPrimaryPatientContact(
  tenantId: string,
  patientId: string,
  contactId: string,
  actorContext?: PatientActorContext,
): Promise<PatientContactDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const current = await loadContact(tx, tenantId, patientId, contactId);

      if (current.isPrimary) return current;

      await clearPrimaryContacts(tx, tenantId, patientId, contactId);

      const [updated] = await tx
        .update(patientContacts)
        .set({ isPrimary: true })
        .where(
          and(
            eq(patientContacts.id, contactId),
            eq(patientContacts.patientId, patientId),
            eq(patientContacts.tenantId, tenantId),
          ),
        )
        .returning(contactSelection);

      if (!updated) throw AppError.notFound("Contact not found");

      recordPatientAudit(actorContext?.audit, "patient_contact.primary_changed", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        contactId: updated.id,
      });

      return updated;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Deletes a contact row. `patient_contacts` has no soft-delete column, so this
 * is a physical delete of the contact only; the patient profile and its other
 * records are untouched. Repeated deletion reports the row as not found.
 */
export async function deletePatientContact(
  tenantId: string,
  patientId: string,
  contactId: string,
  actorContext: PatientActorContext,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await requireMutablePatient(tx, tenantId, patientId, actorContext);

    if (!isUuid(contactId)) throw AppError.notFound("Contact not found");

    const [deleted] = await tx
      .delete(patientContacts)
      .where(
        and(
          eq(patientContacts.id, contactId),
          eq(patientContacts.patientId, patientId),
          eq(patientContacts.tenantId, tenantId),
        ),
      )
      .returning({ id: patientContacts.id });

    if (!deleted) throw AppError.notFound("Contact not found");

    recordPatientAudit(actorContext.audit, "patient_contact.deleted", {
      tenantId,
      actorUserId: actorContext.userId,
      patientId,
      contactId: deleted.id,
    });
  });
}
