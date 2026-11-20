import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createAppointmentBooking } from "./appointment-booking.service.js";
import { cancelAppointment } from "./appointment-cancel.service.js";
import {
  FIXED_NOW,
  SLOT_SECOND,
  SLOT_START,
  SLOT_THIRD,
  addFailureTrigger,
  addInsertDelayTrigger,
  addLifecycleBreak,
  addLifecycleLeave,
  addLifecycleSchedule,
  bookingInput,
  cleanupLifecycleFixtures,
  countLifecycleRows,
  createLifecycleFixture,
  deepestMessage,
  inAppTransaction,
  insertAppointmentDirectly,
  otherTenantStaffActor,
  removeTemporaryTrigger,
  staffActor,
  type LifecycleFixture,
} from "./appointment-lifecycle.test-fixtures.js";
import {
  rescheduleAppointment,
  rescheduleAppointmentInTransaction,
  validateRescheduleRequest,
} from "./appointment-reschedule.service.js";

/**
 * PostgreSQL integration tests for Phase 18.4 rescheduling.
 *
 * The replacement model is verified end to end: original becomes RESCHEDULED
 * and releases its slot, the replacement is CONFIRMED and linked, both events
 * exist, and the exclusion constraint remains the double-booking guard under
 * real concurrent transactions.
 */

async function book(
  fixture: LifecycleFixture,
  overrides: Parameters<typeof bookingInput>[1] = {},
) {
  return createAppointmentBooking(fixture.tenantId, bookingInput(fixture, overrides), staffActor(fixture));
}

beforeAll(async () => {
  await getTestAdminPool().query("select 1");
});

afterAll(async () => {
  await cleanupLifecycleFixtures();
  await closeTestAdminPool();
  await closePool();
});

