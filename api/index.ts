import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { getPool } from "../src/database/index.js";

const app = createApp();
let restrictedRoleValidation: Promise<void> | null = null;

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
  await assertRestrictedRuntimeRole();
  app(req, res);
}
