# Dashboard Analytics (Phases 22.1-22.2)

`src/modules/dashboard/dashboard.service.ts` exposes one read-only aggregation:
`getDashboardAnalytics(tenantId, filters, actor)`. Phase 22.2 mounts it under
`/api/v1/dashboard` for operational, appointment, patient, doctor and financial
summaries; no frontend is included. Every HTTP handler delegates to this single
aggregation, so no metric, currency or timezone rule is reimplemented in the API
layer.

## Usage

```ts
const analytics = await getDashboardAnalytics(
  tenantId,
  {
    fromDate: "2027-01-15",
    toDate: "2027-01-16",
    branchId,          // optional
    timezone: "Asia/Kolkata", // optional
  },
  { permissions: actor.permissions },
);
```

The caller must supply the verified tenant id, never a client value. The actor
must hold `reports:read`; otherwise the service throws `403 FORBIDDEN`.

## Result

```json
{
  "fromDate": "2027-01-15",
  "toDate": "2027-01-16",
  "branchId": "…",
  "timezone": "Asia/Kolkata",
  "asOf": "2026-11-20T10:00:00.000Z",
  "appointments": {
    "total": 4,
    "completed": 1,
    "cancelled": 1,
    "upcoming": 1,
    "noShows": 1
  },
  "patients": { "total": 3, "newlyRegistered": 1 },
  "doctors": {
    "activeDoctors": 2,
    "workload": [
      {
        "doctorId": "…",
        "doctorCode": "DOC-001",
        "doctorName": "Dr. Asha Rao",
        "appointmentCount": 4,
        "completedCount": 1,
        "upcomingCount": 1
      }
    ]
  },
  "financial": {
    "fromDate": "2027-01-15",
    "toDate": "2027-01-16",
    "timezone": "Asia/Kolkata",
    "invoiceCount": 3,
    "revenue": [{ "currency": "USD", "amount": "1800.00" }],
    "collections": [{ "currency": "USD", "amount": "800.00" }],
    "refunds": [{ "currency": "USD", "amount": "100.00" }],
    "netCollections": [{ "currency": "USD", "amount": "700.00" }],
    "pendingInvoices": {
      "invoiceCount": 2,
      "outstanding": [{ "currency": "USD", "amount": "700.00" }]
    }
  }
}
```

## HTTP API (Phase 22.2)

All routes require a cookie-authenticated member of the current hospital
(`authenticate` + `requireTenant`) and the seeded `reports:read` permission.
Each summary additionally requires the read permission of the data it exposes:

| Method | Path | Required permissions |
| ------ | ---- | -------------------- |
| `GET` | `/api/v1/dashboard/operational` | `reports:read` (sections filtered by `appointment:read`, `patient:read`, `doctor:read`) |
| `GET` | `/api/v1/dashboard/appointments` | `reports:read`, `appointment:read` |
| `GET` | `/api/v1/dashboard/patients` | `reports:read`, `patient:read` |
| `GET` | `/api/v1/dashboard/doctors` | `reports:read`, `doctor:read` |
| `GET` | `/api/v1/dashboard/financial` | `reports:read`, `payment:read` |

Query parameters (validated with Zod; unknown properties are stripped):

| Parameter | Required | Rules |
| --------- | -------- | ----- |
| `fromDate` | yes | `YYYY-MM-DD` calendar date |
| `toDate` | yes | calendar date, `fromDate <= toDate`, range at most 366 days |
| `branchId` | no | UUID of a branch in the caller's hospital; a foreign branch is `404` |
| `timezone` | no | IANA zone; defaults to the branch zone, then the hospital zone |

Successful responses use the standard `{ data }` envelope. Each response repeats
the resolved range (`fromDate`, `toDate`, `branchId`, `timezone`, `asOf`) next to
its section:

```json
{
  "data": {
    "appointments": {
      "fromDate": "2027-03-10",
      "toDate": "2027-03-10",
      "branchId": "…",
      "timezone": "Asia/Kolkata",
      "asOf": "2026-11-20T10:00:00.000Z",
      "total": 3,
      "completed": 1,
      "cancelled": 1,
      "upcoming": 1,
      "noShows": 0
    }
  }
}
```

`GET /dashboard/operational` returns `appointments`, `patients` and `doctors`
under `data.operational`, and omits any section the caller lacks the matching
read permission for (a section is never returned zeroed or partial). This is how
"only permitted metrics" is enforced on the composed view; the section-specific
endpoints return `403` instead.

Errors follow the project convention: `401` unauthenticated, `403` missing
permission or wrong plane, `404` unknown or foreign branch, `422`
`VALIDATION_ERROR` for bad dates, ranges, UUIDs or an invalid IANA zone. The
tenant is never read from the query or body, and CSRF does not apply because all
dashboard routes are `GET`.

### Branch and tenant boundaries

- The hospital always comes from the verified session. A `tenantId` supplied by
  the client is not read, so cross-tenant aggregation cannot be requested.
