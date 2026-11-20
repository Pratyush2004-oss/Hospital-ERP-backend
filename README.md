# HospitalOS API

Multi-tenant hospital ERP backend. Phase 11: Express + TypeScript with
PostgreSQL (Drizzle ORM, RLS), Redis (ioredis), JWT auth and tenant RBAC.

## Requirements

- Node.js >= 22
- npm >= 10
- Docker (for local PostgreSQL and Redis from `docker-compose.yml`)

## Getting started

```bash
# 1. Start PostgreSQL and Redis (repo root)
docker compose up -d

# 2. Install and configure the API
cd apps/api
npm install
cp .env.example .env
npm run db:migrate              # apply schema migrations
npm run db:provision-app-role   # create the restricted runtime DB role
npm run dev                     # http://localhost:4000/api/v1/health
```

## Scripts

| Script              | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run with `tsx watch` (auto-restart on change)     |
| `npm run build`     | Compile to `dist/` with `tsc`                     |
| `npm start`         | Run the compiled build (`node dist/server.js`)     |
| `npm run typecheck` | Type-check without emitting                       |
| `npm run db:generate` | Generate SQL migrations from the Drizzle schema |
| `npm run db:migrate`  | Apply pending migrations                        |
| `npm run db:push`     | Push the schema directly (local prototyping)    |
| `npm run db:studio`   | Open Drizzle Studio                             |
| `npm run db:bootstrap` | Seed the permission catalogue and platform role |
| `npm run db:provision-app-role` | Create/rotate the restricted runtime DB role |
| `npm test`            | Run the full suite (auth, tenancy/RLS, RBAC, doctors, branches, departments) |

## Layout

```
src/
  server.ts             # bootstrap: listen, graceful shutdown (HTTP + Redis + pool)
  app.ts                # Express app factory (no port binding)
  config/env.ts         # Zod-validated environment config
  database/
    connection.ts       # singleton pg Pool, SELECT 1 probe, pool shutdown
    client.ts           # singleton Drizzle client over the pool
    index.ts            # public database entry point
    schema/index.ts     # Drizzle schema (tenant-scoped tables, auth, RBAC)
    migrations/         # generated SQL migrations
  infrastructure/
    redis/
      redis.config.ts   # connection options from env
      redis.client.ts   # singleton ioredis client + get/set/del/exists/expire
      redis.health.ts   # bounded PING probe
      index.ts          # public Redis entry point
  lib/                  # infrastructure helpers (logger, error types)
  middleware/           # cross-cutting Express middleware
  modules/              # feature modules, one folder per domain
    health/
      health.routes.ts
      health.service.ts
  routes/index.ts       # versioned API router aggregator
```

New domains follow `modules/<domain>/` with `*.routes.ts` (HTTP wiring),
`*.service.ts` (logic) and, as payloads grow, `*.schemas.ts` (Zod) and
`*.controller.ts`. Routers are mounted in `routes/index.ts`.

## Database

- `DATABASE_URL` is required. It is the administrative/owning connection used
  by migrations, seeds, bootstrap and role provisioning; the HTTP server does
  not serve requests with it.
- `APP_DATABASE_URL` is the restricted runtime connection. Create or rotate its
  role with `npm run db:provision-app-role`; it is provisioned as
  `NOSUPERUSER NOBYPASSRLS` and receives only DML/sequence/function privileges.
  In development the server falls back to `DATABASE_URL` and logs a warning;
  production requires `APP_DATABASE_URL` and verifies the connected role does
  not bypass RLS.
- The pool is created lazily on the first query and shared process-wide
  (`DB_POOL_MAX`, `DB_IDLE_TIMEOUT`, `DB_CONNECTION_TIMEOUT`, all in ms).
- Migrations are the source of truth: `npm run db:generate` after schema
  changes, then `npm run db:migrate`. The server never migrates on startup.
- Business tables live in `src/database/schema/` and are exported from
  `schema/index.ts`; every new table must also be added to the RLS migration.

## Redis

- `REDIS_URL` is required; the client is created lazily and shared process-wide.
- Reconnect attempts continue in the background with a capped backoff, while a
  single command is rejected after `REDIS_MAX_RETRIES` so requests do not hang.
