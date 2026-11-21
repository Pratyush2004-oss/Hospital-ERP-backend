import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../database/client.js";
import {
  withTenantTransaction,
  withTransactionContext,
  type DatabaseTransaction,
} from "../../database/context.js";
import {
  authEmailTokens,
  branches,
  departments,
  membershipRoles,
  roles,
  tenantMemberships,
  tenants,
  users,
  type User,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditStandalone } from "../audit/audit.service.js";
import { sendAuthMail } from "../auth-mail/auth-mail.service.js";
import type {
  AuthMailDeliveryResult,
  AuthMailProvider,
} from "../auth-mail/auth-mail.types.js";
import {
  AUTH_EMAIL_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_TTL_MS,
  INVITATION_TTL_MS,
} from "./auth.config.js";
import { hashPassword } from "./auth.password.js";
import {
  generateEmailVerificationToken,
  generateInvitationToken,
  hashToken,
} from "./auth.tokens.js";

/**
 * Email verification, reset delivery and staff-invitation workflows (ONB-03).
 *
 * Every token is opaque, single-use, expiring and stored only as a SHA-256
 * hash. Delivery goes through the shared auth-mail adapter, so these flows do
 * not know which provider is configured. Raw tokens are returned to callers
 * only where the caller is the issuing service; they are never logged.
 */

export type AuthEmailDispatchStatus =
  | "SENT"
  | "COOLDOWN"
  | "ALREADY_VERIFIED"
  | "DELIVERY_FAILED"
  | "SUPPRESSED";

export interface AuthEmailDispatchResult {
  readonly status: AuthEmailDispatchStatus;
  readonly retryAfterSeconds?: number;
  readonly expiresAt?: string;
}

export interface VerifyEmailResult {
  readonly userId: string;
  readonly emailVerifiedAt: Date;
  readonly alreadyVerified: boolean;
}

export interface StaffInvitationInput {
  readonly email: string;
  readonly fullName?: string;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly branchIds: readonly string[];
}

export interface StaffInvitationResult {
  readonly invitationId: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly membershipId: string | null;
  readonly status: Exclude<AuthEmailDispatchStatus, "ALREADY_VERIFIED">;
  readonly retryAfterSeconds?: number;
}

export const STAFF_INVITATION_STATUSES = [
  "INVITED",
  "EXPIRED",
  "REVOKED",
  "ACCEPTED",
] as const;

export type StaffInvitationStatus = (typeof STAFF_INVITATION_STATUSES)[number];

export interface StaffInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: StaffInvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly membershipId: string | null;
  readonly membershipStatus: string | null;
  readonly invitedByName: string | null;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly branchIds: readonly string[];
  readonly roles: readonly { id: string; slug: string; name: string }[];
  readonly departments: readonly { id: string; name: string }[];
  readonly branches: readonly { id: string; name: string }[];
}

export interface InvitationDetails {
  readonly valid: boolean;
  readonly status: StaffInvitationStatus | "INVALID";
  readonly hospitalName: string | null;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly expiresAt: Date | null;
  readonly requiresPassword: boolean;
  readonly roles: readonly { slug: string; name: string }[];
  readonly departments: readonly { name: string }[];
  readonly branches: readonly { name: string }[];
}

export interface AcceptStaffInvitationInput {
  readonly fullName?: string;
  readonly password?: string;
}

export interface AcceptStaffInvitationResult {
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly accountCreated: boolean;
}

export interface HospitalActivationEmailResult {
  readonly recipients: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
}

type DispatchOptions = { readonly provider?: AuthMailProvider };

function deliveryStatus(
  delivery: AuthMailDeliveryResult,
): Exclude<AuthEmailDispatchStatus, "ALREADY_VERIFIED"> {
  if (delivery.status === "SENT") return "SENT";
  if (delivery.status === "FAILED") return "DELIVERY_FAILED";
  return "SUPPRESSED";
}

