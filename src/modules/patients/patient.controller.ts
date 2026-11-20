import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import type { PatientActorContext } from "./patient.types.js";
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
import {
  addPatientAddress,
  deletePatientAddress,
  listPatientAddresses,
  setPrimaryPatientAddress,
  updatePatientAddress,
} from "./patient.addresses.service.js";
import {
  addPatientContact,
  deletePatientContact,
  listPatientContacts,
  setPrimaryPatientContact,
  updatePatientContact,
} from "./patient.contacts.service.js";
import {
  addPatientEmergencyContact,
  deletePatientEmergencyContact,
  listPatientEmergencyContacts,
  updatePatientEmergencyContact,
} from "./patient.emergency-contacts.service.js";
import {
  createPatient,
  deletePatient,
  getPatientById,
  listPatients,
  updatePatient,
  updatePatientStatus,
} from "./patient.service.js";

/**
 * HTTP-only layer for patient registration and profiles.
 *
 * Actor identity, roles and permissions come from the verified request context
 * only, never from the body or query string. The patient service owns every
 * tenant, duplicate-code, account-link and status decision.
 */

function patientActor(): PatientActorContext {
  const actor = requireTenantScope();

  return { userId: actor.userId, permissions: actor.permissions };
}

/** Maps inclusive calendar-date bounds onto the service's registration filter. */
function registrationBound(date: string | undefined, edge: "start" | "end"): Date | undefined {
  if (date === undefined) return undefined;

  return new Date(`${date}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
}

export const createPatientHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createPatientSchema>(req, "body");
  const patient = await createPatient(actor.tenantId, input, patientActor());

  sendCreated(res, { patient });
};

export const listPatientsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listPatientsQuerySchema>(req, "query");
  const result = await listPatients(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    search: query.search,
    status: query.status,
    gender: query.gender,
    registeredFrom: registrationBound(query.dateFrom, "start"),
    registeredTo: registrationBound(query.dateTo, "end"),
  });

  sendSuccess(res, { patients: result.patients }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getPatientHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const patient = await getPatientById(actor.tenantId, params.patientId);

  sendSuccess(res, { patient });
};

export const updatePatientHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const input = getValidated<typeof updatePatientSchema>(req, "body");
  const patient = await updatePatient(actor.tenantId, params.patientId, input, patientActor());

  sendSuccess(res, { patient });
};

export const updatePatientStatusHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const input = getValidated<typeof updatePatientStatusSchema>(req, "body");
  const patient = await updatePatientStatus(
    actor.tenantId,
    params.patientId,
    input.status,
    patientActor(),
  );

  sendSuccess(res, { patient });
};

export const deletePatientHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  await deletePatient(actor.tenantId, params.patientId, patientActor());

  sendNoContent(res);
};

/* -------------------------------------------------------------------------
 * Task 17.6 - child records (contacts, addresses, emergency contacts)
 *
 * The services own normalisation, deduplication, primary selection, status and
 * tenant/patient ownership checks. These handlers only translate validated
 * input into a service call and wrap the result in the standard envelope.
 * ---------------------------------------------------------------------- */

export const addPatientContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const input = getValidated<typeof addPatientContactSchema>(req, "body");
  const contact = await addPatientContact(
    actor.tenantId,
    params.patientId,
    input,
    patientActor(),
  );

  sendCreated(res, { contact });
};

export const listPatientContactsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientContactParamsSchema>(req, "params");
  const contacts = await listPatientContacts(actor.tenantId, params.patientId);

  sendSuccess(res, { contacts });
};

export const updatePatientContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientContactParamsSchema>(req, "params");
  const input = getValidated<typeof updatePatientContactSchema>(req, "body");
  const contact = await updatePatientContact(
    actor.tenantId,
    params.patientId,
    params.contactId,
    input,
    patientActor(),
  );

  sendSuccess(res, { contact });
};

export const setPrimaryPatientContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientContactParamsSchema>(req, "params");
  const contact = await setPrimaryPatientContact(
    actor.tenantId,
    params.patientId,
    params.contactId,
    patientActor(),
  );

  sendSuccess(res, { contact });
};

export const deletePatientContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientContactParamsSchema>(req, "params");
  await deletePatientContact(actor.tenantId, params.patientId, params.contactId, patientActor());

  sendNoContent(res);
};

export const addPatientAddressHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const input = getValidated<typeof addPatientAddressSchema>(req, "body");
  const address = await addPatientAddress(
    actor.tenantId,
    params.patientId,
    input,
    patientActor(),
  );

  sendCreated(res, { address });
};

export const listPatientAddressesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientAddressParamsSchema>(req, "params");
  const addresses = await listPatientAddresses(actor.tenantId, params.patientId);

  sendSuccess(res, { addresses });
};

export const updatePatientAddressHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientAddressParamsSchema>(req, "params");
  const input = getValidated<typeof updatePatientAddressSchema>(req, "body");
  const address = await updatePatientAddress(
    actor.tenantId,
    params.patientId,
    params.addressId,
    input,
    patientActor(),
  );

  sendSuccess(res, { address });
};

export const setPrimaryPatientAddressHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientAddressParamsSchema>(req, "params");
  const address = await setPrimaryPatientAddress(
    actor.tenantId,
    params.patientId,
    params.addressId,
    patientActor(),
  );

  sendSuccess(res, { address });
};

export const deletePatientAddressHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientAddressParamsSchema>(req, "params");
  await deletePatientAddress(actor.tenantId, params.patientId, params.addressId, patientActor());

  sendNoContent(res);
};

export const addPatientEmergencyContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientIdParamsSchema>(req, "params");
  const input = getValidated<typeof addPatientEmergencyContactSchema>(req, "body");
  const emergencyContact = await addPatientEmergencyContact(
    actor.tenantId,
    params.patientId,
    input,
    patientActor(),
  );

  sendCreated(res, { emergencyContact });
};

export const listPatientEmergencyContactsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientEmergencyContactParamsSchema>(req, "params");
  const emergencyContacts = await listPatientEmergencyContacts(
    actor.tenantId,
    params.patientId,
  );

  sendSuccess(res, { emergencyContacts });
};

export const updatePatientEmergencyContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientEmergencyContactParamsSchema>(req, "params");
  const input = getValidated<typeof updatePatientEmergencyContactSchema>(req, "body");
  const emergencyContact = await updatePatientEmergencyContact(
    actor.tenantId,
    params.patientId,
    params.emergencyContactId,
    input,
    patientActor(),
  );

  sendSuccess(res, { emergencyContact });
};

export const deletePatientEmergencyContactHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof patientEmergencyContactParamsSchema>(req, "params");
  await deletePatientEmergencyContact(
    actor.tenantId,
    params.patientId,
    params.emergencyContactId,
    patientActor(),
  );

  sendNoContent(res);
};
