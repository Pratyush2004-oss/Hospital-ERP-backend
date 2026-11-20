import { and, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../../database/context.js";
import {
  invoices,
  patientProfiles,
  tenants,
} from "../../../database/schema/index.js";
import { logger } from "../../../lib/logger.js";
import { enqueueNotificationsSafely } from "../../notifications/notification.service.js";
import type { NotificationEvent } from "../../notifications/notification.types.js";
import { enqueueBillingNotificationSafely } from "./billing-notification.service.js";
import type {
  BillingNotificationEvent,
  EnqueueBillingNotificationInput,
} from "./billing-notification.types.js";

/**
 * Billing -> central notification integration (Phase 20.2).
 *
 * The Phase 19.10 billing outbox remains the single delivery path for billing
 * EMAIL/SMS: it owns billing templates, tenant billing preferences, dedupe keys
 * and retries. This bridge adds an in-app item for the patient's linked account
 * and otherwise preserves that behavior exactly.
 *
 * Both writes are savepoint-protected and use the event's stable dedupe key, so
 * consuming the same billing event twice inserts nothing the second time. No
 * billing table or template is duplicated.
 */

const CENTRAL_EVENT: Record<BillingNotificationEvent, NotificationEvent | null> = {
  INVOICE_ISSUED: "INVOICE_ISSUED",
  INVOICE_DUE_SOON: "INVOICE_DUE_SOON",
  INVOICE_OVERDUE: "INVOICE_OVERDUE",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PARTIAL_PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  REFUND_SUCCEEDED: "REFUND_PROCESSED",
  REFUND_FAILED: "REFUND_FAILED",
};

export async function enqueueBillingNotificationIntegrated(
  tx: DatabaseTransaction,
  tenantId: string,
  input: EnqueueBillingNotificationInput,
): Promise<{ billing: number; central: number }> {
  await tx.execute(sql`savepoint billing_notification_bridge`);

  try {
    // Existing billing outbox: unchanged templates, channels, settings and worker.
    const billing = await enqueueBillingNotificationSafely(tx, tenantId, input);

    const centralEvent = CENTRAL_EVENT[input.event];

    if (centralEvent === null) {
      await tx.execute(sql`release savepoint billing_notification_bridge`);
      return { billing, central: 0 };
    }

    const [context] = await tx
      .select({
        invoiceNumber: invoices.invoiceNumber,
        dueDate: invoices.dueDate,
        patientUserId: patientProfiles.userId,
        hospitalName: tenants.name,
      })
      .from(invoices)
      .innerJoin(
        patientProfiles,
        and(
          eq(patientProfiles.tenantId, tenantId),
          eq(patientProfiles.id, invoices.patientId),
        ),
      )
      .innerJoin(tenants, eq(tenants.id, tenantId))
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, input.invoiceId)))
      .limit(1);

    // A patient without a linked account has no in-app inbox; billing EMAIL/SMS
    // has already been enqueued above.
    if (!context?.patientUserId) {
      await tx.execute(sql`release savepoint billing_notification_bridge`);
      return { billing, central: 0 };
    }

    const central = await enqueueNotificationsSafely(tx, {
      tenantId,
      userId: context.patientUserId,
      patientId: undefined,
      event: centralEvent,
      eventId: `billing:${input.event}:${input.dedupeKey}`,
      channels: ["IN_APP"],
      variables: {
        invoice_number: context.invoiceNumber,
        due_date: context.dueDate ?? "",
        hospital_name: context.hospitalName,
      },
      tx,
    });

    await tx.execute(sql`release savepoint billing_notification_bridge`);
    return { billing, central };
  } catch {
    try {
      await tx.execute(sql`rollback to savepoint billing_notification_bridge`);
      await tx.execute(sql`release savepoint billing_notification_bridge`);
    } catch {
      // Financial transaction remains authoritative.
    }

    logger.warn(
      { tenantId, event: input.event, invoiceId: input.invoiceId },
      "Billing notification bridge failed; financial transaction preserved",
    );
    return { billing: 0, central: 0 };
  }
}
