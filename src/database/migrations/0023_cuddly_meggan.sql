CREATE TYPE "public"."payment_gateway_order_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "payment_gateway_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" varchar(40) NOT NULL,
	"provider_order_id" varchar(120) NOT NULL,
	"provider_transaction_reference" varchar(120),
	"amount" numeric(12, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "payment_gateway_order_status" DEFAULT 'PENDING' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_orders_amount_check" CHECK ("payment_gateway_orders"."amount" > 0),
	CONSTRAINT "payment_gateway_orders_currency_check" CHECK ("payment_gateway_orders"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "payment_gateway_orders" ADD CONSTRAINT "payment_gateway_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_orders" ADD CONSTRAINT "payment_gateway_orders_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_orders" ADD CONSTRAINT "payment_gateway_orders_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateway_orders_provider_order_unique" ON "payment_gateway_orders" USING btree ("tenant_id","provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateway_orders_payment_unique" ON "payment_gateway_orders" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_gateway_orders_invoice_idx" ON "payment_gateway_orders" USING btree ("tenant_id","invoice_id","status");
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Row Level Security for gateway checkout orders (Task 19.6.1). Same
-- `tenant_isolation` policy as every other billing table: an order is only
-- reachable through a tenant-scoped transaction, and FORCE applies it to the
-- table owner as well.
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_gateway_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_gateway_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_gateway_orders"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON TABLE "payment_gateway_orders" IS
  'Provider checkout orders for pending online payments. Provider-specific ids and non-secret metadata live here; an open order never settles an invoice.';