# Patient Profile and Registration API

Task 17.5 exposes the existing patient service (`patient.service.ts`, Task 17.2)
over HTTP. The service is unchanged; this layer adds controllers, Zod request
schemas and route guards only.

## Endpoints

All endpoints are mounted under the versioned prefix (`/api/v1`) and are
hospital-scoped.

| Method | Path | Permission | Behaviour |
| --- | --- | --- | --- |
| POST | `/patients` | `patient:create` | Register a patient and return the full profile |
| GET | `/patients` | `patient:read` | List/search live patients with pagination meta |
| GET | `/patients/:patientId` | `patient:read` | Retrieve a profile with contacts, addresses and emergency contacts |
| PATCH | `/patients/:patientId` | `patient:update` | Update profile fields |
| PATCH | `/patients/:patientId/status` | `patient:update` | Set ACTIVE / INACTIVE / ARCHIVED |
| DELETE | `/patients/:patientId` | `patient:delete` | Soft delete (archive) |

Writes require the CSRF header like the other hospital-plane endpoints.

## Tenant, actor and permissions

- `authenticate` resolves the actor; `requireTenant` requires a verified tenant
  context. The tenant id is never read from the URL, body or query string.
- The service repeats `tenant_id` in every statement inside
  `withTenantTransaction`, so PostgreSQL RLS and the explicit filter both
  enforce isolation. Cross-tenant ids return 404 at every endpoint.
- Linking a `userId` during registration additionally requires `patient:update`;
  the service checks the same verified permission set. A client cannot set
  `status`, `patientCode`, `tenantId` or `isVerified`.
- The list projection is identity-only (`PatientSummary`). Profile responses do
  not include credential columns, storage keys or audit fields.

## Listing

`page`, `limit` (default 20, max 100), `search` (full name or patient code),
`status`, `gender`, `dateFrom`, `dateTo`. `dateFrom`/`dateTo` are inclusive
registration-date bounds mapped to the service's `registeredFrom`/`registeredTo`
filters. Pagination metadata follows the shared envelope:
`meta.pagination = { page, pageSize, total, totalPages }`.

## Validation

Body schemas are `.strict()`: `tenantId`, `patientCode`, `status`, `userId` on
updates, `isVerified` and any other unexpected property produce
`422 VALIDATION_ERROR` with field-level details. Patient ids must be UUIDs.
Status transitions and every business rule remain in the service, so its
`409 CONFLICT` responses (duplicate account link, archived patient edits,
invalid transition) pass through the central error handler unchanged.

## Child records (Task 17.6)

Contacts, addresses and emergency contacts reuse the existing Task 17.3
services. Reads require `patient:read`; every mutation (including deleting a
child row) requires `patient:update` - `patient:delete` is reserved for
archiving the patient profile.

| Method | Path |
| --- | --- |
| POST | `/patients/:patientId/contacts` |
| GET | `/patients/:patientId/contacts` |
| PATCH | `/patients/:patientId/contacts/:contactId` |
| PATCH | `/patients/:patientId/contacts/:contactId/primary` |
| DELETE | `/patients/:patientId/contacts/:contactId` |
| POST | `/patients/:patientId/addresses` |
| GET | `/patients/:patientId/addresses` |
| PATCH | `/patients/:patientId/addresses/:addressId` |
| PATCH | `/patients/:patientId/addresses/:addressId/primary` |
| DELETE | `/patients/:patientId/addresses/:addressId` |
| POST | `/patients/:patientId/emergency-contacts` |
| GET | `/patients/:patientId/emergency-contacts` |
| PATCH | `/patients/:patientId/emergency-contacts/:emergencyContactId` |
| DELETE | `/patients/:patientId/emergency-contacts/:emergencyContactId` |

Rules preserved from the services:

- Contact rows carry `phone`, `email` or both; `contactType` is the purpose
  (`MOBILE`/`HOME`/`WORK`/`GUARDIAN`/`OTHER`). At most one contact row per
  patient is primary; promotion demotes the previous primary transactionally.
- At most one primary address per address type (`HOME`/`WORK`/`OTHER`).
  Promotion is transactional and demotes the previous primary of that category.
  Concurrent promotions end with one primary or a `409 CONFLICT`.
- Emergency contacts require `name`, `relationship` and `phone`; `email` is
  optional. There is no primary emergency contact.
- Contact verification is never client-controlled. `isVerified` is rejected by
  the strict schemas (`422`) and the service refuses the flag explicitly; new
  contacts start unverified and changing a phone/email resets verification.
- Deleting a primary contact/address is allowed: the schema only constrains
  "at most one primary", so no replacement is required. Child deletes are
  physical row deletes (the tables have no soft-delete column).
- Ownership is re-checked in the service for the tenant, the patient and the
  child row, so cross-tenant and cross-patient ids return `404`.

## Not in scope

Patient document APIs, medical records/EMR, appointment and billing APIs, and
frontend work. Registration-time children are still accepted inline because the
service creates them in the same transaction as the profile.

## Tests

`src/modules/patients/patient.routes.vitest.test.ts` covers registration,
listing/pagination, search and filters, profile retrieval, profile and status
updates, soft deletion, missing auth, missing tenant context, insufficient RBAC,
cross-tenant access, invalid payloads and protected-field rejection.

`src/modules/patients/patient.contact-management.routes.vitest.test.ts` covers
contact/address/emergency-contact CRUD, primary promotion, verification
attempts, malformed ids and payloads, missing auth and permissions, cross-tenant
and cross-patient access, archived patients and concurrent primary updates.

## Security, RBAC and tenant isolation (Task 17.7)

### Permissions

All patient endpoints use the existing RBAC catalogue and the existing
`requirePermission` guard; no parallel authorization system was added.

