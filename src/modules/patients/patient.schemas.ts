import { z } from "zod";

/**
 * Request validation for the patient profile API (Task 17.5).
 *
 * These schemas only check transport-level shape. Normalisation, tenant
 * ownership, account-link authorization, status transitions and every other
 * business rule stay in `patient.service.ts`, so validation cannot drift from
 * the rules the service actually enforces.
 *
 * Every body schema is `.strict()`: `tenantId`, `patientCode`, `status`,
 * `userId` on updates and any other client-controlled field is a 422 instead of
 * being silently ignored.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const GENDERS = ["MALE", "FEMALE", "OTHER", "UNKNOWN"] as const;
const BLOOD_GROUPS = [
  "A_POSITIVE",
  "A_NEGATIVE",
  "B_POSITIVE",
  "B_NEGATIVE",
  "AB_POSITIVE",
  "AB_NEGATIVE",
  "O_POSITIVE",
  "O_NEGATIVE",
] as const;
const MARITAL_STATUSES = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER"] as const;
const PATIENT_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED", "DECEASED"] as const;
/** Statuses this API may assign. `DECEASED` is a clinical workflow. */
const SETTABLE_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
const CONTACT_TYPES = ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"] as const;
const ADDRESS_TYPES = ["HOME", "WORK", "OTHER"] as const;

/** Accepts `""` as "not supplied" so optional fields can be cleared. */
const emptyStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

export const patientDateSchema = z
  .string()
  .trim()
  .regex(DATE_PATTERN, "Date must be an ISO calendar date (YYYY-MM-DD)")
  .refine((value) => {
    const match = DATE_PATTERN.exec(value);
    if (!match) return false;

    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Date must be a valid calendar date");

export const patientDateOfBirthSchema = patientDateSchema.refine(
  (value) => value <= new Date().toISOString().slice(0, 10),
  "Date of birth cannot be in the future",
);

const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Full name is required")
  .max(200, "Full name must be at most 200 characters");

/**
 * Only a private object-storage key is accepted. A URL, an absolute path or a
 * traversal segment is rejected here as well as in the service.
 */
const profileImageKeySchema = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .trim()
    .min(1)
    .max(512, "Profile image key must be at most 512 characters")
    .refine(
      (value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
      "Profile image key must be a private storage path, not a URL",
    )
    .refine(
      (value) =>
        !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
      "Profile image key must be a relative private storage path",
    )
    .nullable()
    .optional(),
);

const phoneSchema = z.preprocess(
  emptyStringToNull,
  z.string().trim().min(7, "Phone number is too short").max(20, "Phone number is too long").nullable().optional(),
);

const emailSchema = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .trim()
    .max(320, "Email must be at most 320 characters")
    .pipe(z.email("Enter a valid email address"))
    .nullable()
    .optional(),
);

const countrySchema = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Country must be a two-letter ISO 3166-1 code")
    .nullable()
    .optional(),
);

const patientContactInputSchema = z
  .object({
    contactType: z.enum(CONTACT_TYPES).optional(),
    phone: phoneSchema,
    email: emailSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.phone != null || value.email != null,
    { message: "Each contact needs a phone number or an email address", path: ["phone"] },
  );

const patientAddressInputSchema = z
  .object({
    addressType: z.enum(ADDRESS_TYPES).optional(),
    addressLine1: z
      .string()
      .trim()
      .min(1, "Address line 1 is required")
      .max(255, "Address line 1 must be at most 255 characters"),
    addressLine2: z.string().trim().max(255).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    country: countrySchema,
    isPrimary: z.boolean().optional(),
  })
  .strict();

const patientEmergencyContactInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Emergency contact name is required")
      .max(200, "Emergency contact name must be at most 200 characters"),
    relationship: z
      .string()
      .trim()
      .min(1, "Emergency contact relationship is required")
      .max(60, "Emergency contact relationship must be at most 60 characters"),
    phone: z
      .string()
      .trim()
      .min(7, "Emergency contact phone is required")
      .max(20, "Emergency contact phone is too long"),
    email: emailSchema,
  })
  .strict();

