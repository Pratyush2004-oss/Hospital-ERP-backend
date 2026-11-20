import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { DatabaseTransaction } from "../../database/context.js";
import { withPlatformTransaction } from "../../database/context.js";
import {
  appointments,
  branches,
  doctors,
  patientProfiles,
  tenantSettings,
  tenants,
  users,
} from "../../database/schema/index.js";
import { logger } from "../../lib/logger.js";
import { formatNotificationInstant } from "./notification.recipients.js";
import { withReminderLock } from "./notification.worker.js";
import { enqueueNotificationsSafely } from "./notification.service.js";
import type {
  NotificationChannel,
  NotificationEvent,
  NotificationLocale,
} from "./notification.types.js";

/**
 * Appointment notifications and reminders (Phase 20.2).
 *
 * Hooks are called inside the booking/reschedule/cancel transaction and are
 * savepoint-protected, so a notification problem never rolls back an
 * appointment. Reminders are enqueued by a sweep over real appointment rows,
 * restricted to PENDING/CONFIRMED appointments that have not started yet, and
 * deduplicated by `appointment:<id>:reminder:<minutes>`.
 *
 * The appointment's branch timezone is used for rendering. No availability or
 * booking logic is duplicated here.
 */

export const APPOINTMENT_NOTIFICATION_SETTINGS_KEY = "appointment.notifications";

const settingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    channels: z
      .array(z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]))
      .min(1)
      .max(4)
      .default(["IN_APP", "EMAIL", "SMS"]),
    reminders: z.array(z.number().int().min(5).max(43_200)).max(10).default([1_440, 60]),
    locale: z.enum(["EN", "HI"]).default("EN"),
  })
  .strict();

export interface AppointmentNotificationSettings {
  readonly enabled: boolean;
  readonly channels: readonly NotificationChannel[];
  readonly reminders: readonly number[];
  readonly locale: NotificationLocale;
}

const DEFAULT_SETTINGS: AppointmentNotificationSettings = {
  enabled: true,
  channels: ["IN_APP", "EMAIL", "SMS"],
  reminders: [1_440, 60],
  locale: "EN",
};

function defaultRemindersFromEnv(): number[] {
  const parsed = env.APPOINTMENT_REMINDER_MINUTES.split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 5 && value <= 43_200);

  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => b - a) : [1_440, 60];
}

export async function loadAppointmentNotificationSettings(
  tx: DatabaseTransaction,
  tenantId: string,
): Promise<AppointmentNotificationSettings> {
  const [row] = await tx
    .select({ value: tenantSettings.settingValue })
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, tenantId),
        eq(tenantSettings.settingKey, APPOINTMENT_NOTIFICATION_SETTINGS_KEY),
      ),
    )
    .limit(1);

  const fallback: AppointmentNotificationSettings = {
    ...DEFAULT_SETTINGS,
    reminders: defaultRemindersFromEnv(),
  };

  if (!row) return fallback;

  const parsed = settingsSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.warn(
      { tenantId, setting: APPOINTMENT_NOTIFICATION_SETTINGS_KEY },
      "Invalid appointment notification settings; using defaults",
    );
    return fallback;
  }

  return {
    enabled: parsed.data.enabled,
    channels: parsed.data.channels,
    reminders: [...parsed.data.reminders].sort((a, b) => b - a),
    locale: parsed.data.locale,
  };
}

interface AppointmentNotificationContext {
  readonly appointmentId: string;
  readonly appointmentCode: string;
  readonly startAt: Date;
  readonly status: string;
  readonly patientUserId: string | null;
  readonly patientId: string;
  readonly branchTimezone: string;
  readonly branchName: string;
  readonly doctorName: string;
  readonly hospitalName: string;
}

const doctorUsers = alias(users, "notification_doctor_user");

async function loadAppointmentNotificationContext(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentNotificationContext | null> {
  const [row] = await tx
    .select({
      appointmentId: appointments.id,
      appointmentCode: appointments.appointmentCode,
      startAt: appointments.startAt,
      status: appointments.appointmentStatus,
      patientId: appointments.patientId,
      patientUserId: patientProfiles.userId,
      branchTimezone: branches.timezone,
      branchName: branches.name,
      doctorName: doctorUsers.fullName,
      hospitalName: tenants.name,
    })
    .from(appointments)
    .innerJoin(
      patientProfiles,
      and(
        eq(patientProfiles.tenantId, tenantId),
        eq(patientProfiles.id, appointments.patientId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.tenantId, tenantId), eq(branches.id, appointments.branchId)),
    )
    .innerJoin(
      doctors,
      and(eq(doctors.tenantId, tenantId), eq(doctors.id, appointments.doctorId)),
    )
    .innerJoin(doctorUsers, eq(doctorUsers.id, doctors.userId))
    .innerJoin(tenants, eq(tenants.id, tenantId))
    .where(
      and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)),
    )
    .limit(1);

  return row ?? null;
}

function variablesFor(
  context: AppointmentNotificationContext,
  locale: NotificationLocale,
): Record<string, string> {
  return {
    appointment_code: context.appointmentCode,
    appointment_time: formatNotificationInstant(context.startAt, context.branchTimezone, locale),
    branch_name: context.branchName,
    doctor_name: context.doctorName,
    hospital_name: context.hospitalName,
  };
}