async function recordDeliveryFailure(input: {
  readonly kind: string;
  readonly tenantId?: string | null;
  readonly userId?: string | null;
  readonly delivery: AuthMailDeliveryResult;
}): Promise<void> {
  if (input.delivery.status !== "FAILED") return;

  await recordAuditStandalone({
    tenantId: input.tenantId ?? null,
    actorUserId: input.userId ?? null,
    actorScope: input.userId ? "USER" : "SYSTEM",
    action: AUDIT_ACTIONS.AUTH_EMAIL_DELIVERY_FAILED,
    module: "auth",
    resourceType: "auth_email",
    description: "Transactional authentication email delivery failed",
    metadata: {
      kind: input.kind,
      providerMode: input.delivery.mode,
      errorCode: input.delivery.errorCode ?? "unknown",
    },
  });
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function invitationStatus(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now = new Date(),
): StaffInvitationStatus {
  if (row.usedAt !== null) return "ACCEPTED";
  if (row.revokedAt !== null) return "REVOKED";
  if (row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "INVITED";
}

/**
 * Empty actor branches mean hospital-wide management. A branch-restricted
 * manager may only touch invitations whose branches are all in their scope,
 * and may not create a hospital-wide (branchless) invitation.
 */
function branchesWithinScope(
  actorBranchIds: readonly string[],
  invitationBranchIds: readonly string[],
): boolean {
  if (actorBranchIds.length === 0) return true;
  if (invitationBranchIds.length === 0) return false;

  const allowed = new Set(actorBranchIds);
  return invitationBranchIds.every((branchId) => allowed.has(branchId));
}

function assertInvitationBranchScope(
  actorBranchIds: readonly string[],
  invitationBranchIds: readonly string[],
): void {
  if (!branchesWithinScope(actorBranchIds, invitationBranchIds)) {
    throw AppError.forbidden(
      "You can only manage invitations for your assigned branches",
    );
  }
}

/**
 * Validates every invitation assignment against the inviting hospital. Roles
 * must be hospital-scoped; branches and departments must be active, non-deleted
 * rows of the same tenant. Cross-tenant ids fail as validation errors.
 */
async function validateStaffAssignments(
  tx: DatabaseTransaction,
  tenantId: string,
  roleIds: readonly string[],
  departmentIds: readonly string[],
  branchIds: readonly string[],
): Promise<void> {
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
      throw AppError.validation("One or more roles do not belong to this hospital");
    }
  }

  if (departmentIds.length > 0) {
    const validDepartments = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          eq(departments.tenantId, tenantId),
          eq(departments.isActive, true),
          isNull(departments.deletedAt),
          inArray(departments.id, departmentIds),
        ),
      );

    if (validDepartments.length !== departmentIds.length) {
      throw AppError.validation("One or more departments do not belong to this hospital");
    }
  }

  if (branchIds.length > 0) {
    const validBranches = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, tenantId),
          eq(branches.isActive, true),
          isNull(branches.deletedAt),
          inArray(branches.id, branchIds),
        ),
      );

    if (validBranches.length !== branchIds.length) {
      throw AppError.validation("One or more branches do not belong to this hospital");
    }
  }
}

function cooldownRetryAfter(latestCreatedAt: Date | null, now = Date.now()): number | null {
  if (!latestCreatedAt || AUTH_EMAIL_RESEND_COOLDOWN_MS <= 0) return null;

  const elapsed = now - latestCreatedAt.getTime();
  if (elapsed >= AUTH_EMAIL_RESEND_COOLDOWN_MS) return null;

  return Math.ceil((AUTH_EMAIL_RESEND_COOLDOWN_MS - elapsed) / 1000);
}

/**
 * Issues and delivers an email-verification token. When `enforceCooldown` is
 * true (resend requests), a token created inside the cooldown window is reused
 * as the duplicate-request guard instead of sending another email.
 */
export async function issueEmailVerification(
  user: User,
  options: DispatchOptions & { readonly enforceCooldown?: boolean } = {},
): Promise<AuthEmailDispatchResult> {
  if (user.emailVerifiedAt) {
    return { status: "ALREADY_VERIFIED" };
  }

  const [latest] = options.enforceCooldown
    ? await getDb()
        .select({ createdAt: authEmailTokens.createdAt })
        .from(authEmailTokens)
        .where(
          and(
            eq(authEmailTokens.userId, user.id),
            eq(authEmailTokens.purpose, "EMAIL_VERIFICATION"),
            isNull(authEmailTokens.usedAt),
            isNull(authEmailTokens.revokedAt),
          ),
        )
        .orderBy(desc(authEmailTokens.createdAt))
        .limit(1)
    : [];

  const retryAfterSeconds = cooldownRetryAfter(latest?.createdAt ?? null);

  if (retryAfterSeconds !== null) {
    return { status: "COOLDOWN", retryAfterSeconds };
  }

  const { token, tokenHash } = generateEmailVerificationToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await getDb().transaction(async (tx) => {
    // Only the newest link may be used.
    await tx
      .update(authEmailTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authEmailTokens.userId, user.id),
          eq(authEmailTokens.purpose, "EMAIL_VERIFICATION"),
          isNull(authEmailTokens.usedAt),
          isNull(authEmailTokens.revokedAt),
        ),
      );

    await tx.insert(authEmailTokens).values({
      purpose: "EMAIL_VERIFICATION",
      userId: user.id,
      email: user.email.toLowerCase(),
      tokenHash,
      expiresAt,
    });
  });

  const delivery = await sendAuthMail(
    {
      to: user.email,
      recipientName: user.fullName,
      kind: "EMAIL_VERIFICATION",
      token,
      expiresAt,
    },
    { provider: options.provider },
  );

  const status = deliveryStatus(delivery);

  if (status === "SENT") {
    await recordAuditStandalone({
      actorUserId: user.id,
      actorScope: "USER",
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFICATION_SENT,
      module: "auth",
      resourceType: "user",
      resourceId: user.id,
      description: "Email verification requested",
      metadata: { providerMode: delivery.mode },
    });
  } else {
    await recordDeliveryFailure({
      kind: "EMAIL_VERIFICATION",
      userId: user.id,
      delivery,
    });
  }

  return {
    status,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Consumes a verification token once and marks the account email verified. */
export async function verifyEmailAddress(rawToken: string): Promise<VerifyEmailResult> {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const result = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: authEmailTokens.id,
        userId: authEmailTokens.userId,
        email: authEmailTokens.email,
        expiresAt: authEmailTokens.expiresAt,
        usedAt: authEmailTokens.usedAt,
        revokedAt: authEmailTokens.revokedAt,
      })
      .from(authEmailTokens)
      .where(
        and(
          eq(authEmailTokens.tokenHash, tokenHash),
          eq(authEmailTokens.purpose, "EMAIL_VERIFICATION"),
        ),
      )
      .limit(1)
      .for("update");

    if (
      !row ||
      row.userId === null ||
      row.usedAt !== null ||
      row.revokedAt !== null ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      throw AppError.badRequest("Invalid or expired verification link");
    }

    const [user] = await tx
      .select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    if (!user) {
      throw AppError.badRequest("Invalid or expired verification link");
    }

    // A different email address on the account invalidates the purpose of the
    // link, even before the account's email is changed by another flow.
    if (user.email.toLowerCase() !== row.email.toLowerCase()) {
      throw AppError.badRequest("Invalid or expired verification link");
    }

    const [consumed] = await tx
      .update(authEmailTokens)
      .set({ usedAt: now })
      .where(and(eq(authEmailTokens.id, row.id), isNull(authEmailTokens.usedAt)))
      .returning({ id: authEmailTokens.id });

    if (!consumed) {
      throw AppError.badRequest("Invalid or expired verification link");
    }

    const alreadyVerified = user.emailVerifiedAt !== null;

    if (!alreadyVerified) {
      await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id));
    }

    await tx
      .update(authEmailTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authEmailTokens.userId, user.id),
          eq(authEmailTokens.purpose, "EMAIL_VERIFICATION"),
          isNull(authEmailTokens.usedAt),
          isNull(authEmailTokens.revokedAt),
        ),
      );

    return { userId: user.id, emailVerifiedAt: user.emailVerifiedAt ?? now, alreadyVerified };
  });

  await recordAuditStandalone({
    actorUserId: result.userId,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFIED,
    module: "auth",
    resourceType: "user",
    resourceId: result.userId,
    description: result.alreadyVerified
      ? "Email verification link replayed after verification"
      : "Email address verified",
    metadata: { alreadyVerified: result.alreadyVerified },
  });

  return result;
}

