import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { auditLogs } from "../../database/schema/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * Phase 21.2 audit API integration tests.
 *
 * The Express app and PostgreSQL run for real as the restricted
 * `hospitalos_app` role, so RBAC, tenant predicates, branch validation and RLS
 * are exercised together. Rows are inserted directly (not through the writer)
 * to simulate legacy stored data and to control timestamps.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";
const BASE_TIME = Date.parse("2026-05-01T10:00:00.000Z");

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  };
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
function at(minutes: number): Date {
  return new Date(BASE_TIME + minutes * 60_000);
}

let adminApi: TestApi;
let branchAdminApi: TestApi;
let nurseApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let tenantId: string;
let otherTenantId: string;
let tenantSlug: string;
let branchId: string;
let otherBranchId: string;
let adminUserId: string;
let branchAdminUserId: string;
let nurseUserId: string;
let otherAdminUserId: string;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

const auditIds: Record<string, string> = {};

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@audit-api-phase21.test`;
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

async function addMembership(tenant: string, userId: string, roleSlug: string): Promise<void> {
  const pool = getTestAdminPool();
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1,$2,'ACTIVE',now())`,
    [tenant, userId],
  );
  await pool.query(
    `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
     select m.tenant_id, m.id, r.id
     from tenant_memberships m
     join roles r on r.tenant_id = m.tenant_id and r.slug = $3
     where m.tenant_id = $1 and m.user_id = $2`,
    [tenant, userId, roleSlug],
  );
}

async function selectTenant(client: TestApi, slug: string): Promise<void> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  expect(response.status).toBe(200);
}

async function insertAudit(values: {
  tenant: string;
  actorUserId: string | null;
  action: string;
  module: string;
  resourceId: string;
  branchId?: string | null;
  createdAt: Date;
  metadata?: Record<string, unknown>;
  previousState?: unknown;
  newState?: unknown;
}): Promise<string> {
  const id = randomUUID();

  await withTenantTransaction(values.tenant, (tx) =>
    tx.insert(auditLogs).values({
      id,
      tenantId: values.tenant,
      branchId: values.branchId ?? null,
      actorUserId: values.actorUserId,
      actorScope: values.actorUserId === null ? "SYSTEM" : "TENANT",
      action: values.action,
      module: values.module,
      resourceType: values.module === "patients" ? "patient" : values.module,
      resourceId: values.resourceId,
      description: `Test audit event ${values.action}`,
      previousState: values.previousState,
      newState: values.newState,
      metadata: values.metadata ?? {},
      createdAt: values.createdAt,
    }),
  );

  return id;
}

