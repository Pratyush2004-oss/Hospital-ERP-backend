import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import { withPlatformTransaction } from "../../database/context.js";
import { notifications } from "../../database/schema/index.js";
import { acquireLock, releaseLock } from "../../infrastructure/redis/index.js";
import { logger } from "../../lib/logger.js";
import {
  createConfiguredNotificationProviders,
  NotificationProviderError,
  providerForChannel,
  type NotificationProviders,
} from "./notification.providers.js";
import type {
  NotificationBatchResult,
  NotificationChannel,
  NotificationStatus,
} from "./notification.types.js";

/**
 * Central notification delivery worker (Phase 20.2).
 *
 * Reliability model:
 * - a single `FOR UPDATE SKIP LOCKED` claim means concurrent API/worker
 *   processes never deliver the same row twice;
 * - `attempts` is incremented at claim time, so a crash after claiming still
 *   counts as an attempt and eventually exhausts the retry budget;
 * - PROCESSING rows whose lease (`next_attempt_at`) has expired are reclaimable,
 *   which recovers deliveries interrupted by a worker restart;
 * - transient failures are retried with exponential backoff, permanent failures
 *   and exhausted retries become terminal FAILED, and an unconfigured provider
 *   becomes SKIPPED without affecting other channels;
 * - in-app rows need no provider and are marked SENT immediately.
 *
 * Delivery is at-least-once: if the provider accepts a message and the database
 * update then fails, the row is retried. Provider adapters should therefore use
 * the row id as their idempotency key when one is available.
 */

interface ClaimedNotification {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly recipient: string | null;
  readonly subject: string | null;
  readonly body: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

const WORKER_LOCK_KEY = "hospitalos:notifications:worker";
const REMINDER_LOCK_KEY = "hospitalos:notifications:reminders";

async function claimNotifications(limit: number): Promise<ClaimedNotification[]> {
  return withPlatformTransaction(async (tx) => {
    const result = await tx.execute(sql`
      with due as (
        select id
        from notifications
        where status in ('PENDING', 'FAILED', 'PROCESSING')
          and attempts < max_attempts
          and next_attempt_at <= now()
        order by next_attempt_at asc, created_at asc
        limit ${limit}
        for update skip locked
      )
      update notifications n
      set status = 'PROCESSING',
          attempts = n.attempts + 1,
          next_attempt_at = now() + make_interval(secs => ${env.NOTIFICATION_PROCESSING_TIMEOUT_SECONDS}),
          updated_at = now()
      from due
      where n.id = due.id
      returning n.id, n.tenant_id, n.channel, n.recipient, n.subject, n.body,
                n.attempts, n.max_attempts
    `);

    return (
      result.rows as Array<{
        id: string;
        tenant_id: string;
        channel: NotificationChannel;
        recipient: string | null;
        subject: string | null;
        body: string;
        attempts: number;
        max_attempts: number;
      }>
    ).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      channel: row.channel,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  });
}

async function markNotification(
  id: string,
  values: {
    status: NotificationStatus;
    providerMessageId?: string | null;
    lastError?: string | null;
    sentAt?: Date | null;
    nextAttemptAt?: Date;
  },
): Promise<void> {
  await withPlatformTransaction(async (tx) => {
    await tx
      .update(notifications)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(notifications.id, id));
  });
}

/**
 * Processes one batch of due rows. Exported for tests and for one-shot operators;
 * providers are injectable so no automated test contacts a real service.
 */
