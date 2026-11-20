ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_payment_fk";
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_tenant_payment_invoice_unique" ON "invoice_payments" USING btree ("tenant_id","payment_id","invoice_id") WHERE "invoice_payments"."payment_id" is not null;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_manual_payment_status_check" CHECK ("invoice_payments"."payment_id" is null or "invoice_payments"."payment_status" = 'SUCCESSFUL');