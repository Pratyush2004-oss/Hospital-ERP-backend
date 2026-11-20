# Appointment API — Architecture, Security and Operations (Phases 18.6–18.7)

This document covers the HTTP surface of the appointment engine introduced in
Phase 18.6 and the security/integration audit performed in Phase 18.7. It is a
reference for the module as a whole; per-phase implementation notes remain in
[`appointment-schema.md`](appointment-schema.md),
[`appointment-availability.md`](appointment-availability.md),
[`appointment-reschedule-cancel.md`](appointment-reschedule-cancel.md) and
[`appointment-lifecycle.md`](appointment-lifecycle.md).

No billing, payments, EMR/consultation notes, notifications, holds,
voice-agent integration or frontend code is part of this module.

## 1. Module architecture

```
HTTP            appointment.routes.ts        route guards + Zod validation
                appointment.controller.ts    request -> one service call
                appointment.schemas.ts       strict transport validation

Read model      appointment-query.service.ts list / by-id / by-code (+ doctor scope)

Domain          appointment-availability.service.ts   slot generation & evaluation
                appointment-booking.service.ts        booking transaction
                appointment-reschedule.service.ts     replacement model
                appointment-cancel.service.ts         status transition
                appointment-lifecycle.service.ts      check-in/start/complete/no-show
                appointment-service.shared.ts         DTOs, transitions, idempotency,
                                                      authorization, error mapping

Persistence     withTenantTransaction()      RLS context, one transaction per command
                appointments / appointment_events / appointment_idempotency_keys
```

Controllers contain no business logic. They read the verified tenant scope,
translate a validated request into exactly one service call, and wrap the
result in the standard `{ data }` / `{ data, meta }` envelope. Every rule
(availability, fee resolution, transitions, idempotency, ownership) lives in the
service layer.

## 2. Database relationships

| Table | Purpose |
| --- | --- |
| `appointments` | One reserved consultation slot |
| `appointment_events` | Append-only history / audit trail per appointment |
| `appointment_idempotency_keys` | Replay protection for create/reschedule/cancel |

Every relationship leads with `tenant_id` (composite foreign keys to
`patient_profiles`, `doctors`, `doctor_branches`, `departments`, `branches`), so
a cross-tenant link is impossible even if a service passes the wrong UUID. The
`(tenant_id, doctor_id, branch_id)` key proves the doctor is assigned to the
booked branch. See [`appointment-schema.md`](appointment-schema.md) for columns
and indexes.

## 3. API reference

Base path: `/api/v1/appointments`. All endpoints require the hospital session
cookie; state-changing requests also require the CSRF header. Tenant and actor
identity always come from the session context.

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/availability` | `appointment:read` | `doctorId`, `branchId`, `date` XOR `fromDate`+`toDate` (≤31 days), optional `durationMinutes` |
| GET | `/availability/:doctorId` | `appointment:read` | Same query, doctor in the path |
| POST | `/` | `appointment:create` | Requires `Idempotency-Key`; 201, or 200 on replay |
| GET | `/` | `appointment:read` | `page`, `limit` (≤100), `search`, `patientId`, `doctorId`, `branchId`, `departmentId`, `status`, `source`, `dateFrom`, `dateTo` |
| GET | `/:appointmentId` | `appointment:read` | 404 for unknown/cross-tenant |
| GET | `/code/:appointmentCode` | `appointment:read` | Public operational code, tenant-scoped |
| POST | `/:appointmentId/reschedule` | `appointment:update` | Replacement model; optional `Idempotency-Key` |
| POST | `/:appointmentId/cancel` | `appointment:cancel` | Reason required; optional `Idempotency-Key` |
| POST | `/:appointmentId/check-in` | `appointment:update` | `CONFIRMED → CHECKED_IN` |
| POST | `/:appointmentId/start` | `appointment:update` | `CHECKED_IN → IN_PROGRESS` |
| POST | `/:appointmentId/complete` | `appointment:update` | `IN_PROGRESS → COMPLETED` |
| POST | `/:appointmentId/no-show` | `appointment:update` | `CONFIRMED → NO_SHOW`, only after `end_at` |
| GET | `/:appointmentId/history` | `appointment:read` | `appointment` + chronological `events` |

There is no generic status/update endpoint, so a client can never set
`appointment_status` directly.

Availability is read-only and never creates or reserves an appointment. The
booking endpoints revalidate the slot inside their transaction; the availability
response is advisory.

### Request/response notes

- Bodies are strict: `tenantId`, `createdBy`, `appointmentStatus`,
  `consultationFee`, `currency` and `appointmentCode` produce `422`.
  `appointmentSource: "ONLINE"` is rejected on the staff booking route; staff
  may record `RECEPTIONIST`, `WALK_IN` or `VOICE_AGENT`.
- The consultation fee and currency are resolved from `doctor_branches` and
  returned; they are never accepted from the client.
- `notes` is accepted on booking, stored, and **never returned** by any read
  endpoint (including the list projection).
- Listing returns a joined projection (patient code/name, doctor code/name,
  branch name) and pagination metadata `{ page, pageSize, total, totalPages }`.
- `dateFrom`/`dateTo` are inclusive UTC calendar-date bounds on `start_at`.

## 4. Status lifecycle

```
CONFIRMED --check-in--> CHECKED_IN --start--> IN_PROGRESS --complete--> COMPLETED
    |
    +--cancel--> CANCELLED        (also from PENDING and CHECKED_IN)
    +--no-show--> NO_SHOW         (only at/after the scheduled end)
    +--reschedule--> RESCHEDULED  (+ new CONFIRMED replacement)
