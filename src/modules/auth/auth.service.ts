import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../database/client.js";
import {
  authRefreshTokens,
  authSessions,
  passwordResetTokens,
  users,
  type User,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { AUDIT_ACTIONS } from "../audit/audit.types.js";
import { recordAuditStandalone } from "../audit/audit.service.js";
import { burnPasswordComparison, hashPassword, verifyPassword } from "./auth.password.js";
import {
  PASSWORD_RESET_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "./auth.config.js";
import {
  generateCsrfToken,
  generatePasswordResetToken,
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from "./auth.tokens.js";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
} from "./auth.schemas.js";

/**
 * Authentication service.
 *
 * Password hashes and opaque token hashes never leave this module: routes and
 * middleware only see `PublicUser` records and freshly issued credentials.
 */

export interface PublicUser {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly isActive: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface SessionMetadata {
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export interface IssuedSession {
  readonly user: PublicUser;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly refreshExpiresAt: Date;
}

export interface SessionSummary {
  readonly id: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly isCurrent: boolean;
}

export interface PasswordResetRequestResult {
  /** Only returned outside production, where no email provider is configured. */
  readonly resetToken: string | null;
  readonly expiresAt: Date | null;
}

export interface AccessTokenSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly activeTenantId: string | null;
}

const INVALID_CREDENTIALS = "Invalid email, phone number or password";

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
    emailVerifiedAt: user.emailVerifiedAt,
    phoneVerifiedAt: user.phoneVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * PostgreSQL unique-violation, e.g. the email/phone indexes on `users`.
 * Drizzle may wrap driver errors, so the cause chain is inspected as well.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  if ((error as { code?: unknown }).code === "23505") return true;

  return isUniqueViolation((error as { cause?: unknown }).cause);
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength);
}

/** Case-insensitive email lookup plus exact phone lookup. */
async function findUserByIdentifier(identifier: string): Promise<User | undefined> {
  const normalized = identifier.trim().toLowerCase();

  const [user] = await getDb()
    .select()
    .from(users)
    .where(
      or(
        sql`lower(${users.email}) = ${normalized}`,
        eq(users.phone, identifier.trim()),
      ),
    )
    .limit(1);

  return user;
}

async function findUserById(userId: string): Promise<User | undefined> {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  return user;
}

/**
 * Creates a sign-in session and its first refresh token. The raw refresh token
 * is returned once and only its SHA-256 hash is persisted.
 */
async function issueSession(user: User, metadata: SessionMetadata): Promise<IssuedSession> {
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  const { token: refreshToken, tokenHash } = generateRefreshToken();

  const sessionId = await getDb().transaction(async (tx) => {
    const [session] = await tx
      .insert(authSessions)
      .values({
        userId: user.id,
        userAgent: truncate(metadata.userAgent, 512),
        ipAddress: truncate(metadata.ipAddress, 64),
        lastUsedAt: now,
        expiresAt: sessionExpiresAt,
      })
      .returning({ id: authSessions.id });

    if (!session) {
      throw AppError.internal("Failed to create authentication session");
    }

    await tx.insert(authRefreshTokens).values({
      sessionId: session.id,
      tokenHash,
      expiresAt: sessionExpiresAt,
    });

    return session.id;
  });

  const accessToken = await signAccessToken({ userId: user.id, sessionId });

  return {
    user: toPublicUser({ ...user, lastLoginAt: now }),
    sessionId,
    accessToken,
    refreshToken,
    csrfToken: generateCsrfToken(),
    refreshExpiresAt: sessionExpiresAt,
  };
}

/** Creates a global account. Tenant membership is intentionally not created. */
export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);

  try {
    const [created] = await getDb()
      .insert(users)
      .values({
        fullName: input.fullName,
        email: input.email,
        phone: input.phone ?? null,
        passwordHash,
      })
      .returning();

    if (!created) {
      throw AppError.internal("Failed to create account");
    }

    await recordAuditStandalone({
      actorUserId: created.id,
      actorScope: "USER",
      action: AUDIT_ACTIONS.AUTH_REGISTERED,
      module: "auth",
      resourceType: "user",
      resourceId: created.id,
      description: "Account registered",
    });

    return toPublicUser(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("An account with this email or phone number already exists");
    }

    throw error;
  }
}

