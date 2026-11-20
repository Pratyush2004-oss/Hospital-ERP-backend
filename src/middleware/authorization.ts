import type { RequestHandler } from "express";
import type { PermissionKey } from "../modules/rbac/rbac.catalogue.js";
import { AppError } from "../lib/http-error.js";
import { AUDIT_ACTIONS } from "../modules/audit/audit.types.js";
import { recordAuditStandalone } from "../modules/audit/audit.service.js";
import {
  getRequestActor,
  requirePlatformScope,
  requireTenantScope,
} from "../lib/request-context.js";

/**
 * Route guards for the two authorization planes.
 *
 * They only read the verified context written by `authenticate`; they never
 * inspect the URL, headers or body to decide who the caller is. Mounting a
 * tenant route without `authenticate` first therefore fails closed with 401
 * rather than trusting client-supplied identifiers.
 */

/** Hospital plane: requires a member of exactly one verified tenant. */
/**
 * Records a denied authorization attempt without delaying the response. The
 * actor and request metadata come from the verified async context; no header or
 * body value is trusted or stored.
 */
function auditAuthorizationDenied(
  actor: NonNullable<ReturnType<typeof getRequestActor>>,
  required: readonly string[],
  reason: string,
): void {
  void recordAuditStandalone({
    tenantId: actor.kind === "tenant" ? actor.tenantId : null,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.AUTH_AUTHORIZATION_DENIED,
    module: "auth",
    resourceType: "permission",
    description: "Authorization denied",
    metadata: { requiredPermissions: required, reason },
  });
}

export const requireTenantContext: RequestHandler = (_req, _res, next) => {
  requireTenantScope();
  next();
};

/** Short alias used by hospital-scoped routers. */
export const requireTenant = requireTenantContext;

/** Platform plane: requires HospitalOS staff, rejects hospital members. */
export const requirePlatformContext: RequestHandler = (_req, _res, next) => {
  requirePlatformScope();
  next();
};

/** Requires one of the given `module:action` permissions on the current actor. */
export function requirePermission(...permissions: readonly PermissionKey[]): RequestHandler {
  return (_req, _res, next) => {
    const actor = getRequestActor();

    if (!actor) {
      next(AppError.unauthorized("Authentication is required"));
      return;
    }

    // A credential-only actor has no tenant/platform roles or permissions yet.
    if (actor.kind === "user") {
      auditAuthorizationDenied(actor, permissions, "credential_only_actor");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    const missing = permissions.filter((permission) => !actor.permissions.has(permission));

    if (missing.length > 0) {
      auditAuthorizationDenied(actor, permissions, "missing_permission");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    next();
  };
}

/** Requires at least one of the given `module:action` permissions. */
export function requireAnyPermission(...permissions: readonly PermissionKey[]): RequestHandler {
  return (_req, _res, next) => {
    const actor = getRequestActor();

    if (!actor) {
      next(AppError.unauthorized("Authentication is required"));
      return;
    }

    if (actor.kind === "user") {
      auditAuthorizationDenied(actor, permissions, "credential_only_actor");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    const allowed = permissions.some((permission) => actor.permissions.has(permission));

    if (!allowed) {
      auditAuthorizationDenied(actor, permissions, "missing_permission");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    next();
  };
}

/** Requires one of the given role slugs (hospital or platform, per plane). */
export function requireRole(...roleSlugs: readonly string[]): RequestHandler {
  return (_req, _res, next) => {
    const actor = getRequestActor();

    if (!actor) {
      next(AppError.unauthorized("Authentication is required"));
      return;
    }

    if (actor.kind === "user") {
      auditAuthorizationDenied(actor, roleSlugs, "credential_only_actor");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    const allowed = roleSlugs.some((slug) => actor.roles.includes(slug));

    if (!allowed) {
      auditAuthorizationDenied(actor, roleSlugs, "missing_role");
      next(AppError.forbidden("You do not have permission to perform this action"));
      return;
    }

    next();
  };
}
