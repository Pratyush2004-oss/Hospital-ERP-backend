import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../database/connection.js";
import * as schema from "../../database/schema/index.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import {
  bookAppointmentInTransaction,
  createAppointmentBooking,
} from "./appointment-booking.service.js";
import type {
  AppointmentBookingActorContext,
  CreateAppointmentBookingInput,
} from "./appointment-booking.types.js";

/**
 * Integration tests for Phase 18.3 appointment booking.
 *
 * Fixtures are written with the admin connection; the service runs as the
 * restricted `hospitalos_app` role with forced RLS. Concurrency tests use a
 * dedicated app-role pool (the shared test pool is capped at one connection)
 * plus a temporary `pg_sleep` trigger on `appointments`, so both transactions
 * are guaranteed to pass the availability pre-check before either inserts. That
 * is what proves the GiST exclusion constraint, not an application check, is
 * the double-booking guard.
 */

interface Fixture {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly branchId: string;
  readonly inactiveBranchId: string;
  readonly otherTenantBranchId: string;
  readonly doctorId: string;
  readonly secondDoctorId: string;
  readonly inactiveDoctorId: string;
  readonly otherTenantDoctorId: string;
  readonly patientId: string;
  readonly inactivePatientId: string;
  readonly otherTenantPatientId: string;
  readonly departmentId: string;
  readonly inactiveDepartmentId: string;
  readonly staffUserId: string;
  readonly patientUserId: string;
  readonly outsiderUserId: string;
  readonly otherTenantStaffUserId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

const FIXED_NOW = new Date("2026-12-01T00:00:00.000Z");
/** Monday 2026-12-07 09:00 Europe/London (GMT in December). */
const SLOT_START = "2026-12-07T09:00:00.000Z";
const SLOT_END = "2026-12-07T09:30:00.000Z";

let concurrencyPool: Pool | null = null;
let concurrencyDb: NodePgDatabase<typeof schema> | null = null;

function getConcurrencyDb(): NodePgDatabase<typeof schema> {
  concurrencyPool ??= new Pool({
    connectionString: testAppDatabaseUrl(),
    max: 3,
    application_name: "hospitalos-booking-concurrency-test",
  });
  concurrencyDb ??= drizzle(concurrencyPool, { schema });
  return concurrencyDb;
}

interface TempDbObject {
  readonly functionName: string;
  readonly triggerName: string;
  readonly table: "appointments" | "appointment_events";
}

const temporaryObjects: TempDbObject[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const branchId = randomUUID();
  const inactiveBranchId = randomUUID();
  const otherTenantBranchId = randomUUID();
  const doctorId = randomUUID();
  const secondDoctorId = randomUUID();
  const inactiveDoctorId = randomUUID();
  const otherTenantDoctorId = randomUUID();
  const patientId = randomUUID();
  const inactivePatientId = randomUUID();
  const otherTenantPatientId = randomUUID();
  const departmentId = randomUUID();
  const inactiveDepartmentId = randomUUID();
  const staffUserId = randomUUID();
  const patientUserId = randomUUID();
  const outsiderUserId = randomUUID();
  const otherTenantStaffUserId = randomUUID();
  const doctorUserId = randomUUID();
  const secondDoctorUserId = randomUUID();
  const inactiveDoctorUserId = randomUUID();
  const otherTenantDoctorUserId = randomUUID();

  await pool.query(
    `insert into tenants (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
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
     values ($1,$2,'Central',$3,'Europe/London',true),
            ($4,$2,'Closed',$5,'Europe/London',false),
            ($6,$7,'Other Central',$8,'UTC',true)`,
    [
      branchId,
      tenantId,
      `CEN-${suffix}`,
      inactiveBranchId,
      `CLO-${suffix}`,
      otherTenantBranchId,
      otherTenantId,
      `OTH-${suffix}`,
    ],
  );

  const userRows = [
    [staffUserId, `${label} Receptionist`, `reception-${label}-${suffix}@booking.test`],
    [patientUserId, `${label} Patient Account`, `patient-${label}-${suffix}@booking.test`],
    [outsiderUserId, `${label} Outsider`, `outsider-${label}-${suffix}@booking.test`],
    [
      otherTenantStaffUserId,
      `${label} Other Receptionist`,
      `other-reception-${label}-${suffix}@booking.test`,
    ],
    [doctorUserId, `${label} Doctor`, `doctor-${label}-${suffix}@booking.test`],
    [
      secondDoctorUserId,
      `${label} Second Doctor`,
      `second-doctor-${label}-${suffix}@booking.test`,
    ],
    [
      inactiveDoctorUserId,
      `${label} Inactive Doctor`,
      `inactive-doctor-${label}-${suffix}@booking.test`,
    ],
    [
      otherTenantDoctorUserId,
      `${label} Other Doctor`,
      `other-doctor-${label}-${suffix}@booking.test`,
    ],
  ] as const;

  for (const [id, fullName, email] of userRows) {
    await pool.query(
      `insert into users (id, full_name, email, password_hash)
       values ($1,$2,$3,'booking-test-hash')`,
      [id, fullName, email],
    );
    createdUserIds.push(id);
  }

  const doctorRows = [
    [doctorId, tenantId, doctorUserId, `DOC-${suffix}`, `REG-${suffix}`, true],
    [
      secondDoctorId,
      tenantId,
      secondDoctorUserId,
      `DOC2-${suffix}`,
      `REG2-${suffix}`,
      true,
    ],
    [
      inactiveDoctorId,
      tenantId,
      inactiveDoctorUserId,
      `DOC-IN-${suffix}`,
      `REG-IN-${suffix}`,
      false,
    ],
    [
      otherTenantDoctorId,
      otherTenantId,
      otherTenantDoctorUserId,
      `DOC-OTH-${suffix}`,
      `REG-OTH-${suffix}`,
      true,
    ],
  ] as const;

  for (const [id, tenant, userId, doctorCode, registrationNumber, isActive] of doctorRows) {
    await pool.query(
      `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number, is_active)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, tenant, userId, doctorCode, registrationNumber, isActive],
    );
  }

  const assignmentRows = [
    [tenantId, doctorId, branchId, "150.00", "GBP"],
    [tenantId, secondDoctorId, branchId, "120.00", "GBP"],
    [tenantId, inactiveDoctorId, branchId, "90.00", "GBP"],
    [otherTenantId, otherTenantDoctorId, otherTenantBranchId, "80.00", "USD"],
  ] as const;

  for (const [tenant, doctor, branch, fee, currency] of assignmentRows) {
    await pool.query(
      `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, currency, is_active)
       values ($1,$2,$3,$4,$5,true)`,
      [tenant, doctor, branch, fee, currency],
    );
  }

  await pool.query(
    `insert into patient_profiles (id, tenant_id, user_id, patient_code, full_name, status)
     values ($1,$4,$5,$6,$7,'ACTIVE'),
            ($2,$4,null,$8,$9,'INACTIVE'),
            ($3,$10,null,$11,$12,'ACTIVE')`,
    [
      patientId,
      inactivePatientId,
      otherTenantPatientId,
      tenantId,
      patientUserId,
      `MRN-${suffix}`,
      `Synthetic Patient ${suffix}`,
      `MRN-IN-${suffix}`,
      `Synthetic Inactive Patient ${suffix}`,
      otherTenantId,
      `MRN-OTH-${suffix}`,
      `Synthetic Other Patient ${suffix}`,
    ],
  );

  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1,$2,'ACTIVE', now()), ($3,$4,'ACTIVE', now())`,
    [tenantId, staffUserId, otherTenantId, otherTenantStaffUserId],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug, is_active)
     values ($1,$2,$3,'Cardiology',$4,true), ($5,$2,$3,'Closed Unit',$6,false)`,
    [
      departmentId,
      tenantId,
      branchId,
      `cardiology-${suffix}`,
      inactiveDepartmentId,
      `closed-${suffix}`,
    ],
  );

  const fixture: Fixture = {
    tenantId,
    otherTenantId,
    branchId,
    inactiveBranchId,
    otherTenantBranchId,
    doctorId,
    secondDoctorId,
    inactiveDoctorId,
    otherTenantDoctorId,
    patientId,
    inactivePatientId,
    otherTenantPatientId,
    departmentId,
    inactiveDepartmentId,
    staffUserId,
    patientUserId,
    outsiderUserId,
    otherTenantStaffUserId,
  };

  fixtures.push(fixture);
  return fixture;
}

interface ScheduleOverrides {
  readonly tenantId?: string;
  readonly doctorId?: string;
  readonly branchId?: string;
  readonly dayOfWeek?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly slotDurationMinutes?: number;
  readonly bufferMinutes?: number;
  readonly effectiveFrom?: string;
}

async function addSchedule(
  fixture: Fixture,
  overrides: ScheduleOverrides = {},
): Promise<string> {
  const scheduleId = randomUUID();

  await getTestAdminPool().query(
    `insert into doctor_schedules
       (id, tenant_id, doctor_id, branch_id, day_of_week, start_time, end_time,
        slot_duration_minutes, buffer_minutes, effective_from, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
    [
      scheduleId,
      overrides.tenantId ?? fixture.tenantId,
      overrides.doctorId ?? fixture.doctorId,
      overrides.branchId ?? fixture.branchId,
      overrides.dayOfWeek ?? 1,
      overrides.startTime ?? "09:00:00",
      overrides.endTime ?? "12:00:00",
      overrides.slotDurationMinutes ?? 30,
      overrides.bufferMinutes ?? 0,
      overrides.effectiveFrom ?? "2026-01-01",
    ],
  );

  return scheduleId;
}

async function addBreak(
  fixture: Fixture,
  scheduleId: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  await getTestAdminPool().query(
    `insert into doctor_breaks (tenant_id, schedule_id, start_time, end_time)
     values ($1,$2,$3,$4)`,
    [fixture.tenantId, scheduleId, startTime, endTime],
  );
}

async function addApprovedLeave(
  fixture: Fixture,
  startAt: string,
  endAt: string,
): Promise<void> {
  await getTestAdminPool().query(
    `insert into doctor_leaves
       (tenant_id, doctor_id, branch_id, start_at, end_at, reason, status,
        created_by, approved_by, approved_at)
     values ($1,$2,$3,$4,$5,'Synthetic leave','APPROVED',$6,$6, now())`,
    [fixture.tenantId, fixture.doctorId, fixture.branchId, startAt, endAt, fixture.staffUserId],
  );
}

function staffActor(fixture: Fixture): AppointmentBookingActorContext {
  return {
    userId: fixture.staffUserId,
    permissions: new Set(["appointment:create", "appointment:read"]),
  };
}

function otherTenantStaffActor(fixture: Fixture): AppointmentBookingActorContext {
  return {
    userId: fixture.otherTenantStaffUserId,
    permissions: new Set(["appointment:create", "appointment:read"]),
  };
}

function bookingInput(
  fixture: Fixture,
  overrides: Partial<CreateAppointmentBookingInput> = {},
): CreateAppointmentBookingInput {
  return {
    patientId: fixture.patientId,
    doctorId: fixture.doctorId,
    branchId: fixture.branchId,
    startAt: SLOT_START,
    now: FIXED_NOW,
    appointmentSource: "RECEPTIONIST",
    ...overrides,
  };
}

function deepestMessage(error: unknown): string {
  let message = "";
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };

