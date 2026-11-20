import { foreignKey, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt } from "./columns.js";
import { departments } from "./departments.js";

/**
 * Which branches a department operates in (Cardiology in Branch A and Branch B,
 * Neurology only in Branch A, ...).
 *
 * Both sides use composite `(tenant_id, id)` foreign keys, so an association can
 * never mix a department and a branch from different tenants - even if a service
 * passes the wrong id. The unique index makes assigning the same branch twice
 * impossible. Deleting a branch or department cascades to its associations;
 * departments are soft deleted in normal operation, so their associations are
 * kept for history.
 */
export const departmentBranches = pgTable(
  "department_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("department_branches_unique").on(
      table.tenantId,
      table.departmentId,
      table.branchId,
    ),
    index("department_branches_branch_idx").on(table.tenantId, table.branchId),
    foreignKey({
      name: "department_branches_department_fk",
      columns: [table.tenantId, table.departmentId],
      foreignColumns: [departments.tenantId, departments.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "department_branches_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
  ],
);

export type DepartmentBranch = typeof departmentBranches.$inferSelect;
export type NewDepartmentBranch = typeof departmentBranches.$inferInsert;
