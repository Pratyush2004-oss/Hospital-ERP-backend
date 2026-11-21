import { env } from "../../config/env.js";

/** Cookie names are prefixed to avoid collisions with other apps on the domain. */
export const ACCESS_COOKIE = "hos_access";
export const REFRESH_COOKIE = "hos_refresh";
export const CSRF_COOKIE = "hos_csrf";
export const CSRF_HEADER = "x-csrf-token";

export const JWT_ISSUER = "hospitalos-api";
export const JWT_AUDIENCE = "hospitalos-client";

export const ACCESS_TOKEN_TTL_SECONDS = env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
export const REFRESH_TOKEN_TTL_MS = env.AUTH_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = env.AUTH_PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_MS = env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000;
export const INVITATION_TTL_MS = env.AUTH_INVITATION_TTL_HOURS * 60 * 60 * 1000;
/** Minimum interval between repeated verification/invitation emails. */
export const AUTH_EMAIL_RESEND_COOLDOWN_MS =
  env.AUTH_EMAIL_RESEND_COOLDOWN_SECONDS * 1000;

/**
 * bcrypt cost. 12 is roughly 250-400 ms on current server hardware. Tests use
 * a low cost so the suite stays fast; production is always cost 12.
 */
export const BCRYPT_COST = env.NODE_ENV === "test" ? 4 : 12;

export const COOKIE_SECURE = env.NODE_ENV === "production";
export const COOKIE_SAME_SITE: "lax" | "strict" | "none" =
  env.NODE_ENV === "production" ? "none" : "lax";

/** Access cookies are sent to the whole API; refresh cookies only to auth. */
export const ACCESS_COOKIE_PATH = env.API_PREFIX;
export const AUTH_COOKIE_PATH = `${env.API_PREFIX}/auth`;

/**
 * The CSRF cookie must be readable by the browser client, which lives outside
 * the API path, so it is scoped to the site root.
 */
export const CSRF_COOKIE_PATH = "/";

/** Session last-used timestamps are refreshed at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
