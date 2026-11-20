import type { RequestHandler } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import {
  branchIdParamsSchema,
  createBranchSchema,
  listBranchesQuerySchema,
  updateBranchSchema,
  updateBranchStatusSchema,
} from "./branch.schemas.js";
import {
  createBranch,
  deleteBranch,
  getBranch,
  listBranches,
  updateBranch,
  updateBranchStatus,
} from "./branch.service.js";

/** HTTP-only layer: no database access or business rules live here. */

export const createBranchHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createBranchSchema>(req, "body");
  const branch = await createBranch(actor.tenantId, input);

  sendCreated(res, { branch });
};

export const listBranchesHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listBranchesQuerySchema>(req, "query");
  const result = await listBranches(actor.tenantId, query);

  sendSuccess(
    res,
    { branches: result.branches },
    200,
    {
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    },
  );
};

export const getBranchHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof branchIdParamsSchema>(req, "params");
  const branch = await getBranch(actor.tenantId, params.id);

  sendSuccess(res, { branch });
};

export const updateBranchHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof branchIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateBranchSchema>(req, "body");
  const branch = await updateBranch(actor.tenantId, params.id, input);

  sendSuccess(res, { branch });
};

export const updateBranchStatusHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof branchIdParamsSchema>(req, "params");
  const input = getValidated<typeof updateBranchStatusSchema>(req, "body");
  const branch = await updateBranchStatus(actor.tenantId, params.id, input.isActive);

  sendSuccess(res, { branch });
};

export const deleteBranchHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof branchIdParamsSchema>(req, "params");
  await deleteBranch(actor.tenantId, params.id);

  sendNoContent(res);
};
