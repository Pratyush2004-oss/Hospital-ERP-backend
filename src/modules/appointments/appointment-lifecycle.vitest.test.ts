import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createAppointmentBooking } from "./appointment-booking.service.js";
import { cancelAppointment } from "./appointment-cancel.service.js";
import {
  checkInAppointment,
  checkInAppointmentInTransaction,
  completeAppointment,
  completeAppointmentInTransaction,
  getAppointmentLifecycleHistory,
  markAppointmentAsNoShow,
  startAppointment,
  startAppointmentInTransaction,
} from "./appointment-lifecycle.service.js";
import {
  SLOT_SECOND,
  SLOT_START,
  addFailureTrigger,
  addLifecycleBreak,
  addLifecycleSchedule,
  bookingInput,
  cleanupLifecycleFixtures,
  countLifecycleRows,
  createLifecycleFixture,
  deepestMessage,
  doctorActor,
  inAppTransaction,
  insertAppointmentDirectly,
  otherTenantStaffActor,
  removeTemporaryTrigger,
  staffActor,
  type LifecycleFixture,
} from "./appointment-lifecycle.test-fixtures.js";

/**
 * PostgreSQL integration tests for Phase 18.5 lifecycle workflows.
 *
 * Everything runs against the real test database as the restricted
 * `hospitalos_app` role with forced RLS. Lifecycle transitions, timestamps,
 * append-only events, doctor scoping, concurrency and rollback are verified;
 * payment state is deliberately absent.
 */

async function book(
  fixture: LifecycleFixture,
  overrides: Parameters<typeof bookingInput>[1] = {},
) {
  return createAppointmentBooking(
    fixture.tenantId,
    bookingInput(fixture, overrides),
    staffActor(fixture),
  );
}

beforeAll(async () => {
  await getTestAdminPool().query("select 1");
});

afterAll(async () => {
  await cleanupLifecycleFixtures();
  await closeTestAdminPool();
  await closePool();
});

describe("patient check-in", () => {
  it("checks in a confirmed appointment and records the actor, timestamp and event", async () => {
    const fixture = await createLifecycleFixture("lifecycle-check-in");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);
    const checkedInAt = new Date("2026-12-07T08:55:00.000Z");

    const result = await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: checkedInAt },
      staffActor(fixture),
    );

    expect(result.applied).toBe(true);
    expect(result.appointment).toMatchObject({
      id: appointment.id,
      appointmentStatus: "CHECKED_IN",
      checkedInAt,
      consultationStartedAt: null,
      completedAt: null,
      noShowAt: null,
    });

    const [stored] = (
      await getTestAdminPool().query(
        "select appointment_status, checked_in_at from appointments where id = $1",
        [appointment.id],
      )
    ).rows;
    expect(stored.appointment_status).toBe("CHECKED_IN");
    expect(new Date(stored.checked_in_at).toISOString()).toBe(checkedInAt.toISOString());

    const events = (
      await getTestAdminPool().query(
        `select event_type, previous_status, new_status, actor_user_id, metadata, created_at
         from appointment_events where appointment_id = $1 order by created_at`,
        [appointment.id],
      )
    ).rows;

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event_type: "STATUS_CHANGED",
      previous_status: "CONFIRMED",
      new_status: "CHECKED_IN",
      actor_user_id: fixture.staffUserId,
    });
    expect(events[1].metadata).toMatchObject({ action: "CHECK_IN" });
    expect(new Date(events[1].created_at).toISOString()).toBe(
      checkedInAt.toISOString(),
    );
  });

  it("treats a duplicate check-in as an idempotent no-op", async () => {
    const fixture = await createLifecycleFixture("lifecycle-check-in-repeat");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);
    const firstAt = new Date("2026-12-07T08:55:00.000Z");
    const secondAt = new Date("2026-12-07T09:10:00.000Z");

    const first = await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: firstAt },
      staffActor(fixture),
    );
    const second = await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: secondAt },
      staffActor(fixture),
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.appointment.checkedInAt).toEqual(firstAt);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(2);
  });
});

