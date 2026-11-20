/**
 * Billing notification contracts (Phase 19.10).
 *
 * Plain-text only: no HTML email, no medical content, no permanent public URLs.
 */

export const BILLING_NOTIFICATION_EVENTS = [
  "INVOICE_ISSUED",
  "PAYMENT_RECEIVED",
  "PAYMENT_FAILED",
  "PARTIAL_PAYMENT_RECEIVED",
  "INVOICE_OVERDUE",
  "INVOICE_DUE_SOON",
  "REFUND_SUCCEEDED",
  "REFUND_FAILED",
] as const;

export type BillingNotificationEvent = (typeof BILLING_NOTIFICATION_EVENTS)[number];

export const BILLING_NOTIFICATION_CHANNELS = ["EMAIL", "SMS"] as const;
export type BillingNotificationChannel = (typeof BILLING_NOTIFICATION_CHANNELS)[number];

export const BILLING_NOTIFICATION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "SKIPPED",
] as const;

export type BillingNotificationStatus = (typeof BILLING_NOTIFICATION_STATUSES)[number];

export interface BillingNotificationSettings {
  readonly enabled: boolean;
  readonly channels: readonly BillingNotificationChannel[];
  readonly dueSoonDays: readonly number[];
  readonly overdueEveryDays: number;
  readonly maxAttempts: number;
  readonly retryBaseSeconds?: number;
}

export const DEFAULT_BILLING_NOTIFICATION_SETTINGS: BillingNotificationSettings = {
  enabled: true,
  channels: ["EMAIL"],
  dueSoonDays: [7, 3, 1],
  overdueEveryDays: 7,
  maxAttempts: 3,
};

export interface BillingNotificationTemplate {
  readonly id: string | null;
  readonly subject: string | null;
  readonly body: string;
}

export interface BillingNotificationRecipient {
  readonly address: string;
  readonly channel: BillingNotificationChannel;
}

export interface EnqueueBillingNotificationInput {
  readonly event: BillingNotificationEvent;
  readonly invoiceId: string;
  readonly paymentId?: string;
  readonly refundId?: string;
  /** Stable unique key within the tenant (event + record + interval). */
  readonly dedupeKey: string;
  readonly paymentReference?: string | null;
  /** Explicit override used by reminder tests / preview flows. */
  readonly asOfDate?: string;
}

export interface BillingNotificationDto {
  readonly id: string;
  readonly event: BillingNotificationEvent;
  readonly channel: BillingNotificationChannel;
  readonly status: BillingNotificationStatus;
  readonly invoiceId: string | null;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  /** Masked for history responses; never a full contact in logs. */
  readonly recipient: string;
  readonly subject: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface BillingNotificationPage {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly notifications: readonly BillingNotificationDto[];
}

export interface ReminderSweepResult {
  readonly skipped: boolean;
  readonly tenants: number;
  readonly enqueued: number;
  readonly dueSoon: number;
  readonly overdue: number;
}

export interface NotificationBatchResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}
