# Central notifications

Tenant-scoped notification outbox, recipient API, delivery worker, appointment
notifications/reminders and the Phase 19.10 billing bridge. Full behaviour and
configuration: [`docs/notifications.md`](../../../docs/notifications.md).

## Components

| File | Responsibility |
| --- | --- |
| `notification.service.ts` | Preference-aware enqueue, channel fan-out, savepoint-safe enqueue. |
| `notification.query.service.ts` | Recipient-owned list/detail/read/unread/preference queries. |
| `notification.routes.ts` | Authenticated hospital-plane HTTP endpoints. |
| `notification.worker.ts` | `SKIP LOCKED` claim, provider delivery, retry/backoff, restart recovery, Redis lock. |
| `notification.appointment.service.ts` | Booking/reschedule/cancel hooks and reminder sweep. |
| `notification.providers.ts` | Provider abstraction plus `none`/`mock` adapters. |
| `notification.templates.ts` | Plain-text EN/HI templates; tenant overrides are table-backed. |
| `notification.events.ts` | In-process event bus for future non-transactional consumers. |

Billing integration lives in
`src/modules/billing/notifications/billing-notification.bridge.ts`; the billing
outbox and templates remain the single billing EMAIL/SMS implementation.

## Event contract

Business services enqueue **inside their transaction** so the outbox write and
the business event commit atomically:

```ts
await enqueueNotificationsSafely(tx, {
  tenantId,
  userId,
  patientId,
  event: "APPOINTMENT_CONFIRMED",
  eventId: `appointment:${appointmentId}:confirmed`,
  channels: ["IN_APP", "EMAIL", "SMS"],
  variables: { appointment_time, branch_name, hospital_name },
  tx,
});
```

`enqueueNotificationsSafely` uses a savepoint: a notification failure can never
roll back a booking, invoice, payment or registration. The unique
`(tenant_id, source_event_id, channel)` constraint makes retries idempotent.

## Security

- Routes take tenant and user ids only from the authenticated context.
- Every read/write query filters by tenant and recipient.
- Contact addresses are resolved from tenant-scoped data and never returned by
  the API or written to logs.
- RLS is enabled and forced on templates, notifications and preferences.
- Preference resolution is most-specific-first and respects opt-outs.
