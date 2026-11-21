import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../database/client.js";
import {
  withPlatformTransaction,
  withTenantTransaction,
  type DbExecutor,
} from "../../database/context.js";
import {
  patientContacts,
  patientProfiles,
  tenants,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { getPublicUser, registerUser, type PublicUser } from "../auth/auth.service.js";
import type {
  LinkPatientAccountInput,
  PublicPatientRegistrationInput,
} from "./patient.portal.schemas.js";
import type {
  PatientPortalHospitalSummary,
  PatientPortalRegistrationResult,
} from "./patient.portal.types.js";
import {
  allocatePatientCode,
  getPatientById,
  mapPatientWriteError,
  normalizeDateOfBirth,
  normalizeEmail,
  normalizeFullName,
  normalizeGender,
  normalizePhone,
} from "./patient.service.js";

interface ActiveHospital {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Patient portal registration/linking.
 *
 * A patient is linked to a hospital through `patient_profiles.user_id`, never
 * through a staff membership or role. This keeps the public flow from creating
 * any hospital-plane authorization. The global account is always reused for an
 * authenticated link, and public registration only creates one when the email
 * is unused.
 */

async function resolveActiveHospital(hospitalSlug: string): Promise<ActiveHospital> {
  const hospital = await withPlatformTransaction(async (tx) => {
    const [row] = await tx
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.slug, hospitalSlug), eq(tenants.status, "ACTIVE")))
      .limit(1);

    return row;
  });

  if (!hospital) {
    throw AppError.notFound("Hospital not found or not accepting patient registrations");
  }

  return hospital;
}

async function requirePortalAccount(userId: string): Promise<PublicUser> {
  const user = await getPublicUser(userId);

  if (!user.emailVerifiedAt) {
    throw new AppError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before accessing the patient portal",
      { reason: "EMAIL_NOT_VERIFIED" },
    );
  }

  return user;
}

async function assertNoLinkedProfile(
  tx: DbExecutor,
  tenantId: string,
  userId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: patientProfiles.id })
    .from(patientProfiles)
    .where(
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.userId, userId),
        isNull(patientProfiles.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict("This account is already linked to a patient in this hospital", {
      reason: "PATIENT_ALREADY_LINKED",
    });
  }
}

/**
 * Safe identity matching is deliberately contact-based only: an exact
 * normalized email or phone already present on a patient in this hospital is a
 * conflict, not an automatic link. The response never reveals the other
 * patient's identity.
 */
async function assertNoPotentialPatientMatch(
  tx: DbExecutor,
  tenantId: string,
  email: string,
  phone: string | null,
): Promise<void> {
  const contactMatch = or(
    eq(sql`lower(${patientContacts.email})`, email),
    phone === null ? undefined : eq(patientContacts.phone, phone),
  );

  if (!contactMatch) return;

  const [existing] = await tx
    .select({ id: patientProfiles.id })
    .from(patientContacts)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.tenantId, patientContacts.tenantId),
        eq(patientProfiles.id, patientContacts.patientId),
      ),
    )
    .where(and(eq(patientContacts.tenantId, tenantId), contactMatch))
    .limit(1);

  if (existing) {
    throw AppError.conflict(
      "A patient record may already exist in this hospital. Contact the hospital to link your existing record.",
      { reason: "POTENTIAL_PATIENT_MATCH" },
    );
  }
}

interface CreatePortalPatientInput {
  readonly fullName: string;
  readonly dateOfBirth?: string | null;
  readonly gender?: "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";
  readonly phone?: string | null;
}

async function createPortalPatient(
  tenantId: string,
  userId: string,
  email: string,
  emailVerified: boolean,
  input: CreatePortalPatientInput,
): Promise<string> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertNoLinkedProfile(tx, tenantId, userId);

      const normalizedEmail = normalizeEmail(email, "Account email");
      const phone =
        input.phone === null || input.phone === undefined || input.phone.trim() === ""
          ? null
          : normalizePhone(input.phone, "Phone");

      await assertNoPotentialPatientMatch(tx, tenantId, normalizedEmail, phone);

      const fullName = normalizeFullName(input.fullName);
      const dateOfBirth = normalizeDateOfBirth(input.dateOfBirth);
      const gender = normalizeGender(input.gender);
      const patientCode = await allocatePatientCode(tx, tenantId);

      const [created] = await tx
        .insert(patientProfiles)
        .values({
          tenantId,
          userId,
          patientCode,
          fullName,
          dateOfBirth,
          gender,
        })
        .returning({ id: patientProfiles.id });

      if (!created) throw AppError.internal("Failed to create patient profile");

      await tx.insert(patientContacts).values({
        tenantId,
        patientId: created.id,
        contactType: "MOBILE",
        phone,
        email: normalizedEmail,
        isPrimary: true,
        isVerified: emailVerified,
      });

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.PATIENT_CREATED,
        module: "patients",
        resourceType: "patient",
        resourceId: created.id,
        description: "Patient self-registration profile created",
        metadata: { selfRegistered: true, accountReused: false },
      });

      return created.id;
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

