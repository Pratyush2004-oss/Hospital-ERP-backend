import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { getDb } from "../../database/client.js";
import { closePool } from "../../database/index.js";
import { users } from "../../database/schema/index.js";
import {
  clearMockAuthMailOutbox,
  createMockAuthMailProvider,
  mockAuthMailOutbox,
} from "../auth-mail/auth-mail.providers.js";
import type { AuthMailKind } from "../auth-mail/auth-mail.types.js";
import {
  deliverPasswordResetEmail,
  issueEmailVerification,
} from "./auth.email.service.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";
const NEW_PASSWORD = "Battery-Staple-Anchor-7";

let api: TestApi;
const clients: TestApi[] = [];

function dataOf<T>(response: TestResponse): T {
  return (response.body as { data: T }).data;
}

function uniqueEmail(prefix = "mail"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

async function newClient(): Promise<TestApi> {
  const client = await createTestApi(createApp());
  clients.push(client);
  return client;
}

async function register(client: TestApi, email: string): Promise<TestResponse> {
  return client.post(`${API}/auth/register`, {
    body: { fullName: "Mail Test User", email, password: PASSWORD },
  });
}

async function login(client: TestApi, email: string, password = PASSWORD): Promise<TestResponse> {
  return client.post(`${API}/auth/login`, { body: { identifier: email, password } });
}

/** Extracts the raw single-use token from the most recent mock email. */
function latestToken(kind: AuthMailKind): string {
  const message = [...mockAuthMailOutbox].reverse().find((entry) => entry.kind === kind);

  if (!message) throw new Error(`No ${kind} email was recorded`);

  const match = message.text.match(/\?token=([^\s]+)/);
  if (!match?.[1]) throw new Error(`No token found in ${kind} email`);

  return decodeURIComponent(match[1]);
}

beforeAll(async () => {
  api = await createTestApi(createApp());
});

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await api.close();
  await closePool();
  await closeTestAdminPool();
});

describe("email verification workflow", () => {
  it("sends a branded verification email and consumes the token once", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail();
    const response = await register(api, email);

    expect(response.status).toBe(201);
    expect(dataOf<{ user: { emailVerifiedAt: string | null } }>(response).user.emailVerifiedAt).toBeNull();

    const verificationEmail = mockAuthMailOutbox.at(-1);
    expect(verificationEmail?.kind).toBe("EMAIL_VERIFICATION");
    expect(verificationEmail?.html).toContain("HospitalOS");
    expect(verificationEmail?.html).toContain("Verify email address");

    const token = latestToken("EMAIL_VERIFICATION");
    const verify = await api.post(`${API}/auth/email/verify`, { body: { token } });

    expect(verify.status).toBe(200);
    const verified = dataOf<{
      user: { emailVerifiedAt: string | null };
      alreadyVerified: boolean;
    }>(verify);
    expect(verified.alreadyVerified).toBe(false);
    expect(verified.user.emailVerifiedAt).toBeTruthy();

    const reuse = await api.post(`${API}/auth/email/verify`, { body: { token } });
    expect(reuse.status).toBe(400);

    await login(api, email);
    const me = await api.get(`${API}/auth/me`);
    expect(
      dataOf<{ user: { emailVerifiedAt: string | null } }>(me).user.emailVerifiedAt,
    ).toBeTruthy();
  });

  it("rejects an expired verification token", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail();
    await register(api, email);
    const token = latestToken("EMAIL_VERIFICATION");

    await getTestAdminPool().query(
      `update auth_email_tokens
       set expires_at = now() - interval '1 minute'
       where purpose = 'EMAIL_VERIFICATION'
         and user_id = (select id from users where lower(email) = lower($1))`,
      [email],
    );

    const response = await api.post(`${API}/auth/email/verify`, { body: { token } });
    expect(response.status).toBe(400);
  });

  it("resends verification, revoking the previous link, and reports already verified", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail();
    await register(api, email);
    await login(api, email);

    const firstToken = latestToken("EMAIL_VERIFICATION");
    const resend = await api.post(`${API}/auth/email/resend`);
    expect(resend.status).toBe(202);
    expect(dataOf<{ status: string }>(resend).status).toBe("SENT");

    const secondToken = latestToken("EMAIL_VERIFICATION");
    expect(secondToken).not.toBe(firstToken);

    const oldLink = await api.post(`${API}/auth/email/verify`, {
      body: { token: firstToken },
    });
    expect(oldLink.status).toBe(400);

    const verify = await api.post(`${API}/auth/email/verify`, {
      body: { token: secondToken },
    });
    expect(verify.status).toBe(200);

    const again = await api.post(`${API}/auth/email/resend`);
    expect(again.status).toBe(202);
    expect(dataOf<{ status: string }>(again).status).toBe("ALREADY_VERIFIED");
  });

  it("reports delivery failure without exposing the token", async () => {
    const email = uniqueEmail("delivery");
    await register(api, email);

    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    expect(user).toBeDefined();

    const result = await issueEmailVerification(user!, {
      provider: createMockAuthMailProvider({ fail: "permanent" }),
    });

    expect(result.status).toBe("DELIVERY_FAILED");
    expect(JSON.stringify(result)).not.toContain("token=");
  });
});

