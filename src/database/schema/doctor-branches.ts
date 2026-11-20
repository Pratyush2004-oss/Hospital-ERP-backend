import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { createdAt, updatedAt } from "./columns.js";
import { doctors } from "./doctors.js";

/**
 * Where a doctor practises. A doctor may be assigned to many branches, each with
 * its own consultation fee and activation state.
 *
 * `UNIQUE (tenant_id, doctor_id, branch_id)` both prevents duplicate
 * doctor-branch assignments and serves as the composite key that
 * `doctor_schedules` points at, so a schedule can only be created for a branch
 * the doctor is actually assigned to.
 *
 * Cross-relationship rule (department coverage): a doctor may be assigned to a
 * branch that one of their departments does not operate in, because the
 * department-branch coverage lives in `department_branches` and this table has
 * no department dimension. PostgreSQL composite keys cannot express that
 * cross-table rule, so the doctor service must validate it when doctors,
 * departments and branches are assigned together (Phase 15.2).
 *
 * Money is stored as NUMERIC(12, 2) with an ISO 4217 currency; the project had
 * no currency policy before, so USD is the column default and the service can
 * set the hospital's currency per assignment.
 */
export const doctorBranches = pgTable(
  "doctor_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    consultationFee: numeric("consultation_fee", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("doctor_branches_doctor_branch_unique").on(
      table.tenantId,
      table.doctorId,
      table.branchId,
    ),
    index("doctor_branches_branch_active_idx").on(table.tenantId, table.branchId, table.isActive),
    index("doctor_branches_doctor_active_idx").on(table.tenantId, table.doctorId, table.isActive),
    check("doctor_branches_fee_check", sql`${table.consultationFee} >= 0`),
    foreignKey({
      name: "doctor_branches_doctor_fk",
      columns: [table.tenantId, table.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_branches_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
  ],
);

export type DoctorBranch = typeof doctorBranches.$inferSelect;
export type NewDoctorBranch = typeof doctorBranches.$inferInsert;