export async function loginUser(
  input: LoginInput,
  metadata: SessionMetadata,
): Promise<IssuedSession> {
  const user = await findUserByIdentifier(input.identifier);

  // Unknown and disabled accounts still burn a bcrypt comparison so response
  // timing does not reveal whether an account exists.
  if (!user || !user.isActive) {
    await burnPasswordComparison(input.password);
    await recordAuditStandalone({
      actorScope: "SYSTEM",
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      module: "auth",
      resourceType: "session",
      description: "Login failed",
      metadata: { reason: "invalid_credentials" },
    });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    await recordAuditStandalone({
      actorUserId: user.id,
      actorScope: "USER",
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      module: "auth",
      resourceType: "user",
      resourceId: user.id,
      description: "Login failed",
      metadata: { reason: "invalid_credentials" },
    });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  const now = new Date();
  await getDb().update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

  const issued = await issueSession({ ...user, lastLoginAt: now }, metadata);

  await recordAuditStandalone({
    actorUserId: user.id,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
    module: "auth",
    resourceType: "session",
    resourceId: issued.sessionId,
    description: "Login succeeded",
  });

  return issued;
}

type RefreshOutcome =
  | { readonly status: "invalid" }
  | { readonly status: "reuse"; readonly userId: string; readonly sessionId: string }
  | {
      readonly status: "ok";
      readonly userId: string;
      readonly sessionId: string;
      readonly sessionExpiresAt: Date;
    };

/**
 * Rotates a refresh token. Reuse of an already-rotated token is treated as
 * theft and revokes the whole session, including the token that replaced it.
 */
export async function refreshSession(rawRefreshToken: string): Promise<IssuedSession> {
  const tokenHash = hashToken(rawRefreshToken);
  const nextToken = generateRefreshToken();
  const now = new Date();

  const outcome = await getDb().transaction<RefreshOutcome>(async (tx) => {
    const [row] = await tx
      .select({
        tokenId: authRefreshTokens.id,
        tokenExpiresAt: authRefreshTokens.expiresAt,
        tokenRotatedAt: authRefreshTokens.rotatedAt,
        tokenRevokedAt: authRefreshTokens.revokedAt,
        sessionId: authSessions.id,
        sessionExpiresAt: authSessions.expiresAt,
        sessionRevokedAt: authSessions.revokedAt,
        userId: users.id,
        userIsActive: users.isActive,
      })
      .from(authRefreshTokens)
      .innerJoin(authSessions, eq(authRefreshTokens.sessionId, authSessions.id))
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(eq(authRefreshTokens.tokenHash, tokenHash))
      .limit(1)
      // Serializes concurrent refreshes so exactly one of them can rotate.
      .for("update");

    if (!row) return { status: "invalid" };

    if (
      row.tokenRevokedAt !== null ||
      row.sessionRevokedAt !== null ||
      row.tokenExpiresAt.getTime() <= now.getTime() ||
      row.sessionExpiresAt.getTime() <= now.getTime() ||
      !row.userIsActive
    ) {
      return { status: "invalid" };
    }

    if (row.tokenRotatedAt !== null) {
      await tx
        .update(authSessions)
        .set({ revokedAt: now, revokedReason: "token_reuse" })
        .where(eq(authSessions.id, row.sessionId));

      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(authRefreshTokens.sessionId, row.sessionId),
            isNull(authRefreshTokens.revokedAt),
          ),
        );

      return { status: "reuse", userId: row.userId, sessionId: row.sessionId };
    }

    await tx
      .update(authRefreshTokens)
      .set({ rotatedAt: now })
      .where(eq(authRefreshTokens.id, row.tokenId));

    await tx.insert(authRefreshTokens).values({
      sessionId: row.sessionId,
      tokenHash: nextToken.tokenHash,
      expiresAt: row.sessionExpiresAt,
    });

    await tx
      .update(authSessions)
      .set({ lastUsedAt: now })
      .where(eq(authSessions.id, row.sessionId));

    return {
      status: "ok",
      userId: row.userId,
      sessionId: row.sessionId,
      sessionExpiresAt: row.sessionExpiresAt,
    };
  });

  if (outcome.status === "reuse") {
    logger.warn(
      { userId: outcome.userId, sessionId: outcome.sessionId },
      "Refresh token reuse detected; session revoked",
    );
    await recordAuditStandalone({
      actorUserId: outcome.userId,
      actorScope: "USER",
      action: AUDIT_ACTIONS.AUTH_SESSION_REUSE_DETECTED,
      module: "auth",
      resourceType: "session",
      resourceId: outcome.sessionId,
      description: "Refresh token reuse detected; session revoked",
    });
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  if (outcome.status === "invalid") {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  const user = await findUserById(outcome.userId);

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  const accessToken = await signAccessToken({
    userId: outcome.userId,
    sessionId: outcome.sessionId,
  });

  return {
    user: toPublicUser(user),
    sessionId: outcome.sessionId,
    accessToken,
    refreshToken: nextToken.token,
    csrfToken: generateCsrfToken(),
    refreshExpiresAt: outcome.sessionExpiresAt,
  };
}

async function revokeSessionById(sessionId: string, reason: string): Promise<void> {
  const now = new Date();

  await getDb().transaction(async (tx) => {
    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(eq(authSessions.id, sessionId));

    await tx
      .update(authRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(authRefreshTokens.sessionId, sessionId), isNull(authRefreshTokens.revokedAt)),
      );
  });
}

