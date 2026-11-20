/**
 * Drizzle schema entry point.
 *
 * Table groups:
 * - tenants                  hospital (tenant) records
 * - users                    global accounts (may span tenants)
 * - tenant_memberships       user <-> tenant join with per-tenant uniqueness
 * - tenant_settings          per-tenant JSONB configuration
 * - branches                 tenant locations, codes unique per tenant
 * - roles                    permission bundles; platform (tenant NULL) or hospital
 * - permissions              global action catalogue (`patient:read`, ...)
 * - role_permissions         role <-> permission grants
 * - membership_roles         roles granted to a tenant membership
 * - departments              clinical/administrative units, home branch in branch_id
 * - department_branches      branches a department operates in (many-to-many)
 * - doctors                  clinical profile of a doctor within a hospital
 * - doctor_departments       doctor <-> department coverage
 * - doctor_branches          branch assignments with per-branch fee
 * - doctor_schedules         recurring weekly working periods (TIME)
 * - doctor_breaks            recurring pauses inside a working period
 * - doctor_leaves            dated absences (TIMESTAMPTZ), one branch or all
 * - patient_profiles         hospital-specific patient identity + MRN
 * - patient_contacts         phone/email reachability, one primary
 * - patient_addresses        postal addresses
 * - patient_emergency_contacts  who to call in an emergency
 * - patient_documents        private file metadata (storage keys, no URLs)
 * - patient_code_sequences   per-tenant MRN counter (internal only)
 * - auth_sessions            one per login; session revocation + active tenant
 * - auth_refresh_tokens      hashed rotating refresh tokens per session
 * - password_reset_tokens    hashed, single-use password reset tokens
 * - platform_user_roles      platform-plane roles (tenant NULL) per user
 * - appointments             booked consultations (tenant, patient, doctor, branch)
 * - appointment_events       append-only appointment history / audit trail
 * - appointment_idempotency_keys  replay protection for booking requests
 * - invoices                 hospital invoice headers (money, DRAFT lifecycle)
 * - invoice_items            billable lines; computed amounts per line
 * - invoice_number_sequences  per-tenant invoice number counter (internal only)
 * - invoice_payments         payment attempts; only SUCCESSFUL settles money
 * - invoice_refunds          refund transactions; only SUCCESSFUL reduces paid
 * - payments                 offline/manual receipts (cash, card, UPI, bank...)
 * - payment_allocations      how each payment is split across invoices
 * - payment_gateway_orders   provider checkout orders for pending online payments
 * - billing_documents        metadata for generated invoice/receipt/credit-note PDFs
 * - audit_logs               append-only, tenant-scoped security/activity trail
 *
 * Tenant isolation convention: every tenant-scoped table stores `tenant_id`
 * and exposes a unique `(tenant_id, id)` key. Child tables added later must
 * reference their parent with a composite foreign key
 * `(tenant_id, parent_id) -> parent(tenant_id, id)`, which makes cross-tenant
 * links impossible at the database level.
 *
 * Authorization planes are separate: platform roles carry no `tenant_id` and
 * can only be attached to global user state, while hospital roles are tied to a
 * tenant and reach users through `membership_roles`.
 */
export * from "./enums.js";
export * from "./tenants.js";
export * from "./users.js";
export * from "./tenant-memberships.js";
export * from "./tenant-settings.js";
export * from "./branches.js";
export * from "./roles.js";
export * from "./permissions.js";
export * from "./role-permissions.js";
export * from "./membership-roles.js";
export * from "./departments.js";
export * from "./department-branches.js";
export * from "./doctors.js";
export * from "./doctor-departments.js";
export * from "./doctor-branches.js";
export * from "./doctor-schedules.js";
export * from "./doctor-breaks.js";
export * from "./doctor-leaves.js";
export * from "./patient-profiles.js";
export * from "./patient-contacts.js";
export * from "./patient-addresses.js";
export * from "./patient-emergency-contacts.js";
export * from "./patient-documents.js";
export * from "./patient-code-sequences.js";
export * from "./auth-sessions.js";
export * from "./auth-refresh-tokens.js";
export * from "./password-reset-tokens.js";
export * from "./platform-user-roles.js";
export * from "./appointments.js";
export * from "./appointment-events.js";
export * from "./appointment-idempotency-keys.js";
export * from "./invoices.js";
export * from "./invoice-items.js";
export * from "./invoice-number-sequences.js";
export * from "./invoice-payments.js";
export * from "./invoice-refunds.js";
export * from "./payments.js";
export * from "./payment-allocations.js";
export * from "./payment-gateway-orders.js";
export * from "./billing-documents.js";
export * from "./billing-notifications.js";
export * from "./notifications.js";
export * from "./audit-logs.js";
