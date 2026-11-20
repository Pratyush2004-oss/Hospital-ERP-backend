import type { RequestHandler } from "express";
import {
  getRequestContext,
  requestIdOf,
  runWithRequestContext,
} from "../lib/request-context.js";

const MAX_USER_AGENT_LENGTH = 512;
const MAX_IP_LENGTH = 64;

function truncate(value: string | undefined, maxLength: number): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  return value.slice(0, maxLength);
}

/**
 * Captures request metadata once per request.
 *
 * Authentication later replaces the actor but preserves this metadata. Audit
 * rows can therefore include the correlation id, client address and user agent
 * even for unauthenticated events such as a failed login. `req.ip` honours the
 * configured trust-proxy setting.
 */
export const captureRequestMetadata: RequestHandler = (req, _res, next) => {
  const current = getRequestContext();

  runWithRequestContext(
    {
      requestId: requestIdOf(req),
      actor: current?.actor ?? null,
      ipAddress: truncate(req.ip, MAX_IP_LENGTH),
      userAgent: truncate(req.get("user-agent"), MAX_USER_AGENT_LENGTH),
    },
    next,
  );
};
