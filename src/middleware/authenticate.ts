import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/http-error.js";
import {
  getRequestContext,
  requestIdOf,
  runWithRequestContext,
  type RequestActor,
} from "../lib/request-context.js";

/**
 * Authentication seam.
 *
 * Phase 9 deliberately does not verify credentials. The future auth module
 * installs a resolver with `setAuthenticator()` that turns a request into a
 * trusted `RequestActor` (tenant or platform) after checking the session/token
 * and loading the caller's roles and permissions. This middleware then binds
 * that actor to the async request context for services and guards to read.
 *
 * Returning `null` means "no valid credentials" and produces a 401. Throwing is
 * reserved for infrastructure failures (database down, session store
 * unavailable) and flows through the central error handler.
 */

export type Authenticator = (request: Request) => Promise<RequestActor | null>;

let authenticator: Authenticator | null = null;

/**
 * Installs (or clears) the credential resolver. Called once during application
 * bootstrap by the auth module; tests use it to inject deterministic actors.
 */
export function setAuthenticator(next: Authenticator | null): void {
  authenticator = next;
}

export function isAuthenticationConfigured(): boolean {
  return authenticator !== null;
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const resolve = authenticator;

  if (!resolve) {
    next(AppError.unauthorized("Authentication is not configured"));
    return;
  }

  const requestId = requestIdOf(req);
  const metadata = getRequestContext();

  resolve(req)
    .then((actor) => {
      if (!actor) {
        next(AppError.unauthorized("Authentication is required"));
        return;
      }

      runWithRequestContext(
        {
          requestId,
          actor,
          // Preserve the metadata captured before authentication so audit
          // rows on authenticated requests still carry IP and user agent.
          ipAddress: metadata?.ipAddress ?? null,
          userAgent: metadata?.userAgent ?? null,
        },
        next,
      );
    })
    .catch((error: unknown) => {
      next(error);
    });
};

/**
 * Binds an empty context for routes that are intentionally public but still want
 * the request id in the async context (e.g. health probes, public forms).
 */
export const withAnonymousContext: RequestHandler = (req, _res, next) => {
  runWithRequestContext({ requestId: requestIdOf(req), actor: null }, next);
};
