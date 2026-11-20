import type { Request, RequestHandler, Response } from "express";
import { sendCreated, sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import { getDoctorAvailability } from "./appointment-availability.service.js";
import type {
  AppointmentActorContext,
  AppointmentBookingDto,
} from "./appointment-booking.types.js";
import { createAppointmentBooking } from "./appointment-booking.service.js";
import { cancelAppointment } from "./appointment-cancel.service.js";
import {
  checkInAppointment,
  completeAppointment,
  getAppointmentLifecycleHistory,
  markAppointmentAsNoShow,
  startAppointment,
} from "./appointment-lifecycle.service.js";
import {
  getAppointmentByCode,
  getAppointmentById,
  listAppointments,
} from "./appointment-query.service.js";
import { rescheduleAppointment } from "./appointment-reschedule.service.js";
import {
  availabilityQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  doctorAvailabilityParamsSchema,
  doctorAvailabilityQuerySchema,
  listAppointmentsQuerySchema,
  noShowSchema,
  rescheduleAppointmentSchema,
  appointmentCodeParamsSchema,
  appointmentIdParamsSchema,
} from "./appointment.schemas.js";

/**
 * HTTP-only layer for the appointment API (Phase 18.6).
 *
 * Handlers validate the caller's scope, translate a validated request into one
 * service call and wrap the result in the standard envelope. They never
 * implement availability, fees, transitions, idempotency or tenant ownership
 * rules: those live in the Phase 18.2-18.5 services, which re-read the trusted
 * actor and tenant context themselves.
 */

/** Verified hospital caller; tenant and user ids never come from the request. */
function appointmentActor(): AppointmentActorContext {
  const actor = requireTenantScope();

  return {
    userId: actor.userId,
    permissions: actor.permissions,
    roles: actor.roles,
  };
}

/**
 * Resolves the idempotency key from the `Idempotency-Key` header or the body
 * field, rejecting a mismatch. Creating an appointment requires one so a retry
 * can never double book; other commands accept one when the client supplies it.
 */
function idempotencyKeyOf(req: Request, bodyValue?: string): string | undefined {
  const header = req.get("idempotency-key")?.trim();
  const fromHeader = header !== undefined && header.length > 0 ? header : undefined;

  if (fromHeader !== undefined && bodyValue !== undefined && bodyValue !== fromHeader) {
    throw AppError.validation(
      "The Idempotency-Key header and idempotencyKey field must match",
      [{ source: "headers", path: "Idempotency-Key", message: "Values do not match", code: "custom" }],
    );
  }

  return fromHeader ?? bodyValue;
}

function requiredIdempotencyKey(req: Request, bodyValue?: string): string {
  const key = idempotencyKeyOf(req, bodyValue);

  if (key === undefined) {
    throw AppError.validation("An Idempotency-Key header is required", [
      {
        source: "headers",
        path: "Idempotency-Key",
        message: "An idempotency key between 1 and 200 characters is required",
        code: "custom",
      },
    ]);
  }

  return key;
}

/* -------------------------------------------------------------------------
 * Availability (Phase 18.2) - read-only, never reserves a slot.
 * ---------------------------------------------------------------------- */

export const getAvailabilityHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof availabilityQuerySchema>(req, "query");
  const availability = await getDoctorAvailability(actor.tenantId, {
    doctorId: query.doctorId,
    branchId: query.branchId,
    date: query.date,
    fromDate: query.fromDate,
    toDate: query.toDate,
    durationMinutes: query.durationMinutes,
  });

  sendSuccess(res, { availability });
};

export const getDoctorAvailabilityHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof doctorAvailabilityParamsSchema>(req, "params");
  const query = getValidated<typeof doctorAvailabilityQuerySchema>(req, "query");
  const availability = await getDoctorAvailability(actor.tenantId, {
    doctorId: params.doctorId,
    branchId: query.branchId,
    date: query.date,
    fromDate: query.fromDate,
    toDate: query.toDate,
    durationMinutes: query.durationMinutes,
  });

  sendSuccess(res, { availability });
};

/* -------------------------------------------------------------------------
 * Booking (Phase 18.3) and reads.
 * ---------------------------------------------------------------------- */

