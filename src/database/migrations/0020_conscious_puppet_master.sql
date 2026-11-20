ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenant_invoice_id_unique" UNIQUE("tenant_id","invoice_id","id");--> statement-breakpoint
ALTER TABLE "invoice_refunds" DROP CONSTRAINT "invoice_refunds_payment_fk";--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_payment_fk" FOREIGN KEY ("tenant_id","invoice_id","payment_id") REFERENCES "public"."invoice_payments"("tenant_id","invoice_id","id") ON DELETE restrict ON UPDATE no action;
