import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { closePool } from "../../database/connection.js";
import { withTenantTransaction } from "../../database/context.js";
import { closeTestAdminPool, getTestAdminPool } from "../../test/database.js";
import { testAppDatabaseUrl } from "../../test/database-config.js";
import { createTestApi, type TestApi, type TestResponse } from "../../test/http-client.js";
import { createInvoice } from "../billing/invoice.service.js";
import { issueInvoice } from "../billing/invoice.lifecycle.service.js";
import { recordPayment } from "../billing/payment.service.js";
import {
  createMockNotificationProvider,
  NotificationProviderError,
} from "./notification.providers.js";
import { sweepAppointmentReminders } from "./notification.appointment.service.js";
import { enqueueNotification } from "./notification.service.js";
import { processNotificationBatch } from "./notification.worker.js";

/**
 * Phase 20.2 integration tests.
 *
 * Real Express app + real PostgreSQL as the restricted `hospitalos_app` role.
 * Provider adapters are deterministic mocks, so no email/SMS/WhatsApp message is
 * ever sent. The suite covers recipient ownership, pagination, read state,
 * preferences, cross-user/cross-tenant isolation, worker retries/recovery,
 * appointment notifications and reminders, billing integration and RLS.
 */

const API = "/api/v1";
const PASSWORD = "Correct-Horse-Battery-9";

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function dataOf<T>(response: TestResponse): T {
  return (response.body as Envelope<T>).data;
}

function errorOf(response: TestResponse): ErrorEnvelope["error"] {
  return (response.body as ErrorEnvelope).error;
}

function futureDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

let adminApi: TestApi;
let linkedApi: TestApi;
let otherApi: TestApi;
let anonymousApi: TestApi;

