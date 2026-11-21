import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/index.js";
import {
  clearMockAuthMailOutbox,
  mockAuthMailOutbox,
} from "../auth-mail/auth-mail.providers.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

let api: TestApi;
const clients: TestApi[] = [];

function dataOf<T>(response: TestResponse): T {
  return (response.body as { data: T }).data;
}

function uniqueEmail(prefix = "staff"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

async function newClient(): Promise<TestApi> {
  const client = await createTestApi(createApp());
  clients.push(client);
  return client;
}

async function register(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/register`, {
    body: { fullName: "Staff Test User", email, password: PASSWORD },
  });
  expect(response.status).toBe(201);
}

async function login(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function platformClient(): Promise<TestApi> {
  const client = await newClient();
  const email = uniqueEmail("platform");
  await register(client, email);

  await getTestAdminPool().query(
    `insert into platform_user_roles (user_id, role_id)
     select id, (select id from roles where slug = 'platform_super_admin' and tenant_id is null)
     from users where lower(email) = lower($1)`,
    [email],
  );

  await login(client, email);
  return client;
}

interface TenantSetup {
  admin: TestApi;
  tenantId: string;
  tenantSlug: string;
  branchId: string;
  departmentId: string;
  doctorRoleId: string;
}

async function setupTenant(): Promise<TenantSetup> {
  const admin = await newClient();
  const email = uniqueEmail("admin");
  await register(admin, email);
  await login(admin, email);

  const created = await admin.post(`${API}/tenants/register`, {
    body: { name: `Staff Hospital ${randomUUID()}` },
  });
  expect(created.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(created).tenant;

  const platform = await platformClient();
  const activated = await platform.post(`${API}/platform/tenants/${tenant.id}/activate`);
  expect(activated.status).toBe(200);

  const selected = await admin.post(`${API}/tenants/select`, {
    body: { slug: tenant.slug },
  });
  expect(selected.status).toBe(200);

  const pool = getTestAdminPool();
  const branch = await pool.query<{ id: string }>(
    `insert into branches (tenant_id, name, branch_code)
     values ($1, 'Main Branch', $2) returning id`,
    [tenant.id, `BR-${randomUUID().slice(0, 8)}`],
  );
  const department = await pool.query<{ id: string }>(
    `insert into departments (tenant_id, branch_id, name, slug)
     values ($1, $2, 'Cardiology', $3) returning id`,
    [tenant.id, branch.rows[0]!.id, `cardiology-${randomUUID().slice(0, 8)}`],
  );
  const doctorRole = await pool.query<{ id: string }>(
    "select id from roles where tenant_id = $1 and slug = 'doctor' limit 1",
    [tenant.id],
  );

  return {
    admin,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    branchId: branch.rows[0]!.id,
    departmentId: department.rows[0]!.id,
    doctorRoleId: doctorRole.rows[0]!.id,
  };
}

function latestToken(): string {
  const message = [...mockAuthMailOutbox]
    .reverse()
    .find((entry) => entry.kind === "STAFF_INVITATION");
  if (!message) throw new Error("No staff invitation email was recorded");

  const match = message.text.match(/\?token=([^\s]+)/);
  if (!match?.[1]) throw new Error("Invitation link did not contain a token");
  return decodeURIComponent(match[1]);
}

async function invite(
  client: TestApi,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return client.post(`${API}/tenant/staff/invitations`, { body });
}

beforeAll(async () => {
  api = await createTestApi(createApp());
});

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close();
  await api.close();
  await closePool();
  await closeTestAdminPool();
});

describe("staff invitation lifecycle", () => {
  it("creates an INVITED membership for an existing user and activates it on acceptance", async () => {
    const setup = await setupTenant();
    const inviteeEmail = uniqueEmail("existing");
    const invitee = await newClient();
    await register(invitee, inviteeEmail);

    clearMockAuthMailOutbox();
    const response = await invite(setup.admin, {
      email: inviteeEmail,
      fullName: "Existing Doctor",
      roleIds: [setup.doctorRoleId],
      branchIds: [setup.branchId],
      departmentIds: [setup.departmentId],
    });

    expect(response.status).toBe(202);
    const invitation = dataOf<{
      invitation: { invitationId: string; membershipId: string; status: string };
    }>(response).invitation;
    expect(invitation.membershipId).toBeTruthy();

    const membershipBefore = await getTestAdminPool().query<{
      status: string;
      branch_ids: string[];
    }>("select status, branch_ids from tenant_memberships where id = $1", [
      invitation.membershipId,
    ]);
    expect(membershipBefore.rows[0]?.status).toBe("INVITED");
    expect(membershipBefore.rows[0]?.branch_ids).toContain(setup.branchId);

    const listed = await setup.admin.get(`${API}/tenant/staff/invitations`);
    expect(listed.status).toBe(200);
    expect(
      dataOf<{ invitations: Array<{ id: string; status: string }> }>(listed).invitations.find(
        (entry) => entry.id === invitation.invitationId,
      )?.status,
    ).toBe("INVITED");

    const memberships = await setup.admin.get(`${API}/tenant/memberships`);
    expect(
      dataOf<{ memberships: Array<{ id: string; status: string }> }>(
        memberships,
      ).memberships.find((entry) => entry.id === invitation.membershipId)?.status,
    ).toBe("INVITED");

    const details = await invitee.post(`${API}/auth/invitations/details`, {
      body: { token: latestToken() },
    });
    expect(details.status).toBe(200);
    expect(dataOf<{ invitation: { valid: boolean; status: string; requiresPassword: boolean } }>(
      details,
    ).invitation).toMatchObject({
      valid: true,
      status: "INVITED",
      requiresPassword: false,
    });

    const accepted = await invitee.post(`${API}/auth/invitations/accept`, {
      body: { token: latestToken() },
    });
    expect(accepted.status).toBe(200);
    expect(dataOf<{ accountCreated: boolean }>(accepted).accountCreated).toBe(false);

    const membershipAfter = await getTestAdminPool().query<{ status: string }>(
      "select status from tenant_memberships where id = $1",
      [invitation.membershipId],
    );
    expect(membershipAfter.rows[0]?.status).toBe("ACTIVE");

    const replay = await invitee.post(`${API}/auth/invitations/accept`, {
      body: { token: latestToken() },
    });
    expect(replay.status).toBe(400);
  });

  it("supports new accounts and exposes only safe token details", async () => {
    const setup = await setupTenant();
    const inviteeEmail = uniqueEmail("new");
    clearMockAuthMailOutbox();

    const response = await invite(setup.admin, {
      email: inviteeEmail,
      fullName: "New Doctor",
      roleIds: [setup.doctorRoleId],
      branchIds: [setup.branchId],
    });
    expect(response.status).toBe(202);
    const invitationId = dataOf<{ invitation: { invitationId: string } }>(response).invitation
      .invitationId;
    const token = latestToken();

    const details = await api.post(`${API}/auth/invitations/details`, {
      body: { token },
    });
    expect(details.status).toBe(200);
    const invitation = dataOf<{
      invitation: {
        valid: boolean;
        status: string;
        hospitalName: string;
        email: string;
        requiresPassword: boolean;
        roles: Array<{ name: string }>;
        branches: Array<{ name: string }>;
      };
    }>(details).invitation;

    expect(invitation.valid).toBe(true);
    expect(invitation.status).toBe("INVITED");
    expect(invitation.requiresPassword).toBe(true);
    expect(invitation.email).toContain("***@");
    expect(invitation.email).not.toBe(inviteeEmail);
    expect(JSON.stringify(invitation)).not.toContain(token);
    expect(invitation.roles.length).toBe(1);
    expect(invitation.branches[0]?.name).toBe("Main Branch");

    const accepted = await api.post(`${API}/auth/invitations/accept`, {
      body: { token, fullName: "New Doctor", password: PASSWORD },
    });
    expect(accepted.status).toBe(200);
    expect(dataOf<{ accountCreated: boolean }>(accepted).accountCreated).toBe(true);

    const linked = await getTestAdminPool().query<{ membership_id: string | null }>(
      "select membership_id from auth_email_tokens where id = $1",
      [invitationId],
    );
    expect(linked.rows[0]?.membership_id).toBeTruthy();

    await login(await newClient(), inviteeEmail);
  });

  it("revokes and resends invitations with single-use tokens", async () => {
    const setup = await setupTenant();
    const inviteeEmail = uniqueEmail("resend");
    await register(await newClient(), inviteeEmail);
    clearMockAuthMailOutbox();

    const first = await invite(setup.admin, {
      email: inviteeEmail,
      roleIds: [setup.doctorRoleId],
    });
    const firstInvitation = dataOf<{ invitation: { invitationId: string; membershipId: string } }>(
      first,
    ).invitation;
    const firstToken = latestToken();

    const resent = await setup.admin.post(
      `${API}/tenant/staff/invitations/${firstInvitation.invitationId}/resend`,
    );
    expect(resent.status).toBe(202);
    const replacement = dataOf<{ invitation: { invitationId: string } }>(resent).invitation;
    expect(replacement.invitationId).not.toBe(firstInvitation.invitationId);

    const oldDetails = await api.post(`${API}/auth/invitations/details`, {
      body: { token: firstToken },
    });
    expect(dataOf<{ invitation: { status: string } }>(oldDetails).invitation.status).toBe(
      "REVOKED",
    );

    const oldAccept = await api.post(`${API}/auth/invitations/accept`, {
      body: { token: firstToken },
    });
    expect(oldAccept.status).toBe(400);

    const revoked = await setup.admin.post(
      `${API}/tenant/staff/invitations/${replacement.invitationId}/revoke`,
    );
    expect(revoked.status).toBe(204);

    const revokedDetails = await api.post(`${API}/auth/invitations/details`, {
      body: { token: latestToken() },
    });
    expect(dataOf<{ invitation: { status: string } }>(revokedDetails).invitation.status).toBe(
      "REVOKED",
    );

    const membership = await getTestAdminPool().query<{ status: string }>(
      "select status from tenant_memberships where id = $1",
      [firstInvitation.membershipId],
    );
    expect(membership.rows[0]?.status).toBe("REMOVED");

    const resendRevoked = await setup.admin.post(
      `${API}/tenant/staff/invitations/${replacement.invitationId}/resend`,
    );
    expect(resendRevoked.status).toBe(409);

    const reinvited = await invite(setup.admin, {
      email: inviteeEmail,
      roleIds: [setup.doctorRoleId],
    });
    expect(reinvited.status).toBe(202);
    expect(
      dataOf<{ invitation: { membershipId: string } }>(reinvited).invitation.membershipId,
    ).toBe(firstInvitation.membershipId);

    const reopened = await getTestAdminPool().query<{ status: string }>(
      "select status from tenant_memberships where id = $1",
      [firstInvitation.membershipId],
    );
    expect(reopened.rows[0]?.status).toBe("INVITED");
  });

  it("rejects expired invitations and cross-tenant management", async () => {
    const first = await setupTenant();
    const second = await setupTenant();
    const inviteeEmail = uniqueEmail("expired");
    clearMockAuthMailOutbox();

    const created = await invite(first.admin, { email: inviteeEmail });
    const invitation = dataOf<{ invitation: { invitationId: string } }>(created).invitation;
    const token = latestToken();

    const crossTenantResend = await second.admin.post(
      `${API}/tenant/staff/invitations/${invitation.invitationId}/resend`,
    );
    expect(crossTenantResend.status).toBe(404);

    const crossTenantRevoke = await second.admin.post(
      `${API}/tenant/staff/invitations/${invitation.invitationId}/revoke`,
    );
    expect(crossTenantRevoke.status).toBe(404);

    await getTestAdminPool().query(
      "update auth_email_tokens set expires_at = now() - interval '1 minute' where id = $1",
      [invitation.invitationId],
    );

    const details = await api.post(`${API}/auth/invitations/details`, {
      body: { token },
    });
    expect(dataOf<{ invitation: { valid: boolean; status: string } }>(details).invitation).toMatchObject({
      valid: false,
      status: "EXPIRED",
    });

    const accepted = await api.post(`${API}/auth/invitations/accept`, {
      body: { token, fullName: "Expired User", password: PASSWORD },
    });
    expect(accepted.status).toBe(400);
  });

  it("separates staff:create from staff:assign_role and rejects foreign assignments", async () => {
    const setup = await setupTenant();
    const staffEmail = uniqueEmail("staff-create");
    const staff = await newClient();
    await register(staff, staffEmail);

    const role = await setup.admin.post(`${API}/tenant/roles`, {
      body: {
        name: "Staff Creator",
        permissions: ["staff:create", "staff:read"],
      },
    });
    expect(role.status).toBe(201);
    const roleId = dataOf<{ role: { id: string } }>(role).role.id;

    const pool = getTestAdminPool();
    const otherBranch = await pool.query<{ id: string }>(
      `insert into branches (tenant_id, name, branch_code)
       values ($1, 'Other Branch', $2) returning id`,
      [setup.tenantId, `OTHER-${randomUUID().slice(0, 8)}`],
    );
    const membership = await pool.query<{ id: string }>(
      `insert into tenant_memberships (tenant_id, user_id, status, joined_at, branch_ids)
       values ($1, (select id from users where lower(email)=lower($2)), 'ACTIVE', now(), $3::jsonb)
       returning id`,
      [setup.tenantId, staffEmail, JSON.stringify([setup.branchId])],
    );
    await pool.query(
      "insert into membership_roles (tenant_id, tenant_membership_id, role_id) values ($1,$2,$3)",
      [setup.tenantId, membership.rows[0]!.id, roleId],
    );
    await login(staff, staffEmail);
    const selected = await staff.post(`${API}/tenants/select`, {
      body: { slug: setup.tenantSlug },
    });
    expect(selected.status).toBe(200);

    const withRole = await invite(staff, {
      email: uniqueEmail("no-role-permission"),
      roleIds: [setup.doctorRoleId],
    });
    expect(withRole.status).toBe(403);

    const hospitalWide = await invite(staff, {
      email: uniqueEmail("hospital-wide"),
    });
    expect(hospitalWide.status).toBe(403);

    const outOfScope = await invite(staff, {
      email: uniqueEmail("other-branch"),
      branchIds: [otherBranch.rows[0]!.id],
    });
    expect(outOfScope.status).toBe(403);

    const inScope = await invite(staff, {
      email: uniqueEmail("own-branch"),
      branchIds: [setup.branchId],
    });
    expect(inScope.status).toBe(202);
    const ownInvitation = dataOf<{ invitation: { invitationId: string } }>(inScope).invitation;

    const blockedResend = await staff.post(
      `${API}/tenant/staff/invitations/${ownInvitation.invitationId}/resend`,
    );
    expect(blockedResend.status).toBe(202);

    const adminOtherBranch = await invite(setup.admin, {
      email: uniqueEmail("admin-other-branch"),
      branchIds: [otherBranch.rows[0]!.id],
    });
    expect(adminOtherBranch.status).toBe(202);
    const adminInvitation = dataOf<{ invitation: { invitationId: string } }>(adminOtherBranch)
      .invitation;

    const hiddenResend = await staff.post(
      `${API}/tenant/staff/invitations/${adminInvitation.invitationId}/resend`,
    );
    expect(hiddenResend.status).toBe(404);

    const hiddenRevoke = await staff.post(
      `${API}/tenant/staff/invitations/${adminInvitation.invitationId}/revoke`,
    );
    expect(hiddenRevoke.status).toBe(404);

    const visible = await staff.get(`${API}/tenant/staff/invitations`);
    const visibleIds = dataOf<{ invitations: Array<{ id: string }> }>(visible).invitations.map(
      (entry) => entry.id,
    );
    expect(visibleIds).not.toContain(adminInvitation.invitationId);

    const foreignBranch = await invite(setup.admin, {
      email: uniqueEmail("foreign-branch"),
      branchIds: [randomUUID()],
    });
    expect(foreignBranch.status).toBe(422);
  });
});