/**
 * Resends verification for the signed-in account, honouring the resend
 * cooldown and refusing to send once the address is already verified.
 */
export async function resendEmailVerification(
  userId: string,
  options: DispatchOptions = {},
): Promise<AuthEmailDispatchResult> {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Authentication is required");
  }

  return issueEmailVerification(user, { provider: options.provider, enforceCooldown: true });
}

/**
 * Resolves the hospital and inviter names, then issues a staff invitation.
 * Kept here so the route only passes verified context ids.
 */
export async function createStaffInvitation(
  tenantId: string,
  invitedByUserId: string,
  invitation: StaffInvitationInput,
  actorBranchIds: readonly string[],
  options: DispatchOptions = {},
): Promise<StaffInvitationResult> {
  assertInvitationBranchScope(actorBranchIds, invitation.branchIds);

  const context = await withTenantTransaction(tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [inviter] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, invitedByUserId))
      .limit(1);

    return { tenant, inviter };
  });

  if (!context.tenant) {
    throw AppError.notFound("Hospital not found");
  }

  return issueStaffInvitation({
    tenantId,
    tenantName: context.tenant.name,
    invitedByUserId,
    invitedByName: context.inviter?.fullName ?? "A hospital administrator",
    invitation,
    provider: options.provider,
  });
}

/** Delivers a password-reset link; the token row is already persisted. */
export async function deliverPasswordResetEmail(
  user: User,
  rawToken: string,
  expiresAt: Date,
  options: DispatchOptions = {},
): Promise<AuthMailDeliveryResult> {
  const delivery = await sendAuthMail(
    {
      to: user.email,
      recipientName: user.fullName,
      kind: "PASSWORD_RESET",
      token: rawToken,
      expiresAt,
    },
    { provider: options.provider },
  );

  await recordAuditStandalone({
    actorUserId: user.id,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
    module: "auth",
    resourceType: "user",
    resourceId: user.id,
    description: "Password reset requested",
    metadata: {
      deliveryStatus: delivery.status,
      providerMode: delivery.mode,
    },
  });

  await recordDeliveryFailure({
    kind: "PASSWORD_RESET",
    userId: user.id,
    delivery,
  });

  return delivery;
}

/**
 * Notifies the hospital's active administrators that a PENDING registration was
 * activated. Delivery is best-effort: the status change is already committed and
 * a provider outage must not reverse it. Failures are audited without recipient
 * addresses, tokens or provider response bodies.
 */