- `branchId` is verified against the caller's tenant before any query runs; a
  branch of another hospital resolves as `404 NOT_FOUND`, not as empty data.
- Memberships are tenant-scoped but not branch-scoped in the current model. A
  `branch_admin` therefore sees the whole hospital when no `branchId` is given.
  This remains a documented limitation; `branchId` is a filter, not an
  authorization boundary, and the API must not be described as branch-isolated.

## Filters and timezone

- `fromDate` / `toDate` are inclusive local calendar dates (`YYYY-MM-DD`), at
  most 366 days, with `fromDate <= toDate`.
- `branchId` must belong to the verified tenant; a foreign branch is `404`.
- `timezone` is an IANA zone. When omitted it resolves to the branch timezone,
  then the hospital timezone, then `UTC`.
- Appointment `start_at`, patient `created_at`, payment `received_at` and refund
  timestamps are absolute instants. They are bounded by local midnight in the
  resolved timezone (`[from 00:00, to+1 00:00)`).
- Invoice `issue_date` is already a local calendar date.

Metric definitions:

| Metric | Definition |
| --- | --- |
| Appointment `total` | All appointments starting in the range (branch-scoped when filtered). |
| `completed` / `cancelled` / `noShows` | Status counts within the range. |
| `upcoming` | `PENDING` or `CONFIRMED` appointments starting at/after the snapshot `asOf`. |
| Patient `total` | All non-deleted patient profiles in the hospital. |
| Patient `newlyRegistered` | Non-deleted profiles whose `created_at` is in the range. |
| Doctor `activeDoctors` | Active, non-deleted doctors, restricted to the branch when filtered. |
| Doctor `workload` | One grouped row per doctor with appointments in the range. |
| Financial | Delegated to Phase 19.9 reports; see below. |

### Patient branch scope

`patient_profiles` has no branch column, so patient statistics are always
hospital-wide. A branch filter does not change `patients.total` or
`patients.newlyRegistered`. Appointment, doctor and financial metrics do honor
the branch. This is an intentional limitation of the current data model, not an
implicit fallback.

## Financial reuse

Revenue, collection, refund, net and invoice definitions come directly from
Phase 19.9:

- `getRevenueSummary` for revenue (`invoiced`), successful collections,
  successful refunds, net collections and invoice count.
- `getOutstandingBalances` for the open invoice count and outstanding balances
  as of `toDate`.

Only `SUCCESSFUL` payments count as collections and only `SUCCESSFUL` refunds
reduce net collections. Draft and cancelled invoices are not revenue. Amounts
are PostgreSQL `NUMERIC` aggregates returned as decimal strings, grouped by
currency; the dashboard never converts them to JavaScript floats or mixes
currencies.

## Query and security properties

- Appointment status counts are one aggregate over indexed `start_at` ranges.
- Patient totals are two bounded `count(*)` queries.
- Doctor active count is a `count`/`count(distinct)` query; workload is a
  `GROUP BY doctor` aggregate. Full appointment histories are never loaded.
- Every operational query runs inside `withTenantTransaction`, adding both the
  explicit `tenant_id` predicate and forced PostgreSQL RLS.
- Branch and date/timezone validation uses the Phase 19.9 rules before any
  dashboard query executes.
- No patient id, name, contact or clinical field is selected. Doctor workload
  exposes only professional identity (`doctorId`, `doctorCode`, name) and counts.
- The service has no write path and does not expose an API route in this phase.

## Tests

`src/modules/dashboard/dashboard.service.vitest.test.ts` covers:

- Appointment status counts, upcoming logic and doctor workload.
- Patient totals and timezone-sensitive new registrations.
- Branch and date-range filters, plus foreign-branch rejection.
- Timezone boundary changes (`Asia/Kolkata` vs `UTC`).
- Decimal-string revenue, collections, refunds, net and pending invoices.
- `reports:read` enforcement and invalid range/timezone rejection.
- Complete empty-tenant zero results with empty currency arrays.
- Tenant isolation and RLS under the restricted `hospitalos_app` role.

`src/modules/dashboard/dashboard.routes.vitest.test.ts` covers the HTTP layer:

- `401` for unauthenticated requests and `403` for a member without permissions,
  on every endpoint.
- Per-section permissions: `accountant` (no `doctor:read`) is denied
  `/doctors`; `doctor` (no `payment:read`) is denied `/financial`; the
  operational view omits the sections they cannot read.
- Response values for appointments, patients, doctors and decimal financial
  totals, including the timezone boundary (`Asia/Kolkata` vs `UTC`).
- Branch filters, hospital-wide patient totals, invalid query parameters
  (date, reversed/oversized range, UUID, IANA zone) and foreign-branch `404`.
- Cross-tenant isolation: the other hospital sees only its own data, and a
  branch of the first hospital is `404` from the second.

Focused runs:

```bash
npx vitest run src/modules/dashboard/dashboard.service.vitest.test.ts \
  src/modules/dashboard/dashboard.routes.vitest.test.ts
```