describe("reschedule request validation", () => {
  it("returns the resolved target slot, fee and currency without writing", async () => {
    const fixture = await createLifecycleFixture("reschedule-validate");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const validation = await validateRescheduleRequest(fixture.tenantId, {
      appointmentId: appointment.id,
      startAt: SLOT_THIRD,
      reason: "Doctor called to theatre",
      now: FIXED_NOW,
    });

    expect(validation).toMatchObject({
      appointmentId: appointment.id,
      patientId: fixture.patientId,
      currentStatus: "CONFIRMED",
      currentDoctorId: fixture.doctorId,
      currentBranchId: fixture.branchId,
      targetDoctorId: fixture.doctorId,
      targetBranchId: fixture.branchId,
      durationMinutes: 30,
      consultationFee: "150.00",
      currency: "GBP",
      branchTimezone: "Europe/London",
      reason: "Doctor called to theatre",
    });
    expect(validation.targetStartAt.toISOString()).toBe(SLOT_THIRD);
    expect(validation.targetEndAt.toISOString()).toBe("2026-12-07T10:30:00.000Z");

    // Read-only: the appointment is still CONFIRMED at its original time.
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(1);
    const [stored] = (
      await getTestAdminPool().query(
        "select appointment_status, start_at from appointments where id = $1",
        [appointment.id],
      )
    ).rows;
    expect(stored.appointment_status).toBe("CONFIRMED");
    expect(new Date(stored.start_at).toISOString()).toBe(SLOT_START);
  });

  it("rejects an end timestamp that is not later than the start or conflicts with a duration", async () => {
    const fixture = await createLifecycleFixture("reschedule-end-validation");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      validateRescheduleRequest(fixture.tenantId, {
        appointmentId: appointment.id,
        startAt: SLOT_THIRD,
        endAt: "2026-12-07T10:00:00.000Z",
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      validateRescheduleRequest(fixture.tenantId, {
        appointmentId: appointment.id,
        startAt: SLOT_THIRD,
        endAt: "2026-12-07T10:30:00.000Z",
        durationMinutes: 30,
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("successful rescheduling", () => {
  it("supersedes the original, creates a linked replacement and records complete history", async () => {
    const fixture = await createLifecycleFixture("reschedule-success");
    await addLifecycleSchedule(fixture);
    const original = await book(fixture);

    const result = await rescheduleAppointment(
      fixture.tenantId,
      {
        appointmentId: original.id,
        startAt: SLOT_THIRD,
        reason: "Doctor called to theatre",
        idempotencyKey: "reschedule-key-1",
      },
      staffActor(fixture),
    );

    expect(result.replayed).toBe(false);
    expect(result.original).toMatchObject({
      id: original.id,
      appointmentStatus: "RESCHEDULED",
      appointmentCode: original.appointmentCode,
      startAt: new Date(SLOT_START),
    });
    expect(result.replacement).toMatchObject({
      appointmentStatus: "CONFIRMED",
      patientId: fixture.patientId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      consultationFee: "150.00",
      currency: "GBP",
      rescheduledFromAppointmentId: original.id,
      replayed: false,
    });
    expect(result.replacement.startAt.toISOString()).toBe(SLOT_THIRD);
    expect(result.replacement.endAt.toISOString()).toBe("2026-12-07T10:30:00.000Z");
    expect(result.replacement.id).not.toBe(original.id);
    expect(result.replacement.appointmentCode).not.toBe(original.appointmentCode);

    const events = (
      await getTestAdminPool().query(
        `select appointment_id, event_type, previous_status, new_status, actor_user_id, metadata
         from appointment_events where tenant_id = $1 order by created_at, event_type`,
        [fixture.tenantId],
      )
    ).rows;

    expect(events).toHaveLength(3);

    const rescheduledEvent = events.find((event) => event.event_type === "RESCHEDULED");
    expect(rescheduledEvent).toMatchObject({
      appointment_id: original.id,
      previous_status: "CONFIRMED",
      new_status: "RESCHEDULED",
      actor_user_id: fixture.staffUserId,
    });
    expect(rescheduledEvent.metadata).toMatchObject({
      reason: "Doctor called to theatre",
      previousStartAt: SLOT_START,
      newStartAt: SLOT_THIRD,
      previousDoctorId: fixture.doctorId,
      newDoctorId: fixture.doctorId,
      previousBranchId: fixture.branchId,
      newBranchId: fixture.branchId,
      replacementAppointmentId: result.replacement.id,
    });

    const replacementCreated = events.find(
      (event) =>
        event.event_type === "CREATED" &&
        event.appointment_id === result.replacement.id,
    );
    expect(replacementCreated).toMatchObject({ new_status: "CONFIRMED" });
    expect(replacementCreated.metadata).toMatchObject({
      rescheduledFromAppointmentId: original.id,
      appointmentCode: result.replacement.appointmentCode,
    });

    const keys = (
      await getTestAdminPool().query(
        `select operation, status, appointment_id from appointment_idempotency_keys
         where tenant_id = $1 and operation = 'appointment.reschedule'`,
        [fixture.tenantId],
      )
    ).rows;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      status: "COMPLETED",
      appointment_id: result.replacement.id,
    });
  });

  it("moves to a different doctor and branch using that assignment's fee", async () => {
    const fixture = await createLifecycleFixture("reschedule-other-doctor");
    await addLifecycleSchedule(fixture);
    await addLifecycleSchedule(fixture, {
      doctorId: fixture.secondDoctorId,
      branchId: fixture.secondaryBranchId,
    });
    const original = await book(fixture);

    const result = await rescheduleAppointment(
      fixture.tenantId,
      {
        appointmentId: original.id,
        doctorId: fixture.secondDoctorId,
        branchId: fixture.secondaryBranchId,
        startAt: SLOT_START,
        now: FIXED_NOW,
      },
      staffActor(fixture),
    );

    expect(result.replacement).toMatchObject({
      doctorId: fixture.secondDoctorId,
      branchId: fixture.secondaryBranchId,
      consultationFee: "200.00",
      currency: "USD",
      rescheduledFromAppointmentId: original.id,
    });
    expect(result.original.doctorId).toBe(fixture.doctorId);
    expect(result.original.branchId).toBe(fixture.branchId);
  });

  it("releases the old slot so it can be booked again", async () => {
    const fixture = await createLifecycleFixture("reschedule-release");
    await addLifecycleSchedule(fixture);
    const original = await book(fixture);

    await rescheduleAppointment(
      fixture.tenantId,
      { appointmentId: original.id, startAt: SLOT_THIRD, now: FIXED_NOW },
      staffActor(fixture),
    );

    const rebooked = await book(fixture, { patientId: fixture.secondPatientId });

    expect(rebooked.appointmentStatus).toBe("CONFIRMED");
    expect(rebooked.startAt.toISOString()).toBe(SLOT_START);
    expect(rebooked.id).not.toBe(original.id);
  });

  it("allows a patient to reschedule their own appointment", async () => {
    const fixture = await createLifecycleFixture("reschedule-self-service");
    await addLifecycleSchedule(fixture);
    const original = await book(fixture);

    const result = await rescheduleAppointment(
      fixture.tenantId,
      { appointmentId: original.id, startAt: SLOT_THIRD, now: FIXED_NOW },
      { userId: fixture.patientUserId },
    );

    expect(result.replacement.appointmentStatus).toBe("CONFIRMED");
    expect(result.replacement.createdBy).toBe(fixture.patientUserId);
    expect(result.replacement.appointmentSource).toBe("RECEPTIONIST");
  });
});

describe("reschedule slot validation", () => {
  it("rejects a slot occupied by another appointment", async () => {
    const fixture = await createLifecycleFixture("reschedule-occupied");
    await addLifecycleSchedule(fixture);
    const first = await book(fixture);
    await book(fixture, { patientId: fixture.secondPatientId, startAt: SLOT_SECOND });

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: first.id, startAt: SLOT_SECOND, now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "OCCUPIED" },
    });
  });

  it("rejects a request outside the doctor's working hours", async () => {
    const fixture = await createLifecycleFixture("reschedule-window");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, startAt: "2026-12-07T12:30:00.000Z", now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "OUTSIDE_SCHEDULE" },
    });
  });

  it("rejects a slot inside a break", async () => {
    const fixture = await createLifecycleFixture("reschedule-break");
    const scheduleId = await addLifecycleSchedule(fixture);
    await addLifecycleBreak(fixture, scheduleId, "10:00:00", "10:15:00");
    const appointment = await book(fixture);

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "BREAK" },
    });
  });

  it("rejects a slot during approved leave", async () => {
    const fixture = await createLifecycleFixture("reschedule-leave");
    await addLifecycleSchedule(fixture);
    await addLifecycleLeave(
      fixture,
      "2026-12-07T10:00:00.000Z",
      "2026-12-07T11:00:00.000Z",
    );
    const appointment = await book(fixture);

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "LEAVE" },
    });
  });

  it("rejects a move into the past", async () => {
    const fixture = await createLifecycleFixture("reschedule-past");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          startAt: SLOT_START,
          now: new Date("2026-12-07T09:10:00.000Z"),
        },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "PAST" },
    });
  });
});

