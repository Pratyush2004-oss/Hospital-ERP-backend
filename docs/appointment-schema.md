# Appointment Management — Database Schema (Phase 18.1)

This document describes the schema added for the appointment management and
booking engine. Phase 18.1 was schema-only; Phase 18.2 reads it in the
availability service (`docs/appointment-availability.md`), Phase 18.3 adds the
booking service, Phase 18.4 adds rescheduling and cancellation
(`docs/appointment-reschedule-cancel.md`) and Phase 18.5 adds check-in,
consultation start, completion and no-show as services
(`docs/appointment-lifecycle.md`). There are still no HTTP routes, medical
records, payments, notifications or voice-agent integrations. The tables and
constraints below are the contract those later phases must build on.

Migration: `0015_puzzling_shooting_star.sql` (generated from the Drizzle schema
in `src/database/schema/` and extended with the exclusion constraint, RLS and
column comments).

## 1. Tables

| Table | Purpose |
| --- | --- |
| `appointments` | One reserved consultation slot for a patient with a doctor at a branch |
| `appointment_events` | Append-only history: creation, status changes, rescheduling, cancellation |
| `appointment_idempotency_keys` | Replay protection for booking requests |

No `appointment_holds` table was created; see section 6.

### `appointments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | `gen_random_uuid()` |
| `tenant_id` | `uuid` NOT NULL | Hospital; cascades from `tenants` |
| `patient_id` | `uuid` NOT NULL | Composite FK to `patient_profiles(tenant_id, id)` |
| `doctor_id` | `uuid` NOT NULL | Composite FK to `doctors(tenant_id, id)` |
| `branch_id` | `uuid` NOT NULL | Composite FK to `branches(tenant_id, id)` and to the doctor's assignment |
| `department_id` | `uuid` NULL | Composite FK to `departments(tenant_id, id)`; NULL = not selected |
| `appointment_code` | `varchar(40)` NOT NULL | Operational code, unique per tenant |
| `appointment_source` | enum NOT NULL | Channel: `ONLINE`, `RECEPTIONIST`, `WALK_IN`, `VOICE_AGENT` |
| `appointment_type` | enum NOT NULL DEFAULT `CONSULTATION` | `CONSULTATION`, `FOLLOW_UP`, `PROCEDURE`, `EMERGENCY` |
| `appointment_status` | enum NOT NULL DEFAULT `CONFIRMED` | Lifecycle only; never payment state |
| `start_at` | `timestamptz` NOT NULL | Absolute instant |
| `end_at` | `timestamptz` NOT NULL | Exclusive end; must be after `start_at` |
| `consultation_fee` | `numeric(12,2)` NOT NULL DEFAULT `0.00` | Non-negative |
| `currency` | `char(3)` NOT NULL DEFAULT `USD` | ISO 4217 |
| `reason` | `text` NULL | Patient-facing reason for the visit |
| `notes` | `text` NULL | Private operational note; see section 9 |
| `rescheduled_from_appointment_id` | `uuid` NULL | Replacement model: points at the superseded appointment (composite self-FK, partial unique index) |
| `checked_in_at` | `timestamptz` NULL | Phase 18.5 check-in instant |
| `consultation_started_at` | `timestamptz` NULL | Phase 18.5 consultation start instant |
| `completed_at` | `timestamptz` NULL | Phase 18.5 completion instant (payment state is separate) |
| `no_show_at` | `timestamptz` NULL | Phase 18.5 no-show instant |
| `created_by` | `uuid` NOT NULL | FK to `users`, `ON DELETE RESTRICT` |
| `cancelled_by` | `uuid` NULL | FK to `users`, `ON DELETE SET NULL` (NULL = system cancellation) |
| `cancellation_reason` | `text` NULL | Required when status is `CANCELLED` |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | Standard columns |

There is **no `deleted_at`**. Cancellation is the deletion concept for an
appointment, and the row must survive for history and audit. There is no
hard-delete path in the schema or application.

