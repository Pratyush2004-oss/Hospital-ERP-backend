import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { closePool } from "../connection.js";
import { withTenantTransaction } from "../context.js";
import {
  appointmentEvents,
  appointmentIdempotencyKeys,
  appointments,
} from "./index.js";
import type { NewAppointment } from "./appointments.js";

/**
 * Schema-level tests for Phase 18.1 (appointment management schema).
 *
 * Fixtures are created with the admin connection; every appointment write runs
 * through `withTenantTransaction`, i.e. as the restricted `hospitalos_app` role
 * under the same RLS policies production uses. No real patient data is used:
 * names and codes are randomised per fixture and never resemble real records.
 */

interface Fixture {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly branchC: string;
  readonly otherBranch: string;
  readonly doctorA: string;
  readonly doctorA2: string;
  readonly doctorB: string;
  readonly patientA: string;
  readonly patientB: string;
  readonly departmentA: string;
  readonly departmentB: string;
  readonly creatorId: string;
}

const fixtures: Fixture[] = [];
const createdUserIds: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const branchC = randomUUID();
  const otherBranch = randomUUID();
  const creatorId = randomUUID();
  const doctorUserId = randomUUID();
  const secondDoctorUserId = randomUUID();
  const otherDoctorUserId = randomUUID();
  const doctorA = randomUUID();
  const doctorA2 = randomUUID();
  const doctorB = randomUUID();
  const patientA = randomUUID();
  const patientB = randomUUID();
  const departmentA = randomUUID();
  const departmentB = randomUUID();

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
    `insert into branches (id, tenant_id, name, branch_code, timezone)
     values ($1, $5, 'Central', $6, 'Asia/Kolkata'),
            ($2, $5, 'Riverside', $7, 'Europe/London'),
            ($3, $5, 'Unassigned', $8, 'America/New_York'),
            ($4, $9, 'Other Central', $10, 'UTC')`,
    [
      branchA,
      branchB,
      branchC,
      otherBranch,
      tenantId,
      `CEN-${suffix}`,
      `RIV-${suffix}`,
      `UNA-${suffix}`,
      otherTenantId,
      `OTH-${suffix}`,
    ],
  );

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1, $2, $3, 'appointment-schema-test-hash'),
            ($4, $5, $6, 'appointment-schema-test-hash'),
            ($7, $8, $9, 'appointment-schema-test-hash'),
            ($10, $11, $12, 'appointment-schema-test-hash')`,
    [
      creatorId,
      `${label} Receptionist`,
      `reception-${label}-${suffix}@appointment-schema.test`,
      doctorUserId,
      `${label} Doctor One`,
      `doctor-one-${label}-${suffix}@appointment-schema.test`,
      secondDoctorUserId,
      `${label} Doctor Two`,
      `doctor-two-${label}-${suffix}@appointment-schema.test`,
      otherDoctorUserId,
      `${label} Other Doctor`,
      `other-doctor-${label}-${suffix}@appointment-schema.test`,
    ],
  );
  createdUserIds.push(creatorId, doctorUserId, secondDoctorUserId, otherDoctorUserId);

  await pool.query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number)
     values ($1, $2, $3, $4, $5),
            ($6, $2, $7, $8, $9),
            ($10, $11, $12, $13, $14)`,
    [
      doctorA,
      tenantId,
      doctorUserId,
      `DOC-A-${suffix}`,
      `REG-A-${suffix}`,
      doctorA2,
      secondDoctorUserId,
      `DOC-A2-${suffix}`,
      `REG-A2-${suffix}`,
      doctorB,
      otherTenantId,
      otherDoctorUserId,
      `DOC-B-${suffix}`,
      `REG-B-${suffix}`,
    ],
  );

  // doctorA works at Central and Riverside, doctorA2 only at Central. The
  // "Unassigned" branch deliberately has no assignment.
  await pool.query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id)
     values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3), ($6, $7, $8)`,
    [tenantId, doctorA, branchA, branchB, doctorA2, otherTenantId, doctorB, otherBranch],
  );

  await pool.query(
    `insert into patient_profiles (id, tenant_id, patient_code, full_name)
     values ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      patientA,
      tenantId,
      `MRN-A-${suffix}`,
      `Synthetic Patient ${suffix}`,
      patientB,
      otherTenantId,
      `MRN-B-${suffix}`,
      `Other Synthetic Patient ${suffix}`,
    ],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug)
     values ($1, $2, $3, 'Cardiology', $4), ($5, $6, $7, 'Cardiology', $8)`,
    [
      departmentA,
      tenantId,
      branchA,
      `cardiology-${suffix}`,
      departmentB,
      otherTenantId,
      otherBranch,
      `cardiology-${suffix}`,
    ],
  );

  const fixture: Fixture = {
    tenantId,
    otherTenantId,
    branchA,
    branchB,
    branchC,
    otherBranch,
    doctorA,
    doctorA2,
    doctorB,
    patientA,
    patientB,
    departmentA,
    departmentB,
    creatorId,
  };
  fixtures.push(fixture);
  return fixture;
}

/** December 2026 slot; `day` keeps unrelated tests in separate calendar days. */
function slot(day: number, hour: number, minute = 0, durationMinutes = 30) {
  const startAt = new Date(Date.UTC(2026, 11, day, hour, minute));
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
  return { startAt, endAt };
}

function appointmentValues(
  fixture: Fixture,
  overrides: Partial<NewAppointment> = {},
): NewAppointment {
  const { startAt, endAt } = slot(1, 9);

  return {
    tenantId: fixture.tenantId,
    patientId: fixture.patientA,
    doctorId: fixture.doctorA,
    branchId: fixture.branchA,
    departmentId: null,
    appointmentCode: `APT-${randomUUID().slice(0, 8).toUpperCase()}`,
    appointmentSource: "ONLINE",
    startAt,
    endAt,
    createdBy: fixture.creatorId,
    ...overrides,
  };
}

/** The same fixture viewed from its second tenant's side. */
function asOtherTenant(fixture: Fixture): Fixture {
  return {
    ...fixture,
    tenantId: fixture.otherTenantId,
    otherTenantId: fixture.tenantId,
    patientA: fixture.patientB,
    doctorA: fixture.doctorB,
    branchA: fixture.otherBranch,
    departmentA: fixture.departmentB,
  };
}

function insertAppointment(fixture: Fixture, overrides: Partial<NewAppointment> = {}) {
  return withTenantTransaction(fixture.tenantId, (tx) =>
    tx.insert(appointments).values(appointmentValues(fixture, overrides)).returning(),
  );
}

/** Walks Drizzle's error `cause` chain to the underlying PostgreSQL SQLSTATE. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(sqlState(error)).toBe(code);
    return;
  }

  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}

beforeAll(async () => {
  await createFixture("appt-a");
  await createFixture("appt-b");
});

afterAll(async () => {
  const pool = getTestAdminPool();

  for (const fixture of fixtures) {
    for (const tenantId of [fixture.tenantId, fixture.otherTenantId]) {
      // Clear appointment rows explicitly: they RESTRICT the doctor-branch and
      // patient rows a tenant cascade would otherwise remove first.
      await pool.query("delete from appointment_idempotency_keys where tenant_id = $1", [tenantId]);
      await pool.query("delete from appointments where tenant_id = $1", [tenantId]);
      await pool.query("delete from tenants where id = $1", [tenantId]);
    }
  }

  for (const userId of createdUserIds) {
    await pool.query("delete from users where id = $1", [userId]);
  }

  await closeTestAdminPool();
  await closePool();
});

describe("appointment schema structure", () => {
  it("applies the migration and exposes the reviewed columns, indexes, constraint and RLS", async () => {
    const pool = getTestAdminPool();

    const expectedColumns: Record<string, string[]> = {
      appointments: Object.values(getTableColumns(appointments)).map((c) => c.name),
      appointment_events: Object.values(getTableColumns(appointmentEvents)).map((c) => c.name),
      appointment_idempotency_keys: Object.values(
        getTableColumns(appointmentIdempotencyKeys),
      ).map((c) => c.name),
    };

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [table],
      );
      expect(rows.map((row) => row.column_name).sort()).toEqual([...columns].sort());
    }

    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and tablename in ('appointments', 'appointment_events', 'appointment_idempotency_keys')`,
    );
    const indexNames = new Set(indexRows.map((row) => row.indexname));
    for (const name of [
      "appointments_tenant_code_unique",
      "appointments_patient_history_idx",
      "appointments_doctor_calendar_idx",
      "appointments_branch_calendar_idx",
      "appointments_status_idx",
      "appointments_range_idx",
      "appointment_events_appointment_idx",
      "appointment_idempotency_keys_unique",
      "appointment_idempotency_keys_appointment_idx",
      "appointment_idempotency_keys_expiry_idx",
      "appointments_rescheduled_from_unique",
    ]) {
      expect(indexNames).toContain(name);
    }

    // Phase 18.4 replacement model: self-reference plus its partial unique index.
    const { rows: rescheduleFkRows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where contype = 'f' and conrelid = 'appointments'::regclass
         and conname = 'appointments_rescheduled_from_fk'`,
    );
    expect(rescheduleFkRows).toHaveLength(1);

    const { rows: rescheduleIndexRows } = await pool.query<{
      indexdef: string;
    }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'appointments_rescheduled_from_unique'`,
    );
    expect(rescheduleIndexRows[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(rescheduleIndexRows[0]?.indexdef).toContain("WHERE");

    const { rows: exclusionRows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where contype = 'x' and conrelid = 'appointments'::regclass`,
    );
    expect(exclusionRows.map((row) => row.conname)).toEqual(["appointments_no_overlap"]);

    const { rows: extensionRows } = await pool.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'btree_gist'",
    );
    expect(extensionRows).toHaveLength(1);

    const { rows: rlsRows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('appointments', 'appointment_events', 'appointment_idempotency_keys')`,
    );
    expect(rlsRows).toHaveLength(3);
    for (const row of rlsRows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // The generated migration is journaled and applied.
    const journal = JSON.parse(
      readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    // Later phases append migrations; this one must remain journaled.
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0017_appointment_lifecycle_timestamps",
    );
    expect(journal.entries.length).toBeGreaterThanOrEqual(18);

    const { rows: appliedRows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(Number(appliedRows[0]?.count)).toBe(journal.entries.length);
  });

  it("creates a confirmed appointment with product defaults and optional fields", async () => {
    const fixture = await createFixture("appt-defaults");
    const { startAt, endAt } = slot(2, 9);

    const [created] = await insertAppointment(fixture, { startAt, endAt });

    expect(created).toMatchObject({
      tenantId: fixture.tenantId,
      patientId: fixture.patientA,
      doctorId: fixture.doctorA,
      branchId: fixture.branchA,
      departmentId: null,
      appointmentSource: "ONLINE",
      appointmentType: "CONSULTATION",
      // A booking that reserved its slot is confirmed immediately.
      appointmentStatus: "CONFIRMED",
      consultationFee: "0.00",
      currency: "USD",
      reason: null,
      notes: null,
      cancelledBy: null,
      cancellationReason: null,
    });
    expect(created?.startAt).toEqual(startAt);
    expect(created?.endAt).toEqual(endAt);
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);

    const [detailed] = await insertAppointment(fixture, {
      ...slot(2, 10),
      departmentId: fixture.departmentA,
      appointmentSource: "WALK_IN",
      appointmentType: "FOLLOW_UP",
      consultationFee: "125.50",
      reason: "Follow-up after discharge",
      notes: "Interpreter requested",
    });

    expect(detailed).toMatchObject({
      departmentId: fixture.departmentA,
      appointmentSource: "WALK_IN",
      appointmentType: "FOLLOW_UP",
      consultationFee: "125.50",
      notes: "Interpreter requested",
    });
  });

  it("accepts every documented status, source and type", async () => {
    const fixture = await createFixture("appt-enums");

    for (const [index, status] of (
      ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"] as const
    ).entries()) {
      const [created] = await insertAppointment(fixture, {
        ...slot(3, 9, index * 30, 30),
        appointmentStatus: status,
        cancellationReason: status === "CANCELLED" ? "Duplicate request" : null,
      });
      expect(created?.appointmentStatus).toBe(status);
    }

    for (const [index, source] of (
      ["ONLINE", "RECEPTIONIST", "WALK_IN", "VOICE_AGENT"] as const
    ).entries()) {
      const [created] = await insertAppointment(fixture, {
        ...slot(4, 9, index * 30, 30),
        appointmentSource: source,
      });
      expect(created?.appointmentSource).toBe(source);
    }
  });

  it("rejects unknown status and source values at the database level", async () => {
    const fixture = await createFixture("appt-invalid-enums");
    const pool = getTestAdminPool();
    const { startAt, endAt } = slot(5, 9);

    await expect(
      pool.query(
        `insert into appointments
           (tenant_id, patient_id, doctor_id, branch_id, appointment_code,
            appointment_source, appointment_status, start_at, end_at, created_by)
         values ($1, $2, $3, $4, $5, 'ONLINE', 'BOOKED', $6, $7, $8)`,
        [
          fixture.tenantId,
          fixture.patientA,
          fixture.doctorA,
          fixture.branchA,
          `BAD-STATUS-${randomUUID().slice(0, 8)}`,
          startAt,
          endAt,
          fixture.creatorId,
        ],
      ),
    ).rejects.toMatchObject({ code: "22P02" });

    await expect(
      pool.query(
        `insert into appointments
           (tenant_id, patient_id, doctor_id, branch_id, appointment_code,
            appointment_source, start_at, end_at, created_by)
         values ($1, $2, $3, $4, $5, 'FAX', $6, $7, $8)`,
        [
          fixture.tenantId,
          fixture.patientA,
          fixture.doctorA,
          fixture.branchA,
          `BAD-SOURCE-${randomUUID().slice(0, 8)}`,
          startAt,
          endAt,
          fixture.creatorId,
        ],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("appointment constraints", () => {
  it("requires start_at before end_at and a non-negative fee", async () => {
    const fixture = await createFixture("appt-time");

    await expectSqlState(
      () => insertAppointment(fixture, { startAt: slot(6, 10).startAt, endAt: slot(6, 9).endAt }),
      "23514",
    );

    await expectSqlState(
      () => insertAppointment(fixture, { startAt: slot(6, 10).startAt, endAt: slot(6, 10).startAt }),
      "23514",
    );

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(6, 11), consultationFee: "-1.00" }),
      "23514",
    );
  });

  it("requires a cancellation reason once an appointment is cancelled", async () => {
    const fixture = await createFixture("appt-cancel");

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(7, 9), appointmentStatus: "CANCELLED" }),
      "23514",
    );

    const [cancelled] = await insertAppointment(fixture, {
      ...slot(7, 10),
      appointmentStatus: "CANCELLED",
      cancelledBy: fixture.creatorId,
      cancellationReason: "Patient called to cancel",
    });
    expect(cancelled).toMatchObject({
      appointmentStatus: "CANCELLED",
      cancelledBy: fixture.creatorId,
      cancellationReason: "Patient called to cancel",
    });
  });

  it("keeps appointment codes unique per tenant and reserved after cancellation", async () => {
    const fixture = await createFixture("appt-code");
    const code = `APT-${randomUUID().slice(0, 8).toUpperCase()}`;

    await insertAppointment(fixture, { ...slot(8, 9), appointmentCode: code });

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(8, 10), appointmentCode: code }),
      "23505",
    );

    await expectSqlState(
      () =>
        insertAppointment(fixture, {
          ...slot(8, 11),
          appointmentCode: code,
          appointmentStatus: "CANCELLED",
          cancellationReason: "Reserved code must not be reused",
        }),
      "23505",
    );

    // Another hospital allocates the same operational code independently.
    const [other] = await insertAppointment(asOtherTenant(fixture), {
      ...slot(8, 9),
      appointmentCode: code,
    });
    expect(other?.tenantId).toBe(fixture.otherTenantId);
  });

  it("rejects cross-tenant and unassigned patient, doctor, branch and department references", async () => {
    const fixture = await createFixture("appt-fks");

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(9, 9), patientId: fixture.patientB }),
      "23503",
    );

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(9, 10), doctorId: fixture.doctorB }),
      "23503",
    );

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(9, 11), branchId: fixture.otherBranch }),
      "23503",
    );

    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(9, 12), departmentId: fixture.departmentB }),
      "23503",
    );

    // The doctor is real and in-tenant, but not assigned to this branch.
    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(9, 13), branchId: fixture.branchC }),
      "23503",
    );
  });

  it("links at most one replacement appointment per superseded row and tenant", async () => {
    const fixture = await createFixture("appt-reschedule-link");

    const original = (
      await insertAppointment(fixture, {
        ...slot(11, 9),
        appointmentStatus: "RESCHEDULED",
      })
    )[0];

    if (!original) throw new Error("Failed to create the superseded appointment fixture");

    const [replacement] = await insertAppointment(fixture, {
      ...slot(11, 10),
      rescheduledFromAppointmentId: original.id,
    });
    expect(replacement?.rescheduledFromAppointmentId).toBe(original.id);

    // A second replacement for the same appointment is rejected by the partial
    // unique index, so history can never fork into two current bookings.
    await expectSqlState(
      () =>
        insertAppointment(fixture, {
          ...slot(11, 11),
          rescheduledFromAppointmentId: original.id,
        }),
      "23505",
    );

    // The link is tenant-checked by the composite self-reference.
    await expectSqlState(
      () =>
        insertAppointment(asOtherTenant(fixture), {
          ...slot(11, 9),
          rescheduledFromAppointmentId: original.id,
        }),
      "23503",
    );
  });
});

