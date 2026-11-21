ALTER TABLE "tenant_memberships" ADD COLUMN "branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD COLUMN "department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD COLUMN "full_name" varchar(200);--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD COLUMN "department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD COLUMN "branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_email_tokens_membership_idx" ON "auth_email_tokens" USING btree ("membership_id");