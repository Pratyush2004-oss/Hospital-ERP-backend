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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@doctor-onboarding.test`;
}

async function newClient(): Promise<TestApi> {
  const client = await createTestApi(createApp());
  clients.push(client);
  return client;
}

async function register(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/register`, {
    body: { fullName: "Onboarding Test User", email, password: PASSWORD },
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

async function setupTenant() {
  const admin = await newClient();
  const email = uniqueEmail("admin");
  await register(admin, email);
  await login(admin, email);

  const created = await admin.post(`${API}/tenants/register`, {
    body: { name: `Doctor Onboarding ${randomUUID()}` },
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
    [tenant.id, `DOC-ONB-${randomUUID().slice(0, 8)}`],
  );
  const department = await pool.query<{ id: string }>(
    `insert into departments (tenant_id, branch_id, name, slug)
     values ($1, $2, 'Cardiology', $3) returning id`,
    [tenant.id, branch.rows[0]!.id, `cardiology-${randomUUID().slice(0, 8)}`],
  );
  await pool.query(
    `insert into department_branches (tenant_id, department_id, branch_id)
     values ($1, $2, $3)`,
    [tenant.id, department.rows[0]!.id, branch.rows[0]!.id],
  );

  const doctorRole = await pool.query<{ id: string }>(
    "select id from roles where tenant_id = $1 and slug = 'doctor' limit 1",
    [tenant.id],
  );

  return {
    admin,
    tenantId: tenant.id,
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

beforeAll(async () => {
  api = await createTestApi(createApp());
});

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close();
  await api.close();
  await closePool();
  await closeTestAdminPool();
});

describe("doctor onboarding from a staff invitation", () => {
  it("invites, accepts, discovers and creates the doctor profile once", async () => {
    const setup = await setupTenant();
    const email = uniqueEmail("invited-doctor");
    clearMockAuthMailOutbox();

    const invited = await setup.admin.post(`${API}/tenant/staff/invitations`, {
      body: {
        email,
        fullName: "Dr. Invited",
        roleIds: [setup.doctorRoleId],
        branchIds: [setup.branchId],
        departmentIds: [setup.departmentId],
      },
    });
    expect(invited.status).toBe(202);

    const before = await setup.admin.get(
      `${API}/doctors/eligible-members?search=${encodeURIComponent(email)}`,
    );
    expect(before.status).toBe(200);
    expect(dataOf<{ members: unknown[] }>(before).members).toHaveLength(0);

    const accepted = await api.post(`${API}/auth/invitations/accept`, {
      body: { token: latestToken(), fullName: "Dr. Invited", password: PASSWORD },
    });
    expect(accepted.status).toBe(200);
    const account = dataOf<{
      user: { id: string };
      membershipId: string;
      accountCreated: boolean;
    }>(accepted);

    const afterAccept = await setup.admin.get(
      `${API}/doctors/eligible-members?search=${encodeURIComponent(email)}`,
    );
    expect(afterAccept.status).toBe(200);
    const members = dataOf<{
      members: Array<{
        userId: string;
        membershipId: string;
        branchIds: string[];
        departmentIds: string[];
        roles: Array<{ slug: string }>;
      }>;
    }>(afterAccept).members;

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      userId: account.user.id,
      membershipId: account.membershipId,
      branchIds: [setup.branchId],
      departmentIds: [setup.departmentId],
    });
    expect(members[0]?.roles.some((role) => role.slug === "doctor")).toBe(true);

    const created = await setup.admin.post(`${API}/doctors`, {
      body: {
        userId: account.user.id,
        doctorCode: "ONB-DOC-1",
        registrationNumber: "ONB-REG-1",
        departmentIds: [setup.departmentId],
        branches: [{ branchId: setup.branchId, consultationFee: "100.00" }],
      },
    });
    expect(created.status).toBe(201);
    const doctor = dataOf<{
      doctor: { userId: string; departments: unknown[]; branches: unknown[] };
    }>(created).doctor;
    expect(doctor.userId).toBe(account.user.id);

    const afterProfile = await setup.admin.get(
      `${API}/doctors/eligible-members?search=${encodeURIComponent(email)}`,
    );
    expect(dataOf<{ members: unknown[] }>(afterProfile).members).toHaveLength(0);

    const duplicate = await setup.admin.post(`${API}/doctors`, {
      body: {
        userId: account.user.id,
        doctorCode: "ONB-DOC-2",
        registrationNumber: "ONB-REG-2",
      },
    });
    expect(duplicate.status).toBe(409);
  });
});
