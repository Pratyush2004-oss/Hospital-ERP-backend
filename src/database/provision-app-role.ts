import { Client } from "pg";
import { env, getAdminDatabaseUrl } from "../config/env.js";

/**
 * Provisions (or rotates) the restricted application role used by
 * `APP_DATABASE_URL`.
 *
 * The role is explicitly NOSUPERUSER and NOBYPASSRLS, so PostgreSQL row level
 * security policies always apply. It receives only the DML privileges the API
 * needs; schema migrations continue to run with `DATABASE_URL`.
 *
 * Usage: `npm run db:provision-app-role`
 */
function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsupported SQL identifier: ${value}`);
  }

  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  if (!env.APP_DATABASE_URL) {
    throw new Error(
      "APP_DATABASE_URL is required. It must contain the restricted runtime role's credentials.",
    );
  }

  const adminUrl = new URL(getAdminDatabaseUrl());
  const appUrl = new URL(env.APP_DATABASE_URL);

  if (
    adminUrl.hostname !== appUrl.hostname ||
    adminUrl.port !== appUrl.port ||
    adminUrl.pathname !== appUrl.pathname
  ) {
    throw new Error(
      "DATABASE_URL and APP_DATABASE_URL must point at the same database; only the credentials should differ.",
    );
  }

  const roleName = decodeURIComponent(appUrl.username);
  const password = decodeURIComponent(appUrl.password);
  const databaseName = decodeURIComponent(appUrl.pathname.replace(/^\//, ""));

  if (!roleName) throw new Error("APP_DATABASE_URL must include a username");
  if (!password) throw new Error("APP_DATABASE_URL must include a password");
  if (!databaseName) throw new Error("APP_DATABASE_URL must include a database name");

  const role = quoteIdentifier(roleName);
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();

  try {
    const existing = await client.query("select 1 from pg_roles where rolname = $1", [roleName]);

    if (existing.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    } else {
      await client.query(
        `ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
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

    const verification = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = $1",
      [roleName],
    );
    const verified = verification.rows[0];

    if (!verified || verified.rolsuper || verified.rolbypassrls) {
      throw new Error(`Role ${roleName} still bypasses row level security`);
    }

    console.log(`Application role ready: ${roleName} (NOSUPERUSER, NOBYPASSRLS)`);
    console.log(`Granted DML privileges on ${databaseName}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to provision the application role:", error);
  process.exitCode = 1;
});
