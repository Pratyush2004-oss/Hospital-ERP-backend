# Patient Documents — Private Storage and Metadata

Task 17.4 adds a patient document service and a private storage abstraction.
It is deliberately a **service-layer** delivery: there are no HTTP routes,
controllers or multipart parsing yet, and no patient profile or medical-record
APIs are introduced.

## 1. Scope

Implemented:

- `StorageProvider` interface with a local filesystem adapter
  (`src/lib/storage/storage.types.ts`, `local-storage.provider.ts`);
- upload content validation (`src/lib/storage/file-validation.ts`);
- patient document service (`src/modules/patients/patient.document.service.ts`);
- tests for storage, validation, authorization and metadata lifecycle.

Not implemented here:

- HTTP routes/controllers, multipart parsing, or a download route;
- S3-compatible storage (the interface and configuration slot exist);
- malware scanning (an integration point exists, see §7);
- permanent object deletion / retention jobs;
- EMR, lab reports, imaging, appointments or billing.

## 2. Storage abstraction

`StorageProvider` has four operations:

```ts
putObject({ key, body, contentType }): Promise<void>
getObject(key): Promise<Buffer>
deleteObject(key): Promise<void>
createSignedDownloadUrl({ key, fileName, contentType, expiresInSeconds })
```

Contract rules:

- the caller supplies a **server-generated** key; a provider never accepts a
  client filename as an object path;
- `putObject` must not overwrite an existing object (the local adapter uses the
  `wx` flag);
- `createSignedDownloadUrl` returns a short-lived URL, never a permanent public
  object URL;
- `deleteObject` tolerates a missing object (used for compensation).

The shipped adapter is `LocalStorageProvider`:

- files live under `STORAGE_LOCAL_ROOT` (default `storage/private`, resolved
  against the process working directory), created `0700` with files `0600`;
- the directory must not be a filesystem root or a public/static-looking path
  (`public`, `public_html`, `static`, `assets`, `www`); the constructor refuses
  to start otherwise;
- the HTTP server has no static file middleware for this directory;
- keys are validated against traversal (`..`, backslashes, absolute paths) and
  resolved inside the root;
- download URLs are API-relative and carry an HMAC-SHA256 signature plus an
  expiry timestamp. Verification lives on the adapter
  (`verifySignedRequest`) for the future download route. A signed URL alone is
  not sufficient: the route must still authorize the caller.

An S3-compatible adapter implements the same interface and is selected in
`createStorageProvider()` by `STORAGE_DRIVER`. No cloud SDK, credentials or
bucket configuration is present.

## 3. Service methods

All methods take the tenant id from the verified caller context (never input)
and run inside `withTenantTransaction`, so RLS is enforced as well as explicit
`tenant_id`/`patient_id` filters.

| Method | Permission (Task 17.7) | Behaviour |
| --- | --- | --- |
| `uploadPatientDocument` | `patient:document:upload` | Validates the file, verifies tenant membership and a mutable patient, writes the object, inserts metadata, audits the upload |
| `getPatientDocuments` | `patient:document:read` | Lists live metadata of one patient, newest first |
| `getPatientDocumentById` | `patient:document:read` | Returns one live document scoped to the patient and tenant |
| `generatePatientDocumentDownloadUrl` | `patient:document:read` | Re-checks ownership, then returns a signed short-lived URL and expiry |
| `deletePatientDocument` | `patient:document:delete` | Soft deletes metadata (`deleted_at`); keeps the object |

Document permissions are deliberately separate from `patient:read` /
`patient:update`: generic patient access must not imply access to identity
proofs, insurance cards or referrals. Seeded grants are least-privilege:

| Role | read | upload | delete |
| --- | --- | --- | --- |
| `hospital_admin`, `branch_admin` | yes | yes | yes |
| `receptionist`, `nurse` | yes | yes | no |
| `doctor` | yes | no | no |
| `accountant`, `pharmacist`, `lab_technician` | no | no | no |

`patient:document:*` permissions are additive catalogue entries; existing
installations must re-run the RBAC seed (or tenant provisioning) to grant them
to existing system roles. Custom roles need the grants added explicitly.

An actor without a resolved permission set is denied by default. The service
also requires an ACTIVE tenant membership. A document id that belongs to another
patient or another tenant is reported as `404`, not `403`, so ids cannot be used
to probe another patient's file list.

`PatientDocumentDto` intentionally omits `storageKey`. The only way to read
bytes is through a short-lived signed URL issued after an authorization check.

## 4. Upload security

