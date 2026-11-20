import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_STATUSES,
} from "./notification.types.js";

/**
 * Notification API validation (Phase 20.2).
 *
 * Bodies are strict: `userId` and `tenantId` are rejected rather than silently
 * ignored, because ownership and tenancy always come from the session context.
 */

const booleanQuery = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

export const notificationIdParamsSchema = z.object({
  notificationId: z.uuid("Notification id must be a UUID"),
});

export const listNotificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(NOTIFICATION_STATUSES).optional(),
    channel: z.enum(NOTIFICATION_CHANNELS).optional(),
    event: z.enum(NOTIFICATION_EVENTS).optional(),
    unreadOnly: booleanQuery,
  })
  .strict();

export const updateNotificationPreferenceSchema = z
  .object({
    event: z.enum(NOTIFICATION_EVENTS).nullable().optional(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    enabled: z.boolean(),
    tenantDefault: z.boolean().default(false),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type UpdateNotificationPreferenceBody = z.infer<
  typeof updateNotificationPreferenceSchema
>;