export const createAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const input = getValidated<typeof createAppointmentSchema>(req, "body");
  const appointment = await createAppointmentBooking(
    actor.tenantId,
    {
      patientId: input.patientId,
      doctorId: input.doctorId,
      branchId: input.branchId,
      departmentId: input.departmentId,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      appointmentSource: input.appointmentSource,
      appointmentType: input.appointmentType,
      reason: input.reason,
      notes: input.notes,
      idempotencyKey: requiredIdempotencyKey(req, input.idempotencyKey),
    },
    appointmentActor(),
  );

  if (appointment.replayed) {
    sendSuccess(res, { appointment });
    return;
  }

  sendCreated(res, { appointment });
};

export const listAppointmentsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listAppointmentsQuerySchema>(req, "query");
  const result = await listAppointments(
    actor.tenantId,
    {
      page: query.page,
      pageSize: query.limit,
      search: query.search,
      patientId: query.patientId,
      doctorId: query.doctorId,
      branchId: query.branchId,
      departmentId: query.departmentId,
      status: query.status,
      source: query.source,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    appointmentActor(),
  );

  sendSuccess(res, { appointments: result.appointments }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const appointment = await getAppointmentById(
    actor.tenantId,
    params.appointmentId,
    appointmentActor(),
  );

  sendSuccess(res, { appointment });
};

export const getAppointmentByCodeHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentCodeParamsSchema>(req, "params");
  const appointment = await getAppointmentByCode(
    actor.tenantId,
    params.appointmentCode,
    appointmentActor(),
  );

  sendSuccess(res, { appointment });
};

/* -------------------------------------------------------------------------
 * Rescheduling and cancellation (Phase 18.4).
 * ---------------------------------------------------------------------- */

export const rescheduleAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const input = getValidated<typeof rescheduleAppointmentSchema>(req, "body");
  const result = await rescheduleAppointment(
    actor.tenantId,
    {
      appointmentId: params.appointmentId,
      doctorId: input.doctorId,
      branchId: input.branchId,
      departmentId: input.departmentId,
      startAt: input.startAt,
      endAt: input.endAt,
      durationMinutes: input.durationMinutes,
      reason: input.reason,
      idempotencyKey: idempotencyKeyOf(req, input.idempotencyKey),
    },
    appointmentActor(),
  );

  sendSuccess(res, {
    appointment: result.replacement,
    original: result.original,
  });
};

export const cancelAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const input = getValidated<typeof cancelAppointmentSchema>(req, "body");
  const result = await cancelAppointment(
    actor.tenantId,
    {
      appointmentId: params.appointmentId,
      cancellationReason: input.cancellationReason,
      idempotencyKey: idempotencyKeyOf(req, input.idempotencyKey),
    },
    appointmentActor(),
  );

  sendSuccess(res, { appointment: result.appointment, replayed: result.replayed });
};

/* -------------------------------------------------------------------------
 * Lifecycle (Phase 18.5). Status is only ever changed through these actions.
 * ---------------------------------------------------------------------- */

function lifecycleResult(
  res: Response,
  result: { appointment: AppointmentBookingDto; applied: boolean },
): void {
  sendSuccess(res, { appointment: result.appointment, applied: result.applied });
}

export const checkInAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const result = await checkInAppointment(
    actor.tenantId,
    { appointmentId: params.appointmentId },
    appointmentActor(),
  );

  lifecycleResult(res, result);
};

export const startAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const result = await startAppointment(
    actor.tenantId,
    { appointmentId: params.appointmentId },
    appointmentActor(),
  );

  lifecycleResult(res, result);
};

export const completeAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const result = await completeAppointment(
    actor.tenantId,
    { appointmentId: params.appointmentId },
    appointmentActor(),
  );

  lifecycleResult(res, result);
};

export const noShowAppointmentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const body = getValidated<typeof noShowSchema>(req, "body");
  const result = await markAppointmentAsNoShow(
    actor.tenantId,
    { appointmentId: params.appointmentId, reason: body.reason },
    appointmentActor(),
  );

  lifecycleResult(res, result);
};

export const getAppointmentHistoryHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof appointmentIdParamsSchema>(req, "params");
  const history = await getAppointmentLifecycleHistory(
    actor.tenantId,
    params.appointmentId,
    appointmentActor(),
  );

  sendSuccess(res, { appointment: history.appointment, events: history.events });
};