describe("consultation lifecycle", () => {
  it("starts and completes a consultation with timestamps and events", async () => {
    const fixture = await createLifecycleFixture("lifecycle-full-flow");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: new Date("2026-12-07T09:00:00.000Z") },
      staffActor(fixture),
    );

    const startedAt = new Date("2026-12-07T09:06:00.000Z");
    const started = await startAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: startedAt },
      doctorActor(fixture),
    );

    expect(started.applied).toBe(true);
    expect(started.appointment).toMatchObject({
      appointmentStatus: "IN_PROGRESS",
      consultationStartedAt: startedAt,
    });

    const completedAt = new Date("2026-12-07T09:26:00.000Z");
    const completed = await completeAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: completedAt },
      doctorActor(fixture),
    );

    expect(completed.applied).toBe(true);
    expect(completed.appointment).toMatchObject({
      appointmentStatus: "COMPLETED",
      completedAt,
      checkedInAt: new Date("2026-12-07T09:00:00.000Z"),
    });

    const [stored] = (
      await getTestAdminPool().query(
        `select appointment_status, checked_in_at, consultation_started_at, completed_at
         from appointments where id = $1`,
        [appointment.id],
      )
    ).rows;
    expect(stored).toMatchObject({ appointment_status: "COMPLETED" });
    expect(new Date(stored.consultation_started_at).toISOString()).toBe(
      startedAt.toISOString(),
    );
    expect(new Date(stored.completed_at).toISOString()).toBe(completedAt.toISOString());

    const events = (
      await getTestAdminPool().query(
        `select previous_status, new_status, metadata from appointment_events
         where appointment_id = $1 order by created_at`,
        [appointment.id],
      )
    ).rows;
    expect(events.map((event) => event.metadata.action)).toEqual([
      undefined,
      "CHECK_IN",
      "START_CONSULTATION",
      "COMPLETE",
    ]);
    expect(events[2]).toMatchObject({
      previous_status: "CHECKED_IN",
      new_status: "IN_PROGRESS",
    });
    expect(events[3]).toMatchObject({
      previous_status: "IN_PROGRESS",
      new_status: "COMPLETED",
    });
  });

  it("treats a duplicate completion as an idempotent no-op", async () => {
    const fixture = await createLifecycleFixture("lifecycle-complete-repeat");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(fixture.tenantId, { appointmentId: appointment.id }, staffActor(fixture));
    await startAppointment(fixture.tenantId, { appointmentId: appointment.id }, doctorActor(fixture));

    const first = await completeAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      doctorActor(fixture),
    );
    const second = await completeAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: new Date("2026-12-07T10:00:00.000Z") },
      doctorActor(fixture),
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.appointment.completedAt).toEqual(first.appointment.completedAt);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(4);
  });
});

describe("no-show management", () => {
  it("marks a confirmed appointment as a no-show after its scheduled end", async () => {
    const fixture = await createLifecycleFixture("lifecycle-no-show");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);
    const noShowAt = new Date("2026-12-07T09:31:00.000Z");

    const result = await markAppointmentAsNoShow(
      fixture.tenantId,
      { appointmentId: appointment.id, reason: "Patient did not arrive", now: noShowAt },
      staffActor(fixture),
    );

    expect(result.applied).toBe(true);
    expect(result.appointment).toMatchObject({
      appointmentStatus: "NO_SHOW",
      noShowAt,
    });

    const events = (
      await getTestAdminPool().query(
        `select event_type, previous_status, new_status, metadata
         from appointment_events where appointment_id = $1 order by created_at`,
        [appointment.id],
      )
    ).rows;
    expect(events[1]).toMatchObject({
      event_type: "NO_SHOW",
      previous_status: "CONFIRMED",
      new_status: "NO_SHOW",
    });
    expect(events[1].metadata).toMatchObject({
      action: "NO_SHOW",
      reason: "Patient did not arrive",
    });

    // The terminal status releases the interval for booking.
    await insertAppointmentDirectly(fixture, { startAt: SLOT_START, endAt: SLOT_SECOND });
    expect(await countLifecycleRows("appointments", fixture.tenantId)).toBe(2);
  });

  it("rejects a no-show before the scheduled end time", async () => {
    const fixture = await createLifecycleFixture("lifecycle-no-show-early");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      markAppointmentAsNoShow(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          now: new Date("2026-12-07T09:15:00.000Z"),
        },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "NO_SHOW_TOO_EARLY",
      details: { scheduledEndAt: new Date(SLOT_SECOND) },
    });

    const [stored] = (
      await getTestAdminPool().query(
        "select appointment_status, no_show_at from appointments where id = $1",
        [appointment.id],
      )
    ).rows;
    expect(stored.appointment_status).toBe("CONFIRMED");
    expect(stored.no_show_at).toBeNull();
  });

  it("rejects marking a checked-in appointment as a no-show", async () => {
    const fixture = await createLifecycleFixture("lifecycle-no-show-checked-in");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      staffActor(fixture),
    );

    await expect(
      markAppointmentAsNoShow(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          now: new Date("2026-12-07T09:31:00.000Z"),
        },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "CHECKED_IN" },
    });
  });
});

