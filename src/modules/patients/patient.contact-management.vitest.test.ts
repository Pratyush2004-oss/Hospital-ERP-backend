import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createPatient, deletePatient } from "./patient.service.js";
import {
  addPatientContact,
  deletePatientContact,
  listPatientContacts,
  setPrimaryPatientContact,
  updatePatientContact,
} from "./patient.contacts.service.js";
import {
  addPatientAddress,
  deletePatientAddress,
  listPatientAddresses,
  setPrimaryPatientAddress,
  updatePatientAddress,
} from "./patient.addresses.service.js";
import {
  addPatientEmergencyContact,
  deletePatientEmergencyContact,
  listPatientEmergencyContacts,
  updatePatientEmergencyContact,
} from "./patient.emergency-contacts.service.js";
import type { AddPatientContactInput, PatientActorContext } from "./patient.types.js";

/**
 * Service-level tests for Task 17.3. Services run as the restricted
 * `hospitalos_app` role inside tenant-scoped transactions (RLS enforced);
 * fixtures and direct database assertions use the admin connection.
 */

interface Fixture {
  readonly tenantId: string;
  readonly actorId: string;
  readonly patientId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'patient-contact-test-hash')`,
    [id, `${label} User`, `${label}-${id.slice(0, 8)}@patients.test`],
  );

  createdUserIds.push(id);
  return id;
}

async function createTenant(label: string): Promise<{ tenantId: string; actorId: string }> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  const actorId = await createUser(`${label}-registrar`);

  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1, $2, 'ACTIVE'::membership_status, now())`,
    [tenantId, actorId],
  );

  return { tenantId, actorId };
}

async function setup(label: string): Promise<Fixture> {
  const { tenantId, actorId } = await createTenant(label);
  const patient = await createPatient(
    tenantId,
    { fullName: `${label} Patient` },
    { userId: actorId },
  );
  const fixture = { tenantId, actorId, patientId: patient.id };

  fixtures.push(fixture);
  return fixture;
}

function actor(fixture: Fixture): PatientActorContext {
  return { userId: fixture.actorId };
}

async function contactCount(fixture: Fixture): Promise<number> {
  const { rows } = await getTestAdminPool().query<{ n: number }>(
    `select count(*)::int as n
       from patient_contacts
      where tenant_id = $1 and patient_id = $2 and is_primary`,
    [fixture.tenantId, fixture.patientId],
  );

  return rows[0]?.n ?? 0;
}

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

