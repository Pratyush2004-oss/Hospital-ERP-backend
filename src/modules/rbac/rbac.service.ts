import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  membershipRoles,
  permissions,
  platformUserRoles,
  rolePermissions,
  roles,
  tenantMemberships,
  users,
} from "../../database/schema/index.js";
import {
  withPlatformTransaction,
  withTenantTransaction,
  type DbExecutor,
} from "../../database/context.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely } from "../audit/audit.service.js";
import { slugify } from "../../lib/slug.js";
import { PERMISSION_CATALOGUE, type PermissionKey } from "./rbac.catalogue.js";
import type {
  AssignMembershipRolesInput,
  CreateRoleInput,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from "./rbac.schemas.js";

/**
 * Tenant RBAC service.
 *
 * Every tenant-scoped query runs inside a transaction that sets the RLS tenant
 * context, so a bug in a WHERE clause cannot read another hospital's roles or
 * grants. Platform role resolution runs in the platform context.
 */

export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export interface PermissionSummary {
  readonly key: string;
  readonly module: string;
  readonly description: string | null;
}

export interface MembershipRoleSummary {
  readonly id: string;
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: string;
  readonly joinedAt: Date | null;
  readonly roles: readonly { id: string; slug: string; name: string }[];
}

export interface ResolvedPermissions {
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

const SYSTEM_ROLE_IMMUTABLE = "Seeded system roles cannot be modified";

async function rolePermissionMap(
  tx: DbExecutor,
  tenantId: string,
): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ roleId: rolePermissions.roleId, key: permissions.permissionKey })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .innerJoin(roles, eq(rolePermissions.roleId, roles.id))
    .where(eq(roles.tenantId, tenantId));

  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const list = grouped.get(row.roleId) ?? [];
    list.push(row.key);
    grouped.set(row.roleId, list);
  }

  return grouped;
}

function toRoleSummary(
  role: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isSystem: boolean;
  },
  granted: readonly string[],
): RoleSummary {
  return { ...role, permissions: [...granted].sort() };
}

/** The global permission catalogue understood by the product. */
export function listPermissions(): readonly PermissionSummary[] {
  return PERMISSION_CATALOGUE.map((permission) => ({
    key: permission.key,
    module: permission.module,
    description: permission.description,
  }));
}

export async function listRoles(tenantId: string): Promise<readonly RoleSummary[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        description: roles.description,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.scope, "HOSPITAL")))
      .orderBy(desc(roles.isSystem), asc(roles.name));

    const grants = await rolePermissionMap(tx, tenantId);

    return rows.map((role) => toRoleSummary(role, grants.get(role.id) ?? []));
  });
}

async function normalizePermissionKeys(
  tx: DbExecutor,
  keys: readonly string[],
): Promise<readonly string[]> {
  const unique = [...new Set(keys)];

  if (unique.length === 0) return [];

  const rows = await tx
    .select({ key: permissions.permissionKey })
    .from(permissions)
    .where(inArray(permissions.permissionKey, unique));

  if (rows.length !== unique.length) {
    const known = new Set(rows.map((row) => row.key));
    const unknown = unique.filter((key) => !known.has(key));
    throw AppError.badRequest(`Unknown permissions: ${unknown.join(", ")}`);
  }

  return unique;
}

async function ensureCustomRole(
  tx: DbExecutor,
  tenantId: string,
  roleId: string,
): Promise<{ id: string; name: string; slug: string; description: string | null; isSystem: boolean }> {
  const [role] = await tx
    .select({
      id: roles.id,
      name: roles.name,
      slug: roles.slug,
      description: roles.description,
      isSystem: roles.isSystem,
    })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
    .limit(1);

  if (!role) {
    throw AppError.notFound("Role not found");
  }

  if (role.isSystem) {
    throw AppError.conflict(SYSTEM_ROLE_IMMUTABLE);
  }

  return role;
}

async function roleSlugForCreate(
  tx: DbExecutor,
  tenantId: string,
  requested: string | undefined,
  name: string,
): Promise<string> {
  const base = slugify(requested ?? name) || "role";

  if (requested !== undefined) {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, base)))
      .limit(1);

    if (existing) {
      throw AppError.conflict("A role with this slug already exists");
    }

    return base;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;

    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, candidate)))
      .limit(1);

    if (!existing) return candidate;
  }

  throw AppError.conflict("Could not allocate a unique role slug");
}

