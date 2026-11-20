# Notifications (Phase 20)

Central notification outbox, recipient API, delivery worker, appointment reminders
and the Phase 19.10 billing notification bridge.

## 1. Model

| Table | Purpose |
| --- | --- |
| `notification_templates` | Optional tenant overrides of plain-text EN/HI templates. |
| `notifications` | Central outbox. One row per `(tenant, source event, channel)`. |
| `notification_preferences` | Optional per-user or tenant-wide channel/event opt-outs. |
| `billing_notifications` | Unchanged Phase 19.10 outbox for billing EMAIL/SMS. |

The unique constraint `notifications_tenant_source_channel_unique` is the
duplicate-delivery guarantee. Enqueueing the same event again writes nothing.

`read_at` (migration `0029_notification_read_state`) tracks in-app
acknowledgement. It is never set by a provider.

## 2. HTTP API

All routes require authentication plus a verified hospital (tenant) context.
`tenantId` and `userId` are taken from the session, never from the request.
Writes require the CSRF header/cookie used by every hospital-plane mutation.

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/api/v1/notifications` | List the caller's notifications. |
| GET | `/api/v1/notifications/unread-count` | `{ unread }` for the caller's in-app inbox. |
| GET | `/api/v1/notifications/:notificationId` | One owned notification, otherwise 404. |
| POST | `/api/v1/notifications/:notificationId/read` | Mark one in-app notification read (idempotent). |
| POST | `/api/v1/notifications/read-all` | Mark all unread in-app notifications read. |
| GET | `/api/v1/notifications/preferences` | Caller overrides + inherited tenant defaults. |
| PATCH | `/api/v1/notifications/preferences` | Upsert one preference. |

List query parameters: `page` (default 1), `limit` (1-100, default 20),
`status`, `channel`, `event`, `unreadOnly`. Responses use the standard
`{ data, meta.pagination }` envelope.

Preference body:

```json
{
  "event": "APPOINTMENT_REMINDER",
  "channel": "EMAIL",
  "enabled": false,
  "tenantDefault": false
}
```

`event` may be omitted/null for a channel-wide preference. `tenantDefault:
true` writes the hospital-wide default and requires `staff:update`; it is
rejected with 403 for ordinary members.

Authorization model: recipient ownership. Every SQL predicate includes both
`tenant_id = <session tenant>` and `user_id = <session user>`. A foreign id
returns 404, not 403, so existence is not disclosed. `requireTenant` rejects
platform-only and unauthenticated callers with 401/403.

## 3. Delivery worker

`src/modules/notifications/notification.worker.ts` runs in the API process and
claims due rows with one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`
statement. That makes concurrent instances safe without a queue broker.

Per row:

1. `IN_APP` is marked `SENT` immediately (no provider).
2. External channels use the configured `NotificationProvider`.
3. Success stores `provider_message_id` and `sent_at`.
4. Transient failure stores `last_error` and schedules exponential backoff
   (`NOTIFICATION_RETRY_BASE_SECONDS * 2^(attempt-1)`).
5. Permanent failure or an exhausted `max_attempts` becomes terminal `FAILED`.
6. An unconfigured provider becomes `SKIPPED`; other rows in the batch continue.

Recovery: claims increment `attempts` and set a lease
(`NOTIFICATION_PROCESSING_TIMEOUT_SECONDS`). A crashed worker leaves a
`PROCESSING` row whose lease expires; the next sweep reclaims and retries it.
Because attempts are counted at claim time, a restart cannot retry forever.

Delivery is at-least-once. A provider may accept a message before the database
update fails; adapters should use the notification row id as an idempotency key
when the provider supports it.

Scheduling:

- `NOTIFICATION_WORKER_ENABLED` (default `true`)
- `NOTIFICATION_WORKER_INTERVAL_MS` (default `15000`)
- Redis lock `hospitalos:notifications:worker` reduces duplicate work across
  instances. If Redis is unavailable the worker logs a warning and still runs,
  because the database claim is authoritative.

`startNotificationWorker()` / `stopNotificationWorker()` are called from
`src/server.ts`; `processNotificationBatch()` is exported for one-off operators
and tests.

## 4. Appointment notifications and reminders

Hooked inside the existing appointment transactions, savepoint-protected:

| Moment | Event |
| --- | --- |
| Booking | `APPOINTMENT_CONFIRMED` |
| Reschedule (replacement) | `APPOINTMENT_RESCHEDULED` |
| Cancellation | `APPOINTMENT_CANCELLED` |
| Reminder sweep | `APPOINTMENT_REMINDER` |

