import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  createDoctorSchema,
  doctorIdParamsSchema,
  eligibleDoctorMembersQuerySchema,
  listDoctorsQuerySchema,
  updateDoctorBranchesSchema,
  updateDoctorDepartmentsSchema,
  updateDoctorSchema,
  updateDoctorStatusSchema,
} from "./doctor.schemas.js";
import {
  createDoctor,
  deleteDoctor,
  getDoctorById,
  listDoctors,
  listEligibleDoctorMembers,
  updateDoctor,
  updateDoctorBranches,
  updateDoctorDepartments,
  updateDoctorStatus,
} from "./doctor.service.js";

/** HTTP-only layer: no database access or business rules live here. */

export const createDoctorHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createDoctorSchema>(req, "body");
  const doctor = await createDoctor(actor.tenantId, input);

  sendCreated(res, { doctor });
};

export const listDoctorsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listDoctorsQuerySchema>(req, "query");
  const result = await listDoctors(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    search: query.search,
    departmentId: query.departmentId,
    branchId: query.branchId,
    isActive: query.isActive,
    specialization: query.specialization,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  });

  sendSuccess(res, { doctors: result.doctors }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const listEligibleDoctorMembersHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof eligibleDoctorMembersQuerySchema>(req, "query");
  const result = await listEligibleDoctorMembers(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    search: query.search,
  });

  sendSuccess(res, { members: result.members }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getDoctorHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  const doctor = await getDoctorById(actor.tenantId, params.id);

  sendSuccess(res, { doctor });
};

export const updateDoctorHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorSchema>(req, "body");
  const doctor = await updateDoctor(actor.tenantId, params.id, input);

  sendSuccess(res, { doctor });
};

export const updateDoctorDepartmentsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorDepartmentsSchema>(req, "body");
  const doctor = await updateDoctorDepartments(actor.tenantId, params.id, input.departmentIds);

  sendSuccess(res, { doctor });
};

export const updateDoctorBranchesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorBranchesSchema>(req, "body");
  const doctor = await updateDoctorBranches(actor.tenantId, params.id, input.branches);

  sendSuccess(res, { doctor });
};

export const updateDoctorStatusHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDoctorStatusSchema>(req, "body");
  const doctor = await updateDoctorStatus(actor.tenantId, params.id, input.isActive);

  sendSuccess(res, { doctor });
};

export const deleteDoctorHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorIdParamsSchema>(req, "params");
  await deleteDoctor(actor.tenantId, params.id);

  sendNoContent(res);
};
