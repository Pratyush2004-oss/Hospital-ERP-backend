import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { patientProfiles } from "../../database/schema/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import {
  HOSPITAL_ROLE_DEFINITIONS,
  PERMISSION_CATALOGUE,
} from "../rbac/rbac.catalogue.js";
import type { PatientAuditDetails, PatientAuditEvent } from "./patient.audit.js";
import { getPatientDocuments } from "./patient.document.service.js";
import {
  addPatientAddress,
  deletePatientAddress,
  setPrimaryPatientAddress,
  updatePatientAddress,
} from "./patient.addresses.service.js";
import {
  addPatientContact,
  deletePatientContact,
  setPrimaryPatientContact,
  updatePatientContact,
} from "./patient.contacts.service.js";
import {
  addPatientEmergencyContact,
  deletePatientEmergencyContact,
  updatePatientEmergencyContact,
} from "./patient.emergency-contacts.service.js";
import {
  createPatient,
  deletePatient,
  getPatientById,
  listPatients,
  updatePatient,
  updatePatientStatus,
} from "./patient.service.js";
import type { PatientActorContext } from "./patient.types.js";

/**
 * Task 17.7 security verification for the patient module.
 *
 * Covered here, at the service layer where every policy is enforced:
 * - audit events for profile and child-record mutations (actor, tenant, target,
 *   changed field NAMES only - never patient values);
 * - least-privilege document permissions, separate from generic patient ones;
 * - tenant-scoped RLS through the restricted application role, including
 *   transaction-local tenant context not leaking across pooled connections;
 * - soft-deleted patients being unreachable for profile, child and document
 *   reads.
 *
 * HTTP-level RBAC and cross-tenant behaviour is covered by
 * `patient.routes.vitest.test.ts` and
 * `patient.contact-management.routes.vitest.test.ts`; table/RLS coverage is in
 * `database/schema/patients.schema.vitest.test.ts`.
 */

const PATIENT_PERMISSIONS = new Set(["patient:read", "patient:create", "patient:update", "patient:delete"]);
const DOCUMENT_PERMISSIONS = new Set([
  "patient:document:read",
  "patient:document:upload",
  "patient:document:delete",
]);

interface AuditEntry {
  readonly event: PatientAuditEvent;
  readonly details?: PatientAuditDetails;
}

function createAuditSink(): {
  readonly entries: AuditEntry[];
  record(event: PatientAuditEvent, details?: PatientAuditDetails): void;
} {
  const entries: AuditEntry[] = [];

  return {
    entries,
    record(event, details) {
      entries.push({ event, details });
    },
  };
}

interface TenantFixture {
  readonly tenantId: string;
  readonly actorId: string;
  readonly patientId: string;
}

