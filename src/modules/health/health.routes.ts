import { Router } from "express";
import { getHealthStatus } from "./health.service.js";

export const healthRouter: Router = Router();

healthRouter.get("/", async (_req, res) => {
  const health = await getHealthStatus();
  res.status(health.status === "ok" ? 200 : 503).json(health);
});