- No BullMQ, business caching or auth sessions are implemented yet. The
  reusable primitives are exported from `src/infrastructure/redis/index.ts`:

```ts
import { del, exists, expire, get, set } from "./infrastructure/redis/index.js";

await set("key", "value", 60); // optional TTL in seconds
await get("key");              // string | null
await exists("key");           // boolean
await expire("key", 120);      // boolean
await del("key");              // boolean
```

Redis runs with AOF persistence and a named volume, so data survives restarts.

## Docker Compose

```bash
docker compose up -d          # start PostgreSQL + Redis
docker compose ps             # health status
docker compose down           # stop (data stays in named volumes)
docker compose down -v        # stop and delete data
```

| Service  | Default port | Credentials                                  |
| -------- | ------------ | -------------------------------------------- |
| postgres | 5432         | `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` (default `hospitalos`) |
| redis    | 6379         | none locally; set `REDIS_PORT` to remap       |

## API conventions

- All routes are mounted under `API_PREFIX` (default `/api/v1`).
- `GET {API_PREFIX}/health` reports `checks.api`, `checks.database` and
  `checks.redis`. It returns `200` when all are up, or `503` with
  `"status": "degraded"` when PostgreSQL or Redis cannot answer a probe.
- Errors are always:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /nope not found",
    "requestId": "b0e0..."
  }
}
```

Throw `AppError` (or a factory such as `AppError.notFound()`) for expected
failures; `ZodError` becomes a 422 `VALIDATION_ERROR`; anything else is logged
and returned as an opaque 500. Requests get an `x-request-id` header echoed in
logs and error bodies.

## Authentication, tenancy and RBAC

Authentication is cookie based: a short-lived JWT access token, an opaque
rotating refresh token (only its SHA-256 hash is stored), and a readable CSRF
cookie echoed in `x-csrf-token` for state-changing requests. All secrets come
from environment variables.

```text
POST /api/v1/auth/register          POST /api/v1/auth/login
POST /api/v1/auth/refresh           POST /api/v1/auth/logout
POST /api/v1/auth/logout-all        POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password    POST /api/v1/auth/change-password
GET  /api/v1/auth/me                GET  /api/v1/auth/sessions

POST /api/v1/tenants/register       GET  /api/v1/tenants/memberships
POST /api/v1/tenants/select         GET  /api/v1/tenants/settings
PUT  /api/v1/tenants/settings/:key
GET  /api/v1/tenant/memberships     PUT  /api/v1/tenant/memberships/:id/roles
GET  /api/v1/tenant/roles           POST /api/v1/tenant/roles
PATCH/DELETE /api/v1/tenant/roles/:id
PUT  /api/v1/tenant/roles/:id/permissions
GET  /api/v1/tenant/permissions

GET  /api/v1/audit-logs              GET  /api/v1/audit-logs/recent
GET  /api/v1/audit-logs/:id

