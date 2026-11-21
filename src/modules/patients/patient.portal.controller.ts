import type { RequestHandler } from "express";
import { sendCreated, sendSuccess } from "../../lib/api-response.js";
import { requireAuthenticatedUser } from "../auth/auth.middleware.js";
import { getValidated } from "../../middleware/validate.js";
import {
  linkPatientAccountSchema,
  patientPortalHospitalParamsSchema,
  publicPatientRegistrationSchema,
} from "./patient.portal.schemas.js";
import {
  getPatientPortalProfile,
  linkPatientToHospital,
  listPatientPortalHospitals,
  registerPatientAccount,
} from "./patient.portal.service.js";

export const publicPatientRegistrationHandler: RequestHandler = async (req, res) => {
  const input = getValidated<typeof publicPatientRegistrationSchema>(req, "body");
  const result = await registerPatientAccount(input);

  sendCreated(res, {
    user: result.user,
    patient: result.patient,
    accountCreated: result.accountCreated,
    requiresEmailVerification: result.requiresEmailVerification,
  });
};

export const linkPatientAccountHandler: RequestHandler = async (req, res) => {
  const actor = requireAuthenticatedUser();
  const input = getValidated<typeof linkPatientAccountSchema>(req, "body");
  const result = await linkPatientToHospital(actor.userId, input);

  sendCreated(res, {
    patient: result.patient,
    accountCreated: result.accountCreated,
    requiresEmailVerification: result.requiresEmailVerification,
  });
};

export const listPatientPortalHospitalsHandler: RequestHandler = async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const hospitals = await listPatientPortalHospitals(actor.userId);

  sendSuccess(res, { hospitals });
};

export const getPatientPortalProfileHandler: RequestHandler = async (req, res) => {
  const actor = requireAuthenticatedUser();
  const params = getValidated<typeof patientPortalHospitalParamsSchema>(req, "params");
  const result = await getPatientPortalProfile(actor.userId, params.hospitalSlug);

  sendSuccess(res, { patient: result.patient });
};
