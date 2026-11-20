import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";
import { getDb } from "./client.js";

/**
 * Database execution context passed to services that may run inside a
 * transaction. Both the singleton client and a transaction satisfy it.
 */
export type DbExecutor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface TransactionContext {
  readonly tenantId?: string | null;
  readonly userId?: string | null;
  readonly isPlatform?: boolean;
}

/**
 * Runs `callback` in a transaction whose PostgreSQL session carries the
 * transaction-local settings the RLS policies read:
 *
 *   app.current_tenant_id  uuid of the verified tenant scope
 *   app.current_user_id    uuid of the signed-in user (for own-membership reads)
 *   app.is_platform        platform-plane bypass for cross-tenant operations
 *
 * `set_config(..., true)` is local to the transaction, so pooled connections
 * never leak one request's tenant context into another request.
 */
export async function withTransactionContext<T>(
  context: TransactionContext,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_tenant_id', ${context.tenantId ?? ""}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.current_user_id', ${context.userId ?? ""}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.is_platform', ${context.isPlatform ? "true" : "false"}, true)`,
    );

    return callback(tx);
  });
}

/** Tenant-scoped operations: RLS only exposes this tenant's rows. */
export function withTenantTransaction<T>(
  tenantId: string,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return withTransactionContext({ tenantId }, callback);
}

/** Reads of a user's own memberships, which span tenants. */
export function withUserTransaction<T>(
  userId: string,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return withTransactionContext({ userId }, callback);
}

/** Platform-plane operations, which may span every tenant. */
export function withPlatformTransaction<T>(
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return withTransactionContext({ isPlatform: true }, callback);
}
