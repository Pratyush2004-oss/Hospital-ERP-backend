import { and, asc, desc, eq, ne } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import { patientAddresses } from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { recordPatientAudit } from "./patient.audit.js";
import {
  isUuid,
  mapPatientWriteError,
  normalizeAddressType,
  normalizeCountry,
  normalizeOptionalText,
  requireLivePatient,
  requireMutablePatient,
} from "./patient.service.js";
import type {
  AddPatientAddressInput,
  PatientActorContext,
  PatientAddressDto,
  PatientAddressType,
  UpdatePatientAddressInput,
} from "./patient.types.js";

/**
 * Patient address management service (Task 17.3).
 *
 * Policy decisions:
 * - A patient may hold several addresses (home, work, other). Uniqueness is per
 *   address category only for the primary flag: at most one primary HOME, one
 *   primary WORK and one primary OTHER address, enforced by the partial unique
 *   index `patient_addresses_primary_unique`.
 * - Adding a primary address demotes the previous primary of the same category
 *   in the same transaction. Changing the category of a row that is already
 *   primary is refused when the target category has a primary, instead of
 *   silently demoting another address.
 * - `patient_addresses` has no soft-delete column, so deletion is a physical
 *   removal of the address row only. Addresses are not referenced by any
 *   operational record yet; when they are, that reference must add its own
 *   guard before deletion is exposed.
 */

interface AddressRow {
  readonly id: string;
  readonly addressType: PatientAddressType;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const addressSelection = {
  id: patientAddresses.id,
  addressType: patientAddresses.addressType,
  addressLine1: patientAddresses.addressLine1,
  addressLine2: patientAddresses.addressLine2,
  city: patientAddresses.city,
  state: patientAddresses.state,
  postalCode: patientAddresses.postalCode,
  country: patientAddresses.country,
  isPrimary: patientAddresses.isPrimary,
  createdAt: patientAddresses.createdAt,
  updatedAt: patientAddresses.updatedAt,
};

async function loadAddress(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  addressId: string,
): Promise<AddressRow> {
  if (!isUuid(addressId)) throw AppError.notFound("Address not found");

  const [row] = await tx
    .select(addressSelection)
    .from(patientAddresses)
    .where(
      and(
        eq(patientAddresses.id, addressId),
        eq(patientAddresses.patientId, patientId),
        eq(patientAddresses.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Address not found");

  return row;
}

async function clearPrimaryAddresses(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  addressType: PatientAddressType,
  excludeAddressId?: string,
): Promise<void> {
  await tx
    .update(patientAddresses)
    .set({ isPrimary: false })
    .where(
      and(
        eq(patientAddresses.tenantId, tenantId),
        eq(patientAddresses.patientId, patientId),
        eq(patientAddresses.addressType, addressType),
        eq(patientAddresses.isPrimary, true),
        excludeAddressId === undefined ? undefined : ne(patientAddresses.id, excludeAddressId),
      ),
    );
}

async function hasOtherPrimaryAddress(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  addressType: PatientAddressType,
  excludeAddressId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: patientAddresses.id })
    .from(patientAddresses)
    .where(
      and(
        eq(patientAddresses.tenantId, tenantId),
        eq(patientAddresses.patientId, patientId),
        eq(patientAddresses.addressType, addressType),
        eq(patientAddresses.isPrimary, true),
        excludeAddressId === undefined ? undefined : ne(patientAddresses.id, excludeAddressId),
      ),
    )
    .limit(1);

  return row !== undefined;
}

function requireAddressLine1(value: string | null | undefined): string {
  const line1 = normalizeOptionalText(value, "Address line 1", 255);

  if (line1 === null) {
    throw AppError.validation("Address line 1 is required");
  }

  return line1;
}

/** Adds one address; a primary address replaces the primary of that category. */
export async function addPatientAddress(
  tenantId: string,
  patientId: string,
  input: AddPatientAddressInput,
  actorContext?: PatientActorContext,
): Promise<PatientAddressDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const addressType = normalizeAddressType(input.addressType);
      const addressLine1 = requireAddressLine1(input.addressLine1);
      const isPrimary = input.isPrimary ?? false;

      if (isPrimary) {
        await clearPrimaryAddresses(tx, tenantId, patientId, addressType);
      }

      const [created] = await tx
        .insert(patientAddresses)
        .values({
          tenantId,
          patientId,
          addressType,
          addressLine1,
          addressLine2: normalizeOptionalText(input.addressLine2, "Address line 2", 255),
          city: normalizeOptionalText(input.city, "City", 120),
          state: normalizeOptionalText(input.state, "State", 120),
          postalCode: normalizeOptionalText(input.postalCode, "Postal code", 20),
          country: normalizeCountry(input.country),
          isPrimary,
        })
        .returning(addressSelection);

      if (!created) throw AppError.internal("Failed to add patient address");

      recordPatientAudit(actorContext?.audit, "patient_address.created", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        addressId: created.id,
      });

