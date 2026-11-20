import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { recordCreateAudit } from "./audit.service.js";

/**
 * Phase 21.1 audit integration tests.
 *
 * These run against the real PostgreSQL schema as the restricted
 * `hospitalos_app` role, so RLS and the append-only trigger are proven at the
 * database layer rather than only through service code. Provider calls are not
 * involved.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface Envelope<T> {
  data: T;
}
interface ErrorEnvelope {
  error: { code: string; message: string };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}
function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

let adminApi: TestApi;
let unprivilegedApi: TestApi;
let anonymousApi: TestApi;

let tenantId: string;
let tenantSlug: string;
let adminUserId: string;
let unprivilegedUserId: string;
let patientId: string;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const testStartedAt = new Date();

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@audit-phase21.test`;
  const client = await createTestApi(createApp());

  try {
    const response = await client.post(`${API}/auth/register`, {
      body: { fullName: label, email, password: PASSWORD },
    });
    expect(response.status).toBe(201);
    const id = dataOf<{ user: { id: string } }>(response).user.id;
    createdUserIds.push(id);
    return { id, email };
  } finally {
    await client.close();
  }
}

async function login(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function addMembership(tenant: string, userId: string): Promise<void> {
  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1,$2,'ACTIVE',now())`,
    [tenant, userId],
  );
}

async function waitForAudit(
  predicateSql: string,
  values: readonly unknown[],
  timeoutMs = 3_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getTestAdminPool().query(predicateSql, [...values]);
    if (result.rows.length > 0) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return [];
}

beforeAll(async () => {
  adminApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);
  const admin = await createAccount(`audit-admin-${suffix}`);
  adminUserId = admin.id;
  await login(adminApi, admin.email);

  const tenantResponse = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Audit Phase 21 ${suffix}` },
  });
  expect(tenantResponse.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(tenantResponse).tenant;
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  createdTenantIds.push(tenantId);
  await getTestAdminPool().query("update tenants set status='ACTIVE' where id=$1", [tenantId]);
  await adminApi.post(`${API}/tenants/select`, { body: { slug: tenantSlug } });

  const unprivileged = await createAccount(`audit-unprivileged-${suffix}`);
  unprivilegedUserId = unprivileged.id;
  await addMembership(tenantId, unprivilegedUserId);
  await login(unprivilegedApi, unprivileged.email);
  await unprivilegedApi.post(`${API}/tenants/select`, { body: { slug: tenantSlug } });
});

afterAll(async () => {
  const pool = getTestAdminPool();

  // Audit rows are append-only; a controlled maintenance transaction is the
  // only supported way to remove test data.
  await pool.query("begin");
  await pool.query("select set_config('app.audit_maintenance','true',true)");
  await pool.query("select set_config('app.is_platform','true',true)");
  await pool.query("delete from audit_logs where created_at >= $1", [testStartedAt.toISOString()]);
  await pool.query("commit");

  for (const tenant of createdTenantIds) {
    await pool.query("delete from tenants where id=$1", [tenant]);
  }
  for (const user of createdUserIds) {
    await pool.query("delete from users where id=$1", [user]);
  }

  await Promise.all([adminApi.close(), unprivilegedApi.close(), anonymousApi.close()]);
  await closeTestAdminPool();
  await closePool();
});

describe("audit event creation and redaction", () => {
  it("stores actor, tenant and resource identity", async () => {
    const id = randomUUID();

    await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.created",
        module: "test",
        resourceType: "widget",
        resourceId: id,
        description: "Widget created",
        newState: { status: "ACTIVE" },
        metadata: { source: "integration-test" },
      }),
    );

    const { rows } = await getTestAdminPool().query(
      `select tenant_id, actor_user_id, actor_scope, module, action,
              resource_type, resource_id, new_state, metadata
         from audit_logs where resource_id=$1`,
      [id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId,
      actor_user_id: adminUserId,
      actor_scope: "SYSTEM",
      module: "test",
      action: "test.created",
      resource_type: "widget",
      resource_id: id,
    });
    expect(rows[0]?.new_state).toEqual({ status: "ACTIVE" });
  });

  it("redacts credentials, contact data and clinical free text", async () => {
    const id = randomUUID();

    await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.redaction",
        module: "test",
        resourceType: "widget",
        resourceId: id,
        newState: {
          status: "ACTIVE",
          password: "super-secret",
          nested: { token: "raw-token", phone: "+919876543210" },
          diagnosis: "influenza",
        },
        metadata: {
          apiKey: "api-key-value",
          safe: "kept",
          contact: { email: "person@example.test" },
        },
      }),
    );

    const { rows } = await getTestAdminPool().query(
      "select new_state, metadata from audit_logs where resource_id=$1",
      [id],
    );
    const state = rows[0]?.new_state as Record<string, unknown>;
    const metadata = rows[0]?.metadata as Record<string, unknown>;

    expect(state.status).toBe("ACTIVE");
    expect(state.password).toBe("[REDACTED]");
    expect((state.nested as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((state.nested as Record<string, unknown>).phone).toBe("[REDACTED]");
    expect(state.diagnosis).toBe("[REDACTED]");
    expect(metadata.apiKey).toBe("[REDACTED]");
    expect(metadata.safe).toBe("kept");
    expect((metadata.contact as Record<string, unknown>).email).toBe("[REDACTED]");
    expect(JSON.stringify(rows[0])).not.toContain("super-secret");
    expect(JSON.stringify(rows[0])).not.toContain("raw-token");
  });

  it("does not persist a successful audit event when the transaction rolls back", async () => {
    const id = randomUUID();

    await expect(
      withTenantTransaction(tenantId, async (tx) => {
        await recordCreateAudit(tx, {
          tenantId,
          actorUserId: adminUserId,
          action: "test.rollback",
          module: "test",
          resourceType: "widget",
          resourceId: id,
          description: "Should disappear",
        });
        throw new Error("business failure");
      }),
    ).rejects.toThrow("business failure");

    const { rows } = await getTestAdminPool().query(
      "select id from audit_logs where resource_id=$1",
      [id],
    );
    expect(rows).toHaveLength(0);
  });

  it("prevents duplicate audit events with a dedupe key", async () => {
    const dedupeKey = `audit-dedupe:${randomUUID()}`;

    const first = await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.dedupe",
        module: "test",
        resourceType: "widget",
        resourceId: "dedupe-resource",
        dedupeKey,
      }),
    );
    const second = await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.dedupe",
        module: "test",
        resourceType: "widget",
        resourceId: "dedupe-resource",
        dedupeKey,
      }),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const { rows } = await getTestAdminPool().query(
      "select count(*)::int as count from audit_logs where dedupe_key=$1",
      [dedupeKey],
    );
    expect(rows[0]?.count).toBe(1);
  });
});

describe("module activity tracking", () => {
  it("records authentication, tenant selection, patient creation and denial", async () => {
    const pool = getTestAdminPool();

    const loginRows = await pool.query(
      `select actor_user_id, actor_scope, request_id, ip_address
         from audit_logs
        where action='auth.login.succeeded' and actor_user_id=$1
        order by created_at desc limit 1`,
      [adminUserId],
    );
    expect(loginRows.rows).toHaveLength(1);
    expect(loginRows.rows[0]?.actor_scope).toBe("USER");
    expect(loginRows.rows[0]?.request_id).not.toBeNull();

    const selected = await pool.query(
      `select tenant_id from audit_logs
        where action='auth.tenant.selected' and actor_user_id=$1 limit 1`,
      [adminUserId],
    );
    expect(selected.rows[0]?.tenant_id).toBe(tenantId);

    const patientResponse = await adminApi.post(`${API}/patients`, {
      body: { fullName: "Audit Patient", gender: "OTHER" },
    });
    expect(patientResponse.status).toBe(201);
    patientId = dataOf<{ patient: { id: string } }>(patientResponse).patient.id;

    const patientAudit = await pool.query(
      `select module, action, tenant_id, metadata
         from audit_logs where action='patient.created' and resource_id=$1`,
      [patientId],
    );
    expect(patientAudit.rows).toHaveLength(1);
    expect(patientAudit.rows[0]?.tenant_id).toBe(tenantId);
    expect(JSON.stringify(patientAudit.rows[0])).not.toContain("Audit Patient");

    const denied = await unprivilegedApi.get(`${API}/patients`);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe("FORBIDDEN");

    const denialRows = await waitForAudit(
      `select action, actor_user_id, metadata from audit_logs
        where action='auth.authorization.denied' and actor_user_id=$1`,
      [unprivilegedUserId],
    );
    expect(denialRows.length).toBeGreaterThanOrEqual(1);

    const failedLogin = await anonymousApi.post(`${API}/auth/login`, {
      body: { identifier: "nobody@example.test", password: "wrong-password" },
    });
    expect(failedLogin.status).toBe(401);

    const failedRows = await waitForAudit(
      `select action from audit_logs
        where action='auth.login.failed' order by created_at desc limit 1`,
      [],
    );
    expect(failedRows.length).toBe(1);
  });
});

describe("tenant isolation and immutability", () => {
  it("hides foreign audit rows from the restricted application role", async () => {
    const ownId = randomUUID();
    const foreignId = randomUUID();
    const foreignTenantId = randomUUID();

    await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.rls.own",
        module: "test",
        resourceType: "widget",
        resourceId: ownId,
      }),
    );
    await withTenantTransaction(foreignTenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId: foreignTenantId,
        actorUserId: adminUserId,
        action: "test.rls.foreign",
        module: "test",
        resourceType: "widget",
        resourceId: foreignId,
      }),
    );

    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-audit-rls-test",
    });
    const client = await pool.connect();

    try {
      const identity = await client.query<{ current_user: string; bypass: boolean }>(
        `select current_user,
                coalesce((select rolbypassrls from pg_roles where rolname = current_user), true) as bypass`,
      );
      expect(identity.rows[0]?.current_user).toBe("hospitalos_app");
      expect(identity.rows[0]?.bypass).toBe(false);

      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("select set_config('app.is_platform','false',true)");

      const own = await client.query("select id from audit_logs where resource_id=$1", [ownId]);
      const foreign = await client.query("select id from audit_logs where resource_id=$1", [
        foreignId,
      ]);
      expect(own.rows).toHaveLength(1);
      expect(foreign.rows).toHaveLength(0);
      await client.query("rollback");

      await client.query("begin");
      const noContext = await client.query<{ count: number }>(
        "select count(*)::int as count from audit_logs",
      );
      expect(noContext.rows[0]?.count).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("blocks application updates and deletes on audit rows", async () => {
    const id = randomUUID();

    await withTenantTransaction(tenantId, (tx) =>
      recordCreateAudit(tx, {
        tenantId,
        actorUserId: adminUserId,
        action: "test.immutable",
        module: "test",
        resourceType: "widget",
        resourceId: id,
      }),
    );

    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-audit-immutability-test",
    });
    const client = await pool.connect();

    try {
      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("select set_config('app.is_platform','false',true)");
      await expect(
        client.query("update audit_logs set description='tampered' where resource_id=$1", [id]),
      ).rejects.toThrow(/append-only/i);
      await client.query("rollback");

      // A failed statement aborts its transaction, so the delete check starts a
      // fresh one.
      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("select set_config('app.is_platform','false',true)");
      await expect(
        client.query("delete from audit_logs where resource_id=$1", [id]),
      ).rejects.toThrow(/append-only/i);
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
