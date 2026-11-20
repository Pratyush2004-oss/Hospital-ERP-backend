import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";

/**
 * HTTP-level tests for Task 17.6 contact, address and emergency-contact
 * endpoints. The service suite covers primary-selection and normalisation
 * rules; these tests prove routing, strict validation (including verification
 * flags), RBAC, tenant isolation, cross-patient ownership and concurrent
 * primary updates.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface ContactShape {
  id: string;
  contactType: string;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AddressShape {
  id: string;
  addressType: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EmergencyContactShape {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Envelope<T> {
  data: T;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function contactOf(response: TestResponse): ContactShape {
  return dataOf<{ contact: ContactShape }>(response).contact;
}

function addressOf(response: TestResponse): AddressShape {
  return dataOf<{ address: AddressShape }>(response).address;
}

function emergencyContactOf(response: TestResponse): EmergencyContactShape {
  return dataOf<{ emergencyContact: EmergencyContactShape }>(response).emergencyContact;
}

function errorCode(response: TestResponse): string {
  return (response.body as ErrorEnvelope).error.code;
}

let api: TestApi;
let otherApi: TestApi;
let unprivilegedApi: TestApi;
let tenantId: string;
let tenantSlug: string;
let patientA: string;
let patientB: string;
let foreignPatient: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@patient-records-api.test`;
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

async function createPatient(client: TestApi, fullName: string): Promise<string> {
  const response = await client.post(`${API}/patients`, { body: { fullName } });
  expect(response.status).toBe(201);

  return dataOf<{ patient: { id: string } }>(response).patient.id;
}

beforeAll(async () => {
  api = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  unprivilegedApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const adminEmail = `admin-${suffix}@patient-records-api.test`;
  await api.post(`${API}/auth/register`, {
    body: { fullName: "Records Admin", email: adminEmail, password: PASSWORD },
  });
  await loginAs(api, adminEmail);

  const tenant = await registerTenant(api, `Patient Records API ${suffix}`);
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  await selectTenant(api, tenantSlug);

  // Active membership with no role: authenticated but holds no patient keys.
  const unprivileged = await createAccount(`staff-${suffix}`);
  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE', now())`,
    [tenantId, unprivileged.id],
  );
  await loginAs(unprivilegedApi, unprivileged.email);
  await selectTenant(unprivilegedApi, tenantSlug);

  patientA = await createPatient(api, "Record Patient A");
  patientB = await createPatient(api, "Record Patient B");

  const otherAdminEmail = `other-admin-${suffix}@patient-records-api.test`;
  await otherApi.post(`${API}/auth/register`, {
    body: { fullName: "Other Records Admin", email: otherAdminEmail, password: PASSWORD },
  });
  await loginAs(otherApi, otherAdminEmail);

  const otherTenant = await registerTenant(otherApi, `Other Patient Records API ${suffix}`);
  await selectTenant(otherApi, otherTenant.slug);
  foreignPatient = await createPatient(otherApi, "Foreign Record Patient");
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
  await unprivilegedApi.close();
  await closeTestAdminPool();
  await closePool();
});

describe("patient contact routes", () => {
  let phoneContactId: string;
  let emailContactId: string;

  it("creates, lists, updates and deletes a phone and an email contact", async () => {
    const phone = await api.post(`${API}/patients/${patientA}/contacts`, {
      body: { contactType: "MOBILE", phone: "+1 (555) 010-2030", isPrimary: true },
    });
    expect(phone.status).toBe(201);

    const phoneContact = contactOf(phone);
    expect(phoneContact).toMatchObject({
      contactType: "MOBILE",
      phone: "+15550102030",
      email: null,
      isPrimary: true,
      isVerified: false,
    });
    // Only the public contact projection is returned.
    expect(Object.keys(phoneContact).sort()).toEqual([
      "contactType",
      "createdAt",
      "email",
      "id",
      "isPrimary",
      "isVerified",
      "phone",
      "updatedAt",
    ]);
    phoneContactId = phoneContact.id;

    const email = await api.post(`${API}/patients/${patientA}/contacts`, {
      body: { contactType: "WORK", email: "  Records.Patient@Example.test " },
    });
    expect(email.status).toBe(201);
    expect(contactOf(email)).toMatchObject({
      contactType: "WORK",
      phone: null,
      email: "records.patient@example.test",
      isPrimary: false,
      isVerified: false,
    });
    emailContactId = contactOf(email).id;

    const listed = await api.get(`${API}/patients/${patientA}/contacts`);
    expect(listed.status).toBe(200);
    const contacts = dataOf<{ contacts: ContactShape[] }>(listed).contacts;
    expect(contacts.map((contact) => contact.id)).toEqual([phoneContactId, emailContactId]);

    const updated = await api.patch(
      `${API}/patients/${patientA}/contacts/${emailContactId}`,
      { body: { phone: "+44 20 7946 0958", contactType: "HOME" } },
    );
    expect(updated.status).toBe(200);
    expect(contactOf(updated)).toMatchObject({
      contactType: "HOME",
      phone: "+442079460958",
      email: "records.patient@example.test",
      isVerified: false,
    });

    const deleted = await api.delete(
      `${API}/patients/${patientA}/contacts/${emailContactId}`,
    );
    expect(deleted.status).toBe(204);

    const afterDelete = await api.get(`${API}/patients/${patientA}/contacts`);
    expect(dataOf<{ contacts: ContactShape[] }>(afterDelete).contacts.map((c) => c.id)).toEqual([
      phoneContactId,
    ]);

    const again = await api.delete(`${API}/patients/${patientA}/contacts/${emailContactId}`);
    expect(again.status).toBe(404);
  });

  it("promotes one contact to primary and demotes the previous primary", async () => {
    const second = await api.post(`${API}/patients/${patientA}/contacts`, {
      body: { contactType: "OTHER", email: "second-primary@example.test" },
    });
    expect(second.status).toBe(201);
    const secondId = contactOf(second).id;

    const promoted = await api.patch(
      `${API}/patients/${patientA}/contacts/${secondId}/primary`,
    );
    expect(promoted.status).toBe(200);
    expect(contactOf(promoted).isPrimary).toBe(true);

    const listed = await api.get(`${API}/patients/${patientA}/contacts`);
    const contacts = dataOf<{ contacts: ContactShape[] }>(listed).contacts;
    expect(contacts.filter((contact) => contact.isPrimary)).toHaveLength(1);
    expect(contacts[0]?.id).toBe(secondId);

    const oldPrimary = contacts.find((contact) => contact.id === phoneContactId);
    expect(oldPrimary?.isPrimary).toBe(false);

    // A repeated promotion is a safe no-op.
    const repeated = await api.patch(
      `${API}/patients/${patientA}/contacts/${secondId}/primary`,
    );
    expect(repeated.status).toBe(200);
    expect(contactOf(repeated).isPrimary).toBe(true);
  });

  it("rejects invalid payloads, protected fields and verification attempts", async () => {
    const base = `${API}/patients/${patientA}/contacts`;

    for (const body of [
      {},
      { phone: "12" },
      { email: "not-an-email" },
      { contactType: "PAGER", phone: "+15550001111" },
      { phone: "+15550001111", isVerified: true },
      { phone: "+15550001111", verified: true },
      { phone: "+15550001111", tenantId: randomUUID() },
      { phone: "+15550001111", patientId: randomUUID() },
      { phone: "+15550001111", id: randomUUID() },
      { phone: "+15550001111", unexpected: "field" },
    ]) {
      const response = await api.post(base, { body });
      expect(response.status).toBe(422);
      expect(errorCode(response)).toBe("VALIDATION_ERROR");
    }

    const verification = await api.post(base, {
      body: { phone: "+15550001111", isVerified: true },
    });
    expect(verification.status).toBe(422);

    const emptyPatch = await api.patch(`${base}/${phoneContactId}`, { body: {} });
    expect(emptyPatch.status).toBe(422);

    const verifiedPatch = await api.patch(`${base}/${phoneContactId}`, {
      body: { isVerified: true },
    });
    expect(verifiedPatch.status).toBe(422);

    const unknownField = await api.patch(`${base}/${phoneContactId}`, {
      body: { phone: "+15550002222", verified: true },
    });
    expect(unknownField.status).toBe(422);

    // Duplicate reachable values stay rejected by the service.
    const duplicate = await api.post(base, { body: { phone: "+1 555 010 2030" } });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe("CONFLICT");

    const malformedPatient = await api.get(`${API}/patients/not-a-uuid/contacts`);
    expect(malformedPatient.status).toBe(422);

    const malformedContact = await api.patch(
      `${API}/patients/${patientA}/contacts/not-a-uuid`,
      { body: { phone: "+15550003333" } },
    );
    expect(malformedContact.status).toBe(422);
  });

  it("keeps concurrent primary contact promotions consistent", async () => {
    const first = await api.post(`${API}/patients/${patientB}/contacts`, {
      body: { phone: "+15550004001" },
    });
    const second = await api.post(`${API}/patients/${patientB}/contacts`, {
      body: { phone: "+15550004002" },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstId = contactOf(first).id;
    const secondId = contactOf(second).id;

    const results = await Promise.all([
      api.patch(`${API}/patients/${patientB}/contacts/${firstId}/primary`),
      api.patch(`${API}/patients/${patientB}/contacts/${secondId}/primary`),
    ]);

    // A lost race is a clean 409, never a 500 or two primaries.
    for (const result of results) {
      expect([200, 409]).toContain(result.status);
    }
    expect(results.some((result) => result.status === 200)).toBe(true);

    const listed = await api.get(`${API}/patients/${patientB}/contacts`);
    const primaries = dataOf<{ contacts: ContactShape[] }>(listed).contacts.filter(
      (contact) => contact.isPrimary,
    );
    expect(primaries).toHaveLength(1);
  });
});

describe("patient address routes", () => {
  let homeA: string;
  let homeB: string;

  it("creates, lists, updates and deletes addresses", async () => {
    const first = await api.post(`${API}/patients/${patientA}/addresses`, {
      body: {
        addressType: "HOME",
        addressLine1: "  12 Rosewood Lane ",
        city: "Springfield",
        postalCode: "62704",
        country: "us",
        isPrimary: true,
      },
    });
    expect(first.status).toBe(201);

    const address = addressOf(first);
    expect(address).toMatchObject({
      addressType: "HOME",
      addressLine1: "12 Rosewood Lane",
      city: "Springfield",
      postalCode: "62704",
      country: "US",
      isPrimary: true,
    });
    expect(Object.keys(address).sort()).toEqual([
      "addressLine1",
      "addressLine2",
      "addressType",
      "city",
      "country",
      "createdAt",
      "id",
      "isPrimary",
      "postalCode",
      "state",
      "updatedAt",
    ]);
    homeA = address.id;

    const second = await api.post(`${API}/patients/${patientA}/addresses`, {
      body: { addressType: "HOME", addressLine1: "48 Oak Avenue" },
    });
    expect(second.status).toBe(201);
    homeB = addressOf(second).id;

    const work = await api.post(`${API}/patients/${patientA}/addresses`, {
      body: { addressType: "WORK", addressLine1: "400 Industrial Way" },
    });
    expect(work.status).toBe(201);

    const listed = await api.get(`${API}/patients/${patientA}/addresses`);
    expect(listed.status).toBe(200);
    expect(dataOf<{ addresses: AddressShape[] }>(listed).addresses).toHaveLength(3);

    const updated = await api.patch(`${API}/patients/${patientA}/addresses/${homeB}`, {
      body: { addressLine2: " Floor 2 ", state: "IL", postalCode: "62705", country: "gb" },
    });
    expect(updated.status).toBe(200);
    expect(addressOf(updated)).toMatchObject({
      addressLine1: "48 Oak Avenue",
      addressLine2: "Floor 2",
      state: "IL",
      postalCode: "62705",
      country: "GB",
    });

    const deleted = await api.delete(`${API}/patients/${patientA}/addresses/${homeB}`);
    expect(deleted.status).toBe(204);

    const afterDelete = await api.get(`${API}/patients/${patientA}/addresses`);
    expect(
      dataOf<{ addresses: AddressShape[] }>(afterDelete).addresses.some((a) => a.id === homeB),
    ).toBe(false);
  });

  it("keeps at most one primary address per category", async () => {
    const promoted = await api.patch(
      `${API}/patients/${patientA}/addresses/${homeB}/primary`,
    );
    // homeB was deleted in the previous test, so this must be a clean 404.
    expect(promoted.status).toBe(404);

    const replacement = await api.post(`${API}/patients/${patientA}/addresses`, {
      body: { addressType: "HOME", addressLine1: "9 New Home Road" },
    });
    expect(replacement.status).toBe(201);
    const replacementId = addressOf(replacement).id;

    const setPrimary = await api.patch(
      `${API}/patients/${patientA}/addresses/${replacementId}/primary`,
    );
    expect(setPrimary.status).toBe(200);

    const listed = await api.get(`${API}/patients/${patientA}/addresses`);
    const addresses = dataOf<{ addresses: AddressShape[] }>(listed).addresses;
    const primaryHome = addresses.filter(
      (address) => address.addressType === "HOME" && address.isPrimary,
    );
    expect(primaryHome).toHaveLength(1);
    expect(primaryHome[0]?.id).toBe(replacementId);
    expect(addresses.find((address) => address.id === homeA)?.isPrimary).toBe(false);
  });

  it("rejects invalid address payloads and protected fields", async () => {
    const base = `${API}/patients/${patientA}/addresses`;

    for (const body of [
      {},
      { addressLine1: "   " },
      { addressLine1: "Line", addressType: "HOLIDAY" },
      { addressLine1: "Line", country: "USA" },
      { addressLine1: "Line", postalCode: "123456789012345678901" },
      { addressLine1: "Line", tenantId: randomUUID() },
      { addressLine1: "Line", patientId: randomUUID() },
      { addressLine1: "Line", id: randomUUID() },
      { addressLine1: "Line", isVerified: true },
    ]) {
      const response = await api.post(base, { body });
      expect(response.status).toBe(422);
      expect(errorCode(response)).toBe("VALIDATION_ERROR");
    }

    const emptyPatch = await api.patch(`${base}/${homeA}`, { body: {} });
    expect(emptyPatch.status).toBe(422);

    const protectedPatch = await api.patch(`${base}/${homeA}`, {
      body: { addressLine1: "Changed", tenantId: randomUUID() },
    });
    expect(protectedPatch.status).toBe(422);

    const malformed = await api.patch(`${base}/not-a-uuid`, {
      body: { city: "Nowhere" },
    });
    expect(malformed.status).toBe(422);
  });

  it("keeps concurrent primary address promotions consistent", async () => {
    const first = await api.post(`${API}/patients/${patientB}/addresses`, {
      body: { addressType: "WORK", addressLine1: "Work One" },
    });
    const second = await api.post(`${API}/patients/${patientB}/addresses`, {
      body: { addressType: "WORK", addressLine1: "Work Two" },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const results = await Promise.all([
      api.patch(`${API}/patients/${patientB}/addresses/${addressOf(first).id}/primary`),
      api.patch(`${API}/patients/${patientB}/addresses/${addressOf(second).id}/primary`),
    ]);

    for (const result of results) {
      expect([200, 409]).toContain(result.status);
    }

    const listed = await api.get(`${API}/patients/${patientB}/addresses`);
    const primaryWork = dataOf<{ addresses: AddressShape[] }>(listed).addresses.filter(
      (address) => address.addressType === "WORK" && address.isPrimary,
    );
    expect(primaryWork).toHaveLength(1);
  });
});

describe("patient emergency contact routes", () => {
  let emergencyContactId: string;

  it("creates, lists, updates and deletes emergency contacts", async () => {
    const created = await api.post(`${API}/patients/${patientA}/emergency-contacts`, {
      body: {
        name: "  Margaret Whitfield ",
        relationship: " Sister ",
        phone: "+1-555-010-9999",
        email: "Margaret@Example.test",
      },
    });
    expect(created.status).toBe(201);

    const contact = emergencyContactOf(created);
    expect(contact).toMatchObject({
      name: "Margaret Whitfield",
      relationship: "Sister",
      phone: "+15550109999",
      email: "margaret@example.test",
    });
    expect(Object.keys(contact).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "name",
      "phone",
      "relationship",
      "updatedAt",
    ]);
    emergencyContactId = contact.id;

    const listed = await api.get(`${API}/patients/${patientA}/emergency-contacts`);
    expect(listed.status).toBe(200);
    expect(
      dataOf<{ emergencyContacts: EmergencyContactShape[] }>(listed).emergencyContacts.map(
        (item) => item.id,
      ),
    ).toContain(emergencyContactId);

    const updated = await api.patch(
      `${API}/patients/${patientA}/emergency-contacts/${emergencyContactId}`,
      { body: { relationship: "Guardian", email: null } },
    );
    expect(updated.status).toBe(200);
    expect(emergencyContactOf(updated)).toMatchObject({
      name: "Margaret Whitfield",
      relationship: "Guardian",
      email: null,
    });

    const deleted = await api.delete(
      `${API}/patients/${patientA}/emergency-contacts/${emergencyContactId}`,
    );
    expect(deleted.status).toBe(204);

    const again = await api.delete(
      `${API}/patients/${patientA}/emergency-contacts/${emergencyContactId}`,
    );
    expect(again.status).toBe(404);
  });

  it("rejects invalid emergency contact payloads and protected fields", async () => {
    const base = `${API}/patients/${patientA}/emergency-contacts`;

    for (const body of [
      {},
      { relationship: "Sister", phone: "+15550001111" },
      { name: "Kin", phone: "+15550001111" },
      { name: "Kin", relationship: "Sister" },
      { name: "Kin", relationship: "Sister", phone: "12" },
      { name: "Kin", relationship: "Sister", phone: "+15550001111", email: "bad" },
      { name: "Kin", relationship: "Sister", phone: "+15550001111", tenantId: randomUUID() },
      {
        name: "Kin",
        relationship: "Sister",
        phone: "+15550001111",
        emergencyContactId: randomUUID(),
      },
    ]) {
      const response = await api.post(base, { body });
      expect(response.status).toBe(422);
      expect(errorCode(response)).toBe("VALIDATION_ERROR");
    }

    const created = await api.post(base, {
      body: { name: "Kin", relationship: "Sister", phone: "+15550005555" },
    });
    expect(created.status).toBe(201);
    const id = emergencyContactOf(created).id;

    const emptyPatch = await api.patch(`${base}/${id}`, { body: {} });
    expect(emptyPatch.status).toBe(422);

    const protectedPatch = await api.patch(`${base}/${id}`, {
      body: { name: "Other", tenantId: randomUUID() },
    });
    expect(protectedPatch.status).toBe(422);

    const malformed = await api.delete(`${base}/not-a-uuid`);
    expect(malformed.status).toBe(422);
  });
});

describe("patient child record access control", () => {
  let contactId: string;
  let addressId: string;
  let emergencyContactId: string;

  beforeAll(async () => {
    const contact = await api.post(`${API}/patients/${patientA}/contacts`, {
      body: { phone: "+15550006001" },
    });
    contactId = contactOf(contact).id;

    const address = await api.post(`${API}/patients/${patientA}/addresses`, {
      body: { addressType: "OTHER", addressLine1: "Ownership Road" },
    });
    addressId = addressOf(address).id;

    const emergency = await api.post(`${API}/patients/${patientA}/emergency-contacts`, {
      body: { name: "Kin", relationship: "Parent", phone: "+15550006002" },
    });
    emergencyContactId = emergencyContactOf(emergency).id;
  });

  it("does not expose one patient's records through another patient", async () => {
    const contacts = await api.patch(
      `${API}/patients/${patientB}/contacts/${contactId}`,
      { body: { phone: "+15550006003" } },
    );
    expect(contacts.status).toBe(404);

    const primary = await api.patch(
      `${API}/patients/${patientB}/contacts/${contactId}/primary`,
    );
    expect(primary.status).toBe(404);

    const removeContact = await api.delete(
      `${API}/patients/${patientB}/contacts/${contactId}`,
    );
    expect(removeContact.status).toBe(404);

    const addresses = await api.patch(
      `${API}/patients/${patientB}/addresses/${addressId}`,
      { body: { city: "Elsewhere" } },
    );
    expect(addresses.status).toBe(404);

    const emergency = await api.patch(
      `${API}/patients/${patientB}/emergency-contacts/${emergencyContactId}`,
      { body: { name: "Hijack" } },
    );
    expect(emergency.status).toBe(404);

    const removeEmergency = await api.delete(
      `${API}/patients/${patientB}/emergency-contacts/${emergencyContactId}`,
    );
    expect(removeEmergency.status).toBe(404);

    // The record is still readable in its true parent.
    const listed = await api.get(`${API}/patients/${patientA}/contacts`);
    expect(
      dataOf<{ contacts: ContactShape[] }>(listed).contacts.some((c) => c.id === contactId),
    ).toBe(true);
  });

  it("isolates child records between tenants", async () => {
    const foreignList = await otherApi.get(`${API}/patients/${patientA}/contacts`);
    expect(foreignList.status).toBe(404);

    const foreignCreate = await otherApi.post(`${API}/patients/${patientA}/contacts`, {
      body: { phone: "+15550006004" },
    });
    expect(foreignCreate.status).toBe(404);

    const crossTenantUpdate = await api.patch(
      `${API}/patients/${foreignPatient}/contacts/${contactId}`,
      { body: { phone: "+15550006005" } },
    );
    expect(crossTenantUpdate.status).toBe(404);

    const crossTenantList = await api.get(`${API}/patients/${foreignPatient}/addresses`);
    expect(crossTenantList.status).toBe(404);

    const crossTenantDelete = await api.delete(
      `${API}/patients/${foreignPatient}/emergency-contacts/${emergencyContactId}`,
    );
    expect(crossTenantDelete.status).toBe(404);

    // Foreign records are not visible in the caller's patient either.
    const linked = await api.get(`${API}/patients/${patientB}/contacts`);
    expect(
      dataOf<{ contacts: ContactShape[] }>(linked).contacts.some((c) => c.id === contactId),
    ).toBe(false);
  });

  it("requires authentication and patient permissions", async () => {
    const anonymous = await createTestApi(createApp());

    try {
      const read = await anonymous.get(`${API}/patients/${patientA}/contacts`);
      expect(read.status).toBe(401);

      const write = await anonymous.post(`${API}/patients/${patientA}/addresses`, {
        body: { addressLine1: "Anonymous Street" },
      });
      expect(write.status).toBe(401);

      const remove = await anonymous.delete(
        `${API}/patients/${patientA}/emergency-contacts/${emergencyContactId}`,
      );
      expect(remove.status).toBe(401);
    } finally {
      await anonymous.close();
    }

    // Authenticated member without patient permissions is denied at the route.
    const readDenied = await unprivilegedApi.get(`${API}/patients/${patientA}/contacts`);
    expect(readDenied.status).toBe(403);

    const createDenied = await unprivilegedApi.post(
      `${API}/patients/${patientA}/contacts`,
      { body: { phone: "+15550006006" } },
    );
    expect(createDenied.status).toBe(403);
    expect(errorCode(createDenied)).toBe("FORBIDDEN");

    const deleteDenied = await unprivilegedApi.delete(
      `${API}/patients/${patientA}/contacts/${contactId}`,
    );
    expect(deleteDenied.status).toBe(403);
  });

  it("does not allow child mutations on an archived patient", async () => {
    const ownContact = await api.post(`${API}/patients/${patientB}/contacts`, {
      body: { phone: "+15550006009" },
    });
    expect(ownContact.status).toBe(201);
    const ownContactId = contactOf(ownContact).id;

    const archived = await api.patch(`${API}/patients/${patientB}/status`, {
      body: { status: "ARCHIVED" },
    });
    expect(archived.status).toBe(200);

    const create = await api.post(`${API}/patients/${patientB}/contacts`, {
      body: { phone: "+15550006007" },
    });
    expect(create.status).toBe(409);

    const update = await api.patch(`${API}/patients/${patientB}/contacts/${ownContactId}`, {
      body: { phone: "+15550006008" },
    });
    expect(update.status).toBe(409);

    const address = await api.post(`${API}/patients/${patientB}/addresses`, {
      body: { addressLine1: "Archived Street" },
    });
    expect(address.status).toBe(409);

    const reactivated = await api.patch(`${API}/patients/${patientB}/status`, {
      body: { status: "ACTIVE" },
    });
    expect(reactivated.status).toBe(200);
  });
});