### `appointment_events`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` NOT NULL | Same tenant-isolation policy |
| `appointment_id` | `uuid` NOT NULL | Composite FK `(tenant_id, appointment_id)` |
| `event_type` | enum NOT NULL | `CREATED`, `STATUS_CHANGED`, `UPDATED`, `RESCHEDULED`, `CANCELLED`, `NO_SHOW` |
| `previous_status` | enum NULL | Set for transitions |
| `new_status` | enum NULL | Set for transitions |
| `actor_user_id` | `uuid` NULL | FK to `users`, `ON DELETE SET NULL` |
| `metadata` | `jsonb` NOT NULL DEFAULT `'{}'` | Event-specific detail, never clinical notes |
| `created_at` | `timestamptz` NOT NULL | Event timestamp |

The table is append-only: it has no `updated_at` and no delete path. Its FK to
`appointments` is `ON DELETE CASCADE` so a deliberate whole-tenant purge can
remove the tenant's data; normal operation never deletes an appointment.

### `appointment_idempotency_keys`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` NOT NULL | |
| `operation` | `varchar(50)` NOT NULL DEFAULT `appointment.create` | Command scope |
| `idempotency_key` | `varchar(200)` NOT NULL | Client-supplied key |
| `request_hash` | `varchar(64)` NOT NULL | SHA-256 hex of the canonical request |
| `appointment_id` | `uuid` NULL | NULL until the booking commits |
| `status` | enum NOT NULL DEFAULT `IN_PROGRESS` | `IN_PROGRESS`, `COMPLETED`, `FAILED` |
| `created_at` | `timestamptz` NOT NULL | |
| `expires_at` | `timestamptz` NOT NULL | Future cleanup boundary |

Uniqueness is `(tenant_id, operation, idempotency_key)`. The same key is legal
in another tenant and for a different operation. No service logic exists yet;
the future booking service must insert the key inside the booking transaction,
reject a reused key with a different `request_hash` (409), and return the
original appointment when the key is already `COMPLETED`.

## 2. Relationships

```
tenants 1 ── * appointments 1 ── * appointment_events
                  │
                  ├── (tenant_id, patient_id) ── patient_profiles(tenant_id, id)
                  ├── (tenant_id, doctor_id, branch_id) ── doctor_branches(...)
                  ├── (tenant_id, department_id) ── departments(tenant_id, id)   [nullable]
                  └── (tenant_id, branch_id) ── branches(tenant_id, id)

appointment_idempotency_keys * ── appointments(tenant_id, id)   [nullable until commit]
```

Every relation starts with `tenant_id`, so a cross-tenant link is impossible at
the database level even if a service passes the wrong UUID. The composite key
to `doctor_branches` also proves that the doctor is assigned to the booked
branch.

Department coverage (does the department operate at this branch, and does the
doctor cover that department?) cannot be expressed as one PostgreSQL foreign
key across `department_branches` and `doctor_departments`. It remains a service
validation for Phase 18.2; the database only guarantees that both rows belong to
the same tenant.

## 3. Status model

`appointment_status` values: `PENDING`, `CONFIRMED`, `CHECKED_IN`,
`IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `NO_SHOW`, `RESCHEDULED`.

Allowed transitions:

```
PENDING      -> CONFIRMED | CANCELLED | RESCHEDULED
CONFIRMED    -> CHECKED_IN | CANCELLED | NO_SHOW | RESCHEDULED
CHECKED_IN   -> IN_PROGRESS | CANCELLED
IN_PROGRESS  -> COMPLETED
```

A checked-in patient is never marked `NO_SHOW` (start or cancel instead).
`appointment-service.shared.ts` holds the authoritative transition table used by
booking, rescheduling, cancellation and the Phase 18.5 lifecycle service; see
[`appointment-lifecycle.md`](appointment-lifecycle.md).

Terminal states: `COMPLETED`, `CANCELLED`, `NO_SHOW`, `RESCHEDULED`.

- A booking created in the transaction that reserves the slot is stored as
  `CONFIRMED` immediately (the default). `PENDING` exists for intake/import
  flows and is **not** an approval workflow.
- Payment status is a different concept and has no column here. A future
  payments module must not overload `appointment_status`.
- A reschedule is represented by marking the superseded appointment
  `RESCHEDULED` (releasing its slot) and creating a new `CONFIRMED`
  appointment whose `rescheduled_from_appointment_id` points at the original.
  History is recorded in `appointment_events`. No slot mutation happens in
  place, and the partial unique index allows at most one replacement per
  superseded row. Implemented in Phase 18.4; see
  [`appointment-reschedule-cancel.md`](appointment-reschedule-cancel.md).
- `CANCELLED` requires a non-empty `cancellation_reason` (CHECK constraint).
  `cancelled_by` may be NULL for a system cancellation, for example an approved
  doctor leave.

## 4. Double-booking prevention

The database, not only the application, prevents overlapping active
appointments for the same doctor and branch:

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  doctor_id WITH =,
  branch_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (appointment_status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'));
```

