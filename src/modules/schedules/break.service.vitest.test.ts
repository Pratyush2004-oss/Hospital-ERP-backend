import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import {
  createDoctorBreak,
  deleteDoctorBreak,
  getDoctorBreakById,
  listDoctorBreaks,
  updateDoctorBreak,
} from "./break.service.js";
import {
  createDoctorSchedule,
  deleteDoctorSchedule,
  getDoctorScheduleById,
  updateDoctorSchedule,
  updateDoctorScheduleStatus,
} from "./schedule.service.js";
import type { CreateDoctorScheduleInput } from "./schedule.types.js";

/**
 * Service-level tests for Task 16.3. All service writes run as the restricted
 * `hospitalos_app` role inside tenant-scoped transactions, so RLS, the
 * containment trigger and the break exclusion constraint are exercised against
 * the real PostgreSQL schema.
 */

interface Fixture {
  readonly tenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly doctorA: string;
  readonly doctorB: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const userId = randomUUID();
  const secondUserId = randomUUID();
  const doctorA = randomUUID();
  const doctorB = randomUUID();

  await pool.query("insert into tenants (id, name, slug) values ($1, $2, $3)", [
    tenantId,
    `${label} Hospital`,
    `${label}-${suffix}`,
  ]);

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $2, 'Central', $3, 'Asia/Kolkata'),
            ($4, $2, 'Riverside', $5, 'Europe/London')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'break-service-test-hash'),
            ($4, $5, $6, 'break-service-test-hash')`,
    [
      userId,
      "Dr. Alice Break",
      `alice-${suffix}@breaks.test`,
      secondUserId,
      "Dr. Bob Break",
      `bob-${suffix}@breaks.test`,
    ],
  );
  createdUserIds.push(userId, secondUserId);

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $9)`,
    [
      doctorA,
      tenantId,
      userId,
      `DOC-A-${suffix}`,
      `REG-A-${suffix}`,
      doctorB,
      secondUserId,
      `DOC-B-${suffix}`,
      `REG-B-${suffix}`,
    ],
  );

  // Both doctors work at Central; doctor A also works at Riverside.
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id)
     values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
    [tenantId, doctorA, branchA, branchB, doctorB],
  );

  const fixture = { tenantId, branchA, branchB, doctorA, doctorB };
  fixtures.push(fixture);
  return fixture;
}

function newWindow(
  fixture: Fixture,
  overrides: Partial<CreateDoctorScheduleInput> = {},
): CreateDoctorScheduleInput {
  return {
    doctorId: fixture.doctorA,
    branchId: fixture.branchA,
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "13:00",
    effectiveFrom: "2026-01-05",
    ...overrides,
  };
}

