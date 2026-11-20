import { env } from "../config/env.js";
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER } from "../modules/auth/auth.config.js";

/**
 * OpenAPI 3.1 description of the doctor scheduling API (Task 16.5).
 *
 * The document is hand-written next to the route modules so it can name the
 * exact fields the Zod schemas accept and the exact DTOs the services return.
 * Two time models coexist and are deliberately documented apart:
 *
 * - schedule/break times are branch-local wall-clock strings (`HH:MM`), which
 *   must NOT be converted to UTC because a recurring window follows the branch
 *   clock across DST;
 * - leave timestamps are absolute instants with an explicit offset (`Z` or
 *   `±HH:MM`), so the instant is preserved exactly.
 */

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", example: "VALIDATION_ERROR" },
        message: { type: "string", example: "Request validation failed" },
        details: {
          description: "Field-level validation issues or error context.",
          oneOf: [
            { type: "array", items: { $ref: "#/components/schemas/ValidationIssue" } },
            { type: "object", additionalProperties: true },
          ],
        },
        requestId: { type: "string", example: "6f1c2c4e-6a1b-4c0e-9c2f-2a5b8d1e3f40" },
      },
    },
  },
} as const;

const paginationMeta = {
  type: "object",
  required: ["page", "pageSize", "total", "totalPages"],
  properties: {
    page: { type: "integer", minimum: 1, example: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100, example: 20 },
    total: { type: "integer", minimum: 0, example: 3 },
    totalPages: { type: "integer", minimum: 0, example: 1 },
  },
} as const;

const successEnvelope = (data: Record<string, unknown>, description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["data"],
        properties: {
          data,
          meta: {
            type: "object",
            properties: {
              requestId: { type: "string" },
              pagination: { $ref: "#/components/schemas/PaginationMeta" },
            },
          },
        },
      },
    },
  },
});

const listEnvelope = (key: string, itemSchema: string, description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: [key],
            properties: { [key]: { type: "array", items: { $ref: itemSchema } } },
          },
          meta: {
            type: "object",
            properties: {
              requestId: { type: "string" },
              pagination: { $ref: "#/components/schemas/PaginationMeta" },
            },
          },
        },
      },
    },
  },
});

const errorResponse = (description: string, code: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
      example: { error: { code, message: description } },
    },
  },
});

const unauthorized = errorResponse("Authentication is required or the session is invalid.", "UNAUTHORIZED");
const forbidden = errorResponse(
  "The authenticated membership lacks the required permission.",
  "FORBIDDEN",
);
const notFound = errorResponse("The record does not exist in the caller's hospital.", "NOT_FOUND");
const validation = errorResponse("The request failed Zod validation.", "VALIDATION_ERROR");
const conflict = errorResponse("The request conflicts with existing scheduling data.", "CONFLICT");
const badRequest = errorResponse("The request violates a scheduling business rule.", "BAD_REQUEST");

const idParameter = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});

const csrfParameter = {
  name: CSRF_HEADER,
  in: "header",
  required: true,
  description:
    `Double-submit CSRF token. Send the value of the ${CSRF_COOKIE} cookie; ` +
    "required on every cookie-authenticated state-changing request.",
  schema: { type: "string" },
} as const;

const paginationParameters = [
  {
    name: "page",
    in: "query",
    required: false,
    description: "1-based page number.",
    schema: { type: "integer", minimum: 1, default: 1 },
  },
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Page size, 1-100.",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
] as const;

const doctorSummary = {
  type: "object",
  required: ["id", "doctorCode", "fullName"],
  properties: {
    id: { type: "string", format: "uuid" },
    doctorCode: { type: "string", example: "DOC-CAR-001" },
    fullName: { type: "string", example: "Dr. Asha Rao" },
  },
} as const;

const branchSummary = {
  type: "object",
  required: ["id", "name", "branchCode", "timezone"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", example: "Central Hospital" },
    branchCode: { type: "string", example: "CEN-01" },
    timezone: {
      type: "string",
      description: "IANA zone the branch-local schedule times are interpreted in.",
      example: "Asia/Kolkata",
    },
  },
} as const;

const reportFilterParameters = [
  {
    name: "branchId",
    in: "query",
    required: false,
    description: "Filter to one branch of the caller's hospital.",
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "timezone",
    in: "query",
    required: false,
    description: "IANA zone overriding the branch/hospital zone for instant boundaries.",
    schema: { type: "string", example: "Asia/Kolkata" },
  },
  {
    name: "paymentMethod",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"] },
  },
  {
    name: "invoiceType",
    in: "query",
    required: false,
    schema: {
      type: "string",
      enum: ["CONSULTATION", "PHARMACY", "LABORATORY", "PROCEDURE", "ADMISSION", "OTHER"],
    },
  },
  {
    name: "invoiceStatus",
    in: "query",
    required: false,
    schema: {
      type: "string",
      enum: ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"],
    },
  },
  {
    name: "paymentStatus",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"] },
  },
  {
    name: "refundStatus",
    in: "query",
    required: false,
    schema: {
      type: "string",
      enum: ["PENDING", "APPROVED", "PROCESSING", "SUCCESSFUL", "FAILED", "REJECTED"],
    },
  },
  {
    name: "doctorId",
    in: "query",
    required: false,
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "departmentId",
    in: "query",
    required: false,
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "format",
    in: "query",
    required: false,
    description: "`csv` requires `reports:export` in addition to `reports:read`.",
    schema: { type: "string", enum: ["json", "csv"], default: "json" },
  },
] as const;

const reportRangeParameters = [
  {
    name: "fromDate",
    in: "query",
    required: true,
    schema: { type: "string", format: "date" },
    description: "Inclusive local date. The range may span at most 366 days.",
  },
  {
    name: "toDate",
    in: "query",
    required: true,
    schema: { type: "string", format: "date" },
    description: "Inclusive local date; must be on or after `fromDate`.",
  },
  ...reportFilterParameters,
] as const;

const dashboardRangeParameters = [
  {
    name: "fromDate",
    in: "query",
    required: true,
    schema: { type: "string", format: "date" },
    description: "Inclusive local date. The range may span at most 366 days.",
  },
  {
    name: "toDate",
    in: "query",
    required: true,
    schema: { type: "string", format: "date" },
    description: "Inclusive local date; must be on or after `fromDate`.",
  },
  {
    name: "branchId",
    in: "query",
    required: false,
    description:
      "Filter operational and financial metrics to one branch of the caller's " +
      "hospital. A foreign branch is `404`. Patient totals stay hospital-wide.",
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "timezone",
    in: "query",
    required: false,
    description:
      "IANA zone used for local-day boundaries; defaults to the branch, then hospital zone.",
    schema: { type: "string", example: "Asia/Kolkata" },
  },
] as const;

const dashboardEnvelope = (key: string, schema: string, description: string) =>
  successEnvelope(
    {
      type: "object",
      required: [key],
      properties: { [key]: { $ref: schema } },
    },
    description,
  );

