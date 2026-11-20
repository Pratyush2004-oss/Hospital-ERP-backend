/**
 * Public entry point for database access. Modules should import from here
 * rather than reaching into individual files.
 */
export { getDb, type Database } from "./client.js";
export {
  checkDatabaseConnection,
  closePool,
  getPool,
  isPoolInitialized,
} from "./connection.js";
export * as schema from "./schema/index.js";
