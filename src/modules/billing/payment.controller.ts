import type { Request, RequestHandler } from "express";
import { sendCreated, sendSuccess } from "../../lib/api-response.js";
import { AppError } from "../../lib/http-error.js";
import { requireTenantScope } from "../../lib/request-context.js";
import { getValidated } from "../../middleware/validate.js";
import type { PaymentActorContext } from "./payment.types.js";
import {
  getPaymentById,
  listPayments,
  recordPayment,
} from "./payment.service.js";
import { initiatePayment } from "./payment-initiation.service.js";
import {
  initiatePaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamsSchema,
  recordPaymentSchema,
} from "./payment.schemas.js";

/**
 * HTTP-only layer for the payment API (Phase 19.5.1).
 *
 * Handlers read the caller's verified scope, translate a validated request into
 * one Phase 19.4 service call and wrap the result in the standard envelope. They
 * never allocate money, check balances, compute replay hashes or decide tenant
 * ownership: `payment.service.ts` re-reads the tenant and actor itself, so a
 * handler bug cannot widen the financial boundary.
 *
 * Response shape:
 * - list rows are the service summaries (no `notes`, no internal columns);
 * - detail adds the allocation lines, which are the payment's public ledger;
 * - no route ever returns `requestHash`, `tenantId` or any column the service
 *   did not put on its DTO.
 */

/** Verified hospital caller; only the user id is financial context. */
function paymentActor(): PaymentActorContext {
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
 * Recording money always requires an idempotency key, on the header or in the
 * body: a client retry must replay the original receipt instead of collecting
 * twice, and the service can only guarantee that when it has a key.
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

export const recordPaymentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const body = getValidated<typeof recordPaymentSchema>(req, "body");
  const result = await recordPayment(
    actor.tenantId,
    {
      branchId: body.branchId,
      patientId: body.patientId,
      method: body.method,
      amount: body.amount,
      currency: body.currency,
      reference: body.reference,
      notes: body.notes,
      receivedAt: body.receivedAt,
      idempotencyKey: requiredIdempotencyKey(req, body.idempotencyKey),
      allocations: body.allocations,
    },
    paymentActor(),
  );

  // A replayed retry did not create anything, so it is a 200 with the original
  // receipt rather than a second 201.
  if (result.replayed) {
    sendSuccess(res, {
      payment: result.payment,
      invoiceBalances: result.invoiceBalances,
      replayed: true,
    });
    return;
  }

  sendCreated(res, {
    payment: result.payment,
    invoiceBalances: result.invoiceBalances,
    replayed: false,
  });
};

/**
 * Starts a provider checkout. The response contains only what the client needs
 * to open the hosted page; provider metadata, request hashes and tenant ids are
 * never returned. A replay is a 200 with the original order, mirroring manual
 * recording.
 */
export const initiatePaymentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const body = getValidated<typeof initiatePaymentSchema>(req, "body");
  const result = await initiatePayment(
    actor.tenantId,
    {
      invoiceId: body.invoiceId,
      method: body.method,
      provider: body.provider,
      idempotencyKey: requiredIdempotencyKey(req, body.idempotencyKey),
    },
    paymentActor(),
  );

  if (result.replayed) {
    sendSuccess(res, { initiation: result });
    return;
  }

  sendCreated(res, { initiation: result });
};

export const listPaymentsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const query = getValidated<typeof listPaymentsQuerySchema>(req, "query");
  const result = await listPayments(actor.tenantId, {
    page: query.page,
    pageSize: query.limit,
    patientId: query.patientId,
    branchId: query.branchId,
    method: query.method,
    status: query.status,
    reference: query.reference,
    fromDate: query.fromDate,
    toDate: query.toDate,
  });

  sendSuccess(res, { payments: result.payments }, 200, {
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
};

export const getPaymentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof paymentIdParamsSchema>(req, "params");
  const payment = await getPaymentById(actor.tenantId, params.paymentId);

  sendSuccess(res, { payment });
};

/**
 * Allocation lines of one receipt. This is a projection of the detail read, not
 * a second query: the service already joins each allocation to its invoice and
 * the tenant boundary is the same one `GET /payments/:paymentId` uses.
 */
export const listPaymentAllocationsHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof paymentIdParamsSchema>(req, "params");
  const payment = await getPaymentById(actor.tenantId, params.paymentId);

  sendSuccess(res, { allocations: payment.allocations });
};