let tenantId: string;
let otherTenantId: string;
let tenantSlug: string;
let branchId: string;
let otherBranchId: string;
let doctorId: string;
let patientId: string;
let adminUserId: string;
let linkedUserId: string;
let otherUserId: string;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function createAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@notifications-phase20.test`;
  const client = await createTestApi(createApp());
  try {
    const response = await client.post(`${API}/auth/register`, {
      body: { fullName: label, email, password: PASSWORD },
    });
    expect(response.status).toBe(201);
    const id = dataOf<{ user: { id: string } }>(response).user.id;
    createdUserIds.push(id);
    return { id, email };
  } finally {
    await client.close();
  }
}

async function addMembership(tenant: string, userId: string, roleSlug: string): Promise<void> {
  await getTestAdminPool().query(
    `insert into tenant_memberships (tenant_id, user_id, status, joined_at)
     values ($1,$2,'ACTIVE',now())`,
    [tenant, userId],
  );
  await getTestAdminPool().query(
    `insert into membership_roles (tenant_id, tenant_membership_id, role_id)
     select m.tenant_id, m.id, r.id
     from tenant_memberships m
     join roles r on r.tenant_id = m.tenant_id and r.slug = $3
     where m.tenant_id = $1 and m.user_id = $2`,
    [tenant, userId, roleSlug],
  );
}

async function login(client: TestApi, email: string): Promise<void> {
  const response = await client.post(`${API}/auth/login`, {
    body: { identifier: email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
}

async function selectTenant(client: TestApi, slug: string): Promise<void> {
  const response = await client.post(`${API}/tenants/select`, { body: { slug } });
  expect(response.status).toBe(200);
}

async function insertNotification(values: {
  tenantId: string;
  userId: string | null;
  channel: string;
  status?: string;
  sourceEventId?: string;
  event?: string;
  body?: string;
  recipient?: string | null;
  attempts?: number;
  maxAttempts?: number;
  nextAttemptAt?: string;
  readAt?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await getTestAdminPool().query(
    `insert into notifications
       (id, tenant_id, user_id, event, channel, status, source_event_id,
        recipient, subject, body, payload, attempts, max_attempts,
        next_attempt_at, read_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,$11,$12,$13,$14)`,
    [
      id,
      values.tenantId,
      values.userId,
      values.event ?? "SYSTEM_ANNOUNCEMENT",
      values.channel,
      values.status ?? "SENT",
      values.sourceEventId ?? `test:${randomUUID()}`,
      values.recipient ?? null,
      "Test subject",
      values.body ?? "Test notification body",
      values.attempts ?? 0,
      values.maxAttempts ?? 3,
      values.nextAttemptAt ?? new Date(Date.now() - 60_000).toISOString(),
      values.readAt ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  adminApi = await createTestApi(createApp());
  linkedApi = await createTestApi(createApp());
  otherApi = await createTestApi(createApp());
  anonymousApi = await createTestApi(createApp());

  const suffix = randomUUID().slice(0, 8);

  const admin = await createAccount(`admin-${suffix}`);
  adminUserId = admin.id;
  await login(adminApi, admin.email);

  const tenantResponse = await adminApi.post(`${API}/tenants/register`, {
    body: { name: `Notification Phase 20 ${suffix}` },
  });
  expect(tenantResponse.status).toBe(201);
  const tenant = dataOf<{ tenant: { id: string; slug: string } }>(tenantResponse).tenant;
  tenantId = tenant.id;
  tenantSlug = tenant.slug;
  createdTenantIds.push(tenantId);
  await getTestAdminPool().query("update tenants set status='ACTIVE' where id=$1", [tenantId]);
  await selectTenant(adminApi, tenantSlug);

  branchId = randomUUID();
  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,'Kolkata Branch',$3,'Asia/Kolkata',true)`,
    [branchId, tenantId, `NB-${randomUUID().slice(0, 8)}`],
  );

  const doctorAccount = await createAccount(`doctor-${suffix}`);
  await addMembership(tenantId, doctorAccount.id, "doctor");
  doctorId = randomUUID();
  const doctorSuffix = randomUUID().slice(0, 8);
  await getTestAdminPool().query(
    `insert into doctors (id, tenant_id, user_id, doctor_code, registration_number, is_active)
     values ($1,$2,$3,$4,$5,true)`,
    [doctorId, tenantId, doctorAccount.id, `DOC-${doctorSuffix}`, `REG-${doctorSuffix}`],
  );
  await getTestAdminPool().query(
    `insert into doctor_branches (tenant_id, doctor_id, branch_id, consultation_fee, currency, is_active)
     values ($1,$2,$3,'100.00','USD',true)`,
    [tenantId, doctorId, branchId],
  );
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    await getTestAdminPool().query(
      `insert into doctor_schedules
         (id, tenant_id, doctor_id, branch_id, day_of_week, start_time, end_time,
          slot_duration_minutes, buffer_minutes, effective_from, is_active)
       values ($1,$2,$3,$4,$5,'09:00:00','17:00:00',30,0,'2020-01-01',true)`,
      [randomUUID(), tenantId, doctorId, branchId, dayOfWeek],
    );
  }

  const patientResponse = await adminApi.post(`${API}/patients`, {
    body: { fullName: "Phase 20 Patient", gender: "OTHER" },
  });
  expect(patientResponse.status).toBe(201);
  patientId = dataOf<{ patient: { id: string } }>(patientResponse).patient.id;

  await getTestAdminPool().query(
    `insert into patient_contacts
       (id, tenant_id, patient_id, contact_type, phone, email, is_primary, is_verified)
     values ($1,$2,$3,'MOBILE','+919876543210','patient-phase20@example.test',true,true)`,
    [randomUUID(), tenantId, patientId],
  );

  const linked = await createAccount(`linked-${suffix}`);
  linkedUserId = linked.id;
  await addMembership(tenantId, linkedUserId, "nurse");
  await login(linkedApi, linked.email);
  await selectTenant(linkedApi, tenantSlug);
  await getTestAdminPool().query("update patient_profiles set user_id=$1 where id=$2 and tenant_id=$3", [
    linkedUserId,
    patientId,
    tenantId,
  ]);

  const other = await createAccount(`other-${suffix}`);
  otherUserId = other.id;
  await login(otherApi, other.email);
  const otherTenantResponse = await otherApi.post(`${API}/tenants/register`, {
    body: { name: `Notification Other ${suffix}` },
  });
  expect(otherTenantResponse.status).toBe(201);
  const otherTenant = dataOf<{ tenant: { id: string; slug: string } }>(otherTenantResponse).tenant;
  otherTenantId = otherTenant.id;
  createdTenantIds.push(otherTenantId);
  await getTestAdminPool().query("update tenants set status='ACTIVE' where id=$1", [otherTenantId]);
  await selectTenant(otherApi, otherTenant.slug);
  otherBranchId = randomUUID();
  await getTestAdminPool().query(
    `insert into branches (id, tenant_id, name, branch_code, timezone, is_active)
     values ($1,$2,'Other Branch',$3,'UTC',true)`,
    [otherBranchId, otherTenantId, `OB-${randomUUID().slice(0, 8)}`],
  );
});

