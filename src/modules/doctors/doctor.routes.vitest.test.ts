import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { getPool } from "../../database/index.js";
import {
  doctorBranches,
  doctorDepartments,
  doctors,
} from "../../database/schema/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for Tasks 15.3 and 15.4. The service suite covers doctor
 * business rules; these tests prove routing, validation, RBAC enforcement,
 * self-access rules, tenant isolation and RLS around it.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface DoctorShape {
  id: string;
  doctorCode: string;
  registrationNumber: string;
  specialization: string | null;
  isActive: boolean;
  user: { id: string; fullName: string; email: string; phone: string | null };
  departments: Array<{ id: string; name: string }>;
  branches: Array<{ branchId: string; consultationFee: string; currency: string }>;
}

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

let api: TestApi;
let otherApi: TestApi;
let adminEmail: string;
let otherAdminEmail: string;
let tenantId: string;
let tenantSlug: string;
let branchA: string;
let branchB: string;
let cardiology: string;
let neurology: string;
let doctorUserA: string;
let doctorUserB: string;
let doctorUserC: string;
let receptionistEmail: string;
let otherTenantId: string;
let otherBranch: string;
let otherDepartment: string;
let otherDoctorId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];
let doctorId: string;

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@doctors-api.test`;

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'doctor-routes-test-hash')`,
    [id, `Dr. ${label}`, email],
  );

  createdUserIds.push(id);
  return { id, email };
}

async function createMemberUser(
  tenant: string,
  label: string,
  roleSlug?: string,
): Promise<{ id: string; email: string }> {
  const user = await createUser(label);

  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenant, user.id],
  );

  if (roleSlug !== undefined) {
    await getTestAdminPool().query(
      `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
       select m.tenant_id, m.id, r.id
       from tenant_memberships m
       join roles r on r.tenant_id = m.tenant_id and r.slug = $3
       where m.tenant_id = $1 and m.user_id = $2`,
      [tenant, user.id, roleSlug],
    );
  }

  return user;
}

