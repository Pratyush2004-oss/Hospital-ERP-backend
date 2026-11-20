import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { withTenantTransaction } from "../../database/context.js";
import {
  notificationPreferences,
  notifications,
} from "../../database/schema/index.js";
import { AppError } from "../../lib/http-error.js";
import type {
  NotificationChannel,
  NotificationDto,
  NotificationEvent,
  NotificationPage,
  NotificationPreferenceDto,
  NotificationStatus,
  UpsertNotificationPreferenceInput,
} from "./notification.types.js";

/**
 * Recipient-owned notification reads and preference management (Phase 20.2).
 *
 * Every query is scoped by the verified tenant AND the authenticated user id.
 * A user id from the request is never trusted: the actor id comes from the
 * session context. Cross-user and cross-tenant ids resolve as 404, so the API
 * does not disclose whether another user's notification exists.
 */

export interface ListNotificationsFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: NotificationStatus;
  readonly channel?: NotificationChannel;
  readonly event?: NotificationEvent;
  readonly unreadOnly?: boolean;
}

interface NotificationRow {
  readonly id: string;
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly subject: string | null;
  readonly body: string;
  readonly payload: unknown;
  readonly readAt: Date | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    event: row.event as NotificationEvent,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    body: row.body,
    payload:
      row.payload !== null && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
    readAt: row.readAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const NOTIFICATION_COLUMNS = {
  id: notifications.id,
  event: notifications.event,
  channel: notifications.channel,
  status: notifications.status,
  subject: notifications.subject,
  body: notifications.body,
  payload: notifications.payload,
  readAt: notifications.readAt,
  sentAt: notifications.sentAt,
  createdAt: notifications.createdAt,
};

function validatePagination(page: number | undefined, pageSize: number | undefined) {
  const resolvedPage = page ?? 1;
  const resolvedPageSize = pageSize ?? 20;

  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    throw AppError.validation("page must be a positive integer", { field: "page" });
  }

  if (!Number.isInteger(resolvedPageSize) || resolvedPageSize < 1 || resolvedPageSize > 100) {
    throw AppError.validation("limit must be between 1 and 100", { field: "limit" });
  }

  return { page: resolvedPage, pageSize: resolvedPageSize };
}

export async function listNotifications(
  tenantId: string,
  userId: string,
  filters: ListNotificationsFilters = {},
): Promise<NotificationPage> {
  const { page, pageSize } = validatePagination(filters.page, filters.pageSize);

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions: SQL[] = [
      eq(notifications.tenantId, tenantId),
      eq(notifications.userId, userId),
    ];

    if (filters.status !== undefined) {
      conditions.push(eq(notifications.status, filters.status));
    }
    if (filters.channel !== undefined) {
      conditions.push(eq(notifications.channel, filters.channel));
    }
    if (filters.event !== undefined) {
      conditions.push(eq(notifications.event, filters.event));
    }
    if (filters.unreadOnly === true) {
      conditions.push(isNull(notifications.readAt));
      conditions.push(eq(notifications.channel, "IN_APP"));
    }

    const where = and(...conditions);

    const [countRows, rows] = await Promise.all([
      tx.select({ total: sql<number>`count(*)::int` }).from(notifications).where(where),
      tx
        .select(NOTIFICATION_COLUMNS)
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      notifications: rows.map(toNotificationDto),
    };
  });
}

export async function getNotificationById(
  tenantId: string,
  userId: string,
  notificationId: string,
): Promise<NotificationDto> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select(NOTIFICATION_COLUMNS)
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      )
      .limit(1);

    if (!row) throw AppError.notFound("Notification not found");
    return toNotificationDto(row);
  });
}

export async function getUnreadNotificationCount(
  tenantId: string,
  userId: string,
): Promise<number> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.channel, "IN_APP"),
          isNull(notifications.readAt),
        ),
      );

    return row?.total ?? 0;
  });
}

