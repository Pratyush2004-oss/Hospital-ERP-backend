# Appointment Rescheduling and Cancellation (Phase 18.4)

This phase adds two transactional lifecycle services on top of the Phase 18.1
schema, the Phase 18.2 availability engine and the Phase 18.3 booking service.
No HTTP routes, controllers, check-in/completion/no-show workflows, payments,
refunds, notifications, frontend or voice-agent code are included.

| Service method | File | Permission (staff) |
| --- | --- | --- |
| `validateRescheduleRequest` | `appointment-reschedule.service.ts` | none (read-only) |
| `rescheduleAppointment` | `appointment-reschedule.service.ts` | `appointment:update` |
| `cancelAppointment` | `appointment-cancel.service.ts` | `appointment:cancel` |

Both services also export an `…InTransaction` form for callers that already own
a tenant transaction; the public functions wrap them in
`withTenantTransaction`. A patient may act on their own appointment without a
hospital membership; anyone else must be an ACTIVE tenant member and, when the
resolved RBAC set is supplied, hold the permission above.

## 1. Rescheduling model: replacement appointment

The Phase 18.1 documentation already defined rescheduling as "mark the superseded
row `RESCHEDULED` (releasing its slot) and create a new CONFIRMED appointment".
Phase 18.4 implements exactly that model and adds the missing explicit link.

Migration `0016_appointment_reschedule_link.sql` adds:

| Column / object | Purpose |
| --- | --- |
| `appointments.rescheduled_from_appointment_id uuid NULL` | Replacement points at the superseded appointment |
| `appointments_rescheduled_from_fk` | Composite self-FK `(tenant_id, rescheduled_from_appointment_id) -> appointments(tenant_id, id)`, `NO ACTION` |
| `appointments_rescheduled_from_unique` | Partial unique index on `(tenant_id, rescheduled_from_appointment_id) WHERE … IS NOT NULL` |

Why not update the appointment in place:

- the original interval, doctor, branch and fee stay intact for history and audit;
- `appointment_events` can record an exact `RESCHEDULED` transition;
- the old slot is released by the existing exclusion-constraint predicate, with no
  second state machine and no duplicate active reservation;
- the current appointment is simply the `CONFIRMED` replacement, and can be found
  by following `rescheduled_from_appointment_id` (or by status).

Invariants:

1. A superseded appointment has status `RESCHEDULED` and is terminal.
2. At most one replacement may point at one appointment (partial unique index),
   even if application code races.
3. The replacement always belongs to the same tenant (composite self-FK) and the
   same patient.
4. Exactly one active reservation remains after commit; the original's slot is
   free.

## 2. `rescheduleAppointment`

Input (`RescheduleAppointmentInput`): `appointmentId`, optional `doctorId`,
optional `branchId`, optional `departmentId` (omit = keep, `null` = clear),
`startAt`, optional `endAt` or `durationMinutes` (mutually exclusive), optional
`reason`, optional `idempotencyKey`, optional test clock `now`.

Flow (one PostgreSQL transaction):

1. `withTenantTransaction` sets `app.current_tenant_id`; every query also filters
   `tenant_id`, so RLS and explicit predicates agree.
2. `SELECT … FOR UPDATE` on the appointment (joined to the patient for the
   self-service check) serializes reschedule-vs-reschedule and
   reschedule-vs-cancel.
3. An existing idempotency record for `(tenant, appointment.reschedule, key)` is
   resolved first: same hash + `COMPLETED` returns the original/replacement pair
   with `replayed: true`; a different hash is `409 IDEMPOTENCY_KEY_REUSED`.
4. Authorization: patient self-service or active membership + `appointment:update`.
5. Eligibility: patient ACTIVE, appointment status `PENDING` or `CONFIRMED`.
6. Target doctor/branch default to the current ones. The Phase 18.2
   `evaluateSlotBooking` is reused with `excludeAppointmentId`, so the
   appointment's own interval is not treated as a conflict while every other
   reservation, break, approved leave, working window and past check still apply.
   Fee and currency come from the target `doctor_branches` assignment.
7. The original is updated to `RESCHEDULED` **inside the transaction**. This
   releases its slot before the replacement is inserted, which makes an
   overlapping in-place move (09:00 → 09:15) legal without a transient
   double-booking. Nothing is visible outside until commit.
