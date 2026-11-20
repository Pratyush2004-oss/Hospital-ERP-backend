import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { StorageObjectNotFoundError, type StorageProvider } from "../../lib/storage/storage.types.js";
import { createPatient } from "./patient.service.js";
import {
  deletePatientDocument,
  generatePatientDocumentDownloadUrl,
  getPatientDocumentById,
  getPatientDocuments,
  uploadPatientDocument,
  type PatientDocumentServiceOptions,
} from "./patient.document.service.js";
import type {
  PatientDocumentActor,
  PatientDocumentAuditEvent,
  UploadPatientDocumentInput,
} from "./patient.document.types.js";

/**
 * Service-level tests for Task 17.4.
 *
 * The service runs as the restricted `hospitalos_app` role inside tenant-scoped
 * transactions, so RLS is enforced end to end. File bytes go through an
 * in-memory provider; database assertions use the admin connection.
 */

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

/** Minimal in-memory provider that records every storage interaction. */
class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory";
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  failPut = false;
  failSignedUrl = false;

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    if (this.failPut) throw new Error("simulated storage outage");
    if (this.objects.has(input.key)) throw new Error("object exists");
    this.putCalls.push(input.key);
    this.objects.set(input.key, input.body);
  }

  async getObject(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (!body) throw new StorageObjectNotFoundError(this.name, key);
    return body;
  }

  async deleteObject(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }

  async createSignedDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date; provider: string }> {
    if (this.failSignedUrl) throw new Error("simulated signing outage");

    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);

    return {
      // Signed, short-lived, and never a public object URL.
      url: `/api/v1/documents/download?key=${encodeURIComponent(input.key)}&expires=${Math.floor(
        expiresAt.getTime() / 1_000,
      )}&signature=test-signature`,
      expiresAt,
      provider: this.name,
    };
  }
}

interface AuditEntry {
  readonly event: PatientDocumentAuditEvent;
  readonly documentId?: string;
}

