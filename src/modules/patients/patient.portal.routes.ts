import { Router } from "express";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/authenticate.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  getPatientPortalProfileHandler,
  linkPatientAccountHandler,
  listPatientPortalHospitalsHandler,
  publicPatientRegistrationHandler,
} from "./patient.portal.controller.js";
import {
  linkPatientAccountSchema,
  patientPortalHospitalParamsSchema,
  publicPatientRegistrationSchema,
} from "./patient.portal.schemas.js";

/**
 * Patient portal. These routes intentionally do NOT require tenant membership:
 * a patient login is a global account linked to `patient_profiles.user_id`.
 * Tenant selection is by validated active hospital slug, and every profile read
 * is hard-scoped to the signed-in account's id.
 */
export const patientPortalRouter: Router = Router();

const patientRegistrationRateLimiter = createRateLimiter({
  windowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
  max: Math.max(20, env.AUTH_LOGIN_RATE_LIMIT_MAX * 2),
  keyGenerator: (req) => `patient-register|${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  message: "Too many patient registration attempts, please try again later",
});

patientPortalRouter.post(
  "/registrations",
  patientRegistrationRateLimiter,
  validate({ body: publicPatientRegistrationSchema }),
  publicPatientRegistrationHandler,
);

patientPortalRouter.post(
  "/portal/registrations",
  authenticate,
  csrfProtection,
  validate({ body: linkPatientAccountSchema }),
  linkPatientAccountHandler,
);

patientPortalRouter.get(
  "/portal/hospitals",
  authenticate,
  listPatientPortalHospitalsHandler,
);

patientPortalRouter.get(
  "/portal/hospitals/:hospitalSlug/profile",
  authenticate,
  validate({ params: patientPortalHospitalParamsSchema }),
  getPatientPortalProfileHandler,
);