8. The replacement is inserted as `CONFIRMED` with
   `rescheduled_from_appointment_id = original.id`; appointment-code collisions are
   retried in a savepoint (shared with booking).
9. Two events are appended: `RESCHEDULED` on the original (with previous/new
   status, previous/new interval, previous/new doctor and branch, reason,
   replacement id) and `CREATED` on the replacement (with `rescheduledFromAppointmentId`).
10. The idempotency row is written with `appointment_id = replacement.id`.
11. Commit. Any failure rolls back the status change, the replacement, both
    events and the idempotency key, restoring the original CONFIRMED booking.

`validateRescheduleRequest` runs the same normalization and slot evaluation on a
read-only snapshot (no row lock, no writes, no authorization) and returns a
`RescheduleValidation` with the server-resolved target interval, fee, currency
and timezone.

## 3. `cancelAppointment`

Input: `appointmentId`, required `cancellationReason` (1–1000 characters),
optional `idempotencyKey`, optional `now`.

Flow (one transaction):

1. Lock the appointment row and load the patient's linked user for authorization.
2. Resolve a completed idempotency record for `appointment.cancel` (same hash →
   replay; different hash → `409 IDEMPOTENCY_KEY_REUSED`).
3. Authorize: patient self-service or active membership + `appointment:cancel`.
4. An already `CANCELLED` row is returned as-is with `replayed: true` — no
   second event, and the original reason is not overwritten.
5. Otherwise the status must be `PENDING`, `CONFIRMED` or `CHECKED_IN`.
6. Update the row: `appointment_status = CANCELLED`, `cancellation_reason`,
   `cancelled_by = actor`, `updated_at`.
7. Append one `CANCELLED` event (`previous_status`, `new_status = CANCELLED`,
   actor, reason, previous interval).
8. Write the idempotency row and commit. The slot becomes bookable as soon as the
   update commits because the exclusion constraint only covers active statuses.

## 4. Status transitions

Enforced by the services (and the DB CHECK for the cancellation reason):

| Current status | Reschedule | Cancel |
| --- | --- | --- |
| `PENDING` | yes → `RESCHEDULED` | yes → `CANCELLED` |
| `CONFIRMED` | yes → `RESCHEDULED` | yes → `CANCELLED` |
| `CHECKED_IN` | no | yes → `CANCELLED` |
| `IN_PROGRESS` | no | no |
| `COMPLETED` | no | no |
| `NO_SHOW` | no | no |
| `CANCELLED` | no | idempotent repeat (no event) |
| `RESCHEDULED` | no | no |

Invalid transitions return `409 INVALID_STATUS_TRANSITION` with
`{ currentStatus, allowedStatuses }`. Payment state is untouched; refunds belong
to the Billing/Payments module.

## 5. Events

`appointment_events` remains append-only. Phase 18.4 writes:

- `RESCHEDULED` on the superseded appointment: `previous_status` = old status,
  `new_status = RESCHEDULED`, metadata with `reason`, `previousStartAt`,
  `previousEndAt`, `newStartAt`, `newEndAt`, previous/new doctor and branch,
  `durationMinutes`, `replacementAppointmentId`.
- `CREATED` on the replacement: `new_status = CONFIRMED`, metadata with
  `appointmentCode`, `rescheduledFromAppointmentId`, interval, duration, source
  and type.
- `CANCELLED` on the cancelled appointment: `previous_status`, `new_status =
  CANCELLED`, metadata with `cancellationReason` and the cancelled interval.

No patient name, contact data, notes or clinical information is written to
metadata.

## 6. Idempotency

The existing `appointment_idempotency_keys` table is reused; `operation`
distinguishes commands, so booking, rescheduling and cancellation cannot collide:

| Operation | `appointment_id` stored |
| --- | --- |
| `appointment.create` | created appointment |
| `appointment.reschedule` | replacement appointment |
| `appointment.cancel` | cancelled appointment |

`request_hash` is the SHA-256 of a canonical payload (fixed key order) of the
client-controlled fields only. Derived values (status, fee, currency, resolved
source, timestamps produced by the server) are excluded so a legitimate retry
hashes identically.