export async function deliverHospitalActivationEmail(
  tenant: { readonly id: string; readonly name: string; readonly slug: string },
  options: DispatchOptions = {},
): Promise<HospitalActivationEmailResult> {
  let administrators: { userId: string; email: string; fullName: string }[] = [];

  try {
    const rows = await withTenantTransaction(tenant.id, async (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          fullName: users.fullName,
        })
        .from(tenantMemberships)
        .innerJoin(users, eq(tenantMemberships.userId, users.id))
        .innerJoin(
          membershipRoles,
          and(
            eq(membershipRoles.tenantMembershipId, tenantMemberships.id),
            eq(membershipRoles.tenantId, tenant.id),
          ),
        )
        .innerJoin(
          roles,
          and(eq(roles.id, membershipRoles.roleId), eq(roles.tenantId, tenant.id)),
        )
        .where(
          and(
            eq(tenantMemberships.tenantId, tenant.id),
            eq(tenantMemberships.status, "ACTIVE"),
            eq(roles.slug, "hospital_admin"),
            eq(users.isActive, true),
          ),
        )
        .orderBy(asc(users.email)),
    );

    administrators = [
      ...new Map(rows.map((row) => [row.userId, row])).values(),
    ];
  } catch (error) {
    logger.warn(
      { tenantId: tenant.id, err: error },
      "Failed to load hospital administrators for activation email",
    );
    return { recipients: 0, sent: 0, failed: 0, suppressed: 0 };
  }

  if (administrators.length === 0) {
    logger.warn(
      { tenantId: tenant.id },
      "Hospital activated without an active administrator to notify",
    );
    return { recipients: 0, sent: 0, failed: 0, suppressed: 0 };
  }

  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const administrator of administrators) {
    const delivery = await sendAuthMail(
      {
        to: administrator.email,
        recipientName: administrator.fullName,
        kind: "HOSPITAL_ACTIVATED",
        hospitalName: tenant.name,
        hospitalSlug: tenant.slug,
      },
      { provider: options.provider },
    );

    if (delivery.status === "SENT") {
      sent += 1;
    } else if (delivery.status === "FAILED") {
      failed += 1;
      await recordDeliveryFailure({
        kind: "HOSPITAL_ACTIVATED",
        tenantId: tenant.id,
        delivery,
      });
    } else {
      suppressed += 1;
    }
  }

  if (sent > 0) {
    await recordAuditStandalone({
      tenantId: tenant.id,
      actorScope: "SYSTEM",
      action: AUDIT_ACTIONS.HOSPITAL_ACTIVATION_EMAIL_SENT,
      module: "tenancy",
      resourceType: "tenant",
      resourceId: tenant.id,
      description: "Hospital activation email sent",
      metadata: { recipientCount: administrators.length },
    });
  }

  return {
    recipients: administrators.length,
    sent,
    failed,
    suppressed,
  };
}

function uniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "23505") return true;
  return uniqueViolation((error as { cause?: unknown }).cause);
}

async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);

  return user;
}

/**
 * Creates (or replaces) a single-use staff invitation and delivers it.
 *
 * Existing active members are rejected. A pending invitation inside the resend
 * cooldown returns COOLDOWN instead of sending a duplicate message.
 */