| Operation | Permission |
| --- | --- |
| List/search and view a profile or child records | `patient:read` |
| Register a patient (including an account link) | `patient:create` (account link also requires `patient:update`) |
| Update a profile, status, contacts, addresses or emergency contacts | `patient:update` |
| Soft delete (archive) a patient | `patient:delete` |
| List/read/download patient documents | `patient:document:read` |
| Upload patient documents | `patient:document:upload` |
| Soft delete patient documents | `patient:document:delete` |

Child-record deletion requires `patient:update`, not `patient:delete`, because
`patient:delete` is reserved for archiving the profile. Deleting a child row is
a physical delete of that row only.

Seeded roles are least-privilege: `receptionist` has read/create/update but no
delete; `doctor` has read-only access plus document read; `nurse` has
read/update plus document read/upload; `accountant`, `pharmacist` and
`lab_technician` have `patient:read` but no document access; only hospital and
branch admins have `patient:document:delete`. Custom roles receive nothing
implicitly.

### Tenant isolation

- The tenant id always comes from the verified session context written by
  `authenticate` and required by `requireTenant`; it is never read from the URL,
  query string, body or a header. Strict schemas reject `tenantId` with `422`.
- Every service call runs inside `withTenantTransaction`, which sets the
  transaction-local `app.current_tenant_id` / `app.current_user_id` /
  `app.is_platform` settings. `set_config(..., true)` means the GUC
  is released when the transaction ends, so a pooled connection never carries
  one request's tenant into the next. This is verified by
  `patient.security.vitest.test.ts` (unscoped pooled reads return no rows and
  concurrent transactions stay separated).
- Statements repeat `tenant_id` and, for child records, `patient_id` and the
  child id on top of RLS. Cross-tenant and cross-patient ids are reported as
  `404`, never `403`, so ids cannot probe another hospital's records.
- `patient_profiles`, `patient_contacts`, `patient_addresses`,
  `patient_emergency_contacts`, `patient_documents` and
  `patient_code_sequences` all have RLS enabled and forced with the
  `tenant_isolation` policy. Child tables use composite
  `(tenant_id, patient_id) -> patient_profiles(tenant_id, id)` foreign keys, so
  a row cannot be attached to another tenant's patient even by direct SQL.
- RLS is exercised with the restricted `hospitalos_app` role (`NOSUPERUSER`,
  `NOBYPASSRLS`); tests assert the runtime role cannot bypass policies.

### Data privacy

- Responses never include `password_hash`, tokens, storage keys, signed URLs,
  `deleted_at` internals or `tenant_id`. The list projection is identity-only and
the linked-account summary exposes only id, display name and active flag.
- `isVerified`/`verified` cannot be set by a client: strict schemas reject the
  field and services also refuse it. Changing a contact's phone or email resets
  verification.
- `profileImageKey` is a private storage key, not a public URL; URLs and paths
  with `..` are rejected.
- Patient records are soft deleted; contacts, addresses, emergency contacts and
document metadata are retained for retention and audit. Document objects are
  never physically deleted until an approved retention policy exists.
- The structured logger redacts credential fields and request headers. Audit
  events store identifiers and changed field *names* only, never names, phone
  numbers, emails, addresses or file contents.

### Audit logging

`patient.audit.ts` is the single audit mechanism for the module (the existing
structured logger; there is no audit table yet). It records:

| Event group | Events |
| --- | --- |
| Profile | `patient.created`, `patient.updated`, `patient.status_changed`, `patient.deleted`, `patient.account_linked`, `patient.account_unlinked` |
| Contacts | `patient_contact.created`, `.updated`, `.primary_changed`, `.deleted` |
| Addresses | `patient_address.created`, `.updated`, `.primary_changed`, `.deleted` |
| Emergency contacts | `patient_emergency_contact.created`, `.updated`, `.deleted` |
| Documents | `patient_document.uploaded`, `download_url_issued`, `soft_deleted`, and failure events |

Each entry carries the event, tenant id, actor user id, patient id, target child
or document id, optional `from`/`to` values for status changes, and the names of
changed fields. Audit failures are swallowed (with a warning) so they can never
break a completed operation; an audit table and tamper-evident retention are
pending work.

### Known limitations

- The new `patient:document:*` permissions are catalogue additions, not a data
  migration. Existing tenants keep their current grants until the RBAC seed is
  re-run (development seed, tenant provisioning, or a reviewed RBAC sync job).
  Production must not enable document routes before that grant sync, otherwise
  every role is denied by design.
- No audit table or immutable audit trail; events live in application logs only.
- No malware scanner is configured; uploads stay `PENDING` and must not be
described as clean.
- No HTTP surface for patient documents yet (service-layer only), so document
  RBAC is proven by service tests, and the future routes must reuse the same
  permission checks, never generic `patient:read`.
- No EMR/appointments/billing dependencies, so patient deletion has no
  dependent-record guard beyond the current module.
- These controls support privacy-by-design but do **not** by themselves
  establish DPDP Act 2023 or other healthcare-regulatory compliance. Still
  required: consent capture and purpose limitation, data-subject access/
  correction/erasure workflows, retention schedules, breach notification,
  audit retention and access review, staff training, encryption/key management
  policy, and a Data Protection Officer / grievance process.

### Security tests

`src/modules/patients/patient.security.vitest.test.ts` adds audit assertions
(actor/tenant/target, no PII), document least-privilege checks against the role
catalogue and the service, cross-tenant rejection for profile, child and
document access, RLS scoping with context reset on the pool, concurrent tenant
transaction isolation, and soft-deleted record access. Existing route, schema and
document suites continue to cover HTTP RBAC, cross-tenant endpoints and RLS.