Behavior:

- same key + same payload → the stored result is returned with `replayed: true`;
- same key + different payload → `409 IDEMPOTENCY_KEY_REUSED`;
- concurrent requests with the same key → the unique index makes one insert win;
  the loser re-reads the completed key (on the error path) and returns the
  winner's result;
- repeated cancellation without a key is also a no-op that returns the cancelled
  row without a second event.

## 7. Concurrency and double-booking prevention

- `SELECT … FOR UPDATE` on the appointment row serializes reschedule/reschedule,
  reschedule/cancel and cancel/cancel for one appointment. The second transaction
  observes the committed status and is rejected (except the idempotent repeat
  cancellation).
- The `appointments_no_overlap` GiST exclusion constraint remains the
  authoritative guard when two *different* appointments are rescheduled into the
  same slot. Both can pass the availability pre-check; exactly one insert
  commits, the other receives `409 SLOT_UNAVAILABLE` and its original booking is
  restored by the rollback.
- `SQLSTATE 23P01`, `40001` and `40P01` all map to the same safe
  `409 SLOT_UNAVAILABLE`.
- The partial unique index prevents a second replacement for one original even
  if a caller bypasses the row lock.
- Appointment-code collisions are retried in savepoints and never surface
  database internals.

The tests force genuine races with a temporary `pg_sleep` trigger on
`appointments`, so both transactions pass the application checks before either
row is written.

## 8. Security and performance

- Tenant ID always comes from the trusted caller; every statement filters
  `tenant_id` in addition to RLS (`hospitalos_app`, `NOSUPERUSER NOBYPASSRLS`).
- Authorization happens **before** an idempotency replay is returned, so a
  retried key can never disclose an appointment the caller may not act on. A
  caller who is a doctor in the hospital may only reschedule or cancel their own
  appointments (`assertDoctorAppointmentScope`, shared with the booking,
  lifecycle and read paths).
- Missing and cross-tenant appointments/doctors/branches/patients all return 404,
  so the existence of another hospital's records is not leaked.
- Fees and currency are never accepted from the request; they come from
  `doctor_branches`.
- Transactions hold one row lock and perform a fixed number of indexed queries.
  No per-slot queries and no extra write when an idempotent replay succeeds.
- Errors are mapped to operational `AppError`s; raw SQLSTATE, query text and
  constraint names never reach the caller.
- `notes` is copied to the replacement but never returned or logged. Event
  metadata excludes patient data.

## 9. Tests

`appointment-reschedule.vitest.test.ts` (20 tests) and
`appointment-cancel.vitest.test.ts` (12 tests) run against the real PostgreSQL
test database with the restricted application role and cover:

- validation, successful reschedule (history, link, fee, slot release,
  self-service), occupied slot, outside window, break, approved leave, past,
  different doctor/branch, cancelled/completed status, authorization,
  cross-tenant access;
- concurrent reschedules of one appointment, concurrent reschedules into one
  slot, rollback on event failure, idempotent replay (sequential and concurrent),
  key reuse with a different payload;
- successful/self-service cancellation, repeat cancellation, completed and
  in-progress rejection, missing reason, unauthorized and cross-tenant attempts,
  slot release, history, idempotent replay and concurrent duplicates;
- cancellation vs reschedule race consistency.

`appointments.schema.vitest.test.ts` verifies migration 0016, the new column,
foreign key, partial unique index, migration journal and the replacement-link
constraints.

## 10. Known limitations

1. No HTTP routes/controllers, check-in, completion or no-show workflows; those
   are separate phases.
2. Rescheduling always creates a replacement row. There is no in-place
   "same appointment id" mode.
3. Department coverage (department operates at the branch, doctor covers the
   department) remains a service-level gap, as documented in Phase 18.1.
4. A doctor can still hold appointments at two branches at the same instant; the
   exclusion constraint is scoped per doctor **and** branch, as before.
5. Reschedule/cancel events are not exposed through a history-read API yet.
6. No notification is emitted when an appointment is moved or cancelled.
7. Idempotency rows expire after 24 hours; an expired key is treated as absent
   and its row is deleted lazily on the next lookup. There is no bulk cleanup
   job, so unused expired rows still accumulate.
