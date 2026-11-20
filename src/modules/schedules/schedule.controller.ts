import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  createDoctorScheduleSchema,
  doctorScheduleIdParamsSchema,
  listDoctorSchedulesQuerySchema,
  updateDoctorScheduleSchema,
  updateDoctorScheduleStatusSchema,
} from "./schedule.schemas.js";
import {
  createDoctorSchedule,
  deleteDoctorSchedule,
  getDoctorScheduleById,
  listDoctorSchedules,
  updateDoctorSchedule,
  updateDoctorScheduleStatus,
} from "./schedule.service.js";

/**
 * HTTP-only layer for doctor schedules: no database access and no business
 * rules live here. The tenant always comes from the verified request context.
 */

export const createDoctorScheduleHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createDoctorScheduleSchema>(req, "body");
  const schedule = await createDoctorSchedule(actor.tenantId, input);

  sendCreated(res, { schedule });
};

export const listDoctorSchedulesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listDoctorSchedulesQuerySchema>(req, "query");
  const result = await listDoctorSchedules(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    doctorId: query.doctorId,
    branchId: query.branchId,
    dayOfWeek: query.dayOfWeek,
    isActive: query.isActive,
    effectiveOn: query.effectiveDate,
  });

  sendSuccess(res, { schedules: result.schedules }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getDoctorScheduleHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorScheduleIdParamsSchema>(req, "params");
  const schedule = await getDoctorScheduleById(actor.tenantId, params.id);

  sendSuccess(res, { schedule });
};

export const updateDoctorScheduleHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorScheduleIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorScheduleSchema>(req, "body");
  const schedule = await updateDoctorSchedule(actor.tenantId, params.id, input);

  sendSuccess(res, { schedule });
};

export const updateDoctorScheduleStatusHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorScheduleIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorScheduleStatusSchema>(req, "body");
  const schedule = await updateDoctorScheduleStatus(
    actor.tenantId,
    params.id,
    input.isActive,
  );

  sendSuccess(res, { schedule });
};

export const deleteDoctorScheduleHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorScheduleIdParamsSchema>(req, "params");
  await deleteDoctorSchedule(actor.tenantId, params.id);

  sendNoContent(res);
};
