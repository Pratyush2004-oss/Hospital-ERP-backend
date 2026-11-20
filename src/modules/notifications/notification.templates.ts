import type { NotificationChannel, NotificationEvent, NotificationLocale } from "./notification.types.js";

type Template = { readonly subject: string | null; readonly body: string };
type TemplateMap = Record<NotificationEvent, Template>;

const EN: TemplateMap = {
  PATIENT_REGISTERED: { subject: "Your hospital registration is complete", body: "Your registration at {{hospital_name}} is complete." },
  APPOINTMENT_BOOKED: { subject: "Appointment booked", body: "Your appointment has been booked for {{appointment_time}} at {{hospital_name}}." },
  APPOINTMENT_CONFIRMED: { subject: "Appointment confirmed", body: "Your appointment at {{hospital_name}} is confirmed for {{appointment_time}}." },
  APPOINTMENT_RESCHEDULED: { subject: "Appointment rescheduled", body: "Your appointment has been rescheduled to {{appointment_time}}." },
  APPOINTMENT_CANCELLED: { subject: "Appointment cancelled", body: "Your appointment scheduled for {{appointment_time}} was cancelled." },
  APPOINTMENT_REMINDER: { subject: "Appointment reminder", body: "Reminder: your appointment is scheduled for {{appointment_time}}." },
  DOCTOR_SCHEDULE_CHANGED: { subject: "Doctor schedule updated", body: "A doctor schedule at {{hospital_name}} was updated." },
  PATIENT_ADMIN_UPDATED: { subject: "Hospital record updated", body: "Your hospital record was updated. Please contact the hospital if you need help." },
  INVOICE_ISSUED: { subject: "Invoice issued", body: "Invoice {{invoice_number}} has been issued by {{hospital_name}}." },
  INVOICE_DUE_SOON: { subject: "Invoice due soon", body: "Invoice {{invoice_number}} is due on {{due_date}}." },
  INVOICE_OVERDUE: { subject: "Invoice overdue", body: "Invoice {{invoice_number}} was due on {{due_date}}." },
  PAYMENT_RECEIVED: { subject: "Payment received", body: "Payment received for invoice {{invoice_number}}." },
  PAYMENT_FAILED: { subject: "Payment failed", body: "A payment for invoice {{invoice_number}} could not be completed." },
  REFUND_PROCESSED: { subject: "Refund processed", body: "Your refund for invoice {{invoice_number}} has been processed." },
  REFUND_FAILED: { subject: "Refund failed", body: "Your refund for invoice {{invoice_number}} could not be processed." },
  SYSTEM_ANNOUNCEMENT: { subject: "{{announcement_title}}", body: "{{announcement_body}}" },
};

const HI: TemplateMap = Object.fromEntries(Object.entries(EN).map(([event, template]) => [event, {
  subject: template.subject === null ? null : `HospitalOS सूचना: ${template.subject}`,
  body: `HospitalOS: ${template.body}`,
}])) as TemplateMap;

const templates: Record<NotificationLocale, TemplateMap> = { EN, HI };

export function renderNotificationTemplate(template: string, variables: Readonly<Record<string, string | number | boolean | null>>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function getNotificationTemplate(event: NotificationEvent, channel: NotificationChannel, locale: NotificationLocale = "EN"): Template {
  const template = templates[locale][event];
  if (!template) throw new Error(`No notification template for ${event} (${channel}/${locale})`);
  return template;
}
