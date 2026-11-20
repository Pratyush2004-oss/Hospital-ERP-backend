import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for Task 17.5 patient endpoints. The patient service suite
 * covers the business rules (codes, normalization, status transitions, account
 * linking); these tests prove routing, strict Zod validation, tenant context
 * from the session, RBAC, tenant isolation and service error propagation.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface PatientShape {
  id: string;
  patientCode: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";
  bloodGroup: string | null;
  maritalStatus: string | null;
  profileImageKey: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED" | "DECEASED";
  user: { id: string; fullName: string; isActive: boolean } | null;
  contacts?: Array<{ phone: string | null; email: string | null; contactType: string }>;
  addresses?: Array<{ addressLine1: string; country: string | null }>;
  emergencyContacts?: Array<{ name: string; phone: string }>;
}

interface PatientSummaryShape {
  id: string;
  patientCode: string;
  fullName: string;
  status: string;
  accountLinked: boolean;
}

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; pageSize: number; total: number; totalPages: number } };
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; code?: string; message?: string }>;
  };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function patientOf(response: TestResponse): PatientShape {
  return dataOf<{ patient: PatientShape }>(response).patient;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

let api: TestApi;
let otherApi: TestApi;
let receptionistApi: TestApi;
let unprivilegedApi: TestApi;
let tenantId: string;
let tenantSlug: string;
let otherTenantId: string;
let linkedUserId: string;
let otherPatientId: string;
let patientId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@patients-api.test`;
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
  receptionistApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@patients-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Patient Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Patients API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  // Front-desk role: patient:read/create/update, but no patient:delete.
  const receptionist = await createAccount(`receptionist-${suffix}`);
  await addMembership(tenantId, receptionist.id, "receptionist");
  await loginAs(receptionistApi, receptionist.email);
  await selectTenant(receptionistApi, tenantSlug);

  // Active membership with no role: authenticated but holds no patient keys.
  const unprivileged = await createAccount(`staff-${suffix}`);
  await addMembership(tenantId, unprivileged.id);
  await loginAs(unprivilegedApi, unprivileged.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  // Global account used as the optional patient-portal link target.
  const linked = await createAccount(`portal-${suffix}`);
  linkedUserId = linked.id;

  const otherAdminEmail = `other-admin-${suffix}@patients-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Patient Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Patients API ${suffix}`);
  otherTenantId = otherTenant.id;
  await selectTenant(otherApi, otherTenant.slug);

  const otherPatient = await otherApi.post(`${API}/patients`, {
    body: { fullName: "Foreign Patient", gender: "OTHER" },
  });
  expect(otherPatient.status).toBe(201);
  otherPatientId = patientOf(otherPatient).id;
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
  await receptionistApi.close();
  await unprivilegedApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("patient routes", () => {
  it("registers a patient with inline contacts, addresses and emergency contacts", async () => {
    const created = await api.post(`${API}/patients`, {
      body: {
        fullName: "  Eleanor   Whitfield ",
        dateOfBirth: "1958-04-12",
        gender: "FEMALE",
        bloodGroup: "O_POSITIVE",
        maritalStatus: "MARRIED",
        contacts: [
          { contactType: "MOBILE", phone: "+1 (555) 010-2030", isPrimary: true },
          { contactType: "WORK", email: "Eleanor.Whitfield@Example.test" },
        ],
        addresses: [
          { addressType: "HOME", addressLine1: "12 Rosewood Lane", country: "us", isPrimary: true },
        ],
        emergencyContacts: [
          {
            name: "Margaret Whitfield",
            relationship: "Sister",
            phone: "+1-555-010-9999",
            email: "margaret@example.test",
          },
        ],
      },
    });

    expect(created.status).toBe(201);
    const patient = patientOf(created);

    expect(patient.patientCode).toMatch(/^P-\d{6}$/);
    expect(patient.fullName).toBe("Eleanor Whitfield");
    expect(patient.dateOfBirth).toBe("1958-04-12");
    expect(patient.gender).toBe("FEMALE");
    expect(patient.bloodGroup).toBe("O_POSITIVE");
    expect(patient.maritalStatus).toBe("MARRIED");
    expect(patient.status).toBe("ACTIVE");
    expect(patient.user).toBeNull();

    expect(patient.contacts).toHaveLength(2);
    expect(patient.contacts?.[0]).toMatchObject({
      contactType: "MOBILE",
      phone: "+15550102030",
      email: null,
    });
    expect(patient.contacts?.[1]?.email).toBe("eleanor.whitfield@example.test");

    expect(patient.addresses).toHaveLength(1);
    expect(patient.addresses?.[0]?.country).toBe("US");
    expect(patient.emergencyContacts?.[0]).toMatchObject({
      name: "Margaret Whitfield",
      phone: "+15550109999",
    });

    // No credential material, storage keys or internal audit fields leak.
    const raw = JSON.stringify(created.body);
    expect(raw).not.toMatch(/passwordHash|password_hash|storageKey|deletedAt|tenantId/i);
    expect(patient).not.toHaveProperty("deletedAt");
    expect(patient).not.toHaveProperty("tenantId");
    expect(patient).not.toHaveProperty("patientCodeSequence");

    patientId = patient.id;
  });

  it("links an optional account only when authorized and never accepts protected fields", async () => {
    const linked = await api.post(`${API}/patients`, {
      body: { fullName: "Linked Portal Patient", userId: linkedUserId },
    });
    expect(linked.status).toBe(201);

    const patient = patientOf(linked);
    expect(Object.keys(patient.user ?? {}).sort()).toEqual(["fullName", "id", "isActive"]);
    expect(patient.user).toMatchObject({ id: linkedUserId, isActive: true });

    // The same global account may only be linked once per hospital.
    const duplicate = await api.post(`${API}/patients`, {
      body: { fullName: "Second Link", userId: linkedUserId },
    });
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).code).toBe("CONFLICT");

    const injected = await api.post(`${API}/patients`, {
      body: { fullName: "Tenant Injection", tenantId: otherTenantId },
    });
    expect(injected.status).toBe(422);
    expect(errorOf(injected).code).toBe("VALIDATION_ERROR");

    const withStatus = await api.post(`${API}/patients`, {
      body: { fullName: "Status Injection", status: "ARCHIVED" },
    });
    expect(withStatus.status).toBe(422);

    const withCode = await api.post(`${API}/patients`, {
      body: { fullName: "Code Injection", patientCode: "P-999999" },
    });
    expect(withCode.status).toBe(422);
  });

  it("rejects missing required fields and invalid values", async () => {
    const cases: unknown[] = [
      {},
      { fullName: "   " },
      { fullName: "Bad DOB", dateOfBirth: "1990-02-31" },
      { fullName: "Future DOB", dateOfBirth: "2999-01-01" },
      { fullName: "Bad Format", dateOfBirth: "12/04/1958" },
      { fullName: "Bad Gender", gender: "X" },
      { fullName: "Bad Blood", bloodGroup: "C_POSITIVE" },
      { fullName: "Bad Marital", maritalStatus: "SINGLE_ISH" },
      { fullName: "Bad User", userId: "not-a-uuid" },
      { fullName: "Bad Image", profileImageKey: "https://cdn.example.test/photo.png" },
      { fullName: "Bad Contact", contacts: [{ email: "not-an-email" }] },
      { fullName: "No Channel", contacts: [{ contactType: "MOBILE" }] },
      { fullName: "Verified Contact", contacts: [{ phone: "+15550001234", isVerified: true }] },
      { fullName: "No Address Line", addresses: [{ addressType: "HOME" }] },
      {
        fullName: "Bad Emergency",
        emergencyContacts: [{ name: "Kin", relationship: "", phone: "+15550001234" }],
      },
    ];

    for (const body of cases) {
      const response = await api.post(`${API}/patients`, { body });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }
  });

  it("lists patients with pagination metadata", async () => {
    for (const name of ["Page Alpha", "Page Bravo", "Page Charlie"]) {
      const created = await api.post(`${API}/patients`, { body: { fullName: name } });
      expect(created.status).toBe(201);
    }

    const first = await api.get(`${API}/patients?search=Page&page=1&limit=2`);
    expect(first.status).toBe(200);

    const body = first.body as Envelope<{ patients: PatientSummaryShape[] }>;
    expect(body.data.patients.map((patient) => patient.fullName)).toEqual([
      "Page Alpha",
      "Page Bravo",
    ]);
    expect(body.meta?.pagination).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });

    const second = await api.get(`${API}/patients?search=Page&page=2&limit=2`);
    expect(dataOf<{ patients: PatientSummaryShape[] }>(second).patients.map((p) => p.fullName))
      .toEqual(["Page Charlie"]);

    // List projection stays identity-only.
    expect(Object.keys(body.data.patients[0] ?? {}).sort()).toEqual([
      "accountLinked",
      "bloodGroup",
      "createdAt",
      "dateOfBirth",
      "fullName",
      "gender",
      "id",
      "patientCode",
      "status",
      "updatedAt",
    ]);
  });

  it("searches by name and patient code and filters by status, gender and date", async () => {
    const ada = patientOf(
      await api.post(`${API}/patients`, { body: { fullName: "Ada Lovelace", gender: "FEMALE" } }),
    );
    const male = patientOf(
      await api.post(`${API}/patients`, { body: { fullName: "Filter Male", gender: "MALE" } }),
    );
    const inactive = patientOf(
      await api.post(`${API}/patients`, { body: { fullName: "Filter Female", gender: "FEMALE" } }),
    );

    const deactivated = await api.patch(`${API}/patients/${inactive.id}/status`, {
      body: { status: "INACTIVE" },
    });
    expect(deactivated.status).toBe(200);

    const byName = await api.get(`${API}/patients?search=lovelace`);
    expect(dataOf<{ patients: PatientSummaryShape[] }>(byName).patients.map((p) => p.id)).toEqual([
      ada.id,
    ]);

    const byCode = await api.get(`${API}/patients?search=${ada.patientCode}`);
    expect(dataOf<{ patients: PatientSummaryShape[] }>(byCode).patients.map((p) => p.id)).toEqual([
      ada.id,
    ]);

    const inactiveOnly = await api.get(`${API}/patients?status=INACTIVE&limit=100`);
    const inactiveIds = dataOf<{ patients: PatientSummaryShape[] }>(inactiveOnly).patients.map(
      (p) => p.id,
    );
    expect(inactiveIds).toContain(inactive.id);
    expect(inactiveIds).not.toContain(male.id);

    const males = await api.get(`${API}/patients?gender=MALE&limit=100`);
    const maleIds = dataOf<{ patients: PatientSummaryShape[] }>(males).patients.map((p) => p.id);
    expect(maleIds).toContain(male.id);
    expect(maleIds).not.toContain(ada.id);

    const today = new Date().toISOString().slice(0, 10);
    const todayOnly = await api.get(`${API}/patients?dateFrom=${today}&dateTo=${today}&limit=100`);
    expect(todayOnly.status).toBe(200);
    expect(
      dataOf<{ patients: PatientSummaryShape[] }>(todayOnly).patients.map((p) => p.id),
    ).toContain(ada.id);

    const reversed = await api.get(
      `${API}/patients?dateFrom=2026-05-01&dateTo=2026-04-01`,
    );
    expect(reversed.status).toBe(422);

    const unknownStatus = await api.get(`${API}/patients?status=MAYBE`);
    expect(unknownStatus.status).toBe(422);

    const unknownGender = await api.get(`${API}/patients?gender=ROBOT`);
    expect(unknownGender.status).toBe(422);

    const badDates = await api.get(`${API}/patients?dateFrom=2026-02-30`);
    expect(badDates.status).toBe(422);

    const badPaging = await api.get(`${API}/patients?page=0&limit=101`);
    expect(badPaging.status).toBe(422);
  });

  it("retrieves a patient profile and returns 404 for unknown or malformed ids", async () => {
    const fetched = await api.get(`${API}/patients/${patientId}`);
    expect(fetched.status).toBe(200);
    expect(patientOf(fetched).id).toBe(patientId);
    expect(patientOf(fetched).contacts).toHaveLength(2);

    const missing = await api.get(`${API}/patients/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe("NOT_FOUND");

    const malformed = await api.get(`${API}/patients/not-a-uuid`);
    expect(malformed.status).toBe(422);
  });

  it("updates profile fields and rejects protected or empty patches", async () => {
    const updated = await api.patch(`${API}/patients/${patientId}`, {
      body: {
        fullName: "Eleanor Whitfield-Smith",
        bloodGroup: null,
        maritalStatus: "WIDOWED",
        profileImageKey: "tenants/patients/profile/abc.jpg",
      },
    });

    expect(updated.status).toBe(200);
    const patient = patientOf(updated);
    expect(patient.fullName).toBe("Eleanor Whitfield-Smith");
    expect(patient.bloodGroup).toBeNull();
    expect(patient.maritalStatus).toBe("WIDOWED");
    expect(patient.profileImageKey).toBe("tenants/patients/profile/abc.jpg");
    // Untouched fields keep their values.
    expect(patient.dateOfBirth).toBe("1958-04-12");
    expect(patient.gender).toBe("FEMALE");

    for (const body of [
      {},
      { tenantId: otherTenantId },
      { userId: linkedUserId },
      { patientCode: "P-000123" },
      { status: "ARCHIVED" },
      { isVerified: true },
    ]) {
      const response = await api.patch(`${API}/patients/${patientId}`, { body });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
    }

    const badImage = await api.patch(`${API}/patients/${patientId}`, {
      body: { profileImageKey: "https://cdn.example.test/photo.png" },
    });
    expect(badImage.status).toBe(422);

    const malformedId = await api.patch(`${API}/patients/not-a-uuid`, {
      body: { fullName: "Nope" },
    });
    expect(malformedId.status).toBe(422);
  });

  it("enforces status transitions and rejects unknown statuses", async () => {
    const created = patientOf(
      await api.post(`${API}/patients`, { body: { fullName: "Status Patient" } }),
    );

    const inactive = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "INACTIVE" },
    });
    expect(inactive.status).toBe(200);
    expect(patientOf(inactive).status).toBe("INACTIVE");

    const active = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "ACTIVE" },
    });
    expect(patientOf(active).status).toBe("ACTIVE");

    const archived = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "ARCHIVED" },
    });
    expect(patientOf(archived).status).toBe("ARCHIVED");

    // Reactivation must be explicit; archived -> inactive is a conflict.
    const backwards = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "INACTIVE" },
    });
    expect(backwards.status).toBe(409);
    expect(errorOf(backwards).code).toBe("CONFLICT");

    // Archived profiles are read-only until reactivated.
    const editArchived = await api.patch(`${API}/patients/${created.id}`, {
      body: { fullName: "Too Late" },
    });
    expect(editArchived.status).toBe(409);

    const reactivated = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "ACTIVE" },
    });
    expect(patientOf(reactivated).status).toBe("ACTIVE");

    const deceased = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "DECEASED" },
    });
    expect(deceased.status).toBe(422);

    const unknown = await api.patch(`${API}/patients/${created.id}/status`, {
      body: { status: "MAYBE" },
    });
    expect(unknown.status).toBe(422);
  });

  it("soft deletes a patient and hides it from reads and lists", async () => {
    const created = patientOf(
      await api.post(`${API}/patients`, { body: { fullName: "Delete Me" } }),
    );

    const deleted = await api.delete(`${API}/patients/${created.id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();

    const fetched = await api.get(`${API}/patients/${created.id}`);
    expect(fetched.status).toBe(404);

    const listed = await api.get(`${API}/patients?search=Delete Me`);
    expect(dataOf<{ patients: PatientSummaryShape[] }>(listed).patients).toHaveLength(0);

    // Repeated deletion is idempotent, and the row is retained (not hard deleted).
    const again = await api.delete(`${API}/patients/${created.id}`);
    expect(again.status).toBe(204);

    const { rows } = await getTestAdminPool().query<{ deleted_at: Date | null; status: string }>(
      "select deleted_at, status from patient_profiles where id = $1",
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.status).toBe("ARCHIVED");
  });

  it("enforces authentication, tenant context and patient RBAC boundaries", async () => {
    const anonymous = await createTestApi(createApp());

    try {
      const read = await anonymous.get(`${API}/patients`);
      expect(read.status).toBe(401);

      const create = await anonymous.post(`${API}/patients`, {
        body: { fullName: "Anonymous" },
      });
      expect(create.status).toBe(401);
    } finally {
      await anonymous.close();
    }

    // No tenant selected: authenticated but wrong plane.
    const noTenant = await createTestApi(createApp());

    try {
      const account = await createAccount(`no-tenant-${randomUUID().slice(0, 8)}`);
      await loginAs(noTenant, account.email);

      const response = await noTenant.get(`${API}/patients`);
      expect(response.status).toBe(403);
    } finally {
      await noTenant.close();
    }

    // Active membership without patient permissions is denied at the route.
    const staffRead = await unprivilegedApi.get(`${API}/patients`);
    expect(staffRead.status).toBe(403);

    const staffCreate = await unprivilegedApi.post(`${API}/patients`, {
      body: { fullName: "Should Fail" },
    });
    expect(staffCreate.status).toBe(403);

    // A receptionist may register and read but not archive patients.
    const receptionistCreate = await receptionistApi.post(`${API}/patients`, {
      body: { fullName: "Reception Registered" },
    });
    expect(receptionistCreate.status).toBe(201);

    const receptionistRead = await receptionistApi.get(`${API}/patients`);
    expect(receptionistRead.status).toBe(200);

    const receptionistDelete = await receptionistApi.delete(
      `${API}/patients/${patientOf(receptionistCreate).id}`,
    );
    expect(receptionistDelete.status).toBe(403);
    expect(errorOf(receptionistDelete).code).toBe("FORBIDDEN");
  });

  it("isolates patients between tenants at every endpoint", async () => {
    const crossRead = await api.get(`${API}/patients/${otherPatientId}`);
    expect(crossRead.status).toBe(404);

    const crossUpdate = await api.patch(`${API}/patients/${otherPatientId}`, {
      body: { fullName: "Hijacked" },
    });
    expect(crossUpdate.status).toBe(404);

    const crossStatus = await api.patch(`${API}/patients/${otherPatientId}/status`, {
      body: { status: "ARCHIVED" },
    });
    expect(crossStatus.status).toBe(404);

    const crossDelete = await api.delete(`${API}/patients/${otherPatientId}`);
    expect(crossDelete.status).toBe(404);

    const ownList = await api.get(`${API}/patients?limit=100`);
    expect(
      dataOf<{ patients: PatientSummaryShape[] }>(ownList).patients.map((p) => p.id),
    ).not.toContain(otherPatientId);

    const foreignList = await otherApi.get(`${API}/patients?limit=100`);
    expect(
      dataOf<{ patients: PatientSummaryShape[] }>(foreignList).patients.map((p) => p.id),
    ).not.toContain(patientId);
  });
});
