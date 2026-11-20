# Invoice Lifecycle, Balance and Reconciliation (Phase 19.3)

This phase adds service-layer invoice lifecycle integration and financial
reconciliation on top of invoice creation (19.2.2), the decimal calculator
(19.2.1) and the status/balance service (19.3.1). No payment gateway, payment
or refund processing service, HTTP route/controller, PDF or frontend code is
included. Payment and refund ledger rows are read here; recording them is the
next payment task's responsibility.

| Service method | Purpose |
| --- | --- |
| `issueInvoice` | `DRAFT -> ISSUED` after validation |
| `cancelInvoice` | Closes an unpaid invoice as `CANCELLED` |
| `updateInvoiceStatus` | Explicit `ISSUED` / `OVERDUE` / `CANCELLED` / `REFUNDED` actions |
| `recalculateInvoiceBalance` | Re-derives status/amounts from payment and refund records |
| `reconcileInvoiceBalance` | Detects and repairs header drift from the ledger |
| `getInvoiceBalance` | Read-only derived balance view |

Files:

- `src/modules/billing/invoice.lifecycle.service.ts` - lifecycle, balance and reconciliation
- `src/modules/billing/billing.audit.ts` - structured audit sink
- `src/database/schema/invoice-payments.ts`, `invoice-refunds.ts` - money ledger
- `src/database/schema/invoices.ts` - invoice header

## 1. Lifecycle model

```
DRAFT --issue--> ISSUED --payment--> PARTIALLY_PAID --payment--> PAID
  |                 |  |                    |                     |
  |                 |  +--past due--> OVERDUE                    |
  |                 |                    |                     |
  +--cancel--> CANCELLED <---------------+--cancel------------+
                                          |
                          successful refunds --> REFUNDED
```

- New invoices are always `DRAFT`; a client-supplied status never reaches the
  insert.
- `ISSUED` requires at least one line item and no settled money.
- `PARTIALLY_PAID` and `PAID` are **derived** from successful payments. Calling
  `updateInvoiceStatus` with either is rejected (`422`), so an unpaid invoice
  cannot be marked paid.
- `OVERDUE` is derived when the due date has passed and nothing is paid, or set
  explicitly on an issued invoice past its due date. A partly paid invoice stays
  `PARTIALLY_PAID` even when past due: the payment queue wins over collections.
- `CANCELLED` requires no successful payments or refunds; pending/failed
  attempts do not block it. It keeps the total for history but owes `0.00`.
- `REFUNDED` requires at least one successful refund and zero net held money
  (all collected money returned); the balance is closed to `0.00`.
- `CANCELLED` and `REFUNDED` are terminal.
- Cancelling an already-cancelled invoice and re-issuing an already-issued
  invoice are idempotent (`applied: false`) and write no second audit event.

## 2. Central transition table

`INVOICE_TRANSITIONS` in `invoice.lifecycle.service.ts` is the single authority.
Every mutating path - issue, cancel, explicit status change, recalculation and
reconciliation repair - calls `assertInvoiceTransition` before writing.

| From | Allowed |
| --- | --- |
| `DRAFT` | `ISSUED`, `CANCELLED` |
| `ISSUED` | `OVERDUE`, `CANCELLED`, `PARTIALLY_PAID`, `PAID`, `REFUNDED` |
| `OVERDUE` | `CANCELLED`, `PARTIALLY_PAID`, `PAID`, `REFUNDED` |
| `PARTIALLY_PAID` | `PAID`, `REFUNDED` |
| `PAID` | `PARTIALLY_PAID` (partial refund), `REFUNDED` |
| `CANCELLED` / `REFUNDED` | terminal |

Invalid transitions return `409 CONFLICT` with
`{ from, to, allowedTransitions }`. Because cancellation and reconciliation
consult the same table, a corrupted header such as `PAID` with no money cannot
be cancelled or silently rewritten to an earlier status.

## 3. Balance rules

All amounts are `NUMERIC(12, 2)` and are computed by `calculateInvoiceBalance`
using integer (BigInt) arithmetic; no JavaScript float participates.

```
amount_paid  = sum(SUCCESSFUL payments) - sum(SUCCESSFUL refunds)
balance_due  = max(total_amount - amount_paid, 0)
```

