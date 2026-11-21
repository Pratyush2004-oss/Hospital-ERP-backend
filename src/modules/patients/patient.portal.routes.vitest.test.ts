import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * ONB-09: public patient self-registration and the patient portal.
 *
 * These tests prove the HTTP contract and the security boundaries around it:
 * strict public input, one global account per email, tenant-scoped patient
 * profiles, email verification before portal access, cross-tenant/cross-patient
 * denial and the preserved receptionist walk-in flow.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface PortalPatient {
  id: string;
  patientCode: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string;
  bloodGroup: string | null;
  status: string;
  user: { id: string; fullName: string; isActive: boolean } | null;
  contacts?: Array<{ phone: string | null; email: string | null }>;
}

interface PortalHospital {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  patientId: string;
  patientCode: string;
  status: string;
}

interface Envelope<T> {
  data: T;
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

function patientOf(response: TestResponse): PortalPatient {
  return dataOf<{ patient: PortalPatient }>(response).patient;
}

let adminApi: TestApi;
let receptionistApi: TestApi;
let otherAdminApi: TestApi;
let tenantId: string;
let tenantName: string;
let tenantSlug: string;
let otherTenantId: string;
let otherTenantSlug: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@portal-api.test`;
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

async function addMembership(
  tenant: string,
  userId: string,
  roleSlug?: string,
): Promise<void> {
  const pool = getTestAdminPool();
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenant, userId],
  );

  if (roleSlug !== undefined) {
    await pool.query(
      `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
       select m.tenant_id, m.id, r.id
       from tenant_memberships m
       join roles r on r.tenant_id = m.tenant_id and r.slug = $3
       where m.tenant_id = $1 and m.user_id = $2`,
      [tenant, userId, roleSlug],
    );
  }
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

async function markEmailVerified(userId: string): Promise<void> {
  await getTestAdminPool().query(
    "update users set email_verified_at = now() where id = $1",
    [userId],
  );
}

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@portal-public.test`;
}

async function publicRegister(
  body: Record<string, unknown>,
): Promise<TestResponse> {
  const client = await createTestApi(createApp());

  try {
    return await client.post(`${API}/registrations`, { body });
  } finally {
    await client.close();
  }
}

/**
 * Registers a patient publicly, verifies the email and returns an
 * authenticated client for that account.
 */
async function createVerifiedPatientClient(
  label: string,
  hospitalSlug: string,
): Promise<{ client: TestApi; userId: string; email: string; patientId: string }> {
  const email = uniqueEmail(label);
  const response = await publicRegister({
    hospitalSlug,
    fullName: `Patient ${label}`,
    email,
    password: PASSWORD,
    phone: null,
  });
  expect(response.status).toBe(201);

  const result = dataOf<{
    user: { id: string };
    patient: PortalPatient;
    accountCreated: boolean;
    requiresEmailVerification: boolean;
  }>(response);
  expect(result.accountCreated).toBe(true);
  expect(result.requiresEmailVerification).toBe(true);

  createdUserIds.push(result.user.id);
  await markEmailVerified(result.user.id);

  const client = await createTestApi(createApp());
  await loginAs(client, email);

  return {
    client,
    userId: result.user.id,
    email,
    patientId: result.patient.id,
  };
}

