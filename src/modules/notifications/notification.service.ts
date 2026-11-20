import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../database/context.js";
import {
  notificationPreferences,
  notificationTemplates,
  notifications,
} from "../../database/schema/index.js";
import { logger } from "../../lib/logger.js";
import { resolveNotificationRecipient } from "./notification.recipients.js";
import { getNotificationTemplate, renderNotificationTemplate } from "./notification.templates.js";
import type {
  EnqueueNotificationChannelsInput,
  EnqueueNotificationInput,
  NotificationChannel,
} from "./notification.types.js";

/**
 * Central notification outbox (Phase 20).
 *
 * Rows are enqueued inside the caller's business transaction and delivered
 * asynchronously by `notification.worker.ts`. The unique
 * `(tenant_id, source_event_id, channel)` constraint is the duplicate-delivery
 * guarantee: replaying an event can never produce a second row for the channel.
 */

interface PreferenceRow {
  readonly userId: string | null;
  readonly event: string | null;
  readonly enabled: boolean;
}

/**
 * Resolves the most specific preference: user+event, user-wide, tenant+event,
 * tenant-wide. The caller's own preference always wins over a tenant default.
 */
async function isChannelEnabled(
  tx: DatabaseTransaction,
  input: EnqueueNotificationInput,
): Promise<boolean> {
  const rows: PreferenceRow[] = await tx
    .select({
      userId: notificationPreferences.userId,
      event: notificationPreferences.event,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.tenantId, input.tenantId),
        input.userId === undefined
          ? isNull(notificationPreferences.userId)
          : or(
              isNull(notificationPreferences.userId),
              eq(notificationPreferences.userId, input.userId),
            ),
        or(
          isNull(notificationPreferences.event),
          eq(notificationPreferences.event, input.event),
        ),
        eq(notificationPreferences.channel, input.channel),
      ),
    );

  let best: PreferenceRow | null = null;
  let bestScore = -1;

  for (const row of rows) {
    const isUserRow = input.userId !== undefined && row.userId === input.userId;
    const isEventRow = row.event !== null;
    const score = (isUserRow ? 2 : 0) + (isEventRow ? 1 : 0);

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return best?.enabled ?? true;
}

async function renderedNotification(
  tx: DatabaseTransaction,
  input: EnqueueNotificationInput,
): Promise<{ subject: string | null; body: string }> {
  const [override] = await tx
    .select({ subject: notificationTemplates.subject, body: notificationTemplates.body })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.tenantId, input.tenantId),
        eq(notificationTemplates.event, input.event),
        eq(notificationTemplates.channel, input.channel),
        eq(notificationTemplates.locale, input.locale ?? "EN"),
        eq(notificationTemplates.isActive, true),
      ),
    )
    .limit(1);

  const template = override ?? getNotificationTemplate(input.event, input.channel, input.locale);

  return {
    subject:
      template.subject === null || template.subject.trim() === ""
        ? null
        : renderNotificationTemplate(template.subject, input.variables).slice(0, 300),
    body: renderNotificationTemplate(template.body, input.variables).slice(0, 4_000),
  };
}

/** Enqueues one channel. Returns the row id, or null when disabled/deduplicated. */
export async function enqueueNotification(
  input: EnqueueNotificationInput,
): Promise<string | null> {
  if (!(await isChannelEnabled(input.tx, input))) return null;

  const message = await renderedNotification(input.tx, input);

  const [row] = await input.tx
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      patientId: input.patientId ?? null,
      event: input.event,
      channel: input.channel,
      sourceEventId: input.eventId,
      recipient: input.channel === "IN_APP" ? null : (input.recipient ?? null),
      subject: message.subject,
      body: message.body,
      payload: input.variables,
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({
      target: [notifications.tenantId, notifications.sourceEventId, notifications.channel],
    })
    .returning({ id: notifications.id });

  return row?.id ?? null;
}

/**
 * Enqueues every eligible channel for one event.
 *
 * Recipient lookup is per channel, so a missing email does not prevent an SMS
 * or in-app notification. A channel with no address is skipped rather than
 * stored with an empty recipient.
 */
export async function enqueueNotificationForChannels(
  input: EnqueueNotificationChannelsInput,
): Promise<number> {
  let inserted = 0;
  const seen = new Set<NotificationChannel>();

  for (const channel of input.channels) {
    if (seen.has(channel)) continue;
    seen.add(channel);

    const recipient =
      channel === "IN_APP"
        ? undefined
        : (input.recipients?.[channel] ??
          (await resolveNotificationRecipient(
            input.tx,
            input.tenantId,
            { userId: input.userId, patientId: input.patientId },
            channel,
          )));

    if (channel !== "IN_APP" && (recipient === undefined || recipient === null)) continue;
    if (channel === "IN_APP" && input.userId === undefined) continue;

    const id = await enqueueNotification({
      tenantId: input.tenantId,
      userId: input.userId,
      patientId: input.patientId,
      event: input.event,
      eventId: input.eventId,
      channel,
      locale: input.locale,
      recipient: recipient ?? undefined,
      variables: input.variables,
      tx: input.tx,
    });

    if (id !== null) inserted += 1;
  }

  return inserted;
}

/**
 * Savepoint-protected enqueue for business transactions.
 *
 * Notification failure is never allowed to roll back a booking, invoice,
 * payment or registration. The savepoint is local to the caller's transaction,
 * so a successful enqueue still commits atomically with the business event.
 */
export async function enqueueNotificationsSafely(
  tx: DatabaseTransaction,
  input: EnqueueNotificationChannelsInput,
): Promise<number> {
  const savepoint = `notification_enqueue_${input.event.toLowerCase()}`;

  await tx.execute(sql`savepoint ${sql.raw(savepoint)}`);

  try {
    const inserted = await enqueueNotificationForChannels({ ...input, tx });
    await tx.execute(sql`release savepoint ${sql.raw(savepoint)}`);
    return inserted;
  } catch (error) {
    try {
      await tx.execute(sql`rollback to savepoint ${sql.raw(savepoint)}`);
      await tx.execute(sql`release savepoint ${sql.raw(savepoint)}`);
    } catch {
      // The business transaction remains authoritative.
    }

    logger.warn(
      { tenantId: input.tenantId, event: input.event, sourceEventId: input.eventId },
      "Notification enqueue failed; business transaction preserved",
    );
    return 0;
  }
}