export async function createRole(
  tenantId: string,
  input: CreateRoleInput,
): Promise<RoleSummary> {
  return withTenantTransaction(tenantId, async (tx) => {
    const slug = await roleSlugForCreate(tx, tenantId, input.slug, input.name);

    const [created] = await tx
      .insert(roles)
      .values({
        tenantId,
        scope: "HOSPITAL",
        name: input.name,
        slug,
        description: input.description ?? null,
        isSystem: false,
      })
      .returning({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        description: roles.description,
        isSystem: roles.isSystem,
      });

    if (!created) {
      throw AppError.internal("Failed to create role");
    }

    const keys = await normalizePermissionKeys(tx, input.permissions ?? []);

    if (keys.length > 0) {
      const grants = await tx
        .select({ id: permissions.id, key: permissions.permissionKey })
        .from(permissions)
        .where(inArray(permissions.permissionKey, [...keys]));

      await tx
        .insert(rolePermissions)
        .values(grants.map((row) => ({ roleId: created.id, permissionId: row.id })));
    }

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.ROLE_CREATED,
      module: "rbac",
      resourceType: "role",
      resourceId: created.id,
      description: "Custom role created",
      newState: { slug: created.slug, name: created.name, permissions: keys },
    });

    return toRoleSummary(created, keys);
  });
}

export async function updateRole(
  tenantId: string,
  roleId: string,
  input: UpdateRoleInput,
): Promise<RoleSummary> {
  return withTenantTransaction(tenantId, async (tx) => {
    await ensureCustomRole(tx, tenantId, roleId);

    const [updated] = await tx
      .update(roles)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      })
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
      .returning({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        description: roles.description,
        isSystem: roles.isSystem,
      });

    if (!updated) {
      throw AppError.notFound("Role not found");
    }

    const grants = await rolePermissionMap(tx, tenantId);

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.ROLE_UPDATED,
      module: "rbac",
      resourceType: "role",
      resourceId: updated.id,
      description: "Custom role updated",
      newState: { name: updated.name, description: updated.description },
    });

    return toRoleSummary(updated, grants.get(updated.id) ?? []);
  });
}

export async function deleteRole(tenantId: string, roleId: string): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await ensureCustomRole(tx, tenantId, roleId);

    await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.ROLE_DELETED,
      module: "rbac",
      resourceType: "role",
      resourceId: roleId,
      description: "Custom role deleted",
    });
  });
}

export async function setRolePermissions(
  tenantId: string,
  roleId: string,
  input: SetRolePermissionsInput,
): Promise<RoleSummary> {
  return withTenantTransaction(tenantId, async (tx) => {
    const role = await ensureCustomRole(tx, tenantId, roleId);
    const keys = await normalizePermissionKeys(tx, input.permissions);

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

    if (keys.length > 0) {
      const grants = await tx
        .select({ id: permissions.id })
        .from(permissions)
        .where(inArray(permissions.permissionKey, [...keys]));

      await tx
        .insert(rolePermissions)
        .values(grants.map((row) => ({ roleId, permissionId: row.id })));
    }

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
      module: "rbac",
      resourceType: "role",
      resourceId: roleId,
      description: "Role permissions replaced",
      newState: { permissions: keys },
    });

    return toRoleSummary(role, keys);
  });
}

export async function listTenantMemberships(
  tenantId: string,
): Promise<readonly MembershipRoleSummary[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const members = await tx
      .select({
        id: tenantMemberships.id,
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        status: tenantMemberships.status,
        joinedAt: tenantMemberships.joinedAt,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(tenantMemberships.userId, users.id))
      .where(eq(tenantMemberships.tenantId, tenantId))
      .orderBy(asc(users.fullName));

    const grants = await tx
      .select({
        membershipId: membershipRoles.tenantMembershipId,
        roleId: roles.id,
        slug: roles.slug,
        name: roles.name,
      })
      .from(membershipRoles)
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(eq(membershipRoles.tenantId, tenantId));

    const rolesByMembership = new Map<string, { id: string; slug: string; name: string }[]>();

    for (const grant of grants) {
      const list = rolesByMembership.get(grant.membershipId) ?? [];
      list.push({ id: grant.roleId, slug: grant.slug, name: grant.name });
      rolesByMembership.set(grant.membershipId, list);
    }

    return members.map((member) => ({
      ...member,
      roles: rolesByMembership.get(member.id) ?? [],
    }));
  });
}

