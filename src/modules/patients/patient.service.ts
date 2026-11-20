import { and, asc, desc, eq, exists, gte, ilike, isNull, lte, ne, or, sql } from "drizzle-orm";
import { withTenantTransaction, type DbExecutor } from "../../database/context.js";
import {
  patientAddresses,
  patientCodeSequences,
  patientContacts,
  patientEmergencyContacts,
  patientProfiles,
  tenantMemberships,
  tenantSettings,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { recordPatientAudit } from "./patient.audit.js";
import type {
  CreatePatientInput,
  ListPatientsFilters,
  PatientAccountSummary,
  PatientAddressDto,
  PatientAddressInput,
  PatientActorContext,
  PatientAddressType,
  PatientBloodGroup,
  PatientContactDto,
  PatientContactInput,
  PatientContactType,
  PatientDetailDto,
  PatientEmergencyContactDto,
  PatientEmergencyContactInput,
  PatientGender,
  PatientListResult,
  PatientMaritalStatus,
  PatientProfileDto,
  PatientSortField,
  PatientStatus,
  PatientSummaryDto,
  SettablePatientStatus,
  UpdatePatientInput,
} from "./patient.types.js";

/**
 * Patient registration and profile service (Task 17.2).
 *
 * Business rules:
 * - A patient profile is tenant-owned. The tenant id always comes from the
 *   verified caller, never from input, and every statement repeats it in SQL on
 *   top of the RLS transaction context.
 * - Patient codes (MRNs) are allocated by this service and never accepted from
 *   input. Allocation uses a per-tenant counter row, so concurrent
 *   registrations cannot receive the same number; `(tenant_id, patient_code)`
 *   remains the final uniqueness guarantee.
 * - A profile may exist with no global account. Linking an account is optional,
 *   explicit and separately authorized; matching phone/email never links.
 * - Status changes never hard delete and always keep child rows, because
 *   documents and (future) clinical/financial records must survive archival.
 * - Patient-facing output never includes credential columns or any global user
 *   field beyond id, display name and active flag.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_CODE_ATTEMPTS = 20;

const PATIENT_CODE_SETTING_KEY = "patient.code_format";
/** Documented default: `P-` followed by a zero-padded, 6-digit sequence. */
const DEFAULT_PATIENT_CODE_FORMAT = "P-{seq:6}";
const MAX_PATIENT_CODE_LENGTH = 40;
const PATIENT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;

/** Linking or unlinking a global account is an update-level action. */
const ACCOUNT_LINK_PERMISSION = "patient:update";

const GENDERS: readonly PatientGender[] = ["MALE", "FEMALE", "OTHER", "UNKNOWN"];
const BLOOD_GROUPS: readonly PatientBloodGroup[] = [
  "A_POSITIVE",
  "A_NEGATIVE",
  "B_POSITIVE",
  "B_NEGATIVE",
  "AB_POSITIVE",
  "AB_NEGATIVE",
  "O_POSITIVE",
  "O_NEGATIVE",
];
const MARITAL_STATUSES: readonly PatientMaritalStatus[] = [
  "SINGLE",
  "MARRIED",
  "DIVORCED",
  "WIDOWED",
  "OTHER",
];
const CONTACT_TYPES: readonly PatientContactType[] = [
  "MOBILE",
  "HOME",
  "WORK",
  "GUARDIAN",
  "OTHER",
];
const ADDRESS_TYPES: readonly PatientAddressType[] = ["HOME", "WORK", "OTHER"];
const SETTABLE_STATUSES: readonly SettablePatientStatus[] = ["ACTIVE", "INACTIVE", "ARCHIVED"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?\d{7,15}$/;

interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** Drizzle wraps driver errors, so walk the `cause` chain for SQLSTATE data. */
function pgErrorInfo(error: unknown): PgErrorInfo {
  const info: { code?: string; constraint?: string } = {};
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (info.code === undefined && typeof candidate.code === "string") {
      info.code = candidate.code;
    }
    if (info.constraint === undefined && typeof candidate.constraint === "string") {
      info.constraint = candidate.constraint;
    }

    current = candidate.cause;
  }

  return info;
}

/**
 * Translates database constraint violations into safe application errors.
 * Raw SQLSTATE text never reaches the caller.
 */
export function mapPatientWriteError(error: unknown): never {
  const { code, constraint } = pgErrorInfo(error);

  if (code === "23505") {
    if (constraint === "patient_profiles_tenant_user_unique") {
      throw AppError.conflict("This user account is already linked to a patient in this hospital");
    }
    if (constraint === "patient_profiles_tenant_code_unique") {
      throw AppError.conflict("A patient with this code already exists in this hospital");
    }
    if (
      constraint === "patient_contacts_patient_phone_unique" ||
      constraint === "patient_contacts_patient_email_unique"
    ) {
      throw AppError.conflict("This contact detail is already recorded for this patient");
    }
    if (constraint === "patient_contacts_primary_unique") {
      throw AppError.conflict("Only one primary contact is allowed per patient");
    }
    if (constraint === "patient_addresses_primary_unique") {
      throw AppError.conflict("Only one primary address per address type is allowed");
    }

    throw AppError.conflict("A patient with these details already exists in this hospital");
  }

  if (code === "23514") {
    throw AppError.validation("Patient data violates a database constraint");
  }

  if (code === "23503") {
    throw AppError.badRequest("A referenced record does not belong to this hospital");
  }

  throw error;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function normalizeFullName(value: string | null | undefined): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ");

  if (name.length === 0) {
    throw AppError.validation("Full name is required");
  }

  if (name.length > 200) {
    throw AppError.validation("Full name must be at most 200 characters");
  }

  return name;
}

/** Accepts `YYYY-MM-DD` (or a Date) and returns the same calendar date. */
function normalizeDateOfBirth(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value.trim();

  if (text.length === 0) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.validation("Date of birth must use the YYYY-MM-DD format");
  }

  const parsed = new Date(`${text}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw AppError.validation("Enter a valid date of birth");
  }

  if (text > new Date().toISOString().slice(0, 10)) {
    throw AppError.validation("Date of birth cannot be in the future");
  }

  return text;
}

function normalizeGender(value: PatientGender | null | undefined): PatientGender {
  if (value === null || value === undefined) return "UNKNOWN";

  const gender = value.trim().toUpperCase() as PatientGender;

  if (!GENDERS.includes(gender)) {
    throw AppError.validation("Gender must be MALE, FEMALE, OTHER or UNKNOWN");
  }

  return gender;
}

function normalizeBloodGroup(
  value: PatientBloodGroup | null | undefined,
): PatientBloodGroup | null {
  if (value === null || value === undefined) return null;

  const bloodGroup = value.trim().toUpperCase() as PatientBloodGroup;

  if (!BLOOD_GROUPS.includes(bloodGroup)) {
    throw AppError.validation("Blood group is not a recognised value");
  }

  return bloodGroup;
}

function normalizeMaritalStatus(
  value: PatientMaritalStatus | null | undefined,
): PatientMaritalStatus | null {
  if (value === null || value === undefined) return null;

  const status = value.trim().toUpperCase() as PatientMaritalStatus;

  if (!MARITAL_STATUSES.includes(status)) {
    throw AppError.validation("Marital status is not a recognised value");
  }

  return status;
}

/**
 * Profile images live in private object storage, so only a relative object key
 * is accepted. URLs, absolute paths and traversal segments are rejected; the
 * API issues signed URLs later, after its own authorization check.
 */
function normalizeProfileImageKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const key = value.trim();

  if (key.length === 0) return null;

  if (key.length > 512) {
    throw AppError.validation("Profile image key must be at most 512 characters");
  }

  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(key) ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\")
  ) {
    throw AppError.validation(
      "Profile image key must be a private storage path, not a URL or absolute path",
    );
  }

  return key;
}

export function normalizePhone(value: string, field: string): string {
  const phone = value.replace(/[\s().-]/g, "");

  if (!PHONE_PATTERN.test(phone)) {
    throw AppError.validation(`${field} must be a valid phone number`);
  }

  return phone;
}

export function normalizeEmail(value: string, field: string): string {
  const email = value.trim().toLowerCase();

  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw AppError.validation(`${field} must be a valid email address`);
  }

  return email;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  if (trimmed.length === 0) return null;

  if (trimmed.length > maxLength) {
    throw AppError.validation(`${field} must be at most ${maxLength} characters`);
  }

  return trimmed;
}

export function normalizeCountry(value: string | null | undefined): string | null {
  const country = normalizeOptionalText(value, "Country", 2);

  if (country === null) return null;

  const code = country.toUpperCase();

  if (!/^[A-Z]{2}$/.test(code)) {
    throw AppError.validation("Country must be a two-letter ISO 3166-1 code");
  }

  return code;
}

/** Validates a contact purpose; `MOBILE` is the default for a new contact. */
export function normalizeContactType(
  value: PatientContactType | null | undefined,
): PatientContactType {
  const contactType = (value ?? "MOBILE").trim().toUpperCase() as PatientContactType;

  if (!CONTACT_TYPES.includes(contactType)) {
    throw AppError.validation("Contact type is not a recognised value");
  }

  return contactType;
}

/** Validates an address category; `HOME` is the default for a new address. */
export function normalizeAddressType(
  value: PatientAddressType | null | undefined,
): PatientAddressType {
  const addressType = (value ?? "HOME").trim().toUpperCase() as PatientAddressType;

  if (!ADDRESS_TYPES.includes(addressType)) {
    throw AppError.validation("Address type must be HOME, WORK or OTHER");
  }

  return addressType;
}

interface NormalizedContact {
  readonly contactType: PatientContactType;
  readonly phone: string | null;
  readonly email: string | null;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
}

function normalizeContacts(inputs: readonly PatientContactInput[]): NormalizedContact[] {
  const contacts: NormalizedContact[] = [];
  const seen = new Set<string>();
  let primaryCount = 0;

  for (const input of inputs) {
    const contactType = normalizeContactType(input.contactType);

    const phone =
      input.phone === null || input.phone === undefined || input.phone.trim().length === 0
        ? null
        : normalizePhone(input.phone, "Contact phone");
    const email =
      input.email === null || input.email === undefined || input.email.trim().length === 0
        ? null
        : normalizeEmail(input.email, "Contact email");

    if (phone === null && email === null) {
      throw AppError.validation("Each contact needs a phone number or an email address");
    }

    const dedupeKey = `${phone ?? ""}|${email ?? ""}`;

    if (seen.has(dedupeKey)) {
      throw AppError.validation("Duplicate contact details were supplied for this patient");
    }

    seen.add(dedupeKey);

    const isPrimary = input.isPrimary ?? false;

    if (isPrimary) primaryCount += 1;

    contacts.push({
      contactType,
      phone,
      email,
      isPrimary,
      isVerified: input.isVerified ?? false,
    });
  }

  // The schema allows a single primary contact row, which may carry both the
  // primary phone and the primary email.
  if (primaryCount > 1) {
    throw AppError.validation("Only one contact may be marked as primary");
  }

  return contacts;
}

interface NormalizedAddress {
  readonly addressType: PatientAddressType;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly isPrimary: boolean;
}

function normalizeAddresses(inputs: readonly PatientAddressInput[]): NormalizedAddress[] {
  const addresses: NormalizedAddress[] = [];
  const primaryTypes = new Set<PatientAddressType>();

  for (const input of inputs) {
    const addressType = normalizeAddressType(input.addressType);

    const addressLine1 = normalizeOptionalText(input.addressLine1, "Address line 1", 255);

    if (addressLine1 === null) {
      throw AppError.validation("Address line 1 is required");
    }

    const isPrimary = input.isPrimary ?? false;

    if (isPrimary) {
      if (primaryTypes.has(addressType)) {
        throw AppError.validation(
          `Only one primary ${addressType} address is allowed per patient`,
        );
      }

      primaryTypes.add(addressType);
    }

    addresses.push({
      addressType,
      addressLine1,
      addressLine2: normalizeOptionalText(input.addressLine2, "Address line 2", 255),
      city: normalizeOptionalText(input.city, "City", 120),
      state: normalizeOptionalText(input.state, "State", 120),
      postalCode: normalizeOptionalText(input.postalCode, "Postal code", 20),
      country: normalizeCountry(input.country),
      isPrimary,
    });
  }

  return addresses;
}

interface NormalizedEmergencyContact {
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email: string | null;
}

function normalizeEmergencyContacts(
  inputs: readonly PatientEmergencyContactInput[],
): NormalizedEmergencyContact[] {
  return inputs.map((input) => {
    const name = normalizeOptionalText(input.name, "Emergency contact name", 200);

    if (name === null) {
      throw AppError.validation("Emergency contact name is required");
    }

    const relationship = normalizeOptionalText(
      input.relationship,
      "Emergency contact relationship",
      60,
    );

    if (relationship === null) {
      throw AppError.validation("Emergency contact relationship is required");
    }

    if (input.phone.trim().length === 0) {
      throw AppError.validation("Emergency contact phone is required");
    }

    return {
      name,
      relationship,
      phone: normalizePhone(input.phone, "Emergency contact phone"),
      email:
        input.email === null || input.email === undefined || input.email.trim().length === 0
          ? null
          : normalizeEmail(input.email, "Emergency contact email"),
    };
  });
}

function normalizeUserId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const userId = value.trim();

  if (userId.length === 0) return null;

  if (!isUuid(userId)) {
    throw AppError.validation("User id must be a valid UUID");
  }

  return userId;
}

function hasPermission(actor: PatientActorContext, permission: string): boolean {
  return actor.permissions?.has(permission) ?? false;
}

export async function assertActiveMembership(
  tx: DbExecutor,
  tenantId: string,
  actor: PatientActorContext,
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

/**
 * Linking a patient profile to a global account is opt-in and sensitive: it
 * changes who can see the record through patient-facing surfaces. It therefore
 * needs an explicit update permission instead of riding on registration.
 */
function assertAccountLinkAuthorized(actor: PatientActorContext): void {
  if (!hasPermission(actor, ACCOUNT_LINK_PERMISSION)) {
    throw AppError.forbidden("You do not have permission to link a patient to a user account");
  }
}

/**
 * A patient account is a patient-portal login, not staff: it does NOT need an
 * ACTIVE tenant membership (unlike a doctor profile). It must exist and be
 * active, and a hospital may link the same global account only once.
 */
async function assertUserLinkable(
  tx: DbExecutor,
  tenantId: string,
  userId: string,
  excludePatientId?: string,
): Promise<void> {
  const [user] = await tx
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw AppError.notFound("User not found");

  if (!user.isActive) {
    throw AppError.badRequest("This user account is inactive");
  }

  // Soft-deleted profiles still reserve their linked account (the unique index
  // is not partial), so no `deleted_at` filter here.
  const [existing] = await tx
    .select({ id: patientProfiles.id })
    .from(patientProfiles)
    .where(
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.userId, userId),
        excludePatientId === undefined ? undefined : ne(patientProfiles.id, excludePatientId),
      ),
    )
    .limit(1);

  if (existing) {
    throw AppError.conflict("This user account is already linked to a patient in this hospital");
  }
}

async function loadPatientCodeFormat(tx: DbExecutor, tenantId: string): Promise<string> {
  const [setting] = await tx
    .select({ value: tenantSettings.settingValue })
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, tenantId),
        eq(tenantSettings.settingKey, PATIENT_CODE_SETTING_KEY),
      ),
    )
    .limit(1);

  if (!setting) return DEFAULT_PATIENT_CODE_FORMAT;

  if (typeof setting.value !== "string" || setting.value.trim().length === 0) {
    throw AppError.internal("The configured patient code format is invalid");
  }

  return setting.value.trim();
}

/**
 * Renders a patient code from a documented, tenant-configurable template.
 *
 * Supported tokens:
 *   {seq}      raw sequence number            -> 42
 *   {seq:N}    zero-padded to N digits (1-12) -> 000042
 *   {year}     current UTC year               -> 2026
 *
 * Default: `P-{seq:6}`. Anything else is rejected as invalid configuration.
 */
function renderPatientCode(format: string, sequence: number, year: number): string {
  let usedSequence = false;
  let invalid = false;

  const rendered = format.replace(
    /\{([a-z]+)(?::(\d{1,2}))?\}/gi,
    (match: string, name: string, width: string | undefined) => {
      const token = name.toLowerCase();

      if (token === "seq") {
        const padding = width === undefined ? 0 : Number(width);

        if (!Number.isInteger(padding) || padding < 0 || padding > 12) {
          invalid = true;
          return match;
        }

        usedSequence = true;
        return String(sequence).padStart(padding, "0");
      }

      if (token === "year" && width === undefined) {
        return String(year);
      }

      invalid = true;
      return match;
    },
  );

  if (invalid || !usedSequence || rendered.includes("{") || rendered.includes("}")) {
    throw AppError.internal("The configured patient code format is invalid");
  }

  if (rendered.length > MAX_PATIENT_CODE_LENGTH || !PATIENT_CODE_PATTERN.test(rendered)) {
    throw AppError.internal("The configured patient code format produces an invalid code");
  }

  return rendered;
}

/**
 * Allocates the next patient code for a tenant.
 *
 * The counter row is locked by the upsert until the registration transaction
 * ends, so two concurrent registrations cannot observe the same number.
 * Numbers already present for the tenant (for example seeded MRNs) are skipped
 * by probing `patient_profiles`; soft-deleted profiles stay reserved.
 */
async function allocatePatientCode(tx: DbExecutor, tenantId: string): Promise<string> {
  const format = await loadPatientCodeFormat(tx, tenantId);
  const year = new Date().getUTCFullYear();

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const [row] = await tx
      .insert(patientCodeSequences)
      .values({ tenantId, lastValue: 1 })
      .onConflictDoUpdate({
        target: patientCodeSequences.tenantId,
        set: {
          lastValue: sql`${patientCodeSequences.lastValue} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ lastValue: patientCodeSequences.lastValue });

    const sequence = row?.lastValue;

    if (sequence === undefined) {
      throw AppError.internal("Failed to allocate a patient code");
    }

    const candidate = renderPatientCode(format, sequence, year);

    const [existing] = await tx
      .select({ id: patientProfiles.id })
      .from(patientProfiles)
      .where(
        and(
          eq(patientProfiles.tenantId, tenantId),
          eq(patientProfiles.patientCode, candidate),
        ),
      )
      .limit(1);

    if (!existing) return candidate;
  }

  throw AppError.conflict("Could not allocate a unique patient code; please try again");
}

