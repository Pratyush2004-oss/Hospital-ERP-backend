/**
 * Audit vocabulary and contracts (Phase 21.1).
 *
 * Actions are dotted `<module>.<operation>` strings. They are deliberately
 * stable and narrow: a new action is added here rather than passing arbitrary
 * request data into `action`.
 */

export const AUDIT_ACTIONS = {
  AUTH_REGISTERED: "auth.registered",
  AUTH_LOGIN_SUCCEEDED: "auth.login.succeeded",
  AUTH_LOGIN_FAILED: "auth.login.failed",
  AUTH_LOGOUT: "auth.logout",
  AUTH_LOGOUT_ALL: "auth.logout_all",
  AUTH_SESSION_REUSE_DETECTED: "auth.session.reuse_detected",
  AUTH_PASSWORD_CHANGED: "auth.password.changed",
  AUTH_PASSWORD_RESET: "auth.password.reset",
  AUTH_TENANT_SELECTED: "auth.tenant.selected",
  AUTH_AUTHORIZATION_DENIED: "auth.authorization.denied",

  HOSPITAL_CREATED: "hospital.created",
  HOSPITAL_STATUS_CHANGED: "hospital.status_changed",
  HOSPITAL_SETTING_UPDATED: "hospital.setting.updated",

  BRANCH_CREATED: "branch.created",
  BRANCH_UPDATED: "branch.updated",
  BRANCH_STATUS_CHANGED: "branch.status_changed",
  BRANCH_DELETED: "branch.deleted",

  DEPARTMENT_CREATED: "department.created",
  DEPARTMENT_UPDATED: "department.updated",
  DEPARTMENT_STATUS_CHANGED: "department.status_changed",
  DEPARTMENT_DELETED: "department.deleted",

  DOCTOR_CREATED: "doctor.created",
  DOCTOR_UPDATED: "doctor.updated",
  DOCTOR_ASSIGNMENTS_CHANGED: "doctor.assignments_changed",
  DOCTOR_STATUS_CHANGED: "doctor.status_changed",
  DOCTOR_DELETED: "doctor.deleted",

  PATIENT_CREATED: "patient.created",
  PATIENT_UPDATED: "patient.updated",
  PATIENT_STATUS_CHANGED: "patient.status_changed",
  PATIENT_DELETED: "patient.deleted",
  PATIENT_ACCOUNT_LINKED: "patient.account_linked",
  PATIENT_ACCOUNT_UNLINKED: "patient.account_unlinked",

  APPOINTMENT_CREATED: "appointment.created",
  APPOINTMENT_RESCHEDULED: "appointment.rescheduled",
  APPOINTMENT_CANCELLED: "appointment.cancelled",
  APPOINTMENT_STATUS_CHANGED: "appointment.status_changed",

  INVOICE_ISSUED: "invoice.issued",
  INVOICE_CANCELLED: "invoice.cancelled",
  INVOICE_STATUS_CHANGED: "invoice.status_changed",
  PAYMENT_RECORDED: "payment.recorded",
  REFUND_REQUESTED: "refund.requested",
  REFUND_APPROVED: "refund.approved",
  REFUND_REJECTED: "refund.rejected",
  REFUND_SUCCEEDED: "refund.succeeded",
  REFUND_FAILED: "refund.failed",

  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  ROLE_PERMISSIONS_CHANGED: "role.permissions_changed",
  MEMBERSHIP_ROLES_CHANGED: "membership.roles_changed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditActorScope = "TENANT" | "PLATFORM" | "USER" | "SYSTEM";

export interface AuditEventInput {
  readonly tenantId?: string | null;
  readonly branchId?: string | null;
  /** Defaults to the verified request actor. */
  readonly actorUserId?: string | null;
  /** Defaults to the request actor's plane. */
  readonly actorScope?: AuditActorScope;
  readonly action: string;
  readonly module: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly description?: string | null;
  readonly previousState?: unknown;
  readonly newState?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Globally unique stable key for retry/duplicate protection. */
  readonly dedupeKey?: string | null;
}

/** Read-only projection returned by the audit API; never includes dedupe keys. */
export interface AuditLogEntry {
  readonly id: string;
  readonly branchId: string | null;
  readonly actorUserId: string | null;
  readonly actorScope: string | null;
  readonly action: string;
  readonly module: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly description: string | null;
  readonly previousState: unknown;
  readonly newState: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

export interface AuditLogPage {
  readonly auditLogs: readonly AuditLogEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface AuditRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly branchId: string | null;
  readonly actorUserId: string | null;
  readonly actorScope: string | null;
  readonly action: string;
  readonly module: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly description: string | null;
  readonly previousState: unknown;
  readonly newState: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly dedupeKey: string | null;
  readonly createdAt: string;
}
