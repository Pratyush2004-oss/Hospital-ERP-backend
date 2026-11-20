import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { getTestAdminPool, closeTestAdminPool } from "../../test/database.js";
import {
  createDoctorSchedule,
  deleteDoctorSchedule,
  getDoctorScheduleById,
  listDoctorSchedules,
  updateDoctorSchedule,
  updateDoctorScheduleStatus,
} from "./schedule.service.js";
import type { CreateDoctorScheduleInput } from "./schedule.types.js";

/**
 * Service-level tests for Task 16.2.
 *
 * The service runs inside tenant-scoped transactions as the restricted
 * `hospitalos_app` role, so RLS is enforced. Tenants, branches, doctors and
 * assignments are fixture data created with the admin connection, matching the
 * existing doctor and department suites.
 */

interface Fixture {
  readonly tenantId: string;
  /** Asia/Kolkata. */
  readonly branchA: string;
  /** Europe/London. */
  readonly branchB: string;
  /** Same tenant, but the doctors are not assigned to it. */
  readonly branchC: string;
  readonly doctorA: string;
  readonly doctorB: string;
  readonly userId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const branchC = randomUUID();
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
            ($4, $2, 'Riverside', $5, 'Europe/London'),
            ($6, $2, 'Unassigned', $7, 'UTC')`,
    [branchA, tenantId, `CEN-${suffix}`, branchB, `RIV-${suffix}`, branchC, `UNA-${suffix}`],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'schedule-service-test-hash'),
            ($4, $5, $6, 'schedule-service-test-hash')`,
    [
      userId,
      "Dr. Alice Schedule",
      `alice-${suffix}@schedules.test`,
      secondUserId,
      "Dr. Bob Schedule",
      `bob-${suffix}@schedules.test`,
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

  // Both doctors work at Central; only doctor A also works at Riverside.
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id)
     values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
    [tenantId, doctorA, branchA, branchB, doctorB],
  );

  const fixture = { tenantId, branchA, branchB, branchC, doctorA, doctorB, userId };
  fixtures.push(fixture);
  return fixture;
}

