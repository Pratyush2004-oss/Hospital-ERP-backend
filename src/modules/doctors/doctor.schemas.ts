import { z } from "zod";

/**
 * Request validation for the doctor API (Task 15.3).
 *
 * These schemas only check transport-level shape. Business rules — code
 * normalization, uniqueness, membership eligibility, department/branch
 * coverage — stay in the doctor service so validation can never drift from the
 * rules the service actually enforces.
 */

const doctorCodeSchema = z
  .string()
  .trim()
  .min(1, "Doctor code is required")
  .max(50, "Doctor code must be at most 50 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._\s-]*$/,
    "Doctor code may only use letters, digits, dots, hyphens, underscores or spaces",
  );

const registrationNumberSchema = z
  .string()
  .trim()
  .min(3, "Registration number is required")
  .max(80, "Registration number must be at most 80 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/._-]*$/,
    "Enter a valid medical registration number",
  );

const optionalTextSchema = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be at most ${max} characters`).nullable().optional();

const profileImageUrlSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .max(2048, "Profile image URL must be at most 2048 characters")
    .pipe(z.url("Profile image URL must be an absolute http(s) URL"))
    .refine(
      (value) => value.startsWith("http://") || value.startsWith("https://"),
      "Profile image URL must be an absolute http(s) URL",
    )
    .nullable()
    .optional(),
);

const consultationLanguageSchema = z
  .array(z.string().trim().min(1).max(20))
  .max(20, "At most 20 consultation languages are allowed")
  .nullable()
  .optional();

const experienceYearsSchema = z
  .number()
  .int("Experience years must be an integer")
  .min(0, "Experience years cannot be negative")
  .max(70, "Experience years must be at most 70")
  .nullable()
  .optional();

const consultationFeeSchema = z
  .union([
    z
      .number()
      .nonnegative("Consultation fee cannot be negative")
      .max(99_999_999_999, "Consultation fee is too large"),
    z
      .string()
      .trim()
      .regex(
        /^\d{1,10}(?:\.\d{1,2})?$/,
        "Consultation fee must be a non-negative amount with at most two decimal places",
      ),
  ])
  .optional();

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a three-letter ISO 4217 code")
  .optional();

export const doctorBranchAssignmentSchema = z.object({
  branchId: z.uuid("Branch id must be a UUID"),
  consultationFee: consultationFeeSchema,
  currency: currencySchema,
  isActive: z.boolean().optional(),
});

const departmentIdsSchema = z.array(z.uuid("Department id must be a UUID")).max(50);
const branchAssignmentsSchema = z.array(doctorBranchAssignmentSchema).max(50);

export const createDoctorSchema = z.object({
  userId: z.uuid("User id must be a UUID"),
  doctorCode: doctorCodeSchema,
  registrationNumber: registrationNumberSchema,
  registrationCouncil: optionalTextSchema("Registration council", 150),
  qualification: optionalTextSchema("Qualification", 200),
  specialization: optionalTextSchema("Specialization", 150),
  experienceYears: experienceYearsSchema,
  biography: optionalTextSchema("Biography", 5000),
  profileImageUrl: profileImageUrlSchema,
  consultationLanguage: consultationLanguageSchema,
  isActive: z.boolean().optional(),
  departmentIds: departmentIdsSchema.optional(),
  branches: branchAssignmentsSchema.optional(),
});

export const updateDoctorSchema = z
  .object({
    doctorCode: doctorCodeSchema.optional(),
    registrationNumber: registrationNumberSchema.optional(),
    registrationCouncil: optionalTextSchema("Registration council", 150),
    qualification: optionalTextSchema("Qualification", 200),
    specialization: optionalTextSchema("Specialization", 150),
    experienceYears: experienceYearsSchema,
    biography: optionalTextSchema("Biography", 5000),
    profileImageUrl: profileImageUrlSchema,
    consultationLanguage: consultationLanguageSchema,
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const updateDoctorDepartmentsSchema = z.object({
  departmentIds: departmentIdsSchema,
});

export const updateDoctorBranchesSchema = z.object({
  branches: branchAssignmentsSchema,
});

export const updateDoctorStatusSchema = z.object({
  isActive: z.boolean(),
});

export const doctorIdParamsSchema = z.object({
  id: z.uuid("Doctor id must be a UUID"),
});

export const listDoctorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  departmentId: z.uuid("Department id must be a UUID").optional(),
  branchId: z.uuid("Branch id must be a UUID").optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  specialization: z.string().trim().max(150).optional(),
  sortBy: z
    .enum(["fullName", "doctorCode", "registrationNumber", "createdAt", "updatedAt"])
    .default("fullName"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateDoctorBody = z.infer<typeof createDoctorSchema>;
export type UpdateDoctorBody = z.infer<typeof updateDoctorSchema>;
export type UpdateDoctorDepartmentsBody = z.infer<typeof updateDoctorDepartmentsSchema>;
export type UpdateDoctorBranchesBody = z.infer<typeof updateDoctorBranchesSchema>;
export type UpdateDoctorStatusBody = z.infer<typeof updateDoctorStatusSchema>;
export type DoctorIdParams = z.infer<typeof doctorIdParamsSchema>;
export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;