describe("patient contact management", () => {
  it("adds a phone contact", async () => {
    const fixture = await setup("contact-phone");

    const created = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { contactType: "MOBILE", phone: "+15550102030" },
      actor(fixture),
    );

    expect(created).toMatchObject({
      contactType: "MOBILE",
      phone: "+15550102030",
      email: null,
      isPrimary: false,
      isVerified: false,
    });
  });

  it("adds an email contact", async () => {
    const fixture = await setup("contact-email");

    const created = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { contactType: "WORK", email: "Desk@Example.TEST" },
      actor(fixture),
    );

    expect(created.phone).toBeNull();
    expect(created.email).toBe("desk@example.test");
  });

  it("normalizes phone numbers and email addresses", async () => {
    const fixture = await setup("contact-normalize");

    const phone = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: " +1 (555) 010-9999 " },
      actor(fixture),
    );
    const email = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { email: "  MIXED.Case@Example.Test " },
      actor(fixture),
    );

    expect(phone.phone).toBe("+15550109999");
    expect(email.email).toBe("mixed.case@example.test");
  });

  it("rejects duplicate contact details for the same patient", async () => {
    const fixture = await setup("contact-duplicate");

    await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550101111", email: "dup@example.test" },
      actor(fixture),
    );

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { phone: "+1 555 010 1111" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { email: "DUP@example.test" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects invalid contact input", async () => {
    const fixture = await setup("contact-invalid");

    await expect(
      addPatientContact(fixture.tenantId, fixture.patientId, {}, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { contactType: "PAGER" as "MOBILE", phone: "+15550102222" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { email: "not-an-email" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { phone: "123" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("selects a single primary contact and demotes the previous one", async () => {
    const fixture = await setup("contact-primary");

    const first = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550103001", isPrimary: true },
      actor(fixture),
    );
    const second = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { email: "second@example.test" },
      actor(fixture),
    );

    expect(await contactCount(fixture)).toBe(1);

    const promoted = await setPrimaryPatientContact(
      fixture.tenantId,
      fixture.patientId,
      second.id,
      actor(fixture),
    );

    expect(promoted.isPrimary).toBe(true);
    expect(await contactCount(fixture)).toBe(1);

    const contacts = await listPatientContacts(fixture.tenantId, fixture.patientId);
    expect(contacts[0]?.id).toBe(second.id);
    expect(contacts.find((contact) => contact.id === first.id)?.isPrimary).toBe(false);
  });

  it("prevents multiple primary contacts, including at the database level", async () => {
    const fixture = await setup("contact-multi-primary");

    const first = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550104001", isPrimary: true },
      actor(fixture),
    );
    await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550104002", isPrimary: true },
      actor(fixture),
    );

    expect(await contactCount(fixture)).toBe(1);

    const contacts = await listPatientContacts(fixture.tenantId, fixture.patientId);
    expect(contacts.find((contact) => contact.id === first.id)?.isPrimary).toBe(false);

    // The database itself is the final protection.
    const other = contacts.find((contact) => contact.id !== first.id);

    await expect(
      getTestAdminPool().query(
        "update patient_contacts set is_primary = true where id = $1",
        [first.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    expect(other).toBeDefined();
  });

  it("updates a contact and resets verification when the value changes", async () => {
    const fixture = await setup("contact-update");

    const created = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { contactType: "MOBILE", phone: "+15550105001" },
      actor(fixture),
    );

    // A trusted backend process verifies the number.
    await getTestAdminPool().query(
      "update patient_contacts set is_verified = true where id = $1",
      [created.id],
    );

    const retyped = await updatePatientContact(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      { contactType: "HOME" },
      actor(fixture),
    );
    expect(retyped.contactType).toBe("HOME");
    expect(retyped.isVerified).toBe(true);

    const renumbered = await updatePatientContact(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      { phone: "+1 (555) 010-5002" },
      actor(fixture),
    );

    expect(renumbered.phone).toBe("+15550105002");
    // The verified value is gone, so verification cannot survive.
    expect(renumbered.isVerified).toBe(false);

    await expect(
      updatePatientContact(
        fixture.tenantId,
        fixture.patientId,
        created.id,
        { phone: null, email: null },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("deletes a contact safely", async () => {
    const fixture = await setup("contact-delete");

    const created = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550106001" },
      actor(fixture),
    );

    await deletePatientContact(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      actor(fixture),
    );

    expect(await listPatientContacts(fixture.tenantId, fixture.patientId)).toHaveLength(0);

    await expect(
      deletePatientContact(fixture.tenantId, fixture.patientId, created.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("protects verification flags from client input", async () => {
    const fixture = await setup("contact-verification");

    const withFlag = {
      phone: "+15550107001",
      isVerified: true,
    } as unknown as AddPatientContactInput;

    await expect(
      addPatientContact(fixture.tenantId, fixture.patientId, withFlag, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 403 });

    const created = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550107002" },
      actor(fixture),
    );

    await expect(
      updatePatientContact(
        fixture.tenantId,
        fixture.patientId,
        created.id,
        { isVerified: true } as unknown as AddPatientContactInput,
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    const contacts = await listPatientContacts(fixture.tenantId, fixture.patientId);
    expect(contacts.every((contact) => contact.isVerified === false)).toBe(true);
  });

  it("keeps at most one primary contact under concurrent updates", async () => {
    const fixture = await setup("contact-concurrent");

    const first = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550108001" },
      actor(fixture),
    );
    const second = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550108002" },
      actor(fixture),
    );

    await Promise.all([
      setPrimaryPatientContact(fixture.tenantId, fixture.patientId, first.id, actor(fixture)),
      setPrimaryPatientContact(fixture.tenantId, fixture.patientId, second.id, actor(fixture)),
    ]);

    expect(await contactCount(fixture)).toBe(1);
  });
});

describe("patient address management", () => {
  it("adds multiple addresses and lists them", async () => {
    const fixture = await setup("address-add");

    const home = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      {
        addressType: "HOME",
        addressLine1: "12 Rosewood Lane",
        city: "Springfield",
        country: "us",
        isPrimary: true,
      },
      actor(fixture),
    );
    await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "WORK", addressLine1: "400 Industrial Way" },
      actor(fixture),
    );

    expect(home.country).toBe("US");
    expect(home.isPrimary).toBe(true);

    const addresses = await listPatientAddresses(fixture.tenantId, fixture.patientId);
    expect(addresses).toHaveLength(2);
    expect(addresses[0]?.id).toBe(home.id);
  });

  it("maintains one primary address per category", async () => {
    const fixture = await setup("address-primary");

    const firstHome = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "HOME", addressLine1: "First Home", isPrimary: true },
      actor(fixture),
    );
    const secondHome = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "HOME", addressLine1: "Second Home" },
      actor(fixture),
    );
    const work = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "WORK", addressLine1: "Office", isPrimary: true },
      actor(fixture),
    );

    const promoted = await setPrimaryPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      secondHome.id,
      actor(fixture),
    );
    expect(promoted.isPrimary).toBe(true);

    const addresses = await listPatientAddresses(fixture.tenantId, fixture.patientId);
    const primaries = addresses.filter((address) => address.isPrimary);

    // One primary HOME and one primary WORK.
    expect(primaries).toHaveLength(2);
    expect(primaries.map((address) => address.addressType).sort()).toEqual(["HOME", "WORK"]);
    expect(addresses.find((address) => address.id === firstHome.id)?.isPrimary).toBe(false);
    expect(addresses.find((address) => address.id === work.id)?.isPrimary).toBe(true);
  });

  it("rejects an address change that would create a second primary in a category", async () => {
    const fixture = await setup("address-conflict");

    await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "HOME", addressLine1: "Primary Home", isPrimary: true },
      actor(fixture),
    );
    const work = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "WORK", addressLine1: "Office" },
      actor(fixture),
    );

    await expect(
      updatePatientAddress(
        fixture.tenantId,
        fixture.patientId,
        work.id,
        { addressType: "HOME", isPrimary: true },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updates an address partially", async () => {
    const fixture = await setup("address-update");

    const created = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      {
        addressType: "HOME",
        addressLine1: "Old Line",
        addressLine2: "Apt 1",
        city: "Old City",
        postalCode: "1111",
        country: "US",
      },
      actor(fixture),
    );

    const updated = await updatePatientAddress(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      { city: "New City", addressLine2: null, country: "gb" },
      actor(fixture),
    );

    expect(updated.city).toBe("New City");
    expect(updated.addressLine2).toBeNull();
    expect(updated.country).toBe("GB");
    // Untouched fields are preserved.
    expect(updated.addressLine1).toBe("Old Line");
    expect(updated.postalCode).toBe("1111");

    await expect(
      updatePatientAddress(
        fixture.tenantId,
        fixture.patientId,
        created.id,
        { addressLine1: "   " },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("deletes an address safely", async () => {
    const fixture = await setup("address-delete");

    const created = await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressType: "HOME", addressLine1: "To Remove" },
      actor(fixture),
    );

    await deletePatientAddress(fixture.tenantId, fixture.patientId, created.id, actor(fixture));

    expect(await listPatientAddresses(fixture.tenantId, fixture.patientId)).toHaveLength(0);

    await expect(
      deletePatientAddress(fixture.tenantId, fixture.patientId, created.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("patient emergency contact management", () => {
  it("creates, updates and deletes emergency contacts", async () => {
    const fixture = await setup("emergency");

    const created = await addPatientEmergencyContact(
      fixture.tenantId,
      fixture.patientId,
      {
        name: " Margaret Whitfield ",
        relationship: "Sister",
        phone: "+1-555-010-9999",
        email: "Margaret@Example.TEST",
      },
      actor(fixture),
    );

    expect(created).toMatchObject({
      name: "Margaret Whitfield",
      relationship: "Sister",
      phone: "+15550109999",
      email: "margaret@example.test",
    });

    // Multiple emergency contacts are allowed; none of them is a user account.
    await addPatientEmergencyContact(
      fixture.tenantId,
      fixture.patientId,
      { name: "Thomas Whitfield", relationship: "Son", phone: "+15550108888" },
      actor(fixture),
    );

    const listed = await listPatientEmergencyContacts(fixture.tenantId, fixture.patientId);
    expect(listed).toHaveLength(2);

    const updated = await updatePatientEmergencyContact(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      { relationship: "Aunt", email: null },
      actor(fixture),
    );
    expect(updated.relationship).toBe("Aunt");
    expect(updated.email).toBeNull();
    expect(updated.name).toBe("Margaret Whitfield");

    await deletePatientEmergencyContact(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      actor(fixture),
    );

    expect(await listPatientEmergencyContacts(fixture.tenantId, fixture.patientId)).toHaveLength(
      1,
    );

    await expect(
      deletePatientEmergencyContact(
        fixture.tenantId,
        fixture.patientId,
        created.id,
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects invalid emergency contact values", async () => {
    const fixture = await setup("emergency-invalid");

    await expect(
      addPatientEmergencyContact(
        fixture.tenantId,
        fixture.patientId,
        { name: "Kin", relationship: "Friend", phone: "12" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      addPatientEmergencyContact(
        fixture.tenantId,
        fixture.patientId,
        { name: "Kin", relationship: "", phone: "+15550109999" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      addPatientEmergencyContact(
        fixture.tenantId,
        fixture.patientId,
        { name: "Kin", relationship: "Friend", phone: "+15550109999", email: "nope" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("patient child-record isolation and lifecycle", () => {
  it("rejects cross-tenant access to contacts, addresses and emergency contacts", async () => {
    const owner = await setup("child-owner");
    const stranger = await setup("child-stranger");

    const contact = await addPatientContact(
      owner.tenantId,
      owner.patientId,
      { phone: "+15550109001" },
      actor(owner),
    );
    const address = await addPatientAddress(
      owner.tenantId,
      owner.patientId,
      { addressLine1: "Owner Home" },
      actor(owner),
    );
    const emergency = await addPatientEmergencyContact(
      owner.tenantId,
      owner.patientId,
      { name: "Kin", relationship: "Friend", phone: "+15550109002" },
      actor(owner),
    );

    // The other hospital cannot even see the patient.
    await expect(
      addPatientContact(stranger.tenantId, owner.patientId, { phone: "+15550109003" }, actor(stranger)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updatePatientContact(
        stranger.tenantId,
        owner.patientId,
        contact.id,
        { phone: "+15550109004" },
        actor(stranger),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      setPrimaryPatientAddress(stranger.tenantId, owner.patientId, address.id, actor(stranger)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatientContact(stranger.tenantId, owner.patientId, contact.id, actor(stranger)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatientEmergencyContact(
        stranger.tenantId,
        owner.patientId,
        emergency.id,
        actor(stranger),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Correct tenant but another patient's child record is also not found.
    await expect(
      deletePatientContact(stranger.tenantId, stranger.patientId, contact.id, actor(stranger)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The owner's records are untouched.
    expect(await listPatientContacts(owner.tenantId, owner.patientId)).toHaveLength(1);
    expect(await listPatientAddresses(owner.tenantId, owner.patientId)).toHaveLength(1);
    expect(
      await listPatientEmergencyContacts(owner.tenantId, owner.patientId),
    ).toHaveLength(1);
  });

  it("blocks child-record changes for a deleted patient", async () => {
    const fixture = await setup("child-deleted");

    const contact = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+15550110001" },
      actor(fixture),
    );

    await deletePatient(fixture.tenantId, fixture.patientId, actor(fixture));

    await expect(
      addPatientContact(fixture.tenantId, fixture.patientId, { phone: "+15550110002" }, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      addPatientAddress(
        fixture.tenantId,
        fixture.patientId,
        { addressLine1: "After Delete" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      addPatientEmergencyContact(
        fixture.tenantId,
        fixture.patientId,
        { name: "Kin", relationship: "Friend", phone: "+15550110003" },
        actor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      listPatientContacts(fixture.tenantId, fixture.patientId),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatientContact(fixture.tenantId, fixture.patientId, contact.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("requires an active membership when the caller is supplied", async () => {
    const fixture = await setup("child-membership");
    const outsider = await createUser("child-outsider");

    await expect(
      addPatientContact(
        fixture.tenantId,
        fixture.patientId,
        { phone: "+15550111001" },
        { userId: outsider },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
