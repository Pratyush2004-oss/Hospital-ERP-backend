import type { DatabaseTransaction } from "../../database/context.js";

export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL", "SMS", "WHATSAPP"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_LOCALES = ["EN", "HI"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const NOTIFICATION_EVENTS = [
  "PATIENT_REGISTERED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_REMINDER",
  "DOCTOR_SCHEDULE_CHANGED",
  "PATIENT_ADMIN_UPDATED",
  "INVOICE_ISSUED",
  "INVOICE_DUE_SOON",
  "INVOICE_OVERDUE",
  "PAYMENT_RECEIVED",
  "PAYMENT_FAILED",
  "REFUND_PROCESSED",
  "REFUND_FAILED",
  "SYSTEM_ANNOUNCEMENT",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface NotificationEventPayload {
  readonly eventId: string;
  readonly tenantId: string;
  readonly event: NotificationEvent;
  readonly userId?: string;
  readonly patientId?: string;
  readonly sourceId?: string;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EnqueueNotificationInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly patientId?: string;
  readonly event: NotificationEvent;
  readonly eventId: string;
  readonly sourceId?: string;
  readonly channel: NotificationChannel;
  readonly locale?: NotificationLocale;
  readonly recipient?: string;
  readonly variables: Readonly<Record<string, string | number | boolean | null>>;
  readonly tx: DatabaseTransaction;
}

export interface NotificationProviderResult {
  readonly messageId: string;
}

export interface NotificationProviderErrorOptions {
  readonly transient: boolean;
}

export const NOTIFICATION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "SKIPPED",
] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Safe, recipient-owned representation returned by the notification API. */
export interface NotificationDto {
  readonly id: string;
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly subject: string | null;
  readonly body: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly readAt: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface NotificationPage {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly notifications: readonly NotificationDto[];
}

export interface NotificationPreferenceDto {
  readonly id: string;
  readonly event: NotificationEvent | null;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly isTenantDefault: boolean;
  readonly updatedAt: string;
}

export interface UpsertNotificationPreferenceInput {
  readonly event: NotificationEvent | null;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

export interface NotificationBatchResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly retried: number;
  readonly skipped: number;
}

export interface EnqueueNotificationChannelsInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly patientId?: string;
  readonly event: NotificationEvent;
  readonly eventId: string;
  readonly channels: readonly NotificationChannel[];
  readonly locale?: NotificationLocale;
  readonly variables: Readonly<Record<string, string | number | boolean | null>>;
  /** Optional per-channel address override (tests and staff-targeted sends). */
  readonly recipients?: Partial<Record<NotificationChannel, string>>;
  readonly tx: DatabaseTransaction;
}
