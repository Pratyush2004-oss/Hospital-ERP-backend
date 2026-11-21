# Staff memberships and invitations (ONB-07A)

This repository is the **API only**. The staff invitation and membership
screens, expired-invitation page, and invitation acceptance UI must be built in
the separate web client against the contracts below.

## 1. Lifecycle

| State | Where | Meaning |
| --- | --- | --- |
| `INVITED` | `tenant_memberships.status`, or derived invitation status | An existing account has a membership waiting for acceptance. A new account has only the invitation token until acceptance. |
| `ACTIVE` | `tenant_memberships.status` | Invitation was accepted and the membership is usable. |
| `EXPIRED` | derived from `expires_at` | The token can no longer be accepted. A new token can be issued with resend. |
| `REVOKED` | `revoked_at` | An operator revoked the invitation. |
| `ACCEPTED` | derived from `used_at` | The token was consumed. The membership is active. |
| `REMOVED` | membership status | An invitation-only membership was revoked before acceptance. |

For an existing account, inviting creates a membership in `INVITED` status
immediately. For a new email, no global account is created at invite time: the
account and active membership are created only when the token is accepted. This
avoids placeholder accounts and duplicate identities. Acceptance links the
token to the resulting membership so an accepted invitation can be correlated
with the staff member it created.

Revoking reverses an unaccepted `INVITED` membership to `REMOVED`. A later
explicit invitation for the same existing account reopens that membership as
`INVITED`; suspended memberships are never silently reinstated this way.

Token material reuses `auth_email_tokens` (ONB-03). No duplicate invitation table
was added. New columns store the invited display name, linked membership,
department ids and branch ids. Tokens remain hashed, expiring and single-use.

## 2. API contracts

### `POST /api/v1/tenant/staff/invitations`

Requires tenant context, CSRF, and `staff:create`. If `roleIds` is non-empty the
caller must also have `staff:assign_role`.

```json
{
  "email": "doctor@example.com",
  "fullName": "Dr. Ada",
  "roleIds": ["uuid"],
  "departmentIds": ["uuid"],
  "branchIds": ["uuid"]
}
```

Returns `202 { invitation: { invitationId, email, expiresAt, membershipId, status } }`.
`membershipId` is non-null only when an existing account received an `INVITED`
membership.

### `GET /api/v1/tenant/staff/invitations`

Requires `staff:read`. Returns `{ invitations: [...] }` newest first:

```json
{
  "id": "uuid",
  "email": "doctor@example.com",
  "fullName": "Dr. Ada",
  "status": "INVITED",
  "createdAt": "...",
  "expiresAt": "...",
  "membershipId": "uuid or null",
  "membershipStatus": "INVITED or null",
  "invitedByName": "Admin Name",
  "roleIds": ["uuid"],
  "departmentIds": ["uuid"],
  "branchIds": ["uuid"],
  "roles": [{ "id": "uuid", "slug": "doctor", "name": "Doctor" }],
  "departments": [{ "id": "uuid", "name": "Cardiology" }],
  "branches": [{ "id": "uuid", "name": "Main Branch" }]
}
```

Raw tokens are never included.

### `POST /api/v1/tenant/staff/invitations/:invitationId/resend`

Requires `staff:create`. Revokes the previous token, issues a new token/expiry
with the same membership and assignments, and sends a new email. Returns `202`
with the new invitation. Accepted, revoked and non-`INVITED` invitations cannot
be resent; a revoked invitation is superseded by sending a new invitation.

### `POST /api/v1/tenant/staff/invitations/:invitationId/revoke`

Requires `staff:create`. Revokes the token; if it created an `INVITED`
membership, that membership becomes `REMOVED`. Returns `204`. Accepted
invitations cannot be revoked.

### `POST /api/v1/auth/invitations/details`

Public, IP rate-limited, token in the JSON body (never the URL). Returns:

```json
{
  "valid": true,
  "status": "INVITED",
  "hospitalName": "St. Mary's General",
  "email": "d***@example.com",
  "fullName": "Dr. Ada",
  "expiresAt": "...",
  "requiresPassword": true,
  "roles": [{ "slug": "doctor", "name": "Doctor" }],
  "departments": [{ "name": "Cardiology" }],
  "branches": [{ "name": "Main Branch" }]
}
```

`valid` is true only for `INVITED`. Invalid tokens return `valid: false` and
`status: "INVALID"`. Expired/revoked/accepted tokens return their status so the
client can show the correct screen. The email is masked and no tenant id,
membership id, inviter id or raw token is returned.

### `POST /api/v1/auth/invitations/accept`

Public, IP rate-limited, body `{ token, fullName?, password? }`.

- Existing account: `fullName`/`password` are ignored; the invited email must
  still match the account.
- New account: `fullName` and `password` are required.
- The token is consumed once, the `INVITED` membership is activated (or created
  active for a new account), and hospital-scoped roles are granted.
- Reused, expired, revoked and cross-purpose tokens return `400`.

### `GET /api/v1/tenant/memberships`

Requires `staff:read`. Memberships now include `branchIds` and `departmentIds`
alongside their `INVITED`, `ACTIVE`, `SUSPENDED` or `REMOVED` status.

## 3. Validation and security

- Role ids must be `HOSPITAL` roles of the inviting tenant.
- Department and branch ids must be active, non-deleted rows of the inviting
  tenant.
- `staff:create` alone cannot assign roles; `staff:assign_role` is required.
- Role assignment is repeated inside acceptance with the same hospital-scope
  predicate; platform roles can never be attached to a membership.
- Existing accounts are reused by case-insensitive email; no duplicate user is
  created.
- The invited email identity is checked during acceptance.
- Tenant-scoped resend/revoke cannot address another hospital's invitation
  (404).
- Tokens are 32 random bytes, stored as SHA-256 hashes, single-use, expiring and
  never logged or returned in production responses.
- Audit events: `auth.invitation.sent`, `auth.invitation.resent`,
  `auth.invitation.revoked`, `auth.invitation.accepted`, `membership.invited`
  and `membership.activated`.

## 4. Branch access rules

Invitation management is branch-scoped from the acting membership:

- An actor with no `branchIds` is hospital-wide and may invite into any branch.
- An actor with `branchIds` may only invite into branches in that set. A
  branchless (hospital-wide) invitation is rejected with `403`.
- Listing hides invitations that contain any branch outside the actor's set.
- Resending or revoking such an invitation returns `404`, so a branch manager
  cannot probe other branches.
- In-scope invitation management remains subject to `staff:create` /
  `staff:read` and, for role assignment, `staff:assign_role`.

Branch and department ids are also validated against the tenant on create,
resend and acceptance. Department and branch assignments are stored on the
membership.

Operational modules (appointments, patients, schedules, billing) remain
hospital-wide in this codebase; this task does not retrofit branch filters into
those unrelated modules. The invitation boundary above is enforced, but it does
not make every clinical API branch-aware.

## 5. Test coverage

`src/modules/auth/staff.invitation.integration.vitest.test.ts` covers existing
and new accounts, `INVITED` membership visibility, activation on acceptance,
token details, masked email, resend, revoke, expiry, replay, cross-tenant
management, branch-scoped visibility/management and the `staff:create` /
`staff:assign_role` split.
