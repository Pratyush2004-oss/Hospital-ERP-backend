import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type {
  AuthMailMessage,
  AuthMailProvider,
  AuthMailProviderResult,
} from "./auth-mail.types.js";

/**
 * Provider adapters for transactional authentication email.
 *
 * Three modes are supported:
 * - `none`    no provider is configured; delivery is suppressed (development).
 * - `mock`    deterministic in-memory delivery used by tests and local dev.
 * - `real`    Resend's HTTP API, configured entirely from the environment.
 *
 * Adapter errors expose only a stable code and a transient flag. Provider
 * response bodies are never surfaced because they can echo recipient data.
 */

export class AuthMailProviderError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, options: { transient: boolean }) {
    super(code);
    this.name = "AuthMailProviderError";
    this.code = code;
    this.transient = options.transient;
  }
}

/** In-memory outbox shared by the mock adapter; tests inspect it. */
export const mockAuthMailOutbox: AuthMailMessage[] = [];

export function clearMockAuthMailOutbox(): void {
  mockAuthMailOutbox.length = 0;
}

export function createNoneAuthMailProvider(): AuthMailProvider {
  return {
    mode: "none",
    async send() {
      throw new AuthMailProviderError("auth_mail_provider_not_configured", {
        transient: false,
      });
    },
  };
}

export function createMockAuthMailProvider(
  options: { fail?: "transient" | "permanent" } = {},
): AuthMailProvider {
  return {
    mode: "mock",
    async send(message) {
      if (options.fail === "transient") {
        throw new AuthMailProviderError("mock_transient_failure", { transient: true });
      }
      if (options.fail === "permanent") {
        throw new AuthMailProviderError("mock_permanent_failure", { transient: false });
      }

      mockAuthMailOutbox.push(message);
      return { messageId: `mock-auth-mail-${randomUUID()}` };
    },
  };
}

export interface ResendAuthMailProviderOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly replyTo?: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface ResendErrorBody {
  readonly name?: string;
  readonly message?: string;
}

function formatFromAddress(fromName: string, fromEmail: string): string {
  const safeName = fromName.replace(/[\r\n"<>]/g, " ").trim();
  return safeName.length > 0 ? `${safeName} <${fromEmail}>` : fromEmail;
}

/**
 * Real transactional email adapter using Resend's `POST /emails` endpoint.
 * No SDK dependency is needed and the API key never leaves this function.
 */
export function createResendAuthMailProvider(
  options: ResendAuthMailProviderOptions,
): AuthMailProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    mode: "real",
    async send(message: AuthMailMessage): Promise<AuthMailProviderResult> {
      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: formatFromAddress(options.fromName, options.fromEmail),
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo ?? options.replyTo
              ? { reply_to: message.replyTo ?? options.replyTo }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new AuthMailProviderError(
          timedOut ? "auth_mail_provider_timeout" : "auth_mail_provider_unreachable",
          { transient: true },
        );
      }

      if (!response.ok) {
        let providerCode = `auth_mail_http_${response.status}`;

        try {
          const body = (await response.json()) as ResendErrorBody;
          if (typeof body.name === "string" && /^[a-z0-9_.-]{1,60}$/i.test(body.name)) {
            providerCode = `auth_mail_${body.name.toLowerCase()}`;
          }
        } catch {
          // A non-JSON error body adds no safe information.
        }

        const transient = response.status === 429 || response.status >= 500;
        throw new AuthMailProviderError(providerCode, { transient });
      }

      let messageId: string | null = null;

      try {
        const body = (await response.json()) as { id?: unknown };
        if (typeof body.id === "string" && body.id.length > 0) {
          messageId = body.id;
        }
      } catch {
        // A successful send without a parseable body still counts as delivered.
      }

      return { messageId: messageId ?? `resend-${randomUUID()}` };
    },
  };
}

/**
 * Builds the provider selected by `AUTH_MAIL_PROVIDER`. Environment validation
 * already guarantees that production selects `real` with a key, so this
 * factory only has to construct the adapter.
 */
export function createConfiguredAuthMailProvider(
  config: {
    readonly provider?: "none" | "mock" | "real";
    readonly apiKey?: string;
    readonly fromEmail?: string;
    readonly fromName?: string;
    readonly replyTo?: string;
  } = {},
): AuthMailProvider {
  const mode = config.provider ?? env.AUTH_MAIL_PROVIDER;

  if (mode === "mock") return createMockAuthMailProvider();
  if (mode === "none") return createNoneAuthMailProvider();

  const apiKey = config.apiKey ?? env.AUTH_MAIL_RESEND_API_KEY;

  if (!apiKey) {
    // Defensive: configuration validation normally makes this unreachable.
    logger.error("AUTH_MAIL_PROVIDER=real is set without AUTH_MAIL_RESEND_API_KEY");
    return createNoneAuthMailProvider();
  }

  return createResendAuthMailProvider({
    apiKey,
    fromEmail: config.fromEmail ?? env.AUTH_MAIL_FROM_EMAIL,
    fromName: config.fromName ?? env.AUTH_MAIL_FROM_NAME,
    replyTo: config.replyTo ?? env.AUTH_MAIL_REPLY_TO,
    apiBaseUrl: env.AUTH_MAIL_API_BASE_URL,
    timeoutMs: env.AUTH_MAIL_TIMEOUT_MS,
  });
}