function createAuditSink(): {
  readonly entries: AuditEntry[];
  record(event: PatientDocumentAuditEvent, details?: { documentId?: string }): void;
} {
  const entries: AuditEntry[] = [];

  return {
    entries,
    record(event, details) {
      entries.push({ event, documentId: details?.documentId });
    },
  };
}

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
     values ($1, $2, $3, 'patient-document-test-hash')`,
    [id, `${label} User`, `${label}-${id.slice(0, 8)}@documents.test`],
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

function actor(fixture: Fixture): PatientDocumentActor {
  return {
    userId: fixture.actorId,
    permissions: new Set([
      "patient:document:read",
      "patient:document:upload",
      "patient:document:delete",
    ]),
  };
}

function uploadInput(overrides: Partial<UploadPatientDocumentInput> = {}): UploadPatientDocumentInput {
  return {
    documentType: "IDENTITY_PROOF",
    fileName: "passport.pdf",
    mimeType: "application/pdf",
    data: PDF_BYTES,
    ...overrides,
  };
}

function memoryStorage(): MemoryStorageProvider {
  return new MemoryStorageProvider();
}

function options(
  storage: MemoryStorageProvider,
  extra: Partial<PatientDocumentServiceOptions> = {},
): PatientDocumentServiceOptions {
  return { storage, ...extra };
}

async function documentRowCount(fixture: Fixture): Promise<number> {
  const { rows } = await getTestAdminPool().query<{ n: number }>(
    "select count(*)::int as n from patient_documents where tenant_id = $1 and patient_id = $2",
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

describe("patient document upload", () => {
  it("stores bytes privately and creates metadata", async () => {
    const fixture = await setup("document-upload");
    const storage = memoryStorage();
    const audit = createAuditSink();

    const created = await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput({ fileName: "../../X Ray Scan.PDF" }),
      actor(fixture),
      options(storage, { audit }),
    );

    expect(created).toMatchObject({
      patientId: fixture.patientId,
      documentType: "IDENTITY_PROOF",
      fileName: "X Ray Scan.PDF",
      mimeType: "application/pdf",
      fileSize: PDF_BYTES.length,
      scanStatus: "PENDING",
      uploadedBy: fixture.actorId,
    });

    // The sanitised name is metadata; the object key is a server-generated UUID.
    expect(created.fileName).not.toContain("/");
    expect(created.fileName).not.toContain("..");
    expect(storage.putCalls).toHaveLength(1);

    const key = storage.putCalls[0] ?? "";
    expect(key).toMatch(
      new RegExp(
        `^tenants/${fixture.tenantId}/patients/${fixture.patientId}/[0-9a-f-]{36}\\.pdf$`,
      ),
    );
    expect(key).not.toContain("passport");
    expect(await storage.getObject(key)).toEqual(PDF_BYTES);

    const { rows } = await getTestAdminPool().query<{
      storage_key: string;
      file_size: string;
      mime_type: string;
      scan_status: string;
      deleted_at: Date | null;
    }>(
      `select storage_key, file_size, mime_type, scan_status, deleted_at
         from patient_documents where id = $1`,
      [created.id],
    );

    expect(rows[0]).toMatchObject({
      storage_key: key,
      mime_type: "application/pdf",
      scan_status: "PENDING",
      deleted_at: null,
    });
    expect(Number(rows[0]?.file_size)).toBe(PDF_BYTES.length);
    expect(audit.entries.map((entry) => entry.event)).toContain("patient_document.uploaded");
  });

  it("generates unpredictable object keys for the same filename", async () => {
    const fixture = await setup("document-random-key");
    const storage = memoryStorage();

    await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage),
    );
    await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage),
    );

    expect(storage.putCalls).toHaveLength(2);
    expect(storage.putCalls[0]).not.toBe(storage.putCalls[1]);
    expect(new Set(storage.putCalls).size).toBe(2);
    expect(storage.putCalls.every((key) => key.includes("passport") === false)).toBe(true);
  });

  it("rejects an unauthorized actor before touching storage", async () => {
    const fixture = await setup("document-unauthorized");
    const storage = memoryStorage();

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        { userId: fixture.actorId, permissions: new Set() },
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      getPatientDocuments(fixture.tenantId, fixture.patientId, {
        userId: fixture.actorId,
        permissions: new Set(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(storage.putCalls).toHaveLength(0);
    expect(await documentRowCount(fixture)).toBe(0);
  });

  it("rejects a caller without an active membership", async () => {
    const fixture = await setup("document-outsider");
    const storage = memoryStorage();
    const outsider = await createUser("document-outsider-user");

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        {
          userId: outsider,
          permissions: new Set(["patient:document:read", "patient:document:upload"]),
        },
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(storage.putCalls).toHaveLength(0);
  });

  it("rejects invalid extension, MIME type and malformed content", async () => {
    const fixture = await setup("document-invalid");
    const storage = memoryStorage();

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput({ fileName: "payload.exe", mimeType: "application/pdf" }),
        actor(fixture),
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput({ fileName: "scan.pdf", mimeType: "image/png" }),
        actor(fixture),
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Correct extension and MIME, but the magic bytes are not a PDF.
    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput({ data: Buffer.from("this is not a pdf") }),
        actor(fixture),
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(storage.putCalls).toHaveLength(0);
    expect(await documentRowCount(fixture)).toBe(0);
  });

  it("enforces the configurable size ceiling", async () => {
    const fixture = await setup("document-oversized");
    const storage = memoryStorage();

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        actor(fixture),
        options(storage, { maxFileSizeBytes: 8 }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(storage.putCalls).toHaveLength(0);
  });

  it("refuses an infected scan and stores nothing", async () => {
    const fixture = await setup("document-infected");
    const storage = memoryStorage();
    const audit = createAuditSink();

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        actor(fixture),
        options(storage, {
          audit,
          scanner: { scan: async () => "INFECTED" as const },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(storage.putCalls).toHaveLength(0);
    expect(audit.entries.map((entry) => entry.event)).toContain(
      "patient_document.rejected_infected",
    );
  });

  it("removes the object when the metadata insert fails", async () => {
    const fixture = await setup("document-cleanup");
    const storage = memoryStorage();
    const audit = createAuditSink();
    const fixedId = randomUUID();
    const collidingKey = `tenants/${fixture.tenantId}/patients/${fixture.patientId}/${fixedId}.pdf`;

    // Force the storage key to collide with an existing metadata row, so the
    // insert violates `patient_documents_storage_key_unique`.
    await getTestAdminPool().query(
      `insert into patient_documents
         (tenant_id, patient_id, document_type, file_name, storage_key, mime_type, file_size, uploaded_by)
       values ($1, $2, 'OTHER', 'existing.pdf', $3, 'application/pdf', 10, $4)`,
      [fixture.tenantId, fixture.patientId, collidingKey, fixture.actorId],
    );

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        actor(fixture),
        options(storage, {
          audit,
          generateObjectId: () => fixedId,
        }),
      ),
    ).rejects.toBeTruthy();

    expect(storage.deleteCalls).toContain(collidingKey);
    expect(storage.objects.has(collidingKey)).toBe(false);
    expect(await documentRowCount(fixture)).toBe(1);
  });

  it("leaves no metadata when the storage provider fails", async () => {
    const fixture = await setup("document-storage-failure");
    const storage = memoryStorage();
    storage.failPut = true;
    const audit = createAuditSink();

    await expect(
      uploadPatientDocument(
        fixture.tenantId,
        fixture.patientId,
        uploadInput(),
        actor(fixture),
        options(storage, { audit }),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(await documentRowCount(fixture)).toBe(0);
    expect(audit.entries.map((entry) => entry.event)).toContain(
      "patient_document.storage_failed",
    );
  });
});

describe("patient document access", () => {
  it("lists and reads documents for the owning patient only", async () => {
    const fixture = await setup("document-list");
    const other = await createPatient(
      fixture.tenantId,
      { fullName: "Other Patient" },
      { userId: fixture.actorId },
    );
    const storage = memoryStorage();

    const created = await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage),
    );

    const listed = await getPatientDocuments(fixture.tenantId, fixture.patientId, actor(fixture));
    expect(listed.map((document) => document.id)).toEqual([created.id]);

    const found = await getPatientDocumentById(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      actor(fixture),
    );
    expect(found.id).toBe(created.id);
    // Metadata never exposes the internal storage path.
    expect(found).not.toHaveProperty("storageKey");

    await expect(
      getPatientDocumentById(fixture.tenantId, other.id, created.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatientDocument(fixture.tenantId, other.id, created.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await documentRowCount(fixture)).toBe(1);
  });

  it("blocks cross-tenant document access", async () => {
    const owner = await setup("document-cross-owner");
    const stranger = await setup("document-cross-stranger");
    const storage = memoryStorage();

    const created = await uploadPatientDocument(
      owner.tenantId,
      owner.patientId,
      uploadInput(),
      actor(owner),
      options(storage),
    );

    const strangerActor = actor(stranger);

    await expect(
      getPatientDocuments(stranger.tenantId, owner.patientId, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getPatientDocumentById(stranger.tenantId, owner.patientId, created.id, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      generatePatientDocumentDownloadUrl(
        stranger.tenantId,
        owner.patientId,
        created.id,
        strangerActor,
        { storage },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deletePatientDocument(stranger.tenantId, owner.patientId, created.id, strangerActor),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      uploadPatientDocument(
        stranger.tenantId,
        owner.patientId,
        uploadInput(),
        strangerActor,
        options(storage),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The owner's document is untouched and still listed.
    expect(await getPatientDocuments(owner.tenantId, owner.patientId, actor(owner))).toHaveLength(1);
  });

  it("requires read permission for downloads", async () => {
    const fixture = await setup("document-download-auth");
    const storage = memoryStorage();

    const created = await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage),
    );

    // Generic patient permissions do not grant document access.
    for (const permissions of [
      new Set(["patient:read"]),
      new Set(["patient:update"]),
      new Set(["patient:document:upload"]),
    ]) {
      await expect(
        generatePatientDocumentDownloadUrl(
          fixture.tenantId,
          fixture.patientId,
          created.id,
          { userId: fixture.actorId, permissions },
          { storage },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    }

    const download = await generatePatientDocumentDownloadUrl(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      actor(fixture),
      { storage },
    );

    expect(download.url).toContain("signature=");
    expect(download.url).toContain("expires=");
    expect(download.url).not.toMatch(/^https?:\/\/.*\/public\//);
    expect(download.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a storage failure while signing a download", async () => {
    const fixture = await setup("document-download-failure");
    const storage = memoryStorage();

    const created = await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage),
    );

    storage.failSignedUrl = true;

    await expect(
      generatePatientDocumentDownloadUrl(
        fixture.tenantId,
        fixture.patientId,
        created.id,
        actor(fixture),
        { storage },
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("patient document soft deletion", () => {
  it("soft deletes metadata and keeps the stored object", async () => {
    const fixture = await setup("document-soft-delete");
    const storage = memoryStorage();
    const audit = createAuditSink();

    const created = await uploadPatientDocument(
      fixture.tenantId,
      fixture.patientId,
      uploadInput(),
      actor(fixture),
      options(storage, { audit }),
    );

    await deletePatientDocument(
      fixture.tenantId,
      fixture.patientId,
      created.id,
      actor(fixture),
      { audit },
    );

    expect(await getPatientDocuments(fixture.tenantId, fixture.patientId, actor(fixture))).toHaveLength(
      0,
    );
    await expect(
      getPatientDocumentById(fixture.tenantId, fixture.patientId, created.id, actor(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });

    const { rows } = await getTestAdminPool().query<{ deleted_at: Date | null }>(
      "select deleted_at from patient_documents where id = $1",
      [created.id],
    );
    expect(rows[0]?.deleted_at).not.toBeNull();

    // Retention has not approved permanent removal.
    expect(storage.deleteCalls).toHaveLength(0);
    expect(storage.objects.size).toBe(1);
    expect(audit.entries.map((entry) => entry.event)).toContain(
      "patient_document.soft_deleted",
    );

    await expect(
      deletePatientDocument(fixture.tenantId, fixture.patientId, created.id, actor(fixture), {
        audit,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
