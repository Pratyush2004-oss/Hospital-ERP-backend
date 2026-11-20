import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { env } from "../../config/env.js";
import { LocalStorageProvider } from "./local-storage.provider.js";
import type { StorageProvider } from "./storage.types.js";

/**
 * Storage provider selection.
 *
 * `STORAGE_DRIVER` is validated by `config/env.ts`, so adding an S3-compatible
 * adapter later only needs a new case here plus an implementation of
 * `StorageProvider`. Services depend on the interface, not the adapter.
 *
 * When `STORAGE_SIGNING_SECRET` is unset, the local adapter derives a
 * storage-specific secret from `AUTH_ACCESS_TOKEN_SECRET`. That keeps local
 * development to one required secret, while production can set an independent
 * storage secret so rotating auth tokens never invalidates outstanding download
 * links.
 */

function deriveSigningSecret(): string {
  return createHash("sha256")
    .update(`hospitalos:storage:v1:${env.AUTH_ACCESS_TOKEN_SECRET}`, "utf8")
    .digest("hex");
}

/** Builds a provider from the validated environment. */
export function createStorageProvider(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case "local":
      return new LocalStorageProvider({
        rootDirectory: resolve(process.cwd(), env.STORAGE_LOCAL_ROOT),
        signingSecret: env.STORAGE_SIGNING_SECRET ?? deriveSigningSecret(),
      });
  }
}

let provider: StorageProvider | null = null;

/** Process-wide provider, created on first use. */
export function getStorageProvider(): StorageProvider {
  provider ??= createStorageProvider();
  return provider;
}
