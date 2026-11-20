/**
 * Patient registration and profile service types (Task 17.2).
 *
 * Service inputs and outputs only: HTTP routes, controllers and Zod request
 * schemas are deliberately out of scope. Contacts, addresses and emergency
 * contacts are supplied inline at registration so the profile and its children
 * are created in one transaction; that is not a contact-management API.
 */

import type { PatientAuditSink } from "./patient.audit.js";

export type PatientGender = "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";

export type PatientBloodGroup =
  | "A_POSITIVE"
  | "A_NEGATIVE"
  | "B_POSITIVE"
  | "B_NEGATIVE"
  | "AB_POSITIVE"
  | "AB_NEGATIVE"
  | "O_POSITIVE"
  | "O_NEGATIVE";

export type PatientMaritalStatus = "SINGLE" | "MARRIED" | "DIVORCED" | "WIDOWED" | "OTHER";

/** `DECEASED` exists in the database enum but is not settable here. */
export type PatientStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED" | "DECEASED";

/** Statuses this service may assign. `DECEASED` is a clinical workflow. */
export type SettablePatientStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

export type PatientContactType = "MOBILE" | "HOME" | "WORK" | "GUARDIAN" | "OTHER";

export type PatientAddressType = "HOME" | "WORK" | "OTHER";

export type PatientSortField =
  | "fullName"
  | "patientCode"
  | "createdAt"
  | "updatedAt";

/**
 * Verified caller identity. `userId` must come from the authenticated request
 * context, never from a request body. `permissions` is the resolved RBAC set;
 * it is optional so internal callers can represent a context whose permissions
 * are not relevant to the operation (a plain registration without an
 * account link). `audit` is an optional sink override; the structured logger
 * is used when it is absent.
 */
export interface PatientActorContext {
  readonly userId: string;
  readonly permissions?: ReadonlySet<string>;
  readonly audit?: PatientAuditSink;
}

/**
 * Minimal linked-account identity. Deliberately excludes email, phone, password
 * hash and verification timestamps: the patient profile must not become a
 * window into another person's global account.
 */
export interface PatientAccountSummary {
  readonly id: string;
  readonly fullName: string;
  readonly isActive: boolean;
}

/** One phone/email record. At least one of `phone` and `email` is present. */
export interface PatientContactDto {
  readonly id: string;
  readonly contactType: PatientContactType;
  readonly phone: string | null;
  readonly email: string | null;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PatientAddressDto {
  readonly id: string;
  readonly addressType: PatientAddressType;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  /** ISO 3166-1 alpha-2, matching `branches.country`. */
  readonly country: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PatientEmergencyContactDto {
  readonly id: string;
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Patient profile without children; `user` is `null` when unlinked. */
export interface PatientProfileDto {
  readonly id: string;
  readonly patientCode: string;
  readonly fullName: string;
  /** Calendar date (`YYYY-MM-DD`); unknown birth dates are normal. */
  readonly dateOfBirth: string | null;
  readonly gender: PatientGender;
  readonly bloodGroup: PatientBloodGroup | null;
  readonly maritalStatus: PatientMaritalStatus | null;
  /** Private object-storage key, never a public URL. */
  readonly profileImageKey: string | null;
  readonly status: PatientStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user: PatientAccountSummary | null;
}

export interface PatientDetailDto extends PatientProfileDto {
  readonly contacts: readonly PatientContactDto[];
  readonly addresses: readonly PatientAddressDto[];
  readonly emergencyContacts: readonly PatientEmergencyContactDto[];
}

/**
 * List projection: identity only. Contacts, documents and any future clinical
 * data stay out of list responses on purpose.
 */
export interface PatientSummaryDto {
  readonly id: string;
  readonly patientCode: string;
  readonly fullName: string;
  readonly dateOfBirth: string | null;
  readonly gender: PatientGender;
  readonly bloodGroup: PatientBloodGroup | null;
  readonly status: PatientStatus;
  readonly accountLinked: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PatientListResult {
  readonly patients: readonly PatientSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface PatientContactInput {
  readonly contactType?: PatientContactType;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly isPrimary?: boolean;
  readonly isVerified?: boolean;
}

export interface PatientAddressInput {
  readonly addressType?: PatientAddressType;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly isPrimary?: boolean;
}

export interface PatientEmergencyContactInput {
  readonly name: string;
  /** Required by the schema; format validation happens here, not in the DB. */
  readonly relationship: string;
  readonly phone: string;
  readonly email?: string | null;
}

export interface CreatePatientInput {
  readonly fullName: string;
  readonly dateOfBirth?: string | Date | null;
  readonly gender?: PatientGender;
  readonly bloodGroup?: PatientBloodGroup | null;
  readonly maritalStatus?: PatientMaritalStatus | null;
  readonly profileImageKey?: string | null;
  /**
   * Optional existing global account. Linking is an authorized operation, not a
   * side effect of matching contact details.
   */
  readonly userId?: string | null;
  readonly contacts?: readonly PatientContactInput[];
  readonly addresses?: readonly PatientAddressInput[];
  readonly emergencyContacts?: readonly PatientEmergencyContactInput[];
}

/**
 * Contact management inputs (Task 17.3).
 *
 * The schema stores the channel split into `phone` and `email` columns: a phone
 * contact sets `phone`, an email contact sets `email`, and a row may carry both
 * (for example the primary reachability row). `contactType` is the purpose, not
 * the channel.
 *
 * `isVerified` is deliberately absent: verification is not client-controlled,
 * and any payload carrying the flag is rejected at runtime.
 */
export interface AddPatientContactInput {
  readonly contactType?: PatientContactType;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly isPrimary?: boolean;
}

export type UpdatePatientContactInput = AddPatientContactInput;

export interface AddPatientAddressInput {
  readonly addressType?: PatientAddressType;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly isPrimary?: boolean;
}

export interface UpdatePatientAddressInput {
  readonly addressType?: PatientAddressType;
  readonly addressLine1?: string;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly isPrimary?: boolean;
}

export interface AddPatientEmergencyContactInput {
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email?: string | null;
}

export interface UpdatePatientEmergencyContactInput {
  readonly name?: string;
  readonly relationship?: string;
  readonly phone?: string;
  readonly email?: string | null;
}

/** Profile fields only. `userId`, `tenantId` and `status` are not updatable here. */
export interface UpdatePatientInput {
  readonly fullName?: string;
  readonly dateOfBirth?: string | Date | null;
  readonly gender?: PatientGender;
  readonly bloodGroup?: PatientBloodGroup | null;
  readonly maritalStatus?: PatientMaritalStatus | null;
  readonly profileImageKey?: string | null;
}

export interface ListPatientsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  /** Matches patient code or full name. */
  readonly search?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly status?: PatientStatus;
  readonly gender?: PatientGender;
  /** Inclusive registration-date bounds. */
  readonly registeredFrom?: Date;
  readonly registeredTo?: Date;
  readonly sortBy?: PatientSortField;
  readonly sortOrder?: "asc" | "desc";
}
