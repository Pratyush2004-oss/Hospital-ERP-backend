CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"payment_status" "invoice_payment_status" DEFAULT 'SUCCESSFUL' NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(200),
	"request_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_payment_invoice_unique" UNIQUE("tenant_id","payment_id","invoice_id"),
	CONSTRAINT "payment_allocations_amount_check" CHECK ("payment_allocations"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_idempotency_key_unique" ON "payments" USING btree ("tenant_id","idempotency_key") WHERE "payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_reference_unique" ON "payments" USING btree ("tenant_id","reference") WHERE "payments"."reference" is not null;--> statement-breakpoint
CREATE INDEX "payments_patient_history_idx" ON "payments" USING btree ("tenant_id","patient_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_branch_history_idx" ON "payments" USING btree ("tenant_id","branch_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("tenant_id","payment_status","received_at");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("tenant_id","payment_id");
-- ---------------------------------------------------------------------------
-- Row Level Security for the payment tables (Task 19.4.1).
-- Same `tenant_isolation` policy as the rest of billing; a payment or its
-- allocations are only reachable through a tenant-scoped transaction.
-- ---------------------------------------------------------------------------
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_allocations"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON TABLE "payments" IS
  'Offline/manual collections. amount equals the sum of payment_allocations; idempotency_key is unique per tenant. Financial history is never hard deleted.';--> statement-breakpoint
COMMENT ON TABLE "payment_allocations" IS
  'How one payment is split across invoices. Amounts are positive and may not exceed the invoice balance at recording time.';