function newSchedule(
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

beforeAll(async () => {
  // Nothing global: tests create isolated hospitals on demand.
});

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

describe("doctor recurring schedule service", () => {
  it("creates a schedule with branch-local times, defaults and safe relations", async () => {
    const fixture = await createFixture("create");

    const created = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { startTime: "09:00", endTime: "13:00" }),
    );

    expect(created).toMatchObject({
      doctorId: fixture.doctorA,
      branchId: fixture.branchA,
      dayOfWeek: 1,
      startTime: "09:00:00",
      endTime: "13:00:00",
      slotDurationMinutes: 15,
      bufferMinutes: 0,
      effectiveFrom: "2026-01-05",
      effectiveUntil: null,
      isActive: true,
    });
    expect(created.doctor).toMatchObject({
      id: fixture.doctorA,
      fullName: "Dr. Alice Schedule",
    });
    expect(created.branch).toMatchObject({
      id: fixture.branchA,
      name: "Central",
      timezone: "Asia/Kolkata",
    });

    const fetched = await getDoctorScheduleById(fixture.tenantId, created.id);
    expect(fetched).toEqual(created);

    // Invalid time windows, weekdays and effective ranges are rejected before SQL.
    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { dayOfWeek: 2, startTime: "14:00", endTime: "14:00" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createDoctorSchedule(fixture.tenantId, newSchedule(fixture, { dayOfWeek: 0 })),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, {
          dayOfWeek: 3,
          effectiveFrom: "2026-02-10",
          effectiveUntil: "2026-02-01",
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { dayOfWeek: 4, slotDurationMinutes: 0 }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { dayOfWeek: 5, startTime: "25:00" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("supports multiple working windows on the same weekday", async () => {
    const fixture = await createFixture("split-shift");

    const morning = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const evening = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { startTime: "16:00", endTime: "20:00" }),
    );

    const listed = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
      dayOfWeek: 1,
    });

    expect(listed.total).toBe(2);
    expect(listed.schedules.map((schedule) => schedule.id)).toEqual([
      morning.id,
      evening.id,
    ]);
    expect(listed.schedules.map((schedule) => schedule.startTime)).toEqual([
      "09:00:00",
      "16:00:00",
    ]);
  });

  it("rejects overlapping active windows for the same doctor, branch and weekday", async () => {
    const fixture = await createFixture("overlap");

    const first = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { startTime: "12:00", endTime: "14:00" }),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      details: { scheduleId: first.id },
    });

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { startTime: "09:00", endTime: "13:00" }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const listed = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
      dayOfWeek: 1,
    });
    expect(listed.total).toBe(1);
  });

  it("accepts adjacent, non-overlapping windows", async () => {
    const fixture = await createFixture("adjacent");

    await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const afternoon = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { startTime: "13:00", endTime: "17:00" }),
    );

    expect(afternoon.startTime).toBe("13:00:00");
  });

  it("allows the same window for the same doctor at a different branch", async () => {
    const fixture = await createFixture("branches");

    const central = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const riverside = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { branchId: fixture.branchB }),
    );

    expect(central.branch.timezone).toBe("Asia/Kolkata");
    expect(riverside.branch.timezone).toBe("Europe/London");
    expect(central.id).not.toBe(riverside.id);
  });

  it("treats effective date ranges as part of the overlap check", async () => {
    const fixture = await createFixture("effective");

    const spring = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { effectiveFrom: "2026-01-01", effectiveUntil: "2026-05-31" }),
    );

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { effectiveFrom: "2026-03-01", effectiveUntil: "2026-07-01" }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Disjoint effective ranges may reuse the same wall-clock window.
    const summer = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { effectiveFrom: "2026-06-01", effectiveUntil: null }),
    );

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { effectiveFrom: "2026-07-01", effectiveUntil: null }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const springOnly = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
      effectiveOn: "2026-03-01",
    });
    expect(springOnly.schedules.map((schedule) => schedule.id)).toEqual([spring.id]);

    const summerOnly = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
      effectiveOn: "2026-07-15",
    });
    expect(summerOnly.schedules.map((schedule) => schedule.id)).toEqual([summer.id]);
  });

  it("updates a schedule's window, durations and effective range", async () => {
    const fixture = await createFixture("update");
    const created = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));

    const updated = await updateDoctorSchedule(fixture.tenantId, created.id, {
      startTime: "10:00",
      endTime: "14:00",
      slotDurationMinutes: 30,
      bufferMinutes: 10,
      effectiveUntil: "2026-12-31",
    });

    expect(updated).toMatchObject({
      id: created.id,
      doctorId: fixture.doctorA,
      branchId: fixture.branchA,
      startTime: "10:00:00",
      endTime: "14:00:00",
      slotDurationMinutes: 30,
      bufferMinutes: 10,
      effectiveUntil: "2026-12-31",
    });

    // Moving to a branch the doctor is not assigned to is rejected.
    await expect(
      updateDoctorSchedule(fixture.tenantId, created.id, { branchId: fixture.branchC }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an update that would create an overlap and leaves the row unchanged", async () => {
    const fixture = await createFixture("update-conflict");

    await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const evening = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { startTime: "16:00", endTime: "20:00" }),
    );

    await expect(
      updateDoctorSchedule(fixture.tenantId, evening.id, {
        startTime: "12:00",
        endTime: "16:00",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const reloaded = await getDoctorScheduleById(fixture.tenantId, evening.id);
    expect(reloaded.startTime).toBe("16:00:00");
    expect(reloaded.endTime).toBe("20:00:00");
  });

  it("activates a previously inactive schedule", async () => {
    const fixture = await createFixture("activate");
    const created = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { isActive: false }),
    );

    expect(created.isActive).toBe(false);

    const activated = await updateDoctorScheduleStatus(fixture.tenantId, created.id, true);
    expect(activated.isActive).toBe(true);
  });

  it("rejects reactivation when an active window now occupies the period", async () => {
    const fixture = await createFixture("reactivate-conflict");

    await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const overlapping = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, {
        startTime: "10:00",
        endTime: "12:00",
        isActive: false,
      }),
    );

    await expect(
      updateDoctorScheduleStatus(fixture.tenantId, overlapping.id, true),
    ).rejects.toMatchObject({ statusCode: 409 });

    const reloaded = await getDoctorScheduleById(fixture.tenantId, overlapping.id);
    expect(reloaded.isActive).toBe(false);
  });

  it("lists schedules with filters, ordering and pagination", async () => {
    const fixture = await createFixture("list");

    const aMonday = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));
    const aTuesday = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { dayOfWeek: 2, startTime: "10:00", endTime: "12:00" }),
    );
    await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { doctorId: fixture.doctorB }),
    );
    const bRiverside = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, {
        doctorId: fixture.doctorB,
        branchId: fixture.branchA,
        dayOfWeek: 3,
        startTime: "14:00",
        endTime: "16:00",
        effectiveFrom: "2026-06-01",
        isActive: false,
      }),
    );

    const all = await listDoctorSchedules(fixture.tenantId, { pageSize: 2 });
    expect(all.total).toBe(4);
    expect(all.totalPages).toBe(2);
    expect(all.schedules).toHaveLength(2);
    expect(all.schedules.map((schedule) => schedule.dayOfWeek)).toEqual([1, 1]);

    const byDoctor = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
    });
    expect(byDoctor.schedules.map((schedule) => schedule.id)).toEqual([
      aMonday.id,
      aTuesday.id,
    ]);

    const byBranch = await listDoctorSchedules(fixture.tenantId, {
      branchId: fixture.branchA,
    });
    expect(byBranch.total).toBe(4);

    const monday = await listDoctorSchedules(fixture.tenantId, { dayOfWeek: 1 });
    expect(monday.total).toBe(2);

    const inactive = await listDoctorSchedules(fixture.tenantId, { isActive: false });
    expect(inactive.schedules.map((schedule) => schedule.id)).toEqual([bRiverside.id]);

    const effectiveJanuary = await listDoctorSchedules(fixture.tenantId, {
      effectiveOn: "2026-01-15",
    });
    expect(effectiveJanuary.total).toBe(3);
    expect(effectiveJanuary.schedules.some((s) => s.id === bRiverside.id)).toBe(false);

    const descending = await listDoctorSchedules(fixture.tenantId, {
      sortBy: "dayOfWeek",
      sortOrder: "desc",
    });
    expect(descending.schedules[0]?.dayOfWeek).toBe(3);

    // No schedule from another hospital leaks into the list.
    expect(new Set(all.schedules.map((s) => s.doctorId))).toEqual(
      new Set([fixture.doctorA, fixture.doctorB]),
    );
  });

  it("rejects invalid doctor-branch assignments and unknown references", async () => {
    const fixture = await createFixture("assignment");
    const pool = getTestAdminPool();

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { branchId: fixture.branchC }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { doctorId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // An existing assignment that was deactivated cannot carry new schedules.
    await pool.query(
      `update doctor_branches set is_active = false
       where tenant_id = $1 and doctor_id = $2 and branch_id = $3`,
      [fixture.tenantId, fixture.doctorA, fixture.branchB],
    );

    await expect(
      createDoctorSchedule(
        fixture.tenantId,
        newSchedule(fixture, { branchId: fixture.branchB }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Inactive doctors cannot receive new schedules.
    await pool.query("update doctors set is_active = false where id = $1", [
      fixture.doctorA,
    ]);

    await expect(
      createDoctorSchedule(fixture.tenantId, newSchedule(fixture)),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects cross-tenant schedule access", async () => {
    const fixture = await createFixture("tenant-a");
    const other = await createFixture("tenant-b");

    const created = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));

    await expect(
      getDoctorScheduleById(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctorSchedule(other.tenantId, created.id, { startTime: "15:00" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateDoctorScheduleStatus(other.tenantId, created.id, false),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      deleteDoctorSchedule(other.tenantId, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The foreign tenant's doctor cannot be used either.
    await expect(
      createDoctorSchedule(other.tenantId, newSchedule(fixture)),
    ).rejects.toMatchObject({ statusCode: 404 });

    const foreignList = await listDoctorSchedules(other.tenantId);
    expect(foreignList.total).toBe(0);
  });

  it("handles concurrent overlapping creation safely", async () => {
    const fixture = await createFixture("concurrent");

    const attempts = await Promise.allSettled([
      createDoctorSchedule(fixture.tenantId, newSchedule(fixture, { startTime: "09:00", endTime: "12:00" })),
      createDoctorSchedule(fixture.tenantId, newSchedule(fixture, { startTime: "11:00", endTime: "13:00" })),
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ statusCode: 409 });

    const listed = await listDoctorSchedules(fixture.tenantId, {
      doctorId: fixture.doctorA,
      dayOfWeek: 1,
    });
    expect(listed.total).toBe(1);
  });

  it("deactivates, replaces and deletes schedules", async () => {
    const fixture = await createFixture("delete");

    const original = await createDoctorSchedule(fixture.tenantId, newSchedule(fixture));

    const deactivated = await updateDoctorScheduleStatus(
      fixture.tenantId,
      original.id,
      false,
    );
    expect(deactivated.isActive).toBe(false);

    // Historical rows stay readable and free their period for a replacement.
    const replacement = await createDoctorSchedule(
      fixture.tenantId,
      newSchedule(fixture, { startTime: "10:00", endTime: "12:00" }),
    );
    expect(replacement.id).not.toBe(original.id);
    expect((await getDoctorScheduleById(fixture.tenantId, original.id)).isActive).toBe(
      false,
    );

    await deleteDoctorSchedule(fixture.tenantId, replacement.id);
    await expect(
      getDoctorScheduleById(fixture.tenantId, replacement.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    await deleteDoctorSchedule(fixture.tenantId, original.id);
    await expect(
      deleteDoctorSchedule(fixture.tenantId, original.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