    if (typeof candidate.message === "string") message = candidate.message;
    current = candidate.cause;
  }

  return message;
}

async function countRows(
  table: "appointments" | "appointment_events" | "appointment_idempotency_keys",
  tenantId: string,
): Promise<number> {
  const { rows } = await getTestAdminPool().query(
    `select count(*)::int as count from ${table} where tenant_id = $1`,
    [tenantId],
  );

  return rows[0].count as number;
}

/**
 * Runs the booking service in its own app-role transaction on the dedicated
 * pool, so two calls really are two concurrent PostgreSQL transactions.
 */
async function bookInOwnTransaction(
  tenantId: string,
  input: CreateAppointmentBookingInput,
  actor: AppointmentBookingActorContext,
) {
  const db = getConcurrencyDb();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.current_user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select set_config('app.is_platform', 'false', true)`);

    return bookAppointmentInTransaction(tx, tenantId, input, actor);
  });
}

async function dropTemporaryObject(object: TempDbObject): Promise<void> {
  const index = temporaryObjects.indexOf(object);
  if (index >= 0) temporaryObjects.splice(index, 1);

  const pool = getTestAdminPool();
  await pool.query(
    `drop trigger if exists ${object.triggerName} on ${object.table}`,
  );
  await pool.query(`drop function if exists ${object.functionName}()`);
}

/**
 * Delays every appointment insert for one tenant, guaranteeing that two
 * concurrent bookings both pass the availability pre-check before either row is
 * written.
 */
async function addInsertDelayTrigger(
  tenantId: string,
  seconds: number,
): Promise<TempDbObject> {
  const pool = getTestAdminPool();
  const functionName = `test_booking_delay_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const triggerName = `${functionName}_trg`;

  await pool.query(`
    create function ${functionName}() returns trigger language plpgsql as $fn$
    begin
      if new.tenant_id = '${tenantId}'::uuid then
        perform pg_sleep(${seconds});
      end if;
      return new;
    end
    $fn$;
  `);

  await pool.query(
    `create trigger ${triggerName} before insert on appointments
     for each row execute function ${functionName}()`,
  );

  const object: TempDbObject = {
    functionName,
    triggerName,
    table: "appointments",
  };
  temporaryObjects.push(object);
  return object;
}