/** Replaces a membership's roles. Empty input removes all access roles. */
export async function assignMembershipRoles(
  tenantId: string,
  membershipId: string,
  input: AssignMembershipRolesInput,
  assignedBy: string,
): Promise<MembershipRoleSummary> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [membership] = await tx
      .select({
        id: tenantMemberships.id,
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
        phone: users.phone,
        status: tenantMemberships.status,
        joinedAt: tenantMemberships.joinedAt,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(tenantMemberships.userId, users.id))
      .where(
        and(
          eq(tenantMemberships.id, membershipId),
          eq(tenantMemberships.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!membership) {
      throw AppError.notFound("Membership not found");
    }

    const roleIds = [...new Set(input.roleIds)];

    if (roleIds.length > 0) {
      const validRoles = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(
          and(
            eq(roles.tenantId, tenantId),
            eq(roles.scope, "HOSPITAL"),
            inArray(roles.id, roleIds),
          ),
        );

      if (validRoles.length !== roleIds.length) {
        throw AppError.badRequest("One or more roles do not belong to this hospital");
      }
    }

    await tx
      .delete(membershipRoles)
      .where(
        and(
          eq(membershipRoles.tenantId, tenantId),
          eq(membershipRoles.tenantMembershipId, membershipId),
        ),
      );

    if (roleIds.length > 0) {
      await tx.insert(membershipRoles).values(
        roleIds.map((roleId) => ({
          tenantId,
          tenantMembershipId: membershipId,
          roleId,
          assignedBy,
        })),
      );
    }

    const granted = await tx
      .select({ id: roles.id, slug: roles.slug, name: roles.name })
      .from(membershipRoles)
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(
          eq(membershipRoles.tenantId, tenantId),
          eq(membershipRoles.tenantMembershipId, membershipId),
        ),
      );

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.MEMBERSHIP_ROLES_CHANGED,
      module: "rbac",
      resourceType: "membership",
      resourceId: membershipId,
      description: "Membership roles replaced",
      metadata: { roleIds, assignedBy },
      newState: { roles: granted.map((role) => role.slug) },
    });

    return { ...membership, roles: granted };
  });
}

/**
 * Centralized permission resolution for a hospital membership: role slugs plus
 * the flattened `module:action` set. Used by the authentication middleware and
 * reusable permission guards.
 */
export async function loadMembershipPermissions(
  tx: DbExecutor,
  tenantId: string,
  membershipId: string,
): Promise<ResolvedPermissions> {
  const roleRows = await tx
    .select({ slug: roles.slug })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(
      and(
        eq(membershipRoles.tenantId, tenantId),
        eq(membershipRoles.tenantMembershipId, membershipId),
      ),
    );

  const permissionRows = await tx
    .selectDistinct({ key: permissions.permissionKey })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        eq(membershipRoles.tenantId, tenantId),
        eq(membershipRoles.tenantMembershipId, membershipId),
      ),
    );

  return {
    roles: roleRows.map((row) => row.slug),
    permissions: new Set<string>(permissionRows.map((row) => row.key)),
  };
}

/** Platform-plane roles and permissions, or null when the user has none. */
export async function resolvePlatformPermissions(
  userId: string,
): Promise<ResolvedPermissions | null> {
  return withPlatformTransaction(async (tx) => {
    const roleRows = await tx
      .select({ slug: roles.slug })
      .from(platformUserRoles)
      .innerJoin(roles, eq(platformUserRoles.roleId, roles.id))
      .where(and(eq(platformUserRoles.userId, userId), eq(roles.scope, "PLATFORM")));

    if (roleRows.length === 0) return null;

    const permissionRows = await tx
      .selectDistinct({ key: permissions.permissionKey })
      .from(platformUserRoles)
      .innerJoin(roles, eq(platformUserRoles.roleId, roles.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(and(eq(platformUserRoles.userId, userId), eq(roles.scope, "PLATFORM")));

    return {
      roles: roleRows.map((row) => row.slug),
      permissions: new Set<string>(permissionRows.map((row) => row.key)),
    };
  });
}

/** Exposed for tests/tooling that need to check a key against the catalogue. */
export function isCataloguePermission(key: string): key is PermissionKey {
  return PERMISSION_CATALOGUE.some((permission) => permission.key === key);
}