describe("invalid transitions", () => {
  it("refuses to start an appointment that was not checked in", async () => {
    const fixture = await createLifecycleFixture("lifecycle-start-invalid");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      startAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id },
        doctorActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "CONFIRMED", targetStatus: "IN_PROGRESS" },
    });
  });

  it("refuses to complete an appointment that was never started", async () => {
    const fixture = await createLifecycleFixture("lifecycle-complete-invalid");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      staffActor(fixture),
    );

    await expect(
      completeAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id },
        doctorActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "CHECKED_IN", targetStatus: "COMPLETED" },
    });
  });

  it("refuses to check in a completed or cancelled appointment", async () => {
    const fixture = await createLifecycleFixture("lifecycle-check-in-invalid");
    await addLifecycleSchedule(fixture);

    const completedId = await insertAppointmentDirectly(fixture, { status: "COMPLETED" });

    await expect(
      checkInAppointment(
        fixture.tenantId,
        { appointmentId: completedId },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATUS_TRANSITION" });

    const cancelled = await book(fixture, { startAt: "2026-12-07T10:00:00.000Z" });
    await cancelAppointment(
      fixture.tenantId,
      { appointmentId: cancelled.id, cancellationReason: "Patient request" },
      staffActor(fixture),
    );

    await expect(
      checkInAppointment(
        fixture.tenantId,
        { appointmentId: cancelled.id },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "CANCELLED" },
    });
  });

  it("refuses to start a cancelled or completed appointment", async () => {
    const fixture = await createLifecycleFixture("lifecycle-start-terminal");
    await addLifecycleSchedule(fixture);
    const completedId = await insertAppointmentDirectly(fixture, { status: "COMPLETED" });

    await expect(
      startAppointment(
        fixture.tenantId,
        { appointmentId: completedId },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATUS_TRANSITION" });
  });
});

describe("authorization and tenant isolation", () => {
  it("rejects callers without membership or the update permission", async () => {
    const fixture = await createLifecycleFixture("lifecycle-auth");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      checkInAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id },
        { userId: fixture.outsiderUserId, permissions: new Set(["appointment:update"]) },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      checkInAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id },
        { userId: fixture.staffUserId, permissions: new Set(["appointment:read"]) },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("hides appointments from another tenant", async () => {
    const fixture = await createLifecycleFixture("lifecycle-tenant");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      checkInAppointment(
        fixture.otherTenantId,
        { appointmentId: appointment.id },
        otherTenantStaffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    await expect(
      getAppointmentLifecycleHistory(
        fixture.otherTenantId,
        appointment.id,
        otherTenantStaffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("stops a doctor from acting on another doctor's appointment", async () => {
    const fixture = await createLifecycleFixture("lifecycle-doctor-scope");
    await addLifecycleSchedule(fixture);
    await addLifecycleSchedule(fixture, {
      doctorId: fixture.secondDoctorId,
      branchId: fixture.secondaryBranchId,
    });

    const otherDoctorAppointment = await book(fixture, {
      doctorId: fixture.secondDoctorId,
      branchId: fixture.secondaryBranchId,
    });

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: otherDoctorAppointment.id },
      staffActor(fixture),
    );

    await expect(
      startAppointment(
        fixture.tenantId,
        { appointmentId: otherDoctorAppointment.id },
        doctorActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      completeAppointment(
        fixture.tenantId,
        { appointmentId: otherDoctorAppointment.id },
        doctorActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });
});

describe("concurrency and rollback", () => {
  it("handles concurrent duplicate check-ins with a single event", async () => {
    const fixture = await createLifecycleFixture("lifecycle-concurrent-check-in");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        checkInAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          staffActor(fixture),
        ),
      ),
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        checkInAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          staffActor(fixture),
        ),
      ),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const applied = results.filter(
      (result) =>
        (result as PromiseFulfilledResult<{ applied: boolean }>).value.applied,
    );
    expect(applied).toHaveLength(1);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(2);
    expect(await countLifecycleRows("appointments", fixture.tenantId)).toBe(1);
  });

  it("handles concurrent duplicate completions with a single event", async () => {
    const fixture = await createLifecycleFixture("lifecycle-concurrent-complete");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      staffActor(fixture),
    );
    await startAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      doctorActor(fixture),
    );

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.doctorUserId, (tx) =>
        completeAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          doctorActor(fixture),
        ),
      ),
      inAppTransaction(fixture.tenantId, fixture.doctorUserId, (tx) =>
        completeAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          doctorActor(fixture),
        ),
      ),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(4);
  });

  it("serializes concurrent start requests so only one transition applies", async () => {
    const fixture = await createLifecycleFixture("lifecycle-concurrent-start");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id },
      staffActor(fixture),
    );

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.doctorUserId, (tx) =>
        startAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          doctorActor(fixture),
        ),
      ),
      inAppTransaction(fixture.tenantId, fixture.doctorUserId, (tx) =>
        startAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id },
          doctorActor(fixture),
        ),
      ),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(3);
  });

  it("rolls back the status change when event creation fails", async () => {
    const fixture = await createLifecycleFixture("lifecycle-rollback");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);
    const trigger = await addFailureTrigger("appointment_events", fixture.tenantId);

    try {
      const failure = await checkInAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id },
        staffActor(fixture),
      ).catch((error: unknown) => error);

      expect(deepestMessage(failure)).toMatch(/synthetic appointment_events failure/);
    } finally {
      await removeTemporaryTrigger(trigger);
    }

    const [stored] = (
      await getTestAdminPool().query(
        "select appointment_status, checked_in_at from appointments where id = $1",
        [appointment.id],
      )
    ).rows;

    expect(stored.appointment_status).toBe("CONFIRMED");
    expect(stored.checked_in_at).toBeNull();
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(1);
  });
});

