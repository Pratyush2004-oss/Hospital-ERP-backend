import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt, deletedAt, updatedAt } from "./columns.js";

/**
 * A clinical or administrative unit of a hospital (Cardiology, Radiology, Front
 * Desk, ...). A department may operate in several branches; the full set of
 * branch associations lives in `department_branches`.
 *
 * `branch_id` is the department's primary (home) branch. It is retained from
 * the original branch-scoped model so existing seed data, doctor assignments
 * and branch dependency checks keep working while the join table becomes the
 * authoritative multi-branch coverage.
 *
 * Uniqueness of `slug` is enforced by the service across the whole tenant
 * (including soft-deleted rows, which keep their slug reserved). The database
 * still carries the legacy `(tenant_id, branch_id, slug)` index, which is
 * stricter about duplicate rows within one branch. Soft-deleted departments
 * cannot be updated or listed again, and are never physically removed.
 *
 * The composite foreign key `(tenant_id, branch_id) -> branches(tenant_id, id)`
 * makes a department in another tenant's branch impossible.
 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Target of composite keys in doctor_departments.
    unique("departments_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("departments_branch_slug_unique").on(table.tenantId, table.branchId, table.slug),
    index("departments_tenant_branch_active_idx").on(
      table.tenantId,
      table.branchId,
      table.isActive,
    ),
    check("departments_slug_format_check", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    foreignKey({
      name: "departments_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
  ],
);

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