export async function issueStaffInvitation(input: {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly invitedByUserId: string;
  readonly invitedByName: string;
  readonly invitation: StaffInvitationInput;
  readonly provider?: AuthMailProvider;
}): Promise<StaffInvitationResult> {
  const email = input.invitation.email.trim().toLowerCase();
  const roleIds = uniqueIds(input.invitation.roleIds);
  const departmentIds = uniqueIds(input.invitation.departmentIds);
  const branchIds = uniqueIds(input.invitation.branchIds);
  const now = new Date();
  const existingUser = await findUserByEmail(email);

  type IssueOutcome =
    | {
        readonly status: "COOLDOWN";
        readonly invitationId: string;
        readonly expiresAt: Date;
        readonly retryAfterSeconds: number;
        readonly membershipId: string | null;
      }
    | {
        readonly status: "CREATED";
        readonly invitationId: string;
        readonly expiresAt: Date;
        readonly token: string;
        readonly membershipId: string | null;
      };

  const outcome = await withTenantTransaction(input.tenantId, async (tx): Promise<IssueOutcome> => {
    await validateStaffAssignments(tx, input.tenantId, roleIds, departmentIds, branchIds);

    const [latest] = await tx
      .select({
        id: authEmailTokens.id,
        createdAt: authEmailTokens.createdAt,
        expiresAt: authEmailTokens.expiresAt,
        membershipId: authEmailTokens.membershipId,
      })
      .from(authEmailTokens)
      .where(
        and(
          eq(authEmailTokens.tenantId, input.tenantId),
          eq(authEmailTokens.purpose, "STAFF_INVITATION"),
          eq(authEmailTokens.email, email),
          isNull(authEmailTokens.usedAt),
          isNull(authEmailTokens.revokedAt),
          gt(authEmailTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(authEmailTokens.createdAt))
      .limit(1);

    const retryAfterSeconds = cooldownRetryAfter(latest?.createdAt ?? null, now.getTime());

    if (retryAfterSeconds !== null && latest) {
      return {
        status: "COOLDOWN",
        invitationId: latest.id,
        expiresAt: latest.expiresAt,
        retryAfterSeconds,
        membershipId: latest.membershipId,
      };
    }

    let membershipId: string | null = latest?.membershipId ?? null;

    if (existingUser) {
      const [membership] = await tx
        .select({ id: tenantMemberships.id, status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, input.tenantId),
            eq(tenantMemberships.userId, existingUser.id),
          ),
        )
        .limit(1)
        .for("update");

      if (membership?.status === "ACTIVE") {
        throw AppError.conflict("This person is already a member of this hospital");
      }

      // A revoked invitation removes the provisional membership. A new,
      // explicit invitation may re-open it; suspended memberships may not be
      // silently reinstated this way.
      if (membership && membership.status !== "INVITED" && membership.status !== "REMOVED") {
        throw AppError.conflict(
          "This account has an existing membership in this hospital that cannot be invited again",
        );
      }

      if (membership) {
        membershipId = membership.id;
        await tx
          .update(tenantMemberships)
          .set({
            status: "INVITED",
            branchIds,
            departmentIds,
            joinedAt: null,
            updatedAt: now,
          })
          .where(eq(tenantMemberships.id, membership.id));
      } else {
        const [created] = await tx
          .insert(tenantMemberships)
          .values({
            tenantId: input.tenantId,
            userId: existingUser.id,
            status: "INVITED",
            branchIds,
            departmentIds,
          })
          .returning({ id: tenantMemberships.id });

        if (!created) throw AppError.internal("Failed to create invited membership");
        membershipId = created.id;
      }
    }

    const { token, tokenHash } = generateInvitationToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

    await tx
      .update(authEmailTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authEmailTokens.tenantId, input.tenantId),
          eq(authEmailTokens.purpose, "STAFF_INVITATION"),
          eq(authEmailTokens.email, email),
          isNull(authEmailTokens.usedAt),
          isNull(authEmailTokens.revokedAt),
        ),
      );

    const [row] = await tx
      .insert(authEmailTokens)
      .values({
        purpose: "STAFF_INVITATION",
        userId: existingUser?.id ?? null,
        email,
        fullName: input.invitation.fullName ?? existingUser?.fullName ?? null,
        tenantId: input.tenantId,
        membershipId,
        roleIds,
        departmentIds,
        branchIds,
        invitedByUserId: input.invitedByUserId,
        tokenHash,
        expiresAt,
      })
      .returning({ id: authEmailTokens.id });

    if (!row) throw AppError.internal("Failed to create staff invitation");

    return {
      status: "CREATED",
      invitationId: row.id,
      expiresAt,
      token,
      membershipId,
    };
  });

  if (outcome.status === "COOLDOWN") {
    return {
      invitationId: outcome.invitationId,
      email,
      expiresAt: outcome.expiresAt.toISOString(),
      membershipId: outcome.membershipId,
      status: "COOLDOWN",
      retryAfterSeconds: outcome.retryAfterSeconds,
    };
  }

  if (outcome.membershipId) {
    await recordAuditStandalone({
      tenantId: input.tenantId,
      actorUserId: input.invitedByUserId,
      actorScope: "TENANT",
      action: AUDIT_ACTIONS.MEMBERSHIP_INVITED,
      module: "auth",
      resourceType: "membership",
      resourceId: outcome.membershipId,
      description: "Membership created in INVITED status",
      metadata: { roleCount: roleIds.length },
    });
  }

  const delivery = await sendAuthMail(
    {
      to: email,
      recipientName: input.invitation.fullName ?? existingUser?.fullName ?? "there",
      kind: "STAFF_INVITATION",
      token: outcome.token,
      expiresAt: outcome.expiresAt,
      hospitalName: input.tenantName,
      inviterName: input.invitedByName,
    },
    { provider: input.provider },
  );

  const status = deliveryStatus(delivery);

  if (status === "SENT") {
    await recordAuditStandalone({
      tenantId: input.tenantId,
      actorUserId: input.invitedByUserId,
      actorScope: "TENANT",
      action: AUDIT_ACTIONS.AUTH_INVITATION_SENT,
      module: "auth",
      resourceType: "staff_invitation",
      resourceId: outcome.invitationId,
      description: "Staff invitation sent",
      metadata: {
        roleCount: roleIds.length,
        branchCount: branchIds.length,
        departmentCount: departmentIds.length,
        providerMode: delivery.mode,
      },
    });
  } else {
    await recordDeliveryFailure({
      kind: "STAFF_INVITATION",
      tenantId: input.tenantId,
      userId: input.invitedByUserId,
      delivery,
    });
  }

  return {
    invitationId: outcome.invitationId,
    email,
    expiresAt: outcome.expiresAt.toISOString(),
    membershipId: outcome.membershipId,
    status,
  };
}

async function assignmentLabels(
  tx: DatabaseTransaction,
  tenantId: string,
  roleIds: readonly string[],
  departmentIds: readonly string[],
  branchIds: readonly string[],
): Promise<{
  roles: { id: string; slug: string; name: string }[];
  departments: { id: string; name: string }[];
  branches: { id: string; name: string }[];
}> {
  const roleRows = roleIds.length
    ? await tx
        .select({ id: roles.id, slug: roles.slug, name: roles.name })
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), inArray(roles.id, roleIds)))
    : [];
  const departmentRows = departmentIds.length
    ? await tx
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(
          and(eq(departments.tenantId, tenantId), inArray(departments.id, departmentIds)),
        )
    : [];
  const branchRows = branchIds.length
    ? await tx
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, branchIds)))
    : [];

  return { roles: roleRows, departments: departmentRows, branches: branchRows };
}

