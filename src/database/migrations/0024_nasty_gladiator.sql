ALTER TYPE "public"."invoice_refund_status" ADD VALUE 'APPROVED' BEFORE 'SUCCESSFUL';--> statement-breakpoint
ALTER TYPE "public"."invoice_refund_status" ADD VALUE 'PROCESSING' BEFORE 'SUCCESSFUL';--> statement-breakpoint
ALTER TYPE "public"."invoice_refund_status" ADD VALUE 'REJECTED';--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "reference" varchar(120);--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "provider" varchar(40);--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "provider_refund_id" varchar(120);--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "idempotency_key" varchar(200);--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "request_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_refunds_payment_idx" ON "invoice_refunds" USING btree ("tenant_id","payment_id","refund_status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_refunds_tenant_idempotency_key_unique" ON "invoice_refunds" USING btree ("tenant_id","idempotency_key") WHERE "invoice_refunds"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_refunds_tenant_reference_unique" ON "invoice_refunds" USING btree ("tenant_id","reference") WHERE "invoice_refunds"."reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_refunds_provider_refund_unique" ON "invoice_refunds" USING btree ("tenant_id","provider","provider_refund_id") WHERE "invoice_refunds"."provider_refund_id" is not null;
--> statement-breakpoint
COMMENT ON TABLE "invoice_refunds" IS
  'Refund requests and transactions per invoice. Only SUCCESSFUL rows reduce amount_paid; PENDING/APPROVED/PROCESSING/FAILED/REJECTED move no money.';--> statement-breakpoint
COMMENT ON COLUMN "invoice_refunds"."idempotency_key" IS
  'Client retry key, unique per tenant; a retried request replays the original refund.';--> statement-breakpoint
COMMENT ON COLUMN "invoice_refunds"."request_hash" IS
  'SHA-256 of the canonical refund request; a reused key with a different request is rejected.';--> statement-breakpoint
COMMENT ON COLUMN "invoice_refunds"."provider_refund_id" IS
  'Provider-side refund id; unique per tenant and provider when present.';