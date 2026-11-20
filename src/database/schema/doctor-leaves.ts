import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { doctorBranches } from "./doctor-branches.js";
import { doctors } from "./doctors.js";
import { doctorLeaveStatusEnum } from "./enums.js";
import { users } from "./users.js";

/**
 * A dated absence. Unlike `doctor_schedules`, a leave is a single real interval
 * in time, so both ends are TIMESTAMPTZ and PostgreSQL stores an absolute
 * instant - a leave spanning a DST change keeps its true duration.
 *
 * `branch_id` NULL means the doctor is unavailable at every branch. A non-null
 * branch must be one the doctor is assigned to; that composite foreign key is
 * checked by PostgreSQL only when `branch_id` is present (MATCH SIMPLE), which
 * is exactly the intended semantics. A second composite key
 * `(tenant_id, doctor_id) -> doctors(tenant_id, id)` validates the doctor even
 * for all-branch leave, so a cross-tenant doctor can never be referenced.
 *
 * Branch unassignment is RESTRICTed: deleting a `doctor_branches` row with
 * leave history fails instead of silently destroying the record. Doctors
 * themselves are soft deleted, so history survives normal profile retirement.
 *
 * Approval integrity: an APPROVED row must carry both `approved_by` and
 * `approved_at`, enforced by a CHECK. Rejection integrity is enforced the same
 * way with `rejected_by`/`rejected_at`; `rejection_reason` explains a REJECTED
 * row without overwriting the doctor's original `reason`. Approver and rejecter
 * references use SET NULL so a departing user account does not erase the leave
 * record; `created_by` is required and blocks hard deletion of the author
 * (accounts are deactivated, not deleted, in normal operation).
 *
 * Approved leaves are meant to suppress slots; that resolution belongs to the
 * scheduling service, this table only records the request and its state.
 */
export const doctorLeaves = pgTable(
  "doctor_leaves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    /** NULL = leave applies to every branch. */
    branchId: uuid("branch_id"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    status: doctorLeaveStatusEnum("status").notNull().default("PENDING"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("doctor_leaves_doctor_range_idx").on(table.tenantId, table.doctorId, table.startAt),
    index("doctor_leaves_branch_range_idx").on(table.tenantId, table.branchId, table.startAt),
    index("doctor_leaves_tenant_status_idx").on(table.tenantId, table.status),
    check("doctor_leaves_interval_check", sql`${table.endAt} > ${table.startAt}`),
    check(
      "doctor_leaves_approval_check",
      sql`${table.status} <> 'APPROVED' or (${table.approvedBy} is not null and ${table.approvedAt} is not null)`,
    ),
    check(
      "doctor_leaves_rejection_check",
      sql`${table.status} <> 'REJECTED' or (${table.rejectedBy} is not null and ${table.rejectedAt} is not null)`,
    ),
    foreignKey({
      name: "doctor_leaves_doctor_fk",
      columns: [table.tenantId, table.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_leaves_doctor_branch_fk",
      columns: [table.tenantId, table.doctorId, table.branchId],
      foreignColumns: [
        doctorBranches.tenantId,
        doctorBranches.doctorId,
        doctorBranches.branchId,
      ],
    }).onDelete("restrict"),
  ],
);

export type DoctorLeave = typeof doctorLeaves.$inferSelect;
export type NewDoctorLeave = typeof doctorLeaves.$inferInsert;
