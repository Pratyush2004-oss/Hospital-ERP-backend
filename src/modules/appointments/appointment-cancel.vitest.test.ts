import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { createAppointmentBooking } from "./appointment-booking.service.js";
import {
  cancelAppointment,
  cancelAppointmentInTransaction,
} from "./appointment-cancel.service.js";
import {
  FIXED_NOW,
  SLOT_START,
  SLOT_THIRD,
  addLifecycleSchedule,
  bookingInput,
  cleanupLifecycleFixtures,
  countLifecycleRows,
  createLifecycleFixture,
  inAppTransaction,
  insertAppointmentDirectly,
  otherTenantStaffActor,
  staffActor,
  type LifecycleFixture,
} from "./appointment-lifecycle.test-fixtures.js";
import { rescheduleAppointmentInTransaction } from "./appointment-reschedule.service.js";

/**
 * PostgreSQL integration tests for Phase 18.4 cancellation.
 *
 * Verifies the status transition rules, atomic event history, slot release,
 * authorization, tenant isolation, idempotent repeats and concurrency against a
 * real database and the restricted application role.
 */

async function book(fixture: LifecycleFixture, startAt = SLOT_START) {
  return createAppointmentBooking(
    fixture.tenantId,
    bookingInput(fixture, { startAt }),
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

describe("successful cancellation", () => {
  it("cancels the appointment, records who/why and writes one event", async () => {
    const fixture = await createLifecycleFixture("cancel-success");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const result = await cancelAppointment(
      fixture.tenantId,
      {
        appointmentId: appointment.id,
        cancellationReason: "Patient requested",
        idempotencyKey: "cancel-key-1",
      },
      staffActor(fixture),
    );

    expect(result.replayed).toBe(false);
    expect(result.appointment).toMatchObject({
      id: appointment.id,
      appointmentStatus: "CANCELLED",
      cancellationReason: "Patient requested",
      cancelledBy: fixture.staffUserId,
      appointmentCode: appointment.appointmentCode,
    });

    const [stored] = (
      await getTestAdminPool().query(
        `select appointment_status, cancellation_reason, cancelled_by
         from appointments where id = $1`,
        [appointment.id],
      )
    ).rows;

    expect(stored.appointment_status).toBe("CANCELLED");
    expect(stored.cancellation_reason).toBe("Patient requested");
    expect(stored.cancelled_by).toBe(fixture.staffUserId);

    const events = (
      await getTestAdminPool().query(
        `select event_type, previous_status, new_status, actor_user_id, metadata
         from appointment_events where appointment_id = $1 order by created_at`,
        [appointment.id],
      )
    ).rows;

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event_type: "CANCELLED",
      previous_status: "CONFIRMED",
      new_status: "CANCELLED",
      actor_user_id: fixture.staffUserId,
    });
    expect(events[1].metadata).toMatchObject({
      cancellationReason: "Patient requested",
      previousStartAt: SLOT_START,
    });

    const keys = (
      await getTestAdminPool().query(
        `select operation, status, appointment_id from appointment_idempotency_keys
         where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      operation: "appointment.cancel",
      status: "COMPLETED",
      appointment_id: appointment.id,
    });
  });

  it("releases the slot so it can be booked again", async () => {
    const fixture = await createLifecycleFixture("cancel-release");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await cancelAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, cancellationReason: "Patient unwell" },
      staffActor(fixture),
    );

    const rebooked = await book(fixture);

    expect(rebooked.appointmentStatus).toBe("CONFIRMED");
    expect(rebooked.id).not.toBe(appointment.id);
    expect(new Set([rebooked.appointmentCode, appointment.appointmentCode]).size).toBe(2);
  });

  it("lets a patient cancel their own appointment", async () => {
    const fixture = await createLifecycleFixture("cancel-self-service");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const result = await cancelAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, cancellationReason: "No longer needed" },
      { userId: fixture.patientUserId },
    );

    expect(result.appointment.appointmentStatus).toBe("CANCELLED");
    expect(result.appointment.cancelledBy).toBe(fixture.patientUserId);
  });
});

describe("cancellation eligibility", () => {
  it("treats a repeated cancellation as an idempotent no-op without duplicate events", async () => {
    const fixture = await createLifecycleFixture("cancel-repeat");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const first = await cancelAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, cancellationReason: "First reason" },
      staffActor(fixture),
    );
    const second = await cancelAppointment(
      fixture.tenantId,
      { appointmentId: appointment.id, cancellationReason: "Second reason" },
      staffActor(fixture),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);
    // The first cancellation is authoritative; the reason is not overwritten.
    expect(second.appointment.cancellationReason).toBe("First reason");

    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(2);
  });

  it("rejects cancelling a completed appointment", async () => {
    const fixture = await createLifecycleFixture("cancel-completed");
    await addLifecycleSchedule(fixture);
    const appointmentId = await insertAppointmentDirectly(fixture, {
      status: "COMPLETED",
    });

    await expect(
      cancelAppointment(
        fixture.tenantId,
        { appointmentId, cancellationReason: "Too late" },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "COMPLETED" },
    });
  });

  it("rejects cancelling an in-progress appointment", async () => {
    const fixture = await createLifecycleFixture("cancel-in-progress");
    await addLifecycleSchedule(fixture);
    const appointmentId = await insertAppointmentDirectly(fixture, {
      status: "IN_PROGRESS",
    });

    await expect(
      cancelAppointment(
        fixture.tenantId,
        { appointmentId, cancellationReason: "Consultation started" },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
      details: { currentStatus: "IN_PROGRESS" },
    });
  });

  it("requires a non-empty cancellation reason", async () => {
    const fixture = await createLifecycleFixture("cancel-reason");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      cancelAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, cancellationReason: "   " },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
  });

  it("rejects unauthorized callers and cross-tenant cancellations", async () => {
    const fixture = await createLifecycleFixture("cancel-auth");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await expect(
      cancelAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, cancellationReason: "Not allowed" },
        { userId: fixture.outsiderUserId, permissions: new Set(["appointment:cancel"]) },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      cancelAppointment(
        fixture.tenantId,
        { appointmentId: appointment.id, cancellationReason: "Not allowed" },
        { userId: fixture.staffUserId, permissions: new Set(["appointment:read"]) },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      cancelAppointment(
        fixture.otherTenantId,
        { appointmentId: appointment.id, cancellationReason: "Cross tenant" },
        otherTenantStaffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(1);
  });
});

describe("cancellation idempotency", () => {
  it("replays the same key and payload without a second event", async () => {
    const fixture = await createLifecycleFixture("cancel-idempotent");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const input = {
      appointmentId: appointment.id,
      cancellationReason: "Patient requested",
      idempotencyKey: "cancel-retry-key",
    };

    const first = await cancelAppointment(fixture.tenantId, input, staffActor(fixture));
    const second = await cancelAppointment(fixture.tenantId, input, staffActor(fixture));

    expect(second.replayed).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);
    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(2);
  });

  it("rejects the same key with a different payload", async () => {
    const fixture = await createLifecycleFixture("cancel-idempotent-conflict");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    await cancelAppointment(
      fixture.tenantId,
      {
        appointmentId: appointment.id,
        cancellationReason: "First payload",
        idempotencyKey: "cancel-reused-key",
      },
      staffActor(fixture),
    );

    await expect(
      cancelAppointment(
        fixture.tenantId,
        {
          appointmentId: appointment.id,
          cancellationReason: "Different payload",
          idempotencyKey: "cancel-reused-key",
        },
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("handles concurrent duplicate cancellation requests consistently", async () => {
    const fixture = await createLifecycleFixture("cancel-concurrent");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const input = {
      appointmentId: appointment.id,
      cancellationReason: "Double click",
      idempotencyKey: "cancel-concurrent-key",
    };

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        cancelAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        cancelAppointmentInTransaction(tx, fixture.tenantId, input, staffActor(fixture)),
      ),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const ids = results.map(
      (result) =>
        (result as PromiseFulfilledResult<{ appointment: { id: string } }>).value
          .appointment.id,
    );
    expect(new Set(ids).size).toBe(1);

    expect(await countLifecycleRows("appointment_events", fixture.tenantId)).toBe(2);
    expect(await countLifecycleRows("appointment_idempotency_keys", fixture.tenantId)).toBe(1);
  });
});

describe("cancellation and rescheduling race", () => {
  it("never applies both transitions to one appointment", async () => {
    const fixture = await createLifecycleFixture("cancel-reschedule-race");
    await addLifecycleSchedule(fixture);
    const appointment = await book(fixture);

    const results = await Promise.allSettled([
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        cancelAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id, cancellationReason: "Patient cancelled" },
          staffActor(fixture),
        ),
      ),
      inAppTransaction(fixture.tenantId, fixture.staffUserId, (tx) =>
        rescheduleAppointmentInTransaction(
          tx,
          fixture.tenantId,
          { appointmentId: appointment.id, startAt: SLOT_THIRD, now: FIXED_NOW },
          staffActor(fixture),
        ),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: "INVALID_STATUS_TRANSITION",
    });

    const rows = (
      await getTestAdminPool().query(
        `select appointment_status, cancellation_reason, rescheduled_from_appointment_id
         from appointments where tenant_id = $1 order by created_at`,
        [fixture.tenantId],
      )
    ).rows;

    const original = rows[0];
    const replacements = rows.filter(
      (row) => row.rescheduled_from_appointment_id !== null,
    );

    if (original.appointment_status === "CANCELLED") {
      expect(original.cancellation_reason).toBe("Patient cancelled");
      expect(replacements).toHaveLength(0);
    } else {
      expect(original.appointment_status).toBe("RESCHEDULED");
      expect(original.cancellation_reason).toBeNull();
      expect(replacements).toHaveLength(1);
    }
  });
});
