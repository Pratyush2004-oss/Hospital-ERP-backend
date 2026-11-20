import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../middleware/authorization.js";
import { validate } from "../../middleware/validate.js";
import { csrfProtection } from "../auth/auth.middleware.js";
import {
  getPaymentHandler,
  initiatePaymentHandler,
  listPaymentAllocationsHandler,
  listPaymentsHandler,
  recordPaymentHandler,
} from "./payment.controller.js";
import {
  initiatePaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamsSchema,
  recordPaymentSchema,
} from "./payment.schemas.js";

/**
 * Hospital plane payment API (Phase 19.5.1).
 *
 * The tenant and actor always come from the verified session context via
 * `requireTenant`; no route accepts a `tenantId` from the URL, query or body,
 * and a payment recorded for another hospital is unreachable (the service
 * scopes every read and write by tenant and RLS enforces it again).
 *
 * Permission keys are the ones already seeded in the RBAC catalogue:
 *
 *   payment:create - record a manual/offline collection (front desk, accountant)
 *                    and start an online gateway checkout
 *   payment:read   - list history, read one receipt and its allocations
 *
 * There is deliberately no status, update or delete route: receipts are
 * append-only financial history, and refunds are out of scope for this phase.
 * `payment:refund` is therefore not used here.
 */
export const paymentRouter: Router = Router();

paymentRouter.post(
  "/",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:create"),
  validate({ body: recordPaymentSchema }),
  recordPaymentHandler,
);

/**
 * Online initiation is separate from manual recording: it creates a PENDING
 * attempt and a provider order, never a settled receipt. The amount is derived
 * from the invoice, and the same Idempotency-Key replays the open checkout.
 */
paymentRouter.post(
  "/initiate",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:create"),
  validate({ body: initiatePaymentSchema }),
  initiatePaymentHandler,
);

paymentRouter.get(
  "/",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ query: listPaymentsQuerySchema }),
  listPaymentsHandler,
);

paymentRouter.get(
  "/:paymentId/allocations",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ params: paymentIdParamsSchema }),
  listPaymentAllocationsHandler,
);

paymentRouter.get(
  "/:paymentId",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ params: paymentIdParamsSchema }),
  getPaymentHandler,
);
