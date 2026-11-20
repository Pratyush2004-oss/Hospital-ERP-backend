import { z } from "zod";

/**
 * Audit API request validation (Phase 21.2).
 *
 * Filters only narrow the caller's own hospital; there is no `tenantId`
 * parameter. `.strict()` rejects unknown query parameters so a client cannot
 * assume an unsupported filter was applied.
 */

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const auditInstantSchema = z
  .string()
  .trim()
  .regex(
    INSTANT_PATTERN,
    'Timestamps must be ISO 8601 with an explicit offset, e.g. "2026-11-20T00:00:00Z"',
  )
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "Timestamps must be valid instants",
  );

const filterTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Filter must contain only letters, digits, dot, colon, underscore or hyphen");

export const listAuditLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, "Page must be at least 1").default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .default(20),
    actorUserId: z.uuid("Actor id must be a UUID").optional(),
    branchId: z.uuid("Branch id must be a UUID").optional(),
    module: z.string().trim().min(1).max(60).optional(),
    action: filterTokenSchema.optional(),
    resourceType: z.string().trim().min(1).max(100).optional(),
    resourceId: z.string().trim().min(1).max(200).optional(),
    from: auditInstantSchema.optional(),
    to: auditInstantSchema.optional(),
    sortOrder: z.enum(["asc", "desc"], "Sort order must be asc or desc").default("desc"),
  })
  .strict()
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      new Date(value.from).getTime() <= new Date(value.to).getTime(),
    { message: "from must be on or before to", path: ["to"] },
  );

export const recentAuditActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    branchId: z.uuid("Branch id must be a UUID").optional(),
  })
  .strict();

export const auditLogIdParamsSchema = z.object({
  auditLogId: z.uuid("Audit log id must be a UUID"),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
export type RecentAuditActivityQuery = z.infer<typeof recentAuditActivityQuerySchema>;
export type AuditLogIdParams = z.infer<typeof auditLogIdParamsSchema>;
