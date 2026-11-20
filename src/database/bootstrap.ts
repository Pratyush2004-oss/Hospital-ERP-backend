import { and, eq, isNull, sql } from "drizzle-orm";
import { closePool } from "./connection.js";
import { withPlatformTransaction } from "./context.js";
import {
  platformUserRoles,
  roles,
  users,
} from "./schema/index.js";
import { env } from "../config/env.js";
import { seedRbacCatalogue } from "../modules/rbac/rbac.seed.js";

/**
 * Idempotent RBAC bootstrap: seeds the global permission catalogue and the
 * platform super-admin role. Run with `npm run db:bootstrap` on a new database.
 *
 * Optionally assigns the platform super-admin role to the account named by
 * `PLATFORM_SUPER_ADMIN_EMAIL`, which is how the first platform operator gets
 * access without a manual SQL step.
 */
async function main(): Promise<void> {
  await withPlatformTransaction(async (tx) => {
    await seedRbacCatalogue(tx);
  });

  console.log("RBAC catalogue and platform roles are up to date.");

  if (!env.PLATFORM_SUPER_ADMIN_EMAIL) {
    return;
  }

  await withPlatformTransaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${env.PLATFORM_SUPER_ADMIN_EMAIL}`)
      .limit(1);

    if (!user) {
      throw new Error(
        `PLATFORM_SUPER_ADMIN_EMAIL is set but no account exists for ${env.PLATFORM_SUPER_ADMIN_EMAIL}`,
      );
    }

    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.slug, "platform_super_admin"), isNull(roles.tenantId)))
      .limit(1);

    if (!role) {
      throw new Error("Platform super-admin role was not seeded");
    }

    await tx
      .insert(platformUserRoles)
      .values({ userId: user.id, roleId: role.id })
      .onConflictDoNothing();

    console.log(`Granted platform_super_admin to ${env.PLATFORM_SUPER_ADMIN_EMAIL}.`);
  });
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error: unknown) => {
    console.error("RBAC bootstrap failed:", error);
    await closePool();
    process.exitCode = 1;
  });

