CREATE TYPE "public"."membership_status" AS ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"legal_name" varchar(255),
	"email" varchar(320),
	"phone" varchar(32),
	"logo_url" text,
	"status" "tenant_status" DEFAULT 'PENDING' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(32),
	"password_hash" varchar(255) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'INVITED' NOT NULL,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"setting_key" varchar(100) NOT NULL,
	"setting_value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"branch_code" varchar(50) NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"address_line1" varchar(255),
	"address_line2" varchar(255),
	"city" varchar(120),
	"state" varchar(120),
	"postal_code" varchar(20),
	"country" varchar(2),
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "branches_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone") WHERE "users"."phone" is not null;--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_memberships_tenant_user_unique" ON "tenant_memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_idx" ON "tenant_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_tenant_status_idx" ON "tenant_memberships" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_settings_tenant_key_unique" ON "tenant_settings" USING btree ("tenant_id","setting_key");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_code_unique" ON "branches" USING btree ("tenant_id","branch_code");--> statement-breakpoint
CREATE INDEX "branches_tenant_active_idx" ON "branches" USING btree ("tenant_id","is_active");