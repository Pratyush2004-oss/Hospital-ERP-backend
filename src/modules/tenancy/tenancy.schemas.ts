import { z } from "zod";

const tenantSlugSchema = z
  .string()
  .trim()
  .min(3, "Slug must be at least 3 characters")
  .max(100, "Slug must be at most 100 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug may contain lowercase letters, digits and hyphens");

const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")).optional(),
);

const optionalPhoneSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .min(6, "Phone must be at least 6 characters")
    .max(32, "Phone must be at most 32 characters")
    .regex(/^\+?[0-9][0-9\s().-]{5,30}$/, "Enter a valid phone number")
    .optional(),
);

export const registerTenantSchema = z.object({
  name: z.string().trim().min(2, "Hospital name is required").max(200),
  slug: tenantSlugSchema.optional(),
  legalName: z.string().trim().max(255).optional(),
  email: optionalEmailSchema,
  phone: optionalPhoneSchema,
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const selectTenantSchema = z.object({
  slug: tenantSlugSchema,
});

export const tenantIdParamsSchema = z.object({
  tenantId: z.uuid("Tenant id must be a UUID"),
});

export const settingKeyParamsSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Setting key is required")
    .max(100)
    .regex(/^[a-z0-9_.-]+$/, "Setting key may contain lowercase letters, digits, dots, dashes and underscores"),
});

export const updateTenantSettingSchema = z.object({
  // Setting values are stored as JSONB, so only JSON values are accepted.
  value: z.json(),
});

export const platformCreateTenantSchema = z.object({
  name: z.string().trim().min(2, "Hospital name is required").max(200),
  slug: tenantSlugSchema.optional(),
  legalName: z.string().trim().max(255).optional(),
  email: optionalEmailSchema,
  phone: optionalPhoneSchema,
  timezone: z.string().trim().min(1).max(64).optional(),
  adminEmail: optionalEmailSchema,
  status: z.enum(["PENDING", "ACTIVE"]).optional(),
});

export type RegisterTenantInput = z.infer<typeof registerTenantSchema>;
export type SelectTenantInput = z.infer<typeof selectTenantSchema>;
export type PlatformCreateTenantInput = z.infer<typeof platformCreateTenantSchema>;
