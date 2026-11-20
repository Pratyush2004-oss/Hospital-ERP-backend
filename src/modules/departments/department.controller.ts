import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  departmentIdParamsSchema,
  listDepartmentsQuerySchema,
  createDepartmentSchema,
  updateDepartmentBranchesSchema,
  updateDepartmentSchema,
  updateDepartmentStatusSchema,
} from "./department.schemas.js";
import {
  createDepartment,
  deleteDepartment,
  getDepartmentById,
  listDepartments,
  updateDepartment,
  updateDepartmentBranches,
  updateDepartmentStatus,
} from "./department.service.js";

/** HTTP-only layer: tenant context comes from the verified session, never input. */

export const createDepartmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createDepartmentSchema>(req, "body");
  const department = await createDepartment(actor.tenantId, input);

  sendCreated(res, { department });
};

export const listDepartmentsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listDepartmentsQuerySchema>(req, "query");
  const result = await listDepartments(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    search: query.search,
    isActive: query.isActive,
    branchId: query.branchId,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  });

  sendSuccess(res, { departments: result.departments }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getDepartmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof departmentIdParamsSchema>(req, "params");
  const department = await getDepartmentById(actor.tenantId, params.id);

  sendSuccess(res, { department });
};

export const updateDepartmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof departmentIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDepartmentSchema>(req, "body");
  const department = await updateDepartment(actor.tenantId, params.id, input);

  sendSuccess(res, { department });
};

export const updateDepartmentBranchesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof departmentIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDepartmentBranchesSchema>(req, "body");
  const department = await updateDepartmentBranches(actor.tenantId, params.id, input.branchIds);

  sendSuccess(res, { department });
};

export const updateDepartmentStatusHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof departmentIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateDepartmentStatusSchema>(req, "body");
  const department = await updateDepartmentStatus(actor.tenantId, params.id, input.isActive);

  sendSuccess(res, { department });
};

export const deleteDepartmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof departmentIdParamsSchema>(req, "params");
  await deleteDepartment(actor.tenantId, params.id);

  sendNoContent(res);
};
