import { pgEnum } from "drizzle-orm/pg-core";

export const tenantStatusEnum = pgEnum("tenant_status", [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "INACTIVE",
]);

export const membershipStatusEnum = pgEnum("membership_status", [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
]);

/**
 * Authorization plane a role belongs to.
 * PLATFORM roles are owned by HospitalOS (no tenant); HOSPITAL roles are owned
 * by exactly one tenant.
 */
export const roleScopeEnum = pgEnum("role_scope", ["PLATFORM", "HOSPITAL"]);

/** Lifecycle of a doctor's leave request. */
export const doctorLeaveStatusEnum = pgEnum("doctor_leave_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

export const patientGenderEnum = pgEnum("patient_gender", [
  "MALE",
  "FEMALE",
  "OTHER",
  "UNKNOWN",
]);

export const bloodGroupEnum = pgEnum("blood_group", [
  "A_POSITIVE",
  "A_NEGATIVE",
  "B_POSITIVE",
  "B_NEGATIVE",
  "AB_POSITIVE",
  "AB_NEGATIVE",
  "O_POSITIVE",
  "O_NEGATIVE",
]);

export const patientStatusEnum = pgEnum("patient_status", [
  "ACTIVE",
  "INACTIVE",
  "DECEASED",
  "ARCHIVED",
]);

/** Optional demographic field; NULL means "not recorded", not "single". */
export const patientMaritalStatusEnum = pgEnum("patient_marital_status", [
  "SINGLE",
  "MARRIED",
  "DIVORCED",
  "WIDOWED",
  "OTHER",
]);

/** Purpose of an address; primary address uniqueness is per patient + type. */
export const patientAddressTypeEnum = pgEnum("patient_address_type", [
  "HOME",
  "WORK",
  "OTHER",
]);

export const patientContactTypeEnum = pgEnum("patient_contact_type", [
  "MOBILE",
  "HOME",
  "WORK",
  "GUARDIAN",
  "OTHER",
]);

export const patientDocumentTypeEnum = pgEnum("patient_document_type", [
  "IDENTITY_PROOF",
  "INSURANCE",
  "REFERRAL",
  "MEDICAL_HISTORY",
  "CONSENT",
  "OTHER",
]);

/**
 * Malware scan state. `PENDING` is the honest default while no scanner is
 * configured; an upload is never presented as malware-free.
 */
export const patientDocumentScanStatusEnum = pgEnum("patient_document_scan_status", [
  "PENDING",
  "CLEAN",
  "INFECTED",
  "FAILED",
]);

/**
 * Appointment lifecycle. Payment status is a separate concept and is never
 * stored here.
 *
 * Allowed transitions (enforced by the central table in
 * `appointment-service.shared.ts`):
 *   PENDING -> CONFIRMED | CANCELLED | RESCHEDULED
 *   CONFIRMED -> CHECKED_IN | CANCELLED | NO_SHOW | RESCHEDULED
 *   CHECKED_IN -> IN_PROGRESS | CANCELLED
 *   IN_PROGRESS -> COMPLETED
 *
 * A checked-in patient is never marked NO_SHOW: the consultation must be
 * started or the appointment cancelled. This is stricter than the original
 * Phase 18.1 sketch and matches the Phase 18.5 product rules.
 *
 * Terminal states are COMPLETED, CANCELLED, NO_SHOW and RESCHEDULED. A
 * reschedule marks the superseded row RESCHEDULED (releasing its slot) and
 * creates a new row; it is not an in-place slot change.
 *
 * Bookings created inside the transaction that reserves the slot are stored as
 * CONFIRMED immediately; PENDING is for intake/import flows and is not an
 * approval workflow.
 */
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
]);

/** Channel through which an appointment was created. */
export const appointmentSourceEnum = pgEnum("appointment_source", [
  "ONLINE",
  "RECEPTIONIST",
  "WALK_IN",
  "VOICE_AGENT",
]);

/**
 * Kind of visit. Kept separate from `appointment_source` (how it was booked)
 * and from the doctor's specialty/department.
 */
export const appointmentTypeEnum = pgEnum("appointment_type", [
  "CONSULTATION",
  "FOLLOW_UP",
  "PROCEDURE",
  "EMERGENCY",
]);

/**
 * Append-only history event kind. Status transitions are also recorded as
 * STATUS_CHANGED; CANCELLED/NO_SHOW/RESCHEDULED are given their own kinds so
 * history queries do not need to parse metadata.
 */
export const appointmentEventTypeEnum = pgEnum("appointment_event_type", [
  "CREATED",
  "STATUS_CHANGED",
  "UPDATED",
  "RESCHEDULED",
  "CANCELLED",
  "NO_SHOW",
]);

/**
 * Booking idempotency record state. A key starts IN_PROGRESS inside the booking
 * transaction and becomes COMPLETED when the appointment exists, or FAILED when
 * the request could not be fulfilled and the key may be retried by the client.
 */
