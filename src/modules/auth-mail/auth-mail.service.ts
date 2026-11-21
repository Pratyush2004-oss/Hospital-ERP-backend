import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import {
  AuthMailProviderError,
  createConfiguredAuthMailProvider,
} from "./auth-mail.providers.js";
import { renderAuthMailTemplate } from "./auth-mail.templates.js";
import {
  AUTH_MAIL_PATHS,
  type AuthMailDeliveryResult,
  type AuthMailKind,
  type AuthMailProvider,
} from "./auth-mail.types.js";

/**
 * Single entry point for sending transactional authentication email.
 *
 * Token mail passes a raw token exactly once; notification mail (hospital
 * activation) passes a page URL instead. This module renders the branded
 * HTML/text pair and hands it to the configured provider. Tokens, links and
 * recipient addresses are never logged.
 */

export interface SendAuthMailInput {
  readonly to: string;
  readonly recipientName: string;
  readonly kind: AuthMailKind;
  /** Single-use link token; omitted for informational notifications. */
  readonly token?: string;
  readonly expiresAt?: Date;
  /** Explicit page URL; otherwise a token or activation page link is built. */
  readonly actionUrl?: string;
  readonly hospitalName?: string;
  readonly hospitalSlug?: string;
  readonly inviterName?: string;
}

/** Builds the production frontend link for a token, rooted at FRONTEND_URL. */
export function buildAuthMailActionUrl(
  kind: AuthMailKind,
  token: string,
  frontendUrl: string = env.FRONTEND_URL,
): string {
  const base = frontendUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${AUTH_MAIL_PATHS[kind]}`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Builds a non-token frontend page link (activation and similar notices). */
export function buildAuthMailPageUrl(
  kind: AuthMailKind,
  params: Readonly<Record<string, string | undefined>> = {},
  frontendUrl: string = env.FRONTEND_URL,
): string {
  const base = frontendUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${AUTH_MAIL_PATHS[kind]}`);

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

function describeExpiry(expiresAt: Date, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now) / 60_000));

  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof AuthMailProviderError) return error.code;
  return "auth_mail_unknown_error";
}

/**
 * Sends one authentication email through the configured adapter.
 *
 * Delivery failure is reported, not thrown: account registration, password
 * reset requests and invitations must not roll back because a provider is
 * temporarily unavailable. Callers audit the result and can offer a resend.
 */
export async function sendAuthMail(
  input: SendAuthMailInput,
  options: { readonly provider?: AuthMailProvider } = {},
): Promise<AuthMailDeliveryResult> {
  const provider = options.provider ?? createConfiguredAuthMailProvider();

  if (provider.mode === "none") {
    logger.warn(
      { kind: input.kind },
      "Authentication email suppressed: AUTH_MAIL_PROVIDER is none",
    );
    return { status: "SUPPRESSED", mode: "none", messageId: null };
  }

  const actionUrl =
    input.actionUrl ??
    (input.token
      ? buildAuthMailActionUrl(input.kind, input.token)
      : buildAuthMailPageUrl(input.kind, { tenant: input.hospitalSlug }));
  const template = renderAuthMailTemplate(input.kind, {
    recipientName: input.recipientName,
    actionUrl,
    ...(input.expiresAt ? { expiresIn: describeExpiry(input.expiresAt) } : {}),
    hospitalName: input.hospitalName,
    inviterName: input.inviterName,
    supportEmail: env.AUTH_MAIL_REPLY_TO,
  });

  try {
    const result = await provider.send({
      to: input.to,
      kind: input.kind,
      subject: template.subject,
      html: template.html,
      text: template.text,
      replyTo: env.AUTH_MAIL_REPLY_TO,
    });

    return {
      status: "SENT",
      mode: provider.mode,
      messageId: result.messageId,
    };
  } catch (error) {
    const errorCode = errorCodeOf(error);

    // Only stable codes and the provider mode are logged: never the recipient,
    // token, link or provider response body.
    logger.warn(
      { kind: input.kind, providerMode: provider.mode, errorCode },
      "Authentication email delivery failed",
    );

    return {
      status: "FAILED",
      mode: provider.mode,
      messageId: null,
      errorCode,
    };
  }
}
