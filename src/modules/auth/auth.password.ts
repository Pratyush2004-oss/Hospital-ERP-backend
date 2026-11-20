import bcrypt from "bcryptjs";
import { z } from "zod";
import { BCRYPT_COST } from "./auth.config.js";

/**
 * bcrypt only consumes the first 72 bytes of a password; longer input is
 * silently truncated, so it is rejected instead of being accepted with a false
 * sense of strength.
 */
const MAX_PASSWORD_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES, {
    message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
  });

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    // Malformed or legacy (non-bcrypt) hashes never authenticate.
    return false;
  }
}

/**
 * A valid bcrypt hash of a random value, compared against when the account does
 * not exist so that "unknown email" and "wrong password" take similar time.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash("hospitalos-nonexistent-account", BCRYPT_COST);
  return dummyHashPromise;
}

/** Constant-ish-work verification used by login for unknown accounts. */
export async function burnPasswordComparison(password: string): Promise<void> {
  await bcrypt.compare(password, await dummyHash());
}
