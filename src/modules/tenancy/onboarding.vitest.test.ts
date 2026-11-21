import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/index.js";
import {
  clearMockAuthMailOutbox,
  createMockAuthMailProvider,
  mockAuthMailOutbox,
} from "../auth-mail/auth-mail.providers.js";
import { deliverHospitalActivationEmail } from "../auth/auth.email.service.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

let api: TestApi;
const clients: TestApi[] = [];

function dataOf<T>(response: TestResponse): T {
  return (response.body as { data: T }).data;
}

function uniqueEmail(prefix = "onboarding"): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

async function newClient(): Promise<TestApi> {
  const client = await createTestApi(createApp());
  clients.push(client);
  return client;
}

async function register(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/register`, {
    body: { fullName: "Onboarding User", email, password: PASSWORD },
  });
  expect(response.status).toBe(201);
}

async function login(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function hospitalClient(): Promise<{ client: TestApi; email: string }> {
  const client = await newClient();
  const email = uniqueEmail();
  await register(client, email);
  await login(client, email);
  return { client, email };
}

async function platformClient(): Promise<TestApi> {
  const client = await newClient();
  const email = uniqueEmail("platform");
  await register(client, email);

  const pool = getTestAdminPool();
  await pool.query(
    `insert into platform_user_roles (user_id, role_id)
     select id, (select id from roles where slug = 'platform_super_admin' and tenant_id is null)
     from users where lower(email) = lower($1)`,
    [email],
  );

  await login(client, email);
  return client;
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
}

interface OnboardingRegistration {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  registrationReference: string;
  status: string;
  submittedAt: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  timezone: string;
  membershipId: string;
  membershipStatus: string;
  joinedAt: string | null;
  selectable: boolean;
}

async function registerTenant(
  client: TestApi,
  name: string,
): Promise<ProvisionResult> {
  const response = await client.post(`${API}/tenants/register`, {
    body: { name, legalName: `${name} LLC`, timezone: "America/New_York" },
  });
  expect(response.status).toBe(201);
  return dataOf<ProvisionResult>(response);
}

async function activate(platform: TestApi, tenantId: string): Promise<void> {
  const response = await platform.post(`${API}/platform/tenants/${tenantId}/activate`);
  expect(response.status).toBe(200);
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

describe("pending hospital onboarding status", () => {
  it("shows the founder their pending registration without operational access", async () => {
    const admin = await hospitalClient();
    const tenant = await registerTenant(admin.client, `Pending Hospital ${randomUUID()}`);

    const status = await admin.client.get(`${API}/tenants/onboarding`);
    expect(status.status).toBe(200);

    const onboarding = dataOf<{
      registrations: OnboardingRegistration[];
      supportEmail: string | null;
    }>(status);

    const registration = onboarding.registrations.find(
      (entry) => entry.tenantId === tenant.tenant.id,
    );
    expect(registration).toMatchObject({
      tenantId: tenant.tenant.id,
      tenantName: tenant.tenant.name,
      tenantSlug: tenant.tenant.slug,
      registrationReference: tenant.tenant.id,
      status: "PENDING",
      legalName: `${tenant.tenant.name} LLC`,
      timezone: "America/New_York",
      membershipId: tenant.membershipId,
      membershipStatus: "ACTIVE",
      selectable: false,
    });
    expect(registration?.submittedAt).toBeTruthy();
    expect(registration).not.toHaveProperty("approvalNotes");

    const memberships = await admin.client.get(`${API}/tenants/memberships`);
    const pendingMembership = dataOf<{
      memberships: Array<{ tenantId: string; selectable: boolean }>;
    }>(memberships).memberships.find((entry) => entry.tenantId === tenant.tenant.id);
    expect(pendingMembership?.selectable).toBe(false);

    const selection = await admin.client.post(`${API}/tenants/select`, {
      body: { slug: tenant.tenant.slug },
    });
    expect(selection.status).toBe(403);

    // No tenant scope exists while PENDING, so hospital APIs stay closed even
    // when the client ignores the UI restriction.
    const operational = await admin.client.get(`${API}/tenant/memberships`);
    expect(operational.status).toBe(403);
  });

  it("only returns registrations belonging to the caller", async () => {
    const first = await hospitalClient();
    const second = await hospitalClient();
    const firstTenant = await registerTenant(first.client, `First Hospital ${randomUUID()}`);
    const secondTenant = await registerTenant(second.client, `Second Hospital ${randomUUID()}`);

    const firstStatus = await first.client.get(`${API}/tenants/onboarding`);
    const secondStatus = await second.client.get(`${API}/tenants/onboarding`);

    const firstIds = dataOf<{ registrations: OnboardingRegistration[] }>(
      firstStatus,
    ).registrations.map((entry) => entry.tenantId);
    const secondIds = dataOf<{ registrations: OnboardingRegistration[] }>(
      secondStatus,
    ).registrations.map((entry) => entry.tenantId);

    expect(firstIds).toContain(firstTenant.tenant.id);
    expect(firstIds).not.toContain(secondTenant.tenant.id);
    expect(secondIds).toContain(secondTenant.tenant.id);
    expect(secondIds).not.toContain(firstTenant.tenant.id);
  });

  it("sends the activation email once and makes the hospital selectable", async () => {
    const admin = await hospitalClient();
    const platform = await platformClient();
    const tenant = await registerTenant(admin.client, `Activation Hospital ${randomUUID()}`);

    clearMockAuthMailOutbox();
    await activate(platform, tenant.tenant.id);

    const activationEmail = mockAuthMailOutbox.find(
      (entry) => entry.kind === "HOSPITAL_ACTIVATED",
    );
    expect(activationEmail?.to).toBe(admin.email);
    expect(activationEmail?.html).toContain(tenant.tenant.name);
    expect(activationEmail?.text).toContain(tenant.tenant.name);
    expect(activationEmail?.text).toContain("/onboarding/status");
    expect(activationEmail?.text).toContain(`tenant=${tenant.tenant.slug}`);
    expect(activationEmail?.text).not.toContain("token=");

    const status = await admin.client.get(`${API}/tenants/onboarding`);
    const registration = dataOf<{ registrations: OnboardingRegistration[] }>(
      status,
    ).registrations.find((entry) => entry.tenantId === tenant.tenant.id);
    expect(registration?.status).toBe("ACTIVE");
    expect(registration?.selectable).toBe(true);

    const selected = await admin.client.post(`${API}/tenants/select`, {
      body: { slug: tenant.tenant.slug },
    });
    expect(selected.status).toBe(200);

    const audit = await getTestAdminPool().query<{ count: number }>(
      `select count(*)::int as count from audit_logs
       where tenant_id = $1 and action = 'hospital.activation_email_sent'`,
      [tenant.tenant.id],
    );
    expect(audit.rows[0]?.count).toBe(1);

    // Activating an already active hospital does not resend the welcome email.
    await activate(platform, tenant.tenant.id);
    expect(
      mockAuthMailOutbox.filter((entry) => entry.kind === "HOSPITAL_ACTIVATED"),
    ).toHaveLength(1);
  });

  it("audits activation email failure without failing activation", async () => {
    const admin = await hospitalClient();
    const tenant = await registerTenant(admin.client, `Mail Failure Hospital ${randomUUID()}`);

    const result = await deliverHospitalActivationEmail(tenant.tenant, {
      provider: createMockAuthMailProvider({ fail: "permanent" }),
    });

    expect(result).toMatchObject({
      recipients: 1,
      sent: 0,
      failed: 1,
      suppressed: 0,
    });

    const audit = await getTestAdminPool().query<{ metadata: { kind?: string } }>(
      `select metadata from audit_logs
       where tenant_id = $1 and action = 'auth.email.delivery_failed'
       order by created_at desc limit 1`,
      [tenant.tenant.id],
    );
    expect(audit.rows[0]?.metadata.kind).toBe("HOSPITAL_ACTIVATED");
  });
});
