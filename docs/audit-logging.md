# Audit Logging (Phase 21.1)

HospitalOS keeps a single append-only audit trail for security and operational
events. Phase 21.1 covers persistence, the shared writer, module integration and
database protection. It intentionally does **not** add audit APIs, dashboards,
frontends or exports.

## Schema

Table: `audit_logs` (`src/database/schema/audit-logs.ts`, migration
`0030_audit_logs.sql`).

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid | Audit record ID. |
| `tenant_id` | uuid, nullable | Owning hospital. Null for pre-tenant/platform events. |
| `branch_id` | uuid, nullable | Branch context when the action is branch-scoped. |
| `actor_user_id` | uuid, nullable | Verified acting user; null for anonymous/system events. |
| `actor_scope` | varchar(20) | `TENANT`, `PLATFORM`, `USER` or `SYSTEM`. |
| `action` | varchar(120) | Stable dotted action, e.g. `patient.created`. |
| `module` | varchar(60) | Owning area, e.g. `patients`, `billing`, `auth`. |
| `resource_type` | varchar(100), nullable | Resource kind, e.g. `invoice`, `appointment`. |
| `resource_id` | varchar(200), nullable | Resource identifier, stored as text. |
| `description` | varchar(500), nullable | Human-readable summary. |
| `previous_state` | jsonb, nullable | Redacted snapshot before an update/delete. |
| `new_state` | jsonb, nullable | Redacted snapshot after a create/update. |
| `metadata` | jsonb, not null | Narrow identifiers, changed field names, redacted values. |
| `request_id` | varchar(100), nullable | Correlation ID from `captureRequestMetadata`. |
| `ip_address` | varchar(64), nullable | Request IP, when available. |
| `user_agent` | varchar(512), nullable | Request user agent, truncated. |
| `dedupe_key` | varchar(250), nullable | Optional globally unique duplicate guard. |
| `created_at` | timestamptz, not null | Event time. |

There is deliberately **no `updated_at`, no `deleted_at` and no foreign keys**.
History must survive deletion of the tenant, actor or resource it references, so
those columns are plain identifiers rather than cascading references.

Indexes support the common read paths that a future API would need:

- `(tenant_id, created_at)` — tenant timeline.
- `(tenant_id, module, created_at)` — module activity.
- `(tenant_id, resource_type, resource_id, created_at)` — resource history.
- `(tenant_id, actor_user_id, created_at)` — actor history.
- `(tenant_id, branch_id, created_at)` — branch activity.
- Partial unique `dedupe_key` where not null.

## Service

`src/modules/audit/audit.service.ts` is the only supported writer.

- `recordAudit(tx, input)` — inserts one row on the caller's transaction.
- `recordAuditSafely(tx, input)` — same, wrapped in the `audit_log_write`
  savepoint. A failure is logged and the business transaction continues.
- `recordAuditStandalone(input)` — platform-scoped write for events with no
  business transaction yet (login, logout, authorization denial). Never throws.
- `recordCreateAudit`, `recordUpdateAudit`, `recordDeleteAudit` — thin helpers
  using the safe writer.
- `redactAuditValue(value)` — deep redaction and bounding for snapshots.
- `changedFields(before, after)` — field **names** only, never values.

Inputs default `actorUserId` and `actorScope` from the verified async request
context. Request ID, IP and user agent are also added automatically; callers
cannot override them with request data.

Action names live in `AUDIT_ACTIONS` (`audit.types.ts`). Add new actions there
rather than passing arbitrary strings.

### Transaction rule

Audit rows share the business transaction. If the business operation rolls back,
its audit row disappears too: the trail never records a successful action that
never committed. `recordAuditSafely` still keeps a broken audit write from
aborting valid business work; the failure is logged and the event is lost rather
than the patient/appointment/payment operation failing.

Standalone writes are used only when there is no tenant transaction to join.
They must never be used to simulate a business event that could still roll back.

## Event conventions

Use `module.operation` with a stable, lowercase action:

- Auth/session: `auth.registered`, `auth.login.succeeded`, `auth.login.failed`,
  `auth.logout`, `auth.logout_all`, `auth.session.reuse_detected`,
  `auth.password.changed`, `auth.password.reset`, `auth.tenant.selected`,
  `auth.authorization.denied`.