describe("lifecycle history", () => {
  it("returns the appointment and its events chronologically", async () => {
    const fixture = await createLifecycleFixture("lifecycle-history");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await checkInAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: new Date("2026-12-07T09:00:00.000Z") },
      staffActor(fixture),
    );
    await startAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: new Date("2026-12-07T09:05:00.000Z") },
      doctorActor(fixture),
    );
    await completeAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, now: new Date("2026-12-07T09:25:00.000Z") },
      doctorActor(fixture),
    );

    const history = await getAppointmentLifecycleHistory(
      fixture.tenantId,
      appointment.id,
      staffActor(fixture),
    );

    expect(history.appointment).toMatchObject({
      id: appointment.id,
      appointmentStatus: "COMPLETED",
      checkedInAt: new Date("2026-12-07T09:00:00.000Z"),
      consultationStartedAt: new Date("2026-12-07T09:05:00.000Z"),
      completedAt: new Date("2026-12-07T09:25:00.000Z"),
      noShowAt: null,
    });

    expect(history.events).toHaveLength(4);
    expect(history.events[0]).toMatchObject({ eventType: "CREATED" });
    expect(history.events.slice(1).map((event) => event.metadata.action)).toEqual([
      "CHECK_IN",
      "START_CONSULTATION",
      "COMPLETE",
    ]);
    expect(
      history.events.map((event) => event.createdAt.getTime()),
    ).toEqual(
      [...history.events]
        .map((event) => event.createdAt.getTime())
        .sort((left, right) => left - right),
    );
    expect(history.events.every((event) => event.actorUserId !== null)).toBe(true);
  });

  it("lets a patient read their own history but not someone else's", async () => {
    const fixture = await createLifecycleFixture("lifecycle-history-self");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const own = await getAppointmentLifecycleHistory(fixture.tenantId, appointment.id, {
      userId: fixture.patientUserId,
    });
    expect(own.appointment.id).toBe(appointment.id);
    expect(own.events).toHaveLength(1);

    const otherPatientAppointment = await book(fixture, {
      patientId: fixture.secondPatientId,
      startAt: "2026-12-07T10:00:00.000Z",
    });

    await expect(
      getAppointmentLifecycleHistory(fixture.tenantId, otherPatientAppointment.id, {
        userId: fixture.patientUserId,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rejects history for an unknown appointment", async () => {
    const fixture = await createLifecycleFixture("lifecycle-history-missing");
    await addLifecycleSchedule(fixture);

    await expect(
      getAppointmentLifecycleHistory(
        fixture.tenantId,
        "00000000-0000-4000-8000-000000000000",
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });
});

describe("no-show and break interaction", () => {
  it("does not mark a no-show for an appointment that is not confirmed", async () => {
    const fixture = await createLifecycleFixture("lifecycle-no-show-terminal");
    const scheduleId = await addLifecycleSchedule(fixture);
    await addLifecycleBreak(fixture, scheduleId, "10:00:00", "10:15:00");
    const appointmentId = await insertAppointmentDirectly(fixture, { status: "COMPLETED" });

    await expect(
      markAppointmentAsNoShow(
        fixture.tenantId,
        { appointmentId, now: new Date("2026-12-07T09:31:00.000Z") },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATUS_TRANSITION" });
  });
});
