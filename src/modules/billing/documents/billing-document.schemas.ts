import { z } from "zod";

/**
 * Request validation for the billing document API (Phase 19.8.2).
 *
 * Schemas validate only identifiers and the explicit regeneration flag. No
 * amount, currency, line item, patient, branch, file name, storage key or
 * document number is accepted: all of them are read from the persisted
 * financial record inside the generation service.
 */

export const invoiceDocumentParamsSchema = z.object({
  invoiceId: z.uuid("Invoice id must be a UUID"),
});

export const paymentReceiptParamsSchema = z.object({
  paymentId: z.uuid("Payment id must be a UUID"),
});

export const creditNoteParamsSchema = z.object({
  refundId: z.uuid("Refund id must be a UUID"),
});

export const billingDocumentIdParamsSchema = z.object({
  documentId: z.uuid("Billing document id must be a UUID"),
});

/**
 * Regeneration is opt-in. Without it the service reuses the latest stored
 * artifact when its object still exists; `regenerate=true` creates a new
 * version linked to the previous one without touching financial records.
 */
export const generateBillingDocumentQuerySchema = z.object({
  regenerate: z.enum(["true", "false"], "regenerate must be true or false").optional(),
});

export type InvoiceDocumentParams = z.infer<typeof invoiceDocumentParamsSchema>;
export type PaymentReceiptParams = z.infer<typeof paymentReceiptParamsSchema>;
export type CreditNoteParams = z.infer<typeof creditNoteParamsSchema>;
export type BillingDocumentIdParams = z.infer<typeof billingDocumentIdParamsSchema>;
export type GenerateBillingDocumentQuery = z.infer<
  typeof generateBillingDocumentQuerySchema
>;
