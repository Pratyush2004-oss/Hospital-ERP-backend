CREATE TYPE "public"."appointment_event_type" AS ENUM('CREATED', 'STATUS_CHANGED', 'UPDATED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."appointment_idempotency_status" AS ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."appointment_source" AS ENUM('ONLINE', 'RECEPTIONIST', 'WALK_IN', 'VOICE_AGENT');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');--> statement-breakpoint
CREATE TYPE "public"."appointment_type" AS ENUM('CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'EMERGENCY');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"department_id" uuid,
	"appointment_code" varchar(40) NOT NULL,
	"appointment_source" "appointment_source" NOT NULL,
	"appointment_type" "appointment_type" DEFAULT 'CONSULTATION' NOT NULL,
	"appointment_status" "appointment_status" DEFAULT 'CONFIRMED' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"consultation_fee" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_time_order_check" CHECK ("appointments"."end_at" > "appointments"."start_at"),
	CONSTRAINT "appointments_fee_check" CHECK ("appointments"."consultation_fee" >= 0),
	CONSTRAINT "appointments_cancellation_check" CHECK ("appointments"."appointment_status" <> 'CANCELLED' or "appointments"."cancellation_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "appointment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"event_type" "appointment_event_type" NOT NULL,
	"previous_status" "appointment_status",
	"new_status" "appointment_status",
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation" varchar(50) DEFAULT 'appointment.create' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"appointment_id" uuid,
	"status" "appointment_idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "public"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_idempotency_keys" ADD CONSTRAINT "appointment_idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_idempotency_keys" ADD CONSTRAINT "appointment_idempotency_keys_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_tenant_code_unique" ON "appointments" USING btree ("tenant_id","appointment_code");--> statement-breakpoint
CREATE INDEX "appointments_patient_history_idx" ON "appointments" USING btree ("tenant_id","patient_id","start_at");--> statement-breakpoint
CREATE INDEX "appointments_doctor_calendar_idx" ON "appointments" USING btree ("tenant_id","doctor_id","start_at");--> statement-breakpoint
CREATE INDEX "appointments_branch_calendar_idx" ON "appointments" USING btree ("tenant_id","branch_id","start_at");--> statement-breakpoint
CREATE INDEX "appointments_status_idx" ON "appointments" USING btree ("tenant_id","appointment_status","start_at");--> statement-breakpoint
CREATE INDEX "appointments_range_idx" ON "appointments" USING btree ("tenant_id","start_at","end_at");--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_idx" ON "appointment_events" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_idempotency_keys_unique" ON "appointment_idempotency_keys" USING btree ("tenant_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "appointment_idempotency_keys_appointment_idx" ON "appointment_idempotency_keys" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_idempotency_keys_expiry_idx" ON "appointment_idempotency_keys" USING btree ("tenant_id","expires_at");
-- --- Appointment integrity (Phase 18.1) ------------------------------------
-- GiST equality on uuid/scalars is required so the exclusion constraint below
-- can combine scalar equality with range overlap. The extension is already
-- installed by migration 0010; re-declaring it keeps this migration standalone
-- and is a no-op when present.
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint

-- Double-booking prevention at the database level: two *active* appointments
-- for the same doctor at the same branch may not overlap. The range is
-- half-open, so a 09:00-09:30 appointment and a 09:30-10:00 appointment are
-- adjacent and both allowed. Terminal states (COMPLETED, CANCELLED, NO_SHOW,
-- RESCHEDULED) are outside the predicate, which releases the slot after a
-- cancellation, a no-show, a completed visit or a reschedule marker. This
-- constraint is the authoritative guard against concurrent bookings; the future
-- booking service must still map the 23P01 violation to a 409 response.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "doctor_id" WITH =,
  "branch_id" WITH =,
  tstzrange("start_at", "end_at", '[)') WITH &&
) WHERE ("appointment_status" in ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row Level Security for appointment tables. Policies reuse the helper
-- functions and transaction-local context defined in migration 0006; no new
-- tenant isolation mechanism is introduced.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'appointments',
    'appointment_events',
    'appointment_idempotency_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id() OR app_is_platform()) WITH CHECK (tenant_id = app_current_tenant_id() OR app_is_platform())',
      target
    );
  END LOOP;
END $$;--> statement-breakpoint

COMMENT ON COLUMN "appointments"."start_at" IS
  'Absolute instant. Local booking requests are interpreted in the branch timezone before storage.';
COMMENT ON COLUMN "appointments"."end_at" IS
  'Exclusive end of the reserved slot; must be later than start_at.';
COMMENT ON COLUMN "appointments"."appointment_status" IS
  'Lifecycle state only; payment status is a separate concept and is never stored here.';
COMMENT ON COLUMN "appointments"."department_id" IS
  'NULL when no department was selected; department/branch coverage is a service rule.';
COMMENT ON COLUMN "appointments"."notes" IS
  'Private operational note, not a clinical record. Never log and never return from list endpoints.';
COMMENT ON COLUMN "appointments"."appointment_code" IS
  'Operational identifier, unique per tenant and reserved even after cancellation.';
COMMENT ON COLUMN "appointment_events"."created_at" IS
  'Event timestamp; appointment_events is append-only.';
COMMENT ON COLUMN "appointment_idempotency_keys"."operation" IS
  'Command scope for the key, so one key cannot collide across operations.';
COMMENT ON COLUMN "appointment_idempotency_keys"."request_hash" IS
  'SHA-256 hex digest of the canonical request, used to detect key reuse with a different payload.';