/**
 * Revokes the session behind the refresh token (or, failing that, behind a
 * still-valid access token). Idempotent: unknown credentials are a no-op.
 */
export async function logout(
  refreshToken: string | null,
  accessToken: string | null,
): Promise<void> {
  let sessionId: string | null = null;
  let userId: string | null = null;

  if (refreshToken) {
    const [row] = await getDb()
      .select({ sessionId: authRefreshTokens.sessionId, userId: authSessions.userId })
      .from(authRefreshTokens)
      .innerJoin(authSessions, eq(authRefreshTokens.sessionId, authSessions.id))
      .where(eq(authRefreshTokens.tokenHash, hashToken(refreshToken)))
      .limit(1);

    sessionId = row?.sessionId ?? null;
    userId = row?.userId ?? null;
  }

  if (!sessionId && accessToken) {
    const resolved = await resolveAccessTokenSession(accessToken);
    sessionId = resolved?.sessionId ?? null;
    userId = resolved?.userId ?? null;
  }

  if (sessionId) {
    await revokeSessionById(sessionId, "logout");

    await recordAuditStandalone({
      actorUserId: userId,
      actorScope: "USER",
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      module: "auth",
      resourceType: "session",
      resourceId: sessionId,
      description: "Session logged out",
    });
  }
}

/** Revokes every active session of the account (all devices). */
export async function logoutAll(userId: string): Promise<void> {
  const now = new Date();

  await getDb().transaction(async (tx) => {
    const activeSessions = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));

    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "logout_all" })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));

    const sessionIds = activeSessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(authRefreshTokens.sessionId, sessionIds),
            isNull(authRefreshTokens.revokedAt),
          ),
        );
    }
  });

  await recordAuditStandalone({
    actorUserId: userId,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_LOGOUT_ALL,
    module: "auth",
    resourceType: "user",
    resourceId: userId,
    description: "All sessions logged out",
  });
}

/**
 * Verifies the access JWT and confirms the session is still live. Every request
 * therefore observes logout, logout-all and password-change revocation
 * immediately, even before the access token's own expiry.
 */