async function deleteUnlinkedRegistrationUser(userId: string): Promise<void> {
  try {
    await getDb().delete(users).where(eq(users.id, userId));
  } catch (error) {
    logger.warn({ userId, err: error }, "Failed to clean up incomplete patient registration");
  }
}

/**
 * Public registration. The account is created first through the existing auth
 * service (which sends email verification), then the linked patient profile is
 * created. If profile creation fails, the just-created account is removed so a
 * failed patient match cannot leave an orphan login.
 */
export async function registerPatientAccount(
  input: PublicPatientRegistrationInput,
): Promise<PatientPortalRegistrationResult> {
  const hospital = await resolveActiveHospital(input.hospitalSlug);
  const normalizedEmail = normalizeEmail(input.email, "Email");
  const phone =
    input.phone === null || input.phone === undefined || input.phone.trim() === ""
      ? null
      : normalizePhone(input.phone, "Phone");

  const [existingAccount] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        eq(sql`lower(${users.email})`, normalizedEmail),
        phone === null ? undefined : eq(users.phone, phone),
      ),
    )
    .limit(1);

  if (existingAccount) {
    throw AppError.conflict(
      "An account with this email or phone number already exists. Sign in to add this hospital.",
      { reason: "ACCOUNT_EXISTS" },
    );
  }

  // Fail before creating the account when a patient record already matches.
  const patientMatch = await withTenantTransaction(hospital.id, async (tx) => {
    try {
      await assertNoPotentialPatientMatch(tx, hospital.id, normalizedEmail, phone);
      return false;
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) return true;
      throw error;
    }
  });

  if (patientMatch) {
    throw AppError.conflict(
      "A patient record may already exist in this hospital. Contact the hospital to link your existing record.",
      { reason: "POTENTIAL_PATIENT_MATCH" },
    );
  }

  const user = await registerUser({
    fullName: normalizeFullName(input.fullName),
    email: normalizedEmail,
    phone: phone ?? undefined,
    password: input.password,
  });

  try {
    const patientId = await createPortalPatient(
      hospital.id,
      user.id,
      normalizedEmail,
      false,
      {
        fullName: input.fullName,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
        phone,
      },
    );
    const patient = await getPatientById(hospital.id, patientId);

    return {
      user,
      patient,
      accountCreated: true,
      requiresEmailVerification: true,
    };
  } catch (error) {
    await deleteUnlinkedRegistrationUser(user.id);
    throw error;
  }
}

/** Links the already-authenticated global account to one more hospital. */
export async function linkPatientToHospital(
  userId: string,
  input: LinkPatientAccountInput,
): Promise<PatientPortalRegistrationResult> {
  const user = await requirePortalAccount(userId);
  const hospital = await resolveActiveHospital(input.hospitalSlug);

  const patientId = await createPortalPatient(
    hospital.id,
    user.id,
    user.email,
    user.emailVerifiedAt !== null,
    {
      fullName: input.fullName ?? user.fullName,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      phone: input.phone ?? user.phone,
    },
  );
  const patient = await getPatientById(hospital.id, patientId);

  return {
    user,
    patient,
    accountCreated: false,
    requiresEmailVerification: false,
  };
}

/** Hospitals where the current account has a live patient profile. */
export async function listPatientPortalHospitals(
  userId: string,
): Promise<readonly PatientPortalHospitalSummary[]> {
  await requirePortalAccount(userId);

  // Patient tables are tenant-RLS protected and have no self-read policy. This
  // platform-context query is still hard-scoped to the signed-in user's id and
  // never trusts a tenant id from the request.
  return withPlatformTransaction(async (tx) => {
    const rows = await tx
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        patientId: patientProfiles.id,
        patientCode: patientProfiles.patientCode,
        status: patientProfiles.status,
        linkedAt: patientProfiles.createdAt,
      })
      .from(patientProfiles)
      .innerJoin(tenants, eq(tenants.id, patientProfiles.tenantId))
      .where(
        and(
          eq(patientProfiles.userId, userId),
          isNull(patientProfiles.deletedAt),
          eq(tenants.status, "ACTIVE"),
        ),
      )
      .orderBy(asc(tenants.name), asc(patientProfiles.id));

    return rows.map((row) => ({ ...row }));
  });
}

/** The signed-in account's own patient profile in one active hospital. */
export async function getPatientPortalProfile(
  userId: string,
  hospitalSlug: string,
): Promise<PatientPortalRegistrationResult> {
  const user = await requirePortalAccount(userId);
  const hospital = await resolveActiveHospital(hospitalSlug);

  const patientId = await withTenantTransaction(hospital.id, async (tx) => {
    const [row] = await tx
      .select({ id: patientProfiles.id })
      .from(patientProfiles)
      .where(
        and(
          eq(patientProfiles.tenantId, hospital.id),
          eq(patientProfiles.userId, userId),
          isNull(patientProfiles.deletedAt),
        ),
      )
      .limit(1);

    return row?.id ?? null;
  });

  if (!patientId) {
    throw AppError.notFound("No patient profile is linked to this hospital");
  }

  return {
    user,
    patient: await getPatientById(hospital.id, patientId),
    accountCreated: false,
    requiresEmailVerification: false,
  };
}
