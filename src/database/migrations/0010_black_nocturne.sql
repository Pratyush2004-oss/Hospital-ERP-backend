ALTER TABLE "doctor_leaves" DROP CONSTRAINT "doctor_leaves_doctor_branch_fk";
--> statement-breakpoint
ALTER TABLE "doctor_leaves" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD COLUMN "buffer_minutes" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD COLUMN "created_by" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "public"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doctor_schedules_effective_idx" ON "doctor_schedules" USING btree ("tenant_id","effective_from","effective_until");--> statement-breakpoint
CREATE INDEX "doctor_leaves_branch_range_idx" ON "doctor_leaves" USING btree ("tenant_id","branch_id","start_at");--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_buffer_check" CHECK ("doctor_schedules"."buffer_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_approval_check" CHECK ("doctor_leaves"."status" <> 'APPROVED' or ("doctor_leaves"."approved_by" is not null and "doctor_leaves"."approved_at" is not null));
-- --- Scheduling integrity (Task 16.1) ---------------------------------------
-- GiST equality on uuid/smallint is required so the exclusion constraints below
-- can combine scalar equality with range overlap. btree_gist ships with every
-- supported PostgreSQL distribution; it is created here once, by the migration
-- owner, never at server startup.
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint

-- Two ACTIVE windows for the same doctor/branch/weekday conflict only when both
-- their effective dates and their wall-clock times overlap. A split shift
-- (09:00-13:00 plus 16:00-20:00) is therefore legal, a duplicate or partially
-- overlapping window is not. Inactive rows are excluded so history is kept.
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_no_overlap"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "doctor_id" WITH =,
  "branch_id" WITH =,
  "day_of_week" WITH =,
  daterange("effective_from", "effective_until", '[]') WITH &&,
  tsrange(date '2000-01-01' + "start_time", date '2000-01-01' + "end_time") WITH &&
) WHERE ("is_active");--> statement-breakpoint

-- Breaks are half-open ranges, so 11:00-11:15 followed by 11:15-11:30 is fine
-- while any overlap inside the same schedule is rejected.
ALTER TABLE "doctor_breaks" ADD CONSTRAINT "doctor_breaks_no_overlap"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "schedule_id" WITH =,
  tsrange(date '2000-01-01' + "start_time", date '2000-01-01' + "end_time") WITH &&
);--> statement-breakpoint

-- Containment is a cross-row rule that a CHECK cannot express. The trigger reads
-- the parent window; the composite foreign key still reports a missing schedule.
CREATE FUNCTION "doctor_breaks_within_schedule"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  window_start time;
  window_end time;
BEGIN
  SELECT s."start_time", s."end_time" INTO window_start, window_end
  FROM "doctor_schedules" s
  WHERE s."tenant_id" = NEW."tenant_id" AND s."id" = NEW."schedule_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW."start_time" < window_start OR NEW."end_time" > window_end THEN
    RAISE EXCEPTION 'doctor break must fall within schedule window %-%',
      window_start, window_end
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "doctor_breaks_window_check"
BEFORE INSERT OR UPDATE ON "doctor_breaks"
FOR EACH ROW EXECUTE FUNCTION "doctor_breaks_within_schedule"();--> statement-breakpoint

COMMENT ON COLUMN "doctor_schedules"."day_of_week" IS
  'ISO weekday in branch-local time: 1 = Monday ... 7 = Sunday';
COMMENT ON COLUMN "doctor_schedules"."start_time" IS
  'Branch-local wall-clock time (no UTC conversion); repeats weekly';
COMMENT ON COLUMN "doctor_schedules"."end_time" IS
  'Branch-local wall-clock time (no UTC conversion); repeats weekly';
COMMENT ON COLUMN "doctor_schedules"."buffer_minutes" IS
  'Pause after each slot; excluded from the consultation itself';
COMMENT ON COLUMN "doctor_leaves"."branch_id" IS
  'NULL = leave applies to every branch; otherwise a branch the doctor is assigned to';
COMMENT ON COLUMN "doctor_leaves"."created_by" IS
  'User who recorded the request; hard delete of that account is restricted';