describe("appointment double-booking prevention", () => {
  it("rejects overlapping active appointments for one doctor and branch", async () => {
    const fixture = await createFixture("appt-overlap");

    await insertAppointment(fixture, { ...slot(10, 9), appointmentStatus: "CONFIRMED" });

    // Exact duplicate.
    await expectSqlState(
      () => insertAppointment(fixture, { ...slot(10, 9), appointmentStatus: "CONFIRMED" }),
      "23P01",
    );

    // Partial overlap.
    await expectSqlState(
      () =>
        insertAppointment(fixture, {
          startAt: slot(10, 9, 15).startAt,
          endAt: slot(10, 10, 0).endAt,
          appointmentStatus: "PENDING",
        }),
      "23P01",
    );

    // Half-open ranges: starting exactly when the previous appointment ends is
    // allowed.
    const [adjacent] = await insertAppointment(fixture, {
      startAt: slot(10, 9, 30).startAt,
      endAt: slot(10, 10, 0).endAt,
    });
    expect(adjacent?.appointmentStatus).toBe("CONFIRMED");
  });

  it("allows overlaps across branches, across doctors, and for terminal states", async () => {
    const fixture = await createFixture("appt-overlap-allow");

    await insertAppointment(fixture, {
      ...slot(11, 9),
      doctorId: fixture.doctorA,
      branchId: fixture.branchA,
    });

    // The same doctor at a different branch (doctorA is assigned to both).
    const [otherBranch] = await insertAppointment(fixture, {
      ...slot(11, 9),
      doctorId: fixture.doctorA,
      branchId: fixture.branchB,
    });
    expect(otherBranch?.branchId).toBe(fixture.branchB);

    // A different doctor at the same branch.
    const [otherDoctor] = await insertAppointment(fixture, {
      ...slot(11, 9),
      doctorId: fixture.doctorA2,
      branchId: fixture.branchA,
    });
    expect(otherDoctor?.doctorId).toBe(fixture.doctorA2);

    // Cancelled, no-show, completed and rescheduled rows release the slot.
    const terminalStates = [
      { status: "CANCELLED" as const, reason: "Patient cancelled" },
      { status: "NO_SHOW" as const, reason: null },
      { status: "COMPLETED" as const, reason: null },
      { status: "RESCHEDULED" as const, reason: null },
    ];

    for (const [index, state] of terminalStates.entries()) {
      const [created] = await insertAppointment(fixture, {
        ...slot(11, 10 + index),
        appointmentStatus: state.status,
        cancellationReason: state.reason,
      });
      expect(created?.appointmentStatus).toBe(state.status);
    }
  });
});

