import type { Request, RequestHandler } from "express";
import { sendSuccess } from "../../../lib/api-response.js";
import { requireTenantScope } from "../../../lib/request-context.js";
import { getValidated } from "../../../middleware/validate.js";
import {
  generateCreditNoteDocument,
  generateInvoiceDocument,
  generatePaymentReceiptDocument,
  getBillingDocumentById,
  readBillingDocumentFile,
} from "./billing-document.service.js";
import {
  billingDocumentIdParamsSchema,
  creditNoteParamsSchema,
  generateBillingDocumentQuerySchema,
  invoiceDocumentParamsSchema,
  paymentReceiptParamsSchema,
} from "./billing-document.schemas.js";
import type { BillingDocumentActor } from "./billing-document.types.js";

/**
 * HTTP layer for billing documents (Phase 19.8.2).
 *
 * Controllers never render PDFs, read records, choose storage keys or decide
 * document status: they pass the verified tenant/actor and validated ids to the
 * Phase 19.8.1 service. The tenant always comes from the session, so a caller
 * cannot address another hospital's invoice, payment, refund or document.
 *
 * Responses:
 * - generation returns the metadata DTO (`201` new, `200` reused);
 * - detail returns the same DTO;
 * - the file endpoint streams the stored bytes directly and is never a public
 *   URL; it is authenticated, tenant-scoped and `no-store`.
 */

function billingDocumentActor(): BillingDocumentActor {
  const actor = requireTenantScope();

  return { userId: actor.userId, permissions: actor.permissions };
}

function wantsRegeneration(req: Request): boolean {
  const query = getValidated<typeof generateBillingDocumentQuerySchema>(req, "query");
  return query.regenerate === "true";
}

export const generateInvoiceDocumentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof invoiceDocumentParamsSchema>(req, "params");
  const result = await generateInvoiceDocument(
    actor.tenantId,
    params.invoiceId,
    billingDocumentActor(),
    { regenerate: wantsRegeneration(req) },
  );

  if (result.reused) {
    sendSuccess(res, { document: result.document, reused: true });
    return;
  }

  sendSuccess(res, { document: result.document, reused: false }, 201);
};

export const generatePaymentReceiptHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof paymentReceiptParamsSchema>(req, "params");
  const result = await generatePaymentReceiptDocument(
    actor.tenantId,
    params.paymentId,
    billingDocumentActor(),
    { regenerate: wantsRegeneration(req) },
  );

  if (result.reused) {
    sendSuccess(res, { document: result.document, reused: true });
    return;
  }

  sendSuccess(res, { document: result.document, reused: false }, 201);
};

export const generateCreditNoteHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof creditNoteParamsSchema>(req, "params");
  const result = await generateCreditNoteDocument(
    actor.tenantId,
    params.refundId,
    billingDocumentActor(),
    { regenerate: wantsRegeneration(req) },
  );

  if (result.reused) {
    sendSuccess(res, { document: result.document, reused: true });
    return;
  }

  sendSuccess(res, { document: result.document, reused: false }, 201);
};

export const getBillingDocumentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof billingDocumentIdParamsSchema>(req, "params");
  const document = await getBillingDocumentById(
    actor.tenantId,
    params.documentId,
    billingDocumentActor(),
  );

  sendSuccess(res, { document });
};

/**
 * Authenticated streaming of a private billing PDF.
 *
 * The response is binary and deliberately not wrapped in the JSON envelope.
 * `Content-Disposition` uses the server-generated, sanitised file name only, and
 * `no-store` prevents a shared cache from retaining patient billing data.
 */
export const downloadBillingDocumentHandler: RequestHandler = async (req, res) => {
  const actor = requireTenantScope();
  const params = getValidated<typeof billingDocumentIdParamsSchema>(req, "params");
  const file = await readBillingDocumentFile(
    actor.tenantId,
    params.documentId,
    billingDocumentActor(),
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.document.fileName}"`,
  );
  res.setHeader("Content-Length", String(file.bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.status(200).end(file.bytes);
};