export async function processNotificationBatch(
  options: {
    readonly limit?: number;
    readonly providers?: NotificationProviders;
    readonly retryBaseSeconds?: number;
  } = {},
): Promise<NotificationBatchResult> {
  const limit = options.limit ?? env.NOTIFICATION_BATCH_SIZE;
  const providers = options.providers ?? createConfiguredNotificationProviders();
  const retryBaseSeconds = options.retryBaseSeconds ?? env.NOTIFICATION_RETRY_BASE_SECONDS;

  const rows = await claimNotifications(limit);
  let sent = 0;
  let failed = 0;
  let retried = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.channel === "IN_APP") {
      await markNotification(row.id, {
        status: "SENT",
        providerMessageId: null,
        lastError: null,
        sentAt: new Date(),
      });
      sent += 1;
      continue;
    }

    const provider = providerForChannel(providers, row.channel);

    if (!provider || row.recipient === null) {
      await markNotification(row.id, {
        status: "SKIPPED",
        lastError: provider ? "recipient_missing" : "provider_not_configured",
      });
      skipped += 1;
      continue;
    }

    try {
      const result = await provider.send({
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
      });

      await markNotification(row.id, {
        status: "SENT",
        providerMessageId: result.messageId,
        lastError: null,
        sentAt: new Date(),
      });
      sent += 1;
    } catch (error) {
      // Unknown provider failures are treated as transient so a temporary
      // outage can recover; the retry budget still bounds total attempts.
      const transient = !(error instanceof NotificationProviderError) || error.transient;
      const code = error instanceof NotificationProviderError ? error.message : "provider_error";
      const exhausted = row.attempts >= row.maxAttempts;

      if (!transient || exhausted) {
        await markNotification(row.id, {
          status: "FAILED",
          lastError: exhausted ? "retry_limit_exceeded" : code,
        });
        failed += 1;
        continue;
      }

      const delayMs = retryBaseSeconds * 1_000 * 2 ** Math.max(0, row.attempts - 1);

      await markNotification(row.id, {
        status: "FAILED",
        lastError: code,
        nextAttemptAt: new Date(Date.now() + delayMs),
      });
      retried += 1;
    }
  }

  return { claimed: rows.length, sent, failed, retried, skipped };
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

/** Runs one worker tick under the Redis lock; exported for the scheduler. */
export async function runNotificationWorkerOnce(): Promise<NotificationBatchResult | null> {
  if (workerRunning) return null;
  workerRunning = true;

  const token = randomUUID();
  let holdsLock = false;

  try {
    try {
      holdsLock = await acquireLock(WORKER_LOCK_KEY, token, env.NOTIFICATION_WORKER_INTERVAL_MS * 3);
      if (!holdsLock) return null;
    } catch (error) {
      // Redis outage must not stop delivery: the database claim already
      // prevents duplicate sends across processes. The lock only reduces work.
      logger.warn({ err: error }, "Notification worker lock unavailable; processing without lock");
    }

    return await processNotificationBatch();
  } catch (error) {
    logger.error({ err: error }, "Notification worker batch failed");
    return null;
  } finally {
    if (holdsLock) {
      try {
        await releaseLock(WORKER_LOCK_KEY, token);
      } catch (error) {
        logger.warn({ err: error }, "Failed to release the notification worker lock");
      }
    }

    workerRunning = false;
  }
}

/**
 * Starts the in-process delivery loop. Safe to call once during bootstrap;
 * returns an idempotent stop function for graceful shutdown and tests.
 */
export function startNotificationWorker(): () => void {
  if (!env.NOTIFICATION_WORKER_ENABLED || workerTimer !== null) {
    return () => undefined;
  }

  workerTimer = setInterval(() => {
    void runNotificationWorkerOnce();
  }, env.NOTIFICATION_WORKER_INTERVAL_MS);
  workerTimer.unref();

  logger.info(
    { intervalMs: env.NOTIFICATION_WORKER_INTERVAL_MS },
    "Notification delivery worker started",
  );

  return stopNotificationWorker;
}

export function stopNotificationWorker(): void {
  if (workerTimer !== null) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info("Notification delivery worker stopped");
  }
}

/** Reminder sweep lock shared with the appointment reminder scheduler. */
export async function withReminderLock<T>(callback: () => Promise<T>): Promise<T | null> {
  const token = randomUUID();

  try {
    const acquired = await acquireLock(
      REMINDER_LOCK_KEY,
      token,
      env.APPOINTMENT_REMINDER_INTERVAL_MS * 3,
    );
    if (!acquired) return null;
  } catch (error) {
    logger.warn({ err: error }, "Reminder lock unavailable; sweep runs unguarded");
  }

  try {
    return await callback();
  } finally {
    try {
      await releaseLock(REMINDER_LOCK_KEY, token);
    } catch {
      // TTL expires the lock if the release fails.
    }
  }
}
