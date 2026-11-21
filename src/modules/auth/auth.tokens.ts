import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from "./auth.config.js";

const secretKey = new TextEncoder().encode(env.AUTH_ACCESS_TOKEN_SECRET);

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Short-lived access token. It carries only identity and session id; roles and
 * tenant membership are resolved server-side per request, so revocation and
 * role changes cannot be smuggled past their expiry.
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId, typ: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (
      payload.typ !== "access" ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string"
    ) {
      return null;
    }

    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

/** Refresh tokens are opaque random strings; only their hash is persisted. */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function generatePasswordResetToken(): { token: string; tokenHash: string } {
  return generateSingleUseToken();
}

/** Email verification and staff invitations share the reset-token rules. */
export function generateEmailVerificationToken(): { token: string; tokenHash: string } {
  return generateSingleUseToken();
}

export function generateInvitationToken(): { token: string; tokenHash: string } {
  return generateSingleUseToken();
}

function generateSingleUseToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Timing-safe string comparison for CSRF tokens. */
export function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
