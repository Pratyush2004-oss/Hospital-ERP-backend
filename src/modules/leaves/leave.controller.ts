import type { RequestHandler } from "express";
import { sendCreated, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import type { DoctorLeaveActorContext } from "./leave.types.js";
import {
  createDoctorLeaveSchema,
  doctorLeaveIdParamsSchema,
  listDoctorLeavesQuerySchema,
  rejectDoctorLeaveSchema,
  updateDoctorLeaveSchema,
} from "./leave.schemas.js";
import {
  approveDoctorLeave,
  cancelDoctorLeave,
  createDoctorLeave,
  getDoctorLeaveById,
  listDoctorLeaves,
  rejectDoctorLeave,
  updateDoctorLeave,
} from "./leave.service.js";

/**
 * HTTP-only layer for doctor leave.
 *
 * Actor identity, roles and permissions come from the verified request context
 * only — never from the body. The leave service performs every workflow,
 * status, conflict and authorization decision.
 */

function leaveActor(): DoctorLeaveActorContext {
  const actor = requireTenantScope();

  return {
    userId: actor.userId,
    permissions: actor.permissions,
    roles: actor.roles,
  };
}

export const createDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createDoctorLeaveSchema>(req, "body");
  const leave = await createDoctorLeave(actor.tenantId, input, leaveActor());

  sendCreated(res, { leave });
};

export const listDoctorLeavesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listDoctorLeavesQuerySchema>(req, "query");
  const result = await listDoctorLeaves(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    doctorId: query.doctorId,
    branchId: query.branchId,
    status: query.status,
    startDate: query.startDate,
    endDate: query.endDate,
  });

  sendSuccess(res, { leaves: result.leaves }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorLeaveIdParamsSchema>(req, "params");
  const leave = await getDoctorLeaveById(actor.tenantId, params.id);

  sendSuccess(res, { leave });
};

export const updateDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorLeaveIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorLeaveSchema>(req, "body");
  const leave = await updateDoctorLeave(actor.tenantId, params.id, input, leaveActor());

  sendSuccess(res, { leave });
};

export const approveDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorLeaveIdParamsSchema>(req, "params");
  const leave = await approveDoctorLeave(actor.tenantId, params.id, leaveActor());

  sendSuccess(res, { leave });
};

export const rejectDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorLeaveIdParamsSchema>(req, "params");
  const input = getValidated<typeof rejectDoctorLeaveSchema>(req, "body");
  const leave = await rejectDoctorLeave(
    actor.tenantId,
    params.id,
    leaveActor(),
    input.rejectionReason,
  );

  sendSuccess(res, { leave });
};

export const cancelDoctorLeaveHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorLeaveIdParamsSchema>(req, "params");
  const leave = await cancelDoctorLeave(actor.tenantId, params.id, leaveActor());

  sendSuccess(res, { leave });
};
