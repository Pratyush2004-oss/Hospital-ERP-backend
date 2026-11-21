# Platform administration console (ONB-06)

This repository is the **API only**. There is no web application, shared UI
component library, or frontend router here, so the Platform Admin Console
layout and pages cannot be created in this repository. The backend contracts and
gaps below are the source of truth for the separate web client.

## 1. Existing platform API contract

All routes are mounted under `/api/v1/platform`. They require a valid session,
a platform-plane actor from `platform_user_roles`, and the listed permission.
They are separate from every tenant-scoped route.

| Method | Path | Permission | CSRF | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/platform/tenants` | `tenant:read` | n/a | `{ tenants: TenantSummary[] }` |
| POST | `/api/v1/platform/tenants` | `tenant:create` | required | `201 { tenant, membershipId, defaultRoleId }` |
| POST | `/api/v1/platform/tenants/:tenantId/activate` | `tenant:suspend` | required | `{ tenant }` |
| POST | `/api/v1/platform/tenants/:tenantId/suspend` | `tenant:suspend` | required | `{ tenant }` |

`TenantSummary` currently contains:

```json
{
  "id": "uuid",
  "name": "Hospital name",
  "slug": "hospital-slug",
  "legalName": "Legal name or null",
  "email": "contact@example.com or null",
  "phone": "contact phone or null",
  "status": "PENDING",
  "timezone": "America/New_York",
  "createdAt": "2026-11-21T09:00:00.000Z"
}
```

`status` is one of `PENDING`, `ACTIVE`, `SUSPENDED`, `INACTIVE`. There is no
`REJECTED` state and no rejection endpoint.

`GET /platform/tenants` returns **every** hospital sorted by name. It does not
accept or apply `search`, `status`, `page`, or `limit` parameters, and there is
no single-tenant detail endpoint. The console can derive an overview count and
client-side filtering/pagination from this list, but the API does not provide
server-side filtering or pagination.

`activate` and `suspend` accept **no request body**. There is no reason field,
reason schema, or approval-notes field. Mandatory reasons cannot be implemented
against the current contract without inventing one.

Activating a hospital from `PENDING` sends the ONB-05 activation email and
writes `hospital.status_changed`. The platform-side response is the updated
tenant only.

## 2. Authentication and authorization

- Platform identity is resolved exclusively from `platform_user_roles` joined to
  a role whose scope is `PLATFORM`.
- Hospital registration and tenant-level role assignment never create a
  `platform_user_roles` row. The seeded platform role is `platform_super_admin`;
  hospital roles do not include `tenant:create`, `tenant:suspend`, or
  `tenant:delete`.
- `requirePlatformContext` rejects a tenant actor even if the account is also a
  hospital administrator. `requireTenant` rejects a platform actor.
- Anonymous calls receive `401`; hospital administrators calling platform routes
  receive `403`.
- Platform routes require CSRF for state-changing POST requests, same as the rest
  of the cookie-authenticated API.

There is no frontend navigation to hide in this repository. The API guards above
remain effective even if a browser navigates directly to a platform URL, but a
separate web client must also route-guard platform pages and keep platform
navigation out of the Hospital Admin Console.

## 3. Audit history

Activation and suspension write `hospital.status_changed` audit rows with
`previousState`, `newState`, tenant id, actor id/scope, request metadata and
timestamp. The audit table is append-only.

There is currently **no platform audit read API**. `GET /api/v1/audit` requires a
tenant context and `audit:read`; it rejects a platform actor with `403` and never
returns cross-tenant rows. A hospital administrator can read its own hospital's
`hospital.status_changed` history after selecting that hospital.

Consequently, the console cannot display cross-tenant activation/suspension
history using the existing API. Implementing that would require a new
platform-scoped audit endpoint; per ONB-06 this gap is documented rather than
invented here.

## 4. Capability matrix for ONB-06

| Console requirement | Existing capability | Status |
| --- | --- | --- |
| Separate platform layout/navigation | None (API-only repository) | Blocked: no frontend |
| Overview dashboard | Derive counts from `GET /platform/tenants` | Possible client-side; no aggregate API |
| Approval queue search/filter/pagination | Full list only | Client-side only; no query parameters |
| Tenant detail/review | List item fields | Possible from list; no detail endpoint |
| Activate/suspend | Existing POST routes | Available |
| Confirmation dialogs | Frontend concern | Blocked: no frontend |
| Mandatory reasons | No request contract supports reasons | Not available |
| Status and registration date | `status`, `createdAt` | Available |
| Activation/suspension history | Audit rows exist, no platform read API | Not available through API |
| Relevant audit events | Tenant audit only, platform rejected | Not available platform-wide |
| Loading/empty/error/success/permission states | Frontend concern | Blocked: no frontend |
| Responsive HospitalOS UI | No UI system in repository | Blocked: no frontend |
| Direct URL protection | Backend guards enforce 401/403 | Backend protected; frontend routing absent |

## 5. Tests

`src/modules/tenancy/tenancy.test.ts` covers:

- anonymous and hospital-administrator rejection from platform routes;
- platform create/activate/suspend and tenant-plane separation;
- tenant audit visibility of `hospital.status_changed` (`PENDING` → `ACTIVE`);
- platform rejection from the tenant audit API, preventing cross-tenant history.

The DB-backed suite requires PostgreSQL and cannot run in the current
environment (connection refused on `localhost:5432`).
