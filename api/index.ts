import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { getPool } from "../src/database/index.js";

const app = createApp();
let restrictedRoleValidation: Promise<void> | null = null;

function isHealthRequest(req: IncomingMessage): boolean {
  const rawPathname = (req.url ?? "").split("?", 1)[0];
  const pathname = rawPathname === "/" ? "/" : rawPathname.replace(/\/+$/, "");
  return pathname === `${env.API_PREFIX}/health`;
}

async function assertRestrictedRuntimeRole(): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  if (!env.APP_DATABASE_URL) {
    throw new Error("APP_DATABASE_URL is required for production serverless runtime.");
  }

  restrictedRoleValidation ??= getPool()
    .query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    )
    .then((result) => {
      const role = result.rows[0];
      if (role?.rolsuper || role?.rolbypassrls) {
        throw new Error(
          "APP_DATABASE_URL must use a NOSUPERUSER NOBYPASSRLS restricted application role.",
        );
      }
    });

  await restrictedRoleValidation;
}

// Vercel invokes this module as a Node serverless function.
// It exports a request handler, never starts app.listen(), and never starts
// in-process notification or reminder timers.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Health must remain reachable as a JSON readiness response even when the
  // runtime database role is misconfigured. It performs the role and
  // dependency checks itself. Protected API routes retain the fail-fast guard.
  if (!isHealthRequest(req)) {
    try {
      await assertRestrictedRuntimeRole();
    } catch (error) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "degraded",
          code: "DATABASE_ROLE_RESTRICTED",
          message: "API database role configuration is not valid.",
        }),
      );
      return;
    }
  }
  app(req, res);
}
