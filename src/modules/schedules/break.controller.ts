import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  createDoctorBreakSchema,
  doctorBreakIdParamsSchema,
  listDoctorBreaksQuerySchema,
  updateDoctorBreakSchema,
} from "./break.schemas.js";
import {
  createDoctorBreak,
  deleteDoctorBreak,
  getDoctorBreakById,
  listDoctorBreaks,
  updateDoctorBreak,
} from "./break.service.js";

/** HTTP-only layer for doctor breaks; all business rules stay in the service. */

export const createDoctorBreakHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createDoctorBreakSchema>(req, "body");
  const doctorBreak = await createDoctorBreak(actor.tenantId, input);

  sendCreated(res, { break: doctorBreak });
};

export const listDoctorBreaksHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listDoctorBreaksQuerySchema>(req, "query");
  const result = await listDoctorBreaks(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    scheduleId: query.scheduleId,
    doctorId: query.doctorId,
    branchId: query.branchId,
  });

  sendSuccess(res, { breaks: result.breaks }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getDoctorBreakHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorBreakIdParamsSchema>(req, "params");
  const doctorBreak = await getDoctorBreakById(actor.tenantId, params.id);

  sendSuccess(res, { break: doctorBreak });
};

export const updateDoctorBreakHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorBreakIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorBreakSchema>(req, "body");
  const doctorBreak = await updateDoctorBreak(actor.tenantId, params.id, input);

  sendSuccess(res, { break: doctorBreak });
};

export const deleteDoctorBreakHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorBreakIdParamsSchema>(req, "params");
  await deleteDoctorBreak(actor.tenantId, params.id);

  sendNoContent(res);
};
