# Doctor Scheduling — Authorization and Security

This document describes the RBAC, tenant/branch isolation and security model of
the doctor scheduling module (schedules, breaks and leave). It reflects Task
16.6 and the existing HospitalOS authorization architecture; it does not define
a new one.

## 1. Permission catalogue

Scheduling uses the fine-grained keys below. Keys are global catalogue rows
(`permissions` table, unique `permission_key`) and are seeded idempotently by
`seedPermissionCatalogue` / `seedTenantRbac`; re-running the seed never creates
duplicates or removes custom grants.

| Permission | Purpose |
| --- | --- |
| `schedule.create` | Create recurring doctor schedule windows |
| `schedule.read` | View recurring schedule windows |
| `schedule.update` | Edit schedules and toggle active status |
| `schedule.delete` | Delete schedule windows |
| `schedule.break.create` | Add breaks inside a schedule window |
| `schedule.break.read` | View breaks |
| `schedule.break.update` | Edit breaks |
| `schedule.break.delete` | Delete breaks |
| `doctor.leave.create` | Request leave (own, or for another doctor with management access) |
| `doctor.leave.read` | View leave requests |
| `doctor.leave.update` | Edit pending leave requests |
| `doctor.leave.approve` | Approve pending leave |
| `doctor.leave.reject` | Reject pending leave |
| `doctor.leave.cancel` | Cancel leave |

The legacy broad key `doctor:schedule` remains in the catalogue for backwards
compatibility, but scheduling endpoints authorize against the keys above.

## 2. Default role matrix

| Role | Schedules | Breaks | Leave |
| --- | --- | --- | --- |
| `hospital_admin` | create/read/update/delete | full | full, including all-branch decisions |
| `branch_admin` | create/read/update/delete | full | create/read/update/approve/reject/cancel; all-branch decisions rejected |
| `doctor` | read | read | create/read/update/cancel for **own** requests only; no approval |
| `receptionist` | read | read | read |
| `nurse` | read | read | none |
| `accountant`, `pharmacist`, `lab_technician` | none | none | none |

Custom hospital roles can be granted any catalogue key through
`POST /tenant/roles` and `PUT /tenant/roles/:roleId/permissions`. Permission
resolution happens per request, so a grant takes effect without re-login.

## 3. Endpoint authorization

| Method | Endpoint | Permission |
| --- | --- | --- |
| POST | `/doctor-schedules` | `schedule.create` |
| GET | `/doctor-schedules`, `/doctor-schedules/:id` | `schedule.read` |
| PATCH | `/doctor-schedules/:id`, `/doctor-schedules/:id/status` | `schedule.update` |
| DELETE | `/doctor-schedules/:id` | `schedule.delete` |
| POST | `/doctor-breaks` | `schedule.break.create` |
| GET | `/doctor-breaks`, `/doctor-breaks/:id` | `schedule.break.read` |
| PATCH | `/doctor-breaks/:id` | `schedule.break.update` |
| DELETE | `/doctor-breaks/:id` | `schedule.break.delete` |
| POST | `/doctor-leaves` | `doctor.leave.create` |
| GET | `/doctor-leaves`, `/doctor-leaves/:id` | `doctor.leave.read` |
| PATCH | `/doctor-leaves/:id` | `doctor.leave.update` |
| PATCH | `/doctor-leaves/:id/approve` | `doctor.leave.approve` |
| PATCH | `/doctor-leaves/:id/reject` | `doctor.leave.reject` |
| PATCH | `/doctor-leaves/:id/cancel` | `doctor.leave.cancel` |

Route guards are coarse gates. The leave service additionally enforces:

- a doctor may create/edit/cancel only their own leave;
- creating/editing another doctor's leave requires a management key
  (`doctor.leave.approve`, `doctor.leave.reject` or `doctor:update`);
- self-approval is rejected unless the tenant setting
  `doctor_leave.allow_self_approval` is enabled;
- only PENDING requests can be approved, rejected or edited;
- a branch administrator cannot approve/reject/cancel all-branch leave.

## 4. Tenant isolation

- The tenant always comes from the verified session context, never from the
  URL, query string or body.
- Every service query is tenant-scoped in SQL and runs inside a
  `withTenantTransaction` that sets transaction-local RLS context.
- `doctor_schedules`, `doctor_breaks` and `doctor_leaves` have RLS enabled and
  forced; the API connects as the restricted `hospitalos_app` role (not owner,
  not superuser, no `BYPASSRLS`).
- Cross-tenant reads, updates and deletes affect zero rows and surface as 404
  (break deletion is an idempotent 204 no-op). Cross-tenant inserts are rejected
  by the RLS `WITH CHECK`.
- Branch IDs supplied in filters only narrow within the tenant; a foreign branch
  filter returns an empty list.

## 5. Branch-level access

**Current limitation:** hospital memberships are tenant-scoped only. There is
no membership-to-branch assignment table, and the tenant scope carries no branch
list. As a result `branch_admin` can act on any branch in its hospital; the
service cannot verify that a branch administrator is authorized for a specific
branch. This is not worked around with role-name checks or client-supplied
branch IDs.

What *is* enforced:

- a schedule can only be created for a branch the doctor is actively assigned to
  (`doctor_branches` composite foreign key plus service check);
- the doctor and branch must both belong to the caller's tenant;
- branch administrators cannot decide all-branch leave;
- filters never bypass the tenant boundary.

Introducing membership-level branch scoping requires a schema change
(membership↔branch assignments), propagation into `TenantScope`, and a
backfill — deliberately deferred.

## 6. Scheduling consistency

- Inactive schedule windows are never treated as available and reject new
  breaks.
- Breaks must sit entirely inside their parent window and may not overlap
  (GiST exclusion constraint, enforced in the database and the service).
- Active schedule windows may not overlap; the service returns 409 and the
  database exclusion constraint covers concurrency.
- Inactive and soft-deleted doctors cannot receive new schedules.
- Leave transitions are PENDING → APPROVED/REJECTED/CANCELLED only; APPROVED
  records remain stored for future availability calculations.
- `branch_id IS NULL` marks all-branch leave, distinct from branch-specific
  leave.
- Schedule/break times stay branch-local wall-clock values; leave timestamps
  remain offset-bearing absolute instants.

## 7. Verification

Covered by `scheduling.security.vitest.test.ts` plus the route/service suites:

- permission catalogue and role matrix (HTTP `/tenant/roles`);
- custom roles receiving and exercising new permissions;
- receptionist/nurse/doctor denials;
- cross-tenant schedule, break and leave access;
- branch-admin all-branch leave restriction;
- RLS as the restricted app role, including cross-tenant write attempts and
  pool-context leakage;
- idempotent permission seeding;
- schedule/break/leave consistency rules.

## 8. Known limitations

1. Branch-scoped membership (see section 5) is not implemented.
2. `schedule.read` / `schedule.break.read` / `doctor.leave.read` are
   tenant-wide. Doctors can read the roster and leave list; writes and leave
   cancellation remain ownership/management-restricted. Row-level self-filtering
   for reads is not implemented because the existing permission model has no
   "own vs all" read distinction.
3. Existing tenants receive new default-role grants when their RBAC is reseeded
   (`npm run db:seed` / provisioning). The permission rows themselves are
   global and upserted on every bootstrap.
4. No audit table exists; leave history is preserved by status transitions.
