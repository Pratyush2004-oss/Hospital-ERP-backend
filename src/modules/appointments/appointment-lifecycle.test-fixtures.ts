import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { DatabaseTransaction } from "../../database/context.js";
import * as schema from "../../database/schema/index.js";
import { getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import type {
  AppointmentActorContext,
  CreateAppointmentBookingInput,
} from "./appointment-booking.types.js";

/**
 * Shared PostgreSQL fixtures for the Phase 18.4 reschedule/cancel suites.
 *
 * Not a test file (the suffix is deliberately absent): it only builds tenant
 * data with the admin connection and provides app-role transactions so
 * concurrency tests really run as the restricted role under RLS.
 */

export interface LifecycleFixture {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly branchId: string;
  readonly secondaryBranchId: string;
  readonly inactiveBranchId: string;
  readonly otherTenantBranchId: string;
  readonly doctorId: string;
  readonly secondDoctorId: string;
  readonly inactiveDoctorId: string;
  readonly otherTenantDoctorId: string;
  readonly patientId: string;
  readonly secondPatientId: string;
  readonly inactivePatientId: string;
  readonly otherTenantPatientId: string;
  readonly departmentId: string;
  readonly staffUserId: string;
  readonly patientUserId: string;
  readonly outsiderUserId: string;
  readonly otherTenantStaffUserId: string;
  readonly doctorUserId: string;
  readonly secondDoctorUserId: string;
  readonly otherTenantDoctorUserId: string;
}

export const FIXED_NOW = new Date("2026-12-01T00:00:00.000Z");
/** Monday 2026-12-07; Europe/London is GMT in December. */
export const SLOT_START = "2026-12-07T09:00:00.000Z";
export const SLOT_SECOND = "2026-12-07T09:30:00.000Z";
export const SLOT_THIRD = "2026-12-07T10:00:00.000Z";

const fixtures: LifecycleFixture[] = [];
const createdUserIds: string[] = [];

interface TempDbObject {
  readonly functionName: string;
  readonly triggerName: string;
  readonly table: "appointments" | "appointment_events";
}

const temporaryObjects: TempDbObject[] = [];

let lifecyclePool: Pool | null = null;
let lifecycleDb: NodePgDatabase<typeof schema> | null = null;

export function getLifecycleDb(): NodePgDatabase<typeof schema> {
  lifecyclePool ??= new Pool({
    connectionString: testAppDatabaseUrl(),
    max: 3,
    application_name: "hospitalos-lifecycle-concurrency-test",
  });
  lifecycleDb ??= drizzle(lifecyclePool, { schema });
  return lifecycleDb;
}

/** Runs `callback` in an independent app-role transaction with tenant context. */
export async function inAppTransaction<T>(
  tenantId: string,
  actorUserId: string,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return getLifecycleDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.current_user_id', ${actorUserId}, true)`);
    await tx.execute(sql`select set_config('app.is_platform', 'false', true)`);

    return callback(tx);
  });
}