const profileSelection = {
  id: patientProfiles.id,
  patientCode: patientProfiles.patientCode,
  fullName: patientProfiles.fullName,
  dateOfBirth: patientProfiles.dateOfBirth,
  gender: patientProfiles.gender,
  bloodGroup: patientProfiles.bloodGroup,
  maritalStatus: patientProfiles.maritalStatus,
  profileImageKey: patientProfiles.profileImageKey,
  status: patientProfiles.status,
  createdAt: patientProfiles.createdAt,
  updatedAt: patientProfiles.updatedAt,
  deletedAt: patientProfiles.deletedAt,
  userId: patientProfiles.userId,
  userFullName: users.fullName,
  userIsActive: users.isActive,
};

interface ProfileRow {
  id: string;
  patientCode: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: PatientGender;
  bloodGroup: PatientBloodGroup | null;
  maritalStatus: PatientMaritalStatus | null;
  profileImageKey: string | null;
  status: PatientStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  userId: string | null;
  userFullName: string | null;
  userIsActive: boolean | null;
}

function toAccountSummary(row: ProfileRow): PatientAccountSummary | null {
  if (row.userId === null) return null;

  return {
    id: row.userId,
    fullName: row.userFullName ?? "",
    isActive: row.userIsActive ?? false,
  };
}

