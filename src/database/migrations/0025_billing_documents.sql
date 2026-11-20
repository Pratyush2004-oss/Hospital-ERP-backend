CREATE TYPE "public"."billing_document_type" AS ENUM('INVOICE', 'PAYMENT_RECEIPT', 'CREDIT_NOTE');--> statement-breakpoint
CREATE TABLE "billing_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"document_type" "billing_document_type" NOT NULL,
	"document_number" varchar(60) NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"file_name" varchar(255) NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"mime_type" varchar(150) DEFAULT 'application/pdf' NOT NULL,
	"file_size" bigint NOT NULL,
	"generated_by" uuid,
	"regenerated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_documents_file_size_check" CHECK ("billing_documents"."file_size" > 0),
	CONSTRAINT "billing_documents_source_check" CHECK (("billing_documents"."document_type" = 'INVOICE' and "billing_documents"."payment_id" is null and "billing_documents"."refund_id" is null)
        or ("billing_documents"."document_type" = 'PAYMENT_RECEIPT' and "billing_documents"."payment_id" is not null and "billing_documents"."refund_id" is null)
        or ("billing_documents"."document_type" = 'CREDIT_NOTE' and "billing_documents"."refund_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_regenerated_from_id_billing_documents_id_fk" FOREIGN KEY ("regenerated_from_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_refund_fk" FOREIGN KEY ("tenant_id","refund_id") REFERENCES "public"."invoice_refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_documents_storage_key_unique" ON "billing_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "billing_documents_tenant_number_idx" ON "billing_documents" USING btree ("tenant_id","document_type","document_number");--> statement-breakpoint
CREATE INDEX "billing_documents_invoice_idx" ON "billing_documents" USING btree ("tenant_id","invoice_id","document_type","created_at");--> statement-breakpoint
CREATE INDEX "billing_documents_payment_idx" ON "billing_documents" USING btree ("tenant_id","payment_id") WHERE "billing_documents"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "billing_documents_refund_idx" ON "billing_documents" USING btree ("tenant_id","refund_id") WHERE "billing_documents"."refund_id" is not null;--> statement-breakpoint
CREATE INDEX "billing_documents_regenerated_from_idx" ON "billing_documents" USING btree ("regenerated_from_id") WHERE "billing_documents"."regenerated_from_id" is not null;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Row Level Security for generated billing documents (Phase 19.8.1). Same
-- `tenant_isolation` policy as every other billing table: a document can only
-- be reached inside a tenant-scoped transaction, and FORCE applies it to the
-- table owner too.
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_documents"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON TABLE "billing_documents" IS
  'Metadata for generated billing PDFs. Bytes live in private object storage; regenerating inserts a new version linked through regenerated_from_id. Financial records are never modified by generation.';
