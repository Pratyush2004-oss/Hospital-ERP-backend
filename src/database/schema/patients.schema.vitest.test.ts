import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { closePool } from "../connection.js";
import { withTenantTransaction } from "../context.js";
import {
  patientAddresses,
  patientContacts,
  patientDocuments,
  patientEmergencyContacts,
  patientProfiles,
} from "./index.js";

/**
 * Schema-level tests for Task 17.1 (patient foundation).
 *
 * Every write runs through `withTenantTransaction`, i.e. as the restricted
 * `hospitalos_app` role inside tenant-local RLS context. Fixtures (tenants and
 * users) use the admin connection, matching the doctor and scheduling schema
 * suites.
 */

interface Fixture {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly userId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'schema-test-not-a-real-hash')`,
    [id, `Patient ${label}`, `${label}-${id.slice(0, 8)}@patient-schema.test`],
  );
  createdUserIds.push(id);
  return id;
}

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = await createUser(`${label}-patient`);

  await pool.query(
    `insert into tenants (id, name, slug)
     values ($1, $2, $3), ($4, $5, $6)`,
    [
      tenantId,
      `${label} Hospital`,
      `${label}-${suffix}`,
      otherTenantId,
      `${label} Other Hospital`,
      `${label}-other-${suffix}`,
    ],
  );

  const fixture = { tenantId, otherTenantId, userId };
  fixtures.push(fixture);
  return fixture;
}

/** Walks Drizzle's error `cause` chain to the underlying PostgreSQL SQLSTATE. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(sqlState(error)).toBe(code);
    return;
  }

  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}

function profileValues(
  tenantId: string,
  overrides: Partial<typeof patientProfiles.$inferInsert> = {},
): typeof patientProfiles.$inferInsert {
  const suffix = randomUUID().slice(0, 8);

  return {
    tenantId,
    patientCode: `P-${suffix}`,
    fullName: `Patient ${suffix}`,
    ...overrides,
  };
}

let alpha: Fixture;

beforeAll(async () => {
  alpha = await createFixture("alpha");
  await createFixture("beta");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
    await pool.query("delete from tenants where id = $1", [fixture.otherTenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("patient profile schema", () => {
  it("stores demographics, defaults, optional privacy fields and timestamps", async () => {
    const fixture = await createFixture("profile");

    const [minimal] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    expect(minimal).toMatchObject({
      tenantId: fixture.tenantId,
      userId: null,
      gender: "UNKNOWN",
      status: "ACTIVE",
      maritalStatus: null,
      profileImageKey: null,
      bloodGroup: null,
      dateOfBirth: null,
      deletedAt: null,
    });
    expect(minimal?.createdAt).toBeInstanceOf(Date);
    expect(minimal?.updatedAt).toBeInstanceOf(Date);

    const [detailed] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientProfiles)
        .values(
          profileValues(fixture.tenantId, {
            userId: fixture.userId,
            fullName: "Eleanor Whitfield",
            dateOfBirth: "1958-04-12",
            gender: "FEMALE",
            bloodGroup: "O_POSITIVE",
            maritalStatus: "WIDOWED",
            profileImageKey: `tenants/${fixture.tenantId}/patients/photo.webp`,
          }),
        )
        .returning(),
    );

    expect(detailed).toMatchObject({
      userId: fixture.userId,
      fullName: "Eleanor Whitfield",
      dateOfBirth: "1958-04-12",
      gender: "FEMALE",
      bloodGroup: "O_POSITIVE",
      maritalStatus: "WIDOWED",
    });
    expect(detailed?.profileImageKey).toContain(`tenants/${fixture.tenantId}/`);

    // Credentials never live on the patient record.
    const columnNames = Object.values(getTableColumns(patientProfiles)).map(
      (column) => column.name,
    );
    expect(columnNames).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/password|credential|token|secret/i)]),
    );
  });

  it("keeps patient codes unique per tenant and reserved after soft delete", async () => {
    const fixture = await createFixture("patient-code");
    const code = `P-${randomUUID().slice(0, 8)}`;

    const [existing] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientProfiles)
        .values(profileValues(fixture.tenantId, { patientCode: code }))
        .returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx
            .insert(patientProfiles)
            .values(profileValues(fixture.tenantId, { patientCode: code })),
        ),
      "23505",
    );

    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .update(patientProfiles)
        .set({ deletedAt: new Date(), status: "ARCHIVED" })
        .where(eq(patientProfiles.id, existing!.id)),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx
            .insert(patientProfiles)
            .values(profileValues(fixture.tenantId, { patientCode: code })),
        ),
      "23505",
    );

    // Another hospital may issue the very same MRN independently.
    const [otherHospital] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx
        .insert(patientProfiles)
        .values(profileValues(fixture.otherTenantId, { patientCode: code }))
        .returning(),
    );
    expect(otherHospital?.tenantId).toBe(fixture.otherTenantId);
  });

  it("supports optional user linkage, one per tenant, many across tenants", async () => {
    const fixture = await createFixture("user-link");

    const [linked] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientProfiles)
        .values(profileValues(fixture.tenantId, { userId: fixture.userId }))
        .returning(),
    );
    expect(linked?.userId).toBe(fixture.userId);

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx
            .insert(patientProfiles)
            .values(profileValues(fixture.tenantId, { userId: fixture.userId })),
        ),
      "23505",
    );

    // The same global account may hold an independent patient profile elsewhere.
    const [otherHospital] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx
        .insert(patientProfiles)
        .values(profileValues(fixture.otherTenantId, { userId: fixture.userId }))
        .returning(),
    );
    expect(otherHospital?.userId).toBe(fixture.userId);

    // Unlinked profiles coexist freely.
    const [anonymous] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );
    expect(anonymous?.userId).toBeNull();
  });

  it("rejects future birth dates", async () => {
    const fixture = await createFixture("birth-date");

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientProfiles).values(
            profileValues(fixture.tenantId, {
              dateOfBirth: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
            }),
          ),
        ),
      "23514",
    );
  });
});

describe("patient contact schema", () => {
  it("supports multiple contacts with one primary row", async () => {
    const fixture = await createFixture("contacts");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    const inserted = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientContacts)
        .values([
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            contactType: "MOBILE",
            phone: "+1-555-0101",
            email: "Primary@Example.test",
            isPrimary: true,
          },
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            contactType: "HOME",
            phone: "+1-555-0102",
          },
        ])
        .returning(),
    );

    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ isPrimary: true, isVerified: false });

    // A second primary contact for the same patient is rejected.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientContacts).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            phone: "+1-555-0103",
            isPrimary: true,
          }),
        ),
      "23505",
    );
  });

  it("prevents duplicate phone numbers and case-insensitive duplicate emails", async () => {
    const fixture = await createFixture("contact-duplicates");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientContacts).values({
        tenantId: fixture.tenantId,
        patientId: patient!.id,
        phone: "+1-555-0201",
        email: "Duplicate@Example.test",
      }),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientContacts).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            phone: "+1-555-0201",
          }),
        ),
      "23505",
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientContacts).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            email: "duplicate@example.test",
          }),
        ),
      "23505",
    );

    // The same phone/email may identify a different patient: they are not
    // global identifiers.
    const [anotherPatient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );
    const shared = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientContacts)
        .values({
          tenantId: fixture.tenantId,
          patientId: anotherPatient!.id,
          phone: "+1-555-0201",
          email: "duplicate@example.test",
        })
        .returning(),
    );
    expect(shared).toHaveLength(1);
  });

  it("requires at least one reachable value and a same-tenant patient", async () => {
    const fixture = await createFixture("contact-checks");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientContacts).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
          }),
        ),
      "23514",
    );

    const [foreignPatient] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.otherTenantId)).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientContacts).values({
            tenantId: fixture.tenantId,
            patientId: foreignPatient!.id,
            phone: "+1-555-0301",
          }),
        ),
      "23503",
    );
  });
});

describe("patient address schema", () => {
  it("supports multiple addresses and one primary per category", async () => {
    const fixture = await createFixture("addresses");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    const inserted = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientAddresses)
        .values([
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            addressLine1: "12 Maple Street",
            city: "Springfield",
            postalCode: "62701",
            country: "US",
            isPrimary: true,
          },
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            addressType: "WORK",
            addressLine1: "500 Office Park",
            city: "Springfield",
            country: "US",
            isPrimary: true,
          },
        ])
        .returning(),
    );

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.addressType).toBe("HOME");
    expect(inserted[1]?.addressType).toBe("WORK");

    // Only one primary HOME address per patient.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientAddresses).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            addressLine1: "Second home",
            isPrimary: true,
          }),
        ),
      "23505",
    );

    // A non-primary address in another category is always allowed.
    const [otherAddress] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientAddresses)
        .values({
          tenantId: fixture.tenantId,
          patientId: patient!.id,
          addressLine1: "Uncategorised",
          addressType: "OTHER",
        })
        .returning(),
    );
    expect(otherAddress?.isPrimary).toBe(false);
  });

  it("rejects a cross-tenant patient reference", async () => {
    const fixture = await createFixture("address-cross-tenant");
    const [foreignPatient] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.otherTenantId)).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientAddresses).values({
            tenantId: fixture.tenantId,
            patientId: foreignPatient!.id,
            addressLine1: "1 Wrong Street",
          }),
        ),
      "23503",
    );
  });
});

describe("patient emergency contact schema", () => {
  it("supports several contacts with optional email", async () => {
    const fixture = await createFixture("emergency");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    const inserted = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientEmergencyContacts)
        .values([
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            name: "Thomas Whitfield",
            relationship: "SPOUSE",
            phone: "+1-555-0401",
            email: "thomas@example.test",
          },
          {
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            name: "Grace Chen",
            relationship: "PARENT",
            phone: "+1-555-0402",
          },
        ])
        .returning(),
    );

    expect(inserted).toHaveLength(2);
    expect(inserted[1]?.email).toBeNull();

    const [foreignPatient] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.otherTenantId)).returning(),
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientEmergencyContacts).values({
            tenantId: fixture.tenantId,
            patientId: foreignPatient!.id,
            name: "Foreign",
            relationship: "OTHER",
            phone: "+1-555-0403",
          }),
        ),
      "23503",
    );
  });
});

describe("patient document metadata schema", () => {
  it("stores private metadata, enforces size and soft delete", async () => {
    const fixture = await createFixture("documents");
    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    const storageKey = `tenants/${fixture.tenantId}/patients/${patient!.id}/${randomUUID()}.pdf`;
    const [document] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(patientDocuments)
        .values({
          tenantId: fixture.tenantId,
          patientId: patient!.id,
          documentType: "IDENTITY_PROOF",
          fileName: "passport.pdf",
          storageKey,
          mimeType: "application/pdf",
          fileSize: 2048,
          uploadedBy: fixture.userId,
        })
        .returning(),
    );

    expect(document).toMatchObject({
      storageKey,
      fileName: "passport.pdf",
      mimeType: "application/pdf",
      fileSize: 2048,
      uploadedBy: fixture.userId,
      deletedAt: null,
    });
    // Metadata only: no public URL column exists.
    const columns = Object.values(getTableColumns(patientDocuments)).map((c) => c.name);
    expect(columns).not.toContain("url");
    expect(columns).not.toContain("public_url");

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientDocuments).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            documentType: "OTHER",
            fileName: "empty.pdf",
            storageKey: `${storageKey}-2`,
            mimeType: "application/pdf",
            fileSize: 0,
          }),
        ),
      "23514",
    );

    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(patientDocuments).values({
            tenantId: fixture.tenantId,
            patientId: patient!.id,
            documentType: "OTHER",
            fileName: "duplicate.pdf",
            storageKey,
            mimeType: "application/pdf",
            fileSize: 10,
          }),
        ),
      "23505",
    );

    const [softDeleted] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .update(patientDocuments)
        .set({ deletedAt: new Date() })
        .where(eq(patientDocuments.id, document!.id))
        .returning(),
    );
    expect(softDeleted?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("patient tenant isolation", () => {
  it("hides all patient child rows from another tenant (RLS)", async () => {
    const fixture = await createFixture("rls");

    const [patient] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(patientProfiles).values(profileValues(fixture.tenantId)).returning(),
    );

    await withTenantTransaction(fixture.tenantId, async (tx) => {
      await tx.insert(patientContacts).values({
        tenantId: fixture.tenantId,
        patientId: patient!.id,
        phone: "+1-555-0501",
      });
      await tx.insert(patientAddresses).values({
        tenantId: fixture.tenantId,
        patientId: patient!.id,
        addressLine1: "9 RLS Road",
        isPrimary: true,
      });
      await tx.insert(patientEmergencyContacts).values({
        tenantId: fixture.tenantId,
        patientId: patient!.id,
        name: "RLS Contact",
        relationship: "FRIEND",
        phone: "+1-555-0502",
      });
      await tx.insert(patientDocuments).values({
        tenantId: fixture.tenantId,
        patientId: patient!.id,
        documentType: "CONSENT",
        fileName: "consent.pdf",
        storageKey: `tenants/${fixture.tenantId}/patients/${patient!.id}/consent.pdf`,
        mimeType: "application/pdf",
        fileSize: 100,
      });
    });

    const foreignCounts = await withTenantTransaction(fixture.otherTenantId, async (tx) => ({
      profiles: (await tx.select({ id: patientProfiles.id }).from(patientProfiles)).length,
      contacts: (await tx.select({ id: patientContacts.id }).from(patientContacts)).length,
      addresses: (await tx.select({ id: patientAddresses.id }).from(patientAddresses)).length,
      emergency: (
        await tx.select({ id: patientEmergencyContacts.id }).from(patientEmergencyContacts)
      ).length,
      documents: (await tx.select({ id: patientDocuments.id }).from(patientDocuments)).length,
    }));

    expect(foreignCounts).toEqual({
      profiles: 0,
      contacts: 0,
      addresses: 0,
      emergency: 0,
      documents: 0,
    });

    // Cross-tenant updates affect no rows.
    const crossUpdate = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx
        .update(patientProfiles)
        .set({ fullName: "Hijacked" })
        .where(eq(patientProfiles.id, patient!.id))
        .returning({ id: patientProfiles.id }),
    );
    expect(crossUpdate).toHaveLength(0);

    // Cross-tenant insert is rejected by the RLS WITH CHECK.
    await expect(
      withTenantTransaction(fixture.otherTenantId, (tx) =>
        tx.insert(patientContacts).values({
          tenantId: fixture.tenantId,
          patientId: patient!.id,
          phone: "+1-555-0503",
        }),
      ),
    ).rejects.toThrow();
  });

  it("runs as a restricted role with forced RLS on every patient table", async () => {
    // The admin fixture connection is intentionally privileged; the API role
    // used by withTenantTransaction must not be.
    const restricted = await withTenantTransaction(alpha.tenantId, (tx) =>
      tx.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      ),
    );
    expect(restricted.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });

    const { rows } = await getTestAdminPool().query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in (
         'patient_profiles', 'patient_contacts', 'patient_addresses',
         'patient_emergency_contacts', 'patient_documents'
       )`,
    );

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("applies the migration and exposes the reviewed columns and indexes", async () => {
    const pool = getTestAdminPool();

    const expectedColumns: Record<string, string[]> = {
      patient_profiles: Object.values(getTableColumns(patientProfiles)).map((c) => c.name),
      patient_contacts: Object.values(getTableColumns(patientContacts)).map((c) => c.name),
      patient_addresses: Object.values(getTableColumns(patientAddresses)).map((c) => c.name),
      patient_emergency_contacts: Object.values(getTableColumns(patientEmergencyContacts)).map(
        (c) => c.name,
      ),
      patient_documents: Object.values(getTableColumns(patientDocuments)).map((c) => c.name),
    };

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [table],
      );
      expect(rows.map((row) => row.column_name).sort()).toEqual([...columns].sort());
    }

    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and tablename in (
           'patient_profiles', 'patient_contacts', 'patient_addresses',
           'patient_emergency_contacts', 'patient_documents'
         )`,
    );
    const indexNames = new Set(indexRows.map((row) => row.indexname));

    for (const name of [
      "patient_profiles_tenant_code_unique",
      "patient_profiles_tenant_user_unique",
      "patient_contacts_primary_unique",
      "patient_contacts_patient_phone_unique",
      "patient_contacts_patient_email_unique",
      "patient_addresses_primary_unique",
      "patient_addresses_patient_type_idx",
      "patient_emergency_contacts_patient_idx",
      "patient_documents_storage_key_unique",
    ]) {
      expect(indexNames).toContain(name);
    }

    const journal = JSON.parse(
      readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: unknown[] };
    const { rows: appliedRows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(Number(appliedRows[0]?.count)).toBe(journal.entries.length);

    // Existing modules remain intact.
    const { rows: legacyRows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public'
         and table_name in ('patients_placeholder_unused', 'doctors', 'doctor_schedules', 'doctor_leaves')`,
    );
    expect(Number(legacyRows[0]?.count)).toBe(3);
  });
});
