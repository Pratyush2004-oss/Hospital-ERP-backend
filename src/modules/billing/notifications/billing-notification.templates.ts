import type {
  BillingNotificationChannel,
  BillingNotificationEvent,
  BillingNotificationTemplate,
} from "./billing-notification.types.js";

/**
 * Default templates and safe rendering (Phase 19.10).
 *
 * Templates are plain text and may only reference the billing variables below.
 * No patient name, diagnosis, appointment reason or other medical information is
 * available to a template. Tenant overrides live in
 * `billing_notification_templates`; these defaults are used when no active
 * override exists.
 */

interface TemplateSet {
  readonly subject: string;
  readonly body: string;
}

const EMAIL: Record<BillingNotificationEvent, TemplateSet> = {
  INVOICE_ISSUED: {
    subject: "Invoice {{invoice_number}} — {{hospital_name}}",
    body: [
      "Hello,",
      "",
      "Invoice {{invoice_number}} for {{currency}} {{total_amount}} has been issued at {{branch_name}}.",
      "Due date: {{due_date}}.",
      "Outstanding balance: {{currency}} {{balance_due}}.",
      "",
      "You can view or download the document through the hospital's authenticated portal.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  PAYMENT_RECEIVED: {
    subject: "Payment received for invoice {{invoice_number}}",
    body: [
      "Hello,",
      "",
      "We received {{currency}} {{payment_amount}} for invoice {{invoice_number}}.",
      "Payment reference: {{payment_reference}}.",
      "Outstanding balance: {{currency}} {{balance_due}}.",
      "",
      "Thank you,",
      "{{hospital_name}}",
    ].join("\n"),
  },
  PAYMENT_FAILED: {
    subject: "Payment could not be completed for invoice {{invoice_number}}",
    body: [
      "Hello,",
      "",
      "A payment for invoice {{invoice_number}} could not be completed.",
      "Please contact the billing desk if you need assistance.",
      "Outstanding balance: {{currency}} {{balance_due}}.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  PARTIAL_PAYMENT_RECEIVED: {
    subject: "Partial payment received for invoice {{invoice_number}}",
    body: [
      "Hello,",
      "",
      "We received {{currency}} {{payment_amount}} toward invoice {{invoice_number}}.",
      "Payment reference: {{payment_reference}}.",
      "Remaining balance: {{currency}} {{balance_due}}.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  INVOICE_DUE_SOON: {
    subject: "Invoice {{invoice_number}} is due on {{due_date}}",
    body: [
      "Hello,",
      "",
      "Invoice {{invoice_number}} for {{currency}} {{balance_due}} is due on {{due_date}}.",
      "Please arrange payment before the due date.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  INVOICE_OVERDUE: {
    subject: "Invoice {{invoice_number}} is overdue",
    body: [
      "Hello,",
      "",
      "Invoice {{invoice_number}} was due on {{due_date}}.",
      "The outstanding balance is {{currency}} {{balance_due}}.",
      "Please contact the billing desk to arrange payment.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  REFUND_SUCCEEDED: {
    subject: "Refund processed for invoice {{invoice_number}}",
    body: [
      "Hello,",
      "",
      "A refund of {{currency}} {{refund_amount}} for invoice {{invoice_number}} has been processed.",
      "Reference: {{payment_reference}}.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
  REFUND_FAILED: {
    subject: "Refund could not be processed for invoice {{invoice_number}}",
    body: [
      "Hello,",
      "",
      "A refund for invoice {{invoice_number}} could not be processed.",
      "Please contact the billing desk for assistance.",
      "",
      "{{hospital_name}}",
    ].join("\n"),
  },
};

const SMS: Record<BillingNotificationEvent, TemplateSet> = {
  INVOICE_ISSUED: {
    subject: "",
    body: "{{hospital_name}}: Invoice {{invoice_number}} for {{currency}} {{total_amount}} is due {{due_date}}. Balance {{currency}} {{balance_due}}.",
  },
  PAYMENT_RECEIVED: {
    subject: "",
    body: "{{hospital_name}}: Payment of {{currency}} {{payment_amount}} received for invoice {{invoice_number}}. Balance {{currency}} {{balance_due}}.",
  },
  PAYMENT_FAILED: {
    subject: "",
    body: "{{hospital_name}}: Payment for invoice {{invoice_number}} was not completed. Please contact the billing desk.",
  },
  PARTIAL_PAYMENT_RECEIVED: {
    subject: "",
    body: "{{hospital_name}}: Partial payment of {{currency}} {{payment_amount}} received for invoice {{invoice_number}}. Remaining {{currency}} {{balance_due}}.",
  },
  INVOICE_DUE_SOON: {
    subject: "",
    body: "{{hospital_name}}: Invoice {{invoice_number}} for {{currency}} {{balance_due}} is due {{due_date}}.",
  },
  INVOICE_OVERDUE: {
    subject: "",
    body: "{{hospital_name}}: Invoice {{invoice_number}} was due {{due_date}}. Outstanding {{currency}} {{balance_due}}.",
  },
  REFUND_SUCCEEDED: {
    subject: "",
    body: "{{hospital_name}}: Refund of {{currency}} {{refund_amount}} for invoice {{invoice_number}} has been processed.",
  },
  REFUND_FAILED: {
    subject: "",
    body: "{{hospital_name}}: Refund for invoice {{invoice_number}} could not be processed. Please contact the billing desk.",
  },
};

export const DEFAULT_BILLING_NOTIFICATION_TEMPLATES: Record<
  BillingNotificationChannel,
  Record<BillingNotificationEvent, BillingNotificationTemplate>
> = {
  EMAIL: Object.fromEntries(
    Object.entries(EMAIL).map(([event, template]) => [
      event,
      { id: null, ...template },
    ]),
  ) as Record<BillingNotificationEvent, BillingNotificationTemplate>,
  SMS: Object.fromEntries(
    Object.entries(SMS).map(([event, template]) => [
      event,
      { id: null, ...template },
    ]),
  ) as Record<BillingNotificationEvent, BillingNotificationTemplate>,
};

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

/**
 * Replaces only known placeholders. Unknown placeholders render as an empty
 * string instead of leaking the raw token into a patient message.
 */
export function renderBillingTemplate(
  template: string,
  variables: Readonly<Record<string, string | null | undefined>>,
): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
