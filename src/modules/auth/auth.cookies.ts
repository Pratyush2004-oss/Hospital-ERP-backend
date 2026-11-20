import type { Request, Response } from "express";
import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_PATH,
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_COOKIE_PATH,
  COOKIE_SECURE,
  CSRF_COOKIE,
  CSRF_COOKIE_PATH,
  COOKIE_SAME_SITE,
  REFRESH_COOKIE,
} from "./auth.config.js";

/**
 * Cookie transport for browser clients.
 *
 * - access token: HttpOnly, whole API path, short lived
 * - refresh token: HttpOnly, auth endpoints only, opaque random string
 * - CSRF token: readable by JavaScript (double-submit cookie), root path
 *
 * `SameSite=Lax` keeps the cookies from being attached to cross-site form
 * posts while still allowing ordinary top-level navigation. Deployment over
 * HTTPS is required in production (`COOKIE_SECURE`).
 */

export interface AuthCookieTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly refreshExpiresAt: Date;
}

export function setAuthCookies(res: Response, tokens: AuthCookieTokens): void {
  const now = Date.now();
  const refreshMaxAge = Math.max(0, tokens.refreshExpiresAt.getTime() - now);

  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    path: ACCESS_COOKIE_PATH,
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    path: AUTH_COOKIE_PATH,
    maxAge: refreshMaxAge,
  });

  res.cookie(CSRF_COOKIE, tokens.csrfToken, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    path: CSRF_COOKIE_PATH,
    maxAge: refreshMaxAge,
  });
}

export function clearAuthCookies(res: Response): void {
  const common = { secure: COOKIE_SECURE, sameSite: COOKIE_SAME_SITE };

  res.clearCookie(ACCESS_COOKIE, { ...common, httpOnly: true, path: ACCESS_COOKIE_PATH });
  res.clearCookie(REFRESH_COOKIE, { ...common, httpOnly: true, path: AUTH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false, path: CSRF_COOKIE_PATH });
}

function readCookie(req: Request, name: string): string | null {
  const value: unknown = req.cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readAccessCookie(req: Request): string | null {
  return readCookie(req, ACCESS_COOKIE);
}

export function readRefreshToken(req: Request): string | null {
  return readCookie(req, REFRESH_COOKIE);
}

export function readCsrfCookie(req: Request): string | null {
  return readCookie(req, CSRF_COOKIE);
}

/** Bearer tokens are supported for non-browser clients. */
export function readBearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Access token for the authentication middleware: the HttpOnly cookie a
 * browser sends, otherwise an explicit `Authorization: Bearer` header.
 */
export function readAccessCredential(req: Request): string | null {
  return readAccessCookie(req) ?? readBearerToken(req);
}
