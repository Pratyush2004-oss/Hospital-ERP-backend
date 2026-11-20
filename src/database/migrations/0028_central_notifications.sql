CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."notification_locale" AS ENUM('EN', 'HI');--> statement-breakpoint
CREATE TABLE "notification_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id") ON DELETE cascade,
  "event" varchar(100) NOT NULL,
  "channel" "notification_channel" NOT NULL,
  "locale" "notification_locale" DEFAULT 'EN' NOT NULL,
  "subject" varchar(300),
  "body" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_templates_tenant_event_channel_locale_unique" UNIQUE ("tenant_id", "event", "channel", "locale")
);--> statement-breakpoint
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "public"."users"("id") ON DELETE cascade,
  "patient_id" uuid,
  "event" varchar(100) NOT NULL,
  "channel" "notification_channel" NOT NULL,
  "status" "notification_delivery_status" DEFAULT 'PENDING' NOT NULL,
  "source_event_id" varchar(200) NOT NULL,
  "recipient" varchar(320),
  "subject" varchar(300),
  "body" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "provider_message_id" varchar(200),
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_tenant_source_channel_unique" UNIQUE ("tenant_id", "source_event_id", "channel"),
  CONSTRAINT "notifications_patient_fk" FOREIGN KEY ("tenant_id", "patient_id") REFERENCES "public"."patient_profiles"("tenant_id", "id") ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE "notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "public"."users"("id") ON DELETE cascade,
  "event" varchar(100),
  "channel" "notification_channel" NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_preferences_tenant_user_event_channel_unique" UNIQUE ("tenant_id", "user_id", "event", "channel")
);--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_created_idx" ON "notifications" ("tenant_id", "user_id", "created_at");--> statement-breakpoint
CREATE INDEX "notifications_delivery_idx" ON "notifications" ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "notification_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_templates" USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_preferences" USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