/**
 * Registration body.
 *
 * Contacts, addresses and emergency contacts are accepted inline because the
 * patient is created with them in one transaction; this is not the separate
 * contact-management API. `isVerified` is not exposed: verification is not
 * client-controlled.
 */
export const createPatientSchema = z
  .object({
    fullName: fullNameSchema,
    dateOfBirth: patientDateOfBirthSchema.nullable().optional(),
    gender: z.enum(GENDERS).optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    maritalStatus: z.enum(MARITAL_STATUSES).nullable().optional(),
    profileImageKey: profileImageKeySchema,
    userId: z.uuid("User id must be a UUID").nullable().optional(),
    contacts: z.array(patientContactInputSchema).max(20).optional(),
    addresses: z.array(patientAddressInputSchema).max(20).optional(),
    emergencyContacts: z
      .array(patientEmergencyContactInputSchema)
      .max(10)
      .optional(),
  })
  .strict();

/** Profile fields only: status, patient code, tenant and account link are not patchable. */
export const updatePatientSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    dateOfBirth: patientDateOfBirthSchema.nullable().optional(),
    gender: z.enum(GENDERS).optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    maritalStatus: z.enum(MARITAL_STATUSES).nullable().optional(),
    profileImageKey: profileImageKeySchema,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

export const updatePatientStatusSchema = z
  .object({
    status: z.enum(SETTABLE_STATUSES, "Patient status must be ACTIVE, INACTIVE or ARCHIVED"),
  })
  .strict();

export const patientIdParamsSchema = z.object({
  patientId: z.uuid("Patient id must be a UUID"),
});

/**
 * Listing and search parameters. `dateFrom` / `dateTo` are inclusive
 * registration-date bounds and map to the service's `registeredFrom` /
 * `registeredTo` filters.
 */
export const listPatientsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
    search: z
      .string()
      .trim()
      .max(100, "Search must be at most 100 characters")
      .optional(),
    status: z.enum(PATIENT_STATUSES, "Unknown patient status").optional(),
    gender: z.enum(GENDERS, "Unknown patient gender").optional(),
    dateFrom: patientDateSchema.optional(),
    dateTo: patientDateSchema.optional(),
  })
  .refine(
    (value) =>
      value.dateFrom === undefined ||
      value.dateTo === undefined ||
      value.dateFrom <= value.dateTo,
    {
      message: "dateFrom must be on or before dateTo",
      path: ["dateTo"],
    },
  );

export type CreatePatientBody = z.infer<typeof createPatientSchema>;
export type UpdatePatientBody = z.infer<typeof updatePatientSchema>;
export type UpdatePatientStatusBody = z.infer<typeof updatePatientStatusSchema>;
export type PatientIdParams = z.infer<typeof patientIdParamsSchema>;
export type ListPatientsQuery = z.infer<typeof listPatientsQuerySchema>;

/* -------------------------------------------------------------------------
 * Task 17.6 - contact, address and emergency-contact child records
 *
 * Bodies are `.strict()`, so `isVerified`, `tenantId`, `patientId`, row ids and
 * any other protected or unexpected property are a 422. Verification is never
 * client-controlled; the services also refuse the flag explicitly.
 * ---------------------------------------------------------------------- */

/** At least one mutable field must be present on a partial update. */
const requireAtLeastOneField = (value: Record<string, unknown>): boolean =>
  Object.keys(value).length > 0;