- Hospital: `hospital.created`, `hospital.status_changed`,
  `hospital.setting.updated`.
- Branches, departments, doctors: `<resource>.created|updated|deleted`,
  plus `<resource>.status_changed` and `doctor.assignments_changed`.
- Patients: `patient.created|updated|deleted`, `patient.status_changed`,
  `patient.account_linked|account_unlinked`.
- Appointments: `appointment.created|rescheduled|cancelled|status_changed`.
- Billing: `invoice.issued|cancelled|status_changed`, `payment.recorded`,
  `refund.requested|approved|rejected|succeeded|failed`.
- RBAC: `role.created|updated|deleted|permissions_changed`,
  `membership.roles_changed`.

Set `resourceType`/`resourceId` when a single resource is concerned. Use
`previousState`/`newState` for the smallest relevant snapshot, and `metadata`
for identifiers such as `changedFields`, invoice/payment IDs or required
permissions. Never put a full request body into `metadata`.

## Integrated modules

- **Auth and sessions:** registration, successful/failed login, logout,
  logout-all, refresh-token reuse, password change/reset, tenant selection.
- **Authorization:** denied permission/role checks from middleware.
- **Hospital/branch:** tenant creation, status/settings changes; branch CRUD,
  status and deletion.
- **Departments/doctors:** CRUD, status changes, doctor assignments.
- **Patients:** registration, profile/status updates, deletion and account
  linking.
- **Appointments:** booking, reschedule, cancellation and lifecycle status
  changes.
- **Billing:** invoice issuance/cancellation/status, payments, refund request,
  approval/rejection and final success/failure.
- **Users/roles:** role CRUD and permission changes, membership role changes.

Existing logger-based `patient.audit.ts` and `billing.audit.ts` remain for
operational logging. Database audit rows are written once per service operation;
the audit writer is not called from both a parent and child service for the same
event.

## Security

- **Tenant isolation:** RLS is enabled and forced with
  `tenant_id = app_current_tenant_id() OR app_is_platform()`. Application
  requests run as the restricted `hospitalos_app` role; no tenant context sees
  no audit rows.
- **Immutability:** trigger `audit_logs_immutable` rejects UPDATE and DELETE with
  SQLSTATE `42501`. It applies to the table owner too. A controlled maintenance
  transaction must set `app.audit_maintenance=true`; this exists for test
  cleanup only and must not be exposed through request code.
- **No secrets:** passwords, passphrases, tokens, API keys, cookies,
  authorization headers, credentials, card numbers/CVV, SSNs, PINs and OTPs are
  replaced with `[REDACTED]` at every nesting level.
- **Minimum patient data:** contact fields, addresses, dates of birth, medical
  history, diagnoses, prescriptions, treatment, clinical notes and reasons are
  redacted. Event metadata should carry IDs and field names, not patient content.
- **Bounded input:** depth 6, 50 array items/object keys, 1,000-character strings,
  and column-length caps prevent oversized audit rows.
- **Trusted request metadata:** request ID, IP and user agent come from the
  request context bound before authentication; values from headers or bodies are
  not trusted as audit identity.

## Tests

`src/modules/audit/audit.phase21.vitest.test.ts` covers:

- Event creation with actor/tenant/resource association.
- Credential, contact and clinical redaction.
- Rollback removes the audit row.
- Dedupe key prevents duplicate events.
- Auth, tenant selection, patient creation and authorization-denial tracking.
- Cross-tenant invisibility through the restricted DB role with no context.
- UPDATE/DELETE rejection by the append-only trigger.

Focused run:

```bash
npx vitest run src/modules/audit/audit.phase21.vitest.test.ts
```

Full validation for Phases 21.1–21.2: `npm run typecheck`, `npm run test:vitest`
(690 tests), `npm run test:node` (41 tests) and `npm run build`.

## Limitations

- Read-only APIs are documented in [audit-api.md](./audit-api.md). There is no
  export, dashboard or retention job.
- Audit writes are best-effort inside business transactions: a failed audit
  insert is logged but does not fail the business operation. Failed standalone
  writes are likewise logged and dropped.
- RLS protects database access, but anyone able to set the platform GUC can read
  all tenants; that capability is limited to trusted backend code and the
  database admin role.