export async function createLifecycleFixture(label: string): Promise<LifecycleFixture> {
  const pool = getTestAdminPool();
  const suffix = randomUUID().slice(0, 8);

  const ids = {
    tenantId: randomUUID(),
    otherTenantId: randomUUID(),
    branchId: randomUUID(),
    secondaryBranchId: randomUUID(),
    inactiveBranchId: randomUUID(),
    otherTenantBranchId: randomUUID(),
    doctorId: randomUUID(),
    secondDoctorId: randomUUID(),
    inactiveDoctorId: randomUUID(),
    otherTenantDoctorId: randomUUID(),
    patientId: randomUUID(),
    secondPatientId: randomUUID(),
    inactivePatientId: randomUUID(),
    otherTenantPatientId: randomUUID(),
    departmentId: randomUUID(),
    staffUserId: randomUUID(),
    patientUserId: randomUUID(),
    outsiderUserId: randomUUID(),
    otherTenantStaffUserId: randomUUID(),
    doctorUserId: randomUUID(),
    secondDoctorUserId: randomUUID(),
    inactiveDoctorUserId: randomUUID(),
    otherTenantDoctorUserId: randomUUID(),
  };

  await pool.query(
    `insert into tenants (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
    [
      ids.tenantId,
      `${label} Hospital`,
      `${label}-${suffix}`,
      ids.otherTenantId,
      `${label} Other Hospital`,
      `${label}-other-${suffix}`,
    ],
  );

  await pool.query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,'Central',$3,'Europe/London',true),
            ($4,$2,'Riverside',$5,'Europe/London',true),
            ($6,$2,'Closed',$7,'Europe/London',false),
            ($8,$9,'Other Central',$10,'UTC',true)`,
    [
      ids.branchId,
      ids.tenantId,
      `CEN-${suffix}`,
      ids.secondaryBranchId,
      `RIV-${suffix}`,
      ids.inactiveBranchId,
      `CLO-${suffix}`,
      ids.otherTenantBranchId,
      ids.otherTenantId,
      `OTH-${suffix}`,
    ],
  );

  const userRows = [
    [ids.staffUserId, `${label} Receptionist`, "reception"],
    [ids.patientUserId, `${label} Patient Account`, "patient"],
    [ids.outsiderUserId, `${label} Outsider`, "outsider"],
    [ids.otherTenantStaffUserId, `${label} Other Receptionist`, "other-reception"],
    [ids.doctorUserId, `${label} Doctor`, "doctor"],
    [ids.secondDoctorUserId, `${label} Second Doctor`, "second-doctor"],
    [ids.inactiveDoctorUserId, `${label} Inactive Doctor`, "inactive-doctor"],
    [ids.otherTenantDoctorUserId, `${label} Other Doctor`, "other-doctor"],
  ] as const;

  await pool.query(
    `insert into users (id, full_name, email, password_hash)
     values ($1,$2,$3,'lifecycle-test-hash'), ($4,$5,$6,'lifecycle-test-hash'),
            ($7,$8,$9,'lifecycle-test-hash'), ($10,$11,$12,'lifecycle-test-hash'),
            ($13,$14,$15,'lifecycle-test-hash'), ($16,$17,$18,'lifecycle-test-hash'),
            ($19,$20,$21,'lifecycle-test-hash'), ($22,$23,$24,'lifecycle-test-hash')`,
    userRows.flatMap(([id, fullName, emailPrefix]) => [
      id,
      fullName,
      `${emailPrefix}-${label}-${suffix}@lifecycle.test`,
    ]),
  );
  for (const [id] of userRows) createdUserIds.push(id);

  const doctorRows = [
    [
      ids.doctorId,
      ids.tenantId,
      ids.doctorUserId,
      `DOC-${suffix}`,
      `REG-${suffix}`,
      true,
    ],
    [
      ids.secondDoctorId,
      ids.tenantId,
      ids.secondDoctorUserId,
      `DOC2-${suffix}`,
      `REG2-${suffix}`,
      true,
    ],
    [
      ids.inactiveDoctorId,
      ids.tenantId,
      ids.inactiveDoctorUserId,
      `DOC-IN-${suffix}`,
      `REG-IN-${suffix}`,
      false,
    ],
    [
      ids.otherTenantDoctorId,
      ids.otherTenantId,
      ids.otherTenantDoctorUserId,
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

  const assignments = [
    [ids.tenantId, ids.doctorId, ids.branchId, "150.00", "GBP"],
    [ids.tenantId, ids.secondDoctorId, ids.secondaryBranchId, "200.00", "USD"],
    [ids.tenantId, ids.inactiveDoctorId, ids.branchId, "90.00", "GBP"],
    [ids.otherTenantId, ids.otherTenantDoctorId, ids.otherTenantBranchId, "80.00", "USD"],
  ] as const;

  for (const [tenant, doctor, branch, fee, currency] of assignments) {
    await pool.query(
      `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, currency, is_active)
       values ($1,$2,$3,$4,$5,true)`,
      [tenant, doctor, branch, fee, currency],
    );
  }

  await pool.query(
    `insert into patient_profiles (id, tenant_id, user_id, patient_code, full_name, status)
     values ($1,$5,$6,$7,$8,'ACTIVE'),
            ($2,$5,null,$9,$10,'ACTIVE'),
            ($3,$5,null,$11,$12,'INACTIVE'),
            ($4,$13,null,$14,$15,'ACTIVE')`,
    [
      ids.patientId,
      ids.secondPatientId,
      ids.inactivePatientId,
      ids.otherTenantPatientId,
      ids.tenantId,
      ids.patientUserId,
      `MRN-${suffix}`,
      `Synthetic Patient ${suffix}`,
      `MRN2-${suffix}`,
      `Synthetic Second Patient ${suffix}`,
      `MRN-IN-${suffix}`,
      `Synthetic Inactive Patient ${suffix}`,
      ids.otherTenantId,
      `MRN-OTH-${suffix}`,
      `Synthetic Other Patient ${suffix}`,
    ],
  );

  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1,$2,'ACTIVE', now()), ($3,$4,'ACTIVE', now()),
            ($1,$5,'ACTIVE', now()), ($1,$6,'ACTIVE', now()),
            ($1,$7,'ACTIVE', now()), ($3,$8,'ACTIVE', now())`,
    [
      ids.tenantId,
      ids.staffUserId,
      ids.otherTenantId,
      ids.otherTenantStaffUserId,
      ids.doctorUserId,
      ids.secondDoctorUserId,
      ids.inactiveDoctorUserId,
      ids.otherTenantDoctorUserId,
    ],
  );

  await pool.query(
    `insert into departments (id, tenant_id, branch_id, name, slug, is_active)
     values ($1,$2,$3,'Cardiology',$4,true)`,
    [ids.departmentId, ids.tenantId, ids.branchId, `cardiology-${suffix}`],
  );

  const fixture: LifecycleFixture = ids;
  fixtures.push(fixture);
  return fixture;
}

interface ScheduleOverrides {
  readonly doctorId?: string;
  readonly branchId?: string;
  readonly dayOfWeek?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly slotDurationMinutes?: number;
  readonly bufferMinutes?: number;
  readonly effectiveFrom?: string;
}

export async function addLifecycleSchedule(
  fixture: LifecycleFixture,
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
      fixture.tenantId,
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

export async function addLifecycleBreak(
  fixture: LifecycleFixture,
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

export async function addLifecycleLeave(
  fixture: LifecycleFixture,
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

/** Direct insert for statuses this phase does not create (COMPLETED, ...). */
export async function insertAppointmentDirectly(
  fixture: LifecycleFixture,
  overrides: {
    status?: string;
    startAt?: string;
    endAt?: string;
    patientId?: string;
    doctorId?: string;
    branchId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();

  await getTestAdminPool().query(
    `insert into appointments
       (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
        appointment_source, appointment_status, start_at, end_at,
        consultation_fee, currency, created_by)
     values ($1,$2,$3,$4,$5,$6,'RECEPTIONIST',$7,$8,$9,'150.00','GBP',$10)`,
    [
      id,
      fixture.tenantId,
      overrides.patientId ?? fixture.patientId,
      overrides.doctorId ?? fixture.doctorId,
      overrides.branchId ?? fixture.branchId,
      `APT-SEED-${randomUUID().slice(0, 8).toUpperCase()}`,
      overrides.status ?? "CONFIRMED",
      overrides.startAt ?? SLOT_START,
      overrides.endAt ?? SLOT_SECOND,
      fixture.staffUserId,
    ],
  );

  return id;
}

export function staffActor(fixture: LifecycleFixture): AppointmentActorContext {
  return {
    userId: fixture.staffUserId,
    permissions: new Set([
      "appointment:create",
      "appointment:read",
      "appointment:update",
      "appointment:cancel",
    ]),
  };
}

export function doctorActor(fixture: LifecycleFixture): AppointmentActorContext {
  return {
    userId: fixture.doctorUserId,
    permissions: new Set([
      "appointment:create",
      "appointment:read",
      "appointment:update",
      "appointment:cancel",
    ]),
  };
}

export function otherTenantStaffActor(
  fixture: LifecycleFixture,
): AppointmentActorContext {
  return {
    userId: fixture.otherTenantStaffUserId,
    permissions: new Set([
      "appointment:create",
      "appointment:update",
      "appointment:cancel",
    ]),
  };
}

export function bookingInput(
  fixture: LifecycleFixture,
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

export async function countLifecycleRows(
  table: "appointments" | "appointment_events" | "appointment_idempotency_keys",
  tenantId: string,
): Promise<number> {
  const { rows } = await getTestAdminPool().query(
    `select count(*)::int as count from ${table} where tenant_id = $1`,
    [tenantId],
  );

  return rows[0].count as number;
}

export function deepestMessage(error: unknown): string {
  let message = "";
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };

    if (typeof candidate.message === "string") message = candidate.message;
    current = candidate.cause;
  }

  return message;
}

async function dropTemporaryObject(object: TempDbObject): Promise<void> {
  const index = temporaryObjects.indexOf(object);
  if (index >= 0) temporaryObjects.splice(index, 1);

  const pool = getTestAdminPool();
  await pool.query(`drop trigger if exists ${object.triggerName} on ${object.table}`);
  await pool.query(`drop function if exists ${object.functionName}()`);
}

/** Delays appointment inserts for one tenant so two transactions can race. */
export async function addInsertDelayTrigger(
  tenantId: string,
  seconds: number,
): Promise<TempDbObject> {
  const pool = getTestAdminPool();
  const functionName = `test_lifecycle_delay_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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

  const object: TempDbObject = { functionName, triggerName, table: "appointments" };
  temporaryObjects.push(object);
  return object;
}

/** Forces a database failure on insert for one tenant, to prove rollback. */
export async function addFailureTrigger(
  table: "appointments" | "appointment_events",
  tenantId: string,
): Promise<TempDbObject> {
  const pool = getTestAdminPool();
  const functionName = `test_lifecycle_fail_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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

export async function removeTemporaryTrigger(object: TempDbObject): Promise<void> {
  await dropTemporaryObject(object);
}

export async function cleanupLifecycleFixtures(): Promise<void> {
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

  if (lifecyclePool) {
    const instance = lifecyclePool;
    lifecyclePool = null;
    lifecycleDb = null;
    await instance.end();
  }
}
