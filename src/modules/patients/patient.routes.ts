import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  addPatientAddressHandler,
  addPatientContactHandler,
  addPatientEmergencyContactHandler,
  createPatientHandler,
  deletePatientAddressHandler,
  deletePatientContactHandler,
  deletePatientEmergencyContactHandler,
  deletePatientHandler,
  getPatientHandler,
  listPatientAddressesHandler,
  listPatientContactsHandler,
  listPatientEmergencyContactsHandler,
  listPatientsHandler,
  setPrimaryPatientAddressHandler,
  setPrimaryPatientContactHandler,
  updatePatientAddressHandler,
  updatePatientContactHandler,
  updatePatientEmergencyContactHandler,
  updatePatientHandler,
  updatePatientStatusHandler,
} from "./patient.controller.js";
import {
  addPatientAddressSchema,
  addPatientContactSchema,
  addPatientEmergencyContactSchema,
  createPatientSchema,
  listPatientsQuerySchema,
  patientAddressParamsSchema,
  patientContactParamsSchema,
  patientEmergencyContactParamsSchema,
  patientIdParamsSchema,
  updatePatientAddressSchema,
  updatePatientContactSchema,
  updatePatientEmergencyContactSchema,
  updatePatientSchema,
  updatePatientStatusSchema,
} from "./patient.schemas.js";

/**
 * Hospital plane patient registration and profiles.
 *
 * The tenant id always comes from the verified session context via
 * `requireTenant`; no route reads it from the URL, query string or body.
 * Permission keys are the ones already seeded in the RBAC catalogue:
 *
 *   patient:create - registration (including an authorized account link)
 *   patient:read   - profile and list/search
 *   patient:update - profile and status changes
 *   patient:delete - soft delete / archive
 *
 * Linking a global account additionally requires `patient:update`, which the
 * patient service checks from the same verified actor.
 */
export const patientRouter: Router = Router();

patientRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:create"),
  validate({ body: createPatientSchema }),
  createPatientHandler,
);

patientRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("patient:read"),
  validate({ query: listPatientsQuerySchema }),
  listPatientsHandler,
);

patientRouter.get(
  "/:patientId",
  authenticate,
  requireTenant,
  requirePermission("patient:read"),
  validate({ params: patientIdParamsSchema }),
  getPatientHandler,
);

patientRouter.patch(
  "/:patientId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientIdParamsSchema, body: updatePatientSchema }),
  updatePatientHandler,
);

patientRouter.patch(
  "/:patientId/status",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientIdParamsSchema, body: updatePatientStatusSchema }),
  updatePatientStatusHandler,
);

patientRouter.delete(
  "/:patientId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:delete"),
  validate({ params: patientIdParamsSchema }),
  deletePatientHandler,
);

/* -------------------------------------------------------------------------
 * Task 17.6 - contacts, addresses and emergency contacts.
 *
 * Reads require `patient:read`; every mutation requires `patient:update`
 * (including deletion of a child row - `patient:delete` is reserved for
 * archiving the patient profile itself). Each handler validates both ids, and
 * the service re-checks tenant, patient ownership and mutable status.
 * ---------------------------------------------------------------------- */

patientRouter.post(
  "/:patientId/contacts",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientIdParamsSchema, body: addPatientContactSchema }),
  addPatientContactHandler,
);

patientRouter.get(
  "/:patientId/contacts",
  authenticate,
  requireTenant,
  requirePermission("patient:read"),
  validate({ params: patientIdParamsSchema }),
  listPatientContactsHandler,
);

patientRouter.patch(
  "/:patientId/contacts/:contactId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientContactParamsSchema, body: updatePatientContactSchema }),
  updatePatientContactHandler,
);

patientRouter.patch(
  "/:patientId/contacts/:contactId/primary",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientContactParamsSchema }),
  setPrimaryPatientContactHandler,
);

patientRouter.delete(
  "/:patientId/contacts/:contactId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientContactParamsSchema }),
  deletePatientContactHandler,
);

patientRouter.post(
  "/:patientId/addresses",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientIdParamsSchema, body: addPatientAddressSchema }),
  addPatientAddressHandler,
);

patientRouter.get(
  "/:patientId/addresses",
  authenticate,
  requireTenant,
  requirePermission("patient:read"),
  validate({ params: patientIdParamsSchema }),
  listPatientAddressesHandler,
);

patientRouter.patch(
  "/:patientId/addresses/:addressId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientAddressParamsSchema, body: updatePatientAddressSchema }),
  updatePatientAddressHandler,
);

patientRouter.patch(
  "/:patientId/addresses/:addressId/primary",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientAddressParamsSchema }),
  setPrimaryPatientAddressHandler,
);

patientRouter.delete(
  "/:patientId/addresses/:addressId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientAddressParamsSchema }),
  deletePatientAddressHandler,
);

patientRouter.post(
  "/:patientId/emergency-contacts",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientIdParamsSchema, body: addPatientEmergencyContactSchema }),
  addPatientEmergencyContactHandler,
);

patientRouter.get(
  "/:patientId/emergency-contacts",
  authenticate,
  requireTenant,
  requirePermission("patient:read"),
  validate({ params: patientIdParamsSchema }),
  listPatientEmergencyContactsHandler,
);

patientRouter.patch(
  "/:patientId/emergency-contacts/:emergencyContactId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({
    params: patientEmergencyContactParamsSchema,
    body: updatePatientEmergencyContactSchema,
  }),
  updatePatientEmergencyContactHandler,
);

patientRouter.delete(
  "/:patientId/emergency-contacts/:emergencyContactId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("patient:update"),
  validate({ params: patientEmergencyContactParamsSchema }),
  deletePatientEmergencyContactHandler,
);
