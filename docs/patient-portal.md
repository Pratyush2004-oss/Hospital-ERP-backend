# Patient self-registration and portal (ONB-09)

A patient login is a **global account** (`users`) linked to at most one
**tenant-scoped patient profile** per hospital (`patient_profiles.user_id`).
It is never a staff membership, role or tenant session. Registration through
these endpoints therefore cannot create hospital-plane authorization.

## Endpoints

All paths are under `/api/v1`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/registrations` | Public | Create a global account (only when the email/phone is unused) and a linked patient profile in one active hospital. Sends the existing email-verification link. |
| POST | `/portal/registrations` | Authenticated + CSRF + verified email | Link the signed-in account to one more active hospital. Reuses the global account; never creates a second one. |
| GET | `/portal/hospitals` | Authenticated + verified email | Hospitals where the signed-in account has a live patient profile. |
| GET | `/portal/hospitals/:hospitalSlug/profile` | Authenticated + verified email | The caller's own patient profile in that hospital. |

### Public registration body

```json
{
  "hospitalSlug": "riverside-care",
  "fullName": "Ada Lovelace",
  "email": "ada@example.com",
  "password": "at-least-12-characters",
  "phone": "+1 555 010 1111",
  "dateOfBirth": "1990-02-28",
  "gender": "FEMALE"
}
```

The body is `.strict()`: `role`, `roles`, `tenantId`, `isStaff`, `patientCode`
and any other workflow field return `422`. The hospital is selected only by an
active tenant slug; an unknown, pending or suspended hospital is a `404` with
no tenant details.

### Responses

- `201` public registration:
  `{ user, patient, accountCreated: true, requiresEmailVerification: true }`
- `201` link: `{ patient, accountCreated: false, requiresEmailVerification: false }`
- `200` hospital list: `{ hospitals: [{ tenantId, tenantName, tenantSlug, patientId, patientCode, status, linkedAt }] }`
- `200` profile: `{ patient }` (profile + contacts, addresses and emergency
  contacts; no clinical records)

## Identity matching and conflicts

A global account is matched by normalized email or phone. A patient profile is
matched only by exact normalized email/phone in the **same** hospital.

| Reason (in `error.details.reason`) | HTTP | Meaning |
| --- | --- | --- |
| `ACCOUNT_EXISTS` | 409 | The email/phone already has a global account. Sign in and link the hospital from the portal instead of registering again. |
| `POTENTIAL_PATIENT_MATCH` | 409 | A walk-in/reception patient record already uses this email/phone in that hospital. Staff must link the existing record; the response never discloses the patient's identity. |
| `PATIENT_ALREADY_LINKED` | 409 | This account already has a patient profile in this hospital. |
| `EMAIL_NOT_VERIFIED` | 403 | Portal reads/writes are locked until the email verification link is used. |

If profile creation fails after the account was created, the new account is
removed, so a conflict cannot leave an orphan login.

## Isolation and authorization

- Tenant selection comes from the validated active hospital slug, never from a
  body/query `tenantId`.
- `patient_profiles`/`patient_contacts` remain under tenant RLS. Portal reads
  are additionally hard-scoped to the authenticated `user_id`.
- A portal request for a hospital where the caller has no linked profile is a
  `404`, identical to an unknown hospital or another patient's profile.
- Patient logins hold no staff permissions; `/patients`, `/appointments` and
  other hospital-plane routes still require a tenant session and RBAC.
- Receptionist-assisted registration (`POST /patients` under a tenant session)
  is unchanged. It creates an **unlinked** patient profile, which is shown as
  "Walk-in / reception" in the dashboard; linked portal profiles show as
  "Portal account".
- Public responses never include medical history, documents or clinical notes.

## Verification

`npm run test:vitest -- patient.portal.routes` (or
`npx vitest run src/modules/patients/patient.portal.routes.vitest.test.ts`)
covers duplicate accounts, duplicate patient contacts, strict role/tenant
injection, multi-hospital linking, unverified access, cross-tenant and
cross-patient denial, unauthenticated access and unlinked walk-in registration.

## Missing capabilities (documented, not invented)

1. **No patient-portal appointment routes.** The appointment services support
   patient self-service internally, but every HTTP appointment route requires a
   hospital tenant session and RBAC (`appointment:read`). A patient login cannot
   list or manage appointments. The portal UI shows this limitation explicitly
   instead of inventing an endpoint.
2. **No public hospital directory.** There is no unauthenticated "list active
   hospitals" endpoint. Registration and linking use the hospital's slug as the
   hospital-specific entry point (`/register/patient?hospital=<slug>`).
3. **Profile editing is read-only.** The portal exposes the existing profile
   read; demographics/contact changes remain staff-managed. No portal update
   endpoint exists.
4. **No source column distinguishing self-registration from receptionist
   linking.** The portal shows the supported signal: whether a global account is
   linked (`accountLinked` / `user`).
