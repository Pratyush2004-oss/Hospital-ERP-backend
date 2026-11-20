import type { RequestHandler } from "express";
import { sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  getNotificationById,
  getUnreadNotificationCount,
  listNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  upsertNotificationPreference,
} from "./notification.query.service.js";
import {
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
  updateNotificationPreferenceSchema,
} from "./notification.schemas.js";

/**
 * HTTP layer for the notification API.
 *
 * The recipient id always comes from `requireTenantScope()`; no handler reads a
 * user or tenant id from the request. Services repeat the ownership and tenant
 * filters in SQL, so an application-level mistake cannot widen the result set.
 */

export const listNotificationsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listNotificationsQuerySchema>(req, "query");

  const result = await listNotifications(actor.tenantId, actor.userId, {
    page: query.page,
    pageSize: query.limit,
    status: query.status,
    channel: query.channel,
    event: query.event,
    unreadOnly: query.unreadOnly,
  });

  sendSuccess(res, { notifications: result.notifications }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getUnreadNotificationCountHandler: RequestHandler = async (_req, res) => {
  const actor = requireTenantScope();
  const unread = await getUnreadNotificationCount(actor.tenantId, actor.userId);
  sendSuccess(res, { unread });
};

export const getNotificationHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof notificationIdParamsSchema>(req, "params");
  const notification = await getNotificationById(
    actor.tenantId,
    actor.userId,
    params.notificationId,
  );

  sendSuccess(res, { notification });
};

export const markNotificationReadHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof notificationIdParamsSchema>(req, "params");
  const result = await markNotificationRead(
    actor.tenantId,
    actor.userId,
    params.notificationId,
  );

  sendSuccess(res, { notification: result.notification, applied: result.applied });
};

export const markAllNotificationsReadHandler: RequestHandler = async (_req, res) => {
  const actor = requireTenantScope();
  const result = await markAllNotificationsRead(actor.tenantId, actor.userId);
  sendSuccess(res, { updated: result.updated });
};

export const listNotificationPreferencesHandler: RequestHandler = async (_req, res) => {
  const actor = requireTenantScope();
  const preferences = await listNotificationPreferences(actor.tenantId, actor.userId);
  sendSuccess(res, preferences);
};

export const updateNotificationPreferenceHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const body = getValidated<typeof updateNotificationPreferenceSchema>(req, "body");

  // Tenant-wide defaults affect every member, so they are an administrative
  // action. Personal preferences never need a separate permission because the
  // actor can only write their own row.
  if (body.tenantDefault && !actor.permissions.has("staff:update")) {
    throw AppError.forbidden("You do not have permission to update tenant notification defaults");
  }

  const preference = await upsertNotificationPreference(
    actor.tenantId,
    actor.userId,
    {
      event: body.event ?? null,
      channel: body.channel,
      enabled: body.enabled,
    },
    { tenantDefault: body.tenantDefault },
  );

  sendSuccess(res, { preference });
};