/** Lists the hospital's invitations, including derived lifecycle status. */
export async function listStaffInvitations(
  tenantId: string,
  actorBranchIds: readonly string[],
): Promise<readonly StaffInvitationSummary[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: authEmailTokens.id,
        email: authEmailTokens.email,
        fullName: authEmailTokens.fullName,
        createdAt: authEmailTokens.createdAt,
        expiresAt: authEmailTokens.expiresAt,
        usedAt: authEmailTokens.usedAt,
        revokedAt: authEmailTokens.revokedAt,
        membershipId: authEmailTokens.membershipId,
        membershipStatus: tenantMemberships.status,
        invitedByName: users.fullName,
        roleIds: authEmailTokens.roleIds,
        departmentIds: authEmailTokens.departmentIds,
        branchIds: authEmailTokens.branchIds,
      })
      .from(authEmailTokens)
      .leftJoin(users, eq(authEmailTokens.invitedByUserId, users.id))
      .leftJoin(tenantMemberships, eq(authEmailTokens.membershipId, tenantMemberships.id))
      .where(
        and(
          eq(authEmailTokens.tenantId, tenantId),
          eq(authEmailTokens.purpose, "STAFF_INVITATION"),
        ),
      )
      .orderBy(desc(authEmailTokens.createdAt));

    const now = new Date();
    const labelsByInvitation = new Map<
      string,
      Awaited<ReturnType<typeof assignmentLabels>>
    >();

    for (const row of rows) {
      labelsByInvitation.set(
        row.id,
        await assignmentLabels(tx, tenantId, row.roleIds, row.departmentIds, row.branchIds),
      );
    }

    return rows
      .filter((row) => branchesWithinScope(actorBranchIds, row.branchIds))
      .map((row) => ({
        ...row,
        status: invitationStatus(row, now),
        roles: labelsByInvitation.get(row.id)?.roles ?? [],
        departments: labelsByInvitation.get(row.id)?.departments ?? [],
        branches: labelsByInvitation.get(row.id)?.branches ?? [],
      }));
  });
}

/** Reissues an unaccepted invitation with a fresh token and expiry. */
export async function resendStaffInvitation(
  tenantId: string,
  invitationId: string,
  invitedByUserId: string,
  actorBranchIds: readonly string[],
  options: DispatchOptions = {},
): Promise<StaffInvitationResult> {
  const now = new Date();

  const outcome = await withTenantTransaction(tenantId, async (tx) => {
    const [original] = await tx
      .select()
      .from(authEmailTokens)
      .where(
        and(
          eq(authEmailTokens.id, invitationId),
          eq(authEmailTokens.tenantId, tenantId),
          eq(authEmailTokens.purpose, "STAFF_INVITATION"),
        ),
      )
      .limit(1)
      .for("update");

    if (!original) throw AppError.notFound("Invitation not found");
    if (!branchesWithinScope(actorBranchIds, original.branchIds)) {
      throw AppError.notFound("Invitation not found");
    }
    if (original.usedAt !== null) {
      throw AppError.conflict("This invitation has already been accepted");
    }
    if (original.revokedAt !== null) {
      throw AppError.conflict("This invitation was revoked; send a new invitation instead");
    }

    if (original.membershipId) {
      const [membership] = await tx
        .select({ status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.id, original.membershipId),
            eq(tenantMemberships.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (membership?.status === "ACTIVE") {
        throw AppError.conflict("This person is already a member of this hospital");
      }

      if (membership && membership.status !== "INVITED") {
        throw AppError.conflict("This invitation can no longer be resent");
      }
    }

    await validateStaffAssignments(
      tx,
      tenantId,
      original.roleIds,
      original.departmentIds,
      original.branchIds,
    );

    const { token, tokenHash } = generateInvitationToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

    if (original.revokedAt === null) {
      await tx
        .update(authEmailTokens)
        .set({ revokedAt: now })
        .where(eq(authEmailTokens.id, original.id));
    }

    const [replacement] = await tx
      .insert(authEmailTokens)
      .values({
        purpose: "STAFF_INVITATION",
        userId: original.userId,
        email: original.email,
        fullName: original.fullName,
        tenantId,
        membershipId: original.membershipId,
        roleIds: original.roleIds,
        departmentIds: original.departmentIds,
        branchIds: original.branchIds,
        invitedByUserId,
        tokenHash,
        expiresAt,
      })
      .returning({ id: authEmailTokens.id });

    if (!replacement) throw AppError.internal("Failed to resend staff invitation");

    return {
      invitationId: replacement.id,
      email: original.email,
      fullName: original.fullName,
      expiresAt,
      token,
      membershipId: original.membershipId,
    };
  });

  const context = await withTenantTransaction(tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [inviter] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, invitedByUserId))
      .limit(1);

    return { tenant, inviter };
  });

  const delivery = await sendAuthMail(
    {
      to: outcome.email,
      recipientName: outcome.fullName ?? "there",
      kind: "STAFF_INVITATION",
      token: outcome.token,
      expiresAt: outcome.expiresAt,
      hospitalName: context.tenant?.name,
      inviterName: context.inviter?.fullName,
    },
    { provider: options.provider },
  );

  const status = deliveryStatus(delivery);

  if (status === "SENT") {
    await recordAuditStandalone({
      tenantId,
      actorUserId: invitedByUserId,
      actorScope: "TENANT",
      action: AUDIT_ACTIONS.AUTH_INVITATION_RESENT,
      module: "auth",
      resourceType: "staff_invitation",
      resourceId: outcome.invitationId,
      description: "Staff invitation resent",
      metadata: { providerMode: delivery.mode },
    });
  } else {
    await recordDeliveryFailure({
      kind: "STAFF_INVITATION",
      tenantId,
      userId: invitedByUserId,
      delivery,
    });
  }

  return {
    invitationId: outcome.invitationId,
    email: outcome.email,
    expiresAt: outcome.expiresAt.toISOString(),
    membershipId: outcome.membershipId,
    status,
  };
}

