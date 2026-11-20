import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../database/client.js";
import {
  withPlatformTransaction,
  withTenantTransaction,
  withTransactionContext,
  type DbExecutor,
} from "../../database/context.js";
import {
  authSessions,
  membershipRoles,
  roles,
  tenantMemberships,
  tenantSettings,
  tenants,
  users,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditSafely, recordAuditStandalone } from "../audit/audit.service.js";
import { slugify, TENANT_SLUG_PATTERN } from "../../lib/slug.js";
import { loadMembershipPermissions } from "../rbac/rbac.service.js";
import { seedTenantRbac } from "../rbac/rbac.seed.js";
import type { PlatformCreateTenantInput, RegisterTenantInput } from "./tenancy.schemas.js";

/**
 * Tenancy service.
 *
 * Tenant identity for hospital-scoped operations always comes from the verified
 * session (`auth_sessions.active_tenant_id`) and an ACTIVE membership. Tenant
 * ids in URLs or bodies are never trusted; selection is by slug and is validated
 * against the caller's memberships before the session is updated.
 */

export type TenantStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "INACTIVE";

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly legalName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: TenantStatus;
  readonly timezone: string;
  readonly createdAt: Date;
}

export interface UserMembershipSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly tenantStatus: TenantStatus;
  readonly status: string;
  readonly joinedAt: Date | null;
  readonly createdAt: Date;
}

export interface TenantContextResolution {
  readonly tenant: TenantSummary;
  readonly membershipId: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

export interface TenantProvisionResult {
  readonly tenant: TenantSummary;
  readonly membershipId: string | null;
  readonly defaultRoleId: string | null;
}

interface ProvisionTenantInput {
  readonly name: string;
  readonly slug?: string;
  readonly legalName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly timezone?: string;
  readonly status: TenantStatus;
  readonly adminUserId: string | null;
}

function tenantSummary(row: {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  status: TenantStatus;
  timezone: string;
  createdAt: Date;
}): TenantSummary {
  return { ...row };
}

function randomSlugSuffix(): string {
  return randomBytes(3).toString("hex");
}

async function tenantSlugExists(tx: DbExecutor, slug: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  return row !== undefined;
}

async function resolveTenantSlug(
  tx: DbExecutor,
  name: string,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    const normalized = requested.trim().toLowerCase();

    if (!TENANT_SLUG_PATTERN.test(normalized)) {
      throw AppError.validation("Slug may contain lowercase letters, digits and hyphens");
    }

    if (await tenantSlugExists(tx, normalized)) {
      throw AppError.conflict("This hospital slug is already taken");
    }

    return normalized;
  }

