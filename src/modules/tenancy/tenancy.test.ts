import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { createApp } from "../../app.js";
import {
  withPlatformTransaction,
  withTenantTransaction,
} from "../../database/context.js";
import { closePool, getPool } from "../../database/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

let api: TestApi;
const extraClients: TestApi[] = [];

interface DataBody<T> {
  data: T;
}

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

interface ProvisionResult {
  tenant: TenantSummary;
  membershipId: string;
  defaultRoleId: string;
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as DataBody<T>).data;
}

function uniqueEmail(): string {
  return `tenant-${randomUUID()}@example.test`;
}

async function newClient(): Promise<TestApi> {
  const client = await createTestApi(createApp());
  extraClients.push(client);
  return client;
}

async function registerUser(client: TestApi, email = uniqueEmail()): Promise<string> {
  const response = await client.post(`${API}/auth/register`, {
    body: { fullName: "Hospital User", email, password: PASSWORD },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return email;
}

async function loginUser(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function hospitalClient(): Promise<{ client: TestApi; email: string }> {
  const client = await newClient();
  const email = await registerUser(client);
  await loginUser(client, email);
  return { client, email };
}

async function platformClient(): Promise<TestApi> {
  const client = await newClient();
  const email = await registerUser(client);
  const pool = getTestAdminPool();

  const role = await pool.query<{ id: string }>(
    "select id from roles where slug = 'platform_super_admin' and tenant_id is null limit 1",
  );

  assert.equal(role.rowCount, 1, "platform super-admin role is seeded");

  await pool.query(
    "insert into platform_user_roles (user_id, role_id) select id, $1 from users where lower(email) = lower($2)",
    [role.rows[0]!.id, email],
  );

  await loginUser(client, email);
  return client;
}

async function registerTenant(
  client: TestApi,
  name: string,
  slug?: string,
): Promise<ProvisionResult> {
  const response = await client.post(`${API}/tenants/register`, {
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return dataOf<ProvisionResult>(response);
}

async function activateTenant(platform: TestApi, tenantId: string): Promise<void> {
  const response = await platform.post(`${API}/platform/tenants/${tenantId}/activate`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function selectTenant(
  client: TestApi,
  slug: string,
): Promise<{ tenant: TenantSummary; roles: string[]; permissions: string[] }> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return dataOf(response);
}

async function addMembership(
  tenantId: string,
  email: string,
  roleSlugs: readonly string[] = [],
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
): Promise<string> {
  const pool = getTestAdminPool();

  const user = await pool.query<{ id: string }>(
    "select id from users where lower(email) = lower($1)",
    [email],
  );
  assert.equal(user.rowCount, 1, `user ${email} exists`);

  const membership = await pool.query<{ id: string }>(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, $3, now()) returning id`,
    [tenantId, user.rows[0]!.id, status],
  );

  const membershipId = membership.rows[0]!.id;

  for (const slug of roleSlugs) {
    await pool.query(
      `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
       select $1, $2, id from roles where tenant_id = $1 and slug = $3`,
      [tenantId, membershipId, slug],
    );
  }

  return membershipId;
}

before(async () => {
  api = await createTestApi(createApp());
});

afterEach(async () => {
  for (const client of extraClients.splice(0)) {
    await client.close();
  }
});

after(async () => {
  await api.close();
  await closePool();
  await closeTestAdminPool();
});

beforeEach(async () => {
  api.jar.clear();

  // Keep the global permission catalogue and the platform role between tests;
  // everything owned by a tenant or user is removed.
  await getTestAdminPool().query(
    "delete from tenants; delete from users; delete from roles where tenant_id is not null;",
  );
});

describe("hospital registration", () => {
  it("creates a PENDING tenant with the creator as hospital admin", async () => {
    const { client } = await hospitalClient();
    const result = await registerTenant(client, "St. Mary's General");

    assert.equal(result.tenant.status, "PENDING");
    assert.equal(result.tenant.slug, "st-marys-general");
    assert.ok(result.membershipId);
    assert.ok(result.defaultRoleId);

    const pool = getTestAdminPool();

    const membership = await pool.query<{ status: string; user_id: string }>(
      "select status, user_id from tenant_memberships where id = $1",
      [result.membershipId],
    );
    assert.equal(membership.rows[0]!.status, "ACTIVE");

    const granted = await pool.query<{ slug: string }>(
      `select r.slug from membership_roles mr
       join roles r on r.id = mr.role_id
       where mr.tenant_membership_id = $1`,
      [result.membershipId],
    );
    assert.deepEqual(
      granted.rows.map((row) => row.slug),
      ["hospital_admin"],
    );

    const tenantRoles = await pool.query<{ count: number }>(
      "select count(*)::int as count from roles where tenant_id = $1",
      [result.tenant.id],
    );
    assert.equal(tenantRoles.rows[0]!.count, 8, "all seeded hospital roles exist");

    const listing = await client.get(`${API}/tenants/memberships`);
    assert.equal(listing.status, 200);
    const { memberships } = dataOf<{
      memberships: Array<{ tenantId: string; tenantStatus: string; status: string }>;
    }>(listing);
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]!.tenantId, result.tenant.id);
    assert.equal(memberships[0]!.tenantStatus, "PENDING");

    const pendingSelection = await client.post(`${API}/tenants/select`, {
      body: { slug: result.tenant.slug },
    });
    assert.equal(pendingSelection.status, 403, "a pending hospital cannot be selected");
  });

  it("generates unique slugs and rejects an explicit duplicate slug", async () => {
    const { client } = await hospitalClient();

    const first = await registerTenant(client, "St. Mary's General");
    const second = await registerTenant(client, "St. Mary's General");

    assert.equal(first.tenant.slug, "st-marys-general");
    assert.notEqual(second.tenant.slug, first.tenant.slug);
    assert.match(second.tenant.slug, /^st-marys-general-[a-f0-9]{6}$/);

    const duplicate = await client.post(`${API}/tenants/register`, {
      body: { name: "Another Hospital", slug: first.tenant.slug },
    });

    assert.equal(duplicate.status, 409);
  });

  it("rejects tenant selection without a membership", async () => {
    const admin = await hospitalClient();
    const platform = await platformClient();
    const tenant = await registerTenant(admin.client, "Isolation Hospital");
    await activateTenant(platform, tenant.tenant.id);

    const outsider = await hospitalClient();
    const response = await outsider.client.post(`${API}/tenants/select`, {
      body: { slug: tenant.tenant.slug },
    });

    assert.equal(response.status, 403);
  });

  it("rejects a suspended membership during selection", async () => {
    const admin = await hospitalClient();
    const platform = await platformClient();
    const tenant = await registerTenant(admin.client, "Membership Hospital");
    await activateTenant(platform, tenant.tenant.id);

    const suspended = await hospitalClient();
    await addMembership(tenant.tenant.id, suspended.email, [], "SUSPENDED");

    const response = await suspended.client.post(`${API}/tenants/select`, {
      body: { slug: tenant.tenant.slug },
    });
    assert.equal(response.status, 403);
  });
});

describe("tenant selection, authorization and settings", () => {
  it("derives tenant context from the session and enforces suspension", async () => {
    const admin = await hospitalClient();
    const platform = await platformClient();
    const tenant = await registerTenant(admin.client, "Northside Medical");

    await activateTenant(platform, tenant.tenant.id);

    const selected = await selectTenant(admin.client, tenant.tenant.slug);

    assert.equal(selected.tenant.id, tenant.tenant.id);
    assert.ok(selected.roles.includes("hospital_admin"));
    assert.ok(selected.permissions.includes("patient:read"));
    assert.ok(selected.permissions.includes("staff:assign_role"));

    const me = await admin.client.get(`${API}/auth/me`);
    assert.equal(me.status, 200);
    const meData = dataOf<{
      plane: string;
      activeTenant: { id: string } | null;
    }>(me);
    assert.equal(meData.plane, "tenant");
    assert.equal(meData.activeTenant?.id, tenant.tenant.id);

    const emptySettings = await admin.client.get(`${API}/tenants/settings`);
    assert.equal(emptySettings.status, 200);
    assert.deepEqual(dataOf<{ settings: Record<string, unknown> }>(emptySettings).settings, {});

    const update = await admin.client.put(`${API}/tenants/settings/branding`, {
      body: { value: { primaryColor: "#0a7", portalName: "Northside" } },
    });
    assert.equal(update.status, 200);

    const readBack = await admin.client.get(`${API}/tenants/settings`);
    assert.deepEqual(dataOf<{ settings: Record<string, unknown> }>(readBack).settings, {
      branding: { primaryColor: "#0a7", portalName: "Northside" },
    });

    await platform.post(`${API}/platform/tenants/${tenant.tenant.id}/suspend`);

    const afterSuspend = await admin.client.get(`${API}/auth/me`);
    const suspendedData = dataOf<{ plane: string; activeTenant: unknown }>(afterSuspend);
    assert.equal(suspendedData.plane, "user", "suspended tenant stops resolving");
    assert.equal(suspendedData.activeTenant, null);

    const hospitalRoute = await admin.client.get(`${API}/tenant/memberships`);
    assert.equal(hospitalRoute.status, 403);

    await platform.post(`${API}/platform/tenants/${tenant.tenant.id}/activate`);

    const afterReactivate = await admin.client.get(`${API}/auth/me`);
    assert.equal(dataOf<{ plane: string }>(afterReactivate).plane, "tenant");
  });
});

describe("custom roles and permission resolution", () => {
  it("creates custom roles, assigns permissions and enforces them centrally", async () => {
    const admin = await hospitalClient();
    const platform = await platformClient();
    const tenant = await registerTenant(admin.client, "Riverside Clinic");
    await activateTenant(platform, tenant.tenant.id);
    await selectTenant(admin.client, tenant.tenant.slug);

    const member = await hospitalClient();
    const membershipId = await addMembership(tenant.tenant.id, member.email);

    const created = await admin.client.post(`${API}/tenant/roles`, {
      body: {
        name: "Ward Clerk",
        description: "Front desk read access",
        permissions: ["patient:read", "appointment:read"],
      },
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const role = dataOf<{ role: { id: string; slug: string; isSystem: boolean; permissions: string[] } }>(
      created,
    ).role;
    assert.equal(role.slug, "ward-clerk");
    assert.equal(role.isSystem, false);
    assert.deepEqual([...role.permissions].sort(), ["appointment:read", "patient:read"]);

    const assigned = await admin.client.put(
      `${API}/tenant/memberships/${membershipId}/roles`,
      { body: { roleIds: [role.id] } },
    );
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

    await loginUser(member.client, member.email);
    await selectTenant(member.client, tenant.tenant.slug);

    const memberMe = await member.client.get(`${API}/auth/me`);
    const memberData = dataOf<{
      activeTenant: { roles: string[]; permissions: string[] };
    }>(memberMe);
    assert.deepEqual(memberData.activeTenant.roles, ["ward-clerk"]);
    assert.ok(memberData.activeTenant.permissions.includes("patient:read"));
    assert.ok(memberData.activeTenant.permissions.includes("appointment:read"));
    assert.equal(memberData.activeTenant.permissions.includes("patient:create"), false);

    const forbidden = await member.client.get(`${API}/tenant/roles`);
    assert.equal(forbidden.status, 403, "requireAnyPermission rejects the clerk role");

    const roles = await admin.client.get(`${API}/tenant/roles`);
    assert.equal(roles.status, 200);
    const roleList = dataOf<{ roles: Array<{ id: string; slug: string; isSystem: boolean }> }>(roles);
    assert.equal(roleList.roles.length, 9, "8 system roles + 1 custom role");

    const receptionist = roleList.roles.find((item) => item.slug === "receptionist");
    assert.ok(receptionist);

    const replaceRoles = await admin.client.put(
      `${API}/tenant/memberships/${membershipId}/roles`,
      { body: { roleIds: [role.id, receptionist.id] } },
    );
    assert.equal(replaceRoles.status, 200);

    const afterReplace = await member.client.get(`${API}/auth/me`);
    const replaced = dataOf<{ activeTenant: { permissions: string[] } }>(afterReplace);
    assert.ok(replaced.activeTenant.permissions.includes("patient:create"));

    const updatePermissions = await admin.client.put(
      `${API}/tenant/roles/${role.id}/permissions`,
      { body: { permissions: ["appointment:read", "appointment:update"] } },
    );
    assert.equal(updatePermissions.status, 200);
    assert.deepEqual(
      [...dataOf<{ role: { permissions: string[] } }>(updatePermissions).role.permissions].sort(),
      ["appointment:read", "appointment:update"],
    );

    const renamed = await admin.client.patch(`${API}/tenant/roles/${role.id}`, {
      body: { name: "Clinic Coordinator", description: "Updated" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(dataOf<{ role: { name: string } }>(renamed).role.name, "Clinic Coordinator");

    const systemUpdate = await admin.client.patch(
      `${API}/tenant/roles/${receptionist.id}`,
      { body: { name: "Changed" } },
    );
    assert.equal(systemUpdate.status, 409);

    const deleted = await admin.client.delete(`${API}/tenant/roles/${role.id}`);
    assert.equal(deleted.status, 204);

    const afterDelete = await member.client.get(`${API}/auth/me`);
    const afterDeleteData = dataOf<{ activeTenant: { roles: string[] } }>(afterDelete);
    assert.deepEqual(afterDeleteData.activeTenant.roles, ["receptionist"]);
  });
});

describe("tenant isolation", () => {
  it("cannot read or mutate roles and memberships from another hospital", async () => {
    const platform = await platformClient();

    const hospitalA = await hospitalClient();
    const tenantA = await registerTenant(hospitalA.client, "Alpha Hospital");
    await activateTenant(platform, tenantA.tenant.id);
    await selectTenant(hospitalA.client, tenantA.tenant.slug);

    const hospitalB = await hospitalClient();
    const tenantB = await registerTenant(hospitalB.client, "Beta Hospital");
    await activateTenant(platform, tenantB.tenant.id);
    await selectTenant(hospitalB.client, tenantB.tenant.slug);

    const rolesB = await hospitalB.client.get(`${API}/tenant/roles`);
    const receptionistB = dataOf<{ roles: Array<{ id: string; slug: string }> }>(rolesB).roles.find(
      (role) => role.slug === "receptionist",
    );
    assert.ok(receptionistB);

    const crossRole = await hospitalA.client.put(
      `${API}/tenant/roles/${receptionistB.id}/permissions`,
      { body: { permissions: ["patient:read"] } },
    );
    assert.equal(crossRole.status, 404);

    const membersB = await hospitalB.client.get(`${API}/tenant/memberships`);
    const membershipB = dataOf<{ memberships: Array<{ id: string }> }>(membersB).memberships[0];
    assert.ok(membershipB);

    const crossMembership = await hospitalA.client.put(
      `${API}/tenant/memberships/${membershipB.id}/roles`,
      { body: { roleIds: [] } },
    );
    assert.equal(crossMembership.status, 404);

    const crossGrant = await hospitalA.client.put(
      `${API}/tenant/memberships/${tenantA.membershipId}/roles`,
      { body: { roleIds: [receptionistB.id] } },
    );
    assert.equal(crossGrant.status, 400, "a role from another tenant cannot be granted");

    const listA = await hospitalA.client.get(`${API}/tenant/memberships`);
    const membershipsA = dataOf<{ memberships: Array<{ id: string }> }>(listA).memberships;
    assert.deepEqual(
      membershipsA.map((membership) => membership.id),
      [tenantA.membershipId],
    );

    const settingsA = await hospitalA.client.put(`${API}/tenants/settings/branding`, {
      body: { value: { portalName: "Alpha Portal" } },
    });
    const settingsB = await hospitalB.client.put(`${API}/tenants/settings/branding`, {
      body: { value: { portalName: "Beta Portal" } },
    });
    assert.equal(settingsA.status, 200);
    assert.equal(settingsB.status, 200);

    const readA = await hospitalA.client.get(`${API}/tenants/settings`);
    const readB = await hospitalB.client.get(`${API}/tenants/settings`);
    assert.deepEqual(dataOf<{ settings: Record<string, unknown> }>(readA).settings, {
      branding: { portalName: "Alpha Portal" },
    });
    assert.deepEqual(dataOf<{ settings: Record<string, unknown> }>(readB).settings, {
      branding: { portalName: "Beta Portal" },
    });
  });
});

describe("authorization planes", () => {
  it("keeps platform and hospital authorization separate", async () => {
    const platform = await platformClient();
    const hospital = await hospitalClient();
    const tenant = await registerTenant(hospital.client, "Plane Hospital");
    await activateTenant(platform, tenant.tenant.id);
    await selectTenant(hospital.client, tenant.tenant.slug);

    const hospitalOnPlatform = await hospital.client.get(`${API}/platform/tenants`);
    assert.equal(hospitalOnPlatform.status, 403);

    const platformOnHospital = await platform.get(`${API}/tenant/memberships`);
    assert.equal(platformOnHospital.status, 403);

    const platformOnSettings = await platform.get(`${API}/tenants/settings`);
    assert.equal(platformOnSettings.status, 403);
  });
});

describe("platform tenant management", () => {
  it("creates an active tenant with an initial admin and can suspend it", async () => {
    const platform = await platformClient();

    const adminEmail = await registerUser(await newClient());

    const created = await platform.post(`${API}/platform/tenants`, {
      body: { name: "Lakeview Hospital", adminEmail, timezone: "America/New_York" },
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const result = dataOf<ProvisionResult>(created);
    assert.equal(result.tenant.status, "ACTIVE");
    assert.equal(result.tenant.slug, "lakeview-hospital");
    assert.ok(result.membershipId);

    const admin = await newClient();
    await loginUser(admin, adminEmail);
    const selected = await selectTenant(admin, result.tenant.slug);
    assert.ok(selected.roles.includes("hospital_admin"));

    const listed = await platform.get(`${API}/platform/tenants`);
    assert.equal(listed.status, 200);
    const tenants = dataOf<{ tenants: TenantSummary[] }>(listed).tenants;
    assert.ok(tenants.some((tenant) => tenant.id === result.tenant.id));

    const duplicateSlug = await platform.post(`${API}/platform/tenants`, {
      body: { name: "Duplicate", slug: result.tenant.slug },
    });
    assert.equal(duplicateSlug.status, 409);

    const suspended = await platform.post(
      `${API}/platform/tenants/${result.tenant.id}/suspend`,
    );
    assert.equal(suspended.status, 200);
    assert.equal(dataOf<{ tenant: TenantSummary }>(suspended).tenant.status, "SUSPENDED");
  });
});

describe("PostgreSQL row level security and pool safety", () => {
  it("limits tenant rows to the transaction-local tenant id", async () => {
    const platform = await platformClient();

    const hospitalA = await hospitalClient();
    const tenantA = await registerTenant(hospitalA.client, "RLS Alpha");
    await activateTenant(platform, tenantA.tenant.id);

    const hospitalB = await hospitalClient();
    const tenantB = await registerTenant(hospitalB.client, "RLS Beta");
    await activateTenant(platform, tenantB.tenant.id);
    assert.ok(hospitalB.email);

    const role = await getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    assert.equal(role.rows[0]!.rolsuper, false, "runtime uses a non-superuser role");
    assert.equal(role.rows[0]!.rolbypassrls, false, "runtime role cannot bypass RLS");

    const membershipsA = await withTenantTransaction(tenantA.tenant.id, async (tx) => {
      const result = await tx.execute(sql`select tenant_id from tenant_memberships`);
      return result.rows as Array<{ tenant_id: string }>;
    });
    assert.ok(membershipsA.length > 0);
    assert.ok(membershipsA.every((row) => row.tenant_id === tenantA.tenant.id));

    const membershipsB = await withTenantTransaction(tenantB.tenant.id, async (tx) => {
      const result = await tx.execute(sql`select tenant_id from tenant_memberships`);
      return result.rows as Array<{ tenant_id: string }>;
    });
    assert.ok(membershipsB.length > 0);
    assert.ok(membershipsB.every((row) => row.tenant_id === tenantB.tenant.id));

    const rolesA = await withTenantTransaction(tenantA.tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`select tenant_id from roles where tenant_id is not null`,
      );
      return result.rows as Array<{ tenant_id: string }>;
    });
    assert.ok(rolesA.length > 0);
    assert.ok(rolesA.every((row) => row.tenant_id === tenantA.tenant.id));

    await assert.rejects(
      withTenantTransaction(tenantA.tenant.id, async () => {
        throw new Error("simulated tenant-scoped failure");
      }),
      /simulated tenant-scoped failure/,
    );

    // The pool is capped at one connection in tests. After the transaction
    // commits (or rolls back), its local GUC must be gone and must not leak
    // into the next use.
    const leaked = await getPool().query<{ tid: string | null }>(
      "select current_setting('app.current_tenant_id', true) as tid",
    );
    assert.ok(leaked.rows[0]?.tid === null || leaked.rows[0]?.tid === "");

    const withoutContext = await getPool().query<{ count: number }>(
      "select count(*)::int as count from tenant_memberships",
    );
    assert.equal(withoutContext.rows[0]!.count, 0);

    const platformView = await withPlatformTransaction(async (tx) => {
      const result = await tx.execute(sql`select tenant_id from tenant_memberships`);
      return result.rows as Array<{ tenant_id: string }>;
    });
    assert.equal(
      new Set(platformView.map((row) => row.tenant_id)).size,
      2,
      "platform context sees both hospitals",
    );

    const platformLeak = await getPool().query<{ flag: string | null }>(
      "select current_setting('app.is_platform', true) as flag",
    );
    assert.notEqual(platformLeak.rows[0]?.flag, "true");
  });
});
