import { Router } from "express";

/**
 * Hospital plane: every route mounted here operates strictly on the caller's
 * tenant, taken from the verified request context — never from the URL or body.
 *
 * Feature modules (patients, appointments, billing, ...) are registered here in
 * later phases, behind `authenticate` and the relevant permission guards.
 */
export const tenantRouter: Router = Router();