- Only `SUCCESSFUL` payments settle money. `PENDING` and `FAILED` attempts are
  history only.
- Only `SUCCESSFUL` refunds return money. `PENDING` and `FAILED` refunds change
  nothing.
- A refund may never exceed collected money; over-refunds are rejected (`422`)
  instead of clamping or producing a negative balance.
- Overpayment is allowed at the ledger level (a patient may pay more than the
  bill): `amount_paid` can exceed `total_amount`, while `balance_due` stays
  `0.00`. The excess is a credit to resolve through a refund.
- `CANCELLED` and `REFUNDED` close `balance_due` to `0.00` regardless of the
  arithmetic result; the total and the ledger stay intact for reporting.
- Header totals are never accepted from a request. Subtotal, discount, tax and
  total come from `createInvoice`'s server-side calculation and the database
  reconciliation constraint (`subtotal - discount + tax = total_amount`).
- The currency of every payment and refund must match the invoice currency.

## 4. Reconciliation logic

`reconcileInvoiceBalance(tenantId, invoiceId, actor, now?)` treats the payment
and refund ledger as the source of truth:

1. Lock the invoice row (`SELECT ... FOR UPDATE`).
2. Recompute `amount_paid`, `balance_due` and the derived status with the same
   calculator and transition table used everywhere else.
3. Compare with the persisted header. If they match, return
   `repaired: false` and write nothing.
4. If they differ, and the status change is legal (or there is no status
   change), update the header and emit `invoice.reconciled` with identifiers and
   field names only.
5. If the header status cannot be reached from the records (for example `PAID`
   with no payments), fail with `409` and roll back instead of inventing
   history.

The function never increments counters, so repeated calls - or a call racing a
recalculation - cannot double apply money. Terminal invoices with settled money
are reported as an integrity fault rather than repaired automatically.

## 5. Transactions and concurrency

- Every mutation runs inside `withTenantTransaction(tenantId, ...)`, which sets
  `app.current_tenant_id` for RLS and commits or rolls back atomically.
- Every mutation locks the invoice row first. Concurrent recalculations,
  cancellations and reconciliations serialize; the loser re-reads committed
  state instead of writing a balance from a stale read.
- Status/amount writes, ledger reads and the audit event happen in one
  transaction. Any error (invalid transition, over-refund, constraint failure)
  rolls back the header, so no partial financial state is visible.
- The future payment/refund writer must lock the invoice row before inserting a
  ledger row, then call `recalculateInvoiceBalance` in the same transaction.
  That keeps a concurrent recalculation from missing money that is about to
  change.
- Financial history is append-only: invoices are never hard deleted, and payment
  and refund rows cascade only when a whole tenant is purged.

## 6. Tenant isolation and security

- Every read and write filters on `tenant_id`; a foreign invoice id yields
  `404`, never data.
- Composite foreign keys make cross-tenant links impossible:
  `invoice_items`, `invoice_payments` and `invoice_refunds` reference
  `invoices(tenant_id, id)`, and a refund's `(tenant_id, invoice_id, payment_id)`
  key must match a payment of the same invoice.
- RLS (`tenant_isolation`) is enabled and forced on all billing tables, including
  the two ledger tables added in 19.3.1. Integration tests run the service as the
  restricted `hospitalos_app` role and verify that an unscoped connection or
  another tenant's context sees zero invoices and payments.
- Patient, branch and appointment links are validated at creation (same tenant,
  same patient and branch for an appointment) in addition to the database keys.
- Audit events carry identifiers, statuses and changed field names only - never
  amounts, patient data, reasons or provider references.

## 7. Known limitations

- Payment/refund recording is not implemented (out of scope). Ledger rows must
  be written by the next payment task using the locking contract above.
- Overpayments are permitted and surfaced as `amount_paid > total_amount`; there
  is no automatic credit note or refund of the excess.
- There is no scheduled job to mark invoices overdue; `OVERDUE` appears through
  recalculation, reconciliation or an explicit staff action.
- Reconciliation repairs amounts for any status, but a corrupt status can only
  be corrected automatically when the transition table allows it; otherwise it
  reports `409` for manual resolution.
- A single refund may reference at most one payment row; split refunds against
  multiple payments are expressed as separate refund rows.
