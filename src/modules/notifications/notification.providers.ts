import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { NotificationChannel, NotificationProviderResult } from "./notification.types.js";

export class NotificationProviderError extends Error {
  readonly transient: boolean;
  constructor(code: string, options: { transient: boolean }) {
    super(code);
    this.name = "NotificationProviderError";
    this.transient = options.transient;
  }
}

export interface NotificationMessage {
  readonly recipient: string;
  readonly subject: string | null;
  readonly body: string;
}

export interface NotificationProvider {
  send(message: NotificationMessage): Promise<NotificationProviderResult>;
}

export interface NotificationProviders {
  readonly email?: NotificationProvider;
  readonly sms?: NotificationProvider;
  readonly whatsapp?: NotificationProvider;
}

export function createMockNotificationProvider(options: { fail?: "transient" | "permanent" } = {}): NotificationProvider {
  return {
    async send() {
      if (options.fail === "transient") throw new NotificationProviderError("mock_transient_failure", { transient: true });
      if (options.fail === "permanent") throw new NotificationProviderError("mock_permanent_failure", { transient: false });
      return { messageId: `mock-notification-${randomUUID()}` };
    },
  };
}

export function providerForChannel(providers: NotificationProviders, channel: NotificationChannel): NotificationProvider | undefined {
  if (channel === "EMAIL") return providers.email;
  if (channel === "SMS") return providers.sms;
  if (channel === "WHATSAPP") return providers.whatsapp;
  return undefined;
}

export function createConfiguredNotificationProviders(): NotificationProviders {
  return {
    email: env.NOTIFICATION_EMAIL_PROVIDER === "mock" ? createMockNotificationProvider() : undefined,
    sms: env.NOTIFICATION_SMS_PROVIDER === "mock" ? createMockNotificationProvider() : undefined,
    whatsapp: env.NOTIFICATION_WHATSAPP_PROVIDER === "mock" ? createMockNotificationProvider() : undefined,
  };
}
