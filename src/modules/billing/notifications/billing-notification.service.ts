import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../../database/context.js";
import {
  withPlatformTransaction,
  withTenantTransaction,
} from "../../../database/context.js";
import {
  billingNotificationTemplates,
  billingNotifications,
  branches,
  invoiceRefunds,
  invoices,
  patientContacts,
  payments,
  tenants,
} from "../../../database/schema/index.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { AppError } from "../../../lib/http-error.js";
import {
  loadBillingNotificationSettings,
} from "./billing-notification.settings.js";
import {
  DEFAULT_BILLING_NOTIFICATION_TEMPLATES,
  renderBillingTemplate,
} from "./billing-notification.templates.js";
import {
  BillingNotificationProviderError,
  createBillingNotificationProviders,
  providerForChannel,
  type BillingNotificationProviders,
} from "./billing-notification.providers.js";
import type {
  BillingNotificationChannel,
  BillingNotificationDto,
  BillingNotificationEvent,
  BillingNotificationPage,
  BillingNotificationRecipient,
  BillingNotificationStatus,
  EnqueueBillingNotificationInput,
  NotificationBatchResult,
} from "./billing-notification.types.js";

/**
 * Billing notification outbox, delivery and history (Phase 19.10).
 *
 * Enqueue runs in the caller's financial transaction but inside a savepoint, so
 * a template/contact/outbox failure cannot roll back an invoice, payment or
 * refund. A successful enqueue commits with that financial event (transactional
 * outbox). Delivery is asynchronous, retried with a bounded attempt count, and
 * claimed with `FOR UPDATE SKIP LOCKED` so repeated/concurrent workers are safe.
 *
 * Rendered messages contain only billing fields. No diagnosis, appointment
 * reason, patient name or permanent public URL is available to templates, and
 * logs contain identifiers/statuses only — never a recipient, message body or
 * API credential.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[1-9]\d{7,14}$/;

interface InvoiceContext {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly patientId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly hospitalName: string;
  readonly invoiceStatus: string;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
}

async function loadInvoiceContext(
  tx: DatabaseTransaction,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceContext> {
  const [row] = await tx
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      patientId: invoices.patientId,
      branchId: invoices.branchId,
      branchName: branches.name,
      hospitalName: tenants.name,
      invoiceStatus: invoices.invoiceStatus,
      dueDate: invoices.dueDate,
      currency: invoices.currency,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .innerJoin(
      branches,
      and(eq(branches.tenantId, tenantId), eq(branches.id, invoices.branchId)),
    )
    .innerJoin(tenants, eq(tenants.id, tenantId))
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
    .limit(1);

  if (!row) throw AppError.notFound("Invoice not found");
  return row;
}

function normalizeRecipient(
  channel: BillingNotificationChannel,
  phone: string | null,
  email: string | null,
): string | null {
  if (channel === "EMAIL") {
    if (email === null) return null;
    const normalized = email.trim().toLowerCase();
    return EMAIL_PATTERN.test(normalized) ? normalized : null;
  }

  if (phone === null) return null;
  const normalized = phone.replace(/[\s().-]/g, "");
  return PHONE_PATTERN.test(normalized) ? normalized : null;
}

async function findRecipient(
  tx: DatabaseTransaction,
  tenantId: string,
  patientId: string,
  channel: BillingNotificationChannel,
): Promise<BillingNotificationRecipient | null> {
  const rows = await tx
    .select({
      phone: patientContacts.phone,
      email: patientContacts.email,
      isPrimary: patientContacts.isPrimary,
    })
    .from(patientContacts)
    .where(
      and(
        eq(patientContacts.tenantId, tenantId),
        eq(patientContacts.patientId, patientId),
        channel === "EMAIL"
          ? sql`${patientContacts.email} is not null`
          : sql`${patientContacts.phone} is not null`,
      ),
    )
    .orderBy(desc(patientContacts.isPrimary), asc(patientContacts.createdAt));

  for (const row of rows) {
    const address = normalizeRecipient(channel, row.phone, row.email);
    if (address !== null) return { channel, address };
  }

  return null;
}

async function loadTemplate(
  tx: DatabaseTransaction,
  tenantId: string,
  event: BillingNotificationEvent,
  channel: BillingNotificationChannel,
) {
  const [override] = await tx
    .select({
      id: billingNotificationTemplates.id,
      subject: billingNotificationTemplates.subject,
      body: billingNotificationTemplates.body,
    })
    .from(billingNotificationTemplates)
    .where(
      and(
        eq(billingNotificationTemplates.tenantId, tenantId),
        eq(billingNotificationTemplates.event, event),
        eq(billingNotificationTemplates.channel, channel),
        eq(billingNotificationTemplates.isActive, true),
      ),
    )
    .limit(1);

  if (override) return override;
  return DEFAULT_BILLING_NOTIFICATION_TEMPLATES[channel][event];
}

async function loadPaymentFacts(
  tx: DatabaseTransaction,
  tenantId: string,
  input: EnqueueBillingNotificationInput,
): Promise<{ amount: string | null; reference: string | null; refundAmount: string | null }> {
  let amount: string | null = null;
  let reference: string | null = null;
  let refundAmount: string | null = null;

  if (input.paymentId !== undefined) {
    const [payment] = await tx
      .select({ amount: payments.amount, reference: payments.reference })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, input.paymentId)))
      .limit(1);
    amount = payment?.amount ?? null;
    reference = payment?.reference ?? null;
  }

  if (input.refundId !== undefined) {
    const [refund] = await tx
      .select({
        amount: invoiceRefunds.amount,
        reference: invoiceRefunds.reference,
      })
      .from(invoiceRefunds)
      .where(
        and(eq(invoiceRefunds.tenantId, tenantId), eq(invoiceRefunds.id, input.refundId)),
      )
      .limit(1);
    refundAmount = refund?.amount ?? null;
    reference = reference ?? refund?.reference ?? null;
  }

  return { amount, reference, refundAmount };
}

/**
 * Enqueues one notification per configured channel. Duplicate keys are ignored
 * at the unique index, so a repeated invocation cannot send twice.
 */
