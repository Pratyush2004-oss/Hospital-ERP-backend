/**
 * RBAC catalogue: the actions the product understands and the roles seeded out
 * of the box.
 *
 * This file is pure data (no database access) so it can be reused by the seed
 * step, by provisioning, and later by authorization middleware without pulling
 * in a connection.
 */

export const PERMISSION_MODULES = [
  "tenant",
  "branch",
  "department",
  "doctor",
  "staff",
  "patient",
  "appointment",
  "payment",
  "reports",
  "schedule",
  "leave",
  "audit",
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export interface PermissionDefinition {
  /** Stable key in `<module>:<action>` form; never reused for a different action. */
  readonly key: string;
  readonly module: PermissionModule;
  readonly description: string;
}

export const PERMISSION_CATALOGUE = [
  // tenant
  { key: "tenant:read", module: "tenant", description: "View the hospital's profile and branding" },
  { key: "tenant:create", module: "tenant", description: "Create a new hospital tenant" },
  { key: "tenant:update", module: "tenant", description: "Update the hospital's profile and settings" },
  { key: "tenant:suspend", module: "tenant", description: "Suspend or reactivate a hospital tenant" },
  { key: "tenant:delete", module: "tenant", description: "Archive a hospital tenant" },

  // branch
  { key: "branch:read", module: "branch", description: "View branches of the hospital" },
  { key: "branch:create", module: "branch", description: "Create a new branch" },
  { key: "branch:update", module: "branch", description: "Update branch details" },
  { key: "branch:delete", module: "branch", description: "Deactivate or delete a branch" },

  // department
  { key: "department:read", module: "department", description: "View departments" },
  { key: "department:create", module: "department", description: "Create a department" },
  { key: "department:update", module: "department", description: "Update a department" },
  { key: "department:delete", module: "department", description: "Delete a department" },

  // doctor
  { key: "doctor:read", module: "doctor", description: "View doctor profiles and directory information" },
  { key: "doctor:create", module: "doctor", description: "Create doctor profiles" },
  { key: "doctor:update", module: "doctor", description: "Update doctor profiles, assignments and status" },
  { key: "doctor:delete", module: "doctor", description: "Soft delete a doctor profile" },
  { key: "doctor:schedule", module: "doctor", description: "Legacy broad key for managing doctor availability and roster" },

  // schedule (fine-grained roster actions, Task 16.6)
  {
    key: "schedule.create",
    module: "schedule",
    description: "Create recurring doctor schedule windows",
  },
  {
    key: "schedule.read",
    module: "schedule",
    description: "View recurring doctor schedule windows",
  },
  {
    key: "schedule.update",
    module: "schedule",
    description: "Update recurring doctor schedule windows and their active status",
  },
  {
    key: "schedule.delete",
    module: "schedule",
    description: "Delete recurring doctor schedule windows",
  },
  {
    key: "schedule.break.create",
    module: "schedule",
    description: "Add breaks inside a doctor schedule window",
  },
  {
    key: "schedule.break.read",
    module: "schedule",
    description: "View breaks inside doctor schedule windows",
  },
  {
    key: "schedule.break.update",
    module: "schedule",
    description: "Update breaks inside a doctor schedule window",
  },
  {
    key: "schedule.break.delete",
    module: "schedule",
    description: "Delete breaks from a doctor schedule window",
  },

  // doctor leave (workflow actions, Task 16.6)
  {
    key: "doctor.leave.create",
    module: "doctor",
    description: "Request doctor leave, for oneself or with management access for another doctor",
  },
  {
    key: "doctor.leave.read",
    module: "doctor",
    description: "View doctor leave requests",
  },
  {
    key: "doctor.leave.update",
    module: "doctor",
    description: "Edit pending doctor leave requests",
  },
  {
    key: "doctor.leave.approve",
    module: "doctor",
    description: "Approve pending doctor leave requests",
  },
  {
    key: "doctor.leave.reject",
    module: "doctor",
    description: "Reject pending doctor leave requests",
  },
  {
    key: "doctor.leave.cancel",
    module: "doctor",
    description: "Cancel doctor leave requests",
  },

  // staff
  { key: "staff:read", module: "staff", description: "View staff memberships" },
  { key: "staff:create", module: "staff", description: "Invite a staff member" },
  { key: "staff:update", module: "staff", description: "Update staff memberships" },
  { key: "staff:delete", module: "staff", description: "Remove a staff member" },
  { key: "staff:assign_role", module: "staff", description: "Assign or revoke roles for staff" },

  // patient
  { key: "patient:read", module: "patient", description: "View patient records" },
  { key: "patient:create", module: "patient", description: "Register a patient" },
  { key: "patient:update", module: "patient", description: "Update patient records" },
  { key: "patient:delete", module: "patient", description: "Archive a patient record" },
  // Patient documents are more sensitive than demographics (identity proofs,
  // insurance, referrals), so they are a separate, explicit grant.
  {
    key: "patient:document:read",
    module: "patient",
    description: "View patient document metadata and download documents",
  },
  {
    key: "patient:document:upload",
    module: "patient",
    description: "Attach documents to a patient record",
  },
  {
    key: "patient:document:delete",
    module: "patient",
    description: "Soft delete patient documents",
  },

  // appointment
  { key: "appointment:read", module: "appointment", description: "View appointments" },
  { key: "appointment:create", module: "appointment", description: "Book an appointment" },
  { key: "appointment:update", module: "appointment", description: "Reschedule or update an appointment" },
  { key: "appointment:cancel", module: "appointment", description: "Cancel an appointment" },

  // payment
  { key: "payment:read", module: "payment", description: "View invoices and payments" },
  { key: "payment:create", module: "payment", description: "Record a payment or raise an invoice" },
  { key: "payment:refund", module: "payment", description: "Refund a payment" },

  // reports
  { key: "reports:read", module: "reports", description: "View operational and financial reports" },
  { key: "reports:export", module: "reports", description: "Export reports" },

  // audit
  {
    key: "audit:read",
    module: "audit",
    description: "View the hospital's audit log and activity history",
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSION_CATALOGUE)[number]["key"];

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOGUE.map(
  (permission) => permission.key,
);

export interface RoleDefinition {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly PermissionKey[];
}

/** Platform plane: owned by HospitalOS, `tenant_id` is NULL. */
export const PLATFORM_ROLE_DEFINITIONS = [
  {
    slug: "platform_super_admin",
    name: "Platform Super Admin",
    description: "Unrestricted access across every tenant and platform setting",
    permissions: ALL_PERMISSION_KEYS,
  },
] as const satisfies readonly RoleDefinition[];

/**
 * Hospital plane: seeded per tenant (`is_system = true`) and freely extensible
 * with custom roles. Platform-only actions (`tenant:create`, `tenant:suspend`,
 * `tenant:delete`) are deliberately absent from every hospital role.
 */
export const HOSPITAL_ROLE_DEFINITIONS = [
  {
    slug: "hospital_admin",
    name: "Hospital Admin",
    description: "Full administrative control of one hospital",
    permissions: [
      "tenant:read",
      "tenant:update",
      "branch:read",
      "branch:create",
      "branch:update",
      "branch:delete",
      "department:read",
      "department:create",
      "department:update",
      "department:delete",
      "doctor:read",
      "doctor:create",
      "doctor:update",
      "doctor:delete",
      "doctor:schedule",
      "staff:read",
      "staff:create",
      "staff:update",
      "staff:delete",
      "staff:assign_role",
      "patient:read",
      "patient:create",
      "patient:update",
      "patient:delete",
      "patient:document:read",
      "patient:document:upload",
      "patient:document:delete",
      "appointment:read",
      "appointment:create",
      "appointment:update",
      "appointment:cancel",
      "payment:read",
      "payment:create",
      "payment:refund",
      "reports:read",
      "reports:export",
      "audit:read",
      "schedule.create",
      "schedule.read",
      "schedule.update",
      "schedule.delete",
      "schedule.break.create",
      "schedule.break.read",
      "schedule.break.update",
      "schedule.break.delete",
      "doctor.leave.create",
      "doctor.leave.read",
      "doctor.leave.update",
      "doctor.leave.approve",
      "doctor.leave.reject",
      "doctor.leave.cancel",
    ],
  },
  {
    slug: "branch_admin",
    name: "Branch Admin",
    description: "Administers a single branch: staff, patients and daily operations",
    permissions: [
      "tenant:read",
      "branch:read",
      "branch:update",
      "department:read",
      "department:create",
      "department:update",
      "doctor:read",
      "doctor:schedule",
      "staff:read",
      "staff:create",
      "staff:update",
      "staff:assign_role",
      "patient:read",
      "patient:create",
      "patient:update",
      "patient:document:read",
      "patient:document:upload",
      "patient:document:delete",
      "appointment:read",
      "appointment:create",
      "appointment:update",
      "appointment:cancel",
      "payment:read",
      "reports:read",
      "reports:export",
      "audit:read",
      "schedule.create",
      "schedule.read",
      "schedule.update",
      "schedule.delete",
      "schedule.break.create",
      "schedule.break.read",
      "schedule.break.update",
      "schedule.break.delete",
      "doctor.leave.create",
      "doctor.leave.read",
      "doctor.leave.update",
      "doctor.leave.approve",
      "doctor.leave.reject",
      "doctor.leave.cancel",
    ],
  },
  {
    slug: "receptionist",
    name: "Receptionist",
    description: "Front-desk registration, scheduling and payment collection",
    permissions: [
      "branch:read",
      "doctor:read",
      "patient:read",
      "patient:create",
      "patient:update",
      // Front desk scans identity/insurance documents at registration.
      "patient:document:read",
      "patient:document:upload",
      "appointment:read",
      "appointment:create",
      "appointment:update",
      "appointment:cancel",
      "payment:read",
      "payment:create",
      "reports:read",
      "schedule.read",
      "schedule.break.read",
      "doctor.leave.read",
    ],
  },
  {
    slug: "doctor",
    name: "Doctor",
    description: "Clinical access to assigned patients and appointments",
    permissions: [
      "branch:read",
      "department:read",
      "doctor:read",
      "patient:read",
      // Clinical context only: doctors may read documents, never upload/delete.
      "patient:document:read",
      "appointment:read",
      "appointment:update",
      "reports:read",
      "schedule.read",
      "schedule.break.read",
      "doctor.leave.create",
      "doctor.leave.read",
      "doctor.leave.update",
      "doctor.leave.cancel",
    ],
  },
  {
    slug: "nurse",
    name: "Nurse",
    description: "Patient care support and appointment handling",
    permissions: [
      "branch:read",
      "department:read",
      "doctor:read",
      "patient:read",
      "patient:update",
      // Nurses may attach and read documents while providing care.
      "patient:document:read",
      "patient:document:upload",
      "appointment:read",
      "appointment:update",
      "schedule.read",
      "schedule.break.read",
    ],
  },
  {
    slug: "accountant",
    name: "Accountant",
    description: "Billing, payments and financial reporting",
    permissions: [
      "branch:read",
      "patient:read",
      "appointment:read",
      "payment:read",
      "payment:create",
      "payment:refund",
      "reports:read",
      "reports:export",
    ],
  },
  {
    slug: "pharmacist",
    name: "Pharmacist",
    description: "Dispensing with read access to the patient's clinical context",
    permissions: [
      "branch:read",
      "department:read",
      "doctor:read",
      "patient:read",
      "appointment:read",
      "reports:read",
    ],
  },
  {
    slug: "lab_technician",
    name: "Lab Technician",
    description: "Laboratory work with read access to patients and orders",
    permissions: [
      "branch:read",
      "department:read",
      "doctor:read",
      "patient:read",
      "appointment:read",
      "reports:read",
    ],
  },
] as const satisfies readonly RoleDefinition[];

export type PlatformRoleSlug = (typeof PLATFORM_ROLE_DEFINITIONS)[number]["slug"];
export type HospitalRoleSlug = (typeof HOSPITAL_ROLE_DEFINITIONS)[number]["slug"];