```

`APPOINTMENT_TRANSITIONS` in `appointment-service.shared.ts` is the single
authority; every mutating service consults it. Terminal states (`COMPLETED`,
`CANCELLED`, `NO_SHOW`, `RESCHEDULED`) are final. Repeating the exact target
action is an idempotent no-op (`applied: false`, or a `replayed` response) and
writes no second event. Payment status is a separate concept and is not touched
by any transition.

## 5. Booking, concurrency and double-booking prevention

A booking is one tenant transaction that verifies the patient, authorizes the
caller, resolves an idempotent replay, revalidates the slot, inserts the
appointment, writes the `CREATED` event and the idempotency record, then
commits.

Double booking is prevented by the database, not by the availability read:

```sql
EXCLUDE USING gist (tenant_id WITH =, doctor_id WITH =, branch_id WITH =,
                    tstzrange(start_at, end_at, '[)') WITH &&)
WHERE appointment_status IN ('PENDING','CONFIRMED','CHECKED_IN','IN_PROGRESS');
```

`CANCELLED`, `NO_SHOW`, `COMPLETED` and `RESCHEDULED` free the interval, which is
what makes cancellation and rescheduling safe. SQLSTATE `23P01`/`40001`/`40P01`
map to `409 SLOT_UNAVAILABLE`; no database detail reaches the client.
Reschedule/cancel lock the appointment row `FOR UPDATE`, serializing competing
transitions; the partial unique index allows only one replacement per original.
The Phase 18.7 suite fires genuinely concurrent HTTP bookings and asserts that
exactly one appointment and one `CREATED` event commit.

## 6. Idempotency

| Operation | Key scope |
| --- | --- |
| Booking | `appointment.create` |
| Reschedule | `appointment.reschedule` |
| Cancellation | `appointment.cancel` |

- Uniqueness is `(tenant_id, operation, idempotency_key)`; the same key is legal
  in another hospital and for another command.
- The key is sent as `Idempotency-Key` or `idempotencyKey`; booking **requires**
  one, and a header/body mismatch is a `422`.
- Same key + same canonical payload returns the committed result with
  `replayed: true` (booking replay returns `200` instead of `201`).
- Same key + different payload is `409 IDEMPOTENCY_KEY_REUSED`.
- A concurrent duplicate either replays the winner or receives
  `409 IDEMPOTENCY_KEY_IN_PROGRESS`; it never creates a second appointment.
- Rows expire 24 hours after they are written. An expired key is treated as
  absent and the row is deleted lazily inside the next transaction, so the key
  can be reused after its retention window (see section 12, limitation 2).
- The idempotency record is written in the same transaction as the appointment,
  so a rolled-back command leaves no successful record.

## 7. Availability and timezone rules

- Working windows come from active, effective `doctor_schedules` rows for the
  branch-local date; slots step by `slot_duration_minutes` plus `buffer_minutes`
  and must fit entirely inside the window.
- Breaks are compared as branch-local wall-clock minutes; approved leave and
  active appointments are compared as absolute `TIMESTAMPTZ` intervals with the
  configured buffer applied after an existing appointment.
- Only `APPROVED` leave blocks; `PENDING` does not. Active appointment statuses
  block (`PENDING`, `CONFIRMED`, `CHECKED_IN`, `IN_PROGRESS`).
- Slots in the past are excluded. Non-existent DST local times are skipped and
  ambiguous times use the first occurrence; the branch IANA zone is returned on
  every availability response.
- Availability loads schedules, breaks, leave and appointments in a fixed number
  of queries (no per-day/per-slot queries); booking reuses the same evaluation
  inside its transaction.

## 8. RBAC matrix

| Action | Permission | `hospital_admin` / `branch_admin` | `receptionist` | `doctor` | `nurse` |
| --- | --- | --- | --- | --- | --- |
| Availability, list, detail, code, history | `appointment:read` | yes | yes | yes | yes |
| Book | `appointment:create` | yes | yes | no | no |
| Reschedule / check-in / start / complete / no-show | `appointment:update` | yes | yes | yes (own) | yes |
| Cancel | `appointment:cancel` | yes | yes | no | no |

- Route guards (`authenticate` → `requireTenant` → `requirePermission`) are the
  coarse gate; services enforce the same keys plus row-level ownership.
- A caller who holds a doctor profile in the hospital may read, act on and
  reschedule/cancel **only their own** appointments — enforced in one shared
  helper (`assertDoctorAppointmentScope`) used by booking, reschedule, cancel,
  lifecycle and the read model. Staff without a doctor profile are governed by
  their RBAC permissions.
- Receptionists are hospital-wide: hospital memberships are tenant-scoped, not
  branch-scoped (section 12, limitation 1).
- Platform administrators act only through the platform plane and have no
  appointment routes; hospital appointment services always require a tenant id.

## 9. Tenant isolation and RLS

- The tenant id always comes from `requireTenantScope()`, never from a URL,
  query or body field; `tenantId` in a body is rejected by the strict schemas.
- Every service runs in `withTenantTransaction`, which sets transaction-local
  `app.current_tenant_id` / `app.is_platform`, and every statement also filters
  `tenant_id` in SQL.
- `appointments`, `appointment_events` and `appointment_idempotency_keys` enable
  and force RLS with the standard `tenant_isolation` policy; the API connects as
  the restricted `hospitalos_app` role (`NOSUPERUSER NOBYPASSRLS`).
- Cross-tenant reads and writes resolve to zero rows, surfacing as `404`.
  Platform bypass exists only for tenant-level administration, not through the
  appointment services.
- Transaction-local GUCs cannot leak through the pool: context is set with
  `set_config(..., true)` inside each transaction.

## 10. Error mapping

| Status | Code examples |
| --- | --- |
| 201 / 200 | created; replay (`replayed: true`); read/update |
| 400 | inactive doctor/branch, unassigned doctor, inactive department/patient |
| 401 | missing or invalid session |
| 403 | missing permission, doctor scope, not an active member |
| 404 | unknown or cross-tenant appointment/doctor/branch/patient/department |
| 409 | `SLOT_UNAVAILABLE`, `INVALID_STATUS_TRANSITION`, `NO_SHOW_TOO_EARLY`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_IN_PROGRESS` |
| 422 | Zod validation, protected field, malformed id/timestamp |

