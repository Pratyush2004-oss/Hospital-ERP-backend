import type { Request, RequestHandler } from "express";
import {
  getRequestActor,
  type PlatformScope,
  type RequestActor,
  type TenantScope,
  type UserScope,
} from "../../lib/request-context.js";
import { AppError } from "../../lib/http-error.js";
import { setAuthenticator } from "../../middleware/authenticate.js";
import { resolvePlatformPermissions } from "../rbac/rbac.service.js";
import { resolveTenantContext } from "../tenancy/tenancy.service.js";
import {
  readAccessCookie,
  readAccessCredential,
  readBearerToken,
  readCsrfCookie,
} from "./auth.cookies.js";
import { CSRF_HEADER } from "./auth.config.js";
import { safeTokenEquals } from "./auth.tokens.js";
import { resolveAccessTokenSession } from "./auth.service.js";

/**
 * Turns the access credential into a trusted actor. The access JWT only carries
 * identity and session id; the live session row is loaded on every request so
 * revocation takes effect immediately.
 *
 * Resolution order:
 * 1. an active tenant stored on the session, validated against an ACTIVE
 *    membership and the hospital's ACTIVE status -> tenant plane;
 * 2. platform-plane roles -> platform scope;
 * 3. otherwise a credential-only account that still needs to select a tenant.
 */
export async function resolveRequestActor(request: Request): Promise<RequestActor | null> {
  const token = readAccessCredential(request);

  if (!token) return null;

  const session = await resolveAccessTokenSession(token);

  if (!session) return null;

  if (session.activeTenantId) {
    const tenantContext = await resolveTenantContext(session.userId, session.activeTenantId);

    if (tenantContext) {
      return {
        kind: "tenant",
        tenantId: tenantContext.tenant.id,
        tenantSlug: tenantContext.tenant.slug,
        membershipId: tenantContext.membershipId,
        branchIds: tenantContext.branchIds,
        userId: session.userId,
        sessionId: session.sessionId,
        roles: tenantContext.roles,
        permissions: tenantContext.permissions,
      } satisfies TenantScope;
    }
  }

  const platform = await resolvePlatformPermissions(session.userId);

  if (platform) {
    return {
      kind: "platform",
      userId: session.userId,
      sessionId: session.sessionId,
      roles: platform.roles,
      permissions: platform.permissions,
    } satisfies PlatformScope;
  }

  return {
    kind: "user",
    userId: session.userId,
    sessionId: session.sessionId,
  } satisfies UserScope;
}

/** Installs the auth resolver into the `authenticate` middleware seam. */
export function installAuthentication(): void {
  setAuthenticator(resolveRequestActor);
}

/**
 * Current signed-in account, independent of the active authorization plane.
 * Returns the session-bound identity needed by account endpoints.
 */
export function requireAuthenticatedUser(): { userId: string; sessionId: string } {
  const actor = getRequestActor();

  if (!actor) {
    throw AppError.unauthorized("Authentication is required");
  }

  return { userId: actor.userId, sessionId: actor.sessionId };
}

/**
 * CSRF protection for cookie-authenticated state-changing routes.
 *
 * Double-submit pattern: the `hos_csrf` cookie is readable by the browser
 * client and must be echoed in the `x-csrf-token` header. An attacker on
 * another origin can neither read the cookie nor set the header, so a forged
 * request fails even though the session cookies are attached automatically.
 *
 * Requests authenticated with an explicit `Authorization: Bearer` header are
 * not cookie-driven and therefore not CSRF-able.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  // Only a request that carries no access cookie is genuinely bearer-only.
  // If a cookie is present it wins in `readAccessCredential`, so a stray
  // Authorization header must not be allowed to skip the CSRF check.
  if (!readAccessCookie(req) && readBearerToken(req)) {
    next();
    return;
  }

  const cookieToken = readCsrfCookie(req);
  const headerToken = req.get(CSRF_HEADER)?.trim() ?? null;

  if (!cookieToken || !headerToken || !safeTokenEquals(cookieToken, headerToken)) {
    next(AppError.forbidden("CSRF token missing or invalid"));
    return;
  }

  next();
};
