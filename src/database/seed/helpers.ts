import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { users } from "../schema/index.js";
import { hashPassword } from "../../modules/auth/auth.password.js";

/**
 * Shared helpers for the development seed.
 *
 * Credentials policy: seeded accounts exist only to make a local environment
 * usable. The default password below is a deliberate, public placeholder - it
 * is not a real credential - and `SEED_ADMIN_PASSWORD` overrides it. Seeding is
 * refused outright in production, so a placeholder can never reach a live
 * installation.
 */
export const DEV_SEED_PASSWORD = "DevOnly-HospitalOS-2026!";

export function assertSeedableEnvironment(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed: this command is development-only. Provision production data through the application instead.",
    );
  }
}

/** `SEED_ADMIN_PASSWORD` when set, otherwise the documented dev placeholder. */
export function resolveSeedPassword(): string {
  assertSeedableEnvironment();

  const override = process.env.SEED_ADMIN_PASSWORD?.trim();
  return override && override.length > 0 ? override : DEV_SEED_PASSWORD;
}

/**
 * Hashes a seeded password with the same bcrypt hasher used by sign-in, so the
 * documented development accounts work through the real auth endpoints.
 */
export async function hashSeedPassword(password: string): Promise<string> {
  return hashPassword(password);
}

/**
 * Inserts or updates a global user. Uniqueness is on `lower(email)`, so the row
 * is looked up case-insensitively instead of relying on an ON CONFLICT target
 * that the generated SQL cannot name.
 */
export async function upsertUser(
  db: Database,
  values: {
    fullName: string;
    email: string;
    phone?: string | null;
    passwordHash: string;
    isActive?: boolean;
  },
): Promise<string> {
  const normalizedEmail = values.email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(1);

  if (existing) {
    await db
      .update(users)
      .set({
        fullName: values.fullName,
        email: normalizedEmail,
        phone: values.phone ?? null,
        passwordHash: values.passwordHash,
        isActive: values.isActive ?? true,
      })
      .where(eq(users.id, existing.id));

    return existing.id;
  }

  const [created] = await db
    .insert(users)
    .values({
      fullName: values.fullName,
      email: normalizedEmail,
      phone: values.phone ?? null,
      passwordHash: values.passwordHash,
      isActive: values.isActive ?? true,
    })
    .returning({ id: users.id });

  if (!created) {
    throw new Error(`Failed to insert user ${normalizedEmail}`);
  }

  return created.id;
}

/** Stable composite key for branch lookups. */
export function branchKey(tenantSlug: string, branchCode: string): string {
  return `${tenantSlug}|${branchCode}`;
}

/** Stable composite key for department lookups. */
export function departmentKey(
  tenantSlug: string,
  branchCode: string,
  departmentSlug: string,
): string {
  return `${tenantSlug}|${branchCode}|${departmentSlug}`;
}
