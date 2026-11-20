import { randomUUID } from "node:crypto";
import { env } from "../../../config/env.js";
import type { BillingNotificationChannel } from "./billing-notification.types.js";

/**
 * Provider-neutral email/SMS adapters (Phase 19.10).
 *
 * The project has no configured email or SMS vendor. The registry therefore
 * ships only `none` and deterministic `mock` adapters; a real provider is added
 * by implementing these interfaces, never by hardcoding vendor calls in the
 * notification service. Credentials belong in environment configuration and are
 * never logged.
 */

export class BillingNotificationProviderError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, transient: boolean) {
    // The message is a safe classification, not a provider payload or address.
    super(code);
    this.name = "BillingNotificationProviderError";
    this.code = code;
    this.transient = transient;
  }
}

export interface EmailNotification {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
}

export interface SmsNotification {
  readonly to: string;
  readonly from: string;
  readonly body: string;
}

export interface ProviderSendResult {
  readonly messageId: string;
}

export interface BillingEmailProvider {
  send(message: EmailNotification): Promise<ProviderSendResult>;
}

export interface BillingSmsProvider {
  send(message: SmsNotification): Promise<ProviderSendResult>;
}

export interface BillingNotificationProviders {
  readonly email?: BillingEmailProvider;
  readonly sms?: BillingSmsProvider;
}

export interface MockProviderOptions {
  readonly failWith?: "transient" | "permanent";
}

/** Deterministic in-process adapter. It never sends a real message. */
export function createMockEmailProvider(
  options: MockProviderOptions = {},
): BillingEmailProvider {
  return {
    async send() {
      if (options.failWith === "transient") {
        throw new BillingNotificationProviderError("mock_transient_failure", true);
      }
      if (options.failWith === "permanent") {
        throw new BillingNotificationProviderError("mock_permanent_failure", false);
      }
      return { messageId: `mock-email-${randomUUID()}` };
    },
  };
}

export function createMockSmsProvider(
  options: MockProviderOptions = {},
): BillingSmsProvider {
  return {
    async send() {
      if (options.failWith === "transient") {
        throw new BillingNotificationProviderError("mock_transient_failure", true);
      }
      if (options.failWith === "permanent") {
        throw new BillingNotificationProviderError("mock_permanent_failure", false);
      }
      return { messageId: `mock-sms-${randomUUID()}` };
    },
  };
}

/**
 * Builds adapters from configuration. `none` leaves the channel unconfigured;
 * the worker records the row as SKIPPED instead of attempting a send.
 */
export function createBillingNotificationProviders(): BillingNotificationProviders {
  return {
    email:
      env.BILLING_NOTIFICATION_EMAIL_PROVIDER === "mock"
        ? createMockEmailProvider()
        : undefined,
    sms:
      env.BILLING_NOTIFICATION_SMS_PROVIDER === "mock"
        ? createMockSmsProvider()
        : undefined,
  };
}

export function providerForChannel(
  providers: BillingNotificationProviders,
  channel: BillingNotificationChannel,
): BillingEmailProvider | BillingSmsProvider | undefined {
  return channel === "EMAIL" ? providers.email : providers.sms;
}