function toProfileDto(row: ProfileRow): PatientProfileDto {
  return {
    id: row.id,
    patientCode: row.patientCode,
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    bloodGroup: row.bloodGroup,
    maritalStatus: row.maritalStatus,
    profileImageKey: row.profileImageKey,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: toAccountSummary(row),
  };
}

async function findProfile(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  options: { readonly includeDeleted?: boolean } = {},
): Promise<ProfileRow> {
  if (!isUuid(patientId)) throw AppError.notFound("Patient not found");

  const [row] = await tx
    .select(profileSelection)
    .from(patientProfiles)
    .leftJoin(users, eq(users.id, patientProfiles.userId))
    .where(
      and(
        eq(patientProfiles.id, patientId),
        eq(patientProfiles.tenantId, tenantId),
        options.includeDeleted ? undefined : isNull(patientProfiles.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("Patient not found");

  return row;
}

/**
 * Confirms a patient exists in the caller's tenant and is not soft deleted.
 * Archived profiles remain readable, so this is the read-side guard used by the
 * contact/address management listings.
 */
export async function requireLivePatient(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
): Promise<void> {
  if (!isUuid(patientId)) throw AppError.notFound("Patient not found");

  const [row] = await tx
    .select({ id: patientProfiles.id, deletedAt: patientProfiles.deletedAt })
    .from(patientProfiles)
    .where(
      and(eq(patientProfiles.id, patientId), eq(patientProfiles.tenantId, tenantId)),
    )
    .limit(1);

  if (!row || row.deletedAt !== null) throw AppError.notFound("Patient not found");
}

/**
 * Guard for every child-record mutation: the caller must (when supplied) be an
 * active member, the patient must exist in this tenant, and soft-deleted or
 * archived/deceased profiles are read-only - no contact, address or emergency
 * contact may be attached to them.
 */
export async function requireMutablePatient(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
  actorContext?: PatientActorContext,
): Promise<void> {
  if (actorContext !== undefined) {
    await assertActiveMembership(tx, tenantId, actorContext);
  }

  if (!isUuid(patientId)) throw AppError.notFound("Patient not found");

  const [row] = await tx
    .select({ id: patientProfiles.id, status: patientProfiles.status, deletedAt: patientProfiles.deletedAt })
    .from(patientProfiles)
    .where(
      and(eq(patientProfiles.id, patientId), eq(patientProfiles.tenantId, tenantId)),
    )
    .limit(1);

  if (!row || row.deletedAt !== null) throw AppError.notFound("Patient not found");

  if (row.status === "ARCHIVED") {
    throw AppError.conflict(
      "Archived patients cannot be modified until they are reactivated",
    );
  }

  if (row.status === "DECEASED") {
    throw AppError.conflict("A deceased patient record cannot be modified");
  }
}

async function loadPatientDetail(
  tx: DbExecutor,
  tenantId: string,
  patientId: string,
): Promise<PatientDetailDto> {
  const profile = await findProfile(tx, tenantId, patientId);

  // Sequential on purpose: a transaction owns one client, and concurrent
  // queries on the same client are deprecated by node-postgres.
  const contactRows = await tx
      .select({
        id: patientContacts.id,
        contactType: patientContacts.contactType,
        phone: patientContacts.phone,
        email: patientContacts.email,
        isPrimary: patientContacts.isPrimary,
        isVerified: patientContacts.isVerified,
        createdAt: patientContacts.createdAt,
        updatedAt: patientContacts.updatedAt,
      })
      .from(patientContacts)
      .where(
        and(
          eq(patientContacts.tenantId, tenantId),
          eq(patientContacts.patientId, patientId),
        ),
      )
      .orderBy(desc(patientContacts.isPrimary), asc(patientContacts.createdAt));

  const addressRows = await tx
      .select({
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
      })
      .from(patientAddresses)
      .where(
        and(
          eq(patientAddresses.tenantId, tenantId),
          eq(patientAddresses.patientId, patientId),
        ),
      )
      .orderBy(desc(patientAddresses.isPrimary), asc(patientAddresses.createdAt));

  const emergencyRows = await tx
      .select({
        id: patientEmergencyContacts.id,
        name: patientEmergencyContacts.name,
        relationship: patientEmergencyContacts.relationship,
        phone: patientEmergencyContacts.phone,
        email: patientEmergencyContacts.email,
        createdAt: patientEmergencyContacts.createdAt,
        updatedAt: patientEmergencyContacts.updatedAt,
      })
      .from(patientEmergencyContacts)
      .where(
        and(
          eq(patientEmergencyContacts.tenantId, tenantId),
          eq(patientEmergencyContacts.patientId, patientId),
        ),
      )
      .orderBy(asc(patientEmergencyContacts.createdAt));

  return {
    ...toProfileDto(profile),
    contacts: contactRows as PatientContactDto[],
    addresses: addressRows as PatientAddressDto[],
    emergencyContacts: emergencyRows as PatientEmergencyContactDto[],
  };
}

/**
 * Registers a patient under the caller's tenant, creating the profile and its
 * contacts, addresses and emergency contacts in one transaction. The patient
 * code is generated here; any client-supplied code is ignored because the input
 * type has no such field.
 */
export async function createPatient(
  tenantId: string,
  input: CreatePatientInput,
  actorContext: PatientActorContext,
): Promise<PatientDetailDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);

      const fullName = normalizeFullName(input.fullName);
      const dateOfBirth = normalizeDateOfBirth(input.dateOfBirth);
      const gender = normalizeGender(input.gender);
      const bloodGroup = normalizeBloodGroup(input.bloodGroup);
      const maritalStatus = normalizeMaritalStatus(input.maritalStatus);
      const profileImageKey = normalizeProfileImageKey(input.profileImageKey);
      const userId = normalizeUserId(input.userId);

      if (userId !== null) {
        assertAccountLinkAuthorized(actorContext);
        await assertUserLinkable(tx, tenantId, userId);
      }

      const contacts = normalizeContacts(input.contacts ?? []);
      const addresses = normalizeAddresses(input.addresses ?? []);
      const emergencyContacts = normalizeEmergencyContacts(input.emergencyContacts ?? []);

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
          bloodGroup,
          maritalStatus,
          profileImageKey,
        })
        .returning({ id: patientProfiles.id });

      if (!created) throw AppError.internal("Failed to register patient");

      if (contacts.length > 0) {
        await tx.insert(patientContacts).values(
          contacts.map((contact) => ({
            tenantId,
            patientId: created.id,
            contactType: contact.contactType,
            phone: contact.phone,
            email: contact.email,
            isPrimary: contact.isPrimary,
            isVerified: contact.isVerified,
          })),
        );
      }

      if (addresses.length > 0) {
        await tx.insert(patientAddresses).values(
          addresses.map((address) => ({
            tenantId,
            patientId: created.id,
            addressType: address.addressType,
            addressLine1: address.addressLine1,
            addressLine2: address.addressLine2,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
            isPrimary: address.isPrimary,
          })),
        );
      }

      if (emergencyContacts.length > 0) {
        await tx.insert(patientEmergencyContacts).values(
          emergencyContacts.map((contact) => ({
            tenantId,
            patientId: created.id,
            name: contact.name,
            relationship: contact.relationship,
            phone: contact.phone,
            email: contact.email,
          })),
        );
      }

      recordPatientAudit(actorContext.audit, "patient.created", {
        tenantId,
        actorUserId: actorContext.userId,
        patientId: created.id,
      });

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: actorContext.userId,
        action: AUDIT_ACTIONS.PATIENT_CREATED,
        module: "patients",
        resourceType: "patient",
        resourceId: created.id,
        description: "Patient registered",
      });

      return await loadPatientDetail(tx, tenantId, created.id);
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Lists patients for one tenant. Soft-deleted profiles are excluded, contact
 * search runs as a scoped `EXISTS` (no joins, no N+1), and the result carries
 * identity fields only.
 */
