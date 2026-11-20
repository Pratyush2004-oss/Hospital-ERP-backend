import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  membershipRoles,
  roles,
  tenantMemberships,
} from "../schema/index.js";
import { seedRbacCatalogue, seedTenantRbac } from "../../modules/rbac/rbac.seed.js";
import { hashSeedPassword, upsertUser } from "./helpers.js";
import type { SeededTenancy } from "./tenancy.js";

/**
 * One hospital administrator per sample hospital. These are global users linked
 * to their hospital through `tenant_memberships`, exactly like real staff.
 */
const ADMIN_ACCOUNTS = [
  {
    tenantSlug: "st-marys-general",
    fullName: "Alice Morgan",
    email: "admin@stmarys.test",
    phone: "+1-555-0101",
  },
  {
    tenantSlug: "northside-medical",
    fullName: "Brian Chen",
    email: "admin@northside.test",
    phone: "+1-555-0201",
  },
] as const;

async function requireRoleId(db: Database, tenantId: string, slug: string): Promise<string> {
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, slug)))
    .limit(1);

  if (!role) {
    throw new Error(`Role "${slug}" has not been seeded for tenant ${tenantId}`);
  }

  return role.id;
}

/**
 * Creates or reactivates a membership and grants the given hospital roles.
 *
 * Idempotent through the `(tenant_id, user_id)` and
 * `(tenant_id, membership_id, role_id)` unique indexes, so calling it for an
 * existing member only refreshes status and re-asserts grants.
 */
export async function ensureMembership(
  db: Database,
  tenantId: string,
  userId: string,
  roleSlugs: readonly string[],
): Promise<string> {
  const [membership] = await db
    .insert(tenantMemberships)
    .values({ tenantId, userId, status: "ACTIVE", joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [tenantMemberships.tenantId, tenantMemberships.userId],
      set: { status: "ACTIVE", joinedAt: new Date() },
    })
    .returning({ id: tenantMemberships.id });

  if (!membership) {
    throw new Error(`Failed to create membership for user ${userId} in tenant ${tenantId}`);
  }

  for (const slug of roleSlugs) {
    const roleId = await requireRoleId(db, tenantId, slug);

    await db
      .insert(membershipRoles)
      .values({ tenantId, tenantMembershipId: membership.id, roleId })
      .onConflictDoNothing();
  }

  return membership.id;
}

/**
 * Seeds the global permission catalogue, the platform role, the system roles of
 * every sample hospital, and the hospital admin accounts.
 *
 * The platform role is created but not assigned: `membership_roles` only accepts
 * hospital roles, and platform authorization has its own (not yet built) plane.
 */
export async function seedAccess(
  db: Database,
  tenancy: SeededTenancy,
  password: string,
): Promise<void> {
  await seedRbacCatalogue(db);

  const passwordHash = await hashSeedPassword(password);

  for (const [tenantSlug, tenantId] of tenancy.tenantIds) {
    await seedTenantRbac(db, tenantId);

    const admins = ADMIN_ACCOUNTS.filter((account) => account.tenantSlug === tenantSlug);

    for (const admin of admins) {
      const userId = await upsertUser(db, {
        fullName: admin.fullName,
        email: admin.email,
        phone: admin.phone,
        passwordHash,
      });

      await ensureMembership(db, tenantId, userId, ["hospital_admin"]);
    }
  }
}
