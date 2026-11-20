CREATE TABLE "platform_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "active_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_roles_user_role_unique" ON "platform_user_roles" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE INDEX "platform_user_roles_role_idx" ON "platform_user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "platform_user_roles_user_idx" ON "platform_user_roles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_tenant_id_tenants_id_fk" FOREIGN KEY ("active_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- PostgreSQL Row Level Security for tenant-scoped tables.
--
-- The application sets two transaction-local GUCs with
--   select set_config('app.current_tenant_id', ..., true)
--   select set_config('app.current_user_id', ..., true)
--   select set_config('app.is_platform', 'true', true)
-- (see src/database/context.ts). RLS policies only trust those values, never a
-- tenant id supplied by the client. `FORCE ROW LEVEL SECURITY` also applies the
-- policies to the table owner. Note that PostgreSQL superusers still bypass
-- RLS, so production must connect with a non-superuser application role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(current_setting('app.is_platform', true), 'false') = 'true'
$$;--> statement-breakpoint

-- Tenants are visible to platform staff, to the active tenant, and to users
-- with an ACTIVE membership (needed by the "my hospitals" listing).
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenants_select" ON "tenants" FOR SELECT
  USING (
    "id" = app_current_tenant_id()
    OR app_is_platform()
    OR EXISTS (
      SELECT 1 FROM "tenant_memberships" tm
      WHERE tm.tenant_id = "tenants"."id"
        AND tm.user_id = app_current_user_id()
        AND tm.status = 'ACTIVE'
    )
  );--> statement-breakpoint
CREATE POLICY "tenants_write" ON "tenants" FOR ALL
  USING ("id" = app_current_tenant_id() OR app_is_platform())
  WITH CHECK ("id" = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint

-- Memberships: a user may always see their own rows across tenants.
ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_memberships_select" ON "tenant_memberships" FOR SELECT
  USING (
    "tenant_id" = app_current_tenant_id()
    OR "user_id" = app_current_user_id()
    OR app_is_platform()
  );--> statement-breakpoint
CREATE POLICY "tenant_memberships_write" ON "tenant_memberships" FOR ALL
  USING ("tenant_id" = app_current_tenant_id() OR app_is_platform())
  WITH CHECK ("tenant_id" = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint

-- Hospital roles are visible in their tenant; platform roles (tenant NULL) are
-- readable globally but can only be written through the platform plane.
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "roles_select" ON "roles" FOR SELECT
  USING (
    "tenant_id" IS NULL
    OR "tenant_id" = app_current_tenant_id()
    OR app_is_platform()
  );--> statement-breakpoint
CREATE POLICY "roles_write" ON "roles" FOR ALL
  USING ("tenant_id" = app_current_tenant_id() OR app_is_platform())
  WITH CHECK ("tenant_id" = app_current_tenant_id() OR app_is_platform());--> statement-breakpoint

-- Role grants inherit the role's tenant; platform role grants are readable but
-- never writable from a hospital context.
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "role_permissions_select" ON "role_permissions" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "role_permissions"."role_id"
        AND (r.tenant_id IS NULL OR r.tenant_id = app_current_tenant_id() OR app_is_platform())
    )
  );--> statement-breakpoint
CREATE POLICY "role_permissions_write" ON "role_permissions" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "role_permissions"."role_id"
        AND (r.tenant_id = app_current_tenant_id() OR app_is_platform())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "roles" r
      WHERE r.id = "role_permissions"."role_id"
        AND (r.tenant_id = app_current_tenant_id() OR app_is_platform())
    )
  );--> statement-breakpoint

-- Every remaining tenant-scoped table has a plain tenant_id column.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'tenant_settings',
    'membership_roles',
    'branches',
    'departments',
    'doctors',
    'doctor_departments',
    'doctor_branches',
    'doctor_schedules',
    'doctor_breaks',
    'doctor_leaves',
    'patient_profiles',
    'patient_contacts',
    'patient_addresses',
    'patient_emergency_contacts',
    'patient_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform())',
      target
    );
  END LOOP;
END $$;