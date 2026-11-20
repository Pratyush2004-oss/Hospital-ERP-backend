import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import {
  appointments,
  doctorBreaks,
  doctorLeaves,
  doctorSchedules,
} from "../../database/schema/index.js";
import type { NewAppointment } from "../../database/schema/appointments.js";
import type { NewDoctorLeave } from "../../database/schema/doctor-leaves.js";
import type { NewDoctorSchedule } from "../../database/schema/doctor-schedules.js";
import {
  getAvailableSlots,
  getDoctorAvailability,
  isSlotAvailable,
} from "./appointment-availability.service.js";

/**
 * Integration tests for Phase 18.2 availability and slot generation.
 *
 * Fixtures use the admin connection; the service under test runs through
 * `withTenantTransaction`, i.e. as the restricted `hospitalos_app` role with
 * RLS. Dates are synthetic (December 2026 and DST transition Sundays), and no
 * real patient information is used.
 */

interface Fixture {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly branchId: string;
  readonly secondaryBranchId: string;
  readonly inactiveBranchId: string;
  readonly unassignedBranchId: string;
  readonly otherTenantBranchId: string;
  readonly doctorId: string;
  readonly inactiveDoctorId: string;
  readonly otherTenantDoctorId: string;
  readonly creatorId: string;
  readonly patientId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const branchId = randomUUID();
  const secondaryBranchId = randomUUID();
  const inactiveBranchId = randomUUID();
  const unassignedBranchId = randomUUID();
  const otherTenantBranchId = randomUUID();
  const creatorId = randomUUID();
  const doctorUserId = randomUUID();
  const inactiveDoctorUserId = randomUUID();
  const otherDoctorUserId = randomUUID();
  const doctorId = randomUUID();
  const inactiveDoctorId = randomUUID();
  const otherTenantDoctorId = randomUUID();
  const patientId = randomUUID();