describe("password reset delivery workflow", () => {
  it("emails a reset link, changes the password once, and rejects reuse", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail("reset");
    await register(api, email);
    await login(api, email);

    const oldAccess = api.jar.get("hos_access");
    expect(oldAccess).toBeTruthy();

    const forgot = await api.post(`${API}/auth/forgot-password`, {
      body: { identifier: email },
    });

    expect(forgot.status).toBe(202);
    // Production-identical response: no delivery status or account hint.
    expect(dataOf<{ deliveryStatus?: string }>(forgot).deliveryStatus).toBeUndefined();
    expect(dataOf<{ resetUrl?: string }>(forgot).resetUrl).toContain(
      "/reset-password?token=",
    );

    const delivered = mockAuthMailOutbox.findLast((entry) => entry.kind === "PASSWORD_RESET");
    expect(delivered?.html).toContain("Reset your password");
    expect(delivered?.text).toContain("single-use link");

    // The development/test response also carries the token so this suite can
    // exercise the flow; production responses never do.
    const resetToken = dataOf<{ resetToken?: string }>(forgot).resetToken;
    expect(resetToken).toBeTruthy();
    expect(resetToken).toBe(latestToken("PASSWORD_RESET"));

    const reset = await api.post(`${API}/auth/reset-password`, {
      body: { token: resetToken, password: NEW_PASSWORD },
    });
    expect(reset.status).toBe(200);

    const oldSession = await api.get(`${API}/auth/me`, {
      cookie: `hos_access=${oldAccess}`,
    });
    expect(oldSession.status).toBe(401);

    const reused = await api.post(`${API}/auth/reset-password`, {
      body: { token: resetToken, password: "Another-Valid-Password-4" },
    });
    expect(reused.status).toBe(400);

    const oldPassword = await login(api, email, PASSWORD);
    expect(oldPassword.status).toBe(401);

    const newPassword = await login(api, email, NEW_PASSWORD);
    expect(newPassword.status).toBe(200);

    const used = await api.post(`${API}/auth/reset-password/validate`, {
      body: { token: resetToken },
    });
    expect(used.status).toBe(200);
    expect(dataOf<{ valid: boolean; status: string }>(used)).toMatchObject({
      valid: false,
      status: "USED",
    });
  });

  it("revokes an earlier reset link when a newer one is requested", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail("resend");
    await register(api, email);

    const first = await api.post(`${API}/auth/forgot-password`, {
      body: { identifier: email },
    });
    const firstToken = dataOf<{ resetToken?: string }>(first).resetToken;
    expect(firstToken).toBeTruthy();

    const second = await api.post(`${API}/auth/forgot-password`, {
      body: { identifier: email },
    });
    const secondToken = dataOf<{ resetToken?: string }>(second).resetToken;
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    const oldInspection = await api.post(`${API}/auth/reset-password/validate`, {
      body: { token: firstToken },
    });
    expect(dataOf<{ status: string }>(oldInspection).status).toBe("REVOKED");

    const oldReset = await api.post(`${API}/auth/reset-password`, {
      body: { token: firstToken, password: NEW_PASSWORD },
    });
    expect(oldReset.status).toBe(400);

    const validInspection = await api.post(`${API}/auth/reset-password/validate`, {
      body: { token: secondToken },
    });
    expect(dataOf<{ valid: boolean; status: string }>(validInspection)).toMatchObject({
      valid: true,
      status: "VALID",
    });
  });

  it("reports an expired reset token without a reset", async () => {
    clearMockAuthMailOutbox();
    const email = uniqueEmail("expired");
    await register(api, email);

    const forgot = await api.post(`${API}/auth/forgot-password`, {
      body: { identifier: email },
    });
    const token = dataOf<{ resetToken?: string }>(forgot).resetToken;
    expect(token).toBeTruthy();

    await getTestAdminPool().query(
      `update password_reset_tokens
       set expires_at = now() - interval '1 minute'
       where user_id = (select id from users where lower(email) = lower($1))`,
      [email],
    );

    const inspection = await api.post(`${API}/auth/reset-password/validate`, {
      body: { token },
    });
    expect(dataOf<{ valid: boolean; status: string }>(inspection)).toMatchObject({
      valid: false,
      status: "EXPIRED",
    });

    const reset = await api.post(`${API}/auth/reset-password`, {
      body: { token, password: NEW_PASSWORD },
    });
    expect(reset.status).toBe(400);
  });

  it("returns the same generic response for unknown accounts", async () => {
    const response = await api.post(`${API}/auth/forgot-password`, {
      body: { identifier: uniqueEmail("missing") },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      data: {
        message: "If an account matches that email or phone number, a reset link has been sent.",
      },
    });
    expect(dataOf<{ resetToken?: string }>(response).resetToken).toBeUndefined();
  });

  it("rate limits repeated forgot-password requests", async () => {
    // The limiter is process-wide, so use a dedicated client IP for this test.
    const limited = await newClient();
    const clientIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await limited.post(`${API}/auth/forgot-password`, {
        body: { identifier: uniqueEmail("rate") },
        headers: { "x-forwarded-for": clientIp },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
  });

  it("reports reset delivery failure without leaking the token", async () => {
    const email = uniqueEmail("reset-delivery");
    await register(api, email);

    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    expect(user).toBeDefined();

    const rawToken = "reset-token-for-delivery-failure-test";
    const result = await deliverPasswordResetEmail(
      user!,
      rawToken,
      new Date(Date.now() + 30 * 60_000),
      { provider: createMockAuthMailProvider({ fail: "permanent" }) },
    );

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("mock_permanent_failure");
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });

  it("reports invalid tokens without account information", async () => {
    const response = await api.post(`${API}/auth/reset-password/validate`, {
      body: { token: "x".repeat(43) },
    });

    expect(response.status).toBe(200);
    expect(dataOf<{ valid: boolean; status: string }>(response)).toMatchObject({
      valid: false,
      status: "INVALID",
    });
  });
});

