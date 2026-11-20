import { z } from "zod";

const slugSchema = z
  .string()
  .trim()
  .min(2, "Slug must be at least 2 characters")
  .max(100, "Slug must be at most 100 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug may contain lowercase letters, digits and hyphens");

const permissionKeysSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(120, "Too many permissions");

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, "Role name must be at least 2 characters").max(100),
  slug: slugSchema.optional(),
  description: z.string().trim().max(500).optional(),
  permissions: permissionKeysSchema.optional(),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2, "Role name must be at least 2 characters").max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "Provide at least one field to update",
  });

export const setRolePermissionsSchema = z.object({
  permissions: permissionKeysSchema,
});

export const assignMembershipRolesSchema = z.object({
  roleIds: z.array(z.uuid("Role ids must be UUIDs")).max(50),
});

export const roleIdParamsSchema = z.object({
  roleId: z.uuid("Role id must be a UUID"),
});

export const membershipIdParamsSchema = z.object({
  membershipId: z.uuid("Membership id must be a UUID"),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsSchema>;
export type AssignMembershipRolesInput = z.infer<typeof assignMembershipRolesSchema>;
