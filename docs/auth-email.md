# Transactional authentication email (ONB-03)

Email verification, password-reset delivery, staff invitations and hospital
activation notices share one transactional adapter. Tokens are opaque, expiring, single-use, and only their
SHA-256 hash is stored. Raw tokens appear only in the emailed link (and, for
development convenience, in non-production reset responses).

## 1. Components

| File | Responsibility |
| --- | --- |
| `src/modules/auth-mail/auth-mail.types.ts` | Shared contract: kinds, provider interface, delivery result, frontend paths. |
| `src/modules/auth-mail/auth-mail.templates.ts` | Branded HTML + plain-text templates for all three mail kinds. |
| `src/modules/auth-mail/auth-mail.providers.ts` | `none`, `mock` (in-memory outbox) and `real` (Resend HTTP) adapters. |
| `src/modules/auth-mail/auth-mail.service.ts` | Link building, rendering, delivery and failure reporting. |
| `src/modules/auth/auth.email.service.ts` | Verification, resend, reset delivery, invitation issue/accept workflows. |
| `src/database/schema/auth-email-tokens.ts` | Hashed verification/invitation tokens (migration `0032_careful_dust`). |

The existing `password_reset_tokens` table and `auth.tokens.ts` helpers are
reused: reset tokens keep the same SHA-256 + single-use rules, and verification
and invitation tokens use the same generator.

## 2. Provider modes

| Mode | Behaviour | Allowed in production |
| --- | --- | --- |
| `none` | Delivery suppressed; a warning is logged. Registration still succeeds. | No |
| `mock` | Deterministic in-memory delivery, no network. Used by tests. | No |
| `real` | `POST {AUTH_MAIL_API_BASE_URL}/emails` via Resend. | Yes, required |

`createApp()` startup fails if `NODE_ENV=production` selects `none` or `mock`,
or if `real` is selected without `AUTH_MAIL_RESEND_API_KEY` or with a
`.invalid` From address. The same guard is covered by unit tests.

## 3. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_MAIL_PROVIDER` | `none` | `none`, `mock` or `real`. |
| `AUTH_MAIL_FROM_EMAIL` | `no-reply@hospitalos.invalid` | Verified sender address for `real`. |
| `AUTH_MAIL_FROM_NAME` | `HospitalOS` | Display name on the From header. |
| `AUTH_MAIL_REPLY_TO` | empty | Optional Reply-To and support address. |
| `AUTH_MAIL_RESEND_API_KEY` | empty | Resend API key; required for `real`. |
| `AUTH_MAIL_API_BASE_URL` | `https://api.resend.com` | Provider API base URL. |
| `AUTH_MAIL_TIMEOUT_MS` | `5000` | Per-send timeout. |
| `AUTH_EMAIL_VERIFICATION_TTL_MINUTES` | `1440` | Verification link lifetime. |
| `AUTH_INVITATION_TTL_HOURS` | `168` | Invitation link lifetime. |
| `AUTH_EMAIL_RESEND_COOLDOWN_SECONDS` | `60` | Duplicate-request guard per address (verification, invitation and password reset). |

Frontend links are built from `FRONTEND_URL` (already used for CORS):

| Mail | Link |
| --- | --- |
| Verification | `${FRONTEND_URL}/verify-email?token=...` |
| Password reset | `${FRONTEND_URL}/reset-password?token=...` |
| Staff invitation | `${FRONTEND_URL}/accept-invitation?token=...` |
| Hospital activated | `${FRONTEND_URL}/onboarding/status?tenant=<slug>` (no token) |

Set `FRONTEND_URL` to the production web origin (for example
`https://app.hospitalos.com`) in the deployed API environment. Links never use
request headers, so a spoofed `Host` header cannot poison them.

## 4. Provider setup (Resend)

1. Create a Resend account and add the sending domain (for example
   `hospitalos.com`) under **Domains**.
2. Add the DNS records Resend displays for that domain:
   - `MX` and `TXT` (SPF) records for the sending subdomain;
   - the `DKIM` `TXT` record;
   - the `DMARC` `TXT` record (`_dmarc`) recommended by Resend.
   Wait until the domain shows **Verified**.
3. Create a **Sending access** API key at
   <https://resend.com/api-keys>. Do not use a full-access key.
4. Set in the API environment (never commit these):

   ```dotenv
   NODE_ENV=production
   AUTH_MAIL_PROVIDER=real
   AUTH_MAIL_FROM_EMAIL=no-reply@hospitalos.com
   AUTH_MAIL_FROM_NAME=HospitalOS
   AUTH_MAIL_REPLY_TO=support@hospitalos.com
   AUTH_MAIL_RESEND_API_KEY=re_...
   FRONTEND_URL=https://app.hospitalos.com
   ```

5. Start the API once with a test send (`AUTH_MAIL_PROVIDER=mock` locally) and
   verify the real domain in a staging deployment before go-live.

Real credentials are read only by `auth-mail.providers.ts`. Provider errors
are reduced to stable codes (`auth_mail_http_429`, `auth_mail_timeout`, ...);
response bodies, tokens, links and recipient addresses are never logged.

