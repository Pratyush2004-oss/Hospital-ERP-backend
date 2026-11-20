CREATE TYPE "public"."invoice_payment_status" AS ENUM('PENDING', 'SUCCESSFUL', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."invoice_refund_status" AS ENUM('PENDING', 'SUCCESSFUL', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'OVERDUE' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'REFUNDED';--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"payment_status" "invoice_payment_status" DEFAULT 'PENDING' NOT NULL,
	"reference" varchar(120),
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_payments_amount_check" CHECK ("invoice_payments"."amount" >= 0),
	CONSTRAINT "invoice_payments_currency_check" CHECK ("invoice_payments"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "invoice_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"refund_status" "invoice_refund_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"refunded_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_refunds_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_refunds_amount_check" CHECK ("invoice_refunds"."amount" >= 0),
	CONSTRAINT "invoice_refunds_currency_check" CHECK ("invoice_refunds"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_refunds" ADD CONSTRAINT "invoice_refunds_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."invoice_payments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("tenant_id","invoice_id","payment_status");--> statement-breakpoint
CREATE INDEX "invoice_refunds_invoice_idx" ON "invoice_refunds" USING btree ("tenant_id","invoice_id","refund_status");
-- ---------------------------------------------------------------------------
-- Row Level Security for the invoice payment/refund tables (Task 19.3.1).
-- Same `tenant_isolation` policy name as the rest of the billing tables; a
-- payment or refund is only reachable through a tenant-scoped transaction.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_payments"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "invoice_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_refunds"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON TABLE "invoice_payments" IS
  'Payment attempts per invoice. Only SUCCESSFUL rows reduce balance_due; recording a payment belongs to the payment task.';
COMMENT ON TABLE "invoice_refunds" IS
  'Refund transactions per invoice. Only SUCCESSFUL rows reduce amount_paid; refund processing belongs to the payment task.';
COMMENT ON COLUMN "invoices"."amount_paid" IS
  'Net settled money: successful payments minus successful refunds. Maintained by the invoice lifecycle service.';
COMMENT ON COLUMN "invoices"."invoice_status" IS
  'DRAFT at creation; ISSUED/OVERDUE/CANCELLED/REFUNDED by explicit lifecycle actions, PARTIALLY_PAID/PAID/REFUNDED derived from successful money records.';