GET  /api/v1/platform/tenants       POST /api/v1/platform/tenants
POST /api/v1/platform/tenants/:id/activate
POST /api/v1/platform/tenants/:id/suspend
```

The tenant is never taken from a client-supplied id on hospital routes. After a
user signs in they register a hospital (created `PENDING` with the creator as
`hospital_admin`), platform staff activate it, and `POST /tenants/select` stores
the verified tenant on the session. Every later request resolves the active
membership and its permissions server-side.

Platform access is bootstrapped with `npm run db:bootstrap`. Set
`PLATFORM_SUPER_ADMIN_EMAIL` to an existing account to grant it
`platform_super_admin`.

## Audit history

`GET /api/v1/audit-logs`, `/audit-logs/recent` and `/audit-logs/:id` are
read-only and require `audit:read`, held by `hospital_admin` and `branch_admin`
by default. Tenant context always comes from the session, filters are validated
with Zod, and audit rows cannot be mutated through the API. See
[`docs/audit-api.md`](docs/audit-api.md) for filters, pagination and security.

### Doctor management and permissions

The doctor module reuses the global RBAC catalogue. Permission keys use the
project's `<module>:<action>` convention (`doctor:read`, not `doctor.read`) and
are seeded idempotently by `seedRbacCatalogue` / `seedTenantRbac`.

| Method | Path | Permission |
| ------ | ---- | ---------- |
| `POST` | `/api/v1/doctors` | `doctor:create` |
| `GET` | `/api/v1/doctors` | `doctor:read` |
| `GET` | `/api/v1/doctors/:id` | `doctor:read` |
| `PATCH` | `/api/v1/doctors/:id` | `doctor:update` |
| `PUT` | `/api/v1/doctors/:id/departments` | `doctor:update` |
| `PUT` | `/api/v1/doctors/:id/branches` | `doctor:update` |
| `PATCH` | `/api/v1/doctors/:id/status` | `doctor:update` |
| `DELETE` | `/api/v1/doctors/:id` | `doctor:delete` |

Every route is mounted with `authenticate`, `requireTenant`, and
`requirePermission(...)`; writes also require CSRF. Routes never inspect role
names, and an unauthenticated or wrong-plane caller is denied by default.

Seeded hospital-role access:

| Role | `doctor:read` | `doctor:create` | `doctor:update` | `doctor:delete` |
| ---- | ------------- | --------------- | --------------- | --------------- |
| `hospital_admin` | yes | yes | yes | yes |
| `branch_admin` | yes | no | no | no |
| `receptionist` | yes | no | no | no |
| `doctor` | yes | no | no | no |
| `nurse` | yes | no | no | no |
| `pharmacist` / `lab_technician` | yes | no | no | no |
| `accountant` | no | no | no | no |

`doctor:schedule` is already catalogued for the later scheduling phase and is
granted to `hospital_admin`/`branch_admin`, but no scheduling endpoint exists.

**Self-access.** The `doctor` role is intentionally read-only: a doctor can read
their own profile and the tenant's doctor directory, but cannot modify their own
registration details, professional fields, branch assignments or status, and
cannot modify another doctor. Self-service profile editing is **not
implemented**. If it is added later it must use a dedicated permission plus an
ownership check against `doctors.user_id` and the verified membership — never a
role-name check inside a controller.

**Branch-level access is not implemented (documented limitation).**
`tenant_memberships` has no branch association, so `branch_admin` cannot be
scoped to specific branches at the authorization layer. It therefore has
read-only doctor access; granting it `doctor:update` would allow writes to every
doctor in the hospital. `branchId`/`departmentId` query parameters on
`GET /doctors` are filters, not authorization. Writes still validate that every
branch and department belongs to the caller's tenant, and that branch coverage
matches the doctor's departments.

**Data exposure.** Doctor responses include only `id`, `fullName`, `email`,
`phone` and `isActive` for the linked user; password hashes, tokens and session
data are never selected. `profileImageUrl` is stored as a plain URL and no
storage credentials are generated or returned. `tenantId` is never accepted
from the body or URL — it comes from the verified session, and unknown body
fields (including an injected `tenantId`) are stripped by validation.

There is no Swagger/OpenAPI harness in this repository (`swagger-ui-express` is
installed but unused), so the tables above are the API documentation and the
Zod schemas are the authoritative request contract.

### Doctor scheduling schema (Phase 16 foundation)

Migration `0010_black_nocturne.sql` reviews and corrects the scheduling tables
created in Phase 2. There are no scheduling APIs, services or slot generation
yet; the schema is the contract for that work.

| Table | Purpose |
| ----- | ------- |
| `doctor_schedules` | Recurring weekly availability window for one doctor at one assigned branch |
| `doctor_breaks` | Recurring pause inside one schedule window |
| `doctor_leaves` | Dated absence for one branch, or for every branch when `branch_id` is NULL |

**Time model.** `doctor_schedules.day_of_week` is an ISO weekday
(1 = Monday … 7 = Sunday) and `start_time` / `end_time` are `TIME` values in the
branch's local wall-clock time. `branches.timezone` holds the IANA zone and is
the only source of the offset — no UTC conversion is stored for recurring
windows, because a weekly rule must follow the branch clock across DST. A
schedule cannot span midnight (`end_time > start_time`); overnight cover is two
windows on adjacent weekdays. `effective_from` / `effective_until` are inclusive
`DATE` bounds, open-ended when the upper bound is NULL. Slot duration is
5–480 minutes and `buffer_minutes` (default 0) is the pause after each slot; the
window must fit at least one slot.

**Leave time model.** Actual leave is an absolute interval, so `start_at` and
`end_at` are `TIMESTAMPTZ`. A leave with `branch_id = NULL` applies to all
branches; otherwise PostgreSQL checks through the composite key that the branch
is one the doctor is assigned to. Leave rows are restricted from cascading away
when a branch assignment is removed, and `APPROVED` requires both `approved_by`
and `approved_at`.

**Overlap guarantees (database level).** Migration 0010 installs `btree_gist`
(available in every supported PostgreSQL distribution) and two exclusion
constraints:

- `doctor_schedules_no_overlap` rejects two *active* windows for the same
  tenant/doctor/branch/weekday when both their effective date ranges and their
  wall-clock ranges overlap. Split shifts (09:00–13:00 and 16:00–20:00) remain
  legal; inactive rows are excluded so history can be retained.
- `doctor_breaks_no_overlap` rejects overlapping breaks in the same schedule.
  Ranges are half-open, so adjacent breaks (11:00–11:15, 11:15–11:30) are fine.

A `BEFORE INSERT OR UPDATE` trigger (`doctor_breaks_window_check`) rejects a
break that is not fully inside its parent schedule window. Shrinking a window
does not retroactively revalidate its breaks, so the future scheduling service
must re-check them when a window is edited. All other checks (day range, time
order, slot/buffer, effective range, leave interval, approval completeness) are
ordinary `CHECK` constraints.

**Future slot generation (not implemented).** Generate slots by converting the
window's local date + time in `branches.timezone` to an instant, never by
treating the stored `TIME` as UTC. For DST transitions the documented policy is:
skip local times that do not exist (spring forward) rather than shifting them
into the next valid hour, and resolve ambiguous local times (fall back) to the
first occurrence (the earlier UTC offset). Approved leave suppresses affected
slots. This policy must be implemented and tested with Phase 16 slot generation.

### Appointment management schema (Phase 18.1)

Migration `0015_puzzling_shooting_star.sql` adds the database contract for the
appointment and booking engine. It is schema-only: no booking service, API,
rescheduling/cancellation logic, payments, notifications or voice-agent
integration exists yet. Availability is read-only and lives in Phase 18.2
(section below).

| Table | Purpose |
| ----- | ------- |
| `appointments` | One reserved consultation slot for a patient, doctor and branch |
| `appointment_events` | Append-only history of creation, status changes, rescheduling and cancellation |
| `appointment_idempotency_keys` | Replay protection for booking requests, scoped per tenant and operation |

**Tenant-aware relationships.** `appointments` uses composite foreign keys
starting with `tenant_id`: `(tenant_id, patient_id)` to `patient_profiles`,
`(tenant_id, doctor_id, branch_id)` to `doctor_branches` (which also proves the
doctor is assigned to the branch), `(tenant_id, branch_id)` to `branches`, and a
nullable `(tenant_id, department_id)` to `departments`. `department_id` is NULL
when no department is selected.

**Status is not payment.** `appointment_status` is one of `PENDING`,
`CONFIRMED`, `CHECKED_IN`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `NO_SHOW`,
`RESCHEDULED`. A booking that reserves its slot inside the booking transaction
is stored as `CONFIRMED` (the default); `PENDING` is for intake/import flows and
is not an approval step. `CANCELLED` requires a `cancellation_reason`.
`appointment_source` is `ONLINE`, `RECEPTIONIST`, `WALK_IN` or `VOICE_AGENT`;
`appointment_type` is `CONSULTATION`, `FOLLOW_UP`, `PROCEDURE` or `EMERGENCY`.

**Double-booking prevention.** `appointments_no_overlap` is a GiST exclusion
constraint over `(tenant_id, doctor_id, branch_id)` and the half-open range
`tstzrange(start_at, end_at, '[)')`, filtered to active statuses (`PENDING`,
`CONFIRMED`, `CHECKED_IN`, `IN_PROGRESS`). Concurrent bookings for one doctor at
one branch cannot both commit, and cancelled/no-show/completed/rescheduled rows
free their slot. Application checks are a convenience, not the guarantee.

**Time.** `start_at`/`end_at` are `TIMESTAMPTZ` absolute instants; local booking
requests must be interpreted in `branches.timezone` before storage. Recurring
schedule windows stay branch-local `TIME` values. `end_at > start_at` is a CHECK.

**No hold table.** The transactional insert plus exclusion constraint reserves a
slot without temporary holds, so `appointment_holds` was deliberately not
created. `appointment_events` is append-only; appointments are cancelled, never
hard-deleted.

See [`docs/appointment-schema.md`](docs/appointment-schema.md) for the full
column reference, state transitions, indexes, RLS and the documented limitations.

### Appointment availability and slot generation (Phase 18.2)

`src/modules/appointments/appointment-availability.service.ts` exposes
`getDoctorAvailability`, `getAvailableSlots` and `isSlotAvailable`. It reads the
existing schedule, break, leave and appointment tables; no second availability
model or HTTP route was added.

- Slots are generated from active, effective `doctor_schedules` for the
  requested branch-local date, stepping by the configured (or explicitly
  overridden) duration plus the window's buffer. The last slot must fit entirely
  inside the window; partial slots are never emitted.
- Multiple windows per day are merged and sorted. Breaks exclude overlapping
  slots. Only APPROVED leave blocks (branch-specific or all-branch); PENDING,
  REJECTED and CANCELLED leave do not.
- Appointments block only in `PENDING`, `CONFIRMED`, `CHECKED_IN` or
  `IN_PROGRESS`; CANCELLED, COMPLETED, NO_SHOW and RESCHEDULED release the slot.
  The buffer is also required after an existing appointment.
- Past slots are excluded. The branch's IANA timezone is used for all wall-clock
  interpretation and returned in the response. DST follows the documented
  policy: skip non-existent local times and use the first occurrence of
  ambiguous ones. No date/time dependency was added; `Intl` is used.
- The response includes doctor/branch IDs, branch timezone, dates, slot
  start/end/duration, consultation fee and currency from `doctor_branches`. No
  patient data is selected.
- Reads are a fixed set of tenant-scoped queries inside `withTenantTransaction`
  (no N+1). Availability is advisory: booking must still revalidate and rely on
  `appointments_no_overlap` under concurrency.

See [`docs/appointment-availability.md`](docs/appointment-availability.md) for
the algorithm, status/leave policies, DST decisions and limitations.

### Appointment booking, rescheduling and cancellation (Phases 18.3-18.4)

Three services use the Phase 18.1 schema and the Phase 18.2 availability model;
their lifecycle helpers (normalization, canonical hashing, idempotency lookup,
DTO mapping, error mapping) live in `appointment-service.shared.ts`. No HTTP
routes or controllers are mounted yet.

| Service method | Permission |
| --- | --- |
| `createAppointmentBooking` | `appointment:create` |
| `validateRescheduleRequest` | - (read-only) |
| `rescheduleAppointment` | `appointment:update` |
| `cancelAppointment` | `appointment:cancel` |

A patient may act on their own appointment without a hospital membership;
staff must be an ACTIVE member and, when the RBAC set is resolved, hold the
permission. Fees and currency always come from `doctor_branches`.

- **Booking** inserts a `CONFIRMED` appointment, a `CREATED` event and an
  idempotency record in one transaction. The `appointments_no_overlap` GiST
  exclusion constraint is the double-booking guarantee; `23P01`/`40001`/`40P01`
  map to `409 SLOT_UNAVAILABLE`.
- **Rescheduling** uses the replacement model from Phase 18.1: the superseded row
  becomes `RESCHEDULED` (releasing its slot inside the transaction) and a new
  `CONFIRMED` row points at it through
  `appointments.rescheduled_from_appointment_id` (migration 0016). A partial
  unique index permits one replacement per appointment. `RESCHEDULED` and
  `CREATED` events record both intervals, doctor/branch changes and the reason.
  The appointment row is locked `FOR UPDATE`, so concurrent reschedules and
  reschedule-vs-cancel are serialized.
- **Cancellation** is allowed from `PENDING`, `CONFIRMED` and `CHECKED_IN`. It
  records the reason and actor, appends one `CANCELLED` event and releases the
  slot. A repeated cancellation returns the cancelled row without a second event.
  `IN_PROGRESS`, `COMPLETED`, `NO_SHOW` and `RESCHEDULED` are not cancellable.
- **Idempotency** reuses `appointment_idempotency_keys` with
  `operation` = `appointment.create`, `appointment.reschedule` or
  `appointment.cancel`. Same key + same canonical hash replays the committed
  result; a different payload is `409 IDEMPOTENCY_KEY_REUSED`; concurrent
  duplicates are resolved by the unique index and an error-path replay.

See [`docs/appointment-reschedule-cancel.md`](docs/appointment-reschedule-cancel.md)
for the models, transitions, concurrency strategy, tests and limitations.

### Appointment lifecycle (Phase 18.5)

`appointment-lifecycle.service.ts` adds the post-booking workflows as services
(no HTTP routes):

| Service method | Permission |
| --- | --- |
| `checkInAppointment` | `appointment:update` |
| `startAppointment` | `appointment:update` |
| `completeAppointment` | `appointment:update` |
| `markAppointmentAsNoShow` | `appointment:update` |
| `getAppointmentLifecycleHistory` | `appointment:read` (patients may read their own) |

- Normal flow: `CONFIRMED → CHECKED_IN → IN_PROGRESS → COMPLETED`; the only
  alternative outcome is `CONFIRMED → NO_SHOW`, allowed only at or after the
  scheduled end instant.
- Every transition locks the appointment `FOR UPDATE`, revalidates the current
  status in the transaction, writes the status plus its timestamp
  (`checked_in_at`, `consultation_started_at`, `completed_at`, `no_show_at`) and
  one `appointment_events` row atomically. Duplicate identical requests return
  `applied: false` without a second event.
- The central transition table in `appointment-service.shared.ts` is shared with
  rescheduling and cancellation, so the rules cannot drift. A checked-in
  appointment may be started or cancelled, never marked as a no-show.
- Lifecycle actions are staff-only (`appointment:update`); a caller who is a
  doctor in the tenant may only act on their own appointments. Patients can read
  their own history. Missing/cross-tenant appointments are 404.
- Completion does not create invoices, change payment state or write clinical
  notes. No automatic no-show job exists.

See [`docs/appointment-lifecycle.md`](docs/appointment-lifecycle.md) for the
state machine, events, concurrency and limitations.

### Patient documents and private storage (Task 17.4)

Patient documents are a service-layer feature: no HTTP routes or controllers are
mounted yet. Metadata lives in PostgreSQL (`patient_documents`); file bytes go
through a private `StorageProvider`, never into the database. The shipped
adapter is local filesystem storage under `STORAGE_LOCAL_ROOT` (default
`storage/private`, git-ignored and never served statically); an S3-compatible
adapter can implement the same interface later.

| Service method | Permission |
| --- | --- |
| `uploadPatientDocument` | `patient:update` |
| `getPatientDocuments` | `patient:read` |
| `getPatientDocumentById` | `patient:read` |
| `generatePatientDocumentDownloadUrl` | `patient:read` |
| `deletePatientDocument` | `patient:update` |

Every method requires a verified tenant context and an ACTIVE membership,
repeats `tenant_id`/`patient_id` in SQL on top of RLS, and treats a document
from another patient or hospital as `404`. Uploads are restricted to PDF, JPEG,
PNG and WebP, with extension/MIME/magic-byte agreement and a configurable size
ceiling. Object keys are server-generated UUID paths; the client filename is
sanitised display metadata only. Responses never include the storage key - a
short-lived signed URL is issued after authorization instead. Deletion is a
soft delete of metadata; objects are retained until a retention policy exists.
Audit events go through the existing structured logger (there is no audit table)
and never contain patient data, filenames, keys or URLs.

**Pending:** malware scanning (`PatientDocumentScanner` integration point;
uploads stay `PENDING` and must not be described as clean), an S3-compatible
provider, the download route, and a retention job. See
[`docs/patient-documents.md`](docs/patient-documents.md) for the full security
model and failure-handling rules.

### Payments and online initiation (Phases 19.5-19.6)

Manual collections and provider-hosted online payments share one receipt table.

| Method | Path | Permission |
| ------ | ---- | ---------- |
| `POST` | `/api/v1/payments` | `payment:create` |
| `POST` | `/api/v1/payments/initiate` | `payment:create` |
| `GET` | `/api/v1/payments` | `payment:read` |
| `GET` | `/api/v1/payments/:paymentId` | `payment:read` |
| `GET` | `/api/v1/payments/:paymentId/allocations` | `payment:read` |

- **Manual recording** stores a `SUCCESSFUL` receipt, allocations and
  `invoice_payments` settlements in one transaction. The amount must equal the
  allocations exactly and may not exceed an invoice balance.
- **Online initiation** creates a provider checkout order plus a `PENDING`
  receipt, its allocation and a `payment_gateway_orders` row. It derives the
  amount, currency, patient and branch from the tenant-scoped invoice and accepts
  no client amount/status/order id. Because no `invoice_payments` row is written,
  an open checkout never changes `amount_paid` or `balance_due`.
- Both endpoints require `Idempotency-Key`; a retry replays the original
  receipt/checkout (`200`) and reusing a key for a different request is `409`.
- Only `ISSUED`, `PARTIALLY_PAID` and `OVERDUE` invoices with a positive balance
  can be initiated. Cross-tenant invoice ids are `404`; draft/cancelled/paid
  invoices and zero balances are `409`.
- Provider failures and timeouts are bounded by
  `PAYMENT_GATEWAY_TIMEOUT_MS`, roll the transaction back and return `502` / `504`
  with a safe message. Logs never contain credentials, request bodies or provider
  payloads.

**Gateway abstraction.** `src/modules/billing/gateway/` contains the
provider-neutral `PaymentGateway` interface, the adapter registry, and the
`mock` adapter used by development/tests. Billing services import only the
interface; a real provider is added by implementing one adapter, adding its
registry key and extending `PAYMENT_GATEWAY_PROVIDER`. Provider order ids,
transaction references and non-secret metadata are stored in
`payment_gateway_orders`, never on the receipt table, and `metadata` is
sanitised before persistence. Webhooks, settlement verification, refunds and
checkout UI are out of scope for Phase 19.6.1.

### Dashboard analytics (Phases 22.1-22.2)

`getDashboardAnalytics` aggregates appointment status counts, patient totals,
active doctors/workload and financial metrics for a tenant, optional branch and
local date range. Financial values reuse the Phase 19.9 billing reports and stay
decimal strings grouped by currency. Aggregation runs under tenant RLS and never
selects patient identities.

Phase 22.2 exposes the aggregation as read-only REST endpoints. Every route
requires `authenticate`, `requireTenant` and `reports:read`; each summary also
requires the read permission of the data it exposes.

| Method | Path | Required permissions |
| ------ | ---- | -------------------- |
| `GET` | `/api/v1/dashboard/operational` | `reports:read` (sections filtered by `appointment:read`, `patient:read`, `doctor:read`) |
| `GET` | `/api/v1/dashboard/appointments` | `reports:read`, `appointment:read` |
| `GET` | `/api/v1/dashboard/patients` | `reports:read`, `patient:read` |
| `GET` | `/api/v1/dashboard/doctors` | `reports:read`, `doctor:read` |
| `GET` | `/api/v1/dashboard/financial` | `reports:read`, `payment:read` |

All endpoints accept `fromDate`, `toDate`, optional `branchId` and optional
`timezone`, validate them with Zod, and reject a branch from another hospital
with `404`. The operational view omits sections the caller may not see; the
section endpoints return `403`. Patient totals are hospital-wide because
`patient_profiles` has no branch column, and memberships are not branch-scoped,
so `branchId` is a filter rather than an authorization boundary. See
[`docs/dashboard-analytics.md`](docs/dashboard-analytics.md).

### Row Level Security

Tenant-scoped tables enable PostgreSQL RLS with `FORCE ROW LEVEL SECURITY`.
Queries run through `withTenantTransaction` / `withPlatformTransaction`
(`src/database/context.ts`), which set `app.current_tenant_id`,
`app.current_user_id` and `app.is_platform` with `set_config(..., true)` inside
the transaction. Because the settings are transaction-local, a pooled
connection returns to the next request without a tenant context; tests cap the
pool at one connection and assert this explicitly.

PostgreSQL superusers and roles with `BYPASSRLS` ignore policies entirely, so
the API must run as `APP_DATABASE_URL`. `src/server.ts` requires that variable
in production, verifies the connected role, and refuses to start when it
bypasses RLS.

Platform authorization is a separate plane: platform routes require an active
row in `platform_user_roles`, while hospital routes require an active tenant
membership selected on the session. A hospital admin receives `403` on platform
routes and a platform admin receives `403` on tenant routes.

Tests run against `TEST_DATABASE_URL` (default
`postgresql://hospitalos:hospitalos@localhost:5432/hospitalos_test`) and never
touch the development database. Fixtures use the admin URL; the API under test
uses the derived restricted `hospitalos_app` role (`NOSUPERUSER NOBYPASSRLS`),
which `pretest` provisions. Doctor tests assert RLS on `doctors`,
`doctor_departments` and `doctor_branches`, and that a tenant GUC does not leak
back into the pooled connection. Scheduling schema tests cover the same
isolation for `doctor_schedules`, `doctor_breaks` and `doctor_leaves`, including
cross-tenant writes, exclusion constraints and the break-containment trigger.
The appointment schema suite exercises the same isolation for `appointments`,
`appointment_events` and `appointment_idempotency_keys`, plus overlapping-slot
rejection, tenant-aware foreign keys and idempotency-key uniqueness.