export async function listPatients(
  tenantId: string,
  filters: ListPatientsFilters = {},
): Promise<PatientListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [eq(patientProfiles.tenantId, tenantId), isNull(patientProfiles.deletedAt)];

    if (filters.search !== undefined && filters.search.trim().length > 0) {
      const pattern = `%${filters.search.trim()}%`;
      const searchClause = or(
        ilike(patientProfiles.fullName, pattern),
        ilike(patientProfiles.patientCode, pattern),
      );

      if (searchClause) conditions.push(searchClause);
    }

    if (filters.phone !== undefined && filters.phone.trim().length > 0) {
      const phone = normalizePhone(filters.phone, "Phone filter");

      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(patientContacts)
            .where(
              and(
                eq(patientContacts.tenantId, tenantId),
                eq(patientContacts.patientId, patientProfiles.id),
                eq(patientContacts.phone, phone),
              ),
            ),
        ),
      );
    }

    if (filters.email !== undefined && filters.email.trim().length > 0) {
      const email = normalizeEmail(filters.email, "Email filter");

      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(patientContacts)
            .where(
              and(
                eq(patientContacts.tenantId, tenantId),
                eq(patientContacts.patientId, patientProfiles.id),
                eq(sql`lower(${patientContacts.email})`, email),
              ),
            ),
        ),
      );
    }

    if (filters.status !== undefined) {
      conditions.push(eq(patientProfiles.status, filters.status));
    }

    if (filters.gender !== undefined) {
      conditions.push(eq(patientProfiles.gender, filters.gender));
    }

    if (filters.registeredFrom !== undefined) {
      conditions.push(gte(patientProfiles.createdAt, filters.registeredFrom));
    }

    if (filters.registeredTo !== undefined) {
      conditions.push(lte(patientProfiles.createdAt, filters.registeredTo));
    }

    const where = and(...conditions);
    // Sorting is an allowlist; unknown columns are never interpolated.
    const sortColumns = {
      fullName: patientProfiles.fullName,
      patientCode: patientProfiles.patientCode,
      createdAt: patientProfiles.createdAt,
      updatedAt: patientProfiles.updatedAt,
    };
    const sortKey: PatientSortField =
      filters.sortBy !== undefined && filters.sortBy in sortColumns
        ? filters.sortBy
        : "fullName";
    const sortColumn = sortColumns[sortKey];
    const direction = filters.sortOrder ?? "asc";

    // Count before page query: both run on the transaction's single client.
    const totals = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(patientProfiles)
        .where(where);

    const rows = await tx
        .select({
          id: patientProfiles.id,
          patientCode: patientProfiles.patientCode,
          fullName: patientProfiles.fullName,
          dateOfBirth: patientProfiles.dateOfBirth,
          gender: patientProfiles.gender,
          bloodGroup: patientProfiles.bloodGroup,
          status: patientProfiles.status,
          userId: patientProfiles.userId,
          createdAt: patientProfiles.createdAt,
          updatedAt: patientProfiles.updatedAt,
        })
        .from(patientProfiles)
        .where(where)
        .orderBy(
          direction === "desc" ? desc(sortColumn) : asc(sortColumn),
          asc(patientProfiles.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    const total = totals[0]?.total ?? 0;

    const patients: PatientSummaryDto[] = rows.map((row) => ({
      id: row.id,
      patientCode: row.patientCode,
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth,
      gender: row.gender,
      bloodGroup: row.bloodGroup,
      status: row.status,
      accountLinked: row.userId !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return { patients, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
}

/** Full profile with children. Soft-deleted and cross-tenant ids are not found. */
export async function getPatientById(
  tenantId: string,
  patientId: string,
): Promise<PatientDetailDto> {
  return withTenantTransaction(tenantId, async (tx) =>
    loadPatientDetail(tx, tenantId, patientId),
  );
}

/**
 * Partial profile update. Tenant ownership is re-checked, `tenant_id` and
 * `user_id` are not part of the patch, and archived patients must be
 * reactivated first. Contact/address rows are never rewritten here.
 */
export async function updatePatient(
  tenantId: string,
  patientId: string,
  input: UpdatePatientInput,
  actorContext?: PatientActorContext,
): Promise<PatientDetailDto> {
  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      if (actorContext !== undefined) {
        await assertActiveMembership(tx, tenantId, actorContext);
      }

      const current = await findProfile(tx, tenantId, patientId);

      if (current.status === "ARCHIVED") {
        throw AppError.conflict(
          "Archived patients must be reactivated before their profile can be edited",
        );
      }

      const patch: Partial<typeof patientProfiles.$inferInsert> = {};

      if (input.fullName !== undefined) {
        patch.fullName = normalizeFullName(input.fullName);
      }

      if (input.dateOfBirth !== undefined) {
        patch.dateOfBirth = normalizeDateOfBirth(input.dateOfBirth);
      }

      if (input.gender !== undefined) {
        patch.gender = normalizeGender(input.gender);
      }

      if (input.bloodGroup !== undefined) {
        patch.bloodGroup = normalizeBloodGroup(input.bloodGroup);
      }

      if (input.maritalStatus !== undefined) {
        patch.maritalStatus = normalizeMaritalStatus(input.maritalStatus);
      }

      if (input.profileImageKey !== undefined) {
        patch.profileImageKey = normalizeProfileImageKey(input.profileImageKey);
      }

      if (Object.keys(patch).length > 0) {
        await tx
          .update(patientProfiles)
          .set(patch)
          .where(
            and(
              eq(patientProfiles.id, patientId),
              eq(patientProfiles.tenantId, tenantId),
              isNull(patientProfiles.deletedAt),
            ),
          );
      }

      recordPatientAudit(actorContext?.audit, "patient.updated", {
        tenantId,
        actorUserId: actorContext?.userId ?? null,
        patientId,
        // Field names only: never the submitted values.
        fields: Object.keys(patch),
      });

      if (Object.keys(patch).length > 0) {
        await recordAuditSafely(tx, {
          tenantId,
          actorUserId: actorContext?.userId ?? null,
          action: AUDIT_ACTIONS.PATIENT_UPDATED,
          module: "patients",
          resourceType: "patient",
          resourceId: patientId,
          description: "Patient profile updated",
          metadata: { fields: Object.keys(patch) },
        });
      }

      return await loadPatientDetail(tx, tenantId, patientId);
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/**
 * Status transitions:
 *   ACTIVE <-> INACTIVE
 *   ACTIVE/INACTIVE -> ARCHIVED
 *   ARCHIVED -> ACTIVE (explicit reactivation)
 *
 * `ARCHIVED -> INACTIVE` is rejected so a reactivation is always deliberate,
 * and `DECEASED` is never assigned here. Unchanged status is a safe no-op.
 */
export async function updatePatientStatus(
  tenantId: string,
  patientId: string,
  status: SettablePatientStatus,
  actorContext?: PatientActorContext,
): Promise<PatientDetailDto> {
  const target = status.trim().toUpperCase() as SettablePatientStatus;

  if (!SETTABLE_STATUSES.includes(target)) {
    throw AppError.validation("Patient status must be ACTIVE, INACTIVE or ARCHIVED");
  }

  return withTenantTransaction(tenantId, async (tx) => {
    if (actorContext !== undefined) {
      await assertActiveMembership(tx, tenantId, actorContext);
    }

    const current = await findProfile(tx, tenantId, patientId);

    if (current.status === "DECEASED") {
      throw AppError.conflict(
        "The status of a deceased patient cannot be changed through this operation",
      );
    }

    if (current.status === target) {
      return await loadPatientDetail(tx, tenantId, patientId);
    }

    if (current.status === "ARCHIVED" && target === "INACTIVE") {
      throw AppError.conflict(
        "An archived patient must be reactivated before being marked inactive",
      );
    }

    await tx
      .update(patientProfiles)
      .set({ status: target })
      .where(
        and(
          eq(patientProfiles.id, patientId),
          eq(patientProfiles.tenantId, tenantId),
          isNull(patientProfiles.deletedAt),
        ),
      );

    recordPatientAudit(actorContext?.audit, "patient.status_changed", {
      tenantId,
      actorUserId: actorContext?.userId ?? null,
      patientId,
      from: current.status,
      to: target,
    });

    await recordAuditSafely(tx, {
      tenantId,
      actorUserId: actorContext?.userId ?? null,
      action: AUDIT_ACTIONS.PATIENT_STATUS_CHANGED,
      module: "patients",
      resourceType: "patient",
      resourceId: patientId,
      description: "Patient status changed",
      previousState: { status: current.status },
      newState: { status: target },
    });

    return await loadPatientDetail(tx, tenantId, patientId);
  });
}

/**
 * Soft deletes a patient.
 *
 * Nothing is physically removed: contacts, addresses, emergency contacts and
 * document metadata stay in place for retention and audit, and the profile row
 * keeps its MRN reserved. Repeated deletion is a no-op.
 *
 * Dependency restriction: no appointment, billing or EMR table exists yet, so
 * there is nothing that can currently block deletion. Those modules must add
 * their own guard here before they ship rather than relying on this comment.
 */
export async function deletePatient(
  tenantId: string,
  patientId: string,
  actorContext: PatientActorContext,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actorContext);

    const current = await findProfile(tx, tenantId, patientId, { includeDeleted: true });

    if (current.status === "DECEASED") {
      throw AppError.conflict("A deceased patient record cannot be archived");
    }

    if (current.deletedAt !== null) return;

    await tx
      .update(patientProfiles)
      .set({ deletedAt: new Date(), status: "ARCHIVED" })
      .where(
        and(
          eq(patientProfiles.id, patientId),
          eq(patientProfiles.tenantId, tenantId),
        ),
      );

    recordPatientAudit(actorContext.audit, "patient.deleted", {
      tenantId,
      actorUserId: actorContext.userId,
      patientId,
      from: current.status,
      to: "ARCHIVED",
    });

    await recordAuditSafely(tx, {
      tenantId,
      actorUserId: actorContext.userId,
      action: AUDIT_ACTIONS.PATIENT_DELETED,
      module: "patients",
      resourceType: "patient",
      resourceId: patientId,
      description: "Patient record soft deleted",
      previousState: { status: current.status },
      newState: { status: "ARCHIVED" },
    });
  });
}

/**
 * Links an existing global account to a patient profile. This is deliberately a
 * separate, explicitly authorized operation: registration never links by
 * matching contact details, and `updatePatient` cannot reassign `user_id`.
 */
export async function linkPatientUser(
  tenantId: string,
  patientId: string,
  userId: string,
  actorContext: PatientActorContext,
): Promise<PatientDetailDto> {
  const normalizedUserId = normalizeUserId(userId);

  if (normalizedUserId === null) {
    throw AppError.validation("User id is required");
  }

  try {
    return await withTenantTransaction(tenantId, async (tx) => {
      await assertActiveMembership(tx, tenantId, actorContext);
      assertAccountLinkAuthorized(actorContext);

      const current = await findProfile(tx, tenantId, patientId);

      if (current.status === "ARCHIVED") {
        throw AppError.conflict("Archived patients must be reactivated before linking an account");
      }

      if (current.userId === normalizedUserId) {
        return await loadPatientDetail(tx, tenantId, patientId);
      }

      await assertUserLinkable(tx, tenantId, normalizedUserId, patientId);

      await tx
        .update(patientProfiles)
        .set({ userId: normalizedUserId })
        .where(
          and(
            eq(patientProfiles.id, patientId),
            eq(patientProfiles.tenantId, tenantId),
            isNull(patientProfiles.deletedAt),
          ),
        );

      recordPatientAudit(actorContext.audit, "patient.account_linked", {
        tenantId,
        actorUserId: actorContext.userId,
        patientId,
      });

      await recordAuditSafely(tx, {
        tenantId,
        actorUserId: actorContext.userId,
        action: AUDIT_ACTIONS.PATIENT_ACCOUNT_LINKED,
        module: "patients",
        resourceType: "patient",
        resourceId: patientId,
        description: "Patient account linked",
        metadata: { linkedUserId: normalizedUserId },
      });

      return await loadPatientDetail(tx, tenantId, patientId);
    });
  } catch (error) {
    mapPatientWriteError(error);
  }
}

/** Removes the account link without touching the global user account. */
export async function unlinkPatientUser(
  tenantId: string,
  patientId: string,
  actorContext: PatientActorContext,
): Promise<PatientDetailDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    await assertActiveMembership(tx, tenantId, actorContext);
    assertAccountLinkAuthorized(actorContext);

    const current = await findProfile(tx, tenantId, patientId);

    if (current.userId === null) {
      return await loadPatientDetail(tx, tenantId, patientId);
    }

    await tx
      .update(patientProfiles)
      .set({ userId: null })
      .where(
        and(
          eq(patientProfiles.id, patientId),
          eq(patientProfiles.tenantId, tenantId),
          isNull(patientProfiles.deletedAt),
        ),
      );

    recordPatientAudit(actorContext.audit, "patient.account_unlinked", {
      tenantId,
      actorUserId: actorContext.userId,
      patientId,
    });

    await recordAuditSafely(tx, {
      tenantId,
      actorUserId: actorContext.userId,
      action: AUDIT_ACTIONS.PATIENT_ACCOUNT_UNLINKED,
      module: "patients",
      resourceType: "patient",
      resourceId: patientId,
      description: "Patient account unlinked",
      metadata: { unlinkedUserId: current.userId },
    });

    return await loadPatientDetail(tx, tenantId, patientId);
  });
}
