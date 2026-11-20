ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_unread_idx" ON "notifications" ("tenant_id", "user_id", "read_at") WHERE "read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_status_idx" ON "notifications" ("tenant_id", "user_id", "status", "created_at");
