# Appointment Availability and Slot Generation (Phase 18.2)

This document describes the read-only availability service that calculates
bookable appointment slots for a doctor at a hospital branch. It builds on the
Phase 16 scheduling schema (`doctor_schedules`, `doctor_breaks`,
`doctor_leaves`) and the Phase 18.1 appointment schema; it does not create a
second availability model.

**Scope.** Availability calculation only. Booking transactions, appointment
creation APIs, rescheduling/cancellation workflows, payments, notifications,
frontend and voice-agent work are not implemented.

## 1. Service methods

Module: `src/modules/appointments/appointment-availability.service.ts`

| Method | Input | Result |
| --- | --- | --- |
| `getDoctorAvailability(tenantId, query)` | doctor, branch, one date or a range, optional duration override | `DoctorAvailabilityResult` with days and slots |
| `getAvailableSlots(tenantId, input)` | doctor, branch, one date, optional duration override | `AvailabilitySlot[]` |
| `isSlotAvailable(tenantId, input)` | doctor, branch, absolute start instant, optional duration | `boolean` |

Shared input options:

- `durationMinutes` (optional, 5–480). When omitted, each working window's
  `doctor_schedules.slot_duration_minutes` is used. This is the only permitted
  override; the stored schedule remains the default source of truth.
- `now` (optional `Date`). The clock used to exclude past slots. It defaults to
  the current time and exists so tests (and later retries) can be
  deterministic. It is a service-only option, not an HTTP parameter.

### Response shape

`getDoctorAvailability` returns:

```ts
{
  doctorId,
  branchId,
  branchTimezone,          // IANA zone used for the schedule
  fromDate, toDate,        // inclusive branch-local dates
  requestedDurationMinutes, // null when window durations were used
  consultationFee,         // from doctor_branches, NUMERIC as string
  currency,                // ISO 4217 from doctor_branches
  days: [
    {
      date,                // YYYY-MM-DD in the branch zone
      slots: [
        { startAt, endAt, durationMinutes } // absolute Date instants
      ]
    }
  ]
}
```

Days with no working window are present with an empty `slots` array. No patient
information is selected or returned. A single-date request is a range where
`fromDate === toDate`; the range is capped at 31 days.

`getAvailableSlots` returns the flattened slots for one date. It is a thin
wrapper over `getDoctorAvailability`, so the result is identical.

## 2. Source-of-truth queries

The service reads the existing entities, tenant-scoped in SQL and inside
`withTenantTransaction` (the RLS transaction context):

1. doctor (`is_active`, `deleted_at`), branch (`timezone`, `is_active`,
   `deleted_at`) and the `doctor_branches` assignment (activity, fee, currency);
2. active, effective `doctor_schedules` for the requested range;
3. all `doctor_breaks` for those schedule rows;
4. APPROVED `doctor_leaves` overlapping the range, for the branch or all
   branches;
5. blocking `appointments` overlapping the range, for the doctor and branch.

That is a fixed number of queries per request, independent of the number of
days or generated slots. There is no per-slot or per-day query and no N+1
pattern. No new indexes were required: Phase 16 and 18.1 already index
`(tenant_id, doctor_id, day_of_week, is_active)`,
`(tenant_id, schedule_id)`, `(tenant_id, doctor_id, start_at)`,
`(tenant_id, doctor_id, branch_id, start_at)` and the appointment range/status
indexes.

## 3. Eligibility rules

Before reading any schedule:

- the doctor must exist in the tenant and not be soft deleted → 404;
- the doctor must be active → 400;
- the branch must exist in the tenant and not be soft deleted → 404;
- the branch must be active → 400;
- `branches.timezone` must be a valid IANA zone → 422;
- an active `doctor_branches` assignment must exist → 400.

A cross-tenant doctor or branch is indistinguishable from a missing resource:
the service returns 404 and never leaks its existence.

## 4. Slot generation

For each requested branch-local date:

1. Select active schedule rows whose ISO weekday matches the date and whose
   inclusive `effective_from` / `effective_until` range covers it.
2. Start at `start_time`. Every step advances by
   `slot duration + buffer_minutes`, where the duration is the per-request
   override or the window's configured duration.
3. Emit a slot only if `start + duration <= end_time`; partial slots are never
   generated.
4. Skip the slot when it overlaps any break (local wall-clock ranges, half-open
   so a slot ending exactly when a break starts is allowed).
5. Convert the local start to an absolute instant. Skip non-existent local
   times; ambiguous local times use the first occurrence (section 6).
6. Skip slots whose start is at or before `now` (past and in-progress slots).
7. Skip slots overlapping an APPROVED leave for this doctor and branch (or an
   all-branch leave), half-open.
8. Skip slots overlapping an active appointment. The window's buffer is also
   required *after* an existing appointment:
   `slot.start < appointment.end + buffer && slot.end > appointment.start`.
   The appointment table stores exact intervals only, so the current window's
   buffer is the only available margin.
9. Deduplicate by start instant (defensive; the Phase 16 exclusion constraint
   already forbids overlapping active windows) and sort ascending.

Multiple non-overlapping windows on one day are supported and produce one
merged, sorted list. Split shifts are therefore just two schedule rows.

## 5. Leave and appointment status policy

**Leave**

| Status | Blocks availability? |
| --- | --- |
| `APPROVED` | Yes |
| `PENDING` | No |
| `REJECTED` | No |
| `CANCELLED` | No |

Pending leave is a request, not an approved absence, so it is deliberately
non-blocking. The booking service may choose to warn about pending leave, but
availability must not pretend it was approved. Only approved leave suppresses
slots, matching the Phase 16 documentation.