  const base = (slugify(name) || "hospital").slice(0, 90);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomSlugSuffix()}`;

    if (!(await tenantSlugExists(tx, candidate))) {
      return candidate;
    }
  }

  throw AppError.conflict("Could not allocate a unique hospital slug");
}

async function provisionTenant(input: ProvisionTenantInput): Promise<TenantProvisionResult> {
  const tenantId = randomUUID();

  // Provisioning needs platform visibility (to check slug uniqueness) plus the
  // new tenant's RLS context (memberships, roles and grants).
  return withTransactionContext({ tenantId, isPlatform: true }, async (tx) => {
    const slug = await resolveTenantSlug(tx, input.name, input.slug);

    const [tenant] = await tx
      .insert(tenants)
      .values({
        id: tenantId,
        name: input.name,
        slug,
        legalName: input.legalName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        timezone: input.timezone ?? "UTC",
        status: input.status,
      })
      .returning({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        legalName: tenants.legalName,
        email: tenants.email,
        phone: tenants.phone,
        status: tenants.status,
        timezone: tenants.timezone,
        createdAt: tenants.createdAt,
      });

    if (!tenant) {
      throw AppError.internal("Failed to create hospital");
    }

    // Permission catalogue + the seeded hospital roles for this tenant.
    await seedTenantRbac(tx, tenantId);

    const [adminRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.slug, "hospital_admin")))
      .limit(1);

    if (!adminRole) {
      throw AppError.internal("Hospital admin role was not provisioned");
    }

    let membershipId: string | null = null;

    if (input.adminUserId) {
      const [membership] = await tx
        .insert(tenantMemberships)
        .values({
          tenantId,
          userId: input.adminUserId,
          status: "ACTIVE",
          joinedAt: new Date(),
        })
        .returning({ id: tenantMemberships.id });

      if (!membership) {
        throw AppError.internal("Failed to create the initial hospital membership");
      }

      await tx.insert(membershipRoles).values({
        tenantId,
        tenantMembershipId: membership.id,
        roleId: adminRole.id,
        assignedBy: input.adminUserId,
      });

      membershipId = membership.id;
    }

    return {
      tenant: tenantSummary(tenant),
      membershipId,
      defaultRoleId: adminRole.id,
    };
  });
}

/** Self-service hospital registration; the creator becomes the hospital admin. */
export async function registerTenant(
  userId: string,
  input: RegisterTenantInput,
): Promise<TenantProvisionResult> {
  const result = await provisionTenant({
    name: input.name,
    slug: input.slug,
    legalName: input.legalName,
    email: input.email,
    phone: input.phone,
    timezone: input.timezone,
    status: "PENDING",
    adminUserId: userId,
  });

  await recordAuditStandalone({
    tenantId: result.tenant.id,
    actorUserId: userId,
    actorScope: "TENANT",
    action: AUDIT_ACTIONS.HOSPITAL_CREATED,
    module: "tenancy",
    resourceType: "tenant",
    resourceId: result.tenant.id,
    description: "Hospital registered",
    metadata: { status: "PENDING" },
  });

  return result;
}

/** Platform-plane hospital creation, optionally with an initial admin account. */
export async function createTenantByPlatform(
  input: PlatformCreateTenantInput,
): Promise<TenantProvisionResult> {
  let adminUserId: string | null = null;

  if (input.adminEmail) {
    const [admin] = await getDb()
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.adminEmail}`)
      .limit(1);

    if (!admin || !admin.isActive) {
      throw AppError.badRequest("The initial admin account was not found or is disabled");
    }

    adminUserId = admin.id;
  }

  const result = await provisionTenant({
    name: input.name,
    slug: input.slug,
    legalName: input.legalName,
    email: input.email,
    phone: input.phone,
    timezone: input.timezone,
    status: input.status ?? "ACTIVE",
    adminUserId,
  });

  await recordAuditStandalone({
    tenantId: result.tenant.id,
    actorScope: "PLATFORM",
    action: AUDIT_ACTIONS.HOSPITAL_CREATED,
    module: "tenancy",
    resourceType: "tenant",
    resourceId: result.tenant.id,
    description: "Hospital created by platform",
    metadata: { status: input.status ?? "ACTIVE" },
  });

  return result;
}

/** Every hospital the signed-in user belongs to, including onboarding state. */
export async function listUserMemberships(userId: string): Promise<readonly UserMembershipSummary[]> {
  return withTransactionContext({ userId }, async (tx) => {
    const rows = await tx
      .select({
        id: tenantMemberships.id,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        tenantStatus: tenants.status,
        status: tenantMemberships.status,
        joinedAt: tenantMemberships.joinedAt,
        createdAt: tenantMemberships.createdAt,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
      .where(eq(tenantMemberships.userId, userId))
      .orderBy(asc(tenants.name));

    return rows;
  });
}

/**
 * Validates tenant + membership and resolves roles/permissions. Returns null
 * when the tenant is not active or the membership is not active, which lets the
 * auth middleware fall back to a credential-only actor.
 */
export async function resolveTenantContext(
  userId: string,
  tenantId: string,
): Promise<TenantContextResolution | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [tenant] = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        legalName: tenants.legalName,
        email: tenants.email,
        phone: tenants.phone,
        status: tenants.status,
        timezone: tenants.timezone,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, "ACTIVE")))
      .limit(1);

    if (!tenant) return null;

    const [membership] = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (!membership) return null;

    const resolved = await loadMembershipPermissions(tx, tenantId, membership.id);

    return {
      tenant: tenantSummary(tenant),
      membershipId: membership.id,
      roles: resolved.roles,
      permissions: resolved.permissions,
    };
  });
}