      return created;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/** Addresses of one live patient, primary first. */
export async function listPatientAddresses(
  tenantId: string,
  patientId: string,
): Promise<PatientAddressDto[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    await requireLivePatient(tx, tenantId, patientId);

    return tx
      .select(addressSelection)
      .from(patientAddresses)
      .where(
        and(
          eq(patientAddresses.tenantId, tenantId),
          eq(patientAddresses.patientId, patientId),
        ),
      )
      .orderBy(desc(patientAddresses.isPrimary), asc(patientAddresses.createdAt));
  });
}

/** Partial update; the resulting row is validated as a whole. */
export async function updatePatientAddress(
  tenantId: string,
  patientId: string,
  addressId: string,
  input: UpdatePatientAddressInput,
  actorContext?: PatientActorContext,
): Promise<PatientAddressDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const current = await loadAddress(tx, tenantId, patientId, addressId);

      const addressType =
        input.addressType === undefined
          ? current.addressType
          : normalizeAddressType(input.addressType);
      const addressLine1 =
        input.addressLine1 === undefined
          ? current.addressLine1
          : requireAddressLine1(input.addressLine1);
      const isPrimary = input.isPrimary ?? current.isPrimary;
      const typeChanged = addressType !== current.addressType;

      if (isPrimary && typeChanged) {
        const occupied = await hasOtherPrimaryAddress(
          tx,
          tenantId,
          patientId,
          addressType,
          addressId,
        );

        if (occupied) {
          throw AppError.conflict(
            `Another ${addressType} address is already marked primary`,
          );
        }
      }

      if (isPrimary && !current.isPrimary) {
        await clearPrimaryAddresses(tx, tenantId, patientId, addressType, addressId);
      }

      const [updated] = await tx
        .update(patientAddresses)
        .set({
          addressType,
          addressLine1,
          addressLine2:
            input.addressLine2 === undefined
              ? current.addressLine2
              : normalizeOptionalText(input.addressLine2, "Address line 2", 255),
          city:
            input.city === undefined
              ? current.city
              : normalizeOptionalText(input.city, "City", 120),
          state:
            input.state === undefined
              ? current.state
              : normalizeOptionalText(input.state, "State", 120),
          postalCode:
            input.postalCode === undefined
              ? current.postalCode
              : normalizeOptionalText(input.postalCode, "Postal code", 20),
          country:
            input.country === undefined ? current.country : normalizeCountry(input.country),
          isPrimary,
        })
        .where(
          and(
            eq(patientAddresses.id, addressId),
            eq(patientAddresses.patientId, patientId),
            eq(patientAddresses.tenantId, tenantId),
          ),
        )
        .returning(addressSelection);

      if (!updated) throw AppError.notFound("Address not found");

      recordPatientAudit(actorContext?.audit, "patient_address.updated", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        addressId: updated.id,
        // Submitted field names only; address values are never audited.
        fields: Object.keys(input),
      });

      return updated;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/** Promotes one address to primary within its category. */
export async function setPrimaryPatientAddress(
  tenantId: string,
  patientId: string,
  addressId: string,
  actorContext?: PatientActorContext,
): Promise<PatientAddressDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await requireMutablePatient(tx, tenantId, patientId, actorContext);

      const current = await loadAddress(tx, tenantId, patientId, addressId);

      if (current.isPrimary) return current;

      await clearPrimaryAddresses(
        tx,
        tenantId,
        patientId,
        current.addressType,
        addressId,
      );

      const [updated] = await tx
        .update(patientAddresses)
        .set({ isPrimary: true })
        .where(
          and(
            eq(patientAddresses.id, addressId),
            eq(patientAddresses.patientId, patientId),
            eq(patientAddresses.tenantId, tenantId),
          ),
        )
        .returning(addressSelection);

      if (!updated) throw AppError.notFound("Address not found");

      recordPatientAudit(actorContext?.audit, "patient_address.primary_changed", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        addressId: updated.id,
      });

      return updated;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Deletes one address row. Addresses have no soft-delete column, so this is a
 * physical delete; the patient profile and other addresses are untouched.
 * Repeated deletion reports the row as not found.
 */
export async function deletePatientAddress(
  tenantId: string,
  patientId: string,
  addressId: string,
  actorContext?: PatientActorContext,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await requireMutablePatient(tx, tenantId, patientId, actorContext);

    if (!isUuid(addressId)) throw AppError.notFound("Address not found");

    const [deleted] = await tx
      .delete(patientAddresses)
      .where(
        and(
          eq(patientAddresses.id, addressId),
          eq(patientAddresses.patientId, patientId),
          eq(patientAddresses.tenantId, tenantId),
        ),
      )
      .returning({ id: patientAddresses.id });

    if (!deleted) throw AppError.notFound("Address not found");

    recordPatientAudit(actorContext?.audit, "patient_address.deleted", {
      tenantId,
      actorUserId: actorContext?.userId ?? null,
      patientId,
      addressId: deleted.id,
    });
  });
}