beforeAll(async () => {
  adminApi = await createTestApi(createApp());
  receptionistApi = await createTestApi(createApp());
  otherAdminApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@portal-api.test`;
  await adminApi.post(`${API}/auth/register`, {
    body: { fullName: "Portal Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(adminApi, adminEmail);

  const registration = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Portal Hospital ${suffix}` },
  });
  expect(registration.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string; slug: string; name: string } }>(
    registration,
  ).tenant;
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  tenantName = tenant.name;
  createdTenantIds.push(tenantId);

  await getTestAdminPool().query(
    "update tenants set status = 'ACTIVE' where id = $1",
    [tenantId],
  );
  await selectTenant(adminApi, tenantSlug);

  const receptionist = await createAccount(`receptionist-${suffix}`);
  await addMembership(tenantId, receptionist.id, "receptionist");
  await loginAs(receptionistApi, receptionist.email);
  await selectTenant(receptionistApi, tenantSlug);

  const otherAdminEmail = `other-admin-${suffix}@portal-api.test`;
  await otherAdminApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Portal Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherAdminApi, otherAdminEmail);

  const otherRegistration = await otherAdminApi.post(`${API}/tenants/register`, {
    body: { name: `Other Portal Hospital ${suffix}` },
  });
  expect(otherRegistration.status).toBe(201);
  const otherTenant = dataOf<{
    tenant: { id: string; slug: string; name: string };
  }>(otherRegistration).tenant;
  otherTenantId = otherTenant.id;
  otherTenantSlug = otherTenant.slug;
  createdTenantIds.push(otherTenantId);

  await getTestAdminPool().query(
    "update tenants set status = 'ACTIVE' where id = $1",
    [otherTenantId],
  );
  await selectTenant(otherAdminApi, otherTenantSlug);
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const id of createdTenantIds) {
    await pool.query("delete from tenants where id = $1", [id]);
  }
  for (const id of createdUserIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  await adminApi.close();
  await receptionistApi.close();
  await otherAdminApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("patient portal registration", () => {
  it("creates one global account and an unverified patient profile in the hospital", async () => {
    const email = uniqueEmail("self-register");
    const response = await publicRegister({
      hospitalSlug: tenantSlug,
      fullName: "  Ada   Lovelace ",
      email,
      password: PASSWORD,
      phone: "+1 (555) 010-1111",
      dateOfBirth: "1990-02-28",
      gender: "FEMALE",
    });

    expect(response.status).toBe(201);
    const result = dataOf<{
      user: { id: string; email: string; emailVerifiedAt: string | null };
      patient: PortalPatient;
      accountCreated: boolean;
      requiresEmailVerification: boolean;
    }>(response);

    createdUserIds.push(result.user.id);

    expect(result.accountCreated).toBe(true);
    expect(result.requiresEmailVerification).toBe(true);
    expect(result.user.emailVerifiedAt).toBeNull();
    expect(result.patient.fullName).toBe("Ada Lovelace");
    expect(result.patient.patientCode).toMatch(/^P-\d{6}$/);
    expect(result.patient.user?.id).toBe(result.user.id);
    expect(result.patient.contacts?.[0]?.email).toBe(email);

    // Registration must not create any staff authorization.
    const memberships = await getTestAdminPool().query(
      "select id from tenant_memberships where tenant_id = $1 and user_id = $2",
      [tenantId, result.user.id],
    );
    expect(memberships.rows).toHaveLength(0);

    // The portal is closed until the email is verified.
    const client = await createTestApi(createApp());
    try {
      await loginAs(client, email);
      const denied = await client.get(`${API}/portal/hospitals`);
      expect(denied.status).toBe(403);
      expect(errorOf(denied).code).toBe("EMAIL_NOT_VERIFIED");

      await markEmailVerified(result.user.id);

      const hospitals = await client.get(`${API}/portal/hospitals`);
      expect(hospitals.status).toBe(200);
      const summaries = dataOf<{ hospitals: PortalHospital[] }>(hospitals).hospitals;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        tenantId,
        tenantSlug,
        tenantName,
        patientId: result.patient.id,
      });

      const profile = await client.get(
        `${API}/portal/hospitals/${tenantSlug}/profile`,
      );
      expect(profile.status).toBe(200);
      const own = patientOf(profile);
      expect(own.id).toBe(result.patient.id);
      // Portal profile data is limited to demographics/contacts; no clinical
      // records or medical history are returned.
      expect(own.bloodGroup).toBeNull();
      expect(own).not.toHaveProperty("documents");
      expect(own).not.toHaveProperty("medicalHistory");
    } finally {
      await client.close();
    }
  });

  it("rejects privileged or tenant-selecting fields in the public payload", async () => {
    const email = uniqueEmail("role-injection");

    for (const extra of [
      { role: "HOSPITAL_ADMIN" },
      { roles: ["admin"] },
      { tenantId },
      { isStaff: true },
      { patientCode: "P-999999" },
    ]) {
      const response = await publicRegister({
        hospitalSlug: tenantSlug,
        fullName: "Privilege Attempt",
        email,
        password: PASSWORD,
        ...extra,
      });

      expect(response.status).toBe(422);
    }

    // Nothing was created by the rejected requests.
    const users = await getTestAdminPool().query(
      "select id from users where lower(email) = lower($1)",
      [email],
    );
    expect(users.rows).toHaveLength(0);
  });

  it("returns an explicit conflict instead of creating a second global account", async () => {
    const patient = await createVerifiedPatientClient("duplicate-account", tenantSlug);

    try {
      const duplicate = await publicRegister({
        hospitalSlug: otherTenantSlug,
        fullName: "Duplicate Account",
        email: patient.email,
        password: PASSWORD,
      });

      expect(duplicate.status).toBe(409);
      expect(errorOf(duplicate).details).toMatchObject({ reason: "ACCOUNT_EXISTS" });

      const users = await getTestAdminPool().query(
        "select id from users where lower(email) = lower($1)",
        [patient.email],
      );
      expect(users.rows).toHaveLength(1);
    } finally {
      await patient.client.close();
    }
  });

  it("blocks self-registration when a matching patient record already exists", async () => {
    const email = uniqueEmail("walk-in-match");

    const walkIn = await receptionistApi.post(`${API}/patients`, {
      body: {
        fullName: "Existing Walk In",
        gender: "UNKNOWN",
        contacts: [{ contactType: "MOBILE", email, isPrimary: true }],
      },
    });
    expect(walkIn.status).toBe(201);

    const response = await publicRegister({
      hospitalSlug: tenantSlug,
      fullName: "Claiming Walk In",
      email,
      password: PASSWORD,
    });

    expect(response.status).toBe(409);
    const error = errorOf(response);
    expect(error.details).toMatchObject({ reason: "POTENTIAL_PATIENT_MATCH" });
    // The response must not disclose the existing patient's identity.
    expect(error.message).not.toContain("Existing Walk In");

    const users = await getTestAdminPool().query(
      "select id from users where lower(email) = lower($1)",
      [email],
    );
    expect(users.rows).toHaveLength(0);
  });

  it("hides a hospital that is not active from public registration", async () => {
    const pool = getTestAdminPool();
    await pool.query("update tenants set status = 'SUSPENDED' where id = $1", [
      otherTenantId,
    ]);

    try {
      const response = await publicRegister({
        hospitalSlug: otherTenantSlug,
        fullName: "Suspended Hospital Patient",
        email: uniqueEmail("suspended"),
        password: PASSWORD,
      });

      expect(response.status).toBe(404);
      expect(errorOf(response).message).toContain("not accepting patient registrations");
    } finally {
      await pool.query("update tenants set status = 'ACTIVE' where id = $1", [
        otherTenantId,
      ]);
    }
  });
});