describe("appointment history", () => {
  it("stores append-only events with transitions and metadata", async () => {
    const fixture = await createFixture("appt-events");
    const [appointment] = await insertAppointment(fixture, slot(12, 9));

    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(appointmentEvents).values({
        tenantId: fixture.tenantId,
        appointmentId: appointment!.id,
        eventType: "CREATED",
        newStatus: "CONFIRMED",
        actorUserId: fixture.creatorId,
      }),
    );

    await withTenantTransaction(fixture.tenantId, async (tx) => {
      await tx
        .update(appointments)
        .set({ appointmentStatus: "CHECKED_IN" })
        .where(eq(appointments.id, appointment!.id));

      await tx.insert(appointmentEvents).values({
        tenantId: fixture.tenantId,
        appointmentId: appointment!.id,
        eventType: "STATUS_CHANGED",
        previousStatus: "CONFIRMED",
        newStatus: "CHECKED_IN",
        actorUserId: fixture.creatorId,
        metadata: { source: "reception-desk" },
      });
    });

    const history = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .select()
        .from(appointmentEvents)
        .where(eq(appointmentEvents.appointmentId, appointment!.id)),
    );

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ eventType: "CREATED", previousStatus: null });
    expect(history[0]?.metadata).toEqual({});
    expect(history[1]).toMatchObject({
      eventType: "STATUS_CHANGED",
      previousStatus: "CONFIRMED",
      newStatus: "CHECKED_IN",
      metadata: { source: "reception-desk" },
    });

    // Events may not point at another tenant's appointment.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(appointmentEvents).values({
            tenantId: fixture.tenantId,
            appointmentId: randomUUID(),
            eventType: "UPDATED",
          }),
        ),
      "23503",
    );
  });
});

