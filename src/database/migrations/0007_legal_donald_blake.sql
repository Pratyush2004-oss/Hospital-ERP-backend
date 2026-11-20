CREATE TABLE "department_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "department_branches" ADD CONSTRAINT "department_branches_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branches" ADD CONSTRAINT "department_branches_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "department_branches_unique" ON "department_branches" USING btree ("tenant_id","department_id","branch_id");--> statement-breakpoint
CREATE INDEX "department_branches_branch_idx" ON "department_branches" USING btree ("tenant_id","branch_id");--> statement-breakpoint
-- Backfill: a department created under the original branch-scoped model operates
-- in its home branch. Platform context is needed because departments have FORCE
-- ROW LEVEL SECURITY (migration 0006) and this reads rows of every tenant.
SELECT set_config('app.is_platform', 'true', true);--> statement-breakpoint
INSERT INTO "department_branches" ("tenant_id", "department_id", "branch_id")
SELECT "tenant_id", "id", "branch_id" FROM "departments"
ON CONFLICT DO NOTHING;--> statement-breakpoint
SELECT set_config('app.is_platform', 'false', true);--> statement-breakpoint

-- RLS for the new join table, matching the policy applied to tenant-scoped
-- tables in migration 0006.
ALTER TABLE "department_branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "department_branches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "department_branches" USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform());