  await pool.query(
    `insert into tenants (id, name, slug)
     values ($1, $2, $3), ($4, $5, $6)`,
    [
      tenantId,
      `${label} Hospital`,
      `${label}-${suffix}`,
      otherTenantId,
      `${label} Other Hospital`,
      `${label}-other-${suffix}`,
    ],
  );

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1, $6, 'Central', $7, 'Europe/London', true),
            ($2, $6, 'Riverside', $8, 'Europe/London', true),
            ($3, $6, 'Closed', $9, 'Europe/London', false),
            ($4, $6, 'Unassigned', $10, 'Europe/London', true),
            ($5, $11, 'Other Central', $12, 'UTC', true)`,
    [
      branchId,
      secondaryBranchId,
      inactiveBranchId,
      unassignedBranchId,
      otherTenantBranchId,
      tenantId,
      `CEN-${suffix}`,
      `RIV-${suffix}`,
      `CLO-${suffix}`,
      `UNA-${suffix}`,
      otherTenantId,
      `OTH-${suffix}`,
    ],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'availability-test-hash'),
            ($4, $5, $6, 'availability-test-hash'),
            ($7, $8, $9, 'availability-test-hash'),
            ($10, $11, $12, 'availability-test-hash')`,
    [
      creatorId,
      `${label} Receptionist`,
      `reception-${label}-${suffix}@availability.test`,
      doctorUserId,
      `${label} Doctor`,
      `doctor-${label}-${suffix}@availability.test`,
      inactiveDoctorUserId,
      `${label} Inactive Doctor`,
      `inactive-doctor-${label}-${suffix}@availability.test`,
      otherDoctorUserId,
      `${label} Other Doctor`,
      `other-doctor-${label}-${suffix}@availability.test`,
    ],
  );
  createdUserIds.push(creatorId, doctorUserId, inactiveDoctorUserId, otherDoctorUserId);

  await pool.query(
    `insert into doctors
       (id, tenant_id, user_id, doctor_code, registration_number, is_active)
     values ($1, $2, $3, $4, $5, true),
            ($6, $2, $7, $8, $9, false),
            ($10, $11, $12, $13, $14, true)`,
    [
      doctorId,
      tenantId,
      doctorUserId,
      `DOC-${suffix}`,
      `REG-${suffix}`,
      inactiveDoctorId,
      inactiveDoctorUserId,
      `DOC-IN-${suffix}`,
      `REG-IN-${suffix}`,
      otherTenantDoctorId,
      otherTenantId,
      otherDoctorUserId,
      `DOC-OTH-${suffix}`,
      `REG-OTH-${suffix}`,
    ],
  );

  await pool.query(
    `insert into doctor_branches
       (tenant_id, doctor_id, branch_id, consultation_fee, currency, is_active)
     values ($1, $2, $3, 150.00, 'GBP', true),
            ($1, $2, $4, 175.00, 'GBP', true),
            ($1, $5, $3, 90.00, 'GBP', true),
            ($6, $7, $8, 80.00, 'USD', true)`,
    [
      tenantId,
      doctorId,
      branchId,
      secondaryBranchId,
      inactiveDoctorId,
      otherTenantId,
      otherTenantDoctorId,
      otherTenantBranchId,
    ],
  );

  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, $4)`,
    [
      patientId,
      tenantId,
      `MRN-${suffix}`,
      `Synthetic Availability Patient ${suffix}`,
    ],
  );

  const fixture: Fixture = {
    tenantId,
    otherTenantId,
    branchId,
    secondaryBranchId,
    inactiveBranchId,
    unassignedBranchId,
    otherTenantBranchId,
    doctorId,
    inactiveDoctorId,
    otherTenantDoctorId,
    creatorId,
    patientId,
  };
  fixtures.push(fixture);
  return fixture;
}

async function addSchedule(
  fixture: Fixture,
  overrides: Partial<NewDoctorSchedule> = {},
): Promise<{ id: string }> {
  const [row] = await withTenantTransaction(fixture.tenantId, (tx) =>
    tx
      .insert(doctorSchedules)
      .values({
        tenantId: fixture.tenantId,
        doctorId: fixture.doctorId,
        branchId: fixture.branchId,
        dayOfWeek: 1,
        startTime: "09:00:00",
        endTime: "12:00:00",
        slotDurationMinutes: 30,
        bufferMinutes: 0,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        isActive: true,
        ...overrides,
      })
      .returning({ id: doctorSchedules.id }),
  );

  if (!row) throw new Error("Failed to create schedule fixture");
  return row;
}

async function addBreak(
  fixture: Fixture,
  scheduleId: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  await withTenantTransaction(fixture.tenantId, (tx) =>
    tx.insert(doctorBreaks).values({
      tenantId: fixture.tenantId,
      scheduleId,
      startTime,
      endTime,
    }),
  );
}

async function addLeave(
  fixture: Fixture,
  overrides: Partial<NewDoctorLeave> = {},
): Promise<void> {
  const status = overrides.status ?? "APPROVED";

  await withTenantTransaction(fixture.tenantId, (tx) =>
    tx.insert(doctorLeaves).values({
      tenantId: fixture.tenantId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      startAt: new Date("2026-12-07T00:00:00.000Z"),
      endAt: new Date("2026-12-08T00:00:00.000Z"),
      reason: "Synthetic leave",
      status,
      createdBy: fixture.creatorId,
      approvedBy: status === "APPROVED" ? fixture.creatorId : null,
      approvedAt: status === "APPROVED" ? new Date("2026-11-01T09:00:00.000Z") : null,
      rejectedBy: status === "REJECTED" ? fixture.creatorId : null,
      rejectedAt: status === "REJECTED" ? new Date("2026-11-01T09:00:00.000Z") : null,
      rejectionReason: status === "REJECTED" ? "Synthetic rejection" : null,
      ...overrides,
    }),
  );
}

async function addAppointment(
  fixture: Fixture,
  overrides: Partial<NewAppointment> = {},
): Promise<void> {
  const status = overrides.appointmentStatus ?? "CONFIRMED";

  await withTenantTransaction(fixture.tenantId, (tx) =>
    tx.insert(appointments).values({
      tenantId: fixture.tenantId,
      patientId: fixture.patientId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      appointmentCode: `APT-${randomUUID().slice(0, 8).toUpperCase()}`,
      appointmentSource: "RECEPTIONIST",
      appointmentStatus: status,
      startAt: new Date("2026-12-07T09:00:00.000Z"),
      endAt: new Date("2026-12-07T09:30:00.000Z"),
      createdBy: fixture.creatorId,
      cancelledBy: status === "CANCELLED" ? fixture.creatorId : null,
      cancellationReason: status === "CANCELLED" ? "Synthetic cancellation" : null,
      ...overrides,
    }),
  );
}

function starts(result: Awaited<ReturnType<typeof getDoctorAvailability>>): string[] {
  return (result.days[0]?.slots ?? []).map((slot) => slot.startAt.toISOString());
}

beforeAll(async () => {
  // Validate the environment is reachable before the suites run.
  await getTestAdminPool().query("select 1");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    for (const tenantId of [fixture.tenantId, fixture.otherTenantId]) {
      await pool.query("delete from appointments where tenant_id = $1", [tenantId]);
      await pool.query("delete from doctor_leaves where tenant_id = $1", [tenantId]);
      await pool.query("delete from doctor_schedules where tenant_id = $1", [tenantId]);
      await pool.query("delete from tenants where id = $1", [tenantId]);
    }
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("slot generation", () => {
  it("generates contiguous slots for a normal working day", async () => {
    const fixture = await createFixture("avail-normal");
    await addSchedule(fixture);

    const result = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });

    expect(result).toMatchObject({
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      branchTimezone: "Europe/London",
      fromDate: "2026-12-07",
      toDate: "2026-12-07",
      requestedDurationMinutes: null,
      consultationFee: "150.00",
      currency: "GBP",
    });
    expect(starts(result)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:30:00.000Z",
      "2026-12-07T10:00:00.000Z",
      "2026-12-07T10:30:00.000Z",
      "2026-12-07T11:00:00.000Z",
      "2026-12-07T11:30:00.000Z",
    ]);
    expect(result.days[0]?.slots[0]).toMatchObject({ durationMinutes: 30 });
    expect(result.days[0]?.slots[0]?.endAt.toISOString()).toBe(
      "2026-12-07T09:30:00.000Z",
    );
  });

  it("supports multiple non-overlapping working windows and returns sorted unique slots", async () => {
    const fixture = await createFixture("avail-windows");
    await addSchedule(fixture, { startTime: "09:00:00", endTime: "10:00:00" });
    await addSchedule(fixture, { startTime: "14:00:00", endTime: "15:00:00" });

    const slots = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });

    expect(slots.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:30:00.000Z",
      "2026-12-07T14:00:00.000Z",
      "2026-12-07T14:30:00.000Z",
    ]);
    expect(new Set(slots.map((slot) => slot.startAt.getTime())).size).toBe(4);
  });

  it("honours a duration override and the schedule slot duration otherwise", async () => {
    const fixture = await createFixture("avail-duration");
    await addSchedule(fixture, { startTime: "09:00:00", endTime: "10:00:00" });

    const overridden = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
      durationMinutes: 20,
    });

    expect(overridden.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:20:00.000Z",
      "2026-12-07T09:40:00.000Z",
    ]);
    expect(overridden.every((slot) => slot.durationMinutes === 20)).toBe(true);
    expect(overridden[2]?.endAt.toISOString()).toBe("2026-12-07T10:00:00.000Z");
  });

  it("excludes slots overlapping one or more breaks", async () => {
    const fixture = await createFixture("avail-breaks");
    const schedule = await addSchedule(fixture);
    await addBreak(fixture, schedule.id, "10:00:00", "10:15:00");
    await addBreak(fixture, schedule.id, "11:00:00", "11:30:00");

    const result = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });

    expect(starts(result)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:30:00.000Z",
      // 10:00-10:30 overlaps the first break; 10:30-11:00 fits before the second.
      "2026-12-07T10:30:00.000Z",
      // 11:00-11:30 overlaps the second break; 11:30-12:00 is free again.
      "2026-12-07T11:30:00.000Z",
    ]);
  });
});

describe("leave policy", () => {
  it("blocks approved branch-specific and all-branch leave", async () => {
    const fixture = await createFixture("avail-leave");
    await addSchedule(fixture);

    await addLeave(fixture, {
      startAt: new Date("2026-12-07T09:30:00.000Z"),
      endAt: new Date("2026-12-07T10:30:00.000Z"),
    });

    const branchBlocked = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    expect(starts(branchBlocked)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T10:30:00.000Z",
      "2026-12-07T11:00:00.000Z",
      "2026-12-07T11:30:00.000Z",
    ]);

    // An all-branch approved leave blocks the same interval too.
    await addLeave(fixture, {
      branchId: null,
      startAt: new Date("2026-12-07T10:30:00.000Z"),
      endAt: new Date("2026-12-07T11:00:00.000Z"),
    });

    const allBranchBlocked = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    expect(starts(allBranchBlocked)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T11:00:00.000Z",
      "2026-12-07T11:30:00.000Z",
    ]);
  });

  it("does not block pending, rejected or cancelled leave", async () => {
    const fixture = await createFixture("avail-leave-pending");
    await addSchedule(fixture);

    const interval = {
      startAt: new Date("2026-12-07T09:30:00.000Z"),
      endAt: new Date("2026-12-07T10:30:00.000Z"),
    };

    await addLeave(fixture, { ...interval, status: "PENDING" });
    await addLeave(fixture, { ...interval, status: "REJECTED" });
    await addLeave(fixture, { ...interval, status: "CANCELLED" });

    const result = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });

    // Availability may look optimistic while a request is pending; only an
    // approved absence suppresses slots (documented policy).
    expect(starts(result)).toHaveLength(6);
  });

  it("only blocks leave for the queried branch", async () => {
    const fixture = await createFixture("avail-leave-other-branch");
    await addSchedule(fixture);

    await addLeave(fixture, {
      branchId: fixture.secondaryBranchId,
      startAt: new Date("2026-12-07T00:00:00.000Z"),
      endAt: new Date("2026-12-08T00:00:00.000Z"),
    });

    const result = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });

    expect(starts(result)).toHaveLength(6);
  });
});

describe("appointment conflicts", () => {
  it("blocks active appointments and releases terminal statuses", async () => {
    const fixture = await createFixture("avail-appointments");
    await addSchedule(fixture);

    await addAppointment(fixture, {
      startAt: new Date("2026-12-07T09:30:00.000Z"),
      endAt: new Date("2026-12-07T10:00:00.000Z"),
      appointmentStatus: "CONFIRMED",
    });
    await addAppointment(fixture, {
      startAt: new Date("2026-12-07T10:00:00.000Z"),
      endAt: new Date("2026-12-07T10:30:00.000Z"),
      appointmentStatus: "CHECKED_IN",
    });

    const blocked = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    expect(starts(blocked)).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T10:30:00.000Z",
      "2026-12-07T11:00:00.000Z",
      "2026-12-07T11:30:00.000Z",
    ]);

    // Cancelled/completed/no-show/rescheduled appointments are historical.
    const terminal = await createFixture("avail-appointments-terminal");
    await addSchedule(terminal);
    for (const status of [
      "CANCELLED",
      "COMPLETED",
      "NO_SHOW",
      "RESCHEDULED",
    ] as const) {
      await addAppointment(terminal, {
        startAt: new Date("2026-12-07T09:30:00.000Z"),
        endAt: new Date("2026-12-07T10:30:00.000Z"),
        appointmentStatus: status,
      });
    }

    const released = await getDoctorAvailability(terminal.tenantId, {
      doctorId: terminal.doctorId,
      branchId: terminal.branchId,
      date: "2026-12-07",
    });
    expect(starts(released)).toHaveLength(6);
  });

  it("applies the schedule buffer when stepping slots and after existing appointments", async () => {
    const fixture = await createFixture("avail-buffer");
    await addSchedule(fixture, {
      startTime: "09:00:00",
      endTime: "11:00:00",
      bufferMinutes: 15,
    });

    const free = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    expect(free.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:45:00.000Z",
      "2026-12-07T10:30:00.000Z",
    ]);

    await addAppointment(fixture, {
      startAt: new Date("2026-12-07T09:00:00.000Z"),
      endAt: new Date("2026-12-07T09:30:00.000Z"),
      appointmentStatus: "CONFIRMED",
    });

    const afterAppointment = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    // 09:45 starts exactly after the 15-minute schedule buffer following the
    // 09:00-09:30 appointment.
    expect(afterAppointment.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-12-07T09:45:00.000Z",
      "2026-12-07T10:30:00.000Z",
    ]);
  });
});

describe("time and timezone handling", () => {
  it("excludes past slots and returns no slots for a past date", async () => {
    const fixture = await createFixture("avail-past");
    await addSchedule(fixture, {
      startTime: "09:00:00",
      endTime: "11:00:00",
    });

    const today = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-11-30",
      now: new Date("2026-11-30T10:05:00.000Z"),
    });
    expect(starts(today)).toEqual(["2026-11-30T10:30:00.000Z"]);

    const past = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-11-23",
      now: new Date("2026-11-30T10:05:00.000Z"),
    });
    expect(past.days[0]?.slots).toEqual([]);
  });

  it("interprets wall-clock windows in the branch zone across summer and winter", async () => {
    const fixture = await createFixture("avail-zone");
    await addSchedule(fixture, {
      startTime: "09:00:00",
      endTime: "10:00:00",
      effectiveFrom: "2026-01-01",
    });

    const summer = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-07-06",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // BST (UTC+1).
    expect(summer.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-07-06T08:00:00.000Z",
      "2026-07-06T08:30:00.000Z",
    ]);

    const winter = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // GMT (UTC+0).
    expect(winter.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T09:30:00.000Z",
    ]);
  });

  it("skips non-existent spring-forward times and uses the first fall-back occurrence", async () => {
    const fixture = await createFixture("avail-dst");
    await addSchedule(fixture, {
      dayOfWeek: 7,
      startTime: "00:30:00",
      endTime: "03:00:00",
      effectiveFrom: "2026-01-01",
    });

    const spring = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-03-29",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // 01:00 and 01:30 local do not exist; 02:00 and 02:30 local are 01:00Z/01:30Z.
    expect(spring.map((slot) => slot.startAt.toISOString())).toEqual([
      "2026-03-29T00:30:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T01:30:00.000Z",
    ]);

    const fallFixture = await createFixture("avail-dst-fall");
    await addSchedule(fallFixture, {
      dayOfWeek: 7,
      startTime: "00:00:00",
      endTime: "03:00:00",
      effectiveFrom: "2026-01-01",
    });

    const fall = await getAvailableSlots(fallFixture.tenantId, {
      doctorId: fallFixture.doctorId,
      branchId: fallFixture.branchId,
      date: "2026-10-25",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fallStarts = fall.map((slot) => slot.startAt.toISOString());
    // 00:00 and 00:30 local are still BST; 01:00/01:30 use the first (BST)
    // occurrence; 02:00/02:30 are GMT after the transition.
    expect(fallStarts).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-24T23:30:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]);
    // The repeated 01:00 local (01:00Z) is not generated a second time.
    expect(fallStarts).not.toContain("2026-10-25T01:00:00.000Z");
  });
});

describe("isSlotAvailable", () => {
  it("accepts a free interval inside a window and rejects conflicts", async () => {
    const fixture = await createFixture("avail-check");
    const schedule = await addSchedule(fixture, {
      startTime: "09:00:00",
      endTime: "11:00:00",
    });
    await addBreak(fixture, schedule.id, "10:00:00", "10:30:00");

    const base = {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      now: new Date("2026-12-01T00:00:00.000Z"),
    };

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T09:15:00Z",
        durationMinutes: 30,
      }),
    ).resolves.toBe(true);

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T10:00:00Z",
        durationMinutes: 30,
      }),
    ).resolves.toBe(false);

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T08:45:00Z",
        durationMinutes: 30,
      }),
    ).resolves.toBe(false);

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T10:45:00Z",
        durationMinutes: 30,
      }),
    ).resolves.toBe(false);

    // Past instants are never available.
    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        now: new Date("2026-12-07T09:20:00.000Z"),
        startAt: "2026-12-07T09:15:00Z",
        durationMinutes: 15,
      }),
    ).resolves.toBe(false);
  });

  it("respects approved leave and active appointments", async () => {
    const fixture = await createFixture("avail-check-conflicts");
    await addSchedule(fixture, {
      startTime: "09:00:00",
      endTime: "11:00:00",
    });

    const base = {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      now: new Date("2026-12-01T00:00:00.000Z"),
      durationMinutes: 30,
    };

    await addLeave(fixture, {
      startAt: new Date("2026-12-07T09:00:00.000Z"),
      endAt: new Date("2026-12-07T09:30:00.000Z"),
    });
    await addAppointment(fixture, {
      startAt: new Date("2026-12-07T10:00:00.000Z"),
      endAt: new Date("2026-12-07T10:30:00.000Z"),
      appointmentStatus: "CONFIRMED",
    });

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T09:00:00Z",
      }),
    ).resolves.toBe(false);

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T10:00:00Z",
      }),
    ).resolves.toBe(false);

    await expect(
      isSlotAvailable(fixture.tenantId, {
        ...base,
        startAt: "2026-12-07T09:30:00Z",
      }),
    ).resolves.toBe(true);
  });
});

describe("eligibility and tenant isolation", () => {
  it("rejects inactive doctors and branches, and unassigned branches", async () => {
    const fixture = await createFixture("avail-eligibility");

    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.inactiveDoctorId,
        branchId: fixture.branchId,
        date: "2026-12-07",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.inactiveBranchId,
        date: "2026-12-07",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The branch is active but this doctor is not assigned to it.
    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.unassignedBranchId,
        date: "2026-12-07",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("hides doctors and branches from another tenant", async () => {
    const fixture = await createFixture("avail-tenant");

    await expect(
      getDoctorAvailability(fixture.otherTenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.branchId,
        date: "2026-12-07",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.otherTenantBranchId,
        date: "2026-12-07",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The other tenant's doctor is likewise invisible from this tenant.
    await expect(
      isSlotAvailable(fixture.tenantId, {
        doctorId: fixture.otherTenantDoctorId,
        branchId: fixture.otherTenantBranchId,
        startAt: "2026-12-07T09:00:00Z",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns empty days for a range and validates range input", async () => {
    const fixture = await createFixture("avail-range");
    await addSchedule(fixture);

    const result = await getDoctorAvailability(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      fromDate: "2026-12-07",
      toDate: "2026-12-08",
    });

    expect(result.days).toHaveLength(2);
    expect(starts(result)).toHaveLength(6);
    expect(result.days[1]).toEqual({ date: "2026-12-08", slots: [] });

    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.branchId,
        date: "2026-12-07",
        fromDate: "2026-12-07",
        toDate: "2026-12-08",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      getDoctorAvailability(fixture.tenantId, {
        doctorId: fixture.doctorId,
        branchId: fixture.branchId,
        fromDate: "2026-12-01",
        toDate: "2027-01-31",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("overlapping schedule safety", () => {
  it("relies on the existing exclusion constraint and never emits duplicate starts", async () => {
    const fixture = await createFixture("avail-overlap");
    await addSchedule(fixture, { startTime: "09:00:00", endTime: "10:00:00" });

    await expect(
      addSchedule(fixture, { startTime: "09:30:00", endTime: "10:30:00" }),
    ).rejects.toMatchObject({ cause: { code: "23P01" } });

    await addSchedule(fixture, { startTime: "10:00:00", endTime: "11:00:00" });

    const slots = await getAvailableSlots(fixture.tenantId, {
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      date: "2026-12-07",
    });
    const startsList = slots.map((slot) => slot.startAt.getTime());

    expect(startsList).toEqual([...startsList].sort((a, b) => a - b));
    expect(new Set(startsList).size).toBe(startsList.length);
  });
});
