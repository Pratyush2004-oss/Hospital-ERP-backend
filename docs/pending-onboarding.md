# Pending hospital onboarding (ONB-05)

This document describes the API-side onboarding status experience. The
repository contains the API only; the web client must render
`/onboarding/status` from the contract below.

## 1. Status model

Hospital and membership status are separate values.

| Value | Source | Meaning |
| --- | --- | --- |
| `PENDING` | `tenants.status` | Self-service registration is awaiting platform review. |
| `ACTIVE` | `tenants.status` | The hospital can be selected and used. |
| `SUSPENDED` | `tenants.status` | A previously active hospital is unavailable. |
| `INACTIVE` | `tenants.status` | Existing schema value; no onboarding flow currently sets it. |

There is **no `REJECTED` tenant status** in the current schema or platform API.
Approval and rejection timelines must not be invented. The platform API only
supports activation and suspension. Pending registrations therefore surface as
`PENDING`, `ACTIVE`, `SUSPENDED`, or `INACTIVE`.

A self-service registration creates:

- a tenant with `status = PENDING`;
- an `ACTIVE` membership for the founding account;
- the `hospital_admin` role for that membership.

The membership is active from the start; the hospital itself is not. This is why
a pending founder can read their own onboarding status but cannot enter hospital
operations.

## 2. API contract

### `GET /api/v1/tenants/onboarding`

Requires an authenticated account. No CSRF token is needed for a `GET`.
Returns only hospitals where the caller holds a membership, enforced both by the
query predicate and by PostgreSQL RLS user context.

```json
{
  "data": {
    "registrations": [
      {
        "tenantId": "uuid",
        "tenantName": "St. Mary's General",
        "tenantSlug": "st-marys-general",
        "registrationReference": "uuid",
        "status": "PENDING",
        "submittedAt": "2026-11-21T09:00:00.000Z",
        "legalName": "St. Mary's General LLC",
        "email": null,
        "phone": null,
        "timezone": "America/New_York",
        "membershipId": "uuid",
        "membershipStatus": "ACTIVE",
        "joinedAt": "2026-11-21T09:00:00.000Z",
        "selectable": false
      }
    ],
    "supportEmail": "support@example.com"
  }
}
```

- `registrationReference` is the tenant UUID and is the stable reference shown in
  the UI. `tenantSlug` is the human-readable identifier used for selection.
- `submittedAt` is the existing tenant creation timestamp.
- `selectable` is `true` only when `status = ACTIVE` and
  `membershipStatus = ACTIVE`.
- `supportEmail` comes from the configured `AUTH_MAIL_REPLY_TO`; it is `null`
  when no support address is configured. No placeholder address is generated.
- Approval notes, reviewer identity, platform audit data and other
  administrative fields are never selected or returned.

### `GET /api/v1/tenants/memberships`

Each membership now includes `selectable` using the same rule. `PENDING`
hospitals remain in the list so the web client can show them in a disabled
selector state.

### `POST /api/v1/tenants/select`

Selection still requires an `ACTIVE` tenant and an `ACTIVE` membership. A
`PENDING` hospital returns `403` and the session's active tenant is unchanged.
Hospital-scoped routes under `/api/v1/tenant/*` require tenant context, so a
pending user receives `403` even if frontend checks are bypassed.

## 3. Activation email

When a platform operator changes a hospital from `PENDING` to `ACTIVE`,
`setTenantStatus` sends an activation email after the status transaction
commits.

Recipients are the hospital's active accounts holding the seeded
`hospital_admin` role. The email:

- uses the shared ONB-03 auth-mail adapter and provider configuration;
- has kind `HOSPITAL_ACTIVATED`;
- links to `${FRONTEND_URL}/onboarding/status?tenant=<slug>`;
- contains no token, approval note or reviewer information.

Delivery is best-effort. A provider failure is recorded as
`auth.email.delivery_failed` and does not roll back the activation. Successful
delivery is audited as `hospital.activation_email_sent`. Re-activating an
already active hospital does not send another email. If no active hospital
administrator exists, activation still succeeds and no message is sent.

## 4. Web client states

| API state | UI |
| --- | --- |
| `PENDING` | Show hospital name, reference, submission date, "pending review"; no hospital navigation. Refresh re-calls `GET /tenants/onboarding`. |
| `ACTIVE` + `selectable` | Show approval state and a "Select hospital / continue setup" action using `tenantSlug`. |
| `SUSPENDED` / `INACTIVE` | Show unavailable state and support action; selection is disabled. |
| `supportEmail` present | Render the configured support action. Omit it when `null`. |
| empty `registrations` | Redirect to hospital registration, not an empty dashboard. |

The web client should call this endpoint when a signed-in account has no active
hospital context, including after login and after an activation refresh.
