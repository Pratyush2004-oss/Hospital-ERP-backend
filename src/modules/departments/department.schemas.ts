import { z } from "zod";
import { slugify } from "../../lib/slug.js";

export const DEPARTMENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const departmentSlugSchema = z
  .string()
  .trim()
  .min(2, "Department slug is too short")
  .max(150)
  .transform((value) => slugify(value))
  .refine(
    (value) => value.length >= 2 && value.length <= 120 && DEPARTMENT_SLUG_PATTERN.test(value),
    "Enter a valid department slug",
  );

const departmentNameSchema = z
  .string()
  .trim()
  .min(2, "Department name is required")
  .max(150, "Department name must be at most 150 characters");

const descriptionSchema = z
  .string()
  .trim()
  .max(2000, "Description must be at most 2000 characters")
  .nullable()
  .optional();

const branchIdsSchema = z.array(z.uuid("Branch id must be a UUID")).max(50);

export const createDepartmentSchema = z.object({
  name: departmentNameSchema,
  slug: departmentSlugSchema.optional(),
  description: descriptionSchema,
  branchIds: branchIdsSchema.optional(),
  isActive: z.boolean().optional(),
});

export const updateDepartmentSchema = z
  .object({
    name: departmentNameSchema.optional(),
    slug: departmentSlugSchema.optional(),
    description: descriptionSchema,
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const updateDepartmentBranchesSchema = z.object({
  branchIds: branchIdsSchema,
});

export const updateDepartmentStatusSchema = z.object({
  isActive: z.boolean(),
});

export const departmentIdParamsSchema = z.object({
  id: z.uuid("Department id must be a UUID"),
});

export const listDepartmentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  branchId: z.uuid("Branch id must be a UUID").optional(),
  sortBy: z.enum(["name", "slug", "createdAt", "updatedAt"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateDepartmentBody = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentBody = z.infer<typeof updateDepartmentSchema>;
export type UpdateDepartmentBranchesBody = z.infer<typeof updateDepartmentBranchesSchema>;
export type UpdateDepartmentStatusBody = z.infer<typeof updateDepartmentStatusSchema>;
export type DepartmentIdParams = z.infer<typeof departmentIdParamsSchema>;
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuerySchema>;
