/**
 * Shared transactional authentication email contract (ONB-03).
 *
 * Verification, password-reset and staff-invitation mail all use this one
 * adapter so token handling, branding and provider configuration are not
 * duplicated per module. HTML and text bodies are always produced together.
 */

export const AUTH_MAIL_KINDS = [
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "STAFF_INVITATION",
  "HOSPITAL_ACTIVATED",
] as const;

export type AuthMailKind = (typeof AUTH_MAIL_KINDS)[number];

/** `none` suppresses delivery, `mock` records in memory, `real` sends. */
export type AuthMailProviderMode = "none" | "mock" | "real";

export interface AuthMailMessage {
  readonly to: string;
  readonly kind: AuthMailKind;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string | null;
  /** Non-sensitive routing hints only; never put a token here. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AuthMailProviderResult {
  readonly messageId: string;
}

export interface AuthMailProvider {
  readonly mode: AuthMailProviderMode;
  send(message: AuthMailMessage): Promise<AuthMailProviderResult>;
}

export interface AuthMailTemplateInput {
  readonly recipientName: string;
  readonly actionUrl: string;
  /** Human-readable lifetime; omitted for non-token notifications. */
  readonly expiresIn?: string;
  /** Hospital name for staff invitations; defaults to HospitalOS. */
  readonly hospitalName?: string;
  /** Who invited the recipient; invitations only. */
  readonly inviterName?: string;
  readonly supportEmail?: string;
}

export interface AuthMailTemplate {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export const AUTH_MAIL_STATUSES = ["SENT", "FAILED", "SUPPRESSED"] as const;
export type AuthMailStatus = (typeof AUTH_MAIL_STATUSES)[number];

export interface AuthMailDeliveryResult {
  readonly status: AuthMailStatus;
  readonly mode: AuthMailProviderMode;
  readonly messageId: string | null;
  /** Stable provider/configuration error code; never contains the token. */
  readonly errorCode?: string;
}

/** Path of the frontend page the email link opens (appended to FRONTEND_URL). */
export const AUTH_MAIL_PATHS: Readonly<Record<AuthMailKind, string>> = {
  EMAIL_VERIFICATION: "/verify-email",
  PASSWORD_RESET: "/reset-password",
  STAFF_INVITATION: "/accept-invitation",
  HOSPITAL_ACTIVATED: "/onboarding/status",
};
