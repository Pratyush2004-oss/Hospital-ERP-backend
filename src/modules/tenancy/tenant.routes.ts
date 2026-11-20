import { Router } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { authenticate } from "../../middleware/authenticate.js";
import {
  requireAnyPermission,
  requirePermission,
  requireTenant,
} from "../../middleware/authorization.js";
import { getValidated, validate } from "../../middleware/validate.js";
import { csrfProtection, requireAuthenticatedUser } from "../auth/auth.middleware.js";
import {
  assignMembershipRoles,
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  listTenantMemberships,
  setRolePermissions,
  updateRole,
} from "../rbac/rbac.service.js";
import {
  assignMembershipRolesSchema,
  createRoleSchema,
  membershipIdParamsSchema,
  roleIdParamsSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
} from "../rbac/rbac.schemas.js";
import {
  getTenantSettings,
  listUserMemberships,
  registerTenant,
  selectTenant,
  setTenantSetting,
} from "./tenancy.service.js";
import {
  registerTenantSchema,
  selectTenantSchema,
  settingKeyParamsSchema,
  updateTenantSettingSchema,
} from "./tenancy.schemas.js";

/**
 * `/tenants` — actions that are about the caller's relation to hospitals
 * (registering, listing memberships, selecting one, and active-tenant settings).
 */
export const tenantRegistrationRouter: Router = Router();

tenantRegistrationRouter.post(
  "/register",
  authenticate,
  csrfProtection,
  validate({ body: registerTenantSchema }),
  async (req, res) => {
    const actor = requireAuthenticatedUser();
    const input = getValidated<typeof registerTenantSchema>(req, "body");
    const result = await registerTenant(actor.userId, input);

    sendCreated(res, result);
  },
);

tenantRegistrationRouter.get("/memberships", authenticate, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const memberships = await listUserMemberships(actor.userId);

  sendSuccess(res, { memberships });
});

tenantRegistrationRouter.post(
  "/select",
  authenticate,
  csrfProtection,
  validate({ body: selectTenantSchema }),
  async (req, res) => {
    const actor = requireAuthenticatedUser();
    const input = getValidated<typeof selectTenantSchema>(req, "body");
    const context = await selectTenant(actor.userId, actor.sessionId, input.slug);

    sendSuccess(res, {
      tenant: context.tenant,
      membershipId: context.membershipId,
      roles: context.roles,
      permissions: [...context.permissions],
    });
  },
);

tenantRegistrationRouter.get(
  "/settings",
  authenticate,
  requireTenant,
  requirePermission("tenant:read"),
  async (_req, res) => {
    const actor = requireTenantScope();
    const settings = await getTenantSettings(actor.tenantId);

    sendSuccess(res, { settings });
  },
);

tenantRegistrationRouter.put(
  "/settings/:key",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("tenant:update"),
  validate({ params: settingKeyParamsSchema, body: updateTenantSettingSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof settingKeyParamsSchema>(req, "params");
    const input = getValidated<typeof updateTenantSettingSchema>(req, "body");
    const setting = await setTenantSetting(actor.tenantId, params.key, input.value);

    sendSuccess(res, { setting });
  },
);

/**
 * `/tenant` — hospital-scoped management. The tenant always comes from the
 * verified request context; no endpoint accepts a tenant id from the client.
 */
export const tenantScopeRouter: Router = Router();

tenantScopeRouter.get(
  "/memberships",
  authenticate,
  requireTenant,
  requirePermission("staff:read"),
  async (_req, res) => {
    const actor = requireTenantScope();
    const memberships = await listTenantMemberships(actor.tenantId);

    sendSuccess(res, { memberships });
  },
);

tenantScopeRouter.put(
  "/memberships/:membershipId/roles",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:assign_role"),
  validate({ params: membershipIdParamsSchema, body: assignMembershipRolesSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof membershipIdParamsSchema>(req, "params");
    const input = getValidated<typeof assignMembershipRolesSchema>(req, "body");
    const membership = await assignMembershipRoles(
      actor.tenantId,
      params.membershipId,
      input,
      actor.userId,
    );

    sendSuccess(res, { membership });
  },
);

tenantScopeRouter.get(
  "/roles",
  authenticate,
  requireTenant,
  requireAnyPermission("tenant:read", "staff:read"),
  async (_req, res) => {
    const actor = requireTenantScope();
    const tenantRoles = await listRoles(actor.tenantId);

    sendSuccess(res, { roles: tenantRoles });
  },
);

tenantScopeRouter.post(
  "/roles",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:assign_role"),
  validate({ body: createRoleSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const input = getValidated<typeof createRoleSchema>(req, "body");
    const role = await createRole(actor.tenantId, input);

    sendCreated(res, { role });
  },
);

tenantScopeRouter.patch(
  "/roles/:roleId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:assign_role"),
  validate({ params: roleIdParamsSchema, body: updateRoleSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof roleIdParamsSchema>(req, "params");
    const input = getValidated<typeof updateRoleSchema>(req, "body");
    const role = await updateRole(actor.tenantId, params.roleId, input);

    sendSuccess(res, { role });
  },
);

tenantScopeRouter.delete(
  "/roles/:roleId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:assign_role"),
  validate({ params: roleIdParamsSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof roleIdParamsSchema>(req, "params");
    await deleteRole(actor.tenantId, params.roleId);

    sendNoContent(res);
  },
);

tenantScopeRouter.put(
  "/roles/:roleId/permissions",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:assign_role"),
  validate({ params: roleIdParamsSchema, body: setRolePermissionsSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof roleIdParamsSchema>(req, "params");
    const input = getValidated<typeof setRolePermissionsSchema>(req, "body");
    const role = await setRolePermissions(actor.tenantId, params.roleId, input);

    sendSuccess(res, { role });
  },
);

tenantScopeRouter.get(
  "/permissions",
  authenticate,
  requireTenant,
  requireAnyPermission("tenant:read", "staff:read"),
  async (_req, res) => {
    sendSuccess(res, { permissions: listPermissions() });
  },
);
