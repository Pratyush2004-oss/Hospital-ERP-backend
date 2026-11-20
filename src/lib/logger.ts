import { pino } from "pino";
import { env } from "../config/env.js";

/**
 * Sensitive values that must never reach the log stream.
 *
 * `remove: true` deletes the property entirely instead of printing `[Redacted]`,
 * so a log line cannot even reveal that a credential was present.
 */
export const redactPaths: readonly string[] = [
  // Transport credentials
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['proxy-authorization']",
  "req.headers['x-api-key']",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  // Common credential fields at any depth (one level wildcard)
  "*.authorization",
  "*.cookie",
  "*.set-cookie",
  "*.password",
  "*.passwordHash",
  "*.newPassword",
  "*.currentPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
  "*.apiKey",
  "*.secret",
  "*.clientSecret",
  // Top-level convenience fields
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwordHash",
  "newPassword",
  "currentPassword",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "secret",
  "clientSecret",
  // Request payloads (pino-http does not log bodies by default; defense in depth)
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.token",
  "req.body.refreshToken",
  "body.password",
  "body.token",
  "body.refreshToken",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "hospitalos-api", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [...redactPaths],
    remove: true,
  },
  serializers: {
    // Drop headers (cookies, bearer tokens) from request logs and keep only the
    // fields needed to correlate a request with a response.
    req(req: { id?: unknown; method?: string; url?: string; remoteAddress?: string }) {
      return {
        id: typeof req.id === "string" ? req.id : String(req.id ?? ""),
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      };
    },
    res(res: { statusCode?: number }) {
      return { statusCode: res.statusCode };
    },
    err(error: Error & { code?: string; statusCode?: number }) {
      return {
        type: error.name,
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        stack: env.NODE_ENV === "development" ? error.stack : undefined,
      };
    },
  },
});
