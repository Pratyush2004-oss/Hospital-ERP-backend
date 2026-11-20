import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Central append-only audit log (Phase 21.1).
 *
 * One row describes one auditable action: who did what, to which tenant-scoped
 * resource, when, and from which request. `previous_state` / `new_state` hold
 * redacted snapshots only; `metadata` carries narrow identifiers and field-name
 * lists. Passwords, tokens, secrets, contact details and clinical free text are
 * removed by the audit service before a row is written.
 *
 * Deliberately no foreign keys and no `updated_at` / `deleted_at`:
 * - audit history must survive deletion of the actor, tenant or resource it
 *   refers to, so `tenant_id`, `branch_id` and `actor_user_id` are plain
 *   identifiers rather than cascading references;
 * - PostgreSQL RLS plus the `audit_logs_immutable` trigger block application
 *   UPDATE and DELETE, so a compromised request path cannot rewrite history.
 *   A controlled maintenance transaction can opt in with
 *   `set_config('app.audit_maintenance', 'true', true)` for test cleanup only.
 *
 * `dedupe_key` is optional. When supplied it is globally unique, which lets a
 * retried consumer or a duplicated event handler no-op instead of writing a
 * second audit record.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    branchId: uuid("branch_id"),
    actorUserId: uuid("actor_user_id"),
    /** TENANT, PLATFORM, USER or SYSTEM. */
    actorScope: varchar("actor_scope", { length: 20 }),
    /** Dotted event name, e.g. `patient.created` or `auth.login.succeeded`. */
    action: varchar("action", { length: 120 }).notNull(),
    /** Billing, patients, appointments, auth, rbac, ... */
    module: varchar("module", { length: 60 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }),
    resourceId: varchar("resource_id", { length: 200 }),
    description: varchar("description", { length: 500 }),
    previousState: jsonb("previous_state"),
    newState: jsonb("new_state"),
    metadata: jsonb("metadata").notNull().default({}),
    requestId: varchar("request_id", { length: 100 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    dedupeKey: varchar("dedupe_key", { length: 250 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_logs_dedupe_unique")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index("audit_logs_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_logs_tenant_module_created_idx").on(
      table.tenantId,
      table.module,
      table.createdAt,
    ),
    index("audit_logs_tenant_resource_idx").on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    index("audit_logs_tenant_resource_id_idx").on(
      table.tenantId,
      table.resourceId,
      table.createdAt,
    ),
    index("audit_logs_tenant_action_idx").on(table.tenantId, table.action, table.createdAt),
    index("audit_logs_tenant_actor_idx").on(
      table.tenantId,
      table.actorUserId,
      table.createdAt,
    ),
    index("audit_logs_tenant_branch_idx").on(table.tenantId, table.branchId, table.createdAt),
    check("audit_logs_action_check", sql`length(btrim(${table.action})) > 0`),
    check("audit_logs_module_check", sql`length(btrim(${table.module})) > 0`),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