## Environment

Validated once at startup with Zod, so bad values fail fast. See `.env.example`.

| Variable              | Required | Default                 | Notes                                |
| --------------------- | -------- | ----------------------- | ------------------------------------ |
| `NODE_ENV`            | no       | `development`           | `development` / `test` / `production`|
| `PORT`                | no       | `4000`                  | 1-65535                              |
| `API_PREFIX`          | no       | `/api/v1`               | Leading slash added, trailing removed|
| `FRONTEND_URL`        | no       | `http://localhost:3000` | Sole allowed CORS origin             |
| `LOG_LEVEL`           | no       | `info`                  | pino level                           |
| `DATABASE_URL`        | **yes**  | -                       | Administrative DB URL (migrations/seeds) |
| `APP_DATABASE_URL`    | no       | falls back to `DATABASE_URL` | Restricted runtime role; required in production |
| `DB_POOL_MAX`         | no       | `10`                    | 1-100                                |
| `DB_IDLE_TIMEOUT`     | no       | `30000`                 | ms                                   |
| `DB_CONNECTION_TIMEOUT` | no     | `5000`                  | ms                                   |
| `REDIS_URL`           | **yes**  | -                       | `redis://` or `rediss://`            |
| `REDIS_CONNECT_TIMEOUT` | no     | `5000`                  | ms                                   |
| `REDIS_MAX_RETRIES`   | no       | `3`                     | 0-20 retries per command             |
| `STORAGE_DRIVER`      | no       | `local`                 | Only `local` is implemented          |
| `STORAGE_LOCAL_ROOT`  | no       | `storage/private`       | Private directory; public paths rejected |
| `STORAGE_MAX_FILE_SIZE_BYTES` | no | `10485760`           | 1 byte - 100 MiB                    |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | no | `300`             | 30-3600 seconds                     |
| `STORAGE_SIGNING_SECRET` | no    | derived from auth secret | 32+ chars; set explicitly in production |
| `PAYMENT_GATEWAY_PROVIDER` | no | `mock` | Registry key of the gateway adapter |
| `PAYMENT_GATEWAY_TIMEOUT_MS` | no | `5000` | Deadline for one order-creation call |
| `PAYMENT_GATEWAY_CHECKOUT_BASE_URL` | no | sandbox `.invalid` URL | Mock checkout page base |
| `PAYMENT_GATEWAY_API_KEY` | no | - | Provider secret; unused by `mock`, never exposed |
| `TEST_DATABASE_URL`   | no       | local `hospitalos_test` | Admin URL used only by `npm test`    |
| `TEST_ADMIN_DATABASE_URL` | no   | `TEST_DATABASE_URL`     | Explicit test admin/fixture URL      |
| `TEST_APP_DATABASE_URL` | no     | derived from admin URL  | Restricted API URL for tests         |
| `TEST_APP_DATABASE_USER` | no    | `hospitalos_app`        | Role used when deriving test app URL |
| `TEST_APP_DATABASE_PASSWORD` | no | `hospitalos_app`       | Password used when deriving test app URL |
| `PLATFORM_SUPER_ADMIN_EMAIL` | no | -                    | Account granted platform admin by `db:bootstrap` |