- Allowed extensions: `pdf`, `jpg`, `jpeg`, `png`, `webp`.
- The declared MIME type must match the extension's canonical type.
- The file signature (magic bytes) must match the extension and MIME type;
  malformed files are rejected with `422`.
- Empty files are rejected; `STORAGE_MAX_FILE_SIZE_BYTES` enforces the ceiling
  (default 10 MiB, validated by `config/env.ts`).
- Original filenames are reduced to basename-only display metadata: control
  characters and separators removed, length capped at 255, fallback
  `document.<ext>`.
- Object names are UUIDs under
  `tenants/<tenantId>/patients/<patientId>/<uuid>.<ext>`. The object key is
  never derived from the client filename.
- The storage directory is private; no public-read ACL exists in the local
  adapter and none may be added to a future provider.

## 5. Database metadata

The existing `patient_documents` table (migration `0003_patient_foundation.sql`,
with `scan_status` added in `0014_patient_document_scan_status.sql`) is reused.
No schema change was required for this task.

Stored columns: `tenant_id`, `patient_id`, `document_type`, `file_name`,
`storage_key`, `mime_type`, `file_size`, `uploaded_by`, `scan_status`,
`created_at`, `deleted_at`. File binaries are **not** stored in PostgreSQL.

Conventions followed:

- composite foreign key `(tenant_id, patient_id) -> patient_profiles(tenant_id, id)`
  with `ON DELETE CASCADE`, so a document cannot point at another tenant's
  patient;
- unique index on `storage_key` (one object, one row);
- index `(tenant_id, patient_id, document_type, created_at)` for patient lists;
- `uploaded_by -> users(id) ON DELETE SET NULL` so removing a staff account
  does not remove the patient's documents;
- `file_size > 0` check;
- RLS enabled and forced (`tenant_isolation` policy) through the existing
  migration convention.

## 6. Audit and failure handling

The project has **no audit table**, so the service uses the shared patient audit
sink (`src/modules/patients/patient.audit.ts`, Task 17.7), which defaults to the
existing structured logger. Document events: `patient_document.uploaded`,
`upload_failed`, `storage_failed`, `scan_failed`, `rejected_infected`,
`download_url_issued`, `soft_deleted`, `upload_cleanup_failed`. Details carry
tenant, actor, patient and document ids plus the provider name only; patient
data, filenames, storage keys, contents and signed URLs are never logged. An
injected sink that throws cannot fail the operation.

Uploads are compensated:

- storage failure → `503`, no metadata row;
- database insert or commit failure after the object was written → the object
  is removed again; a failed removal emits `upload_cleanup_failed`;
- deletion is soft only; stored objects are retained because no retention policy
  authorises permanent removal.

## 7. Pending configuration

1. **Malware scanning.** No scanner is configured. `PatientDocumentScanner` is
   the integration point: a configured scanner returning `INFECTED` rejects the
   upload before storage; a scanner outage rejects with `503`; `CLEAN` may be
   persisted. Without a scanner, new rows are `PENDING` and the API must not
   describe them as malware-free.
2. **S3-compatible provider.** Implement `StorageProvider`, add a
   `STORAGE_DRIVER` case and validated env vars (bucket, region, endpoint,
   credentials via the standard provider chain). No credentials are committed.
3. **HTTP download route.** Must use a short-lived URL, verify the signature via
   the adapter, re-authorize the caller, and set
   `Content-Disposition`/`Content-Type` from metadata. Not part of this task.
4. **Retention job.** May delete objects for rows whose `deleted_at` is past an
   approved policy window; it must not run automatically before that policy
   exists.

## 8. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | Only `local` is implemented |
| `STORAGE_LOCAL_ROOT` | `storage/private` | Private directory, relative to `apps/api` |
| `STORAGE_MAX_FILE_SIZE_BYTES` | `10485760` | 1 byte – 100 MiB |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | `300` | 30–3600 seconds |
| `STORAGE_SIGNING_SECRET` | derived from `AUTH_ACCESS_TOKEN_SECRET` | 32+ chars; set explicitly in production |

`storage/` is git-ignored so patient files cannot be committed.

## 9. Tests

- `src/modules/patients/patient.document.vitest.test.ts` — upload and metadata,
  randomized keys, permission and membership denial, cross-tenant and
  cross-patient access, invalid MIME/extension/signature, size ceiling, scanner
  rejection, storage failure, compensation cleanup, download authorization,
  soft deletion.
- `src/lib/storage/storage.vitest.test.ts` — private file storage, signed
  expiring URL, traversal rejection, overwrite prevention, upload validation.

Service tests use an in-memory `StorageProvider`; database assertions run
against the isolated test database, with the API using the restricted
`hospitalos_app` role.
