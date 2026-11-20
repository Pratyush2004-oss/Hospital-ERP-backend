CREATE TYPE "public"."billing_notification_channel" AS ENUM('EMAIL', 'SMS');--> statement-breakpoint
CREATE TYPE "public"."billing_notification_event" AS ENUM('INVOICE_ISSUED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'PARTIAL_PAYMENT_RECEIVED', 'INVOICE_OVERDUE', 'INVOICE_DUE_SOON', 'REFUND_SUCCEEDED', 'REFUND_FAILED');--> statement-breakpoint
CREATE TYPE "public"."billing_notification_status" AS ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "billing_notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event" "billing_notification_event" NOT NULL,
	"channel" "billing_notification_channel" NOT NULL,
	"subject" varchar(200),
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event" "billing_notification_event" NOT NULL,
	"channel" "billing_notification_channel" NOT NULL,
	"status" "billing_notification_status" DEFAULT 'PENDING' NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"refund_id" uuid,
	"template_id" uuid,
	"recipient" varchar(320) NOT NULL,
	"subject" varchar(300),
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" varchar(220) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_message_id" varchar(200),
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_notifications_attempts_check" CHECK ("billing_notifications"."attempts" >= 0),
	CONSTRAINT "billing_notifications_max_attempts_check" CHECK ("billing_notifications"."max_attempts" > 0),
	CONSTRAINT "billing_notifications_recipient_check" CHECK (length("billing_notifications"."recipient") > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_notification_templates" ADD CONSTRAINT "billing_notification_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_template_id_billing_notification_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."billing_notification_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_refund_fk" FOREIGN KEY ("tenant_id","refund_id") REFERENCES "public"."invoice_refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notification_templates_tenant_event_channel_unique" ON "billing_notification_templates" USING btree ("tenant_id","event","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notifications_tenant_dedupe_unique" ON "billing_notifications" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "billing_notifications_tenant_created_idx" ON "billing_notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_notifications_tenant_invoice_idx" ON "billing_notifications" USING btree ("tenant_id","invoice_id","event");--> statement-breakpoint
CREATE INDEX "billing_notifications_delivery_idx" ON "billing_notifications" USING btree ("next_attempt_at") WHERE "billing_notifications"."status" in ('PENDING', 'FAILED', 'PROCESSING');--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Row Level Security for billing notification templates and delivery history
-- (Phase 19.10). The worker uses the platform context (`app.is_platform()`)
-- to claim rows across tenants; every hospital-plane read stays tenant-scoped.
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_notification_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_notification_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_notification_templates"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "billing_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_notifications"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
COMMENT ON TABLE "billing_notifications" IS
  'Transactional outbox and delivery history for billing notifications. Unique (tenant_id, dedupe_key) prevents duplicate reminders; PostgreSQL SKIP LOCKED claims make repeated/concurrent worker runs safe.';--> statement-breakpoint
COMMENT ON TABLE "billing_notification_templates" IS
  'Tenant overrides for billing notification templates. Plain text only; code defaults apply when no active row exists.';