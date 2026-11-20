# Appointment Lifecycle: Check-in, Consultation, Completion and No-show (Phase 18.5)

This phase adds the service-layer workflows that manage a booked appointment.
No HTTP routes, controllers, EMR/consultation notes, prescriptions, billing,
payments, notifications, automatic no-show jobs, frontend or voice-agent code
are included.

| Service method | Permission (staff) |
| --- | --- |
| `checkInAppointment` | `appointment:update` |
| `startAppointment` | `appointment:update` |
| `completeAppointment` | `appointment:update` |
| `markAppointmentAsNoShow` | `appointment:update` |
| `getAppointmentLifecycleHistory` | `appointment:read` (patients may read their own) |

Each mutating method also has an `…InTransaction` form for callers that already
own a tenant transaction; the public functions wrap them in
`withTenantTransaction`.

## 1. Lifecycle model

```
CONFIRMED --check-in--> CHECKED_IN --start--> IN_PROGRESS --complete--> COMPLETED
    |
    +--no-show (only at/after scheduled end)--> NO_SHOW
```

- `checkInAppointment` accepts only `CONFIRMED`. It records `checked_in_at`.
- `startAppointment` accepts only `CHECKED_IN`. It records
  `consultation_started_at`.
- `completeAppointment` accepts only `IN_PROGRESS`. It records `completed_at`.
- `markAppointmentAsNoShow` accepts only `CONFIRMED` and only once the current
  instant is at or after `end_at`. It records `no_show_at` and an optional
  reason in the event metadata.
- Repeating the exact target action (duplicate check-in, duplicate completion,
  duplicate start, duplicate no-show) returns the appointment with
  `applied: false`, does **not** modify timestamps and writes **no** second
  event.
- Any other invalid request is `409 INVALID_STATUS_TRANSITION` with
  `{ currentStatus, targetStatus, allowedTransitions }`.

Cancellation and rescheduling keep their Phase 18.4 rules and now consult the
same central transition table. In particular a checked-in appointment can still
be cancelled, but it can no longer be marked as a no-show.

## 2. Central state machine

`APPOINTMENT_TRANSITIONS` in `appointment-service.shared.ts` is the single
authority:

| From | Allowed |
| --- | --- |
| `PENDING` | `CONFIRMED`, `CANCELLED`, `RESCHEDULED` |
| `CONFIRMED` | `CHECKED_IN`, `CANCELLED`, `NO_SHOW`, `RESCHEDULED` |
| `CHECKED_IN` | `IN_PROGRESS`, `CANCELLED` |
| `IN_PROGRESS` | `COMPLETED` |
| `COMPLETED` / `CANCELLED` / `NO_SHOW` / `RESCHEDULED` | terminal |

Booking creates `CONFIRMED` directly. Rescheduling requires the target
`RESCHEDULED` to be allowed; cancellation requires `CANCELLED`; lifecycle methods
require their target status. The table is the only transition check in these
services, so the rules cannot drift apart.

`check-in` is only implemented from `CONFIRMED`. `PENDING` is an intake/import
state and is not check-in eligible until it is confirmed.

## 3. Timestamps

Migration `0017_appointment_lifecycle_timestamps.sql` adds four nullable
`TIMESTAMPTZ` columns to `appointments`:

| Column | Written by |
| --- | --- |
| `checked_in_at` | `checkInAppointment` |
| `consultation_started_at` | `startAppointment` |
| `completed_at` | `completeAppointment` |
| `no_show_at` | `markAppointmentAsNoShow` |

The status column remains authoritative; the timestamps are operational audit
data. They are written in the same statement as the status and in the same
transaction as the event. There is no backfill: historical rows keep `NULL`
unless a later migration chooses to derive values from events. Payment state is
never part of these transitions.

## 4. Events

`appointment_events` remains append-only and is the source of lifecycle history:

| Action | Event type | Previous → new status |
| --- | --- | --- |
| Check-in | `STATUS_CHANGED` (`action: "CHECK_IN"`) | `CONFIRMED` → `CHECKED_IN` |
| Start | `STATUS_CHANGED` (`action: "START_CONSULTATION"`) | `CHECKED_IN` → `IN_PROGRESS` |
| Complete | `STATUS_CHANGED` (`action: "COMPLETE"`) | `IN_PROGRESS` → `COMPLETED` |
| No-show | `NO_SHOW` (`action: "NO_SHOW"`, optional `reason`) | `CONFIRMED` → `NO_SHOW` |

The enum has no dedicated `CHECKED_IN`/`STARTED`/`COMPLETED` event types, so the
existing `STATUS_CHANGED` kind is used and `metadata.action` identifies the
transition. Every event carries tenant, appointment, actor, previous/new status
and a `created_at` equal to the transition instant. No patient name, contact
detail, note or clinical information is stored in metadata.

`getAppointmentLifecycleHistory(tenantId, appointmentId, actor)` returns the
appointment DTO (including the four lifecycle timestamps) and the events sorted
chronologically. Cross-tenant appointments are `404`; a patient may read only
their own history.

## 5. Authorization and tenant isolation

- Every operation runs in `withTenantTransaction`; SQL filters `tenant_id` in
  addition to forced RLS (`hospitalos_app`, `NOSUPERUSER NOBYPASSRLS`).
- Lifecycle actions are staff-only: an ACTIVE tenant membership is required.
- When the resolved RBAC set is supplied, `appointment:update` is required for
  transitions and `appointment:read` for history. Receptionists, nurses, doctors
  and administrators are therefore governed by their assigned permissions, not a
  blanket "staff can do anything".
- A caller who is a doctor in this tenant may only act on or read **their own**
  appointments. The check is the shared `assertDoctorAppointmentScope` helper,
  also used by booking, rescheduling, cancellation and the read model. Staff
  without a doctor profile are not subject to this scope.
- Tenant IDs and actor IDs are never read from request bodies.
- A missing or cross-tenant appointment is `404`; an existing appointment the
  caller may not act on is `403`.

## 6. Concurrency

- Each transition locks the appointment row with `SELECT … FOR UPDATE`, then
  revalidates the current status inside the transaction.
- Concurrent duplicate check-ins/starts/completions serialize: the winner
  applies the transition and writes one event; the loser re-reads the committed
  status and returns `applied: false`.
- Concurrent different transitions resolve deterministically from the first
  committed state (for example start after check-in succeeds; start before
  check-in is rejected). No second state machine or advisory lock is introduced.
- `getAppointmentLifecycleHistory` reads a snapshot; it does not lock.

## 7. Tests

`appointment-lifecycle.vitest.test.ts` (22 tests) runs against real PostgreSQL
with the restricted application role and covers:

- successful check-in, start, completion and no-show (status, timestamps, actor,
  event and DB columns);
- duplicate check-in/completion idempotency and single-event guarantees;
- invalid transitions (start without check-in, complete without start, check-in
  of completed/cancelled, no-show of checked-in/terminal rows);
- no-show before the scheduled end (`409 NO_SHOW_TOO_EARLY`) and slot release
  after a terminal no-show;
- unauthorized staff, missing membership, cross-tenant access and a doctor
  acting on another doctor's appointment;
- concurrent duplicate check-ins, completions and starts;
- rollback when event creation fails (status and timestamp restored, no event);
- chronological history, patient self-service history and history isolation;
- the schema test verifies migration 0017 and the lifecycle columns.

## 8. Known limitations

1. No HTTP routes or controllers; services only.
2. No automatic no-show scheduler/job; no-show must be recorded explicitly and
   never before `end_at`. No tenant policy currently permits early no-show.
3. `CHECKED_IN → NO_SHOW` is intentionally not allowed in this phase.
4. No medical record, consultation notes, prescriptions, invoices or payment
   changes are produced by completion.
5. Lifecycle timestamps are not backfilled for appointments that predate the
   migration.
6. `appointment_events` has no read API beyond the lifecycle-history method, and
   no pagination (history is expected to be small per appointment).
