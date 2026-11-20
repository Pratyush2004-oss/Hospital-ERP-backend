import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../connection.js";
import { withTenantTransaction } from "../context.js";
import { getPool } from "../index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { doctorBranches, doctorBreaks, doctorLeaves, doctorSchedules } from "./index.js";

/**
 * Schema-level tests for Task 16.1 (scheduling foundation).
 *
 * Fixtures (tenants, branches, users, doctors, assignments) are created with the
 * admin connection, while every scheduling write goes through
 * `withTenantTransaction`, so it runs as the restricted `hospitalos_app` role
 * against the same RLS policies production uses.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly branchC: string;
  readonly doctorId: string;
  readonly userId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const branchC = randomUUID();
  const userId = randomUUID();
  const doctorId = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);
  createdTenantIds.push(tenantId);

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Riverside', $5, 'Europe/London'),
            ($6, $2, 'Unassigned', $7, 'America/New_York')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`, branchC, `UNA-${suffix}`],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'scheduling-schema-test-hash')`,
    [userId, `${label} Doctor`, `${label}-${suffix}@scheduling.test`],
  );
  createdUserIds.push(userId);

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5)`,
    [doctorId, tenantId, userId, `DOC-${suffix}`, `REG-${suffix}`],
  );

  // Assigned to Central and Riverside only; Unassigned is deliberately not
  // covered so invalid doctor-branch references can be tested.
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id)
     values ($1, $2, $3), ($1, $2, $4)`,
    [tenantId, doctorId, branchA, branchB],
  );

  const fixture = { tenantId, branchA, branchB, branchC, doctorId, userId };
  fixtures.push(fixture);
  return fixture;
}

interface ScheduleInput {
  tenantId: string;
  doctorId: string;
  branchId: string;
  dayOfWeek?: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes?: number;
  bufferMinutes?: number;
  effectiveFrom?: string;
  effectiveUntil?: string | null;
  isActive?: boolean;
}

function insertSchedule(input: ScheduleInput) {
  return withTenantTransaction(input.tenantId, (tx) =>
    tx
      .insert(doctorSchedules)
      .values({
        tenantId: input.tenantId,
        doctorId: input.doctorId,
        branchId: input.branchId,
        dayOfWeek: input.dayOfWeek ?? 1,
        startTime: input.startTime,
        endTime: input.endTime,
        slotDurationMinutes: input.slotDurationMinutes ?? 15,
        bufferMinutes: input.bufferMinutes ?? 0,
        effectiveFrom: input.effectiveFrom ?? "2026-01-01",
        effectiveUntil: input.effectiveUntil ?? null,
        isActive: input.isActive ?? true,
      })
      .returning(),
  );
}

function insertBreak(
  tenantId: string,
  scheduleId: string,
  startTime: string,
  endTime: string,
  reason: string | null = null,
) {
  return withTenantTransaction(tenantId, (tx) =>
    tx
      .insert(doctorBreaks)
      .values({ tenantId, scheduleId, startTime, endTime, reason })
      .returning(),
  );
}

function insertLeave(input: {
  tenantId: string;
  doctorId: string;
  branchId: string | null;
  startAt: Date;
  endAt: Date;
  status?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  approvedBy?: string | null;
  approvedAt?: Date | null;
}) {
  return withTenantTransaction(input.tenantId, (tx) =>
    tx
      .insert(doctorLeaves)
      .values({
        tenantId: input.tenantId,
        doctorId: input.doctorId,
        branchId: input.branchId,
        startAt: input.startAt,
        endAt: input.endAt,
        status: input.status ?? "PENDING",
        createdBy: fixtures[0]!.userId,
        approvedBy: input.approvedBy ?? null,
        approvedAt: input.approvedAt ?? null,
      })
      .returning(),
  );
}

function expectDbError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
  message?: string,
) {
  // Drizzle wraps driver failures, so the pg error code/constraint live on `cause`.
  return expect(promise).rejects.toMatchObject({
    cause: {
      code,
      ...(constraint ? { constraint } : {}),
      ...(message ? { message: expect.stringContaining(message) } : {}),
    },
  });
}

beforeAll(async () => {
  await createFixture("sched-a");
  await createFixture("sched-b");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const id of createdTenantIds) {
    // Leaves reference doctor_branches with RESTRICT, so clear them explicitly
    // (the admin connection bypasses RLS and owns these fixtures).
    await pool.query("delete from doctor_leaves where tenant_id = $1", [id]);
    await pool.query("delete from tenants where id = $1", [id]);
  }

  for (const id of createdUserIds) {
    await pool.query("delete from users where id = $1", [id]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("doctor scheduling schema", () => {
  it("exposes the reviewed columns, indexes, RLS and migration record", async () => {
    const pool = getTestAdminPool();

    const { rows: scheduleColumns } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'doctor_schedules'`,
    );
    expect(scheduleColumns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "doctor_id",
        "branch_id",
        "day_of_week",
        "start_time",
        "end_time",
        "slot_duration_minutes",
        "buffer_minutes",
        "effective_from",
        "effective_until",
        "is_active",
      ]),
    );

    const { rows: leaveColumns } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'doctor_leaves'`,
    );
    expect(leaveColumns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "branch_id",
        "created_by",
        "approved_by",
        "approved_at",
        "status",
        "start_at",
        "end_at",
      ]),
    );

    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and tablename in ('doctor_schedules', 'doctor_breaks', 'doctor_leaves')`,
    );
    const indexNames = new Set(indexRows.map((row) => row.indexname));
    for (const name of [
      "doctor_schedules_doctor_day_idx",
      "doctor_schedules_branch_day_idx",
      "doctor_schedules_effective_idx",
      "doctor_breaks_schedule_idx",
      "doctor_leaves_doctor_range_idx",
      "doctor_leaves_branch_range_idx",
    ]) {
      expect(indexNames).toContain(name);
    }

    const { rows: exclusionRows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where contype = 'x'
         and conrelid in ('doctor_schedules'::regclass, 'doctor_breaks'::regclass)`,
    );
    expect(exclusionRows.map((row) => row.conname).sort()).toEqual([
      "doctor_breaks_no_overlap",
      "doctor_schedules_no_overlap",
    ]);

    const { rows: rlsRows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('doctor_schedules', 'doctor_breaks', 'doctor_leaves')`,
    );
    expect(rlsRows).toHaveLength(3);
    for (const row of rlsRows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Generated and applied migration counts agree, including scheduling
    // integrity (0010) and leave rejection metadata (0011).
    const journal = JSON.parse(
      readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.length).toBeGreaterThanOrEqual(11);
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain("0010_black_nocturne");
    expect(tags).toContain("0011_doctor_leave_rejection_metadata");
    const { rows: applied } = await pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(Number(applied[0]?.count)).toBe(journal.entries.length);
  });

  it("supports multiple working windows on the same weekday", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];

    const morning = await insertSchedule({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchA,
      startTime: "09:00:00",
      endTime: "13:00:00",
    });
    const evening = await insertSchedule({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchA,
      startTime: "16:00:00",
      endTime: "20:00:00",
    });

    expect(morning).toHaveLength(1);
    expect(evening).toHaveLength(1);
    expect(new Set([morning[0]!.id, evening[0]!.id]).size).toBe(2);

    // Adjacent windows are also allowed: half-open time ranges do not overlap.
    await expect(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        startTime: "13:00:00",
        endTime: "15:00:00",
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects invalid schedule time ranges", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];

    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 2,
        startTime: "10:00:00",
        endTime: "09:00:00",
      }),
      "23514",
      "doctor_schedules_time_order_check",
    );

    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "09:00:00",
      }),
      "23514",
      "doctor_schedules_time_order_check",
    );

    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "10:00:00",
        slotDurationMinutes: 90,
      }),
      "23514",
      "doctor_schedules_window_fits_slot_check",
    );
  });

  it("rejects non-positive slot durations", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];

    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 3,
        startTime: "09:00:00",
        endTime: "11:00:00",
        slotDurationMinutes: 0,
      }),
      "23514",
      "doctor_schedules_slot_duration_check",
    );
  });

  it("rejects a negative buffer duration", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];

    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 3,
        startTime: "09:00:00",
        endTime: "11:00:00",
        bufferMinutes: -1,
      }),
      "23514",
      "doctor_schedules_buffer_check",
    );

    await expect(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchA,
        dayOfWeek: 3,
        startTime: "09:00:00",
        endTime: "11:00:00",
        bufferMinutes: 10,
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects schedules for branches the doctor is not assigned to", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];
    const [, other] = fixtures as [Fixture, Fixture];

    // Same tenant, but the doctor has no assignment at this branch.
    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchC,
        dayOfWeek: 4,
        startTime: "09:00:00",
        endTime: "11:00:00",
      }),
      "23503",
      "doctor_schedules_doctor_branch_fk",
    );

    // Another tenant's branch cannot be smuggled in either.
    await expectDbError(
      insertSchedule({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: other.branchA,
        dayOfWeek: 4,
        startTime: "09:00:00",
        endTime: "11:00:00",
      }),
      "23503",
      "doctor_schedules_doctor_branch_fk",
    );
  });

  it("rejects overlapping active windows but allows non-overlapping effective periods", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];
    const shared = {
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchB,
      dayOfWeek: 5,
    };

    await insertSchedule({
      ...shared,
      startTime: "09:00:00",
      endTime: "13:00:00",
      effectiveUntil: "2026-05-31",
    });

    // Exact duplicate.
    await expectDbError(
      insertSchedule({ ...shared, startTime: "09:00:00", endTime: "13:00:00" }),
      "23P01",
      "doctor_schedules_no_overlap",
    );

    // Partial overlap.
    await expectDbError(
      insertSchedule({ ...shared, startTime: "12:00:00", endTime: "14:00:00" }),
      "23P01",
      "doctor_schedules_no_overlap",
    );

    // A different effective period for the same wall-clock window is fine.
    await expect(
      insertSchedule({
        ...shared,
        startTime: "09:00:00",
        endTime: "13:00:00",
        effectiveFrom: "2026-06-01",
        effectiveUntil: "2026-12-31",
      }),
    ).resolves.toHaveLength(1);

    // Inactive history may overlap; only active windows conflict.
    await expect(
      insertSchedule({
        ...shared,
        startTime: "10:00:00",
        endTime: "12:00:00",
        isActive: false,
      }),
    ).resolves.toHaveLength(1);
  });

  it("requires breaks to fall inside their schedule window", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];
    const [schedule] = await insertSchedule({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchA,
      dayOfWeek: 6,
      startTime: "09:00:00",
      endTime: "13:00:00",
    });

    await expectDbError(
      insertBreak(fixture.tenantId, schedule!.id, "08:30:00", "09:15:00"),
      "23514",
      undefined,
      "must fall within schedule window",
    );

    await expectDbError(
      insertBreak(fixture.tenantId, schedule!.id, "12:45:00", "13:30:00"),
      "23514",
      undefined,
      "must fall within schedule window",
    );

    await expect(
      insertBreak(fixture.tenantId, schedule!.id, "11:00:00", "11:15:00", "Ward round"),
    ).resolves.toHaveLength(1);
  });

  it("rejects overlapping breaks while allowing adjacent ones", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];
    const [schedule] = await insertSchedule({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchA,
      dayOfWeek: 7,
      startTime: "09:00:00",
      endTime: "17:00:00",
    });

    await insertBreak(fixture.tenantId, schedule!.id, "11:00:00", "12:00:00", "Lunch");

    await expectDbError(
      insertBreak(fixture.tenantId, schedule!.id, "11:30:00", "12:30:00"),
      "23P01",
      "doctor_breaks_no_overlap",
    );

    // Half-open ranges: starts exactly when the previous break ends.
    await expect(
      insertBreak(fixture.tenantId, schedule!.id, "12:00:00", "12:30:00", "Ward round"),
    ).resolves.toHaveLength(1);
  });

  it("validates leave intervals, all-branch leave and approval integrity", async () => {
    const [fixture] = fixtures as [Fixture, Fixture];
    const start = new Date("2026-03-02T00:00:00.000Z");
    const end = new Date("2026-03-04T00:00:00.000Z");

    const branchLeave = await insertLeave({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchA,
      startAt: start,
      endAt: end,
    });
    expect(branchLeave[0]?.branchId).toBe(fixture.branchA);

    const allBranchLeave = await insertLeave({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: null,
      startAt: start,
      endAt: end,
    });
    expect(allBranchLeave[0]?.branchId).toBeNull();
    expect(allBranchLeave[0]?.status).toBe("PENDING");

    await expectDbError(
      insertLeave({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: null,
        startAt: end,
        endAt: start,
      }),
      "23514",
      "doctor_leaves_interval_check",
    );

    // A branch the doctor is not assigned to cannot carry leave.
    await expectDbError(
      insertLeave({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchC,
        startAt: start,
        endAt: end,
      }),
      "23503",
      "doctor_leaves_doctor_branch_fk",
    );

    // APPROVED requires an approver and a timestamp.
    await expectDbError(
      insertLeave({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: null,
        startAt: start,
        endAt: end,
        status: "APPROVED",
      }),
      "23514",
      "doctor_leaves_approval_check",
    );

    const approved = await insertLeave({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: null,
      startAt: start,
      endAt: end,
      status: "APPROVED",
      approvedBy: fixture.userId,
      approvedAt: new Date("2026-02-20T10:00:00.000Z"),
    });
    expect(approved[0]?.approvedBy).toBe(fixture.userId);
  });

  it("rejects cross-tenant doctor, branch and leave relationships", async () => {
    const [fixtureA, fixtureB] = fixtures as [Fixture, Fixture];

    // Another tenant's branch for a local doctor.
    await expectDbError(
      insertSchedule({
        tenantId: fixtureA.tenantId,
        doctorId: fixtureA.doctorId,
        branchId: fixtureB.branchA,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "10:00:00",
      }),
      "23503",
      "doctor_schedules_doctor_branch_fk",
    );

    // Another tenant's doctor with this tenant's branch.
    await expectDbError(
      insertSchedule({
        tenantId: fixtureA.tenantId,
        doctorId: fixtureB.doctorId,
        branchId: fixtureA.branchA,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "10:00:00",
      }),
      "23503",
      "doctor_schedules_doctor_branch_fk",
    );

    // All-branch leave still validates the doctor against this tenant.
    await expectDbError(
      insertLeave({
        tenantId: fixtureA.tenantId,
        doctorId: fixtureB.doctorId,
        branchId: null,
        startAt: new Date("2026-04-01T00:00:00.000Z"),
        endAt: new Date("2026-04-02T00:00:00.000Z"),
      }),
      "23503",
      "doctor_leaves_doctor_fk",
    );
  });

  it("enforces RLS for scheduling tables under the restricted role", async () => {
    const [fixtureA, fixtureB] = fixtures as [Fixture, Fixture];

    const role = await getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const ownSchedules = await withTenantTransaction(fixtureA.tenantId, (tx) =>
      tx.select({ id: doctorSchedules.id }).from(doctorSchedules),
    );
    expect(ownSchedules.length).toBeGreaterThan(0);

    const foreignSchedules = await withTenantTransaction(fixtureB.tenantId, (tx) =>
      tx.select({ id: doctorSchedules.id }).from(doctorSchedules),
    );
    expect(foreignSchedules).toHaveLength(0);

    const foreignLeaves = await withTenantTransaction(fixtureB.tenantId, (tx) =>
      tx.select({ id: doctorLeaves.id }).from(doctorLeaves),
    );
    expect(foreignLeaves).toHaveLength(0);

    // A write that claims another tenant is blocked by the WITH CHECK policy.
    await expect(
      withTenantTransaction(fixtureA.tenantId, (tx) =>
        tx.insert(doctorSchedules).values({
          tenantId: fixtureB.tenantId,
          doctorId: fixtureB.doctorId,
          branchId: fixtureB.branchA,
          dayOfWeek: 3,
          startTime: "09:00:00",
          endTime: "10:00:00",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });

    // The tenant GUC must not leak back into the pool.
    const leaked = await getPool().query<{ tid: string | null }>(
      "select current_setting('app.current_tenant_id', true) as tid",
    );
    expect(leaked.rows[0]?.tid ?? "").toBe("");

    // A doctor-branch assignment is tenant-visible only to its own tenant.
    const foreignAssignments = await withTenantTransaction(fixtureB.tenantId, (tx) =>
      tx.select({ id: doctorBranches.id }).from(doctorBranches),
    );
    expect(foreignAssignments).toHaveLength(2);
  });
});
