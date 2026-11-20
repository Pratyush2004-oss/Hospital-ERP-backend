import { Router } from "express";
import { authenticate } from "../../../middleware/authenticate.js";
import { requirePermission, requireTenant } from "../../../middleware/authorization.js";
import { validate } from "../../../middleware/validate.js";
import { csrfProtection } from "../../auth/auth.middleware.js";
import {
  downloadBillingDocumentHandler,
  generateCreditNoteHandler,
  generateInvoiceDocumentHandler,
  generatePaymentReceiptHandler,
  getBillingDocumentHandler,
} from "./billing-document.controller.js";
import {
  billingDocumentIdParamsSchema,
  creditNoteParamsSchema,
  generateBillingDocumentQuerySchema,
  invoiceDocumentParamsSchema,
  paymentReceiptParamsSchema,
} from "./billing-document.schemas.js";

/**
 * Billing document API (Phase 19.8.2).
 *
 *   POST /billing-documents/invoices/:invoiceId          generate/reuse invoice PDF
 *   POST /billing-documents/payments/:paymentId/receipt  generate/reuse receipt PDF
 *   POST /billing-documents/refunds/:refundId/credit-note generate/reuse credit note
 *   GET  /billing-documents/:documentId                  metadata
 *   GET  /billing-documents/:documentId/file             authenticated PDF stream
 *
 * Every route requires authentication, hospital (tenant) context and the
 * `payment:read` key already seeded for billing roles. The tenant and actor come
 * from the verified session; no route accepts a `tenantId`, storage key, file
 * name, amount or document number. Generation is a POST because it creates an
 * artifact and requires CSRF protection; reads are GET.
 *
 * There is intentionally no public/static route and no permanent URL: private
 * PDFs are returned by an authenticated stream from the storage abstraction.
 */
export const billingDocumentRouter: Router = Router();

billingDocumentRouter.post(
  "/invoices/:invoiceId",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:read"),
  validate({
    params: invoiceDocumentParamsSchema,
    query: generateBillingDocumentQuerySchema,
  }),
  generateInvoiceDocumentHandler,
);

billingDocumentRouter.post(
  "/payments/:paymentId/receipt",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:read"),
  validate({
    params: paymentReceiptParamsSchema,
    query: generateBillingDocumentQuerySchema,
  }),
  generatePaymentReceiptHandler,
);

billingDocumentRouter.post(
  "/refunds/:refundId/credit-note",
  authenticate,
  csrfProtection,
  requireTenant,
  requirePermission("payment:read"),
  validate({
    params: creditNoteParamsSchema,
    query: generateBillingDocumentQuerySchema,
  }),
  generateCreditNoteHandler,
);

billingDocumentRouter.get(
  "/:documentId/file",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ params: billingDocumentIdParamsSchema }),
  downloadBillingDocumentHandler,
);

billingDocumentRouter.get(
  "/:documentId",
  authenticate,
  requireTenant,
  requirePermission("payment:read"),
  validate({ params: billingDocumentIdParamsSchema }),
  getBillingDocumentHandler,
);
