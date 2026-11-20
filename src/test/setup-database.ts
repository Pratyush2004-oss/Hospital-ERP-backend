import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import * as schema from "../database/schema/index.js";
import { seedRbacCatalogue } from "../modules/rbac/rbac.seed.js";
import {
  TEST_ADMIN_DATABASE_URL,
  TEST_APP_DATABASE_PASSWORD,
  TEST_APP_DATABASE_USER,
} from "./database-config.js";

/**
 * `npm run pretest` entry point.
 *
 * Creates the isolated test database when missing, applies every Drizzle
 * migration, and provisions the restricted application role used by the API
 * under test. The development database is never touched because a `_test` name
 * is required.
 */
const testUrl = TEST_ADMIN_DATABASE_URL;
const parsed = new URL(testUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

if (!databaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to prepare test database "${databaseName}": the name must end with "_test"`,
  );
}

if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error(`Unsupported test database name: ${databaseName}`);
}

const migrationsFolder = fileURLToPath(new URL("../database/migrations", import.meta.url));

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsupported SQL identifier: ${value}`);
  }

  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureDatabaseExists(): Promise<void> {
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = "/postgres";

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();

  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [
      databaseName,
    ]);

    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      console.log(`Created test database ${databaseName}`);
    }
  } finally {
    await client.end();
  }
}

async function runMigrations(): Promise<void> {
  const client = new Client({ connectionString: testUrl });
  await client.connect();

  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });

    // Seed the global permission catalogue and platform role in the test DB.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform', 'true', true)`);
      await seedRbacCatalogue(tx);
    });

    const role = quoteIdentifier(TEST_APP_DATABASE_USER);
    const password = quoteLiteral(TEST_APP_DATABASE_PASSWORD);

    const existingRole = await client.query("select 1 from pg_roles where rolname = $1", [
      TEST_APP_DATABASE_USER,
    ]);

    if (existingRole.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${role} WITH LOGIN PASSWORD ${password} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    } else {
      await client.query(
        `ALTER ROLE ${role} WITH LOGIN PASSWORD ${password} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    }

    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${role}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    );
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);

    console.log(`Test database ${databaseName} is up to date`);
    console.log(`Restricted test role ready: ${TEST_APP_DATABASE_USER}`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await ensureDatabaseExists();
  await runMigrations();
}

main().catch((error: unknown) => {
  console.error("Failed to prepare the test database:", error);
  process.exitCode = 1;
});