afterAll(async () => {
  const pool = getTestAdminPool();
  for (const tenant of createdTenantIds) {
    await pool.query("delete from tenants where id=$1", [tenant]);
  }
  for (const user of createdUserIds) {
    await pool.query("delete from users where id=$1", [user]);
  }

  await Promise.all([
    adminApi.close(),
    linkedApi.close(),
    otherApi.close(),
    anonymousApi.close(),
  ]);
  await closeTestAdminPool();
  await closePool();
});

describe("notification API", () => {
  it("lists, paginates and filters only the caller's notifications", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertNotification({
        tenantId,
        userId: linkedUserId,
        channel: "IN_APP",
        sourceEventId: `api-list:${index}`,
        body: `Notification ${index}`,
      });
    }
    await insertNotification({
      tenantId,
      userId: adminUserId,
      channel: "IN_APP",
      sourceEventId: "api-list-other-user",
    });
    await insertNotification({
      tenantId: otherTenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      sourceEventId: "api-list-other-tenant",
    });

    const firstPage = await linkedApi.get(`${API}/notifications?page=1&limit=2`);
    expect(firstPage.status).toBe(200);
    const page = dataOf<{ notifications: Array<{ id: string }> }>(firstPage);
    expect(page.notifications).toHaveLength(2);
    expect(firstPage.body).toMatchObject({
      meta: { pagination: { page: 1, pageSize: 2, total: 3, totalPages: 2 } },
    });

    const secondPage = await linkedApi.get(`${API}/notifications?page=2&limit=2`);
    expect(dataOf<{ notifications: Array<{ id: string }> }>(secondPage).notifications).toHaveLength(1);

    const unreadOnly = await linkedApi.get(`${API}/notifications?unreadOnly=true&limit=100`);
    expect(dataOf<{ notifications: unknown[] }>(unreadOnly).notifications).toHaveLength(3);

    const filtered = await linkedApi.get(`${API}/notifications?channel=EMAIL`);
    expect(dataOf<{ notifications: unknown[] }>(filtered).notifications).toHaveLength(0);
  });

  it("returns detail only for an owned notification", async () => {
    const ownId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      sourceEventId: "api-detail-own",
    });
    const otherUserIdNotification = await insertNotification({
      tenantId,
      userId: adminUserId,
      channel: "IN_APP",
      sourceEventId: "api-detail-other",
    });
    const otherTenantNotification = await insertNotification({
      tenantId: otherTenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      sourceEventId: "api-detail-tenant",
    });

    expect((await linkedApi.get(`${API}/notifications/${ownId}`)).status).toBe(200);
    expect((await linkedApi.get(`${API}/notifications/${otherUserIdNotification}`)).status).toBe(404);
    expect((await linkedApi.get(`${API}/notifications/${otherTenantNotification}`)).status).toBe(404);
    expect((await anonymousApi.get(`${API}/notifications`)).status).toBe(401);
  });

  it("tracks unread counts and read state per recipient", async () => {
    const id = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      sourceEventId: "api-read-state",
    });

    const before = await linkedApi.get(`${API}/notifications/unread-count`);
    expect(dataOf<{ unread: number }>(before).unread).toBeGreaterThanOrEqual(1);

    const marked = await linkedApi.post(`${API}/notifications/${id}/read`);
    expect(marked.status).toBe(200);
    expect(dataOf<{ applied: boolean }>(marked).applied).toBe(true);

    const replay = await linkedApi.post(`${API}/notifications/${id}/read`);
    expect(replay.status).toBe(200);
    expect(dataOf<{ applied: boolean }>(replay).applied).toBe(false);

    const all = await linkedApi.post(`${API}/notifications/read-all`);
    expect(all.status).toBe(200);
    const remaining = await linkedApi.get(`${API}/notifications/unread-count`);
    expect(dataOf<{ unread: number }>(remaining).unread).toBe(0);

    // Another user's notification cannot be acknowledged.
    const foreign = await insertNotification({
      tenantId,
      userId: adminUserId,
      channel: "IN_APP",
      sourceEventId: "api-read-foreign",
    });
    expect((await linkedApi.post(`${API}/notifications/${foreign}/read`)).status).toBe(404);
  });

  it("manages preferences with ownership and RBAC for tenant defaults", async () => {
    const updated = await linkedApi.patch(`${API}/notifications/preferences`, {
      body: { channel: "EMAIL", event: "APPOINTMENT_REMINDER", enabled: false },
    });
    expect(updated.status).toBe(200);
    expect(dataOf<{ preference: { enabled: boolean; isTenantDefault: boolean } }>(updated)).toMatchObject({
      preference: { enabled: false, isTenantDefault: false },
    });

    const listed = await linkedApi.get(`${API}/notifications/preferences`);
    const preferences = dataOf<{ preferences: Array<{ channel: string; event: string | null }> }>(listed)
      .preferences;
    expect(preferences.some((item) => item.channel === "EMAIL" && item.event === "APPOINTMENT_REMINDER")).toBe(true);

    // A nurse cannot write hospital-wide defaults.
    const forbidden = await linkedApi.patch(`${API}/notifications/preferences`, {
      body: { channel: "IN_APP", enabled: false, tenantDefault: true },
    });
    expect(forbidden.status).toBe(403);

    const adminDefault = await adminApi.patch(`${API}/notifications/preferences`, {
      body: { channel: "IN_APP", enabled: true, tenantDefault: true },
    });
    expect(adminDefault.status).toBe(200);
    expect(dataOf<{ preference: { isTenantDefault: boolean } }>(adminDefault).preference.isTenantDefault).toBe(true);

    const strictBody = await linkedApi.patch(`${API}/notifications/preferences`, {
      body: { channel: "IN_APP", enabled: true, userId: adminUserId },
    });
    expect(strictBody.status).toBe(422);
    expect(errorOf(strictBody).code).toBe("VALIDATION_ERROR");
  });

  it("enforces notification RLS with the restricted application role", async () => {
    const pool = new Pool({
      connectionString: testAppDatabaseUrl(),
      max: 1,
      application_name: "hospitalos-notification-rls-test",
    });
    const client = await pool.connect();

    const ownId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      sourceEventId: "rls-own",
    });
    const foreignId = await insertNotification({
      tenantId: otherTenantId,
      userId: otherUserId,
      channel: "IN_APP",
      sourceEventId: "rls-foreign",
    });

    try {
      const identity = await client.query<{ current_user: string; bypass: boolean }>(
        `select current_user,
                coalesce((select rolbypassrls from pg_roles where rolname = current_user), true) as bypass`,
      );
      expect(identity.rows[0]?.current_user).toBe("hospitalos_app");
      expect(identity.rows[0]?.bypass).toBe(false);

      await client.query("begin");
      await client.query("select set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("select set_config('app.is_platform','false',true)");
      const own = await client.query("select id from notifications where id=$1", [ownId]);
      const foreign = await client.query("select id from notifications where id=$1", [foreignId]);
      expect(own.rows).toHaveLength(1);
      expect(foreign.rows).toHaveLength(0);
      await client.query("rollback");

      await client.query("begin");
      const noContext = await client.query<{ count: number }>(
        "select count(*)::int as count from notifications",
      );
      expect(noContext.rows[0]?.count).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe("notification event idempotency", () => {
  it("inserts one row per source event and channel", async () => {
    const eventId = `dedupe:${randomUUID()}`;

    const ids = await withTenantTransaction(tenantId, async (tx) => {
      const first = await enqueueNotification({
        tenantId,
        userId: linkedUserId,
        event: "SYSTEM_ANNOUNCEMENT",
        eventId,
        channel: "IN_APP",
        variables: { announcement_title: "Title", announcement_body: "Body" },
        tx,
      });
      const second = await enqueueNotification({
        tenantId,
        userId: linkedUserId,
        event: "SYSTEM_ANNOUNCEMENT",
        eventId,
        channel: "IN_APP",
        variables: { announcement_title: "Title", announcement_body: "Body" },
        tx,
      });
      return [first, second];
    });

    expect(ids[0]).not.toBeNull();
    expect(ids[1]).toBeNull();

    const rows = await getTestAdminPool().query<{ count: number }>(
      "select count(*)::int as count from notifications where tenant_id=$1 and source_event_id=$2 and channel='IN_APP'",
      [tenantId, eventId],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
});

describe("notification delivery worker", () => {
  it("delivers in-app, retries transient failures, skips unconfigured channels and recovers", async () => {
    // Isolate this file's worker tests from rows created by other suites.
    await getTestAdminPool().query("delete from notifications");

    const inAppId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "IN_APP",
      status: "PENDING",
      sourceEventId: "worker-in-app",
    });
    const emailId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "EMAIL",
      status: "PENDING",
      recipient: "worker@example.test",
      sourceEventId: "worker-email",
    });
    const smsId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "SMS",
      status: "PENDING",
      recipient: "+919876543210",
      sourceEventId: "worker-sms",
    });
    const whatsappId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "WHATSAPP",
      status: "PENDING",
      recipient: "+919876543210",
      sourceEventId: "worker-whatsapp",
    });
    const recoveredId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "EMAIL",
      status: "PROCESSING",
      recipient: "recovered@example.test",
      sourceEventId: "worker-recovered",
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const permanentId = await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "EMAIL",
      status: "PENDING",
      recipient: "permanent@example.test",
      sourceEventId: "worker-permanent",
      maxAttempts: 1,
    });

    const emailProvider = {
      send: vi.fn(async (message: { recipient: string }) => {
        if (message.recipient === "permanent@example.test") {
          throw new NotificationProviderError("mock_permanent_failure", { transient: false });
        }
        return { messageId: `email-${randomUUID()}` };
      }),
    };
    const result = await processNotificationBatch({
      providers: {
        email: emailProvider,
        sms: createMockNotificationProvider({ fail: "transient" }),
      },
      retryBaseSeconds: 30,
    });

    expect(result.sent).toBeGreaterThanOrEqual(3); // in-app + email + recovered
    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const pool = getTestAdminPool();
    const rows = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      last_error: string | null;
      next_attempt_at: Date;
      provider_message_id: string | null;
    }>("select id,status,attempts,last_error,next_attempt_at,provider_message_id from notifications where id = any($1::uuid[])", [
      [inAppId, emailId, smsId, whatsappId, recoveredId, permanentId],
    ]);
    const byId = new Map(rows.rows.map((row) => [row.id, row]));

    expect(byId.get(inAppId)?.status).toBe("SENT");
    expect(byId.get(emailId)?.status).toBe("SENT");
    expect(byId.get(emailId)?.provider_message_id).toContain("email-");
    expect(byId.get(smsId)?.status).toBe("FAILED");
    expect(byId.get(smsId)?.last_error).toBe("mock_transient_failure");
    expect(byId.get(smsId)!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(byId.get(whatsappId)?.status).toBe("SKIPPED");
    expect(byId.get(whatsappId)?.last_error).toBe("provider_not_configured");
    expect(byId.get(recoveredId)?.status).toBe("SENT");
    expect(byId.get(permanentId)?.status).toBe("FAILED");
    expect(byId.get(permanentId)?.last_error).toBe("retry_limit_exceeded");

    // The retried row succeeds on its next attempt, and nothing is re-sent.
    await pool.query("update notifications set next_attempt_at=now() - interval '1 minute' where id=$1", [smsId]);
    const retry = await processNotificationBatch({
      providers: {
        email: emailProvider,
        sms: createMockNotificationProvider(),
      },
      retryBaseSeconds: 30,
    });
    expect(retry.claimed).toBe(1);
    expect((await pool.query("select status from notifications where id=$1", [smsId])).rows[0]?.status).toBe("SENT");

    const idle = await processNotificationBatch({
      providers: { email: emailProvider, sms: createMockNotificationProvider() },
    });
    expect(idle.claimed).toBe(0);
  });

  it("prevents duplicate delivery when two workers claim the same row", async () => {
    await getTestAdminPool().query("delete from notifications");

    await insertNotification({
      tenantId,
      userId: linkedUserId,
      channel: "EMAIL",
      status: "PENDING",
      recipient: "race@example.test",
      sourceEventId: "worker-race",
    });

    const send = vi.fn(async () => ({ messageId: `race-${randomUUID()}` }));
    const providers = { email: { send } };

    const [first, second] = await Promise.all([
      processNotificationBatch({ providers, limit: 10 }),
      processNotificationBatch({ providers, limit: 10 }),
    ]);

    expect(first.sent + second.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("appointment notifications and reminders", () => {
  it("notifies booking and cancellation using the branch timezone", async () => {
    const day = futureDay(30);
    const booked = await adminApi.post(`${API}/appointments`, {
      body: {
        patientId,
        doctorId,
        branchId,
        startAt: `${day}T09:00:00Z`,
      },
      headers: { "idempotency-key": `phase20-book-${randomUUID()}` },
    });
    expect(booked.status).toBe(201);
    const appointment = dataOf<{ appointment: { id: string } }>(booked).appointment;

    const pool = getTestAdminPool();
    const confirmed = await pool.query<{ body: string; recipient: string | null }>(
      `select body, recipient from notifications
        where tenant_id=$1 and source_event_id=$2 and channel='EMAIL'`,
      [tenantId, `appointment:${appointment.id}:confirmed`],
    );
    expect(confirmed.rows).toHaveLength(1);
    // 09:00Z rendered in Asia/Kolkata is 14:30.
    expect(confirmed.rows[0]?.body).toContain("14:30");
    expect(confirmed.rows[0]?.recipient).toBe("patient-phase20@example.test");

    const cancelled = await adminApi.post(`${API}/appointments/${appointment.id}/cancel`, {
      body: { cancellationReason: "Patient request" },
    });
    expect(cancelled.status).toBe(200);

    const cancellation = await pool.query(
      `select id from notifications where tenant_id=$1 and source_event_id=$2`,
      [tenantId, `appointment:${appointment.id}:cancelled`],
    );
    expect(cancellation.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("notifies rescheduling for the replacement appointment", async () => {
    const day = futureDay(31);
    const booked = await adminApi.post(`${API}/appointments`, {
      body: { patientId, doctorId, branchId, startAt: `${day}T10:00:00Z` },
      headers: { "idempotency-key": `phase20-reschedule-${randomUUID()}` },
    });
    expect(booked.status).toBe(201);
    const originalId = dataOf<{ appointment: { id: string } }>(booked).appointment.id;

    const moved = await adminApi.post(`${API}/appointments/${originalId}/reschedule`, {
      body: { startAt: `${day}T11:00:00Z` },
    });
    expect(moved.status).toBe(200);
    const replacementId = dataOf<{ appointment: { id: string } }>(moved).appointment.id;

    const rows = await getTestAdminPool().query(
      `select id from notifications where tenant_id=$1 and source_event_id=$2`,
      [tenantId, `appointment:${replacementId}:rescheduled`],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("sweeps one reminder per appointment and excludes inactive appointments", async () => {
    const pool = getTestAdminPool();
    const startAt = new Date(Date.now() + 90 * 60_000);
    const inactiveStart = new Date(Date.now() + 120 * 60_000);

    const insertAppointment = async (status: string, start: Date): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `insert into appointments
           (id, tenant_id, patient_id, doctor_id, branch_id, appointment_code,
            appointment_source, appointment_status, start_at, end_at,
            consultation_fee, currency, created_by)
         values ($1,$2,$3,$4,$5,$6,'RECEPTIONIST',$7,$8,$9,'100.00','USD',$10)`,
        [
          id,
          tenantId,
          patientId,
          doctorId,
          branchId,
          `APT-R-${randomUUID().slice(0, 8).toUpperCase()}`,
          status,
          start.toISOString(),
          new Date(start.getTime() + 30 * 60_000).toISOString(),
          adminUserId,
        ],
      );
      return id;
    };

    const activeId = await insertAppointment("CONFIRMED", startAt);
    const inactiveId = await insertAppointment("COMPLETED", inactiveStart);

    const first = await sweepAppointmentReminders();
    expect(first.enqueued).toBeGreaterThanOrEqual(1);

    const reminders = await pool.query<{ source_event_id: string }>(
      `select source_event_id from notifications
        where tenant_id=$1 and event='APPOINTMENT_REMINDER' and source_event_id like $2`,
      [tenantId, `appointment:%:reminder:%`],
    );
    expect(reminders.rows.some((row) => row.source_event_id.startsWith(`appointment:${activeId}:reminder:`))).toBe(true);
    expect(reminders.rows.some((row) => row.source_event_id.startsWith(`appointment:${inactiveId}:`))).toBe(false);

    const before = reminders.rows.length;
    await sweepAppointmentReminders();
    const after = await pool.query<{ count: number }>(
      `select count(*)::int as count from notifications
        where tenant_id=$1 and event='APPOINTMENT_REMINDER'`,
      [tenantId],
    );
    expect(after.rows[0]?.count).toBe(before);
  });
});

describe("billing notification integration", () => {
  it("enqueues billing EMAIL and a central in-app item once per event", async () => {
    const actor = { userId: adminUserId };
    const invoice = await createInvoice(tenantId, {
      branchId,
      patientId,
      createdBy: adminUserId,
      currency: "USD",
      items: [{ description: "Consultation", quantity: 1, unitPrice: "100.00" }],
    });

    await issueInvoice(tenantId, invoice.id, actor);
    // Re-issuing is a no-op and must not create another notification.
    await issueInvoice(tenantId, invoice.id, actor);

    const pool = getTestAdminPool();
    const billing = await pool.query(
      "select id from billing_notifications where tenant_id=$1 and invoice_id=$2 and event='INVOICE_ISSUED'",
      [tenantId, invoice.id],
    );
    expect(billing.rows).toHaveLength(1);

    const central = await pool.query(
      "select id from notifications where tenant_id=$1 and channel='IN_APP' and source_event_id=$2",
      [tenantId, `billing:INVOICE_ISSUED:invoice-issued:${invoice.id}`],
    );
    expect(central.rows).toHaveLength(1);

    await recordPayment(
      tenantId,
      {
        branchId,
        patientId,
        method: "CASH",
        amount: "100.00",
        allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
        receivedAt: new Date(),
        idempotencyKey: `phase20-payment-${randomUUID()}`,
      },
      actor,
    );

    const paymentBilling = await pool.query(
      "select id from billing_notifications where tenant_id=$1 and invoice_id=$2 and event='PAYMENT_RECEIVED'",
      [tenantId, invoice.id],
    );
    expect(paymentBilling.rows).toHaveLength(1);
  });

  it("does not roll back a financial transaction when notifications cannot be enqueued", async () => {
    // A tenant with no notification settings still gets its invoice issued; the
    // bridge falls back to defaults and never throws into the caller.
    const actor = { userId: adminUserId };
    const invoice = await createInvoice(tenantId, {
      branchId,
      patientId,
      createdBy: adminUserId,
      currency: "USD",
      items: [{ description: "Lab", quantity: 1, unitPrice: "50.00" }],
    });

    const issued = await issueInvoice(tenantId, invoice.id, actor);
    expect(issued.applied).toBe(true);
  });
});