Branch-specific leave blocks only that branch; `branch_id = NULL` blocks all
branches. Leave is an absolute `TIMESTAMPTZ` interval.

**Appointments** (actual Phase 18.1 enum, not a duplicate definition)

| Status | Blocks availability? |
| --- | --- |
| `PENDING` | Yes |
| `CONFIRMED` | Yes |
| `CHECKED_IN` | Yes |
| `IN_PROGRESS` | Yes |
| `CANCELLED` | No |
| `COMPLETED` | No |
| `NO_SHOW` | No |
| `RESCHEDULED` | No |

The blocking set matches the `appointments_no_overlap` exclusion constraint.
`CANCELLED` and `RESCHEDULED` release the old slot. `COMPLETED` and `NO_SHOW`
are terminal/historical and never block future availability. A completed or
no-show row that happens to sit in the future is treated as historical data and
does not block.

Appointments are checked only for the requested branch, matching the Phase 18.1
constraint scope. A future product decision to prevent the same doctor from
being booked at two branches simultaneously would require changing that
constraint and this query together.

## 6. Timezone and DST policy

- Recurring schedules, breaks and effective dates stay branch-local values;
  their storage format is unchanged (`TIME`, `DATE`).
- `branches.timezone` is the only source of the offset. The server's local
  timezone is never consulted.
- `appointments.start_at` / `end_at` remain `TIMESTAMPTZ`; generated slots are
  absolute `Date` instants.
- No timezone library was added. The project already standardises on
  `Intl.DateTimeFormat`; `appointment-availability.time.ts` wraps it.
  A local date + wall time is converted by sampling the zone offsets a day
  either side of the naive UTC guess, validating each candidate by formatting it
  back, then choosing the instant.
- **Spring forward:** a local time that does not exist is skipped. For example,
  on `2026-03-29` in `Europe/London`, 01:00 and 01:30 local do not exist; the
  first generated slot after the jump is 02:00 local (01:00Z).
- **Fall back:** a local time that occurs twice resolves to the first
  occurrence (earlier UTC instant). On `2026-10-25` in `Europe/London`,
  01:00 local means 00:00Z (BST), not the repeated 01:00Z (GMT). The repeated
  hour is therefore not double-generated.
- A slot's duration is real elapsed time from its start instant. A consultation
  that begins before a DST change keeps its true length.
- Schedule windows cannot span midnight (Phase 16 rule); overnight cover is two
  windows on adjacent weekdays.

The service derives the *requested* date from the branch zone, never from
`toISOString().slice(0, 10)` or the server clock.

## 7. `isSlotAvailable`

`isSlotAvailable` answers whether a specific absolute interval can be booked. It
does not require the start to match a generated slot boundary; the interval must
simply fall entirely inside one active, effective window on the resulting local
date. It returns `false` for:

- no matching schedule window or effective date;
- overlap with a break;
- overlap with approved leave;
- overlap with an active appointment (with buffer after it);
- a start at or before `now`;
- an interval that does not fit inside the window.

It still throws for missing/cross-tenant resources, inactive doctors/branches,
invalid assignments and invalid input. This is a read-time check; it does not
guarantee a successful booking.

## 8. Concurrency and booking guarantee

**Availability is advisory.** A slot can be taken between the availability read
and the booking write. Phase 18.2 does not implement booking. Phase 18.1's
`appointments_no_overlap` exclusion constraint remains the authoritative
concurrency guard: the booking transaction must insert the appointment, handle
SQLSTATE `23P01` as a conflict, and revalidate before committing. Do not treat a
`true` from `isSlotAvailable` as a reservation.

## 9. Tenant isolation

- `tenantId` comes from the caller's verified context in later routes, never
  from a body or query string.
- Every query includes `tenant_id`, and the whole read runs inside
  `withTenantTransaction`, so RLS applies under the restricted `hospitalos_app`
  role.
- Cross-tenant doctors/branches are 404, and the response never includes
  patient data or internal identifiers beyond the requested doctor/branch.
- Service-level authorization (`appointment:read`) belongs to the later route
  layer and is not implemented here.

## 10. Tests

- `appointment-availability.time.vitest.test.ts` — pure unit tests for ISO
  dates/weekdays, calendar arithmetic, winter/summer offsets, spring-forward
  non-existent times and fall-back ambiguity.
- `appointment-availability.vitest.test.ts` — 18 integration tests against the
  real PostgreSQL test database as the restricted role: normal days, multiple
  windows, duration override, single/multiple breaks, approved/branch/all-branch
  leave, pending/rejected/cancelled leave, active vs terminal appointment
  statuses, buffer handling, past/today, summer/winter conversion, both DST
  transitions, `isSlotAvailable`, inactive eligibility, unassigned branches,
  cross-tenant access, range validation, and overlap/deduplication.

Run `npm run typecheck` and `npm run test:vitest`.

## 11. Known limitations

1. Availability is not a reservation; booking must revalidate transactionally.
2. Pending leave does not block (documented policy); no warning is surfaced.
3. Appointments block only the same branch, matching the Phase 18.1 exclusion
   constraint.
4. The buffer after an existing appointment uses the buffer of the window
   currently being generated, because appointment rows store no buffer.
5. Duration override is allowed for any active schedule for read-only
   calculation; whether a booking may use a non-default duration is a later
   policy decision.
6. Ranges are capped at 31 days; there is no caching or precomputed slot table.
7. No availability HTTP route, permission guard, booking transaction,
   rescheduling/cancellation, payment, notification or voice-agent integration
   exists yet.