/** Forces a database failure on insert for one tenant, to prove rollback. */
async function addFailureTrigger(
  table: "appointments" | "appointment_events",
  tenantId: string,
): Promise<TempDbObject> {
  const pool = getTestAdminPool();
  const functionName = `test_booking_fail_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const triggerName = `${functionName}_trg`;

  await pool.query(`
    create function ${functionName}() returns trigger language plpgsql as $fn$
    begin
      if new.tenant_id = '${tenantId}'::uuid then
        raise exception 'synthetic ${table} failure' using errcode = 'P0001';
      end if;
      return new;
    end
    $fn$;
  `);

  await pool.query(
    `create trigger ${triggerName} before insert on ${table}
     for each row execute function ${functionName}()`,
  );

  const object: TempDbObject = { functionName, triggerName, table };
  temporaryObjects.push(object);
  return object;
}

beforeAll(async () => {
  await getTestAdminPool().query("select 1");
});

afterAll(async () => {
  while (temporaryObjects.length > 0) {
    const object = temporaryObjects[temporaryObjects.length - 1];
    if (object) await dropTemporaryObject(object);
  }

  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    await pool.query("delete from tenants where id = any($1::uuid[])", [
      [fixture.tenantId, fixture.otherTenantId],
    ]);
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  if (concurrencyPool) {
    const instance = concurrencyPool;
    concurrencyPool = null;
    concurrencyDb = null;
    await instance.end();
  }

  await closeTestAdminPool();
  await closePool();
});

describe("successful booking", () => {
  it("reserves the slot, stores CONFIRMED status and records the CREATED event", async () => {
    const fixture = await createFixture("book-success");
    await addSchedule(fixture);

    const booking = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture),
      staffActor(fixture),
    );

    expect(booking).toMatchObject({
      patientId: fixture.patientId,
      doctorId: fixture.doctorId,
      branchId: fixture.branchId,
      departmentId: null,
      appointmentSource: "RECEPTIONIST",
      appointmentType: "CONSULTATION",
      appointmentStatus: "CONFIRMED",
      durationMinutes: 30,
      consultationFee: "150.00",
      currency: "GBP",
      branchTimezone: "Europe/London",
      createdBy: fixture.staffUserId,
      replayed: false,
    });
    expect(booking.appointmentCode).toMatch(/^APT-\d{8}-[0-9A-F]{8}$/);
    expect(booking.startAt.toISOString()).toBe(SLOT_START);
    expect(booking.endAt.toISOString()).toBe(SLOT_END);

    const [stored] = (
      await getTestAdminPool().query(
        "select appointment_status, start_at, end_at from appointments where id = $1",
        [booking.id],
      )
    ).rows;

    expect(stored.appointment_status).toBe("CONFIRMED");
    expect(new Date(stored.start_at).toISOString()).toBe(SLOT_START);
    expect(new Date(stored.end_at).toISOString()).toBe(SLOT_END);

    const events = (
      await getTestAdminPool().query(
        `select event_type, previous_status, new_status, actor_user_id, metadata
         from appointment_events where appointment_id = $1`,
        [booking.id],
      )
    ).rows;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "CREATED",
      previous_status: null,
      new_status: "CONFIRMED",
      actor_user_id: fixture.staffUserId,
    });
    expect(events[0].metadata).toMatchObject({
      appointmentCode: booking.appointmentCode,
      appointmentSource: "RECEPTIONIST",
      durationMinutes: 30,
      startAt: SLOT_START,
      endAt: SLOT_END,
    });
  });

  it("stores the requested department and ignores no client-supplied money fields", async () => {
    const fixture = await createFixture("book-department");
    await addSchedule(fixture);

    const booking = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { departmentId: fixture.departmentId, appointmentType: "FOLLOW_UP" }),
      staffActor(fixture),
    );

    expect(booking.departmentId).toBe(fixture.departmentId);
    expect(booking.appointmentType).toBe("FOLLOW_UP");
    // Authoritative server-side values from doctor_branches.
    expect(booking.consultationFee).toBe("150.00");
    expect(booking.currency).toBe("GBP");
  });

  it("lets a patient book their own profile without a hospital membership", async () => {
    const fixture = await createFixture("book-self-service");
    await addSchedule(fixture);

    const booking = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { appointmentSource: undefined }),
      { userId: fixture.patientUserId },
    );

    expect(booking.appointmentSource).toBe("ONLINE");
    expect(booking.createdBy).toBe(fixture.patientUserId);
  });
});

describe("authorization and references", () => {
  it("rejects unknown patient, doctor and branch references", async () => {
    const fixture = await createFixture("book-invalid-refs");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { patientId: randomUUID() }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { doctorId: randomUUID() }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { branchId: randomUUID() }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { departmentId: randomUUID() }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("rejects an inactive patient", async () => {
    const fixture = await createFixture("book-inactive-patient");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { patientId: fixture.inactivePatientId }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
  });

  it("rejects an inactive doctor and an inactive branch", async () => {
    const fixture = await createFixture("book-inactive-resources");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { doctorId: fixture.inactiveDoctorId }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { branchId: fixture.inactiveBranchId }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
  });

  it("rejects callers who are neither the patient nor active staff with the permission", async () => {
    const fixture = await createFixture("book-authorization");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(fixture.tenantId, bookingInput(fixture), {
        userId: fixture.outsiderUserId,
        permissions: new Set(["appointment:create"]),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      createAppointmentBooking(fixture.tenantId, bookingInput(fixture), {
        userId: fixture.staffUserId,
        permissions: new Set(["appointment:read"]),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rejects assignments to another tenant and unknown doctor-branch pairs", async () => {
    const fixture = await createFixture("book-cross-tenant");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, {
          doctorId: fixture.otherTenantDoctorId,
          branchId: fixture.otherTenantBranchId,
        }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { branchId: fixture.otherTenantBranchId }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // A tenant-B caller cannot book tenant A's patient.
    await expect(
      createAppointmentBooking(
        fixture.otherTenantId,
        bookingInput(fixture, {
          patientId: fixture.otherTenantPatientId,
          doctorId: fixture.doctorId,
          branchId: fixture.branchId,
        }),
        otherTenantStaffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await countRows("appointments", fixture.tenantId)).toBe(0);
    expect(await countRows("appointments", fixture.otherTenantId)).toBe(0);
  });
});

describe("schedule and slot validation", () => {
  it("rejects a day without a schedule and a start outside the working window", async () => {
    const fixture = await createFixture("book-schedule");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { startAt: "2026-12-08T09:00:00.000Z" }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "NO_SCHEDULE" },
    });

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { startAt: "2026-12-07T07:00:00.000Z" }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "OUTSIDE_SCHEDULE" },
    });
  });

  it("validates the appointment duration against the request and the window", async () => {
    const fixture = await createFixture("book-duration");
    await addSchedule(fixture);

    for (const durationMinutes of [0, 4, 481, 600]) {
      await expect(
        createAppointmentBooking(
          fixture.tenantId,
          bookingInput(fixture, { durationMinutes }),
          staffActor(fixture),
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
    }

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { startAt: "2026-12-07T11:30:00.000Z", durationMinutes: 60 }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "DURATION_DOES_NOT_FIT" },
    });

    // A valid override is honoured and used for the stored interval.
    const booked = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { durationMinutes: 45 }),
      staffActor(fixture),
    );
    expect(booked.durationMinutes).toBe(45);
    expect(booked.endAt.toISOString()).toBe("2026-12-07T09:45:00.000Z");
  });

  it("rejects a booking inside a doctor break", async () => {
    const fixture = await createFixture("book-break");
    const scheduleId = await addSchedule(fixture);
    await addBreak(fixture, scheduleId, "10:00:00", "10:15:00");

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { startAt: "2026-12-07T10:00:00.000Z" }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "BREAK" },
    });

    expect(await countRows("appointments", fixture.tenantId)).toBe(0);
  });

  it("rejects a booking during approved leave", async () => {
    const fixture = await createFixture("book-leave");
    await addSchedule(fixture);
    await addApprovedLeave(
      fixture,
      "2026-12-07T09:00:00.000Z",
      "2026-12-07T12:00:00.000Z",
    );

    await expect(
      createAppointmentBooking(fixture.tenantId, bookingInput(fixture), staffActor(fixture)),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "LEAVE" },
    });
  });

  it("rejects a booking in the past", async () => {
    const fixture = await createFixture("book-past");
    await addSchedule(fixture);

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { now: new Date("2026-12-07T09:30:00.000Z") }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "PAST" },
    });
  });

  it("rejects an already reserved slot", async () => {
    const fixture = await createFixture("book-taken");
    await addSchedule(fixture);

    const first = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture),
      staffActor(fixture),
    );

    await expect(
      createAppointmentBooking(fixture.tenantId, bookingInput(fixture), staffActor(fixture)),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SLOT_UNAVAILABLE",
      details: { reason: "OCCUPIED" },
    });

    expect(await countRows("appointments", fixture.tenantId)).toBe(1);
    expect(first.appointmentStatus).toBe("CONFIRMED");
  });
});

describe("concurrency", () => {
  it("allows exactly one of two concurrent bookings for the same slot", async () => {
    const fixture = await createFixture("book-concurrent-same");
    await addSchedule(fixture);
    const delay = await addInsertDelayTrigger(fixture.tenantId, 0.4);

    try {
      const results = await Promise.allSettled([
        bookInOwnTransaction(fixture.tenantId, bookingInput(fixture), staffActor(fixture)),
        bookInOwnTransaction(fixture.tenantId, bookingInput(fixture), staffActor(fixture)),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const reason = (rejected[0] as PromiseRejectedResult).reason as {
        statusCode?: number;
        code?: string;
      };
      expect(reason.statusCode).toBe(409);
      expect(reason.code).toBe("SLOT_UNAVAILABLE");

      // The exclusion constraint, not the pre-check, is the final guard: both
      // transactions reached the insert because the trigger delayed them.
      expect(await countRows("appointments", fixture.tenantId)).toBe(1);
      expect(await countRows("appointment_events", fixture.tenantId)).toBe(1);
    } finally {
      await dropTemporaryObject(delay);
    }
  });

  it("allows concurrent bookings for different doctors at the same instant", async () => {
    const fixture = await createFixture("book-concurrent-different");
    await addSchedule(fixture);
    await addSchedule(fixture, { doctorId: fixture.secondDoctorId });
    const delay = await addInsertDelayTrigger(fixture.tenantId, 0.3);

    try {
      const results = await Promise.allSettled([
        bookInOwnTransaction(
          fixture.tenantId,
          bookingInput(fixture),
          staffActor(fixture),
        ),
        bookInOwnTransaction(
          fixture.tenantId,
          bookingInput(fixture, { doctorId: fixture.secondDoctorId }),
          staffActor(fixture),
        ),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);

      const codes = results.map(
        (result) => (result as PromiseFulfilledResult<{ appointmentCode: string }>).value
          .appointmentCode,
      );
      expect(new Set(codes).size).toBe(2);
      expect(await countRows("appointments", fixture.tenantId)).toBe(2);
    } finally {
      await dropTemporaryObject(delay);
    }
  });
});

describe("idempotency", () => {
  it("returns the original appointment for the same key and payload", async () => {
    const fixture = await createFixture("book-idempotent");
    await addSchedule(fixture);
    const input = bookingInput(fixture, { idempotencyKey: "booking-retry-key-001" });

    const first = await createAppointmentBooking(fixture.tenantId, input, staffActor(fixture));
    const second = await createAppointmentBooking(fixture.tenantId, input, staffActor(fixture));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.appointmentCode).toBe(first.appointmentCode);

    expect(await countRows("appointments", fixture.tenantId)).toBe(1);
    expect(await countRows("appointment_events", fixture.tenantId)).toBe(1);

    const keys = (
      await getTestAdminPool().query(
        `select status, request_hash, appointment_id, operation
         from appointment_idempotency_keys where tenant_id = $1`,
        [fixture.tenantId],
      )
    ).rows;

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      status: "COMPLETED",
      appointment_id: first.id,
      operation: "appointment.create",
    });
    expect(keys[0].request_hash).toHaveLength(64);
  });

  it("rejects reuse of the same key with a different payload", async () => {
    const fixture = await createFixture("book-idempotent-conflict");
    await addSchedule(fixture);

    await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { idempotencyKey: "booking-retry-key-002" }),
      staffActor(fixture),
    );

    await expect(
      createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, {
          idempotencyKey: "booking-retry-key-002",
          startAt: "2026-12-07T10:00:00.000Z",
        }),
        staffActor(fixture),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    expect(await countRows("appointments", fixture.tenantId)).toBe(1);
  });

  it("scopes idempotency keys per tenant", async () => {
    const fixture = await createFixture("book-idempotent-tenant");
    await addSchedule(fixture);
    await addSchedule(fixture, {
      tenantId: fixture.otherTenantId,
      doctorId: fixture.otherTenantDoctorId,
      branchId: fixture.otherTenantBranchId,
    });

    const idempotencyKey = "shared-retry-key";

    const ownTenant = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { idempotencyKey }),
      staffActor(fixture),
    );

    // The other tenant has its own doctor, branch and patient at its own time.
    const otherTenant = await createAppointmentBooking(
      fixture.otherTenantId,
      {
        patientId: fixture.otherTenantPatientId,
        doctorId: fixture.otherTenantDoctorId,
        branchId: fixture.otherTenantBranchId,
        startAt: SLOT_START,
        now: FIXED_NOW,
        appointmentSource: "RECEPTIONIST",
        idempotencyKey,
      },
      otherTenantStaffActor(fixture),
    );

    expect(otherTenant.id).not.toBe(ownTenant.id);
    expect(await countRows("appointment_idempotency_keys", fixture.tenantId)).toBe(1);
    expect(await countRows("appointment_idempotency_keys", fixture.otherTenantId)).toBe(1);
  });
});

describe("transaction rollback", () => {
  it("rolls back the appointment and idempotency key when event creation fails", async () => {
    const fixture = await createFixture("book-rollback-event");
    await addSchedule(fixture);
    const trigger = await addFailureTrigger("appointment_events", fixture.tenantId);

    try {
      const failure = await createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { idempotencyKey: "rollback-event-key" }),
        staffActor(fixture),
      ).catch((error: unknown) => error);

      expect(deepestMessage(failure)).toMatch(/synthetic appointment_events failure/);

      expect(await countRows("appointments", fixture.tenantId)).toBe(0);
      expect(await countRows("appointment_events", fixture.tenantId)).toBe(0);
      expect(await countRows("appointment_idempotency_keys", fixture.tenantId)).toBe(0);
    } finally {
      await dropTemporaryObject(trigger);
    }

    // After the trigger is gone the same slot and key are still usable.
    const booking = await createAppointmentBooking(
      fixture.tenantId,
      bookingInput(fixture, { idempotencyKey: "rollback-event-key" }),
      staffActor(fixture),
    );
    expect(booking.appointmentStatus).toBe("CONFIRMED");
    expect(await countRows("appointments", fixture.tenantId)).toBe(1);
  });

  it("rolls back when appointment creation fails", async () => {
    const fixture = await createFixture("book-rollback-appointment");
    await addSchedule(fixture);
    const trigger = await addFailureTrigger("appointments", fixture.tenantId);

    try {
      const failure = await createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { idempotencyKey: "rollback-appointment-key" }),
        staffActor(fixture),
      ).catch((error: unknown) => error);

      expect(deepestMessage(failure)).toMatch(/synthetic appointments failure/);

      expect(await countRows("appointments", fixture.tenantId)).toBe(0);
      expect(await countRows("appointment_events", fixture.tenantId)).toBe(0);
      expect(await countRows("appointment_idempotency_keys", fixture.tenantId)).toBe(0);
    } finally {
      await dropTemporaryObject(trigger);
    }
  });
});

describe("appointment codes", () => {
  it("generates a unique operational code for every booking", async () => {
    const fixture = await createFixture("book-codes");
    await addSchedule(fixture);

    const starts = [
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ].map((time) => `2026-12-07T${time}:00.000Z`);

    const codes: string[] = [];

    for (const startAt of starts) {
      const booking = await createAppointmentBooking(
        fixture.tenantId,
        bookingInput(fixture, { startAt }),
        staffActor(fixture),
      );
      expect(booking.appointmentCode).toMatch(/^APT-20261207-[0-9A-F]{8}$/);
      codes.push(booking.appointmentCode);
    }

    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);

    const stored = (
      await getTestAdminPool().query(
        "select appointment_code from appointments where tenant_id = $1",
        [fixture.tenantId],
      )
    ).rows.map((row) => row.appointment_code as string);

    expect(new Set(stored).size).toBe(stored.length);
  });
});