describe("patient portal linking and access control", () => {
  it("links the existing account to another hospital without a second global account", async () => {
    const patient = await createVerifiedPatientClient("multi-hospital", tenantSlug);

    try {
      const link = await patient.client.post(`${API}/portal/registrations`, {
        body: {
          hospitalSlug: otherTenantSlug,
          fullName: "Multi Hospital Patient",
          phone: "+1 555 010 2222",
        },
      });
      expect(link.status).toBe(201);

      const linked = dataOf<{ patient: PortalPatient }>(link).patient;
      expect(linked.id).not.toBe(patient.patientId);
      expect(linked.user?.id).toBe(patient.userId);

      const hospitals = await patient.client.get(`${API}/portal/hospitals`);
      const summaries = dataOf<{ hospitals: PortalHospital[] }>(hospitals).hospitals;
      expect(summaries.map((entry) => entry.tenantId).sort()).toEqual(
        [tenantId, otherTenantId].sort(),
      );

      const globalAccounts = await getTestAdminPool().query(
        "select id from users where lower(email) = lower($1)",
        [patient.email],
      );
      expect(globalAccounts.rows).toHaveLength(1);

      // The same account can only be linked once per hospital.
      const duplicateLink = await patient.client.post(`${API}/portal/registrations`, {
        body: { hospitalSlug: otherTenantSlug, phone: "+1 555 010 2222" },
      });
      expect(duplicateLink.status).toBe(409);
      expect(errorOf(duplicateLink).details).toMatchObject({
        reason: "PATIENT_ALREADY_LINKED",
      });
    } finally {
      await patient.client.close();
    }
  });

  it("denies portal reads for other hospitals and other patients", async () => {
    // This account is linked only to the first hospital.
    const patient = await createVerifiedPatientClient("cross-tenant", tenantSlug);

    try {
      const own = await patient.client.get(
        `${API}/portal/hospitals/${tenantSlug}/profile`,
      );
      expect(own.status).toBe(200);

      const foreign = await patient.client.get(
        `${API}/portal/hospitals/${otherTenantSlug}/profile`,
      );
      expect(foreign.status).toBe(404);

      const unknown = await patient.client.get(
        `${API}/portal/hospitals/does-not-exist/profile`,
      );
      expect(unknown.status).toBe(404);

      // A second patient in the same hospital never sees the first one.
      const otherPatient = await createVerifiedPatientClient("cross-patient", tenantSlug);
      try {
        const otherProfile = await otherPatient.client.get(
          `${API}/portal/hospitals/${tenantSlug}/profile`,
        );
        expect(otherProfile.status).toBe(200);
        expect(patientOf(otherProfile).id).toBe(otherPatient.patientId);
        expect(patientOf(otherProfile).id).not.toBe(patient.patientId);

        const otherHospitals = await otherPatient.client.get(`${API}/portal/hospitals`);
        const summaries = dataOf<{ hospitals: PortalHospital[] }>(otherHospitals).hospitals;
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.patientId).toBe(otherPatient.patientId);
      } finally {
        await otherPatient.client.close();
      }
    } finally {
      await patient.client.close();
    }
  });

  it("requires authentication for portal routes", async () => {
    const anonymous = await createTestApi(createApp());

    try {
      const hospitals = await anonymous.get(`${API}/portal/hospitals`);
      expect(hospitals.status).toBe(401);

      const link = await anonymous.post(`${API}/portal/registrations`, {
        body: { hospitalSlug: tenantSlug, phone: "+1 555 010 3333" },
      });
      expect(link.status).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  it("never grants hospital-plane access to a patient login", async () => {
    const patient = await createVerifiedPatientClient("no-staff-access", tenantSlug);

    try {
      const staffList = await patient.client.get(`${API}/patients`);
      expect(staffList.status).toBe(403);

      const memberships = await getTestAdminPool().query(
        "select id from tenant_memberships where user_id = $1",
        [patient.userId],
      );
      expect(memberships.rows).toHaveLength(0);
    } finally {
      await patient.client.close();
    }
  });

  it("keeps receptionist walk-in registration unlinked and distinct from portal profiles", async () => {
    const walkIn = await receptionistApi.post(`${API}/patients`, {
      body: {
        fullName: "Reception Walk In",
        gender: "OTHER",
        contacts: [{ contactType: "MOBILE", phone: "+1 555 010 4444", isPrimary: true }],
      },
    });
    expect(walkIn.status).toBe(201);
    const created = patientOf(walkIn);
    expect(created.user).toBeNull();

    const list = await receptionistApi.get(`${API}/patients`, {
      // Keep the assertion stable even when other tests have added patients.
    });
    expect(list.status).toBe(200);
    const summaries = dataOf<{
      patients: Array<{ id: string; accountLinked: boolean }>;
    }>(list).patients;
    const summary = summaries.find((entry) => entry.id === created.id);

    expect(summary?.accountLinked).toBe(false);

    // A patient portal login cannot be created from a walk-in record without
    // explicit staff linking; the record itself stays staff-visible only.
    const unlinked = await getTestAdminPool().query(
      "select user_id from patient_profiles where id = $1",
      [created.id],
    );
    expect(unlinked.rows[0]?.user_id).toBeNull();
  });
});