The message uses real appointment data and the **branch timezone** for
`appointment_time`. No appointment reason, notes or clinical data is exposed.
No availability or booking logic is reimplemented.

Reminder sweep (`sweepAppointmentReminders`) considers only `PENDING` and
`CONFIRMED` appointments whose start is still in the future. Cancelled,
completed, no-show, rescheduled and started appointments are excluded. For each
appointment it sends the most urgent configured threshold already crossed, so a
worker outage does not flood the patient. Dedupe source id:
`appointment:<id>:reminder:<minutes>`.

Tenant configuration is stored in `tenant_settings` under
`appointment.notifications`:

```json
{
  "enabled": true,
  "channels": ["IN_APP", "EMAIL", "SMS"],
  "reminders": [1440, 60],
  "locale": "EN"
}
```

Defaults come from `APPOINTMENT_REMINDER_MINUTES` (comma-separated minutes).
Scheduler: `APPOINTMENT_REMINDER_SCHEDULER_ENABLED` /
`APPOINTMENT_REMINDER_INTERVAL_MS`. The sweep uses the Redis lock
`hospitalos:notifications:reminders`.

Doctor/branch schedule-change notifications are not emitted because the current
schedule and leave modules do not cancel or move appointments; the central
`DOCTOR_SCHEDULE_CHANGED` event/template is ready for that future hook.

## 5. Billing integration (Phase 19.10 -> 20)

`billing-notification.bridge.ts` keeps the existing billing outbox as the only
billing EMAIL/SMS path. It calls the unchanged
`enqueueBillingNotificationSafely` and additionally writes one central `IN_APP`
row for the patient's linked account.

Wired moments:

- `issueInvoice` -> `INVOICE_ISSUED`
- `transitionOverdue` -> `INVOICE_OVERDUE`
- `recordPayment` -> `PAYMENT_RECEIVED` or `PARTIAL_PAYMENT_RECEIVED`
- refund success/failure -> `REFUND_SUCCEEDED` / `REFUND_FAILED`

Billing templates, tenant billing channels, retry rules and the billing worker
are unchanged. Dedupe keys (`invoice-issued:<id>`, `payment-received:<paymentId>:<invoiceId>`,
`refund-*:<refundId>`) prevent duplicate delivery when a handler is invoked more
than once. No billing table or service is duplicated.

Due-soon billing reminders reuse the existing billing event/template surface;
there is no separate invoice reminder scheduler in this phase.

## 6. Security and tenant isolation

- All API queries carry the session tenant and session user id.
- Notification enqueue resolves recipients from tenant-scoped contacts or the
  account record, never from event payloads or request bodies.
- API responses never include the stored recipient address; logs contain ids and
  statuses only, never message bodies, contact data or provider credentials.
- Preferences are resolved most-specific-first: user+event, user-wide,
  tenant+event, tenant-wide; the caller's own preference wins.
- RLS is enabled and forced on all three central tables. Runtime API traffic uses
  `hospitalos_app`; the RLS test in `notification.phase20.vitest.test.ts` proves
  a foreign tenant row is invisible with that restricted role.
- Provider adapters are selected by environment. `none` disables a channel;
  `mock` is deterministic and never contacts a network.

## 7. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTIFICATION_EMAIL_PROVIDER` | `none` | `none` or `mock`. |
| `NOTIFICATION_SMS_PROVIDER` | `none` | `none` or `mock`. |
| `NOTIFICATION_WHATSAPP_PROVIDER` | `none` | `none` or `mock`. |
| `NOTIFICATION_RETRY_BASE_SECONDS` | `900` | Backoff base. |
| `NOTIFICATION_BATCH_SIZE` | `50` | Rows claimed per tick. |
| `NOTIFICATION_PROCESSING_TIMEOUT_SECONDS` | `300` | Claim lease/recovery window. |
| `NOTIFICATION_WORKER_ENABLED` | `true` | Start the worker loop. |
| `NOTIFICATION_WORKER_INTERVAL_MS` | `15000` | Worker tick interval. |
| `APPOINTMENT_REMINDER_MINUTES` | `1440,60` | Default reminder thresholds. |
| `APPOINTMENT_REMINDER_SCHEDULER_ENABLED` | `true` | Start the reminder sweep. |
| `APPOINTMENT_REMINDER_INTERVAL_MS` | `60000` | Sweep interval. |
| `BILLING_NOTIFICATION_*` | see `.env.example` | Unchanged Phase 19.10 settings. |

Real email/SMS/WhatsApp providers still need adapters behind
`NotificationProvider` and credentials supplied by the deployment environment.
No vendor account or credential is configured in this repository.