/** Revokes an invitation and any INVITED membership created for it. */
export async function revokeStaffInvitation(
  tenantId: string,
  invitationId: string,
  actorUserId: string,
  actorBranchIds: readonly string[],
): Promise<{ email: string; membershipId: string | null }> {
  const now = new Date();

  const result = await withTenantTransaction(tenantId, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(authEmailTokens)
      .where(
        and(
          eq(authEmailTokens.id, invitationId),
          eq(authEmailTokens.tenantId, tenantId),
          eq(authEmailTokens.purpose, "STAFF_INVITATION"),
        ),
      )
      .limit(1)
      .for("update");

    if (!invitation) throw AppError.notFound("Invitation not found");
    if (!branchesWithinScope(actorBranchIds, invitation.branchIds)) {
      throw AppError.notFound("Invitation not found");
    }
    if (invitation.usedAt !== null) {
      throw AppError.conflict("This invitation has already been accepted");
    }

    if (invitation.revokedAt === null) {
      await tx
        .update(authEmailTokens)
        .set({ revokedAt: now })
        .where(eq(authEmailTokens.id, invitation.id));
    }

    if (invitation.membershipId) {
      await tx
        .update(tenantMemberships)
        .set({ status: "REMOVED", updatedAt: now })
        .where(
          and(
            eq(tenantMemberships.id, invitation.membershipId),
            eq(tenantMemberships.tenantId, tenantId),
            eq(tenantMemberships.status, "INVITED"),
          ),
        );
    }

    return {
      email: invitation.email,
      membershipId: invitation.membershipId,
      alreadyRevoked: invitation.revokedAt !== null,
    };
  });

  if (!result.alreadyRevoked) {
    await recordAuditStandalone({
      tenantId,
      actorUserId,
      actorScope: "TENANT",
      action: AUDIT_ACTIONS.AUTH_INVITATION_REVOKED,
      module: "auth",
      resourceType: "staff_invitation",
      resourceId: invitationId,
      description: "Staff invitation revoked",
      metadata: { membershipId: result.membershipId },
    });
  }

  return { email: result.email, membershipId: result.membershipId };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Safe, non-consuming invitation lookup for the acceptance screen. */
export async function getInvitationDetails(rawToken: string): Promise<InvitationDetails> {
  const [invitation] = await getDb()
    .select()
    .from(authEmailTokens)
    .where(
      and(
        eq(authEmailTokens.tokenHash, hashToken(rawToken)),
        eq(authEmailTokens.purpose, "STAFF_INVITATION"),
      ),
    )
    .limit(1);

  if (!invitation || invitation.tenantId === null) {
    return {
      valid: false,
      status: "INVALID",
      hospitalName: null,
      email: null,
      fullName: null,
      expiresAt: null,
      requiresPassword: true,
      roles: [],
      departments: [],
      branches: [],
    };
  }

  const tenantId = invitation.tenantId;
  const status = invitationStatus(invitation);

  const details = await withTenantTransaction(tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const labels = await assignmentLabels(
      tx,
      tenantId,
      invitation.roleIds,
      invitation.departmentIds,
      invitation.branchIds,
    );

    return { hospitalName: tenant?.name ?? null, labels };
  });

  const existingUser = invitation.userId
    ? (await getDb().select({ id: users.id }).from(users).where(eq(users.id, invitation.userId)).limit(1))[0]
    : await findUserByEmail(invitation.email);

  return {
    valid: status === "INVITED",
    status,
    hospitalName: details.hospitalName,
    email: maskEmail(invitation.email),
    fullName: invitation.fullName,
    expiresAt: invitation.expiresAt,
    requiresPassword: !existingUser,
    roles: details.labels.roles.map((role) => ({ slug: role.slug, name: role.name })),
    departments: details.labels.departments.map((department) => ({ name: department.name })),
    branches: details.labels.branches.map((branch) => ({ name: branch.name })),
  };
}

/**
 * Accepts a staff invitation: creates the account when needed, activates the
 * membership and grants the invited roles. The token is consumed once.
 */
