# Audit Log API (Phase 21.2)

Read-only access to the append-only audit trail created in Phase 21.1. There are
no create, update or delete endpoints; only the server-side audit service writes
records.

## Endpoints

All routes are under `API_PREFIX` (default `/api/v1`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/audit-logs` | Paginated audit list with filters and sorting. |
| `GET` | `/audit-logs/recent` | Newest activity for the hospital or one branch. |
| `GET` | `/audit-logs/:auditLogId` | One audit record. |

Success responses use the standard envelope:

```json
{
  "data": {
    "auditLogs": [
      {
        "id": "b0e0...",
        "branchId": null,
        "actorUserId": "a111...",
        "actorScope": "TENANT",
        "action": "patient.created",
        "module": "patients",
        "resourceType": "patient",
        "resourceId": "p222...",
        "description": "Patient registered",
        "previousState": null,
        "newState": { "status": "ACTIVE" },
        "metadata": { "safe": "kept" },
        "requestId": "6f1c...",
        "ipAddress": "127.0.0.1",
        "userAgent": "Mozilla/5.0 ...",
        "createdAt": "2026-11-20T10:00:00.000Z"
      }
    ]
  },
  "meta": {
    "requestId": "6f1c...",
    "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
  }
}
```

`/audit-logs/recent` returns `{ "activity": [...] }` with the same entry shape
and no pagination metadata. Detail returns `{ "auditLog": {...} }`.

## Permission and authorization

Every route requires:

1. a valid session (`authenticate`) in the hospital plane (`requireTenant`), and
2. the `audit:read` permission.

`audit:read` is seeded by migration `0031_audit_read_api.sql` and granted by
default to the system roles:

| Role | `audit:read` |
| --- | --- |
| `hospital_admin` | yes |
| `branch_admin` | yes |
| all other seeded roles | no |

Custom roles can receive `audit:read` through the existing role-permission API.
Platform sessions are rejected by `requireTenant`; there is no cross-tenant
platform audit endpoint in this phase.

The tenant id is always the verified session's active tenant. The API has no
`tenantId` parameter and rejects unknown query parameters, so a client-supplied
tenant id is a `422` rather than being silently ignored.

## Filters

All list filters are optional and combine with `AND`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `page` | integer ≥ 1, default `1` | 1-based page. |
| `limit` | integer 1–100, default `20` | Page size. |
| `actorUserId` | UUID | Events performed by this user. |
| `branchId` | UUID | Events scoped to one branch of the caller's hospital. |
| `module` | string ≤ 60 | Exact module, e.g. `patients`, `billing`, `auth`. |
| `action` | string ≤ 120 | Exact dotted action, e.g. `patient.created`. |
| `resourceType` | string ≤ 100 | Exact resource kind, e.g. `invoice`. |
| `resourceId` | string ≤ 200 | Exact resource identifier. |
| `from` | ISO 8601 instant | Inclusive lower `created_at` bound. |
| `to` | ISO 8601 instant | Inclusive upper bound; must be ≥ `from`. |
| `sortOrder` | `asc` or `desc`, default `desc` | Timestamp order. |

`from`/`to` require an explicit offset (`Z` or `±HH:MM`), for example
`2026-11-01T00:00:00Z`. Invalid values, reversed ranges, malformed UUIDs and
unknown parameters return `422 VALIDATION_ERROR`.

`/audit-logs/recent` accepts only `limit` (1–100, default `20`) and an optional
`branchId`.

### Branch boundaries

A `branchId` must belong to the caller's hospital. A branch from another
hospital returns `404 Branch not found`, the same as a missing branch. A branch
filter matches events whose `branch_id` is exactly that branch; hospital-wide
events with `branch_id = NULL` are excluded.

**Known limitation:** hospital memberships are not branch-scoped in this
codebase. A `branch_admin` therefore has `audit:read` across the whole hospital,
and can query any branch of that hospital (or omit `branchId`). There is no
membership-to-branch assignment to enforce a narrower boundary. Tenant isolation
is enforced regardless.

## Sensitive data

Audit rows are redacted when written. The API applies the same redaction again
when reading, so legacy or out-of-band rows cannot expose credentials, tokens,
API keys, card data, contact details, addresses or clinical free text. Sensitive
keys are replaced with `[REDACTED]` at every nesting level. The internal
`dedupe_key` is never returned.

## Read-only and tenant isolation

- There are no routes for `POST`, `PUT`, `PATCH` or `DELETE`; such requests get
  `404` and cannot alter a row.
- Every query includes `tenant_id = <verified tenant>`, and PostgreSQL RLS is
  enabled and forced on `audit_logs`.
- Another tenant's audit id or branch id returns `404`, not `403`, so existence
  is not disclosed.
- The append-only `audit_logs_immutable` trigger remains the final database
  guard against UPDATE/DELETE.

## Performance

The list query performs a bounded `count(*)` and one `limit`/`offset` page in
parallel; it never loads a complete history. Ordering is `created_at` plus `id`
for a stable page. Indexes used by the API:

- `(tenant_id, created_at)` — timeline and date ranges.
- `(tenant_id, module, created_at)` — module filter.
- `(tenant_id, action, created_at)` — action filter.
- `(tenant_id, resource_type, resource_id, created_at)` — resource type + id.
- `(tenant_id, resource_id, created_at)` — resource id alone.
- `(tenant_id, actor_user_id, created_at)` — actor filter.
- `(tenant_id, branch_id, created_at)` — branch filter/recent activity.

## Tests

`src/modules/audit/audit.api.vitest.test.ts` covers listing, pagination, all
filters, date ranges, ascending order, detail retrieval, recent hospital/branch
activity, RBAC (`401`/`403`), cross-tenant and cross-branch `404`, read-side
redaction, rejected tenant parameters, absent write routes, and RLS as the
restricted `hospitalos_app` role.

Focused run:

```bash
npx vitest run src/modules/audit/audit.api.vitest.test.ts
```
