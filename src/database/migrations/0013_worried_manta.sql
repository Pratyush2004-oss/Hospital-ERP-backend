CREATE TABLE "patient_code_sequences" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_code_sequences_last_value_check" CHECK ("patient_code_sequences"."last_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "patient_code_sequences" ADD CONSTRAINT "patient_code_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row Level Security for the per-tenant patient code counter.
--
-- The counter is internal (never exposed over HTTP) but it is still
-- tenant-owned, so it gets the same tenant_isolation policy as every other
-- tenant-scoped table. Policies are defined in migration 0006; this table was
-- added later, so it is enrolled here instead of redefining helpers.
-- ---------------------------------------------------------------------------
ALTER TABLE "patient_code_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_code_sequences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_code_sequences"
  USING (tenant_id = app_current_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());