export async function enqueueBillingNotification(
  tx: DatabaseTransaction,
  tenantId: string,
  input: EnqueueBillingNotificationInput,
): Promise<number> {
  const settings = await loadBillingNotificationSettings(tx, tenantId);
  if (!settings.enabled || settings.channels.length === 0) return 0;

  const invoice = await loadInvoiceContext(tx, tenantId, input.invoiceId);
  const facts = await loadPaymentFacts(tx, tenantId, input);

  const variables: Record<string, string> = {
    hospital_name: invoice.hospitalName,
    branch_name: invoice.branchName,
    invoice_number: invoice.invoiceNumber,
    currency: invoice.currency,
    total_amount: invoice.totalAmount,
    amount_paid: invoice.amountPaid,
    balance_due: invoice.balanceDue,
    due_date: invoice.dueDate ?? "",
    payment_reference: facts.reference ?? "",
    payment_amount: facts.amount ?? "",
    refund_amount: facts.refundAmount ?? "",
    // Deliberately empty: production PDFs are private and only reachable through
    // authenticated streaming. No permanent public link is generated here.
    document_url: "",
  };

  let inserted = 0;

  for (const channel of settings.channels) {
    const recipient = await findRecipient(tx, tenantId, invoice.patientId, channel);
    if (!recipient) continue;

    const template = await loadTemplate(tx, tenantId, input.event, channel);
    const subject =
      template.subject === null || template.subject.trim() === ""
        ? null
        : renderBillingTemplate(template.subject, variables).slice(0, 300);
    const body = renderBillingTemplate(template.body, variables).slice(0, 4_000);

    const dedupeKey = `${input.dedupeKey}:${channel}`.slice(0, 220);

    const rows = await tx
      .insert(billingNotifications)
      .values({
        tenantId,
        event: input.event,
        channel,
        status: "PENDING",
        invoiceId: invoice.invoiceId,
        paymentId: input.paymentId ?? null,
        refundId: input.refundId ?? null,
        templateId: "id" in template ? template.id : null,
        recipient: recipient.address,
        subject,
        body,
        payload: {
          event: input.event,
          invoiceNumber: invoice.invoiceNumber,
          currency: invoice.currency,
          balanceDue: invoice.balanceDue,
          dueDate: invoice.dueDate,
          paymentReference: facts.reference,
        },
        dedupeKey,
        maxAttempts: settings.maxAttempts,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({
        target: [billingNotifications.tenantId, billingNotifications.dedupeKey],
      })
      .returning({ id: billingNotifications.id });

    inserted += rows.length;
  }

  return inserted;
}

/**
 * Savepoint-protected enqueue for financial transactions.
 *
 * The financial operation keeps its own success/failure semantics: if anything
 * in the notification path fails (including a missing table or invalid data),
 * the savepoint is rolled back and the invoice/payment/refund still commits.
 */
export async function enqueueBillingNotificationSafely(
  tx: DatabaseTransaction,
  tenantId: string,
  input: EnqueueBillingNotificationInput,
): Promise<number> {
  await tx.execute(sql`savepoint billing_notification_enqueue`);

  try {
    const inserted = await enqueueBillingNotification(tx, tenantId, input);
    await tx.execute(sql`release savepoint billing_notification_enqueue`);
    return inserted;
  } catch (error) {
    try {
      await tx.execute(sql`rollback to savepoint billing_notification_enqueue`);
      await tx.execute(sql`release savepoint billing_notification_enqueue`);
    } catch {
      // The financial transaction remains authoritative; nothing to add.
    }

    logger.warn(
      { tenantId, event: input.event, invoiceId: input.invoiceId },
      "Billing notification enqueue failed; financial transaction preserved",
    );
    return 0;
  }
}

function maskRecipient(channel: BillingNotificationChannel, recipient: string): string {
  if (channel === "EMAIL") {
    const [local, domain] = recipient.split("@");
    if (!domain) return "***";
    return `${(local ?? "").slice(0, 1)}***@${domain}`;
  }

  return recipient.length <= 4 ? "***" : `***${recipient.slice(-4)}`;
}

function toDto(row: {
  id: string;
  event: BillingNotificationEvent;
  channel: BillingNotificationChannel;
  status: BillingNotificationStatus;
  invoiceId: string | null;
  paymentId: string | null;
  refundId: string | null;
  recipient: string;
  subject: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}): BillingNotificationDto {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    status: row.status,
    invoiceId: row.invoiceId,
    paymentId: row.paymentId,
    refundId: row.refundId,
    recipient: maskRecipient(row.channel, row.recipient),
    subject: row.subject,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    providerMessageId: row.providerMessageId,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListBillingNotificationsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly event?: BillingNotificationEvent;
  readonly channel?: BillingNotificationChannel;
  readonly status?: BillingNotificationStatus;
  readonly invoiceId?: string;
}

export async function listBillingNotifications(
  tenantId: string,
  filters: ListBillingNotificationsFilters = {},
): Promise<BillingNotificationPage> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1) {
    throw AppError.validation("page must be a positive integer", { field: "page" });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.validation("pageSize must be between 1 and 100", { field: "pageSize" });
  }

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions = [
      eq(billingNotifications.tenantId, tenantId),
      filters.event !== undefined
        ? eq(billingNotifications.event, filters.event)
        : undefined,
      filters.channel !== undefined
        ? eq(billingNotifications.channel, filters.channel)
        : undefined,
      filters.status !== undefined
        ? eq(billingNotifications.status, filters.status)
        : undefined,
      filters.invoiceId !== undefined
        ? eq(billingNotifications.invoiceId, filters.invoiceId)
        : undefined,
    ];

    const where = and(...conditions)!;

    const [countRows, rows] = await Promise.all([
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(billingNotifications)
        .where(where),
      tx
        .select({
          id: billingNotifications.id,
          event: billingNotifications.event,
          channel: billingNotifications.channel,
          status: billingNotifications.status,
          invoiceId: billingNotifications.invoiceId,
          paymentId: billingNotifications.paymentId,
          refundId: billingNotifications.refundId,
          recipient: billingNotifications.recipient,
          subject: billingNotifications.subject,
          attempts: billingNotifications.attempts,
          maxAttempts: billingNotifications.maxAttempts,
          lastError: billingNotifications.lastError,
          providerMessageId: billingNotifications.providerMessageId,
          sentAt: billingNotifications.sentAt,
          createdAt: billingNotifications.createdAt,
        })
        .from(billingNotifications)
        .where(where)
        .orderBy(desc(billingNotifications.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      notifications: rows.map(toDto),
    };
  });
}

interface ClaimedNotification {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: BillingNotificationChannel;
  readonly recipient: string;
  readonly subject: string | null;
  readonly body: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

async function claimNotifications(limit: number): Promise<ClaimedNotification[]> {
  return withPlatformTransaction(async (tx) => {
    const result = await tx.execute(sql`
      with due as (
        select id
        from billing_notifications
        where status in ('PENDING', 'FAILED', 'PROCESSING')
          and attempts < max_attempts
          and next_attempt_at <= now()
        order by next_attempt_at asc, created_at asc
        limit ${limit}
        for update skip locked
      )
      update billing_notifications n
      set status = 'PROCESSING',
          attempts = n.attempts + 1,
          next_attempt_at = now() + make_interval(secs => ${env.BILLING_NOTIFICATION_PROCESSING_TIMEOUT_SECONDS}),
          updated_at = now()
      from due
      where n.id = due.id
      returning n.id, n.tenant_id, n.channel, n.recipient, n.subject, n.body,
                n.attempts, n.max_attempts
    `);

    return (result.rows as Array<{
      id: string;
      tenant_id: string;
      channel: BillingNotificationChannel;
      recipient: string;
      subject: string | null;
      body: string;
      attempts: number;
      max_attempts: number;
    }>).map((row) => ({
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
    status: BillingNotificationStatus;
    providerMessageId?: string | null;
    lastError?: string | null;
    sentAt?: Date | null;
    nextAttemptAt?: Date;
  },
): Promise<void> {
  await withPlatformTransaction(async (tx) => {
    await tx
      .update(billingNotifications)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(billingNotifications.id, id));
  });
}

/**
 * Processes one batch of due outbox rows. Safe to call concurrently: the claim
 * is a single `FOR UPDATE SKIP LOCKED` statement. Providers are injectable so
 * tests never send anything.
 */
export async function processBillingNotificationBatch(options: {
  readonly limit?: number;
  readonly providers?: BillingNotificationProviders;
  readonly retryBaseSeconds?: number;
} = {}): Promise<NotificationBatchResult> {
  const limit = options.limit ?? env.BILLING_NOTIFICATION_BATCH_SIZE;
  const providers = options.providers ?? createBillingNotificationProviders();
  const retryBaseSeconds = options.retryBaseSeconds ?? env.BILLING_NOTIFICATION_RETRY_BASE_SECONDS;

  const rows = await claimNotifications(limit);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const provider = providerForChannel(providers, row.channel);

    if (!provider) {
      await markNotification(row.id, {
        status: "SKIPPED",
        lastError: "provider_not_configured",
      });
      skipped += 1;
      continue;
    }

    try {
      const result =
        row.channel === "EMAIL"
          ? await providers.email!.send({
              to: row.recipient,
              from: env.BILLING_NOTIFICATION_FROM_EMAIL,
              subject: row.subject ?? "Billing notification",
              text: row.body,
            })
          : await providers.sms!.send({
              to: row.recipient,
              from: env.BILLING_NOTIFICATION_FROM_SMS,
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
      const transient =
        !(error instanceof BillingNotificationProviderError) || error.transient;
      const code =
        error instanceof BillingNotificationProviderError ? error.code : "provider_error";
      const exhausted = row.attempts >= row.maxAttempts;

      if (!transient || exhausted) {
        await markNotification(row.id, {
          status: "FAILED",
          lastError: exhausted ? "retry_limit_exceeded" : code,
        });
        failed += 1;
      } else {
        const delayMs =
          retryBaseSeconds * 1_000 * 2 ** Math.max(0, row.attempts - 1);
        await markNotification(row.id, {
          status: "FAILED",
          lastError: code,
          nextAttemptAt: new Date(Date.now() + delayMs),
        });
        failed += 1;
      }
    }
  }

  return { claimed: rows.length, sent, failed, skipped };
}
