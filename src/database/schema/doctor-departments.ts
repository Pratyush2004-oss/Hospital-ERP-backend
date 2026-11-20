import { foreignKey, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { departments } from "./departments.js";
import { doctors } from "./doctors.js";

/**
 * Many-to-many link between doctors and departments: a doctor may cover several
 * departments (e.g. Cardiology and Internal Medicine) and a department has many
 * doctors.
 *
 * Both sides are composite `(tenant_id, id)` keys, so a doctor can only be
 * attached to a department of the same tenant - even if a service layer passes
 * the wrong id. The unique index makes the link idempotent.
 */
export const doctorDepartments = pgTable(
  "doctor_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("doctor_departments_unique").on(table.tenantId, table.doctorId, table.departmentId),
    index("doctor_departments_department_idx").on(table.tenantId, table.departmentId),
    foreignKey({
      name: "doctor_departments_doctor_fk",
      columns: [table.tenantId, table.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_departments_department_fk",
      columns: [table.tenantId, table.departmentId],
      foreignColumns: [departments.tenantId, departments.id],
    }).onDelete("cascade"),
  ],
);

export type DoctorDepartment = typeof doctorDepartments.$inferSelect;
export type NewDoctorDepartment = typeof doctorDepartments.$inferInsert;
