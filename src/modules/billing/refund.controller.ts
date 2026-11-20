import type { Request, RequestHandler } from "express";
import { sendCreated, sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import type { RefundActorContext } from "./refund.types.js";
import {
  approveRefund,
  createRefundRequest,
  getRefundById,
  listRefunds,
  processRefund,
  rejectRefund,
} from "./refund.service.js";
import {
  createRefundRequestSchema,
  listRefundsQuerySchema,
  processRefundSchema,
  refundDecisionSchema,
  refundIdParamsSchema,
} from "./refund.schemas.js";

/**
 * HTTP-only layer for the refund API (Phase 19.7.2).
 *
 * Handlers read the caller's verified scope, translate a validated request into
 * one Phase 19.7.1 service call and wrap the result in the standard envelope.
 * They never insert refund rows, check captured amounts, derive the invoice
 * header, call a gateway or decide tenant ownership: `refund.service.ts`
 * re-reads the tenant and actor itself, so a handler bug cannot widen the
 * financial boundary or mark a refund successful from client input.
 *
 * Response rules:
 * - no response contains `tenantId`, `requestHash`, gateway request data or any
 *   column the service did not put on its DTO;
 * - a replayed create is a `200` with the original refund, a new one is `201`;
 * - approve/reject/process return the refreshed refund so a client can see the
 *   server-decided status instead of assuming one.
 */

/** Verified hospital caller; only the user id is financial context. */
function refundActor(): RefundActorContext {
  const actor = requireTenantScope();

  return { userId: actor.userId };
}

function idempotencyKeyOf(req: Request, bodyValue?: string): string | undefined {
  const header = req.get("idempotency-key")?.trim();
  const fromHeader = header !== undefined && header.length > 0 ? header : undefined;

  if (fromHeader !== undefined && bodyValue !== undefined && bodyValue !== fromHeader) {
    throw AppError.validation(
      "The Idempotency-Key header and idempotencyKey field must match",
      [
        {
          source: "headers",
          path: "Idempotency-Key",
          message: "Values do not match",
          code: "custom",
        },
      ],
    );
  }

  return fromHeader ?? bodyValue;
}

/**
 * Requesting money back always requires an idempotency key, on the header or in
 * the body: a client retry must replay the original request instead of opening a
 * second refund that reserves the captured amount twice.
 */
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

export const createRefundHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const body = getValidated<typeof createRefundRequestSchema>(req, "body");
  const result = await createRefundRequest(
    actor.tenantId,
    {
      invoicePaymentId: body.invoicePaymentId,
      amount: body.amount,
      reason: body.reason,
      reference: body.reference,
      idempotencyKey: requiredIdempotencyKey(req, body.idempotencyKey),
    },
    refundActor(),
  );

  if (result.replayed) {
    sendSuccess(res, { refund: result.refund, replayed: true });
    return;
  }

  sendCreated(res, { refund: result.refund, replayed: false });
};

export const getRefundHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof refundIdParamsSchema>(req, "params");
  const refund = await getRefundById(actor.tenantId, params.refundId);

  sendSuccess(res, { refund });
};

export const listRefundsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listRefundsQuerySchema>(req, "query");
  const result = await listRefunds(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    invoiceId: query.invoiceId,
    paymentId: query.paymentId,
    branchId: query.branchId,
    patientId: query.patientId,
    status: query.status,
    fromDate: query.fromDate,
    toDate: query.toDate,
  });

  sendSuccess(res, { refunds: result.refunds }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const approveRefundHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof refundIdParamsSchema>(req, "params");
  const body = getValidated<typeof refundDecisionSchema>(req, "body");
  const refund = await approveRefund(
    actor.tenantId,
    params.refundId,
    { reason: body.reason },
    refundActor(),
  );

  sendSuccess(res, { refund });
};

export const rejectRefundHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof refundIdParamsSchema>(req, "params");
  const body = getValidated<typeof refundDecisionSchema>(req, "body");
  const refund = await rejectRefund(
    actor.tenantId,
    params.refundId,
    { reason: body.reason },
    refundActor(),
  );

  sendSuccess(res, { refund });
};

/**
 * Processes an approved refund. For a gateway capture the provider adapter
 * decides the outcome; for an offline capture the authorised desk actor
 * confirms it. The response status is always the stored row, never the request.
 */
export const processRefundHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof refundIdParamsSchema>(req, "params");
  const body = getValidated<typeof processRefundSchema>(req, "body");
  const refund = await processRefund(
    actor.tenantId,
    params.refundId,
    { reference: body.reference },
    refundActor(),
  );

  sendSuccess(res, { refund });
};
