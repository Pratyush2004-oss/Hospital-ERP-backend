import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import type { CreatePatientInput, PatientActorContext } from "./patient.types.js";
import {
  createPatient,
  deletePatient,
  getPatientById,
  linkPatientUser,
  listPatients,
  unlinkPatientUser,
  updatePatient,
  updatePatientStatus,
} from "./patient.service.js";

/**
 * Service-level tests for Task 17.2. The service runs as the restricted
 * `hospitalos_app` role inside tenant-scoped transactions (RLS enforced), while
 * fixtures and cleanup use the admin connection - the same split the doctor and
 * scheduling suites use.
 */

interface Fixture {
  readonly tenantId: string;
  /** ACTIVE member of this hospital acting as the caller. */
  readonly actorId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

const LINK_PERMISSION = new Set(["patient:update"]);

async function createUser(label: string): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'patient-service-test-hash')`,
    [id, `${label} User`, `${label}-${id.slice(0, 8)}@patients.test`],
  );

  createdUserIds.push(id);
  return id;
}

async function createMemberUser(tenantId: string, label: string): Promise<string> {
  const userId = await createUser(label);

  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE'::membership_status, now())`,
    [tenantId, userId],
  );

  return userId;
}

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  const actorId = await createMemberUser(tenantId, `${label}-registrar`);
  const fixture = { tenantId, actorId };

  fixtures.push(fixture);
  return fixture;
}

function actor(fixture: Fixture, permissions?: ReadonlySet<string>): PatientActorContext {
  return permissions === undefined
    ? { userId: fixture.actorId }
    : { userId: fixture.actorId, permissions };
}

function newPatient(overrides: Partial<CreatePatientInput> = {}): CreatePatientInput {
  return {
    fullName: "Eleanor Whitfield",
    dateOfBirth: "1958-04-12",
    gender: "FEMALE",
    bloodGroup: "O_POSITIVE",
    maritalStatus: "MARRIED",
    ...overrides,
  };
}

let other: Fixture;

