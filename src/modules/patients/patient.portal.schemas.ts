import { z } from "zod";
import { emailSchema } from "../auth/auth.schemas.js";
import { passwordSchema } from "../auth/auth.password.js";
import { TENANT_SLUG_PATTERN } from "../../lib/slug.js";
import { patientDateOfBirthSchema } from "./patient.schemas.js";

const hospitalSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Hospital is required")
  .max(100, "Hospital slug is too long")
  .regex(TENANT_SLUG_PATTERN, "Enter a valid hospital slug");

const emptyStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

const phoneSchema = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .trim()
    .min(6, "Phone must be at least 6 characters")
    .max(20, "Phone must be at most 20 characters")
    .regex(/^\+?[0-9][0-9\s().-]{5,30}$/, "Enter a valid phone number")
    .nullable()
    .optional(),
);

const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Full name is required")
  .max(200, "Full name must be at most 200 characters");

const genderSchema = z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]);

/**
 * Public self-registration. `.strict()` is deliberate: roles, tenant ids,
 * memberships, patient codes and workflow fields are rejected rather than
 * silently ignored.
 */
export const publicPatientRegistrationSchema = z
  .object({
    hospitalSlug: hospitalSlugSchema,
    fullName: fullNameSchema,
    email: emailSchema,
    password: passwordSchema,
    phone: phoneSchema,
    dateOfBirth: patientDateOfBirthSchema.nullable().optional(),
    gender: genderSchema.optional(),
  })
  .strict();

/** Authenticated link of the current global account to another hospital. */
export const linkPatientAccountSchema = z
  .object({
    hospitalSlug: hospitalSlugSchema,
    fullName: fullNameSchema.optional(),
    phone: phoneSchema,
    dateOfBirth: patientDateOfBirthSchema.nullable().optional(),
    gender: genderSchema.optional(),
  })
  .strict();

export const patientPortalHospitalParamsSchema = z.object({
  hospitalSlug: hospitalSlugSchema,
});

export type PublicPatientRegistrationInput = z.infer<
  typeof publicPatientRegistrationSchema
>;
export type LinkPatientAccountInput = z.infer<typeof linkPatientAccountSchema>;
export type PatientPortalHospitalParams = z.infer<
  typeof patientPortalHospitalParamsSchema
>;