export const appointmentIdempotencyStatusEnum = pgEnum("appointment_idempotency_status", [
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);

/**
 * Invoice lifecycle (Phase 19). New invoices are created as DRAFT; issuing and
 * payment-driven transitions are owned by the invoice lifecycle service
 * (Task 19.3.1), never by invoice creation or a client request body. Payment
 * state is never stored on invoice_items.
 *
 * Allowed transitions:
 *   DRAFT -> ISSUED | CANCELLED
 *   ISSUED -> OVERDUE | CANCELLED | PARTIALLY_PAID | PAID | REFUNDED
 *   OVERDUE -> CANCELLED | PARTIALLY_PAID | PAID | REFUNDED
 *   PARTIALLY_PAID -> PAID | REFUNDED
 *   PAID -> PARTIALLY_PAID (partial refund) | REFUNDED
 *   CANCELLED and REFUNDED are terminal.
 *
 * PARTIALLY_PAID, PAID and OVERDUE are derived from successful payment records
 * (and the due date) and are never set by a caller. REFUNDED is only allowed
 * when successful refund records exist. CANCELLED and REFUNDED close the
 * balance due so no further allocation is possible.
 */
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REFUNDED",
]);

/**
 * Outcome of one payment attempt against an invoice. Only SUCCESSFUL money
 * settles the invoice; PENDING, FAILED and REFUNDED attempts leave the balance
 * unchanged. `REFUNDED` describes the attempt itself after its money was
 * returned; the refund transaction is recorded in `invoice_refunds`.
 */
export const invoicePaymentStatusEnum = pgEnum("invoice_payment_status", [
  "PENDING",
  "SUCCESSFUL",
  "FAILED",
  "REFUNDED",
]);

/**
 * Outcome of one refund transaction (Phase 19.7.1).
 *
 * PENDING   - requested, awaiting a decision
 * APPROVED  - authorised for processing
 * PROCESSING- handed to the provider/desk, outcome not final
 * SUCCESSFUL- refund verified; only this state reduces net paid money
 * FAILED    - processing failed; may be retried
 * REJECTED  - request denied; terminal, never processed
 *
 * The existing SUCCESSFUL spelling is kept for compatibility with the balance
 * lifecycle; it is the schema's equivalent of the business "SUCCESS" state.
 */
export const invoiceRefundStatusEnum = pgEnum("invoice_refund_status", [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESSFUL",
  "FAILED",
  "REJECTED",
]);

/**
 * Kinds of generated billing documents (Phase 19.8.1).
 *
 * Each type maps to exactly one persisted financial record: an invoice, a
 * successful receipt-level payment, or a successful refund. A document is a
 * rendering of that record and never an independent financial source.
 */
export const billingDocumentTypeEnum = pgEnum("billing_document_type", [
  "INVOICE",
  "PAYMENT_RECEIPT",
  "CREDIT_NOTE",
]);

/** What the invoice as a whole is for; line items carry the finer type. */
export const invoiceTypeEnum = pgEnum("invoice_type", [
  "CONSULTATION",
  "PHARMACY",
  "LABORATORY",
  "PROCEDURE",
  "ADMISSION",
  "OTHER",
]);

/** Kind of billable line; CONSULTATION mirrors appointment consultations. */
export const invoiceItemTypeEnum = pgEnum("invoice_item_type", [
  "CONSULTATION",
  "REGISTRATION",
  "PROCEDURE",
  "LABORATORY",
  "PHARMACY",
  "ROOM_CHARGE",
  "OTHER",
]);

/** Matches the calculator's AMOUNT / PERCENTAGE discount kinds. */
export const invoiceDiscountTypeEnum = pgEnum("invoice_discount_type", [
  "AMOUNT",
  "PERCENTAGE",
]);

/**
 * How an offline/manual payment reached the hospital (Task 19.4.1).
 *
 * Deliberately tender-type only: gateway/provided identifiers belong in the
 * payment `reference` column and gateway integrations are out of scope. CHEQUE
 * is included because hospitals still receive them at the front desk.
 */
export const paymentMethodEnum = pgEnum("payment_method", [
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "CHEQUE",
  "OTHER",
]);

/**
 * Lifecycle of a gateway checkout order (Task 19.6.1).
 *
 * PENDING is the only state this task writes; the settlement task owns the
 * transition to SUCCEEDED/FAILED. EXPIRED and CANCELLED are reserved for
 * provider-side expiry and staff abandonment so the state model does not need a
 * second migration later. A gateway order never settles money by itself. The
 * linked `payments` row stays PENDING until verified success, and invoice
 * balances are untouched while it is pending.
 */
export const paymentGatewayOrderStatusEnum = pgEnum("payment_gateway_order_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

/** Billing moments that can produce a patient notification (Phase 19.10). */
export const billingNotificationEventEnum = pgEnum("billing_notification_event", [
  "INVOICE_ISSUED",
  "PAYMENT_RECEIVED",
  "PAYMENT_FAILED",
  "PARTIAL_PAYMENT_RECEIVED",
  "INVOICE_OVERDUE",
  "INVOICE_DUE_SOON",
  "REFUND_SUCCEEDED",
  "REFUND_FAILED",
]);

/** Delivery channel. Only configured adapters are used. */
export const billingNotificationChannelEnum = pgEnum("billing_notification_channel", [
  "EMAIL",
  "SMS",
]);

/** Outbox/delivery state; FAILED rows with remaining attempts are retried. */
export const billingNotificationStatusEnum = pgEnum("billing_notification_status", [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "IN_APP",
  "EMAIL",
  "SMS",
  "WHATSAPP",
]);

export const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

export const notificationLocaleEnum = pgEnum("notification_locale", ["EN", "HI"]);