beforeAll(async () => {
  adminApi = await createTestApi(createApp());
  branchAdminApi = await createTestApi(createApp());
  nurseApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);
  const admin = await createAccount(`audit-api-admin-${suffix}`);
  adminUserId = admin.id;
  await login(adminApi, admin.email);

  const tenantResponse = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Audit API Phase 21 ${suffix}` },
  });
  expect(tenantResponse.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(tenantResponse).tenant;
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  createdTenantIds.push(tenantId);
  await getTestAdminPool().query("update tenants set status='ACTIVE' where id=$1", [tenantId]);
  await selectTenant(adminApi, tenantSlug);

  branchId = randomUUID();
  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,'Central Branch',$3,'UTC',true)`,
    [branchId, tenantId, `AB-${randomUUID().slice(0, 8)}`],
  );

  const branchAdmin = await createAccount(`audit-api-branch-${suffix}`);
  branchAdminUserId = branchAdmin.id;
  await addMembership(tenantId, branchAdminUserId, "branch_admin");
  await login(branchAdminApi, branchAdmin.email);
  await selectTenant(branchAdminApi, tenantSlug);

  const nurse = await createAccount(`audit-api-nurse-${suffix}`);
  nurseUserId = nurse.id;
  await addMembership(tenantId, nurseUserId, "nurse");
  await login(nurseApi, nurse.email);
  await selectTenant(nurseApi, tenantSlug);

  const other = await createAccount(`audit-api-other-${suffix}`);
  otherAdminUserId = other.id;
  await login(otherApi, other.email);
  const otherTenantResponse = await otherApi.post(`${API}/tenants/register`, {
    body: { name: `Audit API Other ${suffix}` },
  });
  expect(otherTenantResponse.status).toBe(201);
  const otherTenant = dataOf<{ tenant: { id: string; slug: string } }>(otherTenantResponse).tenant;
  otherTenantId = otherTenant.id;
  createdTenantIds.push(otherTenantId);
  await getTestAdminPool().query("update tenants set status='ACTIVE' where id=$1", [otherTenantId]);
  await selectTenant(otherApi, otherTenant.slug);

  otherBranchId = randomUUID();
  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,'Other Branch',$3,'UTC',true)`,
    [otherBranchId, otherTenantId, `OB-${randomUUID().slice(0, 8)}`],
  );

  // Remove registration/login rows for this tenant so the fixture below is the
  // complete dataset. Append-only permits deletion only in maintenance mode.
  await getTestAdminPool().query("begin");
  await getTestAdminPool().query("select set_config('app.audit_maintenance','true',true)");
  await getTestAdminPool().query("select set_config('app.is_platform','true',true)");
  await getTestAdminPool().query("delete from audit_logs where tenant_id=$1", [tenantId]);
  await getTestAdminPool().query("commit");

  auditIds.one = await insertAudit({
    tenant: tenantId,
    actorUserId: adminUserId,
    action: "patient.created",
    module: "patients",
    resourceId: "resource-1",
    branchId,
    createdAt: at(1),
    newState: { status: "ACTIVE" },
    metadata: { safe: "kept" },
  });
  auditIds.two = await insertAudit({
    tenant: tenantId,
    actorUserId: adminUserId,
    action: "payment.recorded",
    module: "billing",
    resourceId: "resource-2",
    branchId,
    createdAt: at(2),
  });
  auditIds.three = await insertAudit({
    tenant: tenantId,
    actorUserId: branchAdminUserId,
    action: "appointment.created",
    module: "appointments",
    resourceId: "resource-1",
    createdAt: at(3),
  });
  auditIds.four = await insertAudit({
    tenant: tenantId,
    actorUserId: adminUserId,
    action: "patient.updated",
    module: "patients",
    resourceId: "resource-3",
    branchId,
    createdAt: at(4),
  });
  auditIds.five = await insertAudit({
    tenant: tenantId,
    actorUserId: adminUserId,
    action: "patient.updated",
    module: "patients",
    resourceId: "resource-4",
    branchId,
    createdAt: at(5),
    previousState: { status: "ACTIVE", diagnosis: "influenza" },
    newState: { status: "INACTIVE" },
    metadata: {
      safe: "kept",
      password: "raw-password",
      nested: { token: "raw-token" },
      email: "secret@example.test",
    },
  });
  auditIds.foreign = await insertAudit({
    tenant: otherTenantId,
    actorUserId: otherAdminUserId,
    action: "patient.created",
    module: "patients",
    resourceId: "resource-1",
    branchId: otherBranchId,
    createdAt: at(6),
    metadata: { password: "foreign-secret" },
  });
});

afterAll(async () => {
  const pool = getTestAdminPool();

  // Audit rows are append-only; only a maintenance transaction may remove them.
  await pool.query("begin");
  await pool.query("select set_config('app.audit_maintenance','true',true)");
  await pool.query("select set_config('app.is_platform','true',true)");
  await pool.query(
    `delete from audit_logs
      where tenant_id = any($1::uuid[]) or actor_user_id = any($2::uuid[])`,
    [createdTenantIds, createdUserIds],
  );
  await pool.query("commit");

  for (const tenant of createdTenantIds) {
    await pool.query("delete from tenants where id=$1", [tenant]);
  }
  for (const user of createdUserIds) {
    await pool.query("delete from users where id=$1", [user]);
  }

  await Promise.all([
    adminApi.close(),
    branchAdminApi.close(),
    nurseApi.close(),
    otherApi.close(),
    anonymousApi.close(),
  ]);
  await closeTestAdminPool();
  await closePool();
});

describe("audit API authorization", () => {
  it("requires authentication and audit:read", async () => {
    expect((await anonymousApi.get(`${API}/audit-logs`)).status).toBe(401);
    expect((await branchAdminApi.get(`${API}/audit-logs`)).status).toBe(200);
    expect((await adminApi.get(`${API}/audit-logs`)).status).toBe(200);
  });

  it("exposes no write route for audit records", async () => {
    expect((await adminApi.post(`${API}/audit-logs`, { body: {} })).status).toBe(404);
    expect((await adminApi.patch(`${API}/audit-logs/${auditIds.one}`, { body: {} })).status).toBe(
      404,
    );
    expect((await adminApi.delete(`${API}/audit-logs/${auditIds.one}`)).status).toBe(404);

    const { rows } = await getTestAdminPool().query(
      "select description from audit_logs where id=$1",
      [auditIds.one],
    );
    expect(rows[0]?.description).toBe("Test audit event patient.created");
  });
});

describe("audit listing", () => {
  it("returns paginated tenant activity with metadata", async () => {
    const first = await adminApi.get(`${API}/audit-logs?page=1&limit=2`);

    expect(first.status).toBe(200);
    const body = first.body as Envelope<{ auditLogs: Array<{ id: string }> }>;
    expect(body.data.auditLogs).toHaveLength(2);
    expect(body.meta?.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(body.data.auditLogs.map((row) => row.id)).toEqual([auditIds.five, auditIds.four]);

    const second = await adminApi.get(`${API}/audit-logs?page=2&limit=2`);
    expect(
      (second.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.three, auditIds.two]);
  });

  it("filters by actor, module, action, resource and branch", async () => {
    const byActor = await adminApi.get(
      `${API}/audit-logs?actorUserId=${branchAdminUserId}&limit=100`,
    );
    expect(
      (byActor.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.three]);

    const byModule = await adminApi.get(`${API}/audit-logs?module=patients&limit=100`);
    expect(
      (byModule.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs,
    ).toHaveLength(3);

    const byAction = await adminApi.get(`${API}/audit-logs?action=patient.updated&limit=100`);
    expect(
      (byAction.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs,
    ).toHaveLength(2);

    const byResource = await adminApi.get(`${API}/audit-logs?resourceId=resource-1&limit=100`);
    expect(
      (byResource.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.three, auditIds.one]);

    const byBranch = await adminApi.get(`${API}/audit-logs?branchId=${branchId}&limit=100`);
    expect(
      (byBranch.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs,
    ).toHaveLength(4);

    // The other tenant's row shares this resourceId but must never appear.
    expect(JSON.stringify(byResource.body)).not.toContain(auditIds.foreign);
  });

  it("filters by an inclusive date range and supports ascending order", async () => {
    const from = at(2).toISOString();
    const to = at(4).toISOString();
    const ranged = await adminApi.get(
      `${API}/audit-logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`,
    );

    expect(
      (ranged.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.four, auditIds.three, auditIds.two]);

    const ascending = await adminApi.get(`${API}/audit-logs?page=1&limit=2&sortOrder=asc`);
    expect(
      (ascending.body as Envelope<{ auditLogs: Array<{ id: string }> }>).data.auditLogs.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.one, auditIds.two]);
  });

  it("rejects invalid filters and client-supplied tenant ids", async () => {
    const reversed = await adminApi.get(
      `${API}/audit-logs?from=${encodeURIComponent(at(5).toISOString())}&to=${encodeURIComponent(
        at(1).toISOString(),
      )}`,
    );
    expect(reversed.status).toBe(422);
    expect(errorOf(reversed).code).toBe("VALIDATION_ERROR");

    expect((await adminApi.get(`${API}/audit-logs?limit=101`)).status).toBe(422);
    expect((await adminApi.get(`${API}/audit-logs?sortOrder=newest`)).status).toBe(422);
    expect((await adminApi.get(`${API}/audit-logs?actorUserId=not-a-uuid`)).status).toBe(422);
    expect(
      (await adminApi.get(`${API}/audit-logs?tenantId=${otherTenantId}`)).status,
    ).toBe(422);
  });
});

describe("audit detail and recent activity", () => {
  it("returns one tenant-owned record with sensitive values redacted", async () => {
    const response = await adminApi.get(`${API}/audit-logs/${auditIds.five}`);
    expect(response.status).toBe(200);

    const auditLog = dataOf<{
      auditLog: {
        id: string;
        metadata: Record<string, unknown>;
        previousState: Record<string, unknown>;
        newState: Record<string, unknown>;
      };
    }>(response).auditLog;

    expect(auditLog.id).toBe(auditIds.five);
    expect(auditLog.metadata.safe).toBe("kept");
    expect(auditLog.metadata.password).toBe("[REDACTED]");
    expect((auditLog.metadata.nested as Record<string, unknown>).token).toBe("[REDACTED]");
    expect(auditLog.metadata.email).toBe("[REDACTED]");
    expect(auditLog.previousState.diagnosis).toBe("[REDACTED]");
    expect(auditLog.previousState.status).toBe("ACTIVE");
    expect(auditLog.newState.status).toBe("INACTIVE");
    expect(JSON.stringify(response.body)).not.toContain("raw-password");
    expect(JSON.stringify(response.body)).not.toContain("raw-token");
    expect(JSON.stringify(response.body)).not.toContain("foreign-secret");
  });

  it("hides another tenant's record and rejects malformed ids", async () => {
    const foreign = await adminApi.get(`${API}/audit-logs/${auditIds.foreign}`);
    expect(foreign.status).toBe(404);

    expect((await adminApi.get(`${API}/audit-logs/${randomUUID()}`)).status).toBe(404);
    expect((await adminApi.get(`${API}/audit-logs/not-a-uuid`)).status).toBe(422);
  });

  it("returns bounded recent activity for the tenant or one branch", async () => {
    const recent = await adminApi.get(`${API}/audit-logs/recent?limit=2`);
    expect(recent.status).toBe(200);
    expect(
      (recent.body as Envelope<{ activity: Array<{ id: string }> }>).data.activity.map(
        (row) => row.id,
      ),
    ).toEqual([auditIds.five, auditIds.four]);

    const branchRecent = await adminApi.get(
      `${API}/audit-logs/recent?branchId=${branchId}&limit=100`,
    );
    expect(
      (branchRecent.body as Envelope<{ activity: Array<{ id: string }> }>).data.activity,
    ).toHaveLength(4);

    // A branch from another hospital is not disclosed.
    expect(
      (await adminApi.get(`${API}/audit-logs/recent?branchId=${otherBranchId}`)).status,
    ).toBe(404);
    expect(
      (await adminApi.get(`${API}/audit-logs?branchId=${otherBranchId}`)).status,
    ).toBe(404);
  });
});

describe("audit RLS", () => {
  it("denies a role without audit:read", async () => {
    const denied = await nurseApi.get(`${API}/audit-logs`);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe("FORBIDDEN");
  });

  it("keeps rows invisible to the restricted role without tenant context", async () => {
    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-audit-api-rls-test",
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
      const own = await client.query("select id from audit_logs where id=$1", [auditIds.one]);
      const foreign = await client.query("select id from audit_logs where id=$1", [
        auditIds.foreign,
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
});