export async function acceptStaffInvitation(
  rawToken: string,
  input: AcceptStaffInvitationInput,
): Promise<AcceptStaffInvitationResult> {
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [invitation] = await getDb()
    .select()
    .from(authEmailTokens)
    .where(
      and(
        eq(authEmailTokens.tokenHash, tokenHash),
        eq(authEmailTokens.purpose, "STAFF_INVITATION"),
      ),
    )
    .limit(1);

  if (
    !invitation ||
    invitation.tenantId === null ||
    invitation.usedAt !== null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= now.getTime()
  ) {
    throw AppError.badRequest("Invalid or expired invitation");
  }

  const tenantId: string = invitation.tenantId;

  const existingUser = invitation.userId
    ? (await getDb().select().from(users).where(eq(users.id, invitation.userId)).limit(1))[0]
    : await findUserByEmail(invitation.email);

  if (existingUser && !existingUser.isActive) {
    throw AppError.badRequest("Invalid or expired invitation");
  }

  // Possession of the token must correspond to the invited email identity.
  if (
    existingUser &&
    existingUser.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()
  ) {
    throw AppError.badRequest("Invalid or expired invitation");
  }

  if (!existingUser && (!input.fullName || !input.password)) {
    throw AppError.validation("A full name and password are required to accept this invitation", [
      { source: "body", path: "password", message: "Password is required", code: "custom" },
    ]);
  }

  const passwordHash =
    existingUser || !input.password ? null : await hashPassword(input.password);

  let result: AcceptStaffInvitationResult;

  try {
    result = await withTransactionContext(
      { tenantId, userId: existingUser?.id ?? null },
      async (tx) => {
        const [consumed] = await tx
          .update(authEmailTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(authEmailTokens.id, invitation.id),
              isNull(authEmailTokens.usedAt),
              isNull(authEmailTokens.revokedAt),
              gt(authEmailTokens.expiresAt, now),
            ),
          )
          .returning({ id: authEmailTokens.id });

        if (!consumed) {
          throw AppError.badRequest("Invalid or expired invitation");
        }

        let user = existingUser;
        let accountCreated = false;

        if (!user) {
          const [created] = await tx
            .insert(users)
            .values({
              fullName: input.fullName!.trim(),
              email: invitation.email,
              passwordHash: passwordHash!,
              emailVerifiedAt: now,
            })
            .returning();

          if (!created) throw AppError.internal("Failed to create the invited account");

          user = created;
          accountCreated = true;
        } else if (user.emailVerifiedAt === null) {
          await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id));
        }

        const [existingMembership] = invitation.membershipId
          ? await tx
              .select({ id: tenantMemberships.id, status: tenantMemberships.status })
              .from(tenantMemberships)
              .where(
                and(
                  eq(tenantMemberships.id, invitation.membershipId),
                  eq(tenantMemberships.tenantId, tenantId),
                  eq(tenantMemberships.userId, user.id),
                ),
              )
              .limit(1)
              .for("update")
          : await tx
              .select({ id: tenantMemberships.id, status: tenantMemberships.status })
              .from(tenantMemberships)
              .where(
                and(
                  eq(tenantMemberships.tenantId, tenantId),
                  eq(tenantMemberships.userId, user.id),
                ),
              )
              .limit(1)
              .for("update");

        let membership: { id: string } | undefined;

        if (existingMembership) {
          if (existingMembership.status !== "INVITED") {
            throw AppError.conflict("This membership can no longer be activated");
          }

          const [activated] = await tx
            .update(tenantMemberships)
            .set({
              status: "ACTIVE",
              joinedAt: now,
              branchIds: invitation.branchIds,
              departmentIds: invitation.departmentIds,
              updatedAt: now,
            })
            .where(eq(tenantMemberships.id, existingMembership.id))
            .returning({ id: tenantMemberships.id });

          membership = activated;
        } else {
          const [createdMembership] = await tx
            .insert(tenantMemberships)
            .values({
              tenantId,
              userId: user.id,
              status: "ACTIVE",
              branchIds: invitation.branchIds,
              departmentIds: invitation.departmentIds,
              joinedAt: now,
            })
            .returning({ id: tenantMemberships.id });

          membership = createdMembership;
        }

        if (!membership) throw AppError.internal("Failed to activate hospital membership");

        // New-account invitations have no membership at send time, so link the
        // accepted token now for an auditable invitation -> membership history.
        if (invitation.membershipId === null) {
          await tx
            .update(authEmailTokens)
            .set({ membershipId: membership.id })
            .where(eq(authEmailTokens.id, invitation.id));
        }

        const requestedRoleIds = invitation.roleIds.filter(
          (roleId): roleId is string => typeof roleId === "string",
        );

        if (requestedRoleIds.length > 0) {
          const validRoles = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(
              and(
                eq(roles.tenantId, tenantId),
                eq(roles.scope, "HOSPITAL"),
                inArray(roles.id, requestedRoleIds),
              ),
            );

          if (validRoles.length > 0) {
            await tx
              .insert(membershipRoles)
              .values(
                validRoles.map((role) => ({
                  tenantId,
                  tenantMembershipId: membership.id,
                  roleId: role.id,
                  assignedBy: invitation.invitedByUserId,
                })),
              )
              .onConflictDoNothing();
          }
        }

        // Any other outstanding invitation for the same address is retired.
        await tx
          .update(authEmailTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(authEmailTokens.tenantId, tenantId),
              eq(authEmailTokens.purpose, "STAFF_INVITATION"),
              eq(authEmailTokens.email, invitation.email),
              isNull(authEmailTokens.usedAt),
              isNull(authEmailTokens.revokedAt),
            ),
          );

        return {
          userId: user.id,
          tenantId,
          membershipId: membership.id,
          accountCreated,
        };
      },
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      // Another request created the account between lookup and insert.
      logger.warn({ invitationId: invitation.id }, "Invitation acceptance raced another signup");
      throw AppError.conflict("An account with this email already exists; request a new invitation");
    }

    throw error;
  }

  await recordAuditStandalone({
    tenantId: result.tenantId,
    actorUserId: result.userId,
    actorScope: "TENANT",
    action: AUDIT_ACTIONS.AUTH_INVITATION_ACCEPTED,
    module: "auth",
    resourceType: "membership",
    resourceId: result.membershipId,
    description: "Staff invitation accepted",
    metadata: { accountCreated: result.accountCreated },
  });

  await recordAuditStandalone({
    tenantId: result.tenantId,
    actorUserId: result.userId,
    actorScope: "TENANT",
    action: AUDIT_ACTIONS.MEMBERSHIP_ACTIVATED,
    module: "auth",
    resourceType: "membership",
    resourceId: result.membershipId,
    description: "Membership activated after invitation acceptance",
  });

  return result;
}