describe("staff invitation workflow", () => {
  it("invites by email, then accepts into an active membership with the role", async () => {
    clearMockAuthMailOutbox();

    const adminClient = await newClient();
    const adminEmail = uniqueEmail("inviter");
    await register(adminClient, adminEmail);
    await login(adminClient, adminEmail);

    const tenantResponse = await adminClient.post(`${API}/tenants/register`, {
      body: { name: `Invite Hospital ${randomUUID().slice(0, 8)}` },
    });
    expect(tenantResponse.status).toBe(201);
    const tenant = dataOf<{ tenant: { id: string; slug: string } }>(tenantResponse).tenant;

    const platformClient = await newClient();
    const platformEmail = uniqueEmail("platform");
    await register(platformClient, platformEmail);
    const pool = getTestAdminPool();
    const platformRole = await pool.query<{ id: string }>(
      "select id from roles where slug = 'platform_super_admin' and tenant_id is null limit 1",
    );
    await pool.query(
      "insert into platform_user_roles (user_id, role_id) select id, $1 from users where lower(email) = lower($2)",
      [platformRole.rows[0]!.id, platformEmail],
    );
    await login(platformClient, platformEmail);

    const activate = await platformClient.post(
      `${API}/platform/tenants/${tenant.id}/activate`,
    );
    expect(activate.status).toBe(200);

    const select = await adminClient.post(`${API}/tenants/select`, {
      body: { slug: tenant.slug },
    });
    expect(select.status).toBe(200);

    const doctorRole = await pool.query<{ id: string }>(
      "select id from roles where tenant_id = $1 and slug = 'doctor' limit 1",
      [tenant.id],
    );
    const roleId = doctorRole.rows[0]!.id;

    const inviteeEmail = uniqueEmail("invitee");
    const invite = await adminClient.post(`${API}/tenant/staff/invitations`, {
      body: {
        email: inviteeEmail,
        fullName: "Invited Doctor",
        roleIds: [roleId],
      },
    });

    expect(invite.status).toBe(202);
    const invitation = dataOf<{
      invitation: { invitationId: string; status: string; expiresAt: string };
    }>(invite).invitation;
    expect(invitation.status).toBe("SENT");
    expect(invitation.invitationId).toBeTruthy();

    const email = mockAuthMailOutbox.findLast((entry) => entry.kind === "STAFF_INVITATION");
    expect(email?.to).toBe(inviteeEmail);
    expect(email?.html).toContain("You have been invited");
    expect(email?.text).toContain("Accept invitation");

    const acceptClient = await newClient();
    const accept = await acceptClient.post(`${API}/auth/invitations/accept`, {
      body: {
        token: latestToken("STAFF_INVITATION"),
        fullName: "Invited Doctor",
        password: PASSWORD,
      },
    });

    expect(accept.status).toBe(200);
    const accepted = dataOf<{
      accountCreated: boolean;
      tenantId: string;
      membershipId: string;
      user: { id: string; email: string; emailVerifiedAt: string | null };
    }>(accept);
    expect(accepted.accountCreated).toBe(true);
    expect(accepted.tenantId).toBe(tenant.id);
    expect(accepted.user.emailVerifiedAt).toBeTruthy();

    const membership = await pool.query<{ status: string; user_id: string }>(
      "select status, user_id from tenant_memberships where id = $1",
      [accepted.membershipId],
    );
    expect(membership.rows[0]?.status).toBe("ACTIVE");
    expect(membership.rows[0]?.user_id).toBe(accepted.user.id);

    const granted = await pool.query<{ slug: string }>(
      `select r.slug from membership_roles mr
       join roles r on r.id = mr.role_id
       where mr.tenant_membership_id = $1`,
      [accepted.membershipId],
    );
    expect(granted.rows.map((row) => row.slug)).toContain("doctor");

    const replay = await acceptClient.post(`${API}/auth/invitations/accept`, {
      body: { token: latestToken("STAFF_INVITATION"), password: PASSWORD },
    });
    expect(replay.status).toBe(400);

    const duplicateInvite = await adminClient.post(`${API}/tenant/staff/invitations`, {
      body: { email: inviteeEmail, roleIds: [roleId] },
    });
    expect(duplicateInvite.status).toBe(409);
  });

  it("allows an existing account to accept without a new password", async () => {
    clearMockAuthMailOutbox();

    const adminClient = await newClient();
    const adminEmail = uniqueEmail("inviter2");
    await register(adminClient, adminEmail);
    await login(adminClient, adminEmail);

    const tenantResponse = await adminClient.post(`${API}/tenants/register`, {
      body: { name: `Invite Hospital ${randomUUID().slice(0, 8)}` },
    });
    const tenant = dataOf<{ tenant: { id: string; slug: string } }>(tenantResponse).tenant;

    const platformClient = await newClient();
    const platformEmail = uniqueEmail("platform2");
    await register(platformClient, platformEmail);
    const pool = getTestAdminPool();
    const platformRole = await pool.query<{ id: string }>(
      "select id from roles where slug = 'platform_super_admin' and tenant_id is null limit 1",
    );
    await pool.query(
      "insert into platform_user_roles (user_id, role_id) select id, $1 from users where lower(email) = lower($2)",
      [platformRole.rows[0]!.id, platformEmail],
    );
    await login(platformClient, platformEmail);
    await platformClient.post(`${API}/platform/tenants/${tenant.id}/activate`);
    await adminClient.post(`${API}/tenants/select`, { body: { slug: tenant.slug } });

    const inviteeClient = await newClient();
    const inviteeEmail = uniqueEmail("existing");
    await register(inviteeClient, inviteeEmail);

    const invite = await adminClient.post(`${API}/tenant/staff/invitations`, {
      body: { email: inviteeEmail },
    });
    expect(invite.status).toBe(202);

    const accept = await inviteeClient.post(`${API}/auth/invitations/accept`, {
      body: { token: latestToken("STAFF_INVITATION") },
    });

    expect(accept.status).toBe(200);
    expect(dataOf<{ accountCreated: boolean }>(accept).accountCreated).toBe(false);
  });
});
