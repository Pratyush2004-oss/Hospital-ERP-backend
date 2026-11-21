import { Router } from "express";
import { sendCreated, sendNoContent, sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
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
  createStaffInvitation,
  listStaffInvitations,
  resendStaffInvitation,
  revokeStaffInvitation,
} from "../auth/auth.email.service.js";
import {
  staffInvitationParamsSchema,
  staffInvitationSchema,
} from "../auth/auth.schemas.js";
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
  getUserOnboardingStatus,
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

/**
 * The signed-in account's own hospital registration status. Authentication is
 * enough: no tenant scope exists while the hospital is PENDING, and RLS limits
 * the query to memberships belonging to the caller.
 */
tenantRegistrationRouter.get("/onboarding", authenticate, async (_req, res) => {
  const actor = requireAuthenticatedUser();
  const onboarding = await getUserOnboardingStatus(actor.userId);

  sendSuccess(res, onboarding);
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
    const memberships = await listTenantMemberships(actor.tenantId, actor.branchIds);

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
      actor.branchIds,
    );

    sendSuccess(res, { membership });
  },
);

tenantScopeRouter.get(
  "/staff/invitations",
  authenticate,
  requireTenant,
  requirePermission("staff:read"),
  async (_req, res) => {
    const actor = requireTenantScope();
    const invitations = await listStaffInvitations(actor.tenantId, actor.branchIds);

    sendSuccess(res, { invitations });
  },
);

tenantScopeRouter.post(
  "/staff/invitations",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:create"),
  validate({ body: staffInvitationSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const input = getValidated<typeof staffInvitationSchema>(req, "body");

    // Role assignment is a separate privilege from creating an invitation.
    if (input.roleIds.length > 0 && !actor.permissions.has("staff:assign_role")) {
      throw AppError.forbidden("You do not have permission to assign roles");
    }

    const invitation = await createStaffInvitation(
      actor.tenantId,
      actor.userId,
      {
        email: input.email,
        fullName: input.fullName,
        roleIds: input.roleIds,
        departmentIds: input.departmentIds,
        branchIds: input.branchIds,
      },
      actor.branchIds,
    );

    sendSuccess(res, { invitation }, 202);
  },
);

tenantScopeRouter.post(
  "/staff/invitations/:invitationId/resend",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:create"),
  validate({ params: staffInvitationParamsSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof staffInvitationParamsSchema>(req, "params");
    const invitation = await resendStaffInvitation(
      actor.tenantId,
      params.invitationId,
      actor.userId,
      actor.branchIds,
    );

    sendSuccess(res, { invitation }, 202);
  },
);

tenantScopeRouter.post(
  "/staff/invitations/:invitationId/revoke",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("staff:create"),
  validate({ params: staffInvitationParamsSchema }),
  async (req, res) => {
    const actor = requireTenantScope();
    const params = getValidated<typeof staffInvitationParamsSchema>(req, "params");
    await revokeStaffInvitation(
      actor.tenantId,
      params.invitationId,
      actor.userId,
      actor.branchIds,
    );

    sendNoContent(res);
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
