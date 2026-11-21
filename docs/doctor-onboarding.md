# Doctor onboarding (ONB-08)

This repository is the **API only**. The web client must implement the Add Doctor
wizard against the contracts below.

## 1. The circular dependency and its resolution

A doctor profile may only be attached to an existing global account that is:

1. active;
2. an `ACTIVE` member of the current hospital;
3. holding the hospital-scoped `doctor` role;
4. not already linked to a doctor profile in that hospital.

A newly invited account is not eligible until the invitation is accepted. The
Add Doctor screen therefore cannot create a profile in the same request as the
invitation. ONB-08 resolves this with two paths:

- **Existing HospitalOS user:** search eligible active members and select one.
- **New user:** invite them through ONB-07A, wait for acceptance, then select the
  now-eligible member and create the profile.

No user, invitation or membership table is duplicated, and doctor creation never
creates an account.

## 2. Eligible members API

### `GET /api/v1/doctors/eligible-members`

Requires tenant context and `doctor:create`. This is intentionally the same
permission as profile creation: an actor who cannot create a profile cannot
enumerate candidates for it.

Query parameters:

| Name | Rules |
| --- | --- |
| `search` | Optional case-insensitive match on full name or email, max 100. |
| `page` | Default `1`. |
| `limit` | Default `20`, max `100`. |

```json
{
  "data": {
    "members": [
      {
        "userId": "uuid",
        "membershipId": "uuid",
        "fullName": "Dr. Ada",
        "email": "ada@example.com",
        "phone": "+1 555 0100",
        "joinedAt": "2026-11-21T09:00:00.000Z",
        "branchIds": ["uuid"],
        "departmentIds": ["uuid"],
        "roles": [{ "id": "uuid", "slug": "doctor", "name": "Doctor" }]
      }
    ]
  },
  "meta": {
    "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
  }
}
```

Only `ACTIVE` memberships of active global users appear. A member with no doctor
role, an `INVITED`/`SUSPENDED`/`REMOVED` membership, or any existing doctor row —
including a soft-deleted one, because the uniqueness constraint still reserves
that membership — is excluded. No credentials or token material is returned.

The membership's `branchIds` and `departmentIds` are the assignments captured by
ONB-07A and can prefill the wizard. They are not a substitute for the doctor
profile's own department and branch assignments.

## 3. Doctor profile creation

`POST /api/v1/doctors` is unchanged in shape and still requires `doctor:create`:

```json
{
  "userId": "uuid",
  "doctorCode": "DOC-001",
  "registrationNumber": "REG-001",
  "departmentIds": ["uuid"],
  "branches": [{ "branchId": "uuid", "consultationFee": "150.00" }]
}
```

Server-side validation:

- the user must exist, be active, and have an `ACTIVE` membership in the current
  tenant;
- the membership must hold a hospital-scoped role with slug `doctor`;
- `doctorCode` and `registrationNumber` are unique per tenant;
- only one live or soft-deleted doctor row may exist per tenant/user, so a second
  profile returns `409`;
- departments and branches are tenant-owned and active;
- every assigned branch must be covered by at least one assigned department;
- tenant identity always comes from the verified session, never the body;
- all checks and writes run in one tenant-scoped RLS transaction.

Existing schedules and appointment references are untouched by profile
creation; the profile id is never replaced.

## 4. Frontend wizard contract

### Stage 1 — Account

1. Search `GET /doctors/eligible-members`.
2. If an existing candidate is chosen, continue to Stage 2 with `userId`.
3. If no candidate exists, collect name/email and call the ONB-07A invitation
   endpoint with the `doctor` role and any initial branch/department assignments.
4. Show the invitation as `INVITED`; do not attempt profile creation yet.
5. After acceptance, refresh eligible members and continue.

Use `GET /tenant/staff/invitations` for invitation status and resend/revoke
actions. Accepted invitations are linked to their membership.

### Stage 2 — Professional details

Collect doctor code, registration number/council, qualification,
specialization, experience, biography, profile image URL and languages. The
doctor code may be suggested but must remain editable.

### Stage 3 — Assignments

Select departments and branches and set each branch's consultation fee/currency.
Show a clear error when a branch lacks coverage from the selected departments.
Prefill from the member's `branchIds`/`departmentIds` where possible.

### Stage 4 — Review and submit

Create the profile with `POST /doctors`. Handle:

- `409` — duplicate doctor profile or duplicate code/registration number;
- `400` — missing membership/account/doctor role or foreign assignments;
- `422` — inactive/deleted assignments or invalid branch coverage;
- a stale eligibility result — return to Stage 1 and refresh.

On success, show the created profile and remove the member from the eligible
list. The client should not retry the creation blindly after a network failure;
refresh eligible members and the doctor list first.

## 5. Tests

`src/modules/doctors/doctor.onboarding.integration.vitest.test.ts` covers the
full invite → accept → eligible → create → duplicate path. The doctor service and
route suites cover role rejection, unexpected memberships, tenant isolation,
uniqueness, branches/departments, and RBAC.
