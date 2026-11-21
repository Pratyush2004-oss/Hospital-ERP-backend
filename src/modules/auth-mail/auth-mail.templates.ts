import type {
  AuthMailKind,
  AuthMailTemplate,
  AuthMailTemplateInput,
} from "./auth-mail.types.js";

/**
 * Branded HTML + plain-text templates for transactional authentication email.
 *
 * The HTML is deliberately table-based with inline styles so it renders in
 * common clients without external assets. Every interpolated value is escaped;
 * the only URL rendered comes from the trusted link builder.
 */

const BRAND = {
  name: "HospitalOS",
  color: "#0f766e",
  colorDark: "#115e59",
  ink: "#0f172a",
  muted: "#475569",
  border: "#e2e8f0",
  surface: "#f8fafc",
} as const;

const COPY: Record<
  AuthMailKind,
  {
    readonly subject: string;
    readonly preheader: string;
    readonly heading: string;
    readonly intro: (input: AuthMailTemplateInput) => string;
    readonly button: string;
    readonly fallback: string;
    readonly footnote: string;
  }
> = {
  EMAIL_VERIFICATION: {
    subject: "Verify your HospitalOS email address",
    preheader: "Confirm your email address to finish setting up your HospitalOS account.",
    heading: "Verify your email address",
    intro: (input) =>
      `Hi ${input.recipientName}, confirm this email address to secure your HospitalOS account and receive important hospital notifications.`,
    button: "Verify email address",
    fallback: "If the button does not work, open this link in your browser:",
    footnote:
      "You received this email because this address was used to create a HospitalOS account. If that was not you, you can ignore this message.",
  },
  PASSWORD_RESET: {
    subject: "Reset your HospitalOS password",
    preheader: "Use the secure link to choose a new HospitalOS password.",
    heading: "Reset your password",
    intro: (input) =>
      `Hi ${input.recipientName}, we received a request to reset the password for your HospitalOS account. Choose a new password using the button below.`,
    button: "Reset password",
    fallback: "If the button does not work, open this link in your browser:",
    footnote:
      "If you did not request a password reset, no action is needed. Your current password will keep working and this link will expire.",
  },
  STAFF_INVITATION: {
    subject: "You are invited to join HospitalOS",
    preheader: "Accept your staff invitation and set up your HospitalOS account.",
    heading: "You have been invited",
    intro: (input) =>
      `${input.inviterName ? `${input.inviterName} invited you` : "You have been invited"} to join ${
        input.hospitalName ?? BRAND.name
      } on HospitalOS. Accept the invitation to set up your staff account.`,
    button: "Accept invitation",
    fallback: "If the button does not work, open this link in your browser:",
    footnote:
      "This invitation was sent to you by a hospital administrator. If you were not expecting it, you can ignore this message.",
  },
  HOSPITAL_ACTIVATED: {
    subject: "Your hospital is now active on HospitalOS",
    preheader: "Your hospital registration has been approved. Continue setup in HospitalOS.",
    heading: "Your hospital is active",
    intro: (input) =>
      `Hi ${input.recipientName}, ${input.hospitalName ?? "your hospital"} has been approved and is now active on HospitalOS. Sign in, select your hospital and continue setup.`,
    button: "Continue setup",
    fallback: "If the button does not work, open this link in your browser:",
    footnote:
      "This message was sent because your hospital registration was approved. If you were not expecting it, contact your HospitalOS administrator.",
  },
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(value: string): string {
  // Only http(s) links are ever rendered. The caller builds them from
  // FRONTEND_URL, so this is defense in depth against a misconfiguration.
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

function renderHtml(kind: AuthMailKind, input: AuthMailTemplateInput): string {
  const copy = COPY[kind];
  const actionUrl = safeUrl(input.actionUrl);
  const intro = escapeHtml(copy.intro(input));
  const hospitalName = escapeHtml(input.hospitalName ?? BRAND.name);
  const supportEmail = input.supportEmail ? escapeHtml(input.supportEmail) : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${escapeHtml(copy.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.surface};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(copy.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background:${BRAND.color};padding:24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">HospitalOS</td>
                    <td align="right" style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#ccfbf1;">Hospital operations</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 12px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND.ink};">${escapeHtml(copy.heading)}</h1>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:${BRAND.muted};">${intro}</p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td align="center" style="border-radius:10px;background:${BRAND.color};">
                      <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(copy.button)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${escapeHtml(copy.fallback)}</p>
                <p style="margin:0 0 24px 0;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${escapeHtml(actionUrl)}" style="color:${BRAND.colorDark};">${escapeHtml(actionUrl)}</a>
                </p>
                ${input.expiresIn
                  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:10px;">
                  <tr>
                    <td style="padding:14px 16px;font-size:13px;line-height:1.6;color:${BRAND.muted};">
                      This secure, single-use link expires in <strong style="color:${BRAND.ink};">${escapeHtml(input.expiresIn)}</strong>. Do not forward this email.
                    </td>
                  </tr>
                </table>`
                  : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 32px 32px;">
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.7;color:#64748b;">${escapeHtml(copy.footnote)}</p>
                ${supportEmail ? `<p style="margin:0;font-size:12px;line-height:1.7;color:#64748b;">Need help? Contact <a href="mailto:${supportEmail}" style="color:${BRAND.colorDark};">${supportEmail}</a>.</p>` : ""}
              </td>
            </tr>
          </table>
          <p style="margin:20px 0 0 0;font-size:11px;line-height:1.6;color:#94a3b8;">
            ${hospitalName} &middot; Sent by HospitalOS &middot; This is an automated message.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText(kind: AuthMailKind, input: AuthMailTemplateInput): string {
  const copy = COPY[kind];
  const lines = [
    input.hospitalName ?? BRAND.name,
    "",
    copy.heading,
    "",
    copy.intro(input),
    "",
    `${copy.button}: ${input.actionUrl}`,
    "",
    ...(input.expiresIn
      ? [`This secure, single-use link expires in ${input.expiresIn}. Do not forward this email.`, ""]
      : []),
    copy.footnote,
  ];

  if (input.supportEmail) {
    lines.push("", `Need help? Contact ${input.supportEmail}.`);
  }

  lines.push("", "This is an automated message from HospitalOS.");

  return lines.join("\n");
}

export function renderAuthMailTemplate(
  kind: AuthMailKind,
  input: AuthMailTemplateInput,
): AuthMailTemplate {
  return {
    subject: COPY[kind].subject,
    html: renderHtml(kind, input),
    text: renderText(kind, input),
  };
}