- `btree_gist` provides GiST equality for the UUID columns; it is installed by
  migration 0010 and re-declared idempotently in 0015.
- The range is half-open `[)`, so 09:00–09:30 and 09:30–10:00 are adjacent and
  both allowed.
- Only active states participate. `CANCELLED`, `NO_SHOW`, `COMPLETED` and
  `RESCHEDULED` free the slot, which is what makes cancellation and rescheduling
  safe.
- The constraint covers concurrent booking requests: two transactions that
  attempt the same slot cannot both commit; the loser receives SQLSTATE
  `23P01`. The future booking service must map that to HTTP 409 and retry with
  the next slot. Application-level availability checks remain useful for UX but
  are not the guarantee.
- The scope is doctor **and** branch, as required. A doctor can therefore be
  booked for the same instant at two branches if a schedule is configured that
  way; preventing that would require a doctor-only constraint and is left for a
  later product decision.

## 5. Appointment sources and types

`appointment_source` records the channel: `ONLINE` (patient portal),
`RECEPTIONIST` (front desk), `WALK_IN` and `VOICE_AGENT`. The last value is
reserved; no voice-agent code exists.

`appointment_type` records the kind of visit: `CONSULTATION`, `FOLLOW_UP`,
`PROCEDURE`, `EMERGENCY`. It is intentionally separate from source and from the
doctor's specialty/department.

## 6. Decision: no temporary booking holds

`appointment_holds` was **not** created. The booking engine can reserve a slot
transactionally:

1. begin transaction;
2. insert the appointment (or a `PENDING` row) with its exact interval;
3. commit; the exclusion constraint rejects a conflicting reservation.

This gives the same concurrency guarantee as a hold without a second state
machine, an expiry job, or the risk of stale holds blocking availability. The
existing product requirement is that a successfully booked slot is immediately
confirmed, which matches an insert-and-commit flow.

A hold table would become justified only if the flow needs to reserve a slot
while the patient completes a slow external step (for example card
authorisation or document upload) without creating an appointment. If that is
introduced later, it should be a separate `appointment_holds` table whose
`(doctor_id, branch_id, tstzrange)` also has a GiST exclusion constraint, plus a
job that deletes rows past `expires_at`. That is deliberately out of scope here.

## 7. Time and timezone model

- `appointments.start_at` / `end_at` are `TIMESTAMPTZ`: absolute instants.
- A local booking request must be interpreted in `branches.timezone` before it
  is stored. The API/booking service, not PostgreSQL, performs that conversion.
- Recurring `doctor_schedules` remain branch-local `TIME` values (Phase 16); no
  UTC conversion is stored for them.
- `CHECK (end_at > start_at)` rejects zero-length and inverted intervals.
- Future slot generation must handle DST explicitly: skip non-existent local
  times (spring forward) and choose the first occurrence for ambiguous times
  (fall back). This is not implemented yet.

## 8. Indexes

| Index | Purpose |
| --- | --- |
| `appointments_tenant_code_unique` | Duplicate appointment-code prevention, per tenant |
| `appointments_rescheduled_from_unique` | At most one replacement per superseded appointment (partial) |
| `appointments_patient_history_idx` | Patient appointment history |
| `appointments_doctor_calendar_idx` | Doctor calendar / availability checks |
| `appointments_branch_calendar_idx` | Branch calendar |
| `appointments_status_idx` | Operational queues by state |
| `appointments_range_idx` | Date-range reports and slot scans |
| `appointment_events_appointment_idx` | Chronological history per appointment |
| `appointment_idempotency_keys_unique` | Key replay prevention (tenant + operation + key) |
| `appointment_idempotency_keys_appointment_idx` | Locate the appointment for a completed key |
| `appointment_idempotency_keys_expiry_idx` | Future expiry sweep |

