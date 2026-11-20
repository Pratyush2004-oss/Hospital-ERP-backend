import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateDocumentUpload, type DocumentUploadInput } from "./file-validation.js";
import { LocalStorageProvider } from "./local-storage.provider.js";
import { StorageObjectNotFoundError } from "./storage.types.js";

/**
 * Tests for the development storage adapter (Task 17.4).
 *
 * They assert the two properties the document service relies on: bytes live in
 * a private directory, and the only URL the adapter produces is a signed,
 * expiring, API-relative one.
 */

const SIGNING_SECRET = "test-only-local-storage-signing-secret-0123456789";
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n");
const roots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `hospitalos-${label}-`));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("local storage provider", () => {
  it("stores, reads and deletes a private object", async () => {
    const root = await tempRoot("storage");
    const provider = new LocalStorageProvider({ rootDirectory: root, signingSecret: SIGNING_SECRET });
    const key = "tenants/t/patients/p/11111111-1111-1111-1111-111111111111.pdf";

    await provider.putObject({ key, body: PDF_BYTES, contentType: "application/pdf" });

    expect(await provider.getObject(key)).toEqual(PDF_BYTES);

    const info = await stat(join(root, key));
    // Files are not world-readable where the platform supports the mode.
    if (process.platform !== "win32") {
      expect(info.mode & 0o077).toBe(0);
    }

    await provider.deleteObject(key);

    await expect(provider.getObject(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    // Deleting a missing object is idempotent.
    await expect(provider.deleteObject(key)).resolves.toBeUndefined();
  });

  it("returns a signed, expiring, API-relative URL instead of a public file URL", async () => {
    const root = await tempRoot("storage-url");
    const provider = new LocalStorageProvider({ rootDirectory: root, signingSecret: SIGNING_SECRET });
    const key = "tenants/t/patients/p/22222222-2222-2222-2222-222222222222.pdf";

    await provider.putObject({ key, body: PDF_BYTES, contentType: "application/pdf" });

    const signed = await provider.createSignedDownloadUrl({
      key,
      fileName: "scan.pdf",
      contentType: "application/pdf",
      expiresInSeconds: 60,
    });

    expect(signed.url.startsWith("/api/v1/documents/download?")).toBe(true);
    expect(signed.url).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    expect(signed.url).not.toContain(root);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const params = new URLSearchParams(signed.url.split("?")[1]);

    expect(
      provider.verifySignedRequest({
        key: params.get("key") ?? "",
        expires: params.get("expires") ?? "",
        signature: params.get("signature") ?? "",
        fileName: params.get("fileName") ?? "",
      }),
    ).toBe(true);

    // A tampered key, signature or expiry is rejected.
    expect(
      provider.verifySignedRequest({
        key: `${key}x`,
        expires: params.get("expires") ?? "",
        signature: params.get("signature") ?? "",
        fileName: params.get("fileName") ?? "",
      }),
    ).toBe(false);

    expect(
      provider.verifySignedRequest({
        key,
        expires: "0",
        signature: params.get("signature") ?? "",
        fileName: params.get("fileName") ?? "",
      }),
    ).toBe(false);
  });

  it("refuses public or filesystem-root storage locations", async () => {
    const root = await tempRoot("storage-public");

    expect(
      () =>
        new LocalStorageProvider({
          rootDirectory: join(root, "public"),
          signingSecret: SIGNING_SECRET,
        }),
    ).toThrow(/private directory/);

    expect(
      () =>
        new LocalStorageProvider({
          rootDirectory: join(root, "static", "uploads"),
          signingSecret: SIGNING_SECRET,
        }),
    ).toThrow(/private directory/);
  });

  it("rejects path traversal and absolute keys", async () => {
    const root = await tempRoot("storage-keys");
    const provider = new LocalStorageProvider({ rootDirectory: root, signingSecret: SIGNING_SECRET });

    await expect(
      provider.putObject({ key: "../escape.pdf", body: PDF_BYTES, contentType: "application/pdf" }),
    ).rejects.toMatchObject({ name: "StorageOperationError" });

    await expect(provider.getObject("/etc/passwd")).rejects.toMatchObject({
      name: "StorageOperationError",
    });
  });

  it("does not write an object twice", async () => {
    const root = await tempRoot("storage-collision");
    const provider = new LocalStorageProvider({ rootDirectory: root, signingSecret: SIGNING_SECRET });
    const key = "tenants/t/patients/p/33333333-3333-3333-3333-333333333333.pdf";

    await provider.putObject({ key, body: PDF_BYTES, contentType: "application/pdf" });

    await expect(
      provider.putObject({ key, body: PDF_BYTES, contentType: "application/pdf" }),
    ).rejects.toMatchObject({ name: "StorageOperationError" });

    // The original content is intact.
    expect(await readFile(join(root, key))).toEqual(PDF_BYTES);
  });
});

function upload(overrides: Partial<DocumentUploadInput> = {}): DocumentUploadInput {
  return {
    fileName: "scan.pdf",
    mimeType: "application/pdf",
    data: PDF_BYTES,
    ...overrides,
  };
}

describe("document upload validation", () => {
  it("accepts a matching extension, MIME type and signature", () => {
    expect(validateDocumentUpload(upload(), 1_024)).toMatchObject({
      mimeType: "application/pdf",
      extension: "pdf",
      kind: "pdf",
      fileSize: PDF_BYTES.length,
    });
  });

  it("rejects mismatched or unsupported files", () => {
    expect(() =>
      validateDocumentUpload(upload({ data: Buffer.from("not a pdf") }), 1_024),
    ).toThrow(/supported document format/);

    expect(() =>
      validateDocumentUpload(upload({ fileName: "scan.png" }), 1_024),
    ).toThrow(/MIME type does not match/);

    expect(() =>
      validateDocumentUpload(upload({ fileName: "scan.exe" }), 1_024),
    ).toThrow(/Unsupported file extension/);

    expect(() => validateDocumentUpload(upload({ data: Buffer.alloc(0) }), 1_024)).toThrow(
      /empty/,
    );

    expect(() => validateDocumentUpload(upload(), 4)).toThrow(/maximum size/);
  });
});