describe("status transitions", () => {
  it("rejects rescheduling a cancelled appointment", async () => {
    const fixture = await createLifecycleFixture("reschedule-cancelled");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await cancelAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, cancellationReason: "Patient request" },
      staffActor(fixture),
    );

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "CANCELLED" },
    });
  });

  it("rejects rescheduling a completed appointment", async () => {
    const fixture = await createLifecycleFixture("reschedule-completed");
    await addLifecycleSchedule(fixture);
    const appointmentId = await insertAppointmentDirectly(fixture, {
      status: "COMPLETED",
    });

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId, startAt: SLOT_THIRD, now: FIXED_NOW },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "COMPLETED" },
    });
  });

  it("rejects an unauthorized caller and hides appointments from other tenants", async () => {
    const fixture = await createLifecycleFixture("reschedule-auth");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
        { userId: fixture.outsiderUserId, permissions: new Set(["appointment:update"]) },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      rescheduleAppointment(
        fixture.otherTenantId,
        { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
        otherTenantStaffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("rescheduling concurrency and rollback", () => {
  it("serializes two concurrent reschedules of the same appointment", async () => {
    const fixture = await createLifecycleFixture("reschedule-concurrent-same");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const input = {
      appointmentId: appointment.id,
      startAt: SLOT_THIRD,
      now: FIXED_NOW,
    };

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        rescheduleAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        rescheduleAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toMatchObject({ statusCode: 409, code: "INVALID_STATUS_TRANSITION" });

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status, rescheduled_from_appointment_id
         from appointments where tenant_id = $1 order by created_at`,
        [fixture.tenantId],
      )
    ).rows;

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.appointment_status === "RESCHEDULED")).toHaveLength(1);
    expect(rows.filter((row) => row.rescheduled_from_appointment_id !== null)).toHaveLength(1);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(3);
  });

  it("allows only one of two reschedules that target the same new slot", async () => {
    const fixture = await createLifecycleFixture("reschedule-concurrent-slot");
    await addLifecycleSchedule(fixture);
    const first = await book(fixture);
    const second = await book(fixture, {
      patientId: fixture.secondPatientId,
      startAt: SLOT_SECOND,
    });

    const delay = await addInsertDelayTrigger(fixture.tenantId, 0.3);

    try {
      const results = await Promise.allSettled([
        inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
          rescheduleAppointmentInTransaction(
            tx,
            fixture.tenantId,
            { appointmentId: first.id, startAt: "2026-12-07T11:00:00.000Z", now: FIXED_NOW },
            staffActor(fixture),
          ),
        ),
        inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
          rescheduleAppointmentInTransaction(
            tx,
            fixture.tenantId,
            { appointmentId: second.id, startAt: "2026-12-07T11:00:00.000Z", now: FIXED_NOW },
            staffActor(fixture),
          ),
        ),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toMatchObject({ statusCode: 409, code: "SLOT_UNAVAILABLE" });
    } finally {
      await removeTemporaryTrigger(delay);
    }

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status, start_at, rescheduled_from_appointment_id
         from appointments where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;

    // The loser rolled back to CONFIRMED at its original time; both originals
    // plus the single replacement exist.
    expect(rows.filter((row) => row.appointment_status === "RESCHEDULED")).toHaveLength(1);
    expect(rows.filter((row) => row.appointment_status === "CONFIRMED")).toHaveLength(2);

    const replacements = rows.filter((row) => row.rescheduled_from_appointment_id !== null);
    expect(replacements).toHaveLength(1);
    expect(new Date(replacements[0].start_at).toISOString()).toBe(
      "2026-12-07T11:00:00.000Z",
    );
    // Two booking events + the winner's RESCHEDULED and CREATED events.
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(4);
  });

  it("rolls back the whole reschedule when event creation fails", async () => {
    const fixture = await createLifecycleFixture("reschedule-rollback");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);
    const trigger = await addFailureTrigger("appointment_events", fixture.tenantId);

    try {
      const failure = await rescheduleAppointment(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          startAt: SLOT_THIRD,
          idempotencyKey: "reschedule-rollback-key",
          now: FIXED_NOW,
        },
        staffActor(fixture),
      ).catch((error: unknown) => error);

      expect(deepestMessage(failure)).toMatch(/synthetic appointment_events failure/);
    } finally {
      await removeTemporaryTrigger(trigger);
    }

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status, start_at, rescheduled_from_appointment_id
         from appointments where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].appointment_status).toBe("CONFIRMED");
    expect(new Date(rows[0].start_at).toISOString()).toBe(SLOT_START);
    expect(rows[0].rescheduled_from_appointment_id).toBeNull();
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(1);
    expect(await countLifecycleRows("appointment_idempotency_keys", fixture.tenantId)).toBe(0);
  });
});

describe("rescheduling idempotency", () => {
  it("returns the same replacement for the same key and payload", async () => {
    const fixture = await createLifecycleFixture("reschedule-idempotent");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const input = {
      appointmentId: appointment.id,
      startAt: SLOT_THIRD,
      reason: "Doctor emergency",
      idempotencyKey: "reschedule-retry-key",
      now: FIXED_NOW,
    };

    const first = await rescheduleAppointment(fixture.tenantId, input, staffActor(fixture));
    const second = await rescheduleAppointment(fixture.tenantId, input, staffActor(fixture));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.replacement.id).toBe(first.replacement.id);
    expect(second.original.id).toBe(first.original.id);
    expect(second.replacement.appointmentCode).toBe(first.replacement.appointmentCode);

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status from appointments where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(3);
  });

  it("rejects the same key with a different payload", async () => {
    const fixture = await createLifecycleFixture("reschedule-idempotent-conflict");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await rescheduleAppointment(
      fixture.tenantId,
      {
        appointmentId: appointment.id,
        startAt: SLOT_THIRD,
        idempotencyKey: "reschedule-reused-key",
        now: FIXED_NOW,
      },
      staffActor(fixture),
    );

    await expect(
      rescheduleAppointment(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          startAt: "2026-12-07T11:00:00.000Z",
          idempotencyKey: "reschedule-reused-key",
          now: FIXED_NOW,
        },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status from appointments where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;
    expect(rows.filter((row) => row.appointment_status === "RESCHEDULED")).toHaveLength(1);
  });

  it("handles two concurrent identical requests with the same key", async () => {
    const fixture = await createLifecycleFixture("reschedule-idempotent-concurrent");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const input = {
      appointmentId: appointment.id,
      startAt: SLOT_THIRD,
      idempotencyKey: "reschedule-concurrent-key",
      now: FIXED_NOW,
    };

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        rescheduleAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        rescheduleAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const ids = results.map(
      (result) =>
        (result as PromiseFulfilledResult<{ replacement: { id: string } }>).value
          .replacement.id,
    );
    expect(new Set(ids).size).toBe(1);

    const rows = (
      await getTestAdminPool().query(
        `select rescheduled_from_appointment_id from appointments where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;
    expect(rows.filter((row) => row.rescheduled_from_appointment_id !== null)).toHaveLength(1);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(3);
  });
});