export async function markNotificationRead(
  tenantId: string,
  userId: string,
  notificationId: string,
): Promise<{ notification: NotificationDto; applied: boolean }> {
  return withTenantTransaction(tenantId, async (tx) => {
    const [updated] = await tx
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.channel, "IN_APP"),
          isNull(notifications.readAt),
        ),
      )
      .returning(NOTIFICATION_COLUMNS);

    if (updated) {
      return { notification: toNotificationDto(updated), applied: true };
    }

    // Distinguish "already read" from "not yours / not an in-app notification".
    const [existing] = await tx
      .select(NOTIFICATION_COLUMNS)
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) throw AppError.notFound("Notification not found");

    if (existing.channel !== "IN_APP") {
      throw AppError.unprocessable("Only in-app notifications can be marked as read");
    }

    return { notification: toNotificationDto(existing), applied: false };
  });
}

export async function markAllNotificationsRead(
  tenantId: string,
  userId: string,
): Promise<{ updated: number }> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.channel, "IN_APP"),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });

    return { updated: rows.length };
  });
}

function toPreferenceDto(row: {
  id: string;
  event: string | null;
  channel: NotificationChannel;
  enabled: boolean;
  userId: string | null;
  updatedAt: Date;
}): NotificationPreferenceDto {
  return {
    id: row.id,
    event: row.event === null ? null : (row.event as NotificationEvent),
    channel: row.channel,
    enabled: row.enabled,
    isTenantDefault: row.userId === null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lists the caller's overrides plus the tenant-wide defaults they inherit. */
export async function listNotificationPreferences(
  tenantId: string,
  userId: string,
): Promise<{ preferences: NotificationPreferenceDto[] }> {
  return withTenantTransaction(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: notificationPreferences.id,
        event: notificationPreferences.event,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
        userId: notificationPreferences.userId,
        updatedAt: notificationPreferences.updatedAt,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, tenantId),
          or(
            isNull(notificationPreferences.userId),
            eq(notificationPreferences.userId, userId),
          ),
        ),
      )
      .orderBy(notificationPreferences.channel, notificationPreferences.event);

    return { preferences: rows.map(toPreferenceDto) };
  });
}

/**
 * Creates or updates one preference. Personal scopes are always the caller;
 * a tenant-wide default requires `staff:update`, checked by the controller.
 */
export async function upsertNotificationPreference(
  tenantId: string,
  userId: string,
  input: UpsertNotificationPreferenceInput,
  options: { readonly tenantDefault: boolean },
): Promise<NotificationPreferenceDto> {
  const ownerId = options.tenantDefault ? null : userId;

  return withTenantTransaction(tenantId, async (tx) => {
    const conditions: SQL[] = [
      eq(notificationPreferences.tenantId, tenantId),
      eq(notificationPreferences.channel, input.channel),
      ownerId === null
        ? isNull(notificationPreferences.userId)
        : eq(notificationPreferences.userId, ownerId),
      input.event === null
        ? isNull(notificationPreferences.event)
        : eq(notificationPreferences.event, input.event),
    ];

    const [existing] = await tx
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(and(...conditions))
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(notificationPreferences)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(
          and(
            eq(notificationPreferences.id, existing.id),
            eq(notificationPreferences.tenantId, tenantId),
          ),
        )
        .returning({
          id: notificationPreferences.id,
          event: notificationPreferences.event,
          channel: notificationPreferences.channel,
          enabled: notificationPreferences.enabled,
          userId: notificationPreferences.userId,
          updatedAt: notificationPreferences.updatedAt,
        });

      if (!updated) throw AppError.internal("Failed to update the notification preference");
      return toPreferenceDto(updated);
    }

    const [created] = await tx
      .insert(notificationPreferences)
      .values({
        tenantId,
        userId: ownerId,
        event: input.event,
        channel: input.channel,
        enabled: input.enabled,
      })
      .returning({
        id: notificationPreferences.id,
        event: notificationPreferences.event,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
        userId: notificationPreferences.userId,
        updatedAt: notificationPreferences.updatedAt,
      });

    if (!created) throw AppError.internal("Failed to create the notification preference");
    return toPreferenceDto(created);
  });
}