export const addPatientContactSchema = z
  .object({
    contactType: z.enum(CONTACT_TYPES, "Contact type is not recognised").optional(),
    phone: phoneSchema,
    email: emailSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.phone != null || value.email != null,
    { message: "A contact needs a phone number or an email address", path: ["phone"] },
  );

export const updatePatientContactSchema = z
  .object({
    contactType: z.enum(CONTACT_TYPES, "Contact type is not recognised").optional(),
    phone: phoneSchema,
    email: emailSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine(requireAtLeastOneField, "At least one field is required");

export const patientContactParamsSchema = z.object({
  patientId: z.uuid("Patient id must be a UUID"),
  contactId: z.uuid("Contact id must be a UUID"),
});

export const addPatientAddressSchema = z
  .object({
    addressType: z.enum(ADDRESS_TYPES, "Address type must be HOME, WORK or OTHER").optional(),
    addressLine1: z
      .string()
      .trim()
      .min(1, "Address line 1 is required")
      .max(255, "Address line 1 must be at most 255 characters"),
    addressLine2: z.preprocess(
      emptyStringToNull,
      z.string().trim().max(255).nullable().optional(),
    ),
    city: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
    state: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
    postalCode: z.preprocess(
      emptyStringToNull,
      z.string().trim().max(20, "Postal code must be at most 20 characters").nullable().optional(),
    ),
    country: countrySchema,
    isPrimary: z.boolean().optional(),
  })
  .strict();

export const updatePatientAddressSchema = z
  .object({
    addressType: z.enum(ADDRESS_TYPES, "Address type must be HOME, WORK or OTHER").optional(),
    addressLine1: z
      .string()
      .trim()
      .min(1, "Address line 1 is required")
      .max(255, "Address line 1 must be at most 255 characters")
      .optional(),
    addressLine2: z.preprocess(
      emptyStringToNull,
      z.string().trim().max(255).nullable().optional(),
    ),
    city: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
    state: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
    postalCode: z.preprocess(
      emptyStringToNull,
      z.string().trim().max(20, "Postal code must be at most 20 characters").nullable().optional(),
    ),
    country: countrySchema,
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine(requireAtLeastOneField, "At least one field is required");

export const patientAddressParamsSchema = z.object({
  patientId: z.uuid("Patient id must be a UUID"),
  addressId: z.uuid("Address id must be a UUID"),
});

export const addPatientEmergencyContactSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Emergency contact name is required")
      .max(200, "Emergency contact name must be at most 200 characters"),
    relationship: z
      .string()
      .trim()
      .min(1, "Emergency contact relationship is required")
      .max(60, "Emergency contact relationship must be at most 60 characters"),
    phone: z
      .string()
      .trim()
      .min(7, "Emergency contact phone is required")
      .max(20, "Emergency contact phone is too long"),
    email: emailSchema,
  })
  .strict();

export const updatePatientEmergencyContactSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Emergency contact name is required")
      .max(200, "Emergency contact name must be at most 200 characters")
      .optional(),
    relationship: z
      .string()
      .trim()
      .min(1, "Emergency contact relationship is required")
      .max(60, "Emergency contact relationship must be at most 60 characters")
      .optional(),
    phone: z
      .string()
      .trim()
      .min(7, "Emergency contact phone is required")
      .max(20, "Emergency contact phone is too long")
      .optional(),
    email: emailSchema,
  })
  .strict()
  .refine(requireAtLeastOneField, "At least one field is required");

export const patientEmergencyContactParamsSchema = z.object({
  patientId: z.uuid("Patient id must be a UUID"),
  emergencyContactId: z.uuid("Emergency contact id must be a UUID"),
});

export type AddPatientContactBody = z.infer<typeof addPatientContactSchema>;
export type UpdatePatientContactBody = z.infer<typeof updatePatientContactSchema>;
export type AddPatientAddressBody = z.infer<typeof addPatientAddressSchema>;
export type UpdatePatientAddressBody = z.infer<typeof updatePatientAddressSchema>;
export type AddPatientEmergencyContactBody = z.infer<
  typeof addPatientEmergencyContactSchema
>;
export type UpdatePatientEmergencyContactBody = z.infer<
  typeof updatePatientEmergencyContactSchema
>;
