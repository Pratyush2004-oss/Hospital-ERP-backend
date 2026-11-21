import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { AppError } from "./http-error.js";

/**
 * Request-scoped security context.
 *
 * The tenant is NEVER derived from request input (body, query or headers). It is
 * written once by the authentication middleware from the verified session /
 * membership, and then read by services through `requireTenantScope()`. This
 * keeps a forged `tenantId` in a JSON body from ever becoming authoritative.
 *
 * Two planes exist side by side:
 *   - tenant plane: a staff member acting inside exactly one hospital
 *   - platform plane: HospitalOS staff acting across tenants
 *
 * The two are mutually exclusive, so a platform administrator cannot
 * accidentally be treated as a member of a hospital.
 *
 * A third, credential-only scope represents a signed-in account that has not
 * been resolved to a tenant or platform role yet. It exists so authentication
 * can be implemented (and account endpoints such as `/auth/me` can work)
 * without introducing tenant onboarding or RBAC ahead of schedule. Guards for
 * both planes reject it, so it can never be mistaken for either.
 */

export interface TenantScope {
  readonly kind: "tenant";
  readonly tenantId: string;
  /** Human-readable slug for logging and URLs. */
  readonly tenantSlug: string;
  readonly membershipId: string;
  /** Assigned branches; empty means hospital-wide access. */
  readonly branchIds: readonly string[];
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  /** Flattened `module:action` permissions of the membership's roles. */
  readonly permissions: ReadonlySet<string>;
}

export interface PlatformScope {
  readonly kind: "platform";
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

export interface UserScope {
  readonly kind: "user";
  readonly userId: string;
  readonly sessionId: string;
}

export type RequestActor = TenantScope | PlatformScope | UserScope;

export interface RequestContext {
  readonly requestId: string;
  readonly actor: RequestActor | null;
  /** Client address captured for audit metadata; never used for authorization. */
  readonly ipAddress?: string | null;
  /** Truncated User-Agent captured for audit metadata. */
  readonly userAgent?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Normalizes the id `pino-http` attaches (typed as a union by that package). */
export function requestIdOf(req: Pick<Request, "id">): string {
  const id: unknown = req.id;
  return typeof id === "string" ? id : String(id);
}

/** Runs `callback` with the given context bound to the async call chain. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestActor(): RequestActor | null {
  return storage.getStore()?.actor ?? null;
}

/** Safe request metadata for audit rows; absent outside an HTTP request. */
export function getRequestMetadata(): {
  readonly requestId?: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
} {
  const context = storage.getStore();

  return {
    requestId: context?.requestId,
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,
  };
}

export function getTenantScope(): TenantScope | null {
  const actor = getRequestActor();
  return actor?.kind === "tenant" ? actor : null;
}

export function isTenantScope(actor: RequestActor | null): actor is TenantScope {
  return actor?.kind === "tenant";
}

export function isPlatformScope(actor: RequestActor | null): actor is PlatformScope {
  return actor?.kind === "platform";
}

export function getUserScope(): UserScope | null {
  const actor = getRequestActor();
  return actor?.kind === "user" ? actor : null;
}

export function isUserScope(actor: RequestActor | null): actor is UserScope {
  return actor?.kind === "user";
}

/**
 * Returns the signed-in account (without tenant resolution) or throws.
 * Tenant and platform actors are rejected: callers that need a specific plane
 * must use `requireTenantScope` / `requirePlatformScope` instead.
 */
export function requireUserScope(): UserScope {
  const context = getRequestContext();

  if (!context?.actor) {
    throw AppError.unauthorized("Authentication is required");
  }

  if (context.actor.kind !== "user") {
    throw AppError.forbidden("This operation requires an authenticated account");
  }

  return context.actor;
}

/**
 * Returns the current tenant scope or throws a client-safe error.
 * Missing context means "not authenticated"; a platform actor means "wrong plane".
 */
export function requireTenantScope(): TenantScope {
  const context = getRequestContext();

  if (!context?.actor) {
    throw AppError.unauthorized("Authentication is required");
  }

  if (context.actor.kind !== "tenant") {
    throw AppError.forbidden("This operation requires hospital (tenant) context");
  }

  return context.actor;
}

export function requirePlatformScope(): PlatformScope {
  const context = getRequestContext();

  if (!context?.actor) {
    throw AppError.unauthorized("Authentication is required");
  }

  if (context.actor.kind !== "platform") {
    throw AppError.forbidden("This operation requires platform context");
  }

  return context.actor;
}

/** Convenience for services that only need the id. */
export function requireTenantId(): string {
  return requireTenantScope().tenantId;
}