async function registerMemberUser(
  client: TestApi,
  tenant: string,
  label: string,
  roleSlug?: string,
): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@doctors-api.test`;

  const registered = await client.post(`${API}/auth/register`, {
    body: { fullName: `Dr. ${label}`, email, password: PASSWORD },
  });
  expect(registered.status).toBe(201);

  const userId = dataOf<{ user: { id: string } }>(registered).user.id;
  createdUserIds.push(userId);

  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenant, userId],
  );

  if (roleSlug !== undefined) {
    await getTestAdminPool().query(
      `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
       select m.tenant_id, m.id, r.id
       from tenant_memberships m
       join roles r on r.tenant_id = m.tenant_id and r.slug = $3
       where m.tenant_id = $1 and m.user_id = $2`,
      [tenant, userId, roleSlug],
    );
  }

  return { id: userId, email };
}

async function loginAs(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function selectTenant(client: TestApi, slug: string): Promise<void> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  expect(response.status).toBe(200);
}

async function registerTenant(
  client: TestApi,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await client.post(`${API}/tenants/register`, { body: { name } });
  expect(response.status).toBe(201);

  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(response).tenant;
  createdTenantIds.push(tenant.id);
  await getTestAdminPool().query("update tenants set status = 'ACTIVE' where id = $1", [
    tenant.id,
  ]);

  return tenant;
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  adminEmail = `admin-${suffix}@doctors-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Hospital Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Doctors API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  branchA = randomUUID();
  branchB = randomUUID();
  cardiology = randomUUID();
  neurology = randomUUID();

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code)
     values ($1, $2, 'Central', $3), ($4, $2, 'Riverside', $5)`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug)
     values ($1, $2, $3, 'Cardiology', 'cardiology'), ($4, $2, $5, 'Neurology', 'neurology')`,
    [cardiology, tenantId, branchA, neurology, branchB],
  );

  await pool.query(
    `insert into department_branches (tenant_id, department_id, branch_id)
     values ($1, $2, $3), ($1, $4, $5)`,
    [tenantId, cardiology, branchA, neurology, branchB],
  );

  doctorUserA = (await registerMemberUser(api, tenantId, `doctor-a-${suffix}`, "doctor")).id;
  doctorUserB = (await createMemberUser(tenantId, `doctor-b-${suffix}`, "doctor")).id;
  doctorUserC = (await createMemberUser(tenantId, `doctor-c-${suffix}`, "doctor")).id;

  const receptionist = await registerMemberUser(
    api,
    tenantId,
    `reception-${suffix}`,
    "receptionist",
  );
  receptionistEmail = receptionist.email;

  // A second hospital, used for cross-tenant access checks.
  otherAdminEmail = `other-admin-${suffix}@doctors-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Hospital Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Doctors API ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  otherBranch = randomUUID();
  otherDepartment = randomUUID();

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code)
     values ($1, $2, 'Foreign Branch', $3)`,
    [otherBranch, otherTenantId, `FOR-${suffix}`],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug)
     values ($1, $2, $3, 'Foreign Department', 'foreign-department')`,
    [otherDepartment, otherTenantId, otherBranch],
  );

  await pool.query(
    `insert into department_branches (tenant_id, department_id, branch_id)
     values ($1, $2, $3)`,
    [otherTenantId, otherDepartment, otherBranch],
  );

  const otherDoctorUser = await createMemberUser(
    otherTenantId,
    `other-doctor-${suffix}`,
    "doctor",
  );

  const otherDoctor = await otherApi.post(`${API}/doctors`, {
    body: {
      userId: otherDoctorUser.id,
      doctorCode: "OTHER-DOC-1",
      registrationNumber: "OTHER-REG-1",
    },
  });
  expect(otherDoctor.status).toBe(201);
  otherDoctorId = dataOf<{ doctor: DoctorShape }>(otherDoctor).doctor.id;
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const id of createdTenantIds) {
    await pool.query("delete from tenants where id = $1", [id]);
  }

  for (const id of createdUserIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  await api.close();
  await otherApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("doctor routes", () => {
  it("creates, reads, lists and updates a doctor", async () => {
    const created = await api.post(`${API}/doctors`, {
      body: {
        userId: doctorUserA,
        doctorCode: " doc - api-1 ",
        registrationNumber: "REG-API-1",
        registrationCouncil: "State Medical Council",
        qualification: "MD, DM",
        specialization: "Cardiology",
        experienceYears: 12,
        consultationLanguage: ["EN", "hi"],
        departmentIds: [cardiology],
        branches: [{ branchId: branchA, consultationFee: "150", currency: "inr" }],
      },
    });

    expect(created.status).toBe(201);
    const doctor = dataOf<{ doctor: DoctorShape }>(created).doctor;

    expect(doctor.doctorCode).toBe("DOC-API-1");
    expect(doctor.user.id).toBe(doctorUserA);
    expect(doctor.departments.map((department) => department.id)).toEqual([cardiology]);
    expect(doctor.branches[0]).toMatchObject({
      branchId: branchA,
      consultationFee: "150.00",
      currency: "INR",
    });

    // No credential material or authentication tokens on any doctor response.
    const raw = JSON.stringify(created.body);
    expect(raw).not.toMatch(/passwordHash|password_hash|accessToken|refreshToken|tokenHash/i);
    expect(doctor.user).not.toHaveProperty("passwordHash");

    doctorId = doctor.id;

    const fetched = await api.get(`${API}/doctors/${doctor.id}`);
    expect(fetched.status).toBe(200);
    expect(dataOf<{ doctor: DoctorShape }>(fetched).doctor.id).toBe(doctor.id);

    const listed = await api.get(`${API}/doctors?departmentId=${cardiology}&limit=5`);
    expect(listed.status).toBe(200);
    const list = dataOf<{ doctors: DoctorShape[] }>(listed);
    expect(list.doctors.map((item) => item.id)).toEqual([doctor.id]);

    const listedBody = listed.body as Envelope<{ doctors: DoctorShape[] }>;
    expect(listedBody.meta?.pagination).toMatchObject({
      page: 1,
      pageSize: 5,
      total: 1,
      totalPages: 1,
    });

    const updated = await api.patch(`${API}/doctors/${doctor.id}`, {
      body: { specialization: "Interventional Cardiology", experienceYears: 13 },
    });
    expect(updated.status).toBe(200);
    expect(dataOf<{ doctor: DoctorShape }>(updated).doctor.specialization).toBe(
      "Interventional Cardiology",
    );

    const departments = await api.put(`${API}/doctors/${doctor.id}/departments`, {
      body: { departmentIds: [cardiology] },
    });
    expect(departments.status).toBe(200);

    const branches = await api.put(`${API}/doctors/${doctor.id}/branches`, {
      body: { branches: [{ branchId: branchA, consultationFee: "200.00" }] },
    });
    expect(branches.status).toBe(200);
    expect(dataOf<{ doctor: DoctorShape }>(branches).doctor.branches[0]?.consultationFee).toBe(
      "200.00",
    );

    const status = await api.patch(`${API}/doctors/${doctor.id}/status`, {
      body: { isActive: false },
    });
    expect(status.status).toBe(200);
    expect(dataOf<{ doctor: DoctorShape }>(status).doctor.isActive).toBe(false);
  });

  it("rejects invalid input, duplicate codes and unauthenticated access", async () => {
    const anonymous = await createTestApi(createApp());

    try {
      const unauthorized = await anonymous.get(`${API}/doctors`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await anonymous.close();
    }

    const invalid = await api.post(`${API}/doctors`, {
      body: { userId: "not-a-uuid", doctorCode: "", registrationNumber: "x" },
    });
    expect(invalid.status).toBe(422);

    const error = (invalid.body as { error: { code: string; details: unknown[] } }).error;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(
      error.details.some(
        (issue) => (issue as { path?: string }).path === "userId",
      ),
    ).toBe(true);

    const badId = await api.get(`${API}/doctors/not-a-uuid`);
    expect(badId.status).toBe(422);

    const duplicate = await api.post(`${API}/doctors`, {
      body: {
        userId: doctorUserB,
        doctorCode: "DOC-API-1",
        registrationNumber: "REG-API-2",
      },
    });
    expect(duplicate.status).toBe(409);

    const missing = await api.get(`${API}/doctors/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("allows receptionists to read doctors but not mutate them", async () => {
    const receptionist = await createTestApi(createApp());

    try {
      await loginAs(receptionist, receptionistEmail);
      await selectTenant(receptionist, tenantSlug);

      const read = await receptionist.get(`${API}/doctors/${doctorId}`);
      expect(read.status).toBe(200);

      const listed = await receptionist.get(`${API}/doctors`);
      expect(listed.status).toBe(200);

      const update = await receptionist.patch(`${API}/doctors/${doctorId}`, {
        body: { registrationNumber: "HACK-REG-1" },
      });
      expect(update.status).toBe(403);

      const branches = await receptionist.put(`${API}/doctors/${doctorId}/branches`, {
        body: { branches: [{ branchId: branchB }] },
      });
      expect(branches.status).toBe(403);

      const remove = await receptionist.delete(`${API}/doctors/${doctorId}`);
      expect(remove.status).toBe(403);
    } finally {
      await receptionist.close();
    }
  });

  it("keeps the doctor role read-only, including for its own profile", async () => {
    const otherDoctor = await api.post(`${API}/doctors`, {
      body: {
        userId: doctorUserB,
        doctorCode: "DOC-API-2",
        registrationNumber: "REG-API-3",
      },
    });
    expect(otherDoctor.status).toBe(201);
    const otherDoctorId = dataOf<{ doctor: DoctorShape }>(otherDoctor).doctor.id;

    const doctorClient = await createTestApi(createApp());

    try {
      // Sign in as the user behind doctorId, who holds the DOCTOR role.
      const email = (
        await getTestAdminPool().query<{ email: string }>(
          "select email from users where id = $1",
          [doctorUserA],
        )
      ).rows[0]?.email;
      expect(email).toBeTruthy();

      await loginAs(doctorClient, email!);
      await selectTenant(doctorClient, tenantSlug);

      const own = await doctorClient.get(`${API}/doctors/${doctorId}`);
      expect(own.status).toBe(200);
      expect(dataOf<{ doctor: DoctorShape }>(own).doctor.user.id).toBe(doctorUserA);

      // Directory reads are allowed for the doctor role.
      const directory = await doctorClient.get(`${API}/doctors/${otherDoctorId}`);
      expect(directory.status).toBe(200);

      // Self-modification is not configured: doctors cannot edit their own
      // professional or registration details.
      const ownUpdate = await doctorClient.patch(`${API}/doctors/${doctorId}`, {
        body: { registrationNumber: "SELF-HACK-1" },
      });
      expect(ownUpdate.status).toBe(403);

      // Nor may one doctor modify another doctor.
      const otherUpdate = await doctorClient.patch(`${API}/doctors/${otherDoctorId}`, {
        body: { specialization: "Hijacked" },
      });
      expect(otherUpdate.status).toBe(403);

      const ownAssignments = await doctorClient.put(
        `${API}/doctors/${doctorId}/branches`,
        { body: { branches: [{ branchId: branchB }] } },
      );
      expect(ownAssignments.status).toBe(403);

      const ownDepartments = await doctorClient.put(
        `${API}/doctors/${doctorId}/departments`,
        { body: { departmentIds: [neurology] } },
      );
      expect(ownDepartments.status).toBe(403);

      const remove = await doctorClient.delete(`${API}/doctors/${doctorId}`);
      expect(remove.status).toBe(403);
    } finally {
      await doctorClient.close();
    }
  });

  it("isolates doctor profiles and assignments between tenants", async () => {
    // Scenario A: a doctor from another hospital is a safe 404, never a leak.
    const crossRead = await api.get(`${API}/doctors/${otherDoctorId}`);
    expect(crossRead.status).toBe(404);

    const crossUpdate = await api.patch(`${API}/doctors/${otherDoctorId}`, {
      body: { registrationNumber: "CROSS-HACK-1" },
    });
    expect(crossUpdate.status).toBe(404);

    const crossDelete = await api.delete(`${API}/doctors/${otherDoctorId}`);
    expect(crossDelete.status).toBe(404);

    const listed = await api.get(`${API}/doctors?limit=100`);
    expect(listed.status).toBe(200);
    expect(
      dataOf<{ doctors: DoctorShape[] }>(listed).doctors.some(
        (doctor) => doctor.id === otherDoctorId,
      ),
    ).toBe(false);

    // Scenario B: a foreign branch cannot be attached to a local doctor.
    const crossBranch = await api.put(`${API}/doctors/${doctorId}/branches`, {
      body: { branches: [{ branchId: otherBranch, consultationFee: "10.00" }] },
    });
    expect(crossBranch.status).toBe(400);

    // Scenario C: a foreign department cannot be attached either.
    const crossDepartment = await api.put(`${API}/doctors/${doctorId}/departments`, {
      body: { departmentIds: [otherDepartment] },
    });
    expect(crossDepartment.status).toBe(400);

    // A budget tenantId in the body is ignored; the session's tenant wins.
    const injected = await api.post(`${API}/doctors`, {
      body: {
        tenantId: otherTenantId,
        userId: doctorUserC,
        doctorCode: "DOC-INJECT-1",
        registrationNumber: "REG-INJECT-1",
      },
    });
    expect(injected.status).toBe(201);
    const injectedId = dataOf<{ doctor: DoctorShape }>(injected).doctor.id;

    const readInOtherTenant = await otherApi.get(`${API}/doctors/${injectedId}`);
    expect(readInOtherTenant.status).toBe(404);

    const readInOwnTenant = await api.get(`${API}/doctors/${injectedId}`);
    expect(readInOwnTenant.status).toBe(200);
  });

  it("enforces doctor tenant isolation through PostgreSQL RLS", async () => {
    const role = await getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const ownDoctors = await withTenantTransaction(tenantId, (tx) =>
      tx.select({ id: doctors.id }).from(doctors),
    );
    expect(ownDoctors.some((row) => row.id === doctorId)).toBe(true);

    const foreignDoctors = await withTenantTransaction(otherTenantId, (tx) =>
      tx.select({ id: doctors.id }).from(doctors),
    );
    const foreignIds = new Set(foreignDoctors.map((row) => row.id));
    expect(foreignIds.has(doctorId)).toBe(false);
    expect(foreignIds.has(otherDoctorId)).toBe(true);

    const foreignDepartments = await withTenantTransaction(otherTenantId, (tx) =>
      tx.select({ doctorId: doctorDepartments.doctorId }).from(doctorDepartments),
    );
    expect(foreignDepartments.some((row) => row.doctorId === doctorId)).toBe(false);

    const foreignBranches = await withTenantTransaction(otherTenantId, (tx) =>
      tx.select({ doctorId: doctorBranches.doctorId }).from(doctorBranches),
    );
    expect(foreignBranches.some((row) => row.doctorId === doctorId)).toBe(false);

    // Transaction-local context must not survive into the next pool use.
    const leaked = await getPool().query<{ tid: string | null }>(
      "select current_setting('app.current_tenant_id', true) as tid",
    );
    expect(leaked.rows[0]?.tid ?? "").toBe("");
  });

  it("lists only eligible active doctor members and blocks role-less profiles", async () => {
    const candidate = await createMemberUser(tenantId, "eligible-doctor", "doctor");
    const nonDoctor = await createMemberUser(tenantId, "not-a-doctor", "receptionist");

    const search = await api.get(
      `${API}/doctors/eligible-members?search=${encodeURIComponent(candidate.email)}`,
    );
    expect(search.status).toBe(200);
    const members = dataOf<{
      members: Array<{
        userId: string;
        membershipId: string;
        roles: Array<{ slug: string }>;
      }>;
    }>(search).members;
    expect(members.map((member) => member.userId)).toEqual([candidate.id]);
    expect(members[0]?.roles.some((role) => role.slug === "doctor")).toBe(true);
    expect(JSON.stringify(search.body)).not.toMatch(/password|token/i);

    const blocked = await api.post(`${API}/doctors`, {
      body: {
        userId: nonDoctor.id,
        doctorCode: "NO-ROLE-DOC",
        registrationNumber: "NO-ROLE-REG",
      },
    });
    expect(blocked.status).toBe(400);

    const created = await api.post(`${API}/doctors`, {
      body: {
        userId: candidate.id,
        doctorCode: "ELIGIBLE-DOC",
        registrationNumber: "ELIGIBLE-REG",
      },
    });
    expect(created.status).toBe(201);

    const after = await api.get(
      `${API}/doctors/eligible-members?search=${encodeURIComponent(candidate.email)}`,
    );
    expect(dataOf<{ members: unknown[] }>(after).members).toHaveLength(0);

    const duplicate = await api.post(`${API}/doctors`, {
      body: {
        userId: candidate.id,
        doctorCode: "ELIGIBLE-DOC-2",
        registrationNumber: "ELIGIBLE-REG-2",
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it("soft deletes a doctor", async () => {
    const deleted = await api.delete(`${API}/doctors/${doctorId}`);
    expect(deleted.status).toBe(204);

    const fetched = await api.get(`${API}/doctors/${doctorId}`);
    expect(fetched.status).toBe(404);
  });
});