## 5. API behaviour

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/email/verify` | Public, rate limited. Consumes the token once; returns the updated user. |
| POST | `/api/v1/auth/email/resend` | Authenticated + CSRF. Honours cooldown; returns `SENT`, `COOLDOWN`, `ALREADY_VERIFIED`, `DELIVERY_FAILED` or `SUPPRESSED`. |
| POST | `/api/v1/auth/forgot-password` | Public, rate limited. Always 202; identical response for unknown accounts. Requesting again revokes the previous unused reset link. |
| POST | `/api/v1/auth/reset-password/validate` | Public, rate limited. Non-consuming token check: `{ valid, status, expiresAt? }` with status `VALID`, `INVALID`, `EXPIRED`, `USED` or `REVOKED`. |
| POST | `/api/v1/auth/reset-password` | Consumes the reset token once and revokes all sessions/refresh tokens. |
| POST | `/api/v1/tenant/staff/invitations` | Tenant session, `staff:create`; role ids also require `staff:assign_role`. Body: `{ email, fullName?, roleIds?, departmentIds?, branchIds? }`. |
| GET | `/api/v1/tenant/staff/invitations` | Tenant session, `staff:read`. Lists invitations and derived status. |
| POST | `/api/v1/tenant/staff/invitations/:invitationId/resend` | Tenant session, `staff:create`. Reissues a fresh token. |
| POST | `/api/v1/tenant/staff/invitations/:invitationId/revoke` | Tenant session, `staff:create`. Revokes the token and any INVITED membership. |
| POST | `/api/v1/auth/invitations/details` | Public, rate limited. Body: `{ token }`. Safe invitation details. |
| POST | `/api/v1/auth/invitations/accept` | Public, rate limited. Body: `{ token, fullName?, password? }`. |
| GET | `/api/v1/tenants/onboarding` | Authenticated. Own hospital registrations and permitted onboarding details; no platform-only fields. |

Registration issues a verification token and emails it after the account row is
committed. A delivery failure never rolls the account back; the response is
still 201 and the user can use resend after signing in.

### Password recovery (ONB-04A)

The forgot-password response is always the same 202 envelope with one generic
message: no delivery status, account hint or token in production. A new request
revokes every outstanding unused reset token for that account and inserts a
fresh hashed token, so only the newest emailed link works. Requests are rate
limited per IP and subject to `AUTH_EMAIL_RESEND_COOLDOWN_SECONDS` per account.

Successful reset consumes the token conditionally (`used_at IS NULL AND
revoked_at IS NULL`), revokes any other outstanding reset tokens, replaces the
password hash and revokes all sessions plus their refresh tokens, matching the
rest of the authentication architecture.

Outside production the response additionally includes `resetToken` and an
explicit `resetUrl` built from `FRONTEND_URL`, so the recovery UI can be
exercised without a mail provider. Both fields are omitted in production and
are never written to logs.

This repository contains the API only; there is no frontend application to
modify. The recovery pages must map the endpoint states below.

Staff invitation acceptance:

- with an existing account: activates the membership, grants the invited roles
  and verifies the email; `password` is not required or changed;
- without an account: `fullName` and `password` are required; the account is
  created with `emailVerifiedAt` set (possession of the emailed token proves
  address ownership).

Invitation role ids must belong to the inviting hospital. Any other pending
invitation for the same hospital/address is revoked when a new one is issued or
accepted.

## 6. Frontend states

The API is the only artifact in this repository, so the web client maps these
responses to UI states:

| State | Trigger |
| --- | --- |
| Email sent / verification pending | Registration 201 with `user.emailVerifiedAt = null`; resend returns `SENT`. |
| Verified | `/auth/email/verify` 200 includes `user.emailVerifiedAt`; `/auth/me` reflects it. |
| Expired or used link | 400 `Invalid or expired verification link` / `Invalid or expired invitation`; show a resend/sign-in action. |
| Failed delivery | Resend returns `DELIVERY_FAILED` (or registration completes but `emailVerifiedAt` stays null); show "couldn't send, try again shortly". |
| Resend cooldown | Resend returns `COOLDOWN` with `retryAfterSeconds`; disable the button until then. Password reset resend shows the same generic submitted state. |
| Request submitted / email sent | Forgot-password 202 (always generic); show "check your inbox" and a resend action. |
| Invalid reset token | `/auth/reset-password/validate` returns `status: "INVALID"`; offer a new request. |
| Expired reset token | `status: "EXPIRED"`; offer a new request. |
| Reused/revoked reset token | `status: "USED"` or `"REVOKED"`; explain the link is no longer valid. |
| Successful reset | `/auth/reset-password` 200; clear session state and send the user to sign in. |
| Invitation sent | `POST /tenant/staff/invitations` 202 with `invitation.status` and `expiresAt`. |

Reset-password success keeps the existing behaviour: sessions are revoked and
the user signs in with the new password.

## 7. Security properties

- Tokens: 32 random bytes, base64url; only SHA-256 hashes stored; unique index.
- Single use: conditional `UPDATE ... WHERE used_at IS NULL` makes concurrent
  submissions safe; reuse/expiry returns 400 without disclosing which.
- Newest-link-only: issuing a replacement revokes outstanding verification and
  invitation tokens for the same user/address.
- Raw tokens never appear in production responses or logs. Audit events store
  only kind, provider mode, error code and counts.
- Public token endpoints are IP rate limited; forgot-password and resend add
  per-address cooldown and the existing account-enumeration resistance.
- HTML templates escape every interpolated value and only render http(s) links.