const reportSuccess = (data: Record<string, unknown>, description: string) => {
  const envelope = successEnvelope(data, description);

  return {
    ...envelope,
    content: {
      ...envelope.content,
      "text/csv": {
        schema: { type: "string" },
        description:
          "CSV projection of the same report when `format=csv`; requires `reports:export`.",
      },
    },
  };
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "HospitalOS API — Clinical Scheduling, Patients and Payments",
    version: "1.13.0",
    description: [
      "Doctor recurring schedules, breaks and leave workflows.",
      "",
      "**Tenant context** is always taken from the verified session; a `tenantId`",
      "in a body or query string is never trusted.",
      "",
      "**Patients**",
      "",
      "Registration generates the patient code (MRN) server-side; a client-supplied",
      "code is rejected. `status` changes go through the dedicated status operation,",
      "`patientCode`, `tenantId` and `userId` are not patchable, and body schemas are",
      "strict, so unknown properties produce `422 VALIDATION_ERROR`.",
      "",
      "**Patient child records** (contacts, addresses, emergency contacts) are",
      "tenant- and patient-scoped. Every write requires `patient:update` and the",
      "services keep at most one primary contact row per patient and one primary",
      "address per address type. Contact verification is never client-controlled:",
      "an `isVerified` property is rejected with `422`.",
      "",
      "**Time models**",
      "",
      "- Schedule and break `startTime`/`endTime` are branch-local wall-clock strings",
      "  (`HH:MM` or `HH:MM:SS`). They are intentionally never converted to UTC, so a",
      "  recurring weekly window follows the branch clock across DST. The branch's",
      "  IANA zone is returned on every schedule/break response.",
      "- Leave `startAt`/`endAt` are ISO 8601 timestamps with an explicit offset",
      "  (`Z` or `±HH:MM`). The instant is preserved exactly; a value without an",
      "  offset is rejected.",
      "",
      "**Workflow metadata** (`status`, `createdBy`, `approvedBy`, `approvedAt`,",
      "`rejectedBy`, ...) is never accepted from the client. Leave creation always",
      "starts PENDING and is attributed to the authenticated actor.",
      "",
      "**Appointments**",
      "",
      "Availability is read-only. Booking requires an `Idempotency-Key`, resolves the",
      "consultation fee from the doctor-branch assignment, and rejects client-supplied",
      "tenant ids, actor ids, fees, codes and statuses. Rescheduling follows the",
      "replacement model (the original becomes `RESCHEDULED` and a new `CONFIRMED`",
      "appointment is linked to it). Status is never writable directly: check-in,",
      "start, complete, no-show and cancel each apply the transition table and write",
      "one lifecycle event. A caller who holds a doctor profile only sees their own",
      "appointments.",
      "",
      "**Payments**",
      "",
      "A payment is a receipt-level record of money collected at the desk and is",
      "allocated to one or more of the patient's invoices in the same branch. The",
      "tenant and cashier come from the verified session; a client-supplied",
      "`tenantId`, `receivedBy` or `paymentStatus` is rejected with `422`.",
      "Recording requires an `Idempotency-Key`, so a retried request replays the",
      "original receipt (`replayed: true`, `200`) instead of collecting twice;",
      "reusing a key for a different request is a `409`. A receipt is append-only:",
      "there is no update or delete endpoint, and invoice balances are computed by",
      "the service, never accepted from the client.",
      "",
      "**Refunds**",
      "",
      "A refund reverses one successful payment capture (`invoicePaymentId`) and is",
      "requested under `/refunds`. Invoice, branch, patient, currency and channel are",
      "derived from that capture; a client cannot name them or set a status. Requests",
      "start `PENDING`; the requester cannot approve their own refund, and only an",
      "`APPROVED` refund can be processed. Offline captures are confirmed by the",
      "authorised desk actor; gateway captures go through the provider adapter and",
      "only a verified `SUCCESSFUL` adapter response marks the refund successful and",
      "reduces the invoice. A timeout leaves the refund `PROCESSING` for",
      "reconciliation and is never optimistically successful. Cumulative refunds",
      "(pending, approved, processing and successful) cannot exceed the captured",
      "amount.",
      "",
      "**Audit logs**",
      "",
      "`GET /audit-logs` and `GET /audit-logs/{id}` are read-only and require",
      "`audit:read` (`hospital_admin` and `branch_admin` by default). The tenant is",
      "taken from the session; there is no tenant parameter. `branchId` filters are",
      "validated against the caller's hospital, so a foreign branch is `404`. Audit",
      "rows are append-only: no API route can update or delete them, and stored",
      "sensitive metadata is redacted again on read.",
      "",
      "**Authorization**",
      "",
      "Every operation declares its required permission in `x-required-permission`.",
      "Default roles: `hospital_admin` and `branch_admin` hold the full scheduling",
      "set; `doctor` holds `schedule.read`, `schedule.break.read`,",
      "`doctor.leave.create/read/update/cancel` for its own requests; `receptionist`",
      "and `nurse` are read-only. Doctors cannot approve or reject leave, and the",
      "service denies cancelling or editing a colleague's leave. Custom roles can",
      "be granted any of these keys through `/tenant/roles`.",
      "",
      "**Known limitation**: hospital memberships are tenant-scoped but not",
      "branch-scoped, so `branch_admin` currently acts across the whole hospital.",
      "No membership-to-branch assignment exists; cross-branch restriction is",
      "therefore not enforced and must not be assumed.",
    ].join("\n"),
  },
  servers: [{ url: env.API_PREFIX, description: "Versioned API prefix" }],
  tags: [
    { name: "Appointments", description: "Availability, booking, rescheduling, cancellation and lifecycle." },
    { name: "Patients", description: "Patient registration, profiles and lifecycle." },
    { name: "Payments", description: "Manual payment recording, history and allocations." },
    { name: "Refunds", description: "Refund requests, approval, processing and history." },
    {
      name: "Billing Documents",
      description: "Invoice PDFs, payment receipts and refund credit notes, plus authenticated downloads.",
    },
    {
      name: "Billing Reports",
      description: "Financial aggregation, breakdowns, outstanding invoice reports and CSV exports.",
    },
    {
      name: "Dashboard",
      description:
        "Read-only operational and financial dashboard summaries over the Phase 22.1 " +
        "aggregation. Every operation requires `reports:read` plus the module read " +
        "permission it exposes; the composed operational view omits sections the caller " +
        "may not see.",
    },
    { name: "Doctor Schedules", description: "Recurring weekly working windows." },
    { name: "Doctor Breaks", description: "Recurring pauses inside a schedule window." },
    { name: "Doctor Leaves", description: "Leave requests and approval workflow." },
    {
      name: "Audit Logs",
      description: "Read-only hospital audit history and recent activity.",
    },
  ],
  security: [{ cookieAuth: [] }],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: ACCESS_COOKIE,
        description:
          "HttpOnly session access cookie issued by `POST /auth/login`, scoped to the API prefix.",
      },
    },
    schemas: {
      Error: errorSchema,
      ValidationIssue: {
        type: "object",
        required: ["source", "path", "message", "code"],
        properties: {
          source: { type: "string", enum: ["body", "params", "query"] },
          path: { type: "string", example: "endTime" },
          message: { type: "string" },
          code: { type: "string", example: "too_small" },
        },
      },
      PaginationMeta: paginationMeta,
      AuditLogEntry: {
        type: "object",
        required: [
          "id",
          "branchId",
          "actorUserId",
          "actorScope",
          "action",
          "module",
          "resourceType",
          "resourceId",
          "description",
          "previousState",
          "newState",
          "metadata",
          "requestId",
          "ipAddress",
          "userAgent",
          "createdAt",
        ],
        description:
          "One redacted audit record. Tenant ownership is implicit and dedupe keys are never exposed.",
        properties: {
          id: { type: "string", format: "uuid" },
          branchId: { type: ["string", "null"], format: "uuid" },
          actorUserId: { type: ["string", "null"], format: "uuid" },
          actorScope: {
            type: ["string", "null"],
            enum: ["TENANT", "PLATFORM", "USER", "SYSTEM", null],
          },
          action: { type: "string", example: "patient.created" },
          module: { type: "string", example: "patients" },
          resourceType: { type: ["string", "null"], example: "patient" },
          resourceId: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          previousState: { description: "Redacted snapshot before the operation." },
          newState: { description: "Redacted snapshot after the operation." },
          metadata: { type: "object", additionalProperties: true },
          requestId: { type: ["string", "null"] },
          ipAddress: { type: ["string", "null"] },
          userAgent: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      DoctorSchedule: {
        type: "object",
        required: [
          "id",
          "doctorId",
          "branchId",
          "dayOfWeek",
          "startTime",
          "endTime",
          "slotDurationMinutes",
          "bufferMinutes",
          "effectiveFrom",
          "effectiveUntil",
          "isActive",
          "doctor",
          "branch",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          doctorId: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          dayOfWeek: {
            type: "integer",
            minimum: 1,
            maximum: 7,
            description: "ISO weekday in branch-local time: 1 = Monday ... 7 = Sunday.",
            example: 1,
          },
          startTime: {
            type: "string",
            pattern: "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$",
            description: "Branch-local wall-clock start time (no UTC conversion).",
            example: "09:00",
          },
          endTime: {
            type: "string",
            pattern: "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$",
            description: "Branch-local wall-clock end time; must be later than startTime.",
            example: "13:00",
          },
          slotDurationMinutes: { type: "integer", minimum: 5, maximum: 480, example: 15 },
          bufferMinutes: { type: "integer", minimum: 0, example: 5 },
          effectiveFrom: {
            type: "string",
            format: "date",
            description: "First branch-local calendar date the window applies to.",
            example: "2026-01-05",
          },
          effectiveUntil: {
            type: ["string", "null"],
            format: "date",
            description: "Last applicable date; null means open ended.",
            example: null,
          },
          isActive: { type: "boolean", example: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          doctor: doctorSummary,
          branch: branchSummary,
        },
      },
      DoctorScheduleInput: {
        type: "object",
        required: ["doctorId", "branchId", "dayOfWeek", "startTime", "endTime"],
        properties: {
          doctorId: { type: "string", format: "uuid" },
          branchId: {
            type: "string",
            format: "uuid",
            description: "Branch the doctor is actively assigned to.",
          },
          dayOfWeek: { type: "integer", minimum: 1, maximum: 7, example: 1 },
          startTime: {
            type: "string",
            description: "Branch-local wall-clock start (`HH:MM` or `HH:MM:SS`).",
            example: "09:00",
          },
          endTime: {
            type: "string",
            description: "Branch-local wall-clock end; must be later than startTime.",
            example: "13:00",
          },
          slotDurationMinutes: { type: "integer", minimum: 5, maximum: 480, default: 15 },
          bufferMinutes: { type: "integer", minimum: 0, default: 0 },
          effectiveFrom: {
            type: "string",
            format: "date",
            description: "Defaults to today in the branch timezone.",
            example: "2026-01-05",
          },
          effectiveUntil: {
            type: ["string", "null"],
            format: "date",
            description: "May not be earlier than effectiveFrom; null means open ended.",
            example: null,
          },
          isActive: { type: "boolean", default: true },
        },
      },
      DoctorBreak: {
        type: "object",
        required: ["id", "scheduleId", "startTime", "endTime", "reason", "schedule"],
        properties: {
          id: { type: "string", format: "uuid" },
          scheduleId: { type: "string", format: "uuid" },
          startTime: { type: "string", example: "11:00" },
          endTime: { type: "string", example: "11:15" },
          reason: { type: ["string", "null"], example: "Lunch" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          schedule: {
            type: "object",
            description: "Parent schedule context.",
            required: ["id", "doctorId", "branchId", "dayOfWeek", "startTime", "endTime"],
            properties: {
              id: { type: "string", format: "uuid" },
              doctorId: { type: "string", format: "uuid" },
              branchId: { type: "string", format: "uuid" },
              dayOfWeek: { type: "integer", minimum: 1, maximum: 7 },
              startTime: { type: "string", example: "09:00" },
              endTime: { type: "string", example: "13:00" },
              slotDurationMinutes: { type: "integer" },
              bufferMinutes: { type: "integer" },
              isActive: { type: "boolean" },
              doctorCode: { type: "string" },
              doctorFullName: { type: "string" },
              branchName: { type: "string" },
              branchCode: { type: "string" },
              timezone: { type: "string", example: "Asia/Kolkata" },
            },
          },
        },
      },
      DoctorBreakInput: {
        type: "object",
        required: ["scheduleId", "startTime", "endTime"],
        properties: {
          scheduleId: { type: "string", format: "uuid" },
          startTime: { type: "string", example: "11:00" },
          endTime: { type: "string", example: "11:15" },
          reason: {
            type: ["string", "null"],
            maxLength: 255,
            description: "Optional free-text reason.",
          },
        },
      },
      DoctorLeave: {
        type: "object",
        required: [
          "id",
          "doctorId",
          "branchId",
          "isAllBranches",
          "startAt",
          "endAt",
          "status",
          "createdBy",
          "doctor",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          doctorId: { type: "string", format: "uuid" },
          branchId: {
            type: ["string", "null"],
            format: "uuid",
            description: "null means the absence applies to every branch.",
          },
          isAllBranches: { type: "boolean" },
          startAt: {
            type: "string",
            format: "date-time",
            description: "Absolute instant with offset preserved.",
            example: "2026-02-02T09:00:00+05:30",
          },
          endAt: {
            type: "string",
            format: "date-time",
            example: "2026-02-04T18:00:00+05:30",
          },
          reason: { type: ["string", "null"], maxLength: 1000 },
          status: {
            type: "string",
            enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
          },
          createdBy: { type: "string", format: "uuid" },
          approvedBy: { type: ["string", "null"], format: "uuid" },
          approvedAt: { type: ["string", "null"], format: "date-time" },
          rejectedBy: { type: ["string", "null"], format: "uuid" },
          rejectedAt: { type: ["string", "null"], format: "date-time" },
          rejectionReason: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          doctor: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              doctorCode: { type: "string" },
              fullName: { type: "string" },
              isActive: { type: "boolean" },
            },
          },
          branch: {
            type: ["object", "null"],
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              branchCode: { type: "string" },
              timezone: { type: "string" },
            },
          },
          requestedBy: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              fullName: { type: "string" },
            },
          },
          approvedByUser: {
            type: ["object", "null"],
            properties: {
              id: { type: "string", format: "uuid" },
              fullName: { type: "string" },
            },
          },
          rejectedByUser: {
            type: ["object", "null"],
            properties: {
              id: { type: "string", format: "uuid" },
              fullName: { type: "string" },
            },
          },
        },
      },
      DoctorLeaveInput: {
        type: "object",
        required: ["doctorId", "startAt", "endAt"],
        additionalProperties: false,
        description:
          "Only these fields are accepted. Workflow fields (status, createdBy, " +
          "approvedBy, approvedAt, rejectedBy, ...) are rejected by the strict schema.",
        properties: {
          doctorId: { type: "string", format: "uuid" },
          branchId: {
            type: ["string", "null"],
            format: "uuid",
            description: "Omit or send null for all-branch leave.",
          },
          startAt: {
            type: "string",
            format: "date-time",
            description: "ISO 8601 instant with an explicit offset (Z or ±HH:MM).",
            example: "2026-02-02T09:00:00+05:30",
          },
          endAt: {
            type: "string",
            format: "date-time",
            description: "Must be later than startAt.",
            example: "2026-02-04T18:00:00+05:30",
          },
          reason: { type: ["string", "null"], maxLength: 1000 },
        },
      },
      PatientAccountSummary: {
        type: ["object", "null"],
        description: "Minimal linked account identity; never exposes credentials or contact data.",
        required: ["id", "fullName", "isActive"],
        properties: {
          id: { type: "string", format: "uuid" },
          fullName: { type: "string" },
          isActive: { type: "boolean" },
        },
      },
      PatientSummary: {
        type: "object",
        required: [
          "id",
          "patientCode",
          "fullName",
          "gender",
          "status",
          "accountLinked",
        ],
        description: "Identity-only list projection; no contacts or documents.",
        properties: {
          id: { type: "string", format: "uuid" },
          patientCode: { type: "string", example: "P-000123" },
          fullName: { type: "string", example: "Eleanor Whitfield" },
          dateOfBirth: { type: ["string", "null"], format: "date", example: "1958-04-12" },
          gender: { type: "string", enum: ["MALE", "FEMALE", "OTHER", "UNKNOWN"] },
          bloodGroup: {
            type: ["string", "null"],
            enum: [
              "A_POSITIVE",
              "A_NEGATIVE",
              "B_POSITIVE",
              "B_NEGATIVE",
              "AB_POSITIVE",
              "AB_NEGATIVE",
              "O_POSITIVE",
              "O_NEGATIVE",
              null,
            ],
          },
          status: {
            type: "string",
            enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DECEASED"],
          },
          accountLinked: {
            type: "boolean",
            description: "True when a patient-portal account is linked.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PatientProfile: {
        type: "object",
        required: [
          "id",
          "patientCode",
          "fullName",
          "gender",
          "status",
          "user",
          "contacts",
          "addresses",
          "emergencyContacts",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          patientCode: {
            type: "string",
            description: "Server-generated MRN following the tenant's code format.",
            example: "P-000123",
          },
          fullName: { type: "string", example: "Eleanor Whitfield" },
          dateOfBirth: { type: ["string", "null"], format: "date", example: "1958-04-12" },
          gender: {
            type: "string",
            enum: ["MALE", "FEMALE", "OTHER", "UNKNOWN"],
          },
          bloodGroup: {
            type: ["string", "null"],
            enum: [
              "A_POSITIVE",
              "A_NEGATIVE",
              "B_POSITIVE",
              "B_NEGATIVE",
              "AB_POSITIVE",
              "AB_NEGATIVE",
              "O_POSITIVE",
              "O_NEGATIVE",
              null,
            ],
          },
          maritalStatus: {
            type: ["string", "null"],
            enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER", null],
          },
          profileImageKey: {
            type: ["string", "null"],
            description: "Private storage key, never a public URL.",
          },
          status: {
            type: "string",
            enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DECEASED"],
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          user: { $ref: "#/components/schemas/PatientAccountSummary" },
          contacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                contactType: {
                  type: "string",
                  enum: ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"],
                },
                phone: { type: ["string", "null"] },
                email: { type: ["string", "null"] },
                isPrimary: { type: "boolean" },
                isVerified: { type: "boolean" },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
          addresses: { type: "array", items: { type: "object" } },
          emergencyContacts: { type: "array", items: { type: "object" } },
        },
      },
      PatientRegistrationInput: {
        type: "object",
        additionalProperties: false,
        required: ["fullName"],
        description:
          "Only these fields are accepted. `tenantId`, `patientCode`, `status` and " +
          "`isVerified` are rejected by the strict schema.",
        properties: {
          fullName: { type: "string", minLength: 1, maxLength: 200 },
          dateOfBirth: {
            type: ["string", "null"],
            format: "date",
            description: "Calendar date; may not be in the future.",
          },
          gender: { type: "string", enum: ["MALE", "FEMALE", "OTHER", "UNKNOWN"] },
          bloodGroup: {
            type: ["string", "null"],
            enum: [
              "A_POSITIVE",
              "A_NEGATIVE",
              "B_POSITIVE",
              "B_NEGATIVE",
              "AB_POSITIVE",
              "AB_NEGATIVE",
              "O_POSITIVE",
              "O_NEGATIVE",
              null,
            ],
          },
          maritalStatus: {
            type: ["string", "null"],
            enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER", null],
          },
          profileImageKey: {
            type: ["string", "null"],
            description: "Relative private storage key; URLs and traversal are rejected.",
          },
          userId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "Optional existing account to link. Requires `patient:update`; matching " +
              "contact details never link an account automatically.",
          },
          contacts: {
            type: "array",
            maxItems: 20,
            description: "Registration-time contacts; not the contact-management API.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                contactType: {
                  type: "string",
                  enum: ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"],
                },
                phone: { type: ["string", "null"] },
                email: { type: ["string", "null"] },
                isPrimary: { type: "boolean" },
              },
            },
          },
          addresses: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["addressLine1"],
              properties: {
                addressType: { type: "string", enum: ["HOME", "WORK", "OTHER"] },
                addressLine1: { type: "string", maxLength: 255 },
                addressLine2: { type: ["string", "null"], maxLength: 255 },
                city: { type: ["string", "null"], maxLength: 120 },
                state: { type: ["string", "null"], maxLength: 120 },
                postalCode: { type: ["string", "null"], maxLength: 20 },
                country: {
                  type: ["string", "null"],
                  description: "ISO 3166-1 alpha-2 code.",
                  example: "US",
                },
                isPrimary: { type: "boolean" },
              },
            },
          },
          emergencyContacts: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "relationship", "phone"],
              properties: {
                name: { type: "string", maxLength: 200 },
                relationship: { type: "string", maxLength: 60 },
                phone: { type: "string" },
                email: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      PatientUpdateInput: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        description:
          "Profile fields only. `status` has its own operation; `patientCode`, " +
          "`tenantId` and `userId` are rejected.",
        properties: {
          fullName: { type: "string", minLength: 1, maxLength: 200 },
          dateOfBirth: { type: ["string", "null"], format: "date" },
          gender: { type: "string", enum: ["MALE", "FEMALE", "OTHER", "UNKNOWN"] },
          bloodGroup: {
            type: ["string", "null"],
            enum: [
              "A_POSITIVE",
              "A_NEGATIVE",
              "B_POSITIVE",
              "B_NEGATIVE",
              "AB_POSITIVE",
              "AB_NEGATIVE",
              "O_POSITIVE",
              "O_NEGATIVE",
              null,
            ],
          },
          maritalStatus: {
            type: ["string", "null"],
            enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER", null],
          },
          profileImageKey: { type: ["string", "null"] },
        },
      },
      PatientStatusInput: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        description:
          "`DECEASED` is a clinical workflow and is not assignable here. Archived " +
          "profiles must be reactivated to `ACTIVE` before becoming inactive.",
        properties: {
          status: { type: "string", enum: ["ACTIVE", "INACTIVE", "ARCHIVED"] },
        },
      },
      PatientContact: {
        type: "object",
        required: [
          "id",
          "contactType",
          "phone",
          "email",
          "isPrimary",
          "isVerified",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          contactType: {
            type: "string",
            enum: ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"],
          },
          phone: { type: ["string", "null"], description: "Normalised phone number." },
          email: { type: ["string", "null"], description: "Lower-cased email address." },
          isPrimary: {
            type: "boolean",
            description: "At most one contact row per patient is primary.",
          },
          isVerified: {
            type: "boolean",
            description: "Read-only; set only by a trusted verification workflow.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PatientContactInput: {
        type: "object",
        additionalProperties: false,
        description:
          "A contact needs a phone number, an email address or both. " +
          "`isVerified`, `tenantId` and `patientId` are rejected.",
        properties: {
          contactType: {
            type: "string",
            enum: ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"],
            default: "MOBILE",
          },
          phone: { type: ["string", "null"], example: "+15550102030" },
          email: { type: ["string", "null"], example: "patient@example.com" },
          isPrimary: { type: "boolean", default: false },
        },
      },
      PatientContactUpdateInput: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        description:
          "Partial update. Changing phone or email resets verification server-side.",
        properties: {
          contactType: {
            type: "string",
            enum: ["MOBILE", "HOME", "WORK", "GUARDIAN", "OTHER"],
          },
          phone: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          isPrimary: { type: "boolean" },
        },
      },
      PatientAddress: {
        type: "object",
        required: ["id", "addressType", "addressLine1", "isPrimary"],
        properties: {
          id: { type: "string", format: "uuid" },
          addressType: { type: "string", enum: ["HOME", "WORK", "OTHER"] },
          addressLine1: { type: "string" },
          addressLine2: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          state: { type: ["string", "null"] },
          postalCode: { type: ["string", "null"] },
          country: {
            type: ["string", "null"],
            description: "ISO 3166-1 alpha-2 code, upper-cased.",
            example: "US",
          },
          isPrimary: {
            type: "boolean",
            description: "At most one primary address per address type.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PatientAddressInput: {
        type: "object",
        additionalProperties: false,
        required: ["addressLine1"],
        properties: {
          addressType: {
            type: "string",
            enum: ["HOME", "WORK", "OTHER"],
            default: "HOME",
          },
          addressLine1: { type: "string", maxLength: 255 },
          addressLine2: { type: ["string", "null"], maxLength: 255 },
          city: { type: ["string", "null"], maxLength: 120 },
          state: { type: ["string", "null"], maxLength: 120 },
          postalCode: { type: ["string", "null"], maxLength: 20 },
          country: {
            type: ["string", "null"],
            description: "ISO 3166-1 alpha-2 code.",
            example: "US",
          },
          isPrimary: { type: "boolean", default: false },
        },
      },
      PatientAddressUpdateInput: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          addressType: { type: "string", enum: ["HOME", "WORK", "OTHER"] },
          addressLine1: { type: "string", maxLength: 255 },
          addressLine2: { type: ["string", "null"], maxLength: 255 },
          city: { type: ["string", "null"], maxLength: 120 },
          state: { type: ["string", "null"], maxLength: 120 },
          postalCode: { type: ["string", "null"], maxLength: 20 },
          country: { type: ["string", "null"] },
          isPrimary: { type: "boolean" },
        },
      },
      PatientEmergencyContact: {
        type: "object",
        required: ["id", "name", "relationship", "phone", "email"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          relationship: { type: "string" },
          phone: { type: "string" },
          email: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PatientEmergencyContactInput: {
        type: "object",
        additionalProperties: false,
        required: ["name", "relationship", "phone"],
        properties: {
          name: { type: "string", maxLength: 200 },
          relationship: { type: "string", maxLength: 60 },
          phone: { type: "string" },
          email: { type: ["string", "null"] },
        },
      },
      PatientEmergencyContactUpdateInput: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: "string", maxLength: 200 },
          relationship: { type: "string", maxLength: 60 },
          phone: { type: "string" },
          email: { type: ["string", "null"] },
        },
      },
      AppointmentStatus: {
        type: "string",
        enum: [
          "PENDING",
          "CONFIRMED",
          "CHECKED_IN",
          "IN_PROGRESS",
          "COMPLETED",
          "CANCELLED",
          "NO_SHOW",
          "RESCHEDULED",
        ],
      },
      AppointmentSource: {
        type: "string",
        enum: ["ONLINE", "RECEPTIONIST", "WALK_IN", "VOICE_AGENT"],
      },
      AppointmentType: {
        type: "string",
        enum: ["CONSULTATION", "FOLLOW_UP", "PROCEDURE", "EMERGENCY"],
      },
      AppointmentSummary: {
        type: "object",
        required: [
          "id",
          "appointmentCode",
          "patientId",
          "doctorId",
          "branchId",
          "appointmentStatus",
          "startAt",
          "endAt",
        ],
        description:
          "List projection with joined display names; the private `notes` column is never returned.",
        properties: {
          id: { type: "string", format: "uuid" },
          appointmentCode: { type: "string", example: "APT-20261207-1A2B3C4D" },
          patientId: { type: "string", format: "uuid" },
          patientCode: { type: "string", example: "P-000123" },
          patientName: { type: "string", example: "Eleanor Whitfield" },
          doctorId: { type: "string", format: "uuid" },
          doctorCode: { type: "string", example: "DOC-CAR-001" },
          doctorName: { type: "string", example: "Dr. Asha Rao" },
          branchId: { type: "string", format: "uuid" },
          branchName: { type: "string", example: "Central Hospital" },
          departmentId: { type: ["string", "null"], format: "uuid" },
          appointmentType: { $ref: "#/components/schemas/AppointmentType" },
          appointmentStatus: { $ref: "#/components/schemas/AppointmentStatus" },
          appointmentSource: { $ref: "#/components/schemas/AppointmentSource" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          durationMinutes: { type: "integer", minimum: 5, example: 30 },
          reason: { type: ["string", "null"], maxLength: 1000 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Appointment: {
        type: "object",
        required: [
          "id",
          "appointmentCode",
          "patientId",
          "doctorId",
          "branchId",
          "appointmentStatus",
          "startAt",
          "endAt",
          "consultationFee",
          "currency",
        ],
        description:
          "Server-resolved appointment. Fees, currency, status, code and audit fields are never accepted from the client.",
        properties: {
          id: { type: "string", format: "uuid" },
          appointmentCode: { type: "string", example: "APT-20261207-1A2B3C4D" },
          patientId: { type: "string", format: "uuid" },
          doctorId: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          departmentId: { type: ["string", "null"], format: "uuid" },
          appointmentSource: { $ref: "#/components/schemas/AppointmentSource" },
          appointmentType: { $ref: "#/components/schemas/AppointmentType" },
          appointmentStatus: { $ref: "#/components/schemas/AppointmentStatus" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          durationMinutes: { type: "integer", example: 30 },
          consultationFee: {
            type: "string",
            description: "Resolved from the doctor-branch assignment, never from the request.",
            example: "150.00",
          },
          currency: { type: "string", example: "GBP" },
          branchTimezone: { type: "string", example: "Europe/London" },
          reason: { type: ["string", "null"] },
          rescheduledFromAppointmentId: { type: ["string", "null"], format: "uuid" },
          cancelledBy: { type: ["string", "null"], format: "uuid" },
          cancellationReason: { type: ["string", "null"] },
          checkedInAt: { type: ["string", "null"], format: "date-time" },
          consultationStartedAt: { type: ["string", "null"], format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          noShowAt: { type: ["string", "null"], format: "date-time" },
          createdBy: { type: "string", format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          replayed: {
            type: "boolean",
            description: "True when an idempotent retry returned an already committed appointment.",
          },
        },
      },
      AppointmentCreateInput: {
        type: "object",
        additionalProperties: false,
        required: ["patientId", "doctorId", "branchId", "startAt"],
        description:
          "Only these fields are accepted. `tenantId`, `createdBy`, `appointmentStatus`, " +
          "`consultationFee`, `currency` and `appointmentCode` are rejected by the strict " +
          "schema. `ONLINE` is derived for patient self-service and is not accepted here.",
        properties: {
          patientId: { type: "string", format: "uuid" },
          doctorId: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          departmentId: { type: ["string", "null"], format: "uuid" },
          startAt: {
            type: "string",
            format: "date-time",
            description: "ISO 8601 instant with an explicit offset.",
            example: "2026-12-07T09:00:00Z",
          },
          durationMinutes: { type: "integer", minimum: 5, maximum: 480 },
          appointmentSource: {
            type: "string",
            enum: ["RECEPTIONIST", "WALK_IN", "VOICE_AGENT"],
            default: "RECEPTIONIST",
          },
          appointmentType: {
            type: "string",
            enum: ["CONSULTATION", "FOLLOW_UP", "PROCEDURE", "EMERGENCY"],
            default: "CONSULTATION",
          },
          reason: { type: ["string", "null"], maxLength: 1000 },
          notes: {
            type: ["string", "null"],
            maxLength: 2000,
            description: "Private operational note; never returned by any read endpoint.",
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "May also be sent as the `Idempotency-Key` header.",
          },
        },
      },
      AppointmentRescheduleInput: {
        type: "object",
        additionalProperties: false,
        required: ["startAt"],
        description:
          "Omit `doctorId`/`branchId` to keep them, omit `departmentId` to keep it or send " +
          "null to clear it. `endAt` and `durationMinutes` are mutually exclusive.",
        properties: {
          doctorId: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          departmentId: { type: ["string", "null"], format: "uuid" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          durationMinutes: { type: "integer", minimum: 5, maximum: 480 },
          reason: { type: ["string", "null"], maxLength: 1000 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      AppointmentCancelInput: {
        type: "object",
        additionalProperties: false,
        required: ["cancellationReason"],
        properties: {
          cancellationReason: { type: "string", minLength: 1, maxLength: 1000 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      AppointmentNoShowInput: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: ["string", "null"], maxLength: 500 },
        },
      },
      AvailabilitySlot: {
        type: "object",
        required: ["startAt", "endAt", "durationMinutes"],
        properties: {
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          durationMinutes: { type: "integer", example: 30 },
        },
      },
      AvailabilityDay: {
        type: "object",
        required: ["date", "slots"],
        properties: {
          date: { type: "string", format: "date", example: "2026-12-07" },
          slots: {
            type: "array",
            items: { $ref: "#/components/schemas/AvailabilitySlot" },
          },
        },
      },
      AppointmentAvailability: {
        type: "object",
        required: [
          "doctorId",
          "branchId",
          "branchTimezone",
          "fromDate",
          "toDate",
          "consultationFee",
          "currency",
          "days",
        ],
        properties: {
          doctorId: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          branchTimezone: { type: "string", example: "Europe/London" },
          fromDate: { type: "string", format: "date" },
          toDate: { type: "string", format: "date" },
          requestedDurationMinutes: { type: ["integer", "null"] },
          consultationFee: { type: "string", example: "150.00" },
          currency: { type: "string", example: "GBP" },
          days: {
            type: "array",
            description: "Days without a working window are present with an empty slot list.",
            items: { $ref: "#/components/schemas/AvailabilityDay" },
          },
        },
      },
      AppointmentEvent: {
        type: "object",
        required: ["id", "eventType", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          eventType: {
            type: "string",
            enum: ["CREATED", "STATUS_CHANGED", "UPDATED", "RESCHEDULED", "CANCELLED", "NO_SHOW"],
          },
          previousStatus: { type: ["string", "null"] },
          newStatus: { type: ["string", "null"] },
          actorUserId: { type: ["string", "null"], format: "uuid" },
          metadata: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PaymentAllocation: {
        type: "object",
        required: ["id", "invoiceId", "invoiceNumber", "amount"],
        properties: {
          id: { type: "string", format: "uuid" },
          invoiceId: { type: "string", format: "uuid" },
          invoiceNumber: { type: "string", example: "INV-000123" },
          amount: {
            type: "string",
            description: "Amount of this receipt applied to the invoice, 2 decimals.",
            example: "60.00",
          },
        },
      },
      PaymentSummary: {
        type: "object",
        description:
          "Receipt-level row as returned by the payment list. Free-text `notes` are " +
          "only present on the detail read.",
        required: [
          "id",
          "branchId",
          "patientId",
          "paymentMethod",
          "amount",
          "currency",
          "paymentStatus",
          "reference",
          "receivedBy",
          "receivedAt",
          "idempotencyKey",
          "createdAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          patientId: { type: "string", format: "uuid" },
          paymentMethod: {
            type: "string",
            enum: ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"],
          },
          amount: { type: "string", example: "60.00" },
          currency: { type: "string", example: "USD" },
          paymentStatus: {
            type: "string",
            description: "Manual collections are always stored SUCCESSFUL.",
            enum: ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"],
          },
          reference: { type: ["string", "null"], example: "RCPT-2026-00041" },
          receivedBy: { type: "string", format: "uuid" },
          receivedAt: { type: "string", format: "date-time" },
          idempotencyKey: { type: ["string", "null"], maxLength: 200 },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PaymentDetail: {
        description: "A receipt with its allocation lines.",
        allOf: [
          { $ref: "#/components/schemas/PaymentSummary" },
          {
            type: "object",
            required: ["notes", "allocations"],
            properties: {
              notes: { type: ["string", "null"], maxLength: 2000 },
              allocations: {
                type: "array",
                items: { $ref: "#/components/schemas/PaymentAllocation" },
              },
            },
          },
        ],
      },
      PaymentInvoiceBalance: {
        type: "object",
        description: "Post-payment balance of an invoice the receipt settled.",
        required: [
          "invoiceId",
          "invoiceNumber",
          "invoiceStatus",
          "currency",
          "subtotal",
          "discountTotal",
          "taxTotal",
          "totalAmount",
          "amountPaid",
          "refundedAmount",
          "balanceDue",
        ],
        properties: {
          invoiceId: { type: "string", format: "uuid" },
          invoiceNumber: { type: "string", example: "INV-000123" },
          invoiceStatus: {
            type: "string",
            enum: [
              "DRAFT",
              "ISSUED",
              "PARTIALLY_PAID",
              "PAID",
              "OVERDUE",
              "CANCELLED",
              "REFUNDED",
            ],
          },
          currency: { type: "string", example: "USD" },
          subtotal: { type: "string", example: "100.00" },
          discountTotal: { type: "string", example: "0.00" },
          taxTotal: { type: "string", example: "0.00" },
          totalAmount: { type: "string", example: "100.00" },
          amountPaid: { type: "string", example: "60.00" },
          refundedAmount: { type: "string", example: "0.00" },
          balanceDue: { type: "string", example: "40.00" },
        },
      },
      RecordPaymentInput: {
        type: "object",
        additionalProperties: false,
        required: ["branchId", "patientId", "method", "amount", "allocations"],
        properties: {
          branchId: { type: "string", format: "uuid" },
          patientId: { type: "string", format: "uuid" },
          method: {
            type: "string",
            enum: ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"],
          },
          amount: {
            type: ["string", "number"],
            description:
              "Total collected. Must be positive, have at most 2 decimals, and equal " +
              "the sum of `allocations` exactly.",
            example: "60.00",
          },
          currency: {
            type: ["string", "null"],
            description: "ISO 4217 code; must match the allocated invoices when supplied.",
            example: "USD",
          },
          reference: {
            type: ["string", "null"],
            maxLength: 120,
            description: "Receipt/UTR/cheque number, unique per hospital when supplied.",
          },
          notes: { type: ["string", "null"], maxLength: 2000 },
          receivedAt: {
            type: "string",
            format: "date-time",
            description:
              "When the money was taken; defaults to now and cannot be in the future. " +
              "An explicit offset is required.",
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Alternative to the `Idempotency-Key` header. One of the two is required " +
              "and they must match when both are supplied.",
          },
          allocations: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description:
              "One entry per invoice, each positive, no invoice twice, none above the " +
              "invoice balance, same patient and branch as the receipt.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["invoiceId", "amount"],
              properties: {
                invoiceId: { type: "string", format: "uuid" },
                amount: { type: ["string", "number"], example: "60.00" },
              },
            },
          },
        },
      },
      InitiatePaymentInput: {
        type: "object",
        additionalProperties: false,
        required: ["invoiceId", "method"],
        properties: {
          invoiceId: { type: "string", format: "uuid" },
          method: {
            type: "string",
            enum: ["CARD", "UPI", "BANK_TRANSFER", "OTHER"],
          },
          provider: {
            type: "string",
            enum: ["mock"],
            description: "Optional registry key; defaults to the configured provider.",
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Alternative to the `Idempotency-Key` header. One of the two is required " +
              "and they must match when both are supplied.",
          },
        },
      },
      PaymentInitiation: {
        type: "object",
        description:
          "Checkout information for an open provider order. The linked receipt is " +
          "PENDING and has not changed any invoice balance.",
        required: [
          "paymentId",
          "invoiceId",
          "invoiceNumber",
          "paymentStatus",
          "amount",
          "currency",
          "provider",
          "providerOrderId",
          "checkoutUrl",
          "expiresAt",
          "createdAt",
          "replayed",
        ],
        properties: {
          paymentId: { type: "string", format: "uuid" },
          invoiceId: { type: "string", format: "uuid" },
          invoiceNumber: { type: "string", example: "INV-000123" },
          paymentStatus: { type: "string", enum: ["PENDING"] },
          amount: {
            type: "string",
            example: "40.00",
            description: "Outstanding balance at initiation; never a client-supplied amount.",
          },
          currency: { type: "string", example: "USD" },
          provider: { type: "string", example: "mock" },
          providerOrderId: { type: "string", example: "mock_order_2f1c..." },
          checkoutUrl: { type: "string", format: "uri" },
          expiresAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          replayed: {
            type: "boolean",
            description: "True when the idempotency key replayed an existing open order.",
          },
        },
      },
      RefundSummary: {
        type: "object",
        description:
          "Refund row as returned by the list and detail reads. Free-text reason, " +
          "decision note and failure detail are only present on the detail read.",
        required: [
          "id",
          "invoiceId",
          "invoiceNumber",
          "invoicePaymentId",
          "receiptId",
          "branchId",
          "patientId",
          "amount",
          "currency",
          "refundStatus",
          "channel",
          "reference",
          "provider",
          "providerRefundId",
          "requestedBy",
          "approvedBy",
          "approvedAt",
          "processedAt",
          "refundedAt",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          invoiceId: { type: "string", format: "uuid" },
          invoiceNumber: { type: "string", example: "INV-000123" },
          invoicePaymentId: {
            type: ["string", "null"],
            format: "uuid",
            description: "The successful capture this refund reverses.",
          },
          receiptId: { type: ["string", "null"], format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          patientId: { type: "string", format: "uuid" },
          amount: { type: "string", example: "40.00" },
          currency: { type: "string", example: "USD" },
          refundStatus: {
            type: "string",
            enum: ["PENDING", "APPROVED", "PROCESSING", "SUCCESSFUL", "FAILED", "REJECTED"],
          },
          channel: {
            type: "string",
            enum: ["GATEWAY", "OFFLINE"],
            description: "Derived from whether the capture has a gateway order.",
          },
          reference: { type: ["string", "null"], maxLength: 120 },
          provider: { type: ["string", "null"], example: "mock" },
          providerRefundId: {
            type: ["string", "null"],
            description: "Provider refund id written only from a verified adapter response.",
          },
          requestedBy: { type: ["string", "null"], format: "uuid" },
          approvedBy: { type: ["string", "null"], format: "uuid" },
          approvedAt: { type: ["string", "null"], format: "date-time" },
          processedAt: { type: ["string", "null"], format: "date-time" },
          refundedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      RefundDetail: {
        description: "A refund with its free-text evidence and decision notes.",
        allOf: [
          { $ref: "#/components/schemas/RefundSummary" },
          {
            type: "object",
            required: ["reason", "decisionReason", "failureReason"],
            properties: {
              reason: { type: ["string", "null"], maxLength: 2000 },
              decisionReason: { type: ["string", "null"], maxLength: 2000 },
              failureReason: { type: ["string", "null"] },
            },
          },
        ],
      },
      CreateRefundInput: {
        type: "object",
        additionalProperties: false,
        required: ["invoicePaymentId", "amount"],
        properties: {
          invoicePaymentId: {
            type: "string",
            format: "uuid",
            description: "The successful invoice_payments capture being reversed.",
          },
          amount: {
            type: ["string", "number"],
            description:
              "Full or partial amount, positive, at most 2 decimals, within the " +
              "refundable remainder of the capture.",
            example: "40.00",
          },
          reason: { type: ["string", "null"], maxLength: 2000 },
          reference: {
            type: ["string", "null"],
            maxLength: 120,
            description: "Desk/UTR/cheque reference, unique per hospital when supplied.",
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Alternative to the `Idempotency-Key` header. One of the two is required " +
              "and they must match when both are supplied.",
          },
        },
      },
      BillingDocument: {
        type: "object",
        description:
          "Metadata of a generated billing PDF. The private storage key and any " +
          "URL are never returned.",
        required: [
          "id",
          "documentType",
          "documentNumber",
          "invoiceId",
          "paymentId",
          "refundId",
          "branchId",
          "fileName",
          "mimeType",
          "fileSize",
          "generatedBy",
          "regeneratedFromId",
          "createdAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          documentType: {
            type: "string",
            enum: ["INVOICE", "PAYMENT_RECEIPT", "CREDIT_NOTE"],
          },
          documentNumber: { type: "string", example: "INV-000123" },
          invoiceId: { type: "string", format: "uuid" },
          paymentId: { type: ["string", "null"], format: "uuid" },
          refundId: { type: ["string", "null"], format: "uuid" },
          branchId: { type: "string", format: "uuid" },
          fileName: { type: "string", example: "INV-000123.pdf" },
          mimeType: { type: "string", enum: ["application/pdf"] },
          fileSize: { type: "integer", minimum: 1 },
          generatedBy: { type: ["string", "null"], format: "uuid" },
          regeneratedFromId: { type: ["string", "null"], format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      DashboardRange: {
        type: "object",
        required: ["fromDate", "toDate", "branchId", "timezone", "asOf"],
        properties: {
          fromDate: { type: "string", format: "date" },
          toDate: { type: "string", format: "date" },
          branchId: { type: ["string", "null"], format: "uuid" },
          timezone: { type: "string", example: "Asia/Kolkata" },
          asOf: {
            type: "string",
            format: "date-time",
            description: "Snapshot instant used for the `upcoming` appointment count.",
          },
        },
      },
      DashboardAppointments: {
        allOf: [
          { $ref: "#/components/schemas/DashboardRange" },
          {
            type: "object",
            required: ["total", "completed", "cancelled", "upcoming", "noShows"],
            properties: {
              total: { type: "integer", minimum: 0 },
              completed: { type: "integer", minimum: 0 },
              cancelled: { type: "integer", minimum: 0 },
              upcoming: { type: "integer", minimum: 0 },
              noShows: { type: "integer", minimum: 0 },
            },
          },
        ],
      },
      DashboardPatients: {
        allOf: [
          { $ref: "#/components/schemas/DashboardRange" },
          {
            type: "object",
            required: ["total", "newlyRegistered"],
            description:
              "Patient profiles have no branch, so both counts are hospital-wide and " +
              "only the date range and timezone narrow `newlyRegistered`.",
            properties: {
              total: { type: "integer", minimum: 0 },
              newlyRegistered: { type: "integer", minimum: 0 },
            },
          },
        ],
      },
      DashboardDoctorWorkload: {
        type: "object",
        required: [
          "doctorId", "doctorCode", "doctorName", "appointmentCount",
          "completedCount", "upcomingCount",
        ],
        properties: {
          doctorId: { type: "string", format: "uuid" },
          doctorCode: { type: "string", example: "DOC-001" },
          doctorName: { type: ["string", "null"], example: "Dr. Asha Rao" },
          appointmentCount: { type: "integer", minimum: 0 },
          completedCount: { type: "integer", minimum: 0 },
          upcomingCount: { type: "integer", minimum: 0 },
        },
      },
      DashboardDoctors: {
        allOf: [
          { $ref: "#/components/schemas/DashboardRange" },
          {
            type: "object",
            required: ["activeDoctors", "workload"],
            properties: {
              activeDoctors: { type: "integer", minimum: 0 },
              workload: {
                type: "array",
                items: { $ref: "#/components/schemas/DashboardDoctorWorkload" },
              },
            },
          },
        ],
      },
      DashboardFinancial: {
        allOf: [
          { $ref: "#/components/schemas/DashboardRange" },
          {
            type: "object",
            required: [
              "invoiceCount", "revenue", "collections", "refunds",
              "netCollections", "pendingInvoices",
            ],
            properties: {
              invoiceCount: { type: "integer", minimum: 0 },
              revenue: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
              collections: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
              refunds: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
              netCollections: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
              pendingInvoices: {
                type: "object",
                required: ["invoiceCount", "outstanding"],
                properties: {
                  invoiceCount: { type: "integer", minimum: 0 },
                  outstanding: {
                    type: "array",
                    items: { $ref: "#/components/schemas/BillingCurrencyAmount" },
                  },
                },
              },
            },
          },
        ],
      },
      DashboardOperational: {
        allOf: [
          { $ref: "#/components/schemas/DashboardRange" },
          {
            type: "object",
            description:
              "A section is present only when the caller holds `appointment:read`, " +
              "`patient:read` or `doctor:read` for it.",
            properties: {
              appointments: {
                type: "object",
                properties: {
                  total: { type: "integer", minimum: 0 },
                  completed: { type: "integer", minimum: 0 },
                  cancelled: { type: "integer", minimum: 0 },
                  upcoming: { type: "integer", minimum: 0 },
                  noShows: { type: "integer", minimum: 0 },
                },
              },
              patients: {
                type: "object",
                properties: {
                  total: { type: "integer", minimum: 0 },
                  newlyRegistered: { type: "integer", minimum: 0 },
                },
              },
              doctors: {
                type: "object",
                properties: {
                  activeDoctors: { type: "integer", minimum: 0 },
                  workload: {
                    type: "array",
                    items: { $ref: "#/components/schemas/DashboardDoctorWorkload" },
                  },
                },
              },
            },
          },
        ],
      },
      BillingCurrencyAmount: {
        type: "object",
        required: ["currency", "amount"],
        properties: {
          currency: { type: "string", example: "USD" },
          amount: { type: "string", description: "Decimal string from a NUMERIC aggregate.", example: "1750.00" },
        },
      },
      BillingRevenueSummary: {
        type: "object",
        required: [
          "fromDate", "toDate", "timezone", "invoiceCount", "invoiced",
          "collected", "refunded", "netCollected", "outstanding",
        ],
        properties: {
          fromDate: { type: "string", format: "date" },
          toDate: { type: "string", format: "date" },
          timezone: { type: "string", example: "Asia/Kolkata" },
          invoiceCount: { type: "integer", minimum: 0 },
          invoiced: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
          collected: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
          refunded: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
          netCollected: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
          outstanding: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
        },
      },
      BillingRevenueTrend: {
        type: "object",
        required: ["granularity", "fromDate", "toDate", "timezone", "points"],
        properties: {
          granularity: { type: "string", enum: ["day", "week", "month"] },
          fromDate: { type: "string", format: "date" },
          toDate: { type: "string", format: "date" },
          timezone: { type: "string" },
          points: {
            type: "array",
            items: {
              type: "object",
              required: ["period", "currency", "invoiced", "collected", "refunded", "netCollected"],
              properties: {
                period: { type: "string", format: "date", description: "Start of the bucket." },
                currency: { type: "string" },
                invoiced: { type: "string" },
                collected: { type: "string" },
                refunded: { type: "string" },
                netCollected: { type: "string" },
              },
            },
          },
        },
      },
      BillingOutstandingSummary: {
        type: "object",
        required: ["asOf", "timezone", "invoiceCount", "outstanding"],
        properties: {
          asOf: { type: "string", format: "date" },
          timezone: { type: "string" },
          invoiceCount: { type: "integer", minimum: 0 },
          outstanding: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
        },
      },
      BillingOutstandingInvoice: {
        type: "object",
        required: [
          "invoiceId", "invoiceNumber", "branchId", "branchName", "invoiceStatus",
          "invoiceType", "issueDate", "dueDate", "currency", "totalAmount",
          "amountPaid", "balanceDue",
        ],
        properties: {
          invoiceId: { type: "string", format: "uuid" },
          invoiceNumber: { type: "string" },
          branchId: { type: "string", format: "uuid" },
          branchName: { type: "string" },
          invoiceStatus: { type: "string" },
          invoiceType: { type: "string" },
          issueDate: { type: "string", format: "date" },
          dueDate: { type: ["string", "null"], format: "date" },
          currency: { type: "string" },
          totalAmount: { type: "string" },
          amountPaid: { type: "string" },
          balanceDue: { type: "string" },
        },
      },
      BillingStatusDistribution: {
        type: "object",
        required: ["status", "count", "totals"],
        properties: {
          status: { type: "string" },
          count: { type: "integer", minimum: 0 },
          totals: { type: "array", items: { $ref: "#/components/schemas/BillingCurrencyAmount" } },
        },
      },
      BillingBranchRevenue: {
        type: "object",
        required: [
          "branchId", "branchName", "currency", "invoiceCount", "invoiced",
          "collected", "refunded", "netCollected", "outstanding",
        ],
        properties: {
          branchId: { type: "string", format: "uuid" },
          branchName: { type: "string" },
          currency: { type: "string" },
          invoiceCount: { type: "integer" },
          invoiced: { type: "string" },
          collected: { type: "string" },
          refunded: { type: "string" },
          netCollected: { type: "string" },
          outstanding: { type: "string" },
        },
      },
      BillingPaymentMethodRevenue: {
        type: "object",
        required: ["paymentMethod", "currency", "paymentCount", "collected", "refunded", "netCollected"],
        properties: {
          paymentMethod: { type: "string" },
          currency: { type: "string" },
          paymentCount: { type: "integer" },
          collected: { type: "string" },
          refunded: { type: "string" },
          netCollected: { type: "string" },
        },
      },
      BillingInvoiceTypeRevenue: {
        type: "object",
        required: ["invoiceType", "currency", "invoiceCount", "invoiced", "collected", "refunded", "outstanding"],
        properties: {
          invoiceType: { type: "string" },
          currency: { type: "string" },
          invoiceCount: { type: "integer" },
          invoiced: { type: "string" },
          collected: { type: "string" },
          refunded: { type: "string" },
          outstanding: { type: "string" },
        },
      },
      BillingDoctorRevenue: {
        type: "object",
        required: ["doctorId", "doctorCode", "doctorName", "currency", "invoiceCount", "invoiced", "collected", "refunded", "netCollected"],
        properties: {
          doctorId: { type: "string", format: "uuid" },
          doctorCode: { type: "string" },
          doctorName: { type: ["string", "null"] },
          currency: { type: "string" },
          invoiceCount: { type: "integer" },
          invoiced: { type: "string" },
          collected: { type: "string" },
          refunded: { type: "string" },
          netCollected: { type: "string" },
        },
      },
      BillingDepartmentRevenue: {
        type: "object",
        required: ["departmentId", "departmentName", "currency", "invoiceCount", "invoiced", "collected", "refunded", "netCollected"],
        properties: {
          departmentId: { type: "string", format: "uuid" },
          departmentName: { type: "string" },
          currency: { type: "string" },
          invoiceCount: { type: "integer" },
          invoiced: { type: "string" },
          collected: { type: "string" },
          refunded: { type: "string" },
          netCollected: { type: "string" },
        },
      },
      RefundDecisionInput: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: ["string", "null"], maxLength: 2000 },
        },
      },
      ProcessRefundInput: {
        type: "object",
        additionalProperties: false,
        description:
          "Both fields are optional. A gateway refund takes its evidence from the " +
          "adapter; the desk reference is operational text only. Provider ids and " +
          "statuses are rejected.",
        properties: {
          reference: { type: ["string", "null"], maxLength: 120 },
        },
      },
    },
    parameters: {
      CsrfToken: csrfParameter,
    },
  },
  paths: {
    "/patients": {
      post: {
        tags: ["Patients"],
        summary: "Register a patient",
        description:
          "Registers a patient in the caller's hospital and returns the full profile. " +
          "The patient code is generated server-side. Profile, contacts, addresses and " +
          "emergency contacts are created in one transaction. Linking `userId` also " +
          "requires `patient:update`.",
        operationId: "createPatient",
        "x-required-permission": "patient:create",
        parameters: [{ $ref: "#/components/parameters/CsrfToken" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientRegistrationInput" },
              example: {
                fullName: "Eleanor Whitfield",
                dateOfBirth: "1958-04-12",
                gender: "FEMALE",
                bloodGroup: "O_POSITIVE",
                contacts: [{ contactType: "MOBILE", phone: "+15550102030", isPrimary: true }],
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["patient"],
              properties: { patient: { $ref: "#/components/schemas/PatientProfile" } },
            },
            "Patient registered.",
          ),
          401: unauthorized,
          403: forbidden,
          409: errorResponse("The account is already linked to a patient in this hospital.", "CONFLICT"),
          422: validation,
        },
      },
      get: {
        tags: ["Patients"],
        summary: "List and search patients",
        description:
          "Lists live (non-deleted) patients of the caller's hospital. `search` " +
          "matches full name or patient code. `dateFrom`/`dateTo` are inclusive " +
          "registration-date bounds.",
        operationId: "listPatients",
        "x-required-permission": "patient:read",
        parameters: [
          ...paginationParameters,
          {
            name: "search",
            in: "query",
            required: false,
            description: "Case-insensitive match on full name or patient code.",
            schema: { type: "string", maxLength: 100 },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DECEASED"],
            },
          },
          {
            name: "gender",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["MALE", "FEMALE", "OTHER", "UNKNOWN"],
            },
          },
          {
            name: "dateFrom",
            in: "query",
            required: false,
            description: "Registered on or after this calendar date (inclusive).",
            schema: { type: "string", format: "date" },
          },
          {
            name: "dateTo",
            in: "query",
            required: false,
            description: "Registered on or before this calendar date (inclusive).",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope("patients", "#/components/schemas/PatientSummary", "Paginated patients."),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/patients/{patientId}": {
      get: {
        tags: ["Patients"],
        summary: "Retrieve a patient profile",
        description:
          "Returns the profile with its contacts, addresses and emergency contacts. " +
          "Archived profiles remain readable; soft-deleted and cross-tenant ids are 404.",
        operationId: "getPatient",
        "x-required-permission": "patient:read",
        parameters: [idParameter("patientId", "Patient id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["patient"],
              properties: { patient: { $ref: "#/components/schemas/PatientProfile" } },
            },
            "Patient profile.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
      patch: {
        tags: ["Patients"],
        summary: "Update a patient profile",
        description:
          "Partial profile update. Archived patients must be reactivated first. " +
          "Contact, address and emergency-contact rows are never rewritten here.",
        operationId: "updatePatient",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientUpdateInput" },
              example: { fullName: "Eleanor Whitfield-Smith", maritalStatus: "WIDOWED" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["patient"],
              properties: { patient: { $ref: "#/components/schemas/PatientProfile" } },
            },
            "Patient updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The patient is archived and must be reactivated first.", "CONFLICT"),
          422: validation,
        },
      },
      delete: {
        tags: ["Patients"],
        summary: "Soft delete a patient",
        description:
          "Archives the patient and sets `deleted_at`; nothing is hard deleted and " +
          "dependent records are retained. Repeated deletion is a no-op.",
        operationId: "deletePatient",
        "x-required-permission": "patient:delete",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Patient soft deleted." },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("A deceased patient record cannot be archived.", "CONFLICT"),
          422: validation,
        },
      },
    },
    "/patients/{patientId}/status": {
      patch: {
        tags: ["Patients"],
        summary: "Update patient status",
        description:
          "ACTIVE <-> INACTIVE, ACTIVE/INACTIVE -> ARCHIVED and ARCHIVED -> ACTIVE. " +
          "`ARCHIVED -> INACTIVE` is rejected so reactivation is always deliberate; " +
          "`DECEASED` is not assignable through this operation.",
        operationId: "updatePatientStatus",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientStatusInput" },
              example: { status: "INACTIVE" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["patient"],
              properties: { patient: { $ref: "#/components/schemas/PatientProfile" } },
            },
            "Patient status updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The transition is not permitted for the current status.", "CONFLICT"),
          422: validation,
        },
      },
    },
    "/patients/{patientId}/contacts": {
      post: {
        tags: ["Patients"],
        summary: "Add a patient contact",
        description:
          "Adds a phone and/or email contact. `contactType` records the purpose " +
          "(MOBILE/HOME/WORK/GUARDIAN/OTHER). Passing `isPrimary: true` demotes the " +
          "previous primary in the same transaction. New contacts are unverified.",
        operationId: "addPatientContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientContactInput" },
              example: { contactType: "MOBILE", phone: "+15550102030", isPrimary: true },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["contact"],
              properties: { contact: { $ref: "#/components/schemas/PatientContact" } },
            },
            "Contact added.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Patients"],
        summary: "List patient contacts",
        description: "Primary first, then oldest first. Live patients only.",
        operationId: "listPatientContacts",
        "x-required-permission": "patient:read",
        parameters: [idParameter("patientId", "Patient id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["contacts"],
              properties: {
                contacts: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PatientContact" },
                },
              },
            },
            "Patient contacts.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/contacts/{contactId}": {
      patch: {
        tags: ["Patients"],
        summary: "Update a patient contact",
        description:
          "Partial update. The resulting row must still carry a phone or email, " +
          "and changing a value resets verification server-side.",
        operationId: "updatePatientContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("contactId", "Contact id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientContactUpdateInput" },
              example: { phone: "+15550109999" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["contact"],
              properties: { contact: { $ref: "#/components/schemas/PatientContact" } },
            },
            "Contact updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      delete: {
        tags: ["Patients"],
        summary: "Delete a patient contact",
        description:
          "Physical delete of the contact row only. A primary contact may be " +
          "deleted; the remaining contacts are untouched.",
        operationId: "deletePatientContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("contactId", "Contact id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Contact deleted." },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/contacts/{contactId}/primary": {
      patch: {
        tags: ["Patients"],
        summary: "Set a contact as primary",
        description:
          "Promotes the contact and demotes the previous primary in one " +
          "transaction. Concurrent promotions either resolve to one primary or " +
          "return 409; they never leave two primary rows.",
        operationId: "setPrimaryPatientContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("contactId", "Contact id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["contact"],
              properties: { contact: { $ref: "#/components/schemas/PatientContact" } },
            },
            "Primary contact updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/addresses": {
      post: {
        tags: ["Patients"],
        summary: "Add a patient address",
        description:
          "Adds one address. A primary address replaces the primary of the same " +
          "address type in the same transaction.",
        operationId: "addPatientAddress",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientAddressInput" },
              example: {
                addressType: "HOME",
                addressLine1: "12 Rosewood Lane",
                city: "Springfield",
                postalCode: "62704",
                country: "US",
                isPrimary: true,
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["address"],
              properties: { address: { $ref: "#/components/schemas/PatientAddress" } },
            },
            "Address added.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Patients"],
        summary: "List patient addresses",
        description: "Primary first, then oldest first. Live patients only.",
        operationId: "listPatientAddresses",
        "x-required-permission": "patient:read",
        parameters: [idParameter("patientId", "Patient id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["addresses"],
              properties: {
                addresses: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PatientAddress" },
                },
              },
            },
            "Patient addresses.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/addresses/{addressId}": {
      patch: {
        tags: ["Patients"],
        summary: "Update a patient address",
        description:
          "Partial update validated as a whole. Changing a primary address to a " +
          "category that already has a primary returns 409.",
        operationId: "updatePatientAddress",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("addressId", "Address id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientAddressUpdateInput" },
              example: { city: "Shelbyville", postalCode: "62705" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["address"],
              properties: { address: { $ref: "#/components/schemas/PatientAddress" } },
            },
            "Address updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      delete: {
        tags: ["Patients"],
        summary: "Delete a patient address",
        description: "Physical delete of the address row only.",
        operationId: "deletePatientAddress",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("addressId", "Address id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Address deleted." },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/addresses/{addressId}/primary": {
      patch: {
        tags: ["Patients"],
        summary: "Set an address as primary",
        description:
          "Promotes the address within its own category and demotes the previous " +
          "primary of that category in one transaction. Concurrent promotions " +
          "either resolve to one primary or return 409.",
        operationId: "setPrimaryPatientAddress",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("addressId", "Address id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["address"],
              properties: { address: { $ref: "#/components/schemas/PatientAddress" } },
            },
            "Primary address updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/emergency-contacts": {
      post: {
        tags: ["Patients"],
        summary: "Add an emergency contact",
        description:
          "Emergency contacts are tenant-scoped records, not patients or global " +
          "users. Phone and email are normalised server-side. There is no primary " +
          "emergency contact.",
        operationId: "addPatientEmergencyContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PatientEmergencyContactInput" },
              example: {
                name: "Margaret Whitfield",
                relationship: "Sister",
                phone: "+15550109999",
                email: "margaret@example.com",
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["emergencyContact"],
              properties: {
                emergencyContact: {
                  $ref: "#/components/schemas/PatientEmergencyContact",
                },
              },
            },
            "Emergency contact added.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Patients"],
        summary: "List emergency contacts",
        description: "Oldest first. Live patients only.",
        operationId: "listPatientEmergencyContacts",
        "x-required-permission": "patient:read",
        parameters: [idParameter("patientId", "Patient id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["emergencyContacts"],
              properties: {
                emergencyContacts: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PatientEmergencyContact" },
                },
              },
            },
            "Emergency contacts.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/patients/{patientId}/emergency-contacts/{emergencyContactId}": {
      patch: {
        tags: ["Patients"],
        summary: "Update an emergency contact",
        description:
          "Partial update. Name, relationship and phone cannot be emptied; email " +
          "may be cleared with null.",
        operationId: "updatePatientEmergencyContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("emergencyContactId", "Emergency contact id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/PatientEmergencyContactUpdateInput",
              },
              example: { relationship: "Guardian", email: null },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["emergencyContact"],
              properties: {
                emergencyContact: {
                  $ref: "#/components/schemas/PatientEmergencyContact",
                },
              },
            },
            "Emergency contact updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      delete: {
        tags: ["Patients"],
        summary: "Delete an emergency contact",
        description: "Physical delete of the emergency contact row only.",
        operationId: "deletePatientEmergencyContact",
        "x-required-permission": "patient:update",
        parameters: [
          idParameter("patientId", "Patient id."),
          idParameter("emergencyContactId", "Emergency contact id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Emergency contact deleted." },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/doctor-schedules": {
      post: {
        tags: ["Doctor Schedules"],
        summary: "Create a recurring doctor schedule",
        description:
          "Creates one weekly working window. The doctor must be actively assigned " +
          "to the branch and may not have an overlapping active window for the same " +
          "weekday and branch.",
        operationId: "createDoctorSchedule",
        "x-required-permission": "schedule.create",
        security: [{ cookieAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/CsrfToken" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DoctorScheduleInput" },
              example: {
                doctorId: "8b1d0a52-6f95-4c45-9f2f-1f2a3c4d5e6f",
                branchId: "c2f4a7e0-3d21-4a88-9b1e-2a3b4c5d6e7f",
                dayOfWeek: 1,
                startTime: "09:00",
                endTime: "13:00",
                slotDurationMinutes: 15,
                bufferMinutes: 5,
                effectiveFrom: "2026-01-05",
                effectiveUntil: null,
                isActive: true,
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["schedule"],
              properties: { schedule: { $ref: "#/components/schemas/DoctorSchedule" } },
            },
            "Schedule created.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Doctor Schedules"],
        summary: "List doctor schedules",
        description: "Lists recurring windows for the caller's hospital with optional filters.",
        operationId: "listDoctorSchedules",
        "x-required-permission": "schedule.read",
        parameters: [
          ...paginationParameters,
          {
            name: "doctorId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "dayOfWeek",
            in: "query",
            required: false,
            description: "ISO weekday, 1 (Monday) to 7 (Sunday).",
            schema: { type: "integer", minimum: 1, maximum: 7 },
          },
          {
            name: "isActive",
            in: "query",
            required: false,
            schema: { type: "boolean" },
          },
          {
            name: "effectiveDate",
            in: "query",
            required: false,
            description: "Only windows effective on this branch-local calendar date.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope(
            "schedules",
            "#/components/schemas/DoctorSchedule",
            "Paginated schedules.",
          ),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/doctor-schedules/{id}": {
      get: {
        tags: ["Doctor Schedules"],
        summary: "Get a doctor schedule",
        operationId: "getDoctorSchedule",
        "x-required-permission": "schedule.read",
        parameters: [idParameter("id", "Schedule id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["schedule"],
              properties: { schedule: { $ref: "#/components/schemas/DoctorSchedule" } },
            },
            "Schedule detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
      patch: {
        tags: ["Doctor Schedules"],
        summary: "Update a doctor schedule",
        description:
          "Partial update. The service validates the complete resulting schedule " +
          "(time order, slot duration, effective range and overlaps), not just the " +
          "patched fields. The doctor cannot be changed; the branch can, when the " +
          "doctor is assigned there.",
        operationId: "updateDoctorSchedule",
        "x-required-permission": "schedule.update",
        parameters: [
          idParameter("id", "Schedule id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                minProperties: 1,
                properties: {
                  branchId: { type: "string", format: "uuid" },
                  dayOfWeek: { type: "integer", minimum: 1, maximum: 7 },
                  startTime: { type: "string", example: "10:00" },
                  endTime: { type: "string", example: "14:00" },
                  slotDurationMinutes: { type: "integer", minimum: 5, maximum: 480 },
                  bufferMinutes: { type: "integer", minimum: 0 },
                  effectiveFrom: { type: "string", format: "date" },
                  effectiveUntil: { type: ["string", "null"], format: "date" },
                },
              },
              example: { startTime: "10:00", endTime: "14:00" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["schedule"],
              properties: { schedule: { $ref: "#/components/schemas/DoctorSchedule" } },
            },
            "Schedule updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      delete: {
        tags: ["Doctor Schedules"],
        summary: "Delete a doctor schedule",
        description:
          "Hard deletes the window; its breaks cascade. Deactivation is the " +
          "history-preserving alternative.",
        operationId: "deleteDoctorSchedule",
        "x-required-permission": "schedule.delete",
        parameters: [
          idParameter("id", "Schedule id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Schedule deleted." },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/doctor-schedules/{id}/status": {
      patch: {
        tags: ["Doctor Schedules"],
        summary: "Activate or deactivate a schedule",
        description:
          "Deactivation keeps the row as history. Reactivation re-runs the overlap " +
          "check and fails with 409 when a newer active window occupies the slot.",
        operationId: "updateDoctorScheduleStatus",
        "x-required-permission": "schedule.update",
        parameters: [
          idParameter("id", "Schedule id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["isActive"],
                properties: { isActive: { type: "boolean", example: false } },
              },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["schedule"],
              properties: { schedule: { $ref: "#/components/schemas/DoctorSchedule" } },
            },
            "Schedule status updated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/doctor-breaks": {
      post: {
        tags: ["Doctor Breaks"],
        summary: "Create a doctor break",
        description:
          "Creates a recurring pause inside an active schedule window. The break " +
          "must sit entirely inside the window, must not overlap another break and " +
          "is expressed in the same branch-local wall-clock times as its schedule.",
        operationId: "createDoctorBreak",
        "x-required-permission": "schedule.break.create",
        parameters: [{ $ref: "#/components/parameters/CsrfToken" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DoctorBreakInput" },
              example: {
                scheduleId: "1b2c3d4e-5f60-4a71-8b92-0c1d2e3f4a5b",
                startTime: "11:00",
                endTime: "11:15",
                reason: "Lunch",
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["break"],
              properties: { break: { $ref: "#/components/schemas/DoctorBreak" } },
            },
            "Break created.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Doctor Breaks"],
        summary: "List doctor breaks",
        description: "Lists breaks in the caller's hospital with optional filters.",
        operationId: "listDoctorBreaks",
        "x-required-permission": "schedule.break.read",
        parameters: [
          ...paginationParameters,
          {
            name: "scheduleId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "doctorId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: listEnvelope("breaks", "#/components/schemas/DoctorBreak", "Paginated breaks."),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/doctor-breaks/{id}": {
      get: {
        tags: ["Doctor Breaks"],
        summary: "Get a doctor break",
        operationId: "getDoctorBreak",
        "x-required-permission": "schedule.break.read",
        parameters: [idParameter("id", "Break id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["break"],
              properties: { break: { $ref: "#/components/schemas/DoctorBreak" } },
            },
            "Break detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
      patch: {
        tags: ["Doctor Breaks"],
        summary: "Update a doctor break",
        description:
          "Partial update. The service validates the complete resulting interval " +
          "against the parent schedule and neighbouring breaks.",
        operationId: "updateDoctorBreak",
        "x-required-permission": "schedule.break.update",
        parameters: [
          idParameter("id", "Break id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                minProperties: 1,
                properties: {
                  startTime: { type: "string", example: "11:30" },
                  endTime: { type: "string", example: "11:45" },
                  reason: { type: ["string", "null"], maxLength: 255 },
                },
              },
              example: { startTime: "11:30", endTime: "11:45", reason: "Lunch" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["break"],
              properties: { break: { $ref: "#/components/schemas/DoctorBreak" } },
            },
            "Break updated.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      delete: {
        tags: ["Doctor Breaks"],
        summary: "Delete a doctor break",
        description: "Deletes the break. Idempotent: a missing break still returns 204.",
        operationId: "deleteDoctorBreak",
        "x-required-permission": "schedule.break.delete",
        parameters: [
          idParameter("id", "Break id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          204: { description: "Break deleted." },
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/doctor-leaves": {
      post: {
        tags: ["Doctor Leaves"],
        summary: "Create a leave request",
        description:
          "Creates a PENDING request attributed to the authenticated actor. " +
          "`startAt`/`endAt` are timezone-aware ISO instants. Unknown fields, " +
          "including status and approval metadata, are rejected.",
        operationId: "createDoctorLeave",
        "x-required-permission": "doctor.leave.create",
        parameters: [{ $ref: "#/components/parameters/CsrfToken" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DoctorLeaveInput" },
              example: {
                doctorId: "8b1d0a52-6f95-4c45-9f2f-1f2a3c4d5e6f",
                branchId: null,
                startAt: "2026-02-02T09:00:00+05:30",
                endAt: "2026-02-04T18:00:00+05:30",
                reason: "Family medical leave",
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave request created.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
      get: {
        tags: ["Doctor Leaves"],
        summary: "List leave requests",
        operationId: "listDoctorLeaves",
        "x-required-permission": "doctor.leave.read",
        parameters: [
          ...paginationParameters,
          {
            name: "doctorId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
            },
          },
          {
            name: "startDate",
            in: "query",
            required: false,
            description: "Only leave ending on or after this UTC calendar date.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "endDate",
            in: "query",
            required: false,
            description: "Only leave starting on or before this UTC calendar date.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope("leaves", "#/components/schemas/DoctorLeave", "Paginated leaves."),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/doctor-leaves/{id}": {
      get: {
        tags: ["Doctor Leaves"],
        summary: "Get a leave request",
        operationId: "getDoctorLeave",
        "x-required-permission": "doctor.leave.read",
        parameters: [idParameter("id", "Leave id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
      patch: {
        tags: ["Doctor Leaves"],
        summary: "Update a pending leave request",
        description:
          "Only PENDING requests can be edited, and only by the requesting doctor or " +
          "a caller with leave-management permission. The service enforces both rules.",
        operationId: "updateDoctorLeave",
        "x-required-permission": "doctor.leave.update",
        parameters: [
          idParameter("id", "Leave id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  branchId: { type: ["string", "null"], format: "uuid" },
                  startAt: { type: "string", format: "date-time" },
                  endAt: { type: "string", format: "date-time" },
                  reason: { type: ["string", "null"], maxLength: 1000 },
                },
              },
              example: { endAt: "2026-02-05T18:00:00+05:30" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave updated.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/doctor-leaves/{id}/approve": {
      patch: {
        tags: ["Doctor Leaves"],
        summary: "Approve a leave request",
        description:
          "Only PENDING requests can be approved. The approver is the authenticated " +
          "actor; approval metadata is never read from the body. Self-approval is " +
          "rejected unless hospital policy allows it.",
        operationId: "approveDoctorLeave",
        "x-required-permission": "doctor.leave.approve",
        parameters: [
          idParameter("id", "Leave id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave approved.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/doctor-leaves/{id}/reject": {
      patch: {
        tags: ["Doctor Leaves"],
        summary: "Reject a leave request",
        description:
          "Only PENDING requests can be rejected. The rejection reason is required " +
          "and the rejecting actor comes from the session.",
        operationId: "rejectDoctorLeave",
        "x-required-permission": "doctor.leave.reject",
        parameters: [
          idParameter("id", "Leave id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["rejectionReason"],
                additionalProperties: false,
                properties: {
                  rejectionReason: {
                    type: "string",
                    minLength: 1,
                    maxLength: 1000,
                    example: "Coverage unavailable on those dates",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave rejected.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/doctor-leaves/{id}/cancel": {
      patch: {
        tags: ["Doctor Leaves"],
        summary: "Cancel a leave request",
        description:
          "The requesting doctor may cancel their own request; anyone else needs " +
          "leave-management permission. Rejected and already-cancelled requests " +
          "cannot be cancelled.",
        operationId: "cancelDoctorLeave",
        "x-required-permission": "doctor.leave.cancel",
        parameters: [
          idParameter("id", "Leave id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["leave"],
              properties: { leave: { $ref: "#/components/schemas/DoctorLeave" } },
            },
            "Leave cancelled.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
        },
      },
    },
    "/appointments/availability": {
      get: {
        tags: ["Appointments"],
        summary: "Get doctor availability",
        description:
          "Returns bookable slots for a doctor at a branch, for one date or an " +
          "inclusive range of at most 31 days. Read-only: availability never creates " +
          "or reserves an appointment. Slots are absolute instants interpreted from the " +
          "branch's IANA timezone.",
        operationId: "getAppointmentAvailability",
        "x-required-permission": "appointment:read",
        parameters: [
          {
            name: "doctorId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "date",
            in: "query",
            required: false,
            description: "Single branch-local calendar date; excludes fromDate/toDate.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            description: "Inclusive range start; requires toDate.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "toDate",
            in: "query",
            required: false,
            description: "Inclusive range end; at most 31 days after fromDate.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "durationMinutes",
            in: "query",
            required: false,
            description:
              "Consultation length override (5-480). Defaults to each working window's configured slot duration.",
            schema: { type: "integer", minimum: 5, maximum: 480 },
          },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["availability"],
              properties: {
                availability: { $ref: "#/components/schemas/AppointmentAvailability" },
              },
            },
            "Availability for the requested day or range.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/appointments/availability/{doctorId}": {
      get: {
        tags: ["Appointments"],
        summary: "Get availability for a specific doctor",
        description:
          "Same read-only availability model as the collection endpoint, with the " +
          "doctor taken from the path. The doctor and branch must belong to the " +
          "caller's hospital and the doctor must be actively assigned to the branch.",
        operationId: "getDoctorAppointmentAvailability",
        "x-required-permission": "appointment:read",
        parameters: [
          idParameter("doctorId", "Doctor id."),
          {
            name: "branchId",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "date",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          {
            name: "toDate",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          {
            name: "durationMinutes",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 5, maximum: 480 },
          },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["availability"],
              properties: {
                availability: { $ref: "#/components/schemas/AppointmentAvailability" },
              },
            },
            "Availability for the requested doctor.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/appointments": {
      post: {
        tags: ["Appointments"],
        summary: "Book an appointment",
        description:
          "Books one appointment inside a tenant transaction. The slot is revalidated " +
          "against the scheduling model, the consultation fee and currency are resolved " +
          "from the doctor-branch assignment, and a duplicate overlapping booking is a " +
          "409 `SLOT_UNAVAILABLE`. An `Idempotency-Key` is required so a retry can never " +
          "double book; replaying the same key and payload returns the committed " +
          "appointment with `replayed: true` and a 200 response.",
        operationId: "createAppointment",
        "x-required-permission": "appointment:create",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "1-200 characters; may also be sent as `idempotencyKey` in the body.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AppointmentCreateInput" },
              example: {
                patientId: "6f1c2c4e-6a1b-4c0e-9c2f-2a5b8d1e3f40",
                doctorId: "a3b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d",
                branchId: "b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e",
                startAt: "2026-12-07T09:00:00Z",
                reason: "Follow-up consultation",
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["appointment"],
              properties: { appointment: { $ref: "#/components/schemas/Appointment" } },
            },
            "Appointment booked.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment"],
              properties: { appointment: { $ref: "#/components/schemas/Appointment" } },
            },
            "Idempotent replay of a committed booking (`replayed: true`).",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The slot is unavailable, the idempotency key is in use, or it was reused with a different payload.",
            "SLOT_UNAVAILABLE",
          ),
          422: validation,
        },
      },
      get: {
        tags: ["Appointments"],
        summary: "List and filter appointments",
        description:
          "Tenant-scoped list with joined patient, doctor and branch display names. " +
          "`dateFrom`/`dateTo` are inclusive UTC calendar-date bounds on the start " +
          "instant. A caller who is a doctor in this hospital only sees appointments " +
          "assigned to them; requesting another doctor's `doctorId` is a 403. The " +
          "private `notes` column is never returned.",
        operationId: "listAppointments",
        "x-required-permission": "appointment:read",
        parameters: [
          ...paginationParameters,
          {
            name: "search",
            in: "query",
            required: false,
            description: "Case-insensitive match on appointment code, patient name or patient code.",
            schema: { type: "string", maxLength: 100 },
          },
          { name: "patientId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "doctorId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "branchId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "departmentId", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "status", in: "query", required: false, schema: { $ref: "#/components/schemas/AppointmentStatus" } },
          { name: "source", in: "query", required: false, schema: { $ref: "#/components/schemas/AppointmentSource" } },
          {
            name: "dateFrom",
            in: "query",
            required: false,
            description: "Appointments starting on or after this UTC calendar date.",
            schema: { type: "string", format: "date" },
          },
          {
            name: "dateTo",
            in: "query",
            required: false,
            description: "Appointments starting on or before this UTC calendar date.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope(
            "appointments",
            "#/components/schemas/AppointmentSummary",
            "Paginated appointments.",
          ),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/appointments/code/{appointmentCode}": {
      get: {
        tags: ["Appointments"],
        summary: "Retrieve an appointment by its public code",
        description:
          "Looks the appointment up by its tenant-unique operational code. Unknown " +
          "and cross-tenant codes are a 404. Doctor-specific visibility still applies.",
        operationId: "getAppointmentByCode",
        "x-required-permission": "appointment:read",
        parameters: [
          {
            name: "appointmentCode",
            in: "path",
            required: true,
            description: "Appointment code, e.g. APT-20261207-1A2B3C4D.",
            schema: { type: "string", maxLength: 40 },
          },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment"],
              properties: { appointment: { $ref: "#/components/schemas/Appointment" } },
            },
            "Appointment detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}": {
      get: {
        tags: ["Appointments"],
        summary: "Retrieve appointment details",
        description:
          "Returns the server-resolved appointment. Cross-tenant ids are a 404; a " +
          "doctor may only read appointments assigned to them.",
        operationId: "getAppointment",
        "x-required-permission": "appointment:read",
        parameters: [idParameter("appointmentId", "Appointment id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment"],
              properties: { appointment: { $ref: "#/components/schemas/Appointment" } },
            },
            "Appointment detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/reschedule": {
      post: {
        tags: ["Appointments"],
        summary: "Reschedule an appointment",
        description:
          "Uses the Phase 18.4 replacement model: the original row becomes RESCHEDULED " +
          "and a new CONFIRMED appointment is linked to it, so exactly one active " +
          "reservation remains. The target slot is revalidated and the fee is resolved " +
          "server-side. Reusing an idempotency key with a different payload is a 409. " +
          "A caller who holds a doctor profile may only reschedule their own appointments.",
        operationId: "rescheduleAppointment",
        "x-required-permission": "appointment:update",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: "Optional; may also be sent as `idempotencyKey` in the body.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AppointmentRescheduleInput" },
              example: { startAt: "2026-12-08T10:00:00Z", reason: "Patient request" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "original"],
              properties: {
                appointment: {
                  allOf: [{ $ref: "#/components/schemas/Appointment" }],
                  description: "New CONFIRMED appointment holding the target slot.",
                },
                original: {
                  allOf: [{ $ref: "#/components/schemas/Appointment" }],
                  description: "Superseded appointment, now RESCHEDULED.",
                },
              },
            },
            "Appointment rescheduled.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The target slot is unavailable or the appointment cannot be rescheduled in its current state.",
            "SLOT_UNAVAILABLE",
          ),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/cancel": {
      post: {
        tags: ["Appointments"],
        summary: "Cancel an appointment",
        description:
          "Cancels a PENDING, CONFIRMED or CHECKED_IN appointment, records the " +
          "mandatory reason and releases the slot. Repeating the cancellation is a " +
          "no-op that returns the cancelled appointment. IN_PROGRESS and terminal " +
          "appointments are rejected with 409. A caller who holds a doctor profile may " +
          "only cancel their own appointments.",
        operationId: "cancelAppointment",
        "x-required-permission": "appointment:cancel",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AppointmentCancelInput" },
              example: { cancellationReason: "Patient called to cancel" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment"],
              properties: { appointment: { $ref: "#/components/schemas/Appointment" } },
            },
            "Appointment cancelled.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The appointment cannot be cancelled in its current state.", "INVALID_STATUS_TRANSITION"),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/check-in": {
      post: {
        tags: ["Appointments"],
        summary: "Check a patient in",
        description:
          "CONFIRMED -> CHECKED_IN. Records `checkedInAt` and one STATUS_CHANGED event. " +
          "Repeating the action is an idempotent no-op with `applied: false`.",
        operationId: "checkInAppointment",
        "x-required-permission": "appointment:update",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "applied"],
              properties: {
                appointment: { $ref: "#/components/schemas/Appointment" },
                applied: { type: "boolean" },
              },
            },
            "Appointment checked in.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The transition is not allowed from the current status.", "INVALID_STATUS_TRANSITION"),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/start": {
      post: {
        tags: ["Appointments"],
        summary: "Start the consultation",
        description:
          "CHECKED_IN -> IN_PROGRESS. Records `consultationStartedAt` and one event.",
        operationId: "startAppointment",
        "x-required-permission": "appointment:update",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "applied"],
              properties: {
                appointment: { $ref: "#/components/schemas/Appointment" },
                applied: { type: "boolean" },
              },
            },
            "Consultation started.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The transition is not allowed from the current status.", "INVALID_STATUS_TRANSITION"),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/complete": {
      post: {
        tags: ["Appointments"],
        summary: "Complete the appointment",
        description:
          "IN_PROGRESS -> COMPLETED. Records `completedAt` and one event. Payment " +
          "state is untouched.",
        operationId: "completeAppointment",
        "x-required-permission": "appointment:update",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "applied"],
              properties: {
                appointment: { $ref: "#/components/schemas/Appointment" },
                applied: { type: "boolean" },
              },
            },
            "Appointment completed.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The transition is not allowed from the current status.", "INVALID_STATUS_TRANSITION"),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/no-show": {
      post: {
        tags: ["Appointments"],
        summary: "Mark the appointment as a no-show",
        description:
          "CONFIRMED -> NO_SHOW, only at or after the scheduled end instant. Records " +
          "`noShowAt`; the optional reason is stored in the event metadata only.",
        operationId: "markAppointmentAsNoShow",
        "x-required-permission": "appointment:update",
        parameters: [
          idParameter("appointmentId", "Appointment id."),
          { $ref: "#/components/parameters/CsrfToken" },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AppointmentNoShowInput" },
              example: { reason: "Patient did not arrive" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "applied"],
              properties: {
                appointment: { $ref: "#/components/schemas/Appointment" },
                applied: { type: "boolean" },
              },
            },
            "Appointment marked as a no-show.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The appointment is before its scheduled end, or the transition is not allowed.",
            "NO_SHOW_TOO_EARLY",
          ),
          422: validation,
        },
      },
    },
    "/appointments/{appointmentId}/history": {
      get: {
        tags: ["Appointments"],
        summary: "Retrieve appointment lifecycle history",
        description:
          "Chronological, append-only lifecycle events for one appointment. A doctor " +
          "may only read their own appointments; cross-tenant ids are a 404.",
        operationId: "getAppointmentHistory",
        "x-required-permission": "appointment:read",
        parameters: [idParameter("appointmentId", "Appointment id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["appointment", "events"],
              properties: {
                appointment: { $ref: "#/components/schemas/Appointment" },
                events: {
                  type: "array",
                  items: { $ref: "#/components/schemas/AppointmentEvent" },
                },
              },
            },
            "Appointment lifecycle history.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/payments/initiate": {
      post: {
        tags: ["Payments"],
        summary: "Initiate an online payment",
        description:
          "Creates a provider checkout order for an issued invoice and records a " +
          "PENDING receipt linked to it. The amount, currency, patient and branch are " +
          "derived from the tenant-scoped invoice; the client cannot supply an amount, " +
          "status, provider order id or transaction reference. Only ISSUED, " +
          "PARTIALLY_PAID and OVERDUE invoices with a positive outstanding balance are " +
          "accepted. No settlement row is written, so the invoice balance is unchanged " +
          "until success is verified. A repeated `Idempotency-Key` replays the original " +
          "open order with `200`; reusing it for a different invoice, method or provider " +
          "is a `409`. Provider timeouts and rejections create no rows and return a " +
          "safe `502`/`504`.",
        operationId: "initiatePayment",
        "x-required-permission": "payment:create",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description:
              "Client retry key, unique per hospital. The body field " +
              "`idempotencyKey` is an alternative, and the two must match when both " +
              "are sent.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InitiatePaymentInput" },
              example: { invoiceId: "c96cac80-adbd-4d50-bdb7-fe40fc089649", method: "CARD" },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["initiation"],
              properties: {
                initiation: { $ref: "#/components/schemas/PaymentInitiation" },
              },
            },
            "Checkout order created; the linked receipt is PENDING.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["initiation"],
              properties: {
                initiation: { $ref: "#/components/schemas/PaymentInitiation" },
              },
            },
            "Idempotent replay of the original open checkout; no new order was created.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
          502: errorResponse(
            "The payment provider rejected the request or returned an unusable order.",
            "PAYMENT_GATEWAY_ERROR",
          ),
          504: errorResponse(
            "The payment provider did not respond within the configured timeout.",
            "PAYMENT_GATEWAY_TIMEOUT",
          ),
        },
      },
    },
    "/payments": {
      post: {
        tags: ["Payments"],
        summary: "Record a manual payment",
        description:
          "Records one receipt-level collection and settles the listed invoices in the " +
          "same transaction. At least one allocation is required; each must belong to " +
          "the paying patient and to the payment's branch, stay inside the invoice's " +
          "outstanding balance, and sum exactly to `amount`. Only issued, outstanding " +
          "invoices accept money: a `DRAFT` or `CANCELLED` invoice is refused with " +
          "`409`. The cashier is taken from the session and the receipt is stored " +
          "`SUCCESSFUL`. A repeated `Idempotency-Key` replays the original payment " +
          "with `200`.",
        operationId: "recordPayment",
        "x-required-permission": "payment:create",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description:
              "Client retry key, unique per hospital. The body field " +
              "`idempotencyKey` is an alternative, and the two must match when both " +
              "are sent.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RecordPaymentInput" },
              example: {
                branchId: "7b1c9d55-3f7e-4c2a-9d1b-5f8e2a6c4d10",
                patientId: "0f2b7c14-8a63-4f9d-9a51-2c7d1e8b6f31",
                method: "CASH",
                amount: "60.00",
                reference: "RCPT-2026-00041",
                allocations: [
                  {
                    invoiceId: "c96cac80-adbd-4d50-bdb7-fe40fc089649",
                    amount: "60.00",
                  },
                ],
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["payment", "invoiceBalances", "replayed"],
              properties: {
                payment: { $ref: "#/components/schemas/PaymentDetail" },
                invoiceBalances: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PaymentInvoiceBalance" },
                },
                replayed: { type: "boolean", enum: [false] },
              },
            },
            "Payment recorded.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["payment", "invoiceBalances", "replayed"],
              properties: {
                payment: { $ref: "#/components/schemas/PaymentDetail" },
                invoiceBalances: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PaymentInvoiceBalance" },
                },
                replayed: { type: "boolean", enum: [true] },
              },
            },
            "Idempotent replay of the original receipt; nothing new was written.",
          ),
          400: errorResponse(
            "A patient, branch or invoice does not belong to the caller's hospital, or an invoice is in another branch or belongs to another patient.",
            "BAD_REQUEST",
          ),
          401: unauthorized,
          403: forbidden,
          409: errorResponse(
            "An allocated invoice is a draft or has been cancelled, the reference is already used, or the idempotency key was used for a different request.",
            "CONFLICT",
          ),
          422: validation,
        },
      },
      get: {
        tags: ["Payments"],
        summary: "List payments",
        description:
          "Payment history for the caller's hospital, newest receipt first. Filters " +
          "are additive and every date bound is an inclusive UTC calendar date. Rows " +
          "omit free-text notes, allocations and every internal column.",
        operationId: "listPayments",
        "x-required-permission": "payment:read",
        parameters: [
          ...paginationParameters,
          {
            name: "patientId",
            in: "query",
            required: false,
            description: "Only receipts for one patient.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            description: "Only receipts collected at one branch.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "method",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"],
            },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"],
            },
          },
          {
            name: "reference",
            in: "query",
            required: false,
            description: "Exact receipt/UTR/cheque reference match.",
            schema: { type: "string", maxLength: 120 },
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            description: "Inclusive lower bound on the received date (YYYY-MM-DD, UTC).",
            schema: { type: "string", format: "date" },
          },
          {
            name: "toDate",
            in: "query",
            required: false,
            description:
              "Inclusive upper bound on the received date; must be on or after `fromDate`.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope(
            "payments",
            "#/components/schemas/PaymentSummary",
            "Payment history page.",
          ),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/payments/{paymentId}": {
      get: {
        tags: ["Payments"],
        summary: "Retrieve a payment",
        description:
          "One receipt with its allocation lines and the invoice numbers they settled. " +
          "A payment from another hospital is a `404`, never a `403`.",
        operationId: "getPayment",
        "x-required-permission": "payment:read",
        parameters: [idParameter("paymentId", "Payment id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["payment"],
              properties: { payment: { $ref: "#/components/schemas/PaymentDetail" } },
            },
            "Payment detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/payments/{paymentId}/allocations": {
      get: {
        tags: ["Payments"],
        summary: "List a payment's allocations",
        description:
          "Allocation lines of one receipt in creation order. Reads the same " +
          "tenant-scoped payment as the detail endpoint.",
        operationId: "listPaymentAllocations",
        "x-required-permission": "payment:read",
        parameters: [idParameter("paymentId", "Payment id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["allocations"],
              properties: {
                allocations: {
                  type: "array",
                  items: { $ref: "#/components/schemas/PaymentAllocation" },
                },
              },
            },
            "Allocation lines of the receipt.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/refunds": {
      post: {
        tags: ["Refunds"],
        summary: "Request a refund",
        description:
          "Opens a PENDING refund against one successful payment capture. The " +
          "invoice, branch, patient, currency and channel are derived from the " +
          "capture; a client-supplied `tenantId`, `invoiceId`, `status`, `provider`, " +
          "`providerRefundId` or `refundedAt` is rejected with `422`. Only a " +
          "SUCCESSFUL capture with a matching successful receipt can be reversed. " +
          "Cumulative refunds that are PENDING, APPROVED, PROCESSING or SUCCESSFUL " +
          "may never exceed the captured amount, so two open requests cannot " +
          "promise the same money twice. Requires an `Idempotency-Key`: a retry " +
          "replays the original request with `200`, while reusing the key for a " +
          "different request is a `409`.",
        operationId: "createRefundRequest",
        "x-required-permission": "payment:refund",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description:
              "Client retry key, unique per hospital. The body field " +
              "`idempotencyKey` is an alternative, and the two must match when both " +
              "are sent.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateRefundInput" },
              example: {
                invoicePaymentId: "5d0f3c4a-8a51-4a3e-9b4f-2e6f7c1d8a90",
                amount: "40.00",
                reason: "Treatment cancelled",
              },
            },
          },
        },
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["refund", "replayed"],
              properties: {
                refund: { $ref: "#/components/schemas/RefundDetail" },
                replayed: { type: "boolean", enum: [false] },
              },
            },
            "Refund request created; status is PENDING.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["refund", "replayed"],
              properties: {
                refund: { $ref: "#/components/schemas/RefundDetail" },
                replayed: { type: "boolean", enum: [true] },
              },
            },
            "Idempotent replay of the original request; nothing new was written.",
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The capture cannot be refunded in its current state, the reference is already used, or the idempotency key was used for a different request.",
            "CONFLICT",
          ),
          422: validation,
        },
      },
      get: {
        tags: ["Refunds"],
        summary: "List refunds",
        description:
          "Refund history for the caller's hospital, newest request first. Filters " +
          "are additive and every date bound is an inclusive UTC calendar date. Rows " +
          "omit the free-text reason, decision note and failure detail.",
        operationId: "listRefunds",
        "x-required-permission": "payment:read",
        parameters: [
          ...paginationParameters,
          {
            name: "invoiceId",
            in: "query",
            required: false,
            description: "Only refunds of one invoice.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "paymentId",
            in: "query",
            required: false,
            description: "Only refunds of one invoice_payments capture.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            description: "Only refunds of invoices issued at one branch.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "patientId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: [
                "PENDING",
                "APPROVED",
                "PROCESSING",
                "SUCCESSFUL",
                "FAILED",
                "REJECTED",
              ],
            },
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            description: "Inclusive lower bound on the request date (YYYY-MM-DD, UTC).",
            schema: { type: "string", format: "date" },
          },
          {
            name: "toDate",
            in: "query",
            required: false,
            description:
              "Inclusive upper bound on the request date; must be on or after `fromDate`.",
            schema: { type: "string", format: "date" },
          },
        ],
        responses: {
          200: listEnvelope("refunds", "#/components/schemas/RefundSummary", "Refund history page."),
          401: unauthorized,
          403: forbidden,
          422: validation,
        },
      },
    },
    "/refunds/{refundId}": {
      get: {
        tags: ["Refunds"],
        summary: "Retrieve a refund",
        description:
          "One refund with its invoice number, capture link and decision history. A " +
          "refund from another hospital is a `404`, never a `403`.",
        operationId: "getRefund",
        "x-required-permission": "payment:read",
        parameters: [idParameter("refundId", "Refund id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["refund"],
              properties: { refund: { $ref: "#/components/schemas/RefundDetail" } },
            },
            "Refund detail.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/refunds/{refundId}/approve": {
      post: {
        tags: ["Refunds"],
        summary: "Approve a refund request",
        description:
          "Moves a PENDING refund to APPROVED and re-checks the live capture and " +
          "cumulative limit. A caller cannot approve a refund they requested " +
          "themselves (`409`). Only PENDING refunds can be approved.",
        operationId: "approveRefund",
        "x-required-permission": "payment:refund",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("refundId", "Refund id."),
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RefundDecisionInput" },
              example: { reason: "Approved by finance" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["refund"],
              properties: { refund: { $ref: "#/components/schemas/RefundDetail" } },
            },
            "Refund approved.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The refund is not PENDING, the caller requested it, or the capture no longer covers it.",
            "CONFLICT",
          ),
          422: validation,
        },
      },
    },
    "/refunds/{refundId}/reject": {
      post: {
        tags: ["Refunds"],
        summary: "Reject a refund request",
        description:
          "Moves a PENDING refund to REJECTED. Rejection is terminal and no money " +
          "moves or invoice balance changes.",
        operationId: "rejectRefund",
        "x-required-permission": "payment:refund",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("refundId", "Refund id."),
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RefundDecisionInput" },
              example: { reason: "Duplicate request" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["refund"],
              properties: { refund: { $ref: "#/components/schemas/RefundDetail" } },
            },
            "Refund rejected.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("Only a PENDING refund can be rejected.", "CONFLICT"),
          422: validation,
        },
      },
    },
    "/refunds/{refundId}/process": {
      post: {
        tags: ["Refunds"],
        summary: "Process an approved refund",
        description:
          "Processes an APPROVED refund (or retries a FAILED one). An offline " +
          "capture is confirmed by the authorised actor; a gateway capture is sent " +
          "through the provider adapter. Only a verified adapter `SUCCESSFUL` result " +
          "marks the refund SUCCESSFUL and recalculates the invoice header through " +
          "the invoice lifecycle service. A provider decline stores FAILED and moves " +
          "no money; a timeout stays PROCESSING because the outcome is unverified. " +
          "Calling this again on a SUCCESSFUL refund returns the stored row and " +
          "cannot refund twice; a PROCESSING refund is a `409` until its outcome is " +
          "reconciled.",
        operationId: "processRefund",
        "x-required-permission": "payment:refund",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("refundId", "Refund id."),
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProcessRefundInput" },
              example: { reference: "VOID-2026-0007" },
            },
          },
        },
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["refund"],
              properties: { refund: { $ref: "#/components/schemas/RefundDetail" } },
            },
            "Refund processed; the returned status is the stored outcome.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The refund is not approved/failed, is already processing, or is no longer in a processable state.",
            "CONFLICT",
          ),
          422: validation,
        },
      },
    },
    "/billing-documents/invoices/{invoiceId}": {
      post: {
        tags: ["Billing Documents"],
        summary: "Generate or reuse an invoice PDF",
        description:
          "Renders the issued invoice from persisted records. Draft and cancelled " +
          "invoices are refused with `409`. The PDF is stored privately and the " +
          "response contains only metadata. Repeating the call reuses the latest " +
          "stored artifact (`200`); `regenerate=true` creates a new version linked " +
          "to the previous one without changing any financial row.",
        operationId: "generateInvoiceDocument",
        "x-required-permission": "payment:read",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("invoiceId", "Invoice id."),
          {
            name: "regenerate",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true", "false"], default: "false" },
          },
        ],
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [false] },
              },
            },
            "Invoice PDF generated.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [true] },
              },
            },
            "An existing valid PDF was reused; nothing new was generated.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse(
            "The invoice is a draft, cancelled, has no lines, or its totals do not reconcile.",
            "CONFLICT",
          ),
          422: validation,
          503: errorResponse("PDF rendering or private storage is temporarily unavailable.", "SERVICE_UNAVAILABLE"),
        },
      },
    },
    "/billing-documents/payments/{paymentId}/receipt": {
      post: {
        tags: ["Billing Documents"],
        summary: "Generate or reuse a payment receipt",
        description:
          "Renders a receipt for one `SUCCESSFUL` payment and its invoice " +
          "allocations. A non-successful payment is `409`; allocations must " +
          "reconcile with the receipt amount, branch, patient and currency. " +
          "Reuse and `regenerate=true` behave like invoice generation.",
        operationId: "generatePaymentReceipt",
        "x-required-permission": "payment:read",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("paymentId", "Payment id."),
          {
            name: "regenerate",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true", "false"], default: "false" },
          },
        ],
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [false] },
              },
            },
            "Receipt PDF generated.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [true] },
              },
            },
            "An existing valid receipt was reused.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
          503: errorResponse("PDF rendering or private storage is temporarily unavailable.", "SERVICE_UNAVAILABLE"),
        },
      },
    },
    "/billing-documents/refunds/{refundId}/credit-note": {
      post: {
        tags: ["Billing Documents"],
        summary: "Generate or reuse a refund credit note",
        description:
          "Renders a credit note for one `SUCCESSFUL` refund. Pending, rejected, " +
          "failed or processing refunds are refused with `409`, and the refund " +
          "currency must match the invoice. Regeneration never modifies refund or " +
          "invoice rows.",
        operationId: "generateCreditNote",
        "x-required-permission": "payment:read",
        parameters: [
          { $ref: "#/components/parameters/CsrfToken" },
          idParameter("refundId", "Refund id."),
          {
            name: "regenerate",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true", "false"], default: "false" },
          },
        ],
        responses: {
          201: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [false] },
              },
            },
            "Credit note PDF generated.",
          ),
          200: successEnvelope(
            {
              type: "object",
              required: ["document", "reused"],
              properties: {
                document: { $ref: "#/components/schemas/BillingDocument" },
                reused: { type: "boolean", enum: [true] },
              },
            },
            "An existing valid credit note was reused.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: conflict,
          422: validation,
          503: errorResponse("PDF rendering or private storage is temporarily unavailable.", "SERVICE_UNAVAILABLE"),
        },
      },
    },
    "/billing-documents/{documentId}": {
      get: {
        tags: ["Billing Documents"],
        summary: "Retrieve billing document metadata",
        description:
          "Metadata of one generated document in the caller's hospital. The " +
          "private storage key is never returned; use the file endpoint for bytes.",
        operationId: "getBillingDocument",
        "x-required-permission": "payment:read",
        parameters: [idParameter("documentId", "Billing document id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["document"],
              properties: { document: { $ref: "#/components/schemas/BillingDocument" } },
            },
            "Billing document metadata.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-documents/{documentId}/file": {
      get: {
        tags: ["Billing Documents"],
        summary: "Download a billing PDF",
        description:
          "Streams the stored PDF after re-checking tenant, membership, permission " +
          "and the document's invoice/branch link. The response is binary " +
          "`application/pdf` with `attachment` disposition and `no-store`; no " +
          "public or permanent URL exists. A missing object is a `404`.",
        operationId: "downloadBillingDocument",
        "x-required-permission": "payment:read",
        parameters: [idParameter("documentId", "Billing document id.")],
        responses: {
          200: {
            description: "The stored PDF bytes.",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errorResponse("The document does not match its invoice branch.", "CONFLICT"),
          422: validation,
          503: errorResponse("Private document storage is temporarily unavailable.", "SERVICE_UNAVAILABLE"),
        },
      },
    },
    "/billing-reports/revenue": {
      get: {
        tags: ["Billing Reports"],
        summary: "Revenue and collection summary",
        description:
          "Invoiced revenue, successful collections, successful refunds, net collections and " +
          "outstanding balances for a local date range, grouped by currency. Draft and " +
          "cancelled invoices are excluded; failed/pending payments and refunds are not " +
          "counted. Payment/refund instants use the branch or hospital timezone.",
        operationId: "getBillingRevenueReport",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["revenue"],
              properties: { revenue: { $ref: "#/components/schemas/BillingRevenueSummary" } },
            },
            "Revenue summary, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/revenue/trends": {
      get: {
        tags: ["Billing Reports"],
        summary: "Daily, weekly or monthly revenue trend",
        description:
          "Buckets invoiced, collected, refunded and net collections by day, ISO week or " +
          "month in the resolved timezone. The requested range may span at most 366 days.",
        operationId: "getBillingRevenueTrends",
        "x-required-permission": "reports:read",
        parameters: [
          ...reportRangeParameters,
          {
            name: "granularity",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["day", "week", "month"] },
          },
        ],
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["trends"],
              properties: { trends: { $ref: "#/components/schemas/BillingRevenueTrend" } },
            },
            "Revenue trend, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/outstanding": {
      get: {
        tags: ["Billing Reports"],
        summary: "Outstanding invoice balances",
        description:
          "Sums open balances as of a local date, grouped by currency. `fromDate` optionally " +
          "limits by issue date; draft and cancelled invoices are excluded.",
        operationId: "getBillingOutstandingReport",
        "x-required-permission": "reports:read",
        parameters: [
          {
            name: "asOf",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
            description: "Cutoff date; defaults to today in the resolved timezone.",
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          ...reportFilterParameters,
        ],
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["outstanding"],
              properties: {
                outstanding: { $ref: "#/components/schemas/BillingOutstandingSummary" },
              },
            },
            "Outstanding summary, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/outstanding/invoices": {
      get: {
        tags: ["Billing Reports"],
        summary: "Paginated outstanding invoice rows",
        description:
          "Record-level open invoices with branch name and money totals. Deliberately " +
          "contains no patient identity. `state` filters all open, pending (not yet due) or " +
          "overdue rows. `format=csv` exports up to 5,000 filtered rows and requires " +
          "`reports:export`.",
        operationId: "listBillingOutstandingInvoices",
        "x-required-permission": "reports:read",
        parameters: [
          {
            name: "asOf",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          {
            name: "fromDate",
            in: "query",
            required: false,
            schema: { type: "string", format: "date" },
          },
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["ALL", "PENDING", "OVERDUE"], default: "ALL" },
          },
          { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          ...reportFilterParameters,
        ],
        responses: {
          200: {
            description: "Paginated invoice rows, or a CSV projection when `format=csv`.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["invoices", "asOf", "state"],
                      properties: {
                        invoices: {
                          type: "array",
                          items: { $ref: "#/components/schemas/BillingOutstandingInvoice" },
                        },
                        asOf: { type: "string", format: "date" },
                        state: { type: "string", enum: ["ALL", "PENDING", "OVERDUE"] },
                      },
                    },
                    meta: {
                      type: "object",
                      properties: { pagination: paginationMeta },
                    },
                  },
                },
              },
              "text/csv": {
                schema: { type: "string" },
                description: "CSV export; requires `reports:export`.",
              },
            },
          },
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/pending-overdue": {
      get: {
        tags: ["Billing Reports"],
        summary: "Pending and overdue invoice balances",
        description:
          "Splits open balances at `toDate` into pending (not yet due) and overdue " +
          "(status OVERDUE or due date before `toDate`), with counts per currency.",
        operationId: "getBillingPendingOverdueReport",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              properties: { pendingOverdue: { type: "object", additionalProperties: true } },
            },
            "Pending/overdue summary, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/payment-summary": {
      get: {
        tags: ["Billing Reports"],
        summary: "Payment status summary",
        description:
          "Payment counts and amounts grouped by stored status and currency. Only " +
          "SUCCESSFUL rows contribute to collected revenue elsewhere; this report keeps " +
          "failed/pending rows visible for reconciliation.",
        operationId: "getBillingPaymentSummary",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["payments"],
              properties: {
                payments: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingStatusDistribution" },
                },
              },
            },
            "Payment status summary, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/refund-summary": {
      get: {
        tags: ["Billing Reports"],
        summary: "Refund status summary",
        description:
          "Refund counts and amounts grouped by stored status and currency. Only " +
          "SUCCESSFUL refunds reduce net collections; other states remain visible here.",
        operationId: "getBillingRefundSummary",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["refunds"],
              properties: {
                refunds: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingStatusDistribution" },
                },
              },
            },
            "Refund status summary, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/invoice-status": {
      get: {
        tags: ["Billing Reports"],
        summary: "Invoice status distribution",
        description: "Invoice counts and totals grouped by status and currency.",
        operationId: "getBillingInvoiceStatusReport",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["invoiceStatus"],
              properties: {
                invoiceStatus: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingStatusDistribution" },
                },
              },
            },
            "Invoice status distribution, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/branches": {
      get: {
        tags: ["Billing Reports"],
        summary: "Branch revenue breakdown",
        description: "Invoiced, collected, refunded, net and outstanding totals per branch and currency.",
        operationId: "getBillingBranchBreakdown",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["branches"],
              properties: {
                branches: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingBranchRevenue" },
                },
              },
            },
            "Branch breakdown, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/payment-methods": {
      get: {
        tags: ["Billing Reports"],
        summary: "Payment method breakdown",
        description:
          "Successful collection and attributed refund totals per payment method and currency.",
        operationId: "getBillingPaymentMethodBreakdown",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["paymentMethods"],
              properties: {
                paymentMethods: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingPaymentMethodRevenue" },
                },
              },
            },
            "Payment method breakdown, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/invoice-types": {
      get: {
        tags: ["Billing Reports"],
        summary: "Invoice type revenue breakdown",
        description:
          "Invoiced, allocated collections, refunds and outstanding totals per invoice type " +
          "and currency, without double counting a multi-invoice receipt.",
        operationId: "getBillingInvoiceTypeBreakdown",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["invoiceTypes"],
              properties: {
                invoiceTypes: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingInvoiceTypeRevenue" },
                },
              },
            },
            "Invoice type breakdown, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/doctors": {
      get: {
        tags: ["Billing Reports"],
        summary: "Doctor-wise billing breakdown",
        description:
          "Invoices attributed through their appointment to each doctor, with collected and " +
          "refund amounts. Invoices without an appointment are excluded.",
        operationId: "getBillingDoctorBreakdown",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["doctors"],
              properties: {
                doctors: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingDoctorRevenue" },
                },
              },
            },
            "Doctor breakdown, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/audit-logs": {
      get: {
        tags: ["Audit Logs"],
        summary: "List hospital audit logs",
        description:
          "Paginated, newest-first activity for the caller's hospital. All filters are " +
          "optional and combine with AND. The tenant comes from the verified session; " +
          "`tenantId` is rejected by the strict query schema.",
        operationId: "listAuditLogs",
        "x-required-permission": "audit:read",
        parameters: [
          ...paginationParameters,
          {
            name: "actorUserId",
            in: "query",
            required: false,
            description: "Only events performed by this user id.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            description: "Only branch-scoped events. Must belong to the caller's hospital.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "module",
            in: "query",
            required: false,
            description: "Exact module name, e.g. `patients`, `billing`, `auth`.",
            schema: { type: "string", maxLength: 60 },
          },
          {
            name: "action",
            in: "query",
            required: false,
            description: "Exact dotted action, e.g. `patient.created`.",
            schema: { type: "string", maxLength: 120 },
          },
          {
            name: "resourceType",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 100 },
          },
          {
            name: "resourceId",
            in: "query",
            required: false,
            description: "Exact resource identifier; combine with `resourceType` to narrow further.",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "from",
            in: "query",
            required: false,
            description: "Inclusive lower bound as an ISO 8601 instant with explicit offset.",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "to",
            in: "query",
            required: false,
            description: "Inclusive upper bound; must be on or after `from`.",
            schema: { type: "string", format: "date-time" },
          },
          {
            name: "sortOrder",
            in: "query",
            required: false,
            description: "Timestamp ordering; defaults to newest first.",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
        ],
        responses: {
          200: listEnvelope(
            "auditLogs",
            "#/components/schemas/AuditLogEntry",
            "A page of the caller's audit records.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/audit-logs/recent": {
      get: {
        tags: ["Audit Logs"],
        summary: "Recent hospital or branch activity",
        description:
          "Returns up to 100 newest audit entries without a count, for activity feeds. " +
          "Omit `branchId` for hospital-wide activity; a foreign branch is `404`.",
        operationId: "getRecentAuditActivity",
        "x-required-permission": "audit:read",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "branchId",
            in: "query",
            required: false,
            description: "Restrict activity to one branch of the caller's hospital.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["activity"],
              properties: {
                activity: {
                  type: "array",
                  items: { $ref: "#/components/schemas/AuditLogEntry" },
                },
              },
            },
            "Newest audit entries for the hospital or branch.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/audit-logs/{auditLogId}": {
      get: {
        tags: ["Audit Logs"],
        summary: "Get one audit log",
        description:
          "Returns a single record from the caller's hospital. Another tenant's id is " +
          "indistinguishable from a missing id (`404`).",
        operationId: "getAuditLog",
        "x-required-permission": "audit:read",
        parameters: [idParameter("auditLogId", "Audit log id.")],
        responses: {
          200: successEnvelope(
            {
              type: "object",
              required: ["auditLog"],
              properties: { auditLog: { $ref: "#/components/schemas/AuditLogEntry" } },
            },
            "The requested audit record.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/billing-reports/departments": {
      get: {
        tags: ["Billing Reports"],
        summary: "Department-wise billing breakdown",
        description:
          "Invoices attributed through their appointment's department, so a doctor in several " +
          "departments cannot cause the same invoice to count twice.",
        operationId: "getBillingDepartmentBreakdown",
        "x-required-permission": "reports:read",
        parameters: reportRangeParameters,
        responses: {
          200: reportSuccess(
            {
              type: "object",
              required: ["departments"],
              properties: {
                departments: {
                  type: "array",
                  items: { $ref: "#/components/schemas/BillingDepartmentRevenue" },
                },
              },
            },
            "Department breakdown, or a CSV projection when `format=csv`.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/dashboard/operational": {
      get: {
        tags: ["Dashboard"],
        summary: "Operational dashboard overview",
        description:
          "Appointment counts, patient totals and doctor capacity/workload for a local " +
          "date range. Requires `reports:read`. Sections are returned only when the " +
          "caller also holds `appointment:read`, `patient:read` or `doctor:read`; a " +
          "section without its permission is omitted rather than zeroed.",
        operationId: "getDashboardOperational",
        "x-required-permission": "reports:read",
        parameters: dashboardRangeParameters,
        responses: {
          200: dashboardEnvelope(
            "operational",
            "#/components/schemas/DashboardOperational",
            "Permissions-filtered operational overview.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/dashboard/appointments": {
      get: {
        tags: ["Dashboard"],
        summary: "Appointment summary",
        description:
          "Status counts (total, completed, cancelled, upcoming, no-shows) for " +
          "appointments starting in the range. Requires `reports:read` and " +
          "`appointment:read`.",
        operationId: "getDashboardAppointments",
        "x-required-permission": "reports:read",
        parameters: dashboardRangeParameters,
        responses: {
          200: dashboardEnvelope(
            "appointments",
            "#/components/schemas/DashboardAppointments",
            "Appointment summary for the selected range and branch.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/dashboard/patients": {
      get: {
        tags: ["Dashboard"],
        summary: "Patient summary",
        description:
          "Total non-deleted patient profiles and registrations created in the range. " +
          "Requires `reports:read` and `patient:read`. Patient totals are " +
          "hospital-wide; a branch filter does not narrow them.",
        operationId: "getDashboardPatients",
        "x-required-permission": "reports:read",
        parameters: dashboardRangeParameters,
        responses: {
          200: dashboardEnvelope(
            "patients",
            "#/components/schemas/DashboardPatients",
            "Patient summary for the selected range.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/dashboard/doctors": {
      get: {
        tags: ["Dashboard"],
        summary: "Doctor capacity and workload summary",
        description:
          "Active doctor count and one grouped workload row per doctor with " +
          "appointments in the range. Requires `reports:read` and `doctor:read`. " +
          "Only professional identity and counts are returned, never patient data.",
        operationId: "getDashboardDoctors",
        "x-required-permission": "reports:read",
        parameters: dashboardRangeParameters,
        responses: {
          200: dashboardEnvelope(
            "doctors",
            "#/components/schemas/DashboardDoctors",
            "Doctor capacity and workload summary.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
    "/dashboard/financial": {
      get: {
        tags: ["Dashboard"],
        summary: "Financial dashboard summary",
        description:
          "Revenue, collections, refunds, net collections and pending balances as " +
          "decimal strings grouped by currency, delegated to the Phase 19.9 billing " +
          "reports. Requires `reports:read` and `payment:read`.",
        operationId: "getDashboardFinancial",
        "x-required-permission": "reports:read",
        parameters: dashboardRangeParameters,
        responses: {
          200: dashboardEnvelope(
            "financial",
            "#/components/schemas/DashboardFinancial",
            "Financial summary for the selected range and branch.",
          ),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: validation,
        },
      },
    },
  },
};