beforeAll(async () => {
  // A second hospital used as the "other tenant" in isolation checks.
  other = await createFixture("beta");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("patient service", () => {
  it("registers a patient without a user account and generates a patient code", async () => {
    const fixture = await createFixture("register");
    const created = await createPatient(
      fixture.tenantId,
      newPatient({
        contacts: [
          {
            contactType: "MOBILE",
            phone: "+1 (555) 010-2030",
            isPrimary: true,
            isVerified: true,
          },
          { contactType: "WORK", email: "Eleanor.Whitfield@Example.test" },
        ],
        addresses: [
          {
            addressType: "HOME",
            addressLine1: "12 Rosewood Lane",
            city: "Springfield",
            country: "us",
            isPrimary: true,
          },
          { addressType: "WORK", addressLine1: "400 Industrial Way" },
        ],
        emergencyContacts: [
          {
            name: "Margaret Whitfield",
            relationship: "Sister",
            phone: "+1-555-010-9999",
            email: "margaret@example.test",
          },
          { name: "Thomas Whitfield", relationship: "Son", phone: "+1-555-010-8888" },
        ],
      }),
      actor(fixture),
    );

    expect(created.patientCode).toMatch(/^P-\d{6}$/);
    expect(created.fullName).toBe("Eleanor Whitfield");
    expect(created.dateOfBirth).toBe("1958-04-12");
    expect(created.gender).toBe("FEMALE");
    expect(created.bloodGroup).toBe("O_POSITIVE");
    expect(created.maritalStatus).toBe("MARRIED");
    expect(created.status).toBe("ACTIVE");
    expect(created.user).toBeNull();

    // Contacts are normalised (phone stripped of formatting, email lower-cased).
    expect(created.contacts).toHaveLength(2);
    expect(created.contacts[0]).toMatchObject({
      contactType: "MOBILE",
      phone: "+15550102030",
      email: null,
      isPrimary: true,
      isVerified: true,
    });
    expect(created.contacts[1]).toMatchObject({
      contactType: "WORK",
      phone: null,
      email: "eleanor.whitfield@example.test",
      isPrimary: false,
    });

    expect(created.addresses).toHaveLength(2);
    expect(created.addresses[0]).toMatchObject({
      addressType: "HOME",
      addressLine1: "12 Rosewood Lane",
      country: "US",
      isPrimary: true,
    });

    expect(created.emergencyContacts).toHaveLength(2);
    expect(created.emergencyContacts[0]).toMatchObject({
      name: "Margaret Whitfield",
      relationship: "Sister",
      phone: "+15550109999",
    });
  });

  it("links an existing account when the actor is authorized", async () => {
    const fixture = await createFixture("link");
    const linkedUser = await createUser("linked");

    const created = await createPatient(
      fixture.tenantId,
      newPatient({ userId: linkedUser }),
      actor(fixture, LINK_PERMISSION),
    );

    expect(created.user).not.toBeNull();
    // Only display identity is exposed; no email, phone or credential columns.
    expect(Object.keys(created.user ?? {}).sort()).toEqual(["fullName", "id", "isActive"]);
    expect(created.user).toMatchObject({ id: linkedUser, isActive: true });
  });

  it("rejects account linking without the update permission", async () => {
    const fixture = await createFixture("unauthorized-link");
    const linkedUser = await createUser("unauthorized");

    await expect(
      createPatient(
        fixture.tenantId,
        newPatient({ userId: linkedUser }),
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a duplicate account link in one tenant but allows another hospital", async () => {
    const fixture = await createFixture("duplicate");
    const linkedUser = await createUser("duplicate");

    await createPatient(
      fixture.tenantId,
      newPatient({ userId: linkedUser }),
      actor(fixture, LINK_PERMISSION),
    );

    await expect(
      createPatient(
        fixture.tenantId,
        newPatient({ fullName: "Duplicate Person", userId: linkedUser }),
        actor(fixture, LINK_PERMISSION),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The same global account may hold a separate profile at another hospital.
    const otherHospital = await createPatient(
      other.tenantId,
      newPatient({ userId: linkedUser }),
      actor(other, LINK_PERMISSION),
    );

    expect(otherHospital.user).toMatchObject({ id: linkedUser });
  });

  it("allocates sequential, unique patient codes under concurrent registration", async () => {
    const fixture = await createFixture("codes");

    const created = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        createPatient(
          fixture.tenantId,
          newPatient({ fullName: `Concurrent Patient ${index}` }),
          actor(fixture),
        ),
      ),
    );

    const codes = created.map((patient) => patient.patientCode);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.sort()).toEqual([
      "P-000001",
      "P-000002",
      "P-000003",
      "P-000004",
      "P-000005",
      "P-000006",
    ]);
  });

  it("honours a tenant-specific patient code format", async () => {
    const fixture = await createFixture("format");

    await getTestAdminPool().query(
      `insert into tenant_settings (tenant_id, setting_key, setting_value)
       values ($1, 'patient.code_format', $2::jsonb)`,
      [fixture.tenantId, JSON.stringify("MRN/{year}/{seq:4}")],
    );

    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    expect(created.patientCode).toMatch(/^MRN\/\d{4}\/0001$/);
  });

  it("lists patients with pagination metadata and excludes soft-deleted rows", async () => {
    const fixture = await createFixture("list");

    for (const name of ["Alice Adams", "Bruno Costa", "Carla Dias"]) {
      await createPatient(fixture.tenantId, newPatient({ fullName: name }), actor(fixture));
    }

    const firstPage = await listPatients(fixture.tenantId, { page: 1, pageSize: 2 });

    expect(firstPage.total).toBe(3);
    expect(firstPage.totalPages).toBe(2);
    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(2);
    expect(firstPage.patients).toHaveLength(2);
    expect(firstPage.patients.map((patient) => patient.fullName)).toEqual([
      "Alice Adams",
      "Bruno Costa",
    ]);
    // List projection is identity-only: no contacts, no documents.
    expect(Object.keys(firstPage.patients[0] ?? {}).sort()).toEqual([
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

    const secondPage = await listPatients(fixture.tenantId, { page: 2, pageSize: 2 });
    expect(secondPage.patients.map((patient) => patient.fullName)).toEqual(["Carla Dias"]);

    const target = firstPage.patients[0];
    if (!target) throw new Error("expected a patient");

    await deletePatient(fixture.tenantId, target.id, actor(fixture));

    const afterDelete = await listPatients(fixture.tenantId, {});
    expect(afterDelete.total).toBe(2);
    expect(afterDelete.patients.some((patient) => patient.id === target.id)).toBe(false);
  });

  it("searches by name, patient code, phone and email", async () => {
    const fixture = await createFixture("search");

    const ada = await createPatient(
      fixture.tenantId,
      newPatient({
        fullName: "Ada Lovelace",
        contacts: [{ phone: "+15550001111", isPrimary: true }],
      }),
      actor(fixture),
    );
    await createPatient(
      fixture.tenantId,
      newPatient({
        fullName: "Grace Hopper",
        contacts: [{ email: "grace@example.test", isPrimary: true }],
      }),
      actor(fixture),
    );

    const byName = await listPatients(fixture.tenantId, { search: "lovelace" });
    expect(byName.patients.map((patient) => patient.id)).toEqual([ada.id]);

    const byCode = await listPatients(fixture.tenantId, { search: ada.patientCode });
    expect(byCode.patients.map((patient) => patient.id)).toEqual([ada.id]);

    const byPhone = await listPatients(fixture.tenantId, { phone: "+1 555 000 1111" });
    expect(byPhone.patients.map((patient) => patient.id)).toEqual([ada.id]);

    const byEmail = await listPatients(fixture.tenantId, { email: "GRACE@example.test" });
    expect(byEmail.patients).toHaveLength(1);
    expect(byEmail.patients[0]?.fullName).toBe("Grace Hopper");

    const noMatch = await listPatients(fixture.tenantId, { phone: "+15559999999" });
    expect(noMatch.total).toBe(0);
  });

  it("filters by status, gender and registration date", async () => {
    const fixture = await createFixture("filters");
    const before = new Date(Date.now() - 60_000);

    const active = await createPatient(
      fixture.tenantId,
      newPatient({ fullName: "Active Male", gender: "MALE" }),
      actor(fixture),
    );
    const inactive = await createPatient(
      fixture.tenantId,
      newPatient({ fullName: "Inactive Female", gender: "FEMALE" }),
      actor(fixture),
    );
    await updatePatientStatus(fixture.tenantId, inactive.id, "INACTIVE");

    const activeOnly = await listPatients(fixture.tenantId, { status: "ACTIVE" });
    expect(activeOnly.patients.map((patient) => patient.id)).toEqual([active.id]);

    const males = await listPatients(fixture.tenantId, { gender: "MALE" });
    expect(males.patients.map((patient) => patient.id)).toEqual([active.id]);

    const recent = await listPatients(fixture.tenantId, { registeredFrom: before });
    expect(recent.total).toBe(2);

    const future = await listPatients(fixture.tenantId, {
      registeredFrom: new Date(Date.now() + 86_400_000),
    });
    expect(future.total).toBe(0);
  });

  it("returns a full detail view for one patient", async () => {
    const fixture = await createFixture("detail");
    const created = await createPatient(
      fixture.tenantId,
      newPatient({
        contacts: [{ phone: "+15550002222", isPrimary: true }],
        addresses: [{ addressLine1: "1 Detail Street", isPrimary: true }],
        emergencyContacts: [{ name: "Kin", relationship: "Parent", phone: "+15550003333" }],
      }),
      actor(fixture),
    );

    const detail = await getPatientById(fixture.tenantId, created.id);

    expect(detail.id).toBe(created.id);
    expect(detail.patientCode).toBe(created.patientCode);
    expect(detail.contacts).toHaveLength(1);
    expect(detail.addresses).toHaveLength(1);
    expect(detail.emergencyContacts).toHaveLength(1);
    expect(detail.user).toBeNull();

    await expect(
      getPatientById(fixture.tenantId, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates only the supplied profile fields", async () => {
    const fixture = await createFixture("update");
    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    const updated = await updatePatient(fixture.tenantId, created.id, {
      fullName: "  Eleanor   Whitfield-Smith ",
      bloodGroup: null,
      maritalStatus: "WIDOWED",
      profileImageKey: "tenants/patients/profile/abc.jpg",
    });

    expect(updated.fullName).toBe("Eleanor Whitfield-Smith");
    expect(updated.bloodGroup).toBeNull();
    expect(updated.maritalStatus).toBe("WIDOWED");
    expect(updated.profileImageKey).toBe("tenants/patients/profile/abc.jpg");
    // Untouched fields keep their value.
    expect(updated.dateOfBirth).toBe("1958-04-12");
    expect(updated.gender).toBe("FEMALE");

    const noop = await updatePatient(fixture.tenantId, created.id, {});
    expect(noop.fullName).toBe(updated.fullName);
  });

  it("rejects invalid profile data", async () => {
    const fixture = await createFixture("invalid");
    const create = (input: CreatePatientInput) =>
      createPatient(fixture.tenantId, input, actor(fixture));

    await expect(create(newPatient({ fullName: "   " }))).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(create(newPatient({ dateOfBirth: "1990-02-31" }))).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(create(newPatient({ dateOfBirth: "2999-01-01" }))).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(
      create(newPatient({ profileImageKey: "https://cdn.example.test/photo.png" })),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(newPatient({ contacts: [{ email: "not-an-email" }] })),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(newPatient({ contacts: [{ phone: "12" }] })),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(newPatient({ contacts: [{ phone: "+15550004444" }, { phone: "+15550004444" }] })),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(
        newPatient({
          contacts: [
            { phone: "+15550005555", isPrimary: true },
            { email: "second@example.test", isPrimary: true },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(
        newPatient({
          addresses: [
            { addressLine1: "One", addressType: "HOME", isPrimary: true },
            { addressLine1: "Two", addressType: "HOME", isPrimary: true },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      create(newPatient({ emergencyContacts: [{ name: "Kin", relationship: "", phone: "+1" }] })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("enforces permitted status transitions", async () => {
    const fixture = await createFixture("status");
    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    expect((await updatePatientStatus(fixture.tenantId, created.id, "INACTIVE")).status).toBe(
      "INACTIVE",
    );
    expect((await updatePatientStatus(fixture.tenantId, created.id, "ACTIVE")).status).toBe(
      "ACTIVE",
    );
    expect((await updatePatientStatus(fixture.tenantId, created.id, "ARCHIVED")).status).toBe(
      "ARCHIVED",
    );

    // Reactivation must go through ACTIVE explicitly.
    await expect(
      updatePatientStatus(fixture.tenantId, created.id, "INACTIVE"),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await updatePatientStatus(fixture.tenantId, created.id, "ACTIVE")).status).toBe(
      "ACTIVE",
    );

    await expect(
      updatePatientStatus(fixture.tenantId, created.id, "DECEASED" as "ACTIVE"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("blocks profile edits while a patient is archived", async () => {
    const fixture = await createFixture("archived");
    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    await updatePatientStatus(fixture.tenantId, created.id, "ARCHIVED");

    await expect(
      updatePatient(fixture.tenantId, created.id, { fullName: "Changed Name" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Archived records remain readable, and reactivation restores editing.
    expect((await getPatientById(fixture.tenantId, created.id)).status).toBe("ARCHIVED");
    await updatePatientStatus(fixture.tenantId, created.id, "ACTIVE");
    expect(
      (await updatePatient(fixture.tenantId, created.id, { fullName: "Changed Name" })).fullName,
    ).toBe("Changed Name");
  });

  it("soft deletes a patient, retains dependent records and stays idempotent", async () => {
    const fixture = await createFixture("delete");
    const created = await createPatient(
      fixture.tenantId,
      newPatient({
        contacts: [{ phone: "+15550006666", isPrimary: true }],
        addresses: [{ addressLine1: "Keep Me Street" }],
        emergencyContacts: [{ name: "Kin", relationship: "Friend", phone: "+15550007777" }],
      }),
      actor(fixture),
    );

    const pool = getTestAdminPool();

    await pool.query(
      `insert into patient_documents
         (id, tenant_id, patient_id, document_type, file_name, storage_key, mime_type, file_size, uploaded_by)
       values ($1, $2, $3, 'IDENTITY_PROOF'::patient_document_type, 'id.pdf', $4, 'application/pdf', 2048, $5)`,
      [
        randomUUID(),
        fixture.tenantId,
        created.id,
        `tenants/${fixture.tenantId}/patients/${created.id}/id.pdf`,
        fixture.actorId,
      ],
    );

    await deletePatient(fixture.tenantId, created.id, actor(fixture));

    await expect(
      getPatientById(fixture.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const listed = await listPatients(fixture.tenantId, {});
    expect(listed.patients.some((patient) => patient.id === created.id)).toBe(false);

    // Nothing is hard deleted: the profile, children and document metadata stay.
    const { rows } = await pool.query<{ deleted_at: Date | null; status: string }>(
      "select deleted_at, status from patient_profiles where id = $1",
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.status).toBe("ARCHIVED");

    const counts = await pool.query<{ contacts: number; addresses: number; emergency: number; documents: number }>(
      `select
         (select count(*)::int from patient_contacts where patient_id = $1) as contacts,
         (select count(*)::int from patient_addresses where patient_id = $1) as addresses,
         (select count(*)::int from patient_emergency_contacts where patient_id = $1) as emergency,
         (select count(*)::int from patient_documents where patient_id = $1) as documents`,
      [created.id],
    );
    expect(counts.rows[0]).toEqual({ contacts: 1, addresses: 1, emergency: 1, documents: 1 });

    // Repeated deletion is a no-op, and the MRN stays reserved.
    await expect(
      deletePatient(fixture.tenantId, created.id, actor(fixture)),
    ).resolves.toBeUndefined();

    const next = await createPatient(fixture.tenantId, newPatient(), actor(fixture));
    expect(next.patientCode).not.toBe(created.patientCode);

    await expect(
      deletePatient(fixture.tenantId, randomUUID(), actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("links and unlinks an account through the dedicated operations", async () => {
    const fixture = await createFixture("account");
    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));
    const linkedUser = await createUser("portal");

    const linked = await linkPatientUser(
      fixture.tenantId,
      created.id,
      linkedUser,
      actor(fixture, LINK_PERMISSION),
    );
    expect(linked.user).toMatchObject({ id: linkedUser });

    await expect(
      linkPatientUser(fixture.tenantId, created.id, linkedUser, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 403 });

    const unlinked = await unlinkPatientUser(
      fixture.tenantId,
      created.id,
      actor(fixture, LINK_PERMISSION),
    );
    expect(unlinked.user).toBeNull();

    // The global account itself is never touched.
    const { rows } = await getTestAdminPool().query(
      "select id from users where id = $1",
      [linkedUser],
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps patients isolated between tenants", async () => {
    const fixture = await createFixture("isolation");
    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    await expect(
      getPatientById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updatePatient(other.tenantId, created.id, { fullName: "Hijacked" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updatePatientStatus(other.tenantId, created.id, "ARCHIVED"),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatient(other.tenantId, created.id, actor(other)),
    ).rejects.toMatchObject({ statusCode: 404 });

    const otherList = await listPatients(other.tenantId, {});
    expect(otherList.patients.some((patient) => patient.id === created.id)).toBe(false);
  });

  it("requires an active membership to register or delete", async () => {
    const fixture = await createFixture("membership");
    const outsider = await createUser("outsider");

    await expect(
      createPatient(fixture.tenantId, newPatient(), { userId: outsider }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const created = await createPatient(fixture.tenantId, newPatient(), actor(fixture));

    await expect(
      deletePatient(fixture.tenantId, created.id, { userId: outsider }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