function createBreak(
  tenantId: string,
  scheduleId: string,
  startTime = "10:00",
  endTime = "10:30",
  reason: string | null = null,
) {
  return createDoctorBreak(tenantId, { scheduleId, startTime, endTime, reason });
}

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = $1", [fixture.tenantId]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("doctor break service", () => {
  it("creates a break inside an active schedule and returns parent context", async () => {
    const fixture = await createFixture("create");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const created = await createDoctorBreak(fixture.tenantId, {
      scheduleId: schedule.id,
      startTime: "10:00",
      endTime: "10:30",
      reason: "  Ward round  ",
    });

    expect(created).toMatchObject({
      scheduleId: schedule.id,
      startTime: "10:00:00",
      endTime: "10:30:00",
      reason: "Ward round",
    });
    expect(created.schedule).toMatchObject({
      id: schedule.id,
      doctorId: fixture.doctorA,
      branchId: fixture.branchA,
      dayOfWeek: 1,
      startTime: "09:00:00",
      endTime: "13:00:00",
      isActive: true,
      timezone: "Asia/Kolkata",
      doctorCode: expect.stringContaining("DOC-A-"),
    });

    expect(await getDoctorBreakById(fixture.tenantId, created.id)).toEqual(created);

    // Optional reason may be omitted and still yields null.
    const withoutReason = await createBreak(
      fixture.tenantId,
      schedule.id,
      "11:30",
      "12:00",
    );
    expect(withoutReason.reason).toBeNull();
  });

  it("supports multiple breaks in one schedule", async () => {
    const fixture = await createFixture("multiple");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const first = await createBreak(fixture.tenantId, schedule.id, "10:00", "10:30");
    const second = await createBreak(fixture.tenantId, schedule.id, "11:30", "12:00");

    const listed = await listDoctorBreaks(fixture.tenantId, {
      scheduleId: schedule.id,
    });

    expect(listed.total).toBe(2);
    expect(listed.breaks.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("rejects a break starting before its schedule window", async () => {
    const fixture = await createFixture("before");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    await expect(
      createBreak(fixture.tenantId, schedule.id, "08:30", "09:30"),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "UNPROCESSABLE_ENTITY",
    });
  });

  it("rejects a break ending after its schedule window", async () => {
    const fixture = await createFixture("after");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    await expect(
      createBreak(fixture.tenantId, schedule.id, "12:30", "13:30"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects invalid break intervals", async () => {
    const fixture = await createFixture("invalid");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    await expect(
      createBreak(fixture.tenantId, schedule.id, "11:00", "10:30"),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createBreak(fixture.tenantId, schedule.id, "10:00", "10:00"),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createBreak(fixture.tenantId, schedule.id, "25:00", "26:00"),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createBreak(fixture.tenantId, schedule.id, "10:00", "10:30", "x".repeat(256)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects overlapping breaks in the same schedule", async () => {
    const fixture = await createFixture("overlap");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const existing = await createBreak(fixture.tenantId, schedule.id, "10:00", "11:00");

    await expect(
      createBreak(fixture.tenantId, schedule.id, "10:30", "11:30"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      details: { breakId: existing.id },
    });

    await expect(
      createBreak(fixture.tenantId, schedule.id, "09:30", "10:15"),
    ).rejects.toMatchObject({ statusCode: 409 });

    const listed = await listDoctorBreaks(fixture.tenantId, { scheduleId: schedule.id });
    expect(listed.total).toBe(1);
  });

  it("allows adjacent breaks under half-open semantics", async () => {
    const fixture = await createFixture("adjacent");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    await createBreak(fixture.tenantId, schedule.id, "10:00", "11:00");
    const adjacent = await createBreak(fixture.tenantId, schedule.id, "11:00", "11:30");

    expect(adjacent.startTime).toBe("11:00:00");
  });

  it("updates supplied fields and validates the resulting interval", async () => {
    const fixture = await createFixture("update");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));
    const created = await createBreak(
      fixture.tenantId,
      schedule.id,
      "10:00",
      "10:30",
      "Ward round",
    );

    const updated = await updateDoctorBreak(fixture.tenantId, created.id, {
      endTime: "11:00",
      reason: "  Teaching  ",
    });

    expect(updated).toMatchObject({
      id: created.id,
      scheduleId: schedule.id,
      startTime: "10:00:00",
      endTime: "11:00:00",
      reason: "Teaching",
    });

    const cleared = await updateDoctorBreak(fixture.tenantId, created.id, {
      reason: null,
    });
    expect(cleared.reason).toBeNull();

    // An update that leaves the window is rejected, and the row is unchanged.
    await expect(
      updateDoctorBreak(fixture.tenantId, created.id, { endTime: "14:00" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const reloaded = await getDoctorBreakById(fixture.tenantId, created.id);
    expect(reloaded.endTime).toBe("11:00:00");
  });

  it("rejects an update that would overlap another break", async () => {
    const fixture = await createFixture("update-overlap");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const first = await createBreak(fixture.tenantId, schedule.id, "10:00", "11:00");
    const second = await createBreak(fixture.tenantId, schedule.id, "11:30", "12:00");

    await expect(
      updateDoctorBreak(fixture.tenantId, second.id, { startTime: "10:30" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const reloaded = await getDoctorBreakById(fixture.tenantId, second.id);
    expect(reloaded.startTime).toBe("11:30:00");
    expect(first.id).not.toBe(second.id);
  });

  it("lists breaks with filters, ordering and pagination", async () => {
    const fixture = await createFixture("list");

    const monday = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));
    const tuesday = await createDoctorSchedule(
      fixture.tenantId,
      newWindow(fixture, { dayOfWeek: 2, startTime: "09:00", endTime: "13:00" }),
    );
    const otherDoctor = await createDoctorSchedule(
      fixture.tenantId,
      newWindow(fixture, { doctorId: fixture.doctorB }),
    );
    const riverside = await createDoctorSchedule(
      fixture.tenantId,
      newWindow(fixture, {
        dayOfWeek: 3,
        branchId: fixture.branchB,
        startTime: "14:00",
        endTime: "18:00",
      }),
    );

    const mondayBreak = await createBreak(fixture.tenantId, monday.id, "10:00", "10:15");
    await createBreak(fixture.tenantId, tuesday.id, "09:30", "09:45");
    await createBreak(fixture.tenantId, otherDoctor.id, "10:15", "10:30");
    const riversideBreak = await createBreak(
      fixture.tenantId,
      riverside.id,
      "15:00",
      "15:15",
    );

    const all = await listDoctorBreaks(fixture.tenantId, { pageSize: 2 });
    expect(all.total).toBe(4);
    expect(all.totalPages).toBe(2);
    expect(all.breaks).toHaveLength(2);
    expect(all.breaks.map((item) => item.startTime)).toEqual(["09:30:00", "10:00:00"]);

    const bySchedule = await listDoctorBreaks(fixture.tenantId, {
      scheduleId: monday.id,
    });
    expect(bySchedule.breaks.map((item) => item.id)).toEqual([mondayBreak.id]);

    const byDoctor = await listDoctorBreaks(fixture.tenantId, {
      doctorId: fixture.doctorA,
    });
    expect(byDoctor.total).toBe(3);

    const byBranch = await listDoctorBreaks(fixture.tenantId, {
      branchId: fixture.branchB,
    });
    expect(byBranch.breaks.map((item) => item.id)).toEqual([riversideBreak.id]);
  });

  it("rejects cross-tenant access and never deletes another tenant's break", async () => {
    const fixture = await createFixture("tenant-a");
    const other = await createFixture("tenant-b");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));
    const created = await createBreak(fixture.tenantId, schedule.id, "10:00", "10:30");

    await expect(
      getDoctorBreakById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctorBreak(other.tenantId, created.id, { startTime: "11:00" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Deletion is idempotent and tenant-scoped: the foreign attempt is a no-op.
    await expect(
      deleteDoctorBreak(other.tenantId, created.id),
    ).resolves.toBeUndefined();

    const foreignList = await listDoctorBreaks(other.tenantId);
    expect(foreignList.total).toBe(0);

    // The owner still sees the intact break.
    expect(await getDoctorBreakById(fixture.tenantId, created.id)).toMatchObject({
      id: created.id,
      startTime: "10:00:00",
    });
  });

  it("rejects break creation for an inactive schedule", async () => {
    const fixture = await createFixture("inactive");
    const schedule = await createDoctorSchedule(
      fixture.tenantId,
      newWindow(fixture, { isActive: false }),
    );

    await expect(
      createBreak(fixture.tenantId, schedule.id, "10:00", "10:30"),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
  });

  it("keeps breaks valid when the parent schedule changes", async () => {
    const fixture = await createFixture("parent-update");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));
    const pause = await createBreak(fixture.tenantId, schedule.id, "10:00", "10:30");

    // Shrinking the start past the break is rejected.
    await expect(
      updateDoctorSchedule(fixture.tenantId, schedule.id, { startTime: "10:15" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { breakId: pause.id },
    });

    // Shrinking the end past the break is rejected.
    await expect(
      updateDoctorSchedule(fixture.tenantId, schedule.id, { endTime: "10:15" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const unchanged = await getDoctorScheduleById(fixture.tenantId, schedule.id);
    expect(unchanged.startTime).toBe("09:00:00");
    expect(unchanged.endTime).toBe("13:00:00");

    // A shrink that still contains the break is allowed.
    const tightened = await updateDoctorSchedule(fixture.tenantId, schedule.id, {
      startTime: "09:30",
      endTime: "12:30",
    });
    expect(tightened.startTime).toBe("09:30:00");
    expect(tightened.endTime).toBe("12:30:00");
    expect((await getDoctorBreakById(fixture.tenantId, pause.id)).endTime).toBe(
      "10:30:00",
    );

    // Deactivation leaves the break intact but marks the window unavailable.
    const deactivated = await updateDoctorScheduleStatus(
      fixture.tenantId,
      schedule.id,
      false,
    );
    expect(deactivated.isActive).toBe(false);
    expect((await getDoctorBreakById(fixture.tenantId, pause.id)).schedule.isActive).toBe(
      false,
    );
  });

  it("handles concurrent overlapping break creation safely", async () => {
    const fixture = await createFixture("concurrent");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const attempts = await Promise.allSettled([
      createBreak(fixture.tenantId, schedule.id, "10:00", "11:00"),
      createBreak(fixture.tenantId, schedule.id, "10:30", "11:30"),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
    });

    const listed = await listDoctorBreaks(fixture.tenantId, { scheduleId: schedule.id });
    expect(listed.total).toBe(1);
  });

  it("deletes breaks idempotently and cascades with the parent schedule", async () => {
    const fixture = await createFixture("delete");
    const schedule = await createDoctorSchedule(fixture.tenantId, newWindow(fixture));

    const explicit = await createBreak(fixture.tenantId, schedule.id, "10:00", "10:30");
    const cascaded = await createBreak(fixture.tenantId, schedule.id, "11:30", "12:00");

    await deleteDoctorBreak(fixture.tenantId, explicit.id);
    await expect(
      getDoctorBreakById(fixture.tenantId, explicit.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Repeated deletion is safe.
    await expect(
      deleteDoctorBreak(fixture.tenantId, explicit.id),
    ).resolves.toBeUndefined();

    // Removing the parent window removes the remaining break via cascade.
    await deleteDoctorSchedule(fixture.tenantId, schedule.id);
    await expect(
      getDoctorBreakById(fixture.tenantId, cascaded.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
