import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  getNotificationHandler,
  getUnreadNotificationCountHandler,
  listNotificationPreferencesHandler,
  listNotificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
  updateNotificationPreferenceHandler,
} from "./notification.controller.js";
import {
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
  updateNotificationPreferenceSchema,
} from "./notification.schemas.js";

/**
 * Hospital-plane notification API (Phase 20.2).
 *
 * Authorization is recipient ownership: an authenticated hospital member can
 * read and acknowledge only their own notifications, and can edit only their
 * own preferences. Tenant membership is enforced by `requireTenant`, and the
 * SQL filters repeat both the tenant and recipient predicates. Cross-tenant and
 * cross-user ids therefore return 404 without disclosing existence.
 *
 * No route accepts a user id or tenant id from the client.
 */
export const notificationRouter: Router = Router();

/* Registered before `/:notificationId` so these literals are never parsed as ids. */
notificationRouter.get(
  "/unread-count",
  authenticate,
  requireTenant,
  getUnreadNotificationCountHandler,
);

notificationRouter.get(
  "/preferences",
  authenticate,
  requireTenant,
  listNotificationPreferencesHandler,
);

notificationRouter.patch(
  "/preferences",
  authenticate,
  csrfProtection,
  requireTenant,
  validate({ body: updateNotificationPreferenceSchema }),
  updateNotificationPreferenceHandler,
);

notificationRouter.post(
  "/read-all",
  authenticate,
  csrfProtection,
  requireTenant,
  markAllNotificationsReadHandler,
);

notificationRouter.get(
  "/",
  authenticate,
  requireTenant,
  validate({ query: listNotificationsQuerySchema }),
  listNotificationsHandler,
);

notificationRouter.get(
  "/:notificationId",
  authenticate,
  requireTenant,
  validate({ params: notificationIdParamsSchema }),
  getNotificationHandler,
);

notificationRouter.post(
  "/:notificationId/read",
  authenticate,
  csrfProtection,
  requireTenant,
  validate({ params: notificationIdParamsSchema }),
  markNotificationReadHandler,
);