const fixtures: TenantFixture[] = [];
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'patient-security-test-hash')`,
    [id, `${label} User`, `${label}-${id.slice(0, 8)}@security.test`],
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

function actorOf(fixture: { actorId: string }, audit?: PatientActorContext["audit"]): PatientActorContext {
  return { userId: fixture.actorId, permissions: PATIENT_PERMISSIONS, audit };
}

async function setup(label: string): Promise<TenantFixture> {
  const { tenantId, actorId } = await createTenant(label);
  const patient = await createPatient(
    tenantId,
    { fullName: `${label} Patient` },
    { userId: actorId, permissions: PATIENT_PERMISSIONS },
  );
  const fixture = { tenantId, actorId, patientId: patient.id };

  fixtures.push(fixture);
  return fixture;
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

describe("patient audit logging", () => {
  it("records profile lifecycle events with actor, tenant and target only", async () => {
    const fixture = await setup("audit-profile");
    const audit = createAuditSink();
    const actor = actorOf(fixture, audit);

    await updatePatient(
      fixture.tenantId,
      fixture.patientId,
      { fullName: "Audit Nightingale" },
      actor,
    );
    await updatePatientStatus(fixture.tenantId, fixture.patientId, "INACTIVE", actor);
    await updatePatientStatus(fixture.tenantId, fixture.patientId, "ACTIVE", actor);
    await deletePatient(fixture.tenantId, fixture.patientId, actor);

    const events = audit.entries.map((entry) => entry.event);
    expect(events).toEqual([
      "patient.updated",
      "patient.status_changed",
      "patient.status_changed",
      "patient.deleted",
    ]);

    const updated = audit.entries[0]?.details;
    expect(updated).toMatchObject({
      tenantId: fixture.tenantId,
      actorUserId: fixture.actorId,
      patientId: fixture.patientId,
      fields: ["fullName"],
    });
    // Field names, never submitted values.
    expect(JSON.stringify(audit.entries)).not.toContain("Audit Nightingale");

    expect(audit.entries[1]?.details).toMatchObject({ from: "ACTIVE", to: "INACTIVE" });
    expect(audit.entries[2]?.details).toMatchObject({ from: "INACTIVE", to: "ACTIVE" });
    expect(audit.entries[3]?.details).toMatchObject({ from: "ACTIVE", to: "ARCHIVED" });

    for (const entry of audit.entries) {
      expect(entry.details?.tenantId).toBe(fixture.tenantId);
      expect(entry.details?.actorUserId).toBe(fixture.actorId);
      expect(entry.details?.patientId).toBe(fixture.patientId);
    }
  });

  it("records registration and child-record changes without patient values", async () => {
    const { tenantId, actorId } = await createTenant("audit-children");
    const audit = createAuditSink();
    const actor = actorOf({ actorId }, audit);

    const patient = await createPatient(
      tenantId,
      {
        fullName: "Audit Nightingale",
        contacts: [{ phone: "+1 555 010 7788", email: "audit.nightingale@example.test" }],
        addresses: [{ addressLine1: "77 Hidden Lane", country: "IN" }],
        emergencyContacts: [
          { name: "Kin Person", relationship: "Sister", phone: "+1 555 010 8899" },
        ],
      },
      actor,
    );

    fixtures.push({ tenantId, actorId, patientId: patient.id });

    expect(audit.entries.map((entry) => entry.event)).toEqual(["patient.created"]);

    const contact = await addPatientContact(
      tenantId,
      patient.id,
      { phone: "+1 555 010 1234" },
      actor,
    );
    await updatePatientContact(tenantId, patient.id, contact.id, { contactType: "WORK" }, actor);
    await setPrimaryPatientContact(tenantId, patient.id, contact.id, actor);
    await deletePatientContact(tenantId, patient.id, contact.id, actor);

    const address = await addPatientAddress(
      tenantId,
      patient.id,
      { addressLine1: "1 Audit Street", country: "IN" },
      actor,
    );
    await updatePatientAddress(tenantId, patient.id, address.id, { city: "Pune" }, actor);
    await setPrimaryPatientAddress(tenantId, patient.id, address.id, actor);
    await deletePatientAddress(tenantId, patient.id, address.id, actor);

    const emergency = await addPatientEmergencyContact(
      tenantId,
      patient.id,
      { name: "Kin Person", relationship: "Brother", phone: "+1 555 010 5678" },
      actor,
    );
    await updatePatientEmergencyContact(
      tenantId,
      patient.id,
      emergency.id,
      { relationship: "Cousin" },
      actor,
    );
    await deletePatientEmergencyContact(tenantId, patient.id, emergency.id, actor);

    expect(audit.entries.map((entry) => entry.event)).toEqual([
      "patient.created",
      "patient_contact.created",
      "patient_contact.updated",
      "patient_contact.primary_changed",
      "patient_contact.deleted",
      "patient_address.created",
      "patient_address.updated",
      "patient_address.primary_changed",
      "patient_address.deleted",
      "patient_emergency_contact.created",
      "patient_emergency_contact.updated",
      "patient_emergency_contact.deleted",
    ]);

    for (const entry of audit.entries) {
      expect(entry.details?.tenantId).toBe(tenantId);
      expect(entry.details?.actorUserId).toBe(actorId);
      expect(entry.details?.patientId).toBe(patient.id);
    }

    // No PII or child values in audit details.
    const serialized = JSON.stringify(audit.entries);
    for (const value of [
      "Audit Nightingale",
      "5550107788",
      "audit.nightingale@example.test",
      "Hidden Lane",
      "Kin Person",
      "5550108899",
      "Pune",
    ]) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe("patient document least privilege", () => {
  it("keeps sensitive document permissions separate from generic patient ones", () => {
    const keys = new Set<string>(PERMISSION_CATALOGUE.map((permission) => permission.key));
    expect(keys.has("patient:document:read")).toBe(true);
    expect(keys.has("patient:document:upload")).toBe(true);
    expect(keys.has("patient:document:delete")).toBe(true);

    const role = (slug: string): Set<string> =>
      new Set<string>(
        HOSPITAL_ROLE_DEFINITIONS.find((definition) => definition.slug === slug)?.permissions ?? [],
      );

    // Full administrative roles manage documents explicitly.
    for (const permission of ["patient:document:read", "patient:document:upload", "patient:document:delete"]) {
      expect(role("hospital_admin").has(permission)).toBe(true);
      expect(role("branch_admin").has(permission)).toBe(true);
    }

    // Front desk and nursing may attach and read, never delete.
    for (const slug of ["receptionist", "nurse"]) {
      expect(role(slug).has("patient:document:read")).toBe(true);
      expect(role(slug).has("patient:document:upload")).toBe(true);
      expect(role(slug).has("patient:document:delete")).toBe(false);
    }

    // Clinical read-only access.
    expect(role("doctor").has("patient:document:read")).toBe(true);
    expect(role("doctor").has("patient:document:upload")).toBe(false);
    expect(role("doctor").has("patient:document:delete")).toBe(false);

    // Roles with patient:read but no clinical need for identity documents.
    for (const slug of ["accountant", "pharmacist", "lab_technician"]) {
      expect(role(slug).has("patient:read")).toBe(true);
      for (const permission of keys) {
        if (permission.startsWith("patient:document:")) {
          expect(role(slug).has(permission)).toBe(false);
        }
      }
    }
  });

  it("denies document reads to a caller with patient permissions but no document grant", async () => {
    const fixture = await setup("document-least-privilege");

    await expect(
      getPatientDocuments(fixture.tenantId, fixture.patientId, {
        userId: fixture.actorId,
        permissions: PATIENT_PERMISSIONS,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      getPatientDocuments(fixture.tenantId, fixture.patientId, {
        userId: fixture.actorId,
        permissions: DOCUMENT_PERMISSIONS,
      }),
    ).resolves.toEqual([]);
  });

  it("seeds the document permissions into the database catalogue", async () => {
    const { rows } = await getTestAdminPool().query<{ permission_key: string }>(
      "select permission_key from permissions where permission_key like 'patient:document:%' order by permission_key",
    );

    expect(rows.map((row) => row.permission_key)).toEqual([
      "patient:document:delete",
      "patient:document:read",
      "patient:document:upload",
    ]);
  });
});

describe("patient tenant isolation and RLS", () => {
  it("scopes reads to the transaction tenant and resets context on the pool", async () => {
    const first = await setup("rls-first");
    const second = await setup("rls-second");

    const firstView = await withTenantTransaction(first.tenantId, async (tx) => {
      const own = await tx
        .select({ id: patientProfiles.id })
        .from(patientProfiles)
        .where(sql`${patientProfiles.id} = ${first.patientId}`);
      const foreign = await tx
        .select({ id: patientProfiles.id })
        .from(patientProfiles)
        .where(sql`${patientProfiles.id} = ${second.patientId}`);

      return { own: own.length, foreign: foreign.length };
    });

    expect(firstView).toEqual({ own: 1, foreign: 0 });

    // A pooled connection with no transaction context reads nothing, proving
    // the tenant GUC did not survive the transaction.
    const unscoped = await getPool().query<{ n: number }>(
      "select count(*)::int as n from patient_profiles",
    );
    expect(unscoped.rows[0]?.n).toBe(0);
  });

  it("keeps tenant context isolated across concurrent transactions", async () => {
    const first = await setup("rls-concurrent-a");
    const second = await setup("rls-concurrent-b");

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const [firstCounts, secondCounts] = await Promise.all([
      withTenantTransaction(first.tenantId, async (tx) => {
        await sleep(75);
        const own = await tx
          .select({ id: patientProfiles.id })
          .from(patientProfiles)
          .where(sql`${patientProfiles.id} = ${first.patientId}`);
        const foreign = await tx
          .select({ id: patientProfiles.id })
          .from(patientProfiles)
          .where(sql`${patientProfiles.id} = ${second.patientId}`);

        return { own: own.length, foreign: foreign.length };
      }),
      withTenantTransaction(second.tenantId, async (tx) => {
        const own = await tx
          .select({ id: patientProfiles.id })
          .from(patientProfiles)
          .where(sql`${patientProfiles.id} = ${second.patientId}`);
        const foreign = await tx
          .select({ id: patientProfiles.id })
          .from(patientProfiles)
          .where(sql`${patientProfiles.id} = ${first.patientId}`);

        return { own: own.length, foreign: foreign.length };
      }),
    ]);

    expect(firstCounts).toEqual({ own: 1, foreign: 0 });
    expect(secondCounts).toEqual({ own: 1, foreign: 0 });
  });

  it("hides child records and documents from another tenant", async () => {
    const owner = await setup("tenant-owner");
    const stranger = await setup("tenant-stranger");
    const strangerActor = actorOf(stranger);

    await addPatientContact(
      owner.tenantId,
      owner.patientId,
      { phone: "+1 555 010 2211" },
      actorOf(owner),
    );
    await addPatientAddress(
      owner.tenantId,
      owner.patientId,
      { addressLine1: "9 Private Road", country: "IN" },
      actorOf(owner),
    );
    await addPatientEmergencyContact(
      owner.tenantId,
      owner.patientId,
      { name: "Kin Person", relationship: "Mother", phone: "+1 555 010 3322" },
      actorOf(owner),
    );

    // Cross-tenant patient ids are reported as not found by every child route.
    await expect(
      addPatientContact(stranger.tenantId, owner.patientId, { phone: "+1 555 010 4433" }, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      addPatientAddress(
        stranger.tenantId,
        owner.patientId,
        { addressLine1: "Hijack Road", country: "IN" },
        strangerActor,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      addPatientEmergencyContact(
        stranger.tenantId,
        owner.patientId,
        { name: "Hijack", relationship: "Kin", phone: "+1 555 010 5544" },
        strangerActor,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getPatientById(stranger.tenantId, owner.patientId),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getPatientDocuments(stranger.tenantId, owner.patientId, {
        userId: stranger.actorId,
        permissions: DOCUMENT_PERMISSIONS,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Cross-tenant update/delete/status operations cannot reach the record.
    await expect(
      updatePatient(stranger.tenantId, owner.patientId, { fullName: "Hijacked" }, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updatePatientStatus(stranger.tenantId, owner.patientId, "ARCHIVED", strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatient(stranger.tenantId, owner.patientId, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The stranger's own list never contains the other tenant's patient.
    const listing = await listPatients(stranger.tenantId, { pageSize: 100 });
    expect(listing.patients.map((patient) => patient.id)).not.toContain(owner.patientId);
  });
});

describe("soft-deleted patient access", () => {
  it("hides a deleted patient and all of its records", async () => {
    const fixture = await setup("soft-deleted");
    const actor = actorOf(fixture);

    const contact = await addPatientContact(
      fixture.tenantId,
      fixture.patientId,
      { phone: "+1 555 010 6677" },
      actor,
    );
    await addPatientAddress(
      fixture.tenantId,
      fixture.patientId,
      { addressLine1: "11 Gone Lane", country: "IN" },
      actor,
    );

    await deletePatient(fixture.tenantId, fixture.patientId, actor);

    await expect(getPatientById(fixture.tenantId, fixture.patientId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      updatePatientContact(fixture.tenantId, fixture.patientId, contact.id, { contactType: "HOME" }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      deletePatientContact(fixture.tenantId, fixture.patientId, contact.id, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      getPatientDocuments(fixture.tenantId, fixture.patientId, {
        userId: fixture.actorId,
        permissions: DOCUMENT_PERMISSIONS,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The row is retained for retention/audit, not physically removed.
    const { rows } = await getTestAdminPool().query<{ deleted_at: Date | null }>(
      "select deleted_at from patient_profiles where id = $1",
      [fixture.patientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});