/**
 * Selects the active hospital for the current session after validating an
 * ACTIVE membership. The tenant id is written to the session, never sent by the
 * client on subsequent hospital requests.
 */
export async function selectTenant(
  userId: string,
  sessionId: string,
  slug: string,
): Promise<TenantContextResolution> {
  const [tenant] = await withTransactionContext({ userId }, async (tx) =>
    tx
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1),
  );

  if (!tenant) {
    throw AppError.forbidden("You do not have access to this hospital");
  }

  if (tenant.status !== "ACTIVE") {
    throw AppError.forbidden("This hospital is not active yet");
  }

  const context = await resolveTenantContext(userId, tenant.id);

  if (!context) {
    throw AppError.forbidden("You do not have an active membership in this hospital");
  }

  const [updated] = await getDb()
    .update(authSessions)
    .set({ activeTenantId: tenant.id })
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
    .returning({ id: authSessions.id });

  if (!updated) {
    throw AppError.unauthorized("Authentication is required");
  }

  await recordAuditStandalone({
    tenantId: context.tenant.id,
    actorUserId: userId,
    actorScope: "TENANT",
    action: AUDIT_ACTIONS.AUTH_TENANT_SELECTED,
    module: "auth",
    resourceType: "tenant",
    resourceId: context.tenant.id,
    description: "Active hospital selected",
    metadata: { sessionId },
  });

  return context;
}

/** Key/value settings of the active hospital. */
export async function getTenantSettings(
  tenantId: string,
): Promise<Readonly<Record<string, unknown>>> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx
      .select({ key: tenantSettings.settingKey, value: tenantSettings.settingValue })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .orderBy(asc(tenantSettings.settingKey));

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  });
}

export async function setTenantSetting(
  tenantId: string,
  key: string,
  value: unknown,
): Promise<{ key: string; value: unknown }> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .insert(tenantSettings)
      .values({ tenantId, settingKey: key, settingValue: value })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.settingKey],
        set: { settingValue: value },
      })
      .returning({ key: tenantSettings.settingKey, value: tenantSettings.settingValue });

    if (!row) {
      throw AppError.internal("Failed to save hospital setting");
    }

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.HOSPITAL_SETTING_UPDATED,
      module: "tenancy",
      resourceType: "tenant_setting",
      resourceId: key,
      description: "Hospital setting updated",
      metadata: { settingKey: key },
    });

    return row;
  });
}

export async function listAllTenants(): Promise<readonly TenantSummary[]> {
  return withPlatformTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        legalName: tenants.legalName,
        email: tenants.email,
        phone: tenants.phone,
        status: tenants.status,
        timezone: tenants.timezone,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .orderBy(asc(tenants.name));

    return rows.map(tenantSummary);
  });
}

export async function setTenantStatus(
  tenantId: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<TenantSummary> {
  return withPlatformTransaction(async (tx) => {
    const [previous] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [tenant] = await tx
      .update(tenants)
      .set({ status })
      .where(eq(tenants.id, tenantId))
      .returning({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        legalName: tenants.legalName,
        email: tenants.email,
        phone: tenants.phone,
        status: tenants.status,
        timezone: tenants.timezone,
        createdAt: tenants.createdAt,
      });

    if (!tenant) {
      throw AppError.notFound("Hospital not found");
    }

    await recordAuditSafely(tx, {
      tenantId,
      action: AUDIT_ACTIONS.HOSPITAL_STATUS_CHANGED,
      module: "tenancy",
      resourceType: "tenant",
      resourceId: tenant.id,
      description: "Hospital status changed",
      previousState: { status: previous?.status ?? null },
      newState: { status: tenant.status },
    });

    return tenantSummary(tenant);
  });
}
