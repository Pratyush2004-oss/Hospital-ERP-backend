import { z } from "zod";
import { assertRange, dateSchema } from "../billing/reports/billing-report.schemas.js";

/**
 * Query validation for the dashboard API (Phase 22.2).
 *
 * Dates and the 366-day range bound use the Phase 19.9 report rules, so the
 * dashboard cannot accept a range the billing reports would reject. The
 * timezone is syntactically unconstrained here; the aggregation service
 * validates that it is a real IANA zone before running any query.
 *
 * `tenantId` is intentionally not part of the schema: the hospital always comes
 * from the verified session and an injected value is discarded by Zod.
 */
export const dashboardQuerySchema = z
  .object({
    fromDate: dateSchema,
    toDate: dateSchema,
    branchId: z.uuid("Branch id must be a UUID").optional(),
    timezone: z
      .string()
      .trim()
      .min(1, "Timezone cannot be empty")
      .max(64, "Timezone must be at most 64 characters")
      .optional(),
  })
  .superRefine(assertRange);

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
