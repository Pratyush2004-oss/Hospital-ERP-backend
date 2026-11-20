CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid,
  "branch_id" uuid,
  "actor_user_id" uuid,
  "actor_scope" varchar(20),
  "action" varchar(120) NOT NULL,
  "module" varchar(60) NOT NULL,
  "resource_type" varchar(100),
  "resource_id" varchar(200),
  "description" varchar(500),
  "previous_state" jsonb,
  "new_state" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "request_id" varchar(100),
  "ip_address" varchar(64),
  "user_agent" varchar(512),
  "dedupe_key" varchar(250),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_logs_action_check" CHECK (length(btrim("action")) > 0),
  CONSTRAINT "audit_logs_module_check" CHECK (length(btrim("module")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_dedupe_unique" ON "audit_logs" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" ("tenant_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_module_created_idx" ON "audit_logs" ("tenant_id", "module", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_resource_idx" ON "audit_logs" ("tenant_id", "resource_type", "resource_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_actor_idx" ON "audit_logs" ("tenant_id", "actor_user_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_branch_idx" ON "audit_logs" ("tenant_id", "branch_id", "created_at");--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_logs" USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.audit_maintenance', true), '') = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_logs_immutable"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