`appointments_tenant_id_id_unique` (`UNIQUE (tenant_id, id)`) is also present as
the target of the child composite keys. No index on `tenant_id` alone is added:
every listed index leads with `tenant_id`, so a tenant-only lookup is served by
their prefix.

## 9. `notes` protection

`notes` is private operational text (for example an interpreter or mobility
request), not a clinical record. It is protected as follows:

- access is gated by the appointment read/write permissions introduced in later
  phases;
- it must never be written to logs or included in list/search responses;
- the column has a database comment restating this;
- RLS restricts the row to its tenant.

PostgreSQL column-level privileges were not used because the application role
needs `SELECT` on the table for list queries and Drizzle selects named columns;
withholding the column would break normal reads. Column-level protection is
therefore a service-layer contract, documented here and on the column.

## 10. Tenant isolation and RLS

`appointments`, `appointment_events` and `appointment_idempotency_keys` enable
and force RLS with the same `tenant_isolation` policy as every other
tenant-owned table:

```sql
USING (tenant_id = app_current_tenant_id() OR app_is_platform())
WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform())
```

The policy reuses the helper functions and the transaction-local
`app.current_tenant_id` / `app.is_platform` context from migration 0006 and
`src/database/context.ts`. No new isolation mechanism was introduced. The API
runs as the restricted `hospitalos_app` role (`NOSUPERUSER NOBYPASSRLS`), so the
policies are enforced in tests and production.

## 11. Deletion and history policy

- Appointments are never hard-deleted; cancellation leaves the row and is
  recorded in `appointment_events`.
- Cancelled appointments keep their `appointment_code`, so a code is never
  reused inside a tenant (the unique index is unconditional).
- `appointment_events` is append-only and cascades only when its appointment or
  tenant is deleted as part of an explicit purge.
- `appointment_idempotency_keys` are operational records and may be removed once
  `expires_at` passes. The service treats an expired key as absent and deletes
  that row lazily on the next lookup; a bulk expiry sweep is still not
  implemented.

## 12. Verification

`src/database/schema/appointments.schema.vitest.test.ts` verifies, against the
real PostgreSQL test database and the restricted application role:

- columns, indexes, the exclusion constraint, RLS flags and the applied
  migration;
- valid appointment creation and product defaults (`CONFIRMED`, fee, currency);
- every status/source/type value, and rejection of unknown enum values;
- time-order and non-negative fee checks, cancellation-reason requirement;
- tenant-aware patient/doctor/branch/department foreign keys and the
  doctor-branch assignment rule;
- duplicate appointment-code prevention, including across tenants;
- overlapping active appointment rejection, adjacent slots, different
  branches/doctors, and slot release for terminal states;
- append-only event history and event/appointment foreign keys;
- idempotency-key uniqueness per tenant and operation;
- RLS isolation, cross-tenant write rejection and the restricted role check.

Run `npm run typecheck` and `npm run test:vitest` (the full suite also covers the
doctor, scheduling and patient schema tests).

## 13. Known limitations / future work

1. Department/branch coverage and doctor-department coverage are service-level
   rules, not database constraints.
2. Overlap prevention is scoped per doctor **and** branch; the same doctor can
   be booked at two branches at the same instant.
3. The exclusion constraint cannot be expressed in Drizzle Kit, so it lives in
   the handwritten tail of migration 0015. A future `db:generate` will not drop
   it, but it also will not be recreated from the TypeScript schema.
4. No hold table, expiry job, HTTP API, check-in/completion/no-show workflow,
   payments, notifications or voice-agent integration exists yet. Booking,
   rescheduling and cancellation exist as services only.
5. Idempotency expiry is enforced lazily (an expired key is ignored and its row
   deleted on reuse); unused expired rows accumulate until a bulk sweep job is
   added.
6. Slot generation now applies the branch timezone and DST rules; see
   [`appointment-availability.md`](appointment-availability.md).
