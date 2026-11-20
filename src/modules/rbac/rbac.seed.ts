import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database/context.js";
import { permissions, rolePermissions, roles } from "../../database/schema/index.js";
import {
  HOSPITAL_ROLE_DEFINITIONS,
  PLATFORM_ROLE_DEFINITIONS,
  PERMISSION_CATALOGUE,
  type PermissionKey,
  type RoleDefinition,
} from "./rbac.catalogue.js";

/**
 * Applies the RBAC catalogue to the database. Idempotent: safe to run on every
 * deploy and on every tenant provisioning.
 *
 * The permission catalogue is global, so it is upserted once. Roles are then
 * seeded per plane:
 * - platform roles with `tenant_id = NULL`, once for the whole installation;
 * - hospital system roles with the tenant's id, once per hospital.
 */
export async function seedRbacCatalogue(db: DbExecutor): Promise<void> {
  await seedPermissionCatalogue(db);
  await seedRoles(db, null, PLATFORM_ROLE_DEFINITIONS);
}

/** Seeds the `is_system` hospital roles for one tenant. */
export async function seedTenantRbac(db: DbExecutor, tenantId: string): Promise<void> {
  await seedPermissionCatalogue(db);
  await seedRoles(db, tenantId, HOSPITAL_ROLE_DEFINITIONS);
}

/** Upserts every catalogue permission and returns key -> id. */
export async function seedPermissionCatalogue(
  db: DbExecutor,
): Promise<Map<PermissionKey, string>> {
  const rows = PERMISSION_CATALOGUE.map((permission) => ({
    permissionKey: permission.key,
    module: permission.module,
    description: permission.description,
  }));

  const inserted = await db
    .insert(permissions)
    .values(rows)
    .onConflictDoUpdate({
      target: permissions.permissionKey,
      set: {
        module: sql`excluded.module`,
        description: sql`excluded.description`,
      },
    })
    .returning({ id: permissions.id, permissionKey: permissions.permissionKey });

  return new Map(inserted.map((row) => [row.permissionKey as PermissionKey, row.id]));
}

async function seedRoles(
  db: DbExecutor,
  tenantId: string | null,
  definitions: readonly RoleDefinition[],
): Promise<void> {
  const permissionIds = await seedPermissionCatalogue(db);

  for (const definition of definitions) {
    const tenantMatch = tenantId === null ? isNull(roles.tenantId) : eq(roles.tenantId, tenantId);

    const [existing] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.slug, definition.slug), tenantMatch))
      .limit(1);

    const values = {
      tenantId,
      scope: tenantId === null ? ("PLATFORM" as const) : ("HOSPITAL" as const),
      name: definition.name,
      slug: definition.slug,
      description: definition.description,
      isSystem: true,
    };

    let roleId = existing?.id;

    if (roleId) {
      await db.update(roles).set(values).where(eq(roles.id, roleId));
    } else {
      const [created] = await db.insert(roles).values(values).returning({ id: roles.id });
      roleId = created?.id;
    }

    if (!roleId) {
      continue;
    }

    const grants = definition.permissions.flatMap((key) => {
      const permissionId = permissionIds.get(key);
      return permissionId ? [{ roleId, permissionId }] : [];
    });

    if (grants.length > 0) {
      await db.insert(rolePermissions).values(grants).onConflictDoNothing();
    }
  }
}
