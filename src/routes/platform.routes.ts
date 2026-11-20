import { Router } from "express";
import { sendCreated, sendSuccess } from "../lib/api-response.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission, requirePlatformContext } from "../middleware/authorization.js";
import { getValidated, validate } from "../middleware/validate.js";
import { csrfProtection } from "../modules/auth/auth.middleware.js";
import {
  createTenantByPlatform,
  listAllTenants,
  setTenantStatus,
} from "../modules/tenancy/tenancy.service.js";
import {
  platformCreateTenantSchema,
  tenantIdParamsSchema,
} from "../modules/tenancy/tenancy.schemas.js";

/**
 * Platform plane: HospitalOS-owned operations that span tenants (creating a
 * hospital, activating or suspending it, cross-tenant reporting).
 *
 * Mounted under a distinct prefix so these endpoints can never be reached with
 * a hospital member's session: `requirePlatformContext` rejects tenant actors.
 */
export const platformRouter: Router = Router();

platformRouter.get(
  "/tenants",
  authenticate,
  requirePlatformContext,
  requirePermission("tenant:read"),
  async (_req, res) => {
    const tenants = await listAllTenants();
    sendSuccess(res, { tenants });
  },
);

platformRouter.post(
  "/tenants",
  authenticate,
  csrfProtection,
  requirePlatformContext,
  requirePermission("tenant:create"),
  validate({ body: platformCreateTenantSchema }),
  async (req, res) => {
    const input = getValidated<typeof platformCreateTenantSchema>(req, "body");
    const result = await createTenantByPlatform(input);

    sendCreated(res, result);
  },
);

platformRouter.post(
  "/tenants/:tenantId/activate",
  authenticate,
  csrfProtection,
  requirePlatformContext,
  requirePermission("tenant:suspend"),
  validate({ params: tenantIdParamsSchema }),
  async (req, res) => {
    const params = getValidated<typeof tenantIdParamsSchema>(req, "params");
    const tenant = await setTenantStatus(params.tenantId, "ACTIVE");
    sendSuccess(res, { tenant });
  },
);

platformRouter.post(
  "/tenants/:tenantId/suspend",
  authenticate,
  csrfProtection,
  requirePlatformContext,
  requirePermission("tenant:suspend"),
  validate({ params: tenantIdParamsSchema }),
  async (req, res) => {
    const params = getValidated<typeof tenantIdParamsSchema>(req, "params");
    const tenant = await setTenantStatus(params.tenantId, "SUSPENDED");
    sendSuccess(res, { tenant });
  },
);
