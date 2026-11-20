/**
 * Private object storage abstraction.
 *
 * The API stores document bytes through this interface only; PostgreSQL keeps
 * metadata and never file contents. Two rules are part of the contract:
 *
 * - Callers supply an opaque, server-generated `key`. A storage provider never
 *   accepts a client-provided key or filename as an object path.
 * - `createSignedDownloadUrl` returns a short-lived URL. A provider must never
 *   expose a permanent public URL, because patient documents are private.
 *
 * The shipped adapter is `LocalStorageProvider` (development/single-node). An
 * S3-compatible adapter can implement the same interface later without touching
 * the patient document service.
 */

export interface PutObjectInput {
  /** Server-generated object key, e.g. `tenants/<id>/patients/<id>/<uuid>.pdf`. */
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface SignedDownloadUrl {
  /** Short-lived URL. Local adapter returns an API-relative path. */
  readonly url: string;
  readonly expiresAt: Date;
  /** Adapter name, for diagnostics; never used as a URL. */
  readonly provider: string;
}

export interface SignedDownloadUrlInput {
  readonly key: string;
  /** Download filename presented to the client; already sanitised. */
  readonly fileName: string;
  readonly contentType: string;
  readonly expiresInSeconds: number;
}

export interface StorageProvider {
  /** Adapter identifier (`local`, later `s3`). */
  readonly name: string;

  /** Stores bytes under `key`. Must not overwrite an existing object. */
  putObject(input: PutObjectInput): Promise<void>;

  /** Reads object bytes. Used by the future download route. */
  getObject(key: string): Promise<Buffer>;

  /** Removes an object. Used for compensation; missing objects are tolerated. */
  deleteObject(key: string): Promise<void>;

  /**
   * Builds a short-lived URL. For the local adapter the URL points at the API's
   * own download endpoint and carries an HMAC signature plus an expiry, so the
   * object is never served from a public directory.
   */
  createSignedDownloadUrl(input: SignedDownloadUrlInput): Promise<SignedDownloadUrl>;
}

/** Raised when an object is missing; services translate it to a 404. */
export class StorageObjectNotFoundError extends Error {
  readonly provider: string;
  readonly key: string;

  constructor(provider: string, key: string) {
    super("Stored object not found");
    this.name = "StorageObjectNotFoundError";
    this.provider = provider;
    this.key = key;
  }
}

/** Raised for adapter-level failures that must not leak internal detail. */
export class StorageOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, message = "Storage operation failed") {
    super(message);
    this.name = "StorageOperationError";
    this.operation = operation;
  }
}
