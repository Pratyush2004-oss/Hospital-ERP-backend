# Payment API

Phase 19.5.1 exposes the payment recording and query services (`payment.service.ts`,
Phase 19.4) over HTTP. The service is unchanged: this layer adds controllers,
Zod request schemas, route guards and documentation only. No allocation,
balance, idempotency or reconciliation rule is re-implemented here.

## Endpoints

All endpoints are mounted under the versioned prefix (`/api/v1`) and are
hospital-scoped.

| Method | Path | Permission | Behaviour |
| --- | --- | --- | --- |
| POST | `/payments` | `payment:create` | Record a manual payment and settle the listed invoices |
| GET | `/payments` | `payment:read` | List receipts with filters and pagination meta |
| GET | `/payments/:paymentId` | `payment:read` | One receipt with its allocation lines |
| GET | `/payments/:paymentId/allocations` | `payment:read` | Allocation lines of one receipt |

POST requires the CSRF header like every other hospital-plane write. There is
deliberately no update, delete, status or refund endpoint in this phase:
receipts are append-only financial history.

## Recording

```json
POST /api/v1/payments
Idempotency-Key: 6f1c2c4e-6a1b-4c0e-9c2f-2a5b8d1e3f40

{
  "branchId": "7b1c9d55-3f7e-4c2a-9d1b-5f8e2a6c4d10",
  "patientId": "0f2b7c14-8a63-4f9d-9a51-2c7d1e8b6f31",
  "method": "CASH",
  "amount": "60.00",
  "reference": "RCPT-2026-00041",
  "allocations": [
    { "invoiceId": "c96cac80-adbd-4d50-bdb7-fe40fc089649", "amount": "60.00" }
  ]
}
```

`201` returns `{ data: { payment, invoiceBalances, replayed: false } }`. A retry
with the same key and the same request returns `200` with the original receipt
and `replayed: true`; the same key with a different request is a `409`. The
key may also be sent as the body field `idempotencyKey`, but one of the two is
required and they must match when both are present.

The body is `.strict()`: `tenantId`, `receivedBy`, `paymentStatus`, `createdAt`
and any other server-owned field is a `422`. `receivedAt` is optional, accepts a
backdated ISO 8601 instant with an explicit offset, and cannot be in the future.
Money is a positive decimal with at most 2 decimals.

The service (not the controller) enforces that every allocation belongs to the
paying patient and to the payment's branch, stays within the invoice's
outstanding balance, appears only once, and sums exactly to `amount`.

## Listing and filters

`page` and `limit` (default 20, max 100) plus `patientId`, `branchId`, `method`,
`status`, `reference` (exact match) and the inclusive UTC date bounds
`fromDate`/`toDate` on `receivedAt`. `toDate` before `fromDate` is a `422`.
Pagination metadata follows the shared envelope:
`meta.pagination = { page, pageSize, total, totalPages }`.

List rows are service summaries: no `notes`, no allocations, no internal
columns. Detail adds `notes` and the allocation lines (with the invoice number)
but never exposes `requestHash`, `tenantId` or any storage/audit column.

## Tenant, actor and permissions

- `authenticate` resolves the actor and `requireTenant` requires a verified
  tenant context; the tenant is never read from the URL, body or query string.
- The service repeats `tenant_id` in every statement inside
  `withTenantTransaction`, so PostgreSQL RLS and the explicit filter both
  enforce isolation. Another hospital's payment id is a `404`, not a `403`.
- `payment:create` is held by `hospital_admin`, `receptionist` and
  `accountant`; `payment:read` additionally by `branch_admin`. `doctor`,
  `nurse` and every role without a payment key get a `403`.
- The cashier is the authenticated user; `receivedBy` is never accepted from the
  client. Manual collections are stored `SUCCESSFUL` and there is no endpoint
  that can write another status.

## Known limitation

Hospital memberships are tenant-scoped but not branch-scoped, so
`branch_admin` acts across the whole hospital. `branchId` is a filter and a
consistency rule (money collected in a branch can only settle that branch's
invoices), not an authorization boundary.

## Tests

`src/modules/billing/payment.routes.vitest.test.ts` covers recording, replayed
retries, idempotency-key requirements, strict validation, service error
propagation (`400`/`409`/`422`), detail and allocation reads, pagination and
filters, RBAC, CSRF, unauthenticated access and cross-tenant isolation.
