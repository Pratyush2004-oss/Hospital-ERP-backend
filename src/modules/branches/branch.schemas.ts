import { z } from "zod";

/** Uppercase, hyphen-separated codes; the service normalizes before uniqueness checks. */
export const BRANCH_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function normalizeBranchCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const branchCodeSchema = z
  .string()
  .trim()
  .min(2, "Branch code must be at least 2 characters")
  .max(50, "Branch code must be at most 50 characters")
  .refine((value) => normalizeBranchCode(value).length >= 2, "Enter a valid branch code")
  .transform(normalizeBranchCode);

const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")).nullable().optional(),
);

const optionalPhoneSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .min(6, "Phone must be at least 6 characters")
    .max(32, "Phone must be at most 32 characters")
    .regex(/^\+?[0-9][0-9\s().-]{5,30}$/, "Enter a valid phone number")
    .nullable()
    .optional(),
);

const optionalAddressSchema = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be at most ${max} characters`).nullable().optional();

const optionalPostalCodeSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .min(2, "Postal code is too short")
    .max(20, "Postal code must be at most 20 characters")
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, "Enter a valid postal code")
    .nullable()
    .optional(),
);

const optionalCountrySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Country must be a 2-letter ISO code")
    .nullable()
    .optional(),
);

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Enter a valid IANA timezone");

const branchFields = {
  name: z.string().trim().min(2, "Branch name is required").max(200),
  contactEmail: optionalEmailSchema,
  contactPhone: optionalPhoneSchema,
  addressLine1: optionalAddressSchema("Address line 1", 255),
  addressLine2: optionalAddressSchema("Address line 2", 255),
  city: optionalAddressSchema("City", 120),
  state: optionalAddressSchema("State", 120),
  postalCode: optionalPostalCodeSchema,
  country: optionalCountrySchema,
  timezone: timezoneSchema.optional(),
};

export const createBranchSchema = z.object({
  name: branchFields.name,
  branchCode: branchCodeSchema,
  contactEmail: branchFields.contactEmail,
  contactPhone: branchFields.contactPhone,
  addressLine1: branchFields.addressLine1,
  addressLine2: branchFields.addressLine2,
  city: branchFields.city,
  state: branchFields.state,
  postalCode: branchFields.postalCode,
  country: branchFields.country,
  timezone: branchFields.timezone,
  isActive: z.boolean().optional(),
});

export const updateBranchSchema = z
  .object({
    name: branchFields.name.optional(),
    branchCode: branchCodeSchema.optional(),
    contactEmail: branchFields.contactEmail,
    contactPhone: branchFields.contactPhone,
    addressLine1: branchFields.addressLine1,
    addressLine2: branchFields.addressLine2,
    city: branchFields.city,
    state: branchFields.state,
    postalCode: branchFields.postalCode,
    country: branchFields.country,
    timezone: branchFields.timezone,
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const updateBranchStatusSchema = z.object({
  isActive: z.boolean(),
});

export const branchIdParamsSchema = z.object({
  id: z.uuid("Branch id must be a UUID"),
});

export const listBranchesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  sortBy: z.enum(["name", "branchCode", "createdAt", "updatedAt"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type UpdateBranchStatusInput = z.infer<typeof updateBranchStatusSchema>;
export type ListBranchesQuery = z.infer<typeof listBranchesQuerySchema>;
export type BranchIdParams = z.infer<typeof branchIdParamsSchema>;
