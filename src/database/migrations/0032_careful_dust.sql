CREATE TYPE "public"."auth_email_token_purpose" AS ENUM('EMAIL_VERIFICATION', 'STAFF_INVITATION');--> statement-breakpoint
CREATE TABLE "auth_email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "auth_email_token_purpose" NOT NULL,
	"user_id" uuid,
	"email" varchar(320) NOT NULL,
	"tenant_id" uuid,
	"role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invited_by_user_id" uuid,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_tokens_hash_unique" ON "auth_email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_user_purpose_idx" ON "auth_email_tokens" USING btree ("user_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_email_purpose_idx" ON "auth_email_tokens" USING btree ("email","purpose","created_at");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_tenant_idx" ON "auth_email_tokens" USING btree ("tenant_id","purpose","created_at");