describe("appointment idempotency keys", () => {
  it("enforces uniqueness per tenant and operation scope", async () => {
    const fixture = await createFixture("appt-idempotency");
    const [appointment] = await insertAppointment(fixture, slot(13, 9));
    const expiresAt = new Date("2026-12-20T00:00:00.000Z");

    await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.insert(appointmentIdempotencyKeys).values({
        tenantId: fixture.tenantId,
        operation: "appointment.create",
        idempotencyKey: "client-retry-1",
        requestHash: "a".repeat(64),
        appointmentId: appointment!.id,
        status: "COMPLETED",
        expiresAt,
      }),
    );

    // Same tenant + operation + key is rejected.
    await expectSqlState(
      () =>
        withTenantTransaction(fixture.tenantId, (tx) =>
          tx.insert(appointmentIdempotencyKeys).values({
            tenantId: fixture.tenantId,
            operation: "appointment.create",
            idempotencyKey: "client-retry-1",
            requestHash: "b".repeat(64),
            expiresAt,
          }),
        ),
      "23505",
    );

    // The same key is legal for a different operation...
    const [otherOperation] = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx
        .insert(appointmentIdempotencyKeys)
        .values({
          tenantId: fixture.tenantId,
          operation: "appointment.cancel",
          idempotencyKey: "client-retry-1",
          requestHash: "c".repeat(64),
          expiresAt,
        })
        .returning(),
    );
    expect(otherOperation?.status).toBe("IN_PROGRESS");
    expect(otherOperation?.appointmentId).toBeNull();

    // ...and for another tenant.
    const [otherTenant] = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx
        .insert(appointmentIdempotencyKeys)
        .values({
          tenantId: fixture.otherTenantId,
          operation: "appointment.create",
          idempotencyKey: "client-retry-1",
          requestHash: "d".repeat(64),
          expiresAt,
        })
        .returning(),
    );
    expect(otherTenant?.tenantId).toBe(fixture.otherTenantId);
  });
});

describe("appointment tenant isolation", () => {
  it("hides appointments, events and idempotency keys from other tenants (RLS)", async () => {
    const fixture = await createFixture("appt-rls");
    const [appointment] = await insertAppointment(fixture, slot(14, 9));

    await withTenantTransaction(fixture.tenantId, async (tx) => {
      await tx.insert(appointmentEvents).values({
        tenantId: fixture.tenantId,
        appointmentId: appointment!.id,
        eventType: "CREATED",
        newStatus: "CONFIRMED",
      });
      await tx.insert(appointmentIdempotencyKeys).values({
        tenantId: fixture.tenantId,
        idempotencyKey: "rls-key-1",
        requestHash: "e".repeat(64),
        appointmentId: appointment!.id,
        status: "COMPLETED",
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      });
    });

    const foreignCounts = await withTenantTransaction(fixture.otherTenantId, async (tx) => ({
      appointments: (await tx.select({ id: appointments.id }).from(appointments)).length,
      events: (await tx.select({ id: appointmentEvents.id }).from(appointmentEvents)).length,
      keys: (
        await tx.select({ id: appointmentIdempotencyKeys.id }).from(appointmentIdempotencyKeys)
      ).length,
    }));

    expect(foreignCounts).toEqual({ appointments: 0, events: 0, keys: 0 });

    // Cross-tenant updates affect no rows.
    const crossUpdate = await withTenantTransaction(fixture.otherTenantId, (tx) =>
      tx
        .update(appointments)
        .set({ appointmentStatus: "CANCELLED", cancellationReason: "Hijacked" })
        .where(eq(appointments.id, appointment!.id))
        .returning({ id: appointments.id }),
    );
    expect(crossUpdate).toHaveLength(0);

    // A write that claims another tenant is rejected by the WITH CHECK policy.
    await expect(
      withTenantTransaction(fixture.otherTenantId, (tx) =>
        tx.insert(appointments).values(appointmentValues(fixture, slot(14, 10))),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });

    const role = await withTenantTransaction(fixture.tenantId, (tx) =>
      tx.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      ),
    );
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});