Unexpected failures become `500 INTERNAL_ERROR`; SQLSTATE values, constraint
names, stack traces and storage keys are never returned.

## 11. Audit trail

`appointment_events` is the audit record: one row per creation, reschedule,
cancellation, status transition and no-show, carrying tenant, appointment,
event type, previous/new status, actor user id, timestamp and event metadata
(previous/new interval, reason, replacement id). It is append-only and has no
delete path. No patient demographics, contact details, clinical notes,
authentication tokens or idempotency secrets are written to it. Private `notes`
is never logged or returned.

## 12. Known limitations and pending integrations

1. **No branch-scoped membership.** Memberships are tenant-scoped, so a
   receptionist or branch administrator can act on any branch in the hospital.
   Branch scoping needs a membership↔branch table, propagation into
   `TenantScope` and a backfill.
2. **Idempotency cleanup is lazy.** Expired rows are deleted when the same key is
   used again; there is still no bulk sweep job, so unused expired rows
   accumulate past 24 hours.
3. **No patient-portal appointment routes.** The services support patient
   self-service (own appointment, no membership), but all HTTP routes require a
   hospital tenant session.
4. **No holds.** A slot is reserved only by the appointment insert; there is no
   temporary hold table or countdown.
5. **Overlap is scoped per doctor *and* branch.** One doctor can be booked at two
   branches at the same instant.
6. **No automatic no-show job.** No-show is explicit and only after the
   scheduled end.
7. `dateFrom`/`dateTo` filters are UTC day bounds, not branch-local days.
8. Departure from the generic lifecycle: `CHECKED_IN → NO_SHOW` is intentionally
   disallowed (start or cancel instead).
9. Billing, payments, notifications, EMR and voice-agent integration are out of
   scope for Phase 18 and remain unimplemented.

## 13. Verification

| Suite | Scope |
| --- | --- |
| `appointment-availability.vitest.test.ts`, `.time.vitest.test.ts` | slot generation, breaks, leave, DST, timezone math |
| `appointment-booking.vitest.test.ts` | booking, authorization, slot rules, concurrency, idempotency, rollback |
| `appointment-reschedule.vitest.test.ts` | replacement model, slot validation, races, idempotency, rollback |
| `appointment-cancel.vitest.test.ts` | cancellation, eligibility, replay, races |
| `appointment-lifecycle.vitest.test.ts` | transitions, timestamps, events, concurrency, history |
| `appointment.routes.vitest.test.ts` | route guards, Zod validation, RBAC, doctor visibility, expiry |
| `appointment.e2e.vitest.test.ts` | full flow over HTTP, alternatives, concurrent booking, cross-tenant, RLS as app role |
| `appointments.schema.vitest.test.ts` | constraints, indexes, RLS flags, migrations |

All integration suites run against real PostgreSQL as the restricted
`hospitalos_app` role. Run `npm run typecheck` and `npm run test:vitest`.
