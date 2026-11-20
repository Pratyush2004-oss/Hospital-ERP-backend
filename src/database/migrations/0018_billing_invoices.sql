CREATE TYPE "public"."invoice_discount_type" AS ENUM('AMOUNT', 'PERCENTAGE');--> statement-breakpoint
CREATE TYPE "public"."invoice_item_type" AS ENUM('CONSULTATION', 'REGISTRATION', 'PROCEDURE', 'LABORATORY', 'PHARMACY', 'ROOM_CHARGE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('CONSULTATION', 'PHARMACY', 'LABORATORY', 'PROCEDURE', 'ADMISSION', 'OTHER');--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"invoice_number" varchar(40) NOT NULL,
	"invoice_type" "invoice_type" DEFAULT 'OTHER' NOT NULL,
	"invoice_status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"notes" text,
	"subtotal" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"tax_total" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"amount_paid" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"balance_due" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_subtotal_check" CHECK ("invoices"."subtotal" >= 0),
	CONSTRAINT "invoices_discount_total_check" CHECK ("invoices"."discount_total" >= 0),
	CONSTRAINT "invoices_tax_total_check" CHECK ("invoices"."tax_total" >= 0),
	CONSTRAINT "invoices_total_amount_check" CHECK ("invoices"."total_amount" >= 0),
	CONSTRAINT "invoices_amount_paid_check" CHECK ("invoices"."amount_paid" >= 0),
	CONSTRAINT "invoices_balance_due_check" CHECK ("invoices"."balance_due" >= 0),
	CONSTRAINT "invoices_discount_within_subtotal_check" CHECK ("invoices"."discount_total" <= "invoices"."subtotal"),
	CONSTRAINT "invoices_total_reconciliation_check" CHECK ("invoices"."subtotal" - "invoices"."discount_total" + "invoices"."tax_total" = "invoices"."total_amount"),
	CONSTRAINT "invoices_due_date_check" CHECK ("invoices"."due_date" is null or "invoices"."due_date" >= "invoices"."issue_date")
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"item_type" "invoice_item_type" DEFAULT 'OTHER' NOT NULL,
	"description" varchar(500) NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"discount_type" "invoice_discount_type",
	"discount_value" numeric(12, 4),
	"gross_amount" numeric(12, 2) NOT NULL,
	"discount_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"tax_rate" numeric(7, 4) DEFAULT '0.0000' NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_items_quantity_check" CHECK ("invoice_items"."quantity" >= 0),
	CONSTRAINT "invoice_items_unit_price_check" CHECK ("invoice_items"."unit_price" >= 0),
	CONSTRAINT "invoice_items_gross_amount_check" CHECK ("invoice_items"."gross_amount" >= 0),
	CONSTRAINT "invoice_items_discount_amount_check" CHECK ("invoice_items"."discount_amount" >= 0),
	CONSTRAINT "invoice_items_discount_within_gross_check" CHECK ("invoice_items"."discount_amount" <= "invoice_items"."gross_amount"),
	CONSTRAINT "invoice_items_discount_value_check" CHECK ("invoice_items"."discount_value" is null or "invoice_items"."discount_value" >= 0),
	CONSTRAINT "invoice_items_tax_rate_check" CHECK ("invoice_items"."tax_rate" >= 0 and "invoice_items"."tax_rate" <= 100),
	CONSTRAINT "invoice_items_tax_amount_check" CHECK ("invoice_items"."tax_amount" >= 0),
	CONSTRAINT "invoice_items_line_total_check" CHECK ("invoice_items"."line_total" >= 0),
	CONSTRAINT "invoice_items_total_reconciliation_check" CHECK ("invoice_items"."gross_amount" - "invoice_items"."discount_amount" + "invoice_items"."tax_amount" = "invoice_items"."line_total")
);
--> statement-breakpoint
CREATE TABLE "invoice_number_sequences" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_number_sequences_last_value_check" CHECK ("invoice_number_sequences"."last_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_unique" ON "invoices" USING btree ("tenant_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_patient_history_idx" ON "invoices" USING btree ("tenant_id","patient_id","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_branch_history_idx" ON "invoices" USING btree ("tenant_id","branch_id","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("tenant_id","invoice_status","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_issue_date_idx" ON "invoices" USING btree ("tenant_id","issue_date","id");--> statement-breakpoint
CREATE INDEX "invoices_appointment_idx" ON "invoices" USING btree ("tenant_id","appointment_id") WHERE "invoices"."appointment_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "invoice_items" USING btree ("tenant_id","invoice_id","sort_order");

-- ---------------------------------------------------------------------------
-- Row Level Security for the Phase 19 billing tables.
--
-- Policies follow migration 0006 helpers. These tables were added later, so
-- they are enrolled here with the shared `tenant_isolation` policy name used by
-- patient_code_sequences in migration 0013. Invoice lines and the number
-- counter are only reachable through a tenant-scoped transaction either way.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "invoice_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_items"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_number_sequences"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON COLUMN "invoices"."invoice_number" IS
  'Allocated from invoice_number_sequences inside the creation transaction; unique per tenant for its lifetime.';--> statement-breakpoint
COMMENT ON COLUMN "invoices"."invoice_status" IS
  'DRAFT at creation. Issuing and payment transitions belong to the payment tasks.';--> statement-breakpoint
COMMENT ON COLUMN "invoices"."balance_due" IS
  'total_amount - amount_paid, never negative. Invoice creation writes the full total.';