import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getPool } from "./connection.js";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

let db: Database | null = null;

/** Lazily created singleton Drizzle client backed by the shared pg pool. */
export function getDb(): Database {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }

  return db;
}