async function enqueueForAppointment(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
  event: NotificationEvent,
  eventId: string,
  settingsOverride?: AppointmentNotificationSettings,
): Promise<number> {
  const savepoint = "appointment_notification_dispatch";
  await tx.execute(sql`savepoint appointment_notification_dispatch`);

  try {
    const settings =
      settingsOverride ?? (await loadAppointmentNotificationSettings(tx, tenantId));

    if (!settings.enabled) {
      await tx.execute(sql`release savepoint appointment_notification_dispatch`);
      return 0;
    }

    const context = await loadAppointmentNotificationContext(tx, tenantId, appointmentId);

    if (!context) {
      await tx.execute(sql`release savepoint appointment_notification_dispatch`);
      return 0;
    }

    const inserted = await enqueueNotificationsSafely(tx, {
      tenantId,
      userId: context.patientUserId ?? undefined,
      patientId: context.patientId,
      event,
      eventId,
      channels: settings.channels,
      locale: settings.locale,
      variables: variablesFor(context, settings.locale),
      tx,
    });

    await tx.execute(sql`release savepoint appointment_notification_dispatch`);
    return inserted;
  } catch (error) {
    try {
      await tx.execute(sql`rollback to savepoint appointment_notification_dispatch`);
      await tx.execute(sql`release savepoint appointment_notification_dispatch`);
    } catch {
      // The business transaction remains authoritative.
    }

    logger.warn(
      { tenantId, appointmentId, event, savepoint, err: error },
      "Appointment notification enqueue failed; appointment transaction preserved",
    );
    return 0;
  }
}

function safeEventIdPart(appointmentId: string): string {
  return `appointment:${appointmentId}`;
}

/** Booking/reschedule confirmation hook. */
export async function enqueueAppointmentConfirmedNotification(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<number> {
  return enqueueForAppointment(
    tx,
    tenantId,
    appointmentId,
    "APPOINTMENT_CONFIRMED",
    `${safeEventIdPart(appointmentId)}:confirmed`,
  );
}

export async function enqueueAppointmentBookedNotification(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<number> {
  return enqueueForAppointment(
    tx,
    tenantId,
    appointmentId,
    "APPOINTMENT_BOOKED",
    `${safeEventIdPart(appointmentId)}:booked`,
  );
}

export async function enqueueAppointmentRescheduledNotification(
  tx: DatabaseTransaction,
  tenantId: string,
  replacementAppointmentId: string,
): Promise<number> {
  return enqueueForAppointment(
    tx,
    tenantId,
    replacementAppointmentId,
    "APPOINTMENT_RESCHEDULED",
    `${safeEventIdPart(replacementAppointmentId)}:rescheduled`,
  );
}

export async function enqueueAppointmentCancelledNotification(
  tx: DatabaseTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<number> {
  return enqueueForAppointment(
    tx,
    tenantId,
    appointmentId,
    "APPOINTMENT_CANCELLED",
    `${safeEventIdPart(appointmentId)}:cancelled`,
  );
}

interface ReminderCandidate {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly startAt: Date;
}

/**
 * One reminder sweep. Only appointments that are still upcoming and whose
 * status can legitimately receive a reminder are considered; cancelled,
 * completed, no-show, rescheduled and started appointments are excluded by the
 * status filter. The most urgent threshold already crossed is used, so a worker
 * outage does not flood the patient with every missed reminder.
 */
export async function sweepAppointmentReminders(
  now: Date = new Date(),
): Promise<{ scanned: number; enqueued: number }> {
  return withPlatformTransaction(async (tx) => {
    const candidates = await tx
      .select({
        tenantId: appointments.tenantId,
        appointmentId: appointments.id,
        startAt: appointments.startAt,
      })
      .from(appointments)
      .where(
        and(
          inArray(appointments.appointmentStatus, ["PENDING", "CONFIRMED"]),
          sql`${appointments.startAt} > ${now}`,
          sql`${appointments.startAt} <= ${new Date(now.getTime() + 43_200 * 60_000)}`,
        ),
      );

    const settingsByTenant = new Map<string, AppointmentNotificationSettings>();
    let enqueued = 0;

    for (const candidate of candidates as ReminderCandidate[]) {
      let settings = settingsByTenant.get(candidate.tenantId);
      if (!settings) {
        settings = await loadAppointmentNotificationSettings(tx, candidate.tenantId);
        settingsByTenant.set(candidate.tenantId, settings);
      }

      if (!settings.enabled || settings.reminders.length === 0) continue;

      const dueMinutes = [...settings.reminders]
        .sort((a, b) => a - b)
        .find((minutes) => now.getTime() >= candidate.startAt.getTime() - minutes * 60_000);

      if (dueMinutes === undefined) continue;

      enqueued += await enqueueForAppointment(
        tx,
        candidate.tenantId,
        candidate.appointmentId,
        "APPOINTMENT_REMINDER",
        `${safeEventIdPart(candidate.appointmentId)}:reminder:${dueMinutes}`,
        settings,
      );
    }

    return { scanned: candidates.length, enqueued };
  });
}

let reminderTimer: NodeJS.Timeout | null = null;

export function startAppointmentReminderScheduler(): () => void {
  if (!env.APPOINTMENT_REMINDER_SCHEDULER_ENABLED || reminderTimer !== null) {
    return () => undefined;
  }

  reminderTimer = setInterval(() => {
    void withReminderLock(() => sweepAppointmentReminders()).catch((error: unknown) => {
      logger.error({ err: error }, "Appointment reminder sweep failed");
    });
  }, env.APPOINTMENT_REMINDER_INTERVAL_MS);
  reminderTimer.unref();

  logger.info(
    { intervalMs: env.APPOINTMENT_REMINDER_INTERVAL_MS },
    "Appointment reminder scheduler started",
  );

  return stopAppointmentReminderScheduler;
}

export function stopAppointmentReminderScheduler(): void {
  if (reminderTimer !== null) {
    clearInterval(reminderTimer);
    reminderTimer = null;
    logger.info("Appointment reminder scheduler stopped");
  }
}