export async function resolveAccessTokenSession(
  accessToken: string,
): Promise<AccessTokenSession | null> {
  const claims = await verifyAccessToken(accessToken);

  if (!claims) return null;

  const now = new Date();

  const [row] = await getDb()
    .select({
      sessionId: authSessions.id,
      sessionExpiresAt: authSessions.expiresAt,
      sessionRevokedAt: authSessions.revokedAt,
      sessionActiveTenantId: authSessions.activeTenantId,
      lastUsedAt: authSessions.lastUsedAt,
      userId: users.id,
      userIsActive: users.isActive,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(eq(authSessions.id, claims.sessionId), eq(users.id, claims.userId)))
    .limit(1);

  if (
    !row ||
    row.sessionRevokedAt !== null ||
    row.sessionExpiresAt.getTime() <= now.getTime() ||
    !row.userIsActive
  ) {
    return null;
  }

  // Keep "last used" meaningful without a write on every single request.
  if (now.getTime() - row.lastUsedAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    void (async () => {
      try {
        await getDb()
          .update(authSessions)
          .set({ lastUsedAt: now })
          .where(eq(authSessions.id, row.sessionId));
      } catch (error) {
        logger.warn({ err: error }, "Failed to update session last-used timestamp");
      }
    })();
  }

  return {
    userId: row.userId,
    sessionId: row.sessionId,
    activeTenantId: row.sessionActiveTenantId,
  };
}


/** Active sessions of the account, newest activity first. */
export async function listSessions(
  userId: string,
  currentSessionId: string,
): Promise<readonly SessionSummary[]> {
  const rows = await getDb()
    .select({
      id: authSessions.id,
      userAgent: authSessions.userAgent,
      ipAddress: authSessions.ipAddress,
      createdAt: authSessions.createdAt,
      lastUsedAt: authSessions.lastUsedAt,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(authSessions.lastUsedAt));

  return rows.map((row) => ({
    ...row,
    isCurrent: row.id === currentSessionId,
  }));
}

/**
 * Changes the password and revokes every session, including the current one.
 * The client must sign in again with the new password.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await findUserById(userId);

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Authentication is required");
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw AppError.badRequest("Current password is incorrect");
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  await getDb().transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));

    const activeSessions = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));

    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "password_change" })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));

    const sessionIds = activeSessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(authRefreshTokens.sessionId, sessionIds),
            isNull(authRefreshTokens.revokedAt),
          ),
        );
    }
  });

  await recordAuditStandalone({
    actorUserId: userId,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
    module: "auth",
    resourceType: "user",
    resourceId: userId,
    description: "Password changed; sessions revoked",
  });
}

/**
 * Issues a single-use reset token. The response is deliberately identical for
 * known and unknown identifiers, so the endpoint cannot enumerate accounts.
 */
export async function requestPasswordReset(
  input: ForgotPasswordInput,
): Promise<PasswordResetRequestResult> {
  const user = await findUserByIdentifier(input.identifier);

  if (!user || !user.isActive) {
    return { resetToken: null, expiresAt: null };
  }

  const { token, tokenHash } = generatePasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await getDb().insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  return { resetToken: token, expiresAt };
}

/** Consumes a reset token, sets the new password and revokes all sessions. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [reset] = await getDb()
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (
    !reset ||
    reset.usedAt !== null ||
    reset.expiresAt.getTime() <= now.getTime()
  ) {
    throw AppError.badRequest("Invalid or expired password reset token");
  }

  const user = await findUserById(reset.userId);

  if (!user || !user.isActive) {
    throw AppError.badRequest("Invalid or expired password reset token");
  }

  const passwordHash = await hashPassword(newPassword);

  await getDb().transaction(async (tx) => {
    // Guard against two concurrent submissions of the same token.
    const [consumed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.id, reset.id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });

    if (!consumed) {
      throw AppError.badRequest("Invalid or expired password reset token");
    }

    await tx.update(users).set({ passwordHash }).where(eq(users.id, reset.userId));

    // Remaining unconsumed reset tokens for this account are retired too.
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, reset.userId),
          isNull(passwordResetTokens.usedAt),
        ),
      );

    const activeSessions = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, reset.userId), isNull(authSessions.revokedAt)));

    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "password_reset" })
      .where(and(eq(authSessions.userId, reset.userId), isNull(authSessions.revokedAt)));

    const sessionIds = activeSessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(authRefreshTokens.sessionId, sessionIds),
            isNull(authRefreshTokens.revokedAt),
          ),
        );
    }
  });

  await recordAuditStandalone({
    actorUserId: reset.userId,
    actorScope: "USER",
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET,
    module: "auth",
    resourceType: "user",
    resourceId: reset.userId,
    description: "Password reset; sessions revoked",
  });
}

export async function getPublicUser(userId: string): Promise<PublicUser> {
  const user = await findUserById(userId);

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Authentication is required");
  }

  return toPublicUser(user);
}
