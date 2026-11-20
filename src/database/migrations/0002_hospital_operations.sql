CREATE TYPE "public"."doctor_leave_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "departments_slug_format_check" CHECK ("departments"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"registration_number" varchar(80) NOT NULL,
	"qualification" varchar(200),
	"experience_years" smallint DEFAULT 0 NOT NULL,
	"biography" text,
	"profile_image_url" text,
	"specialization" varchar(150),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctors_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "doctors_experience_years_check" CHECK ("doctors"."experience_years" >= 0 and "doctors"."experience_years" <= 70)
);
--> statement-breakpoint
CREATE TABLE "doctor_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"department_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"consultation_fee" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_branches_doctor_branch_unique" UNIQUE("tenant_id","doctor_id","branch_id"),
	CONSTRAINT "doctor_branches_fee_check" CHECK ("doctor_branches"."consultation_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "doctor_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"slot_duration_minutes" smallint DEFAULT 15 NOT NULL,
	"effective_from" date DEFAULT current_date NOT NULL,
	"effective_until" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_schedules_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "doctor_schedules_day_of_week_check" CHECK ("doctor_schedules"."day_of_week" between 1 and 7),
	CONSTRAINT "doctor_schedules_time_order_check" CHECK ("doctor_schedules"."end_time" > "doctor_schedules"."start_time"),
	CONSTRAINT "doctor_schedules_slot_duration_check" CHECK ("doctor_schedules"."slot_duration_minutes" between 5 and 480),
	CONSTRAINT "doctor_schedules_window_fits_slot_check" CHECK (extract(epoch from ("doctor_schedules"."end_time" - "doctor_schedules"."start_time")) / 60 >= "doctor_schedules"."slot_duration_minutes"),
	CONSTRAINT "doctor_schedules_effective_range_check" CHECK ("doctor_schedules"."effective_until" is null or "doctor_schedules"."effective_until" >= "doctor_schedules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "doctor_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"reason" varchar(255),
	CONSTRAINT "doctor_breaks_time_order_check" CHECK ("doctor_breaks"."end_time" > "doctor_breaks"."start_time")
);
--> statement-breakpoint
CREATE TABLE "doctor_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"reason" text,
	"status" "doctor_leave_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_leaves_interval_check" CHECK ("doctor_leaves"."end_at" > "doctor_leaves"."start_at")
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_departments" ADD CONSTRAINT "doctor_departments_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_departments" ADD CONSTRAINT "doctor_departments_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_branches" ADD CONSTRAINT "doctor_branches_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_branches" ADD CONSTRAINT "doctor_branches_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "public"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_breaks" ADD CONSTRAINT "doctor_breaks_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."doctor_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_doctor_branch_fk" FOREIGN KEY ("tenant_id","doctor_id","branch_id") REFERENCES "public"."doctor_branches"("tenant_id","doctor_id","branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_branch_slug_unique" ON "departments" USING btree ("tenant_id","branch_id","slug");--> statement-breakpoint
CREATE INDEX "departments_tenant_branch_active_idx" ON "departments" USING btree ("tenant_id","branch_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_tenant_user_unique" ON "doctors" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_tenant_registration_unique" ON "doctors" USING btree ("tenant_id","registration_number");--> statement-breakpoint
CREATE INDEX "doctors_tenant_active_idx" ON "doctors" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "doctors_user_idx" ON "doctors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_departments_unique" ON "doctor_departments" USING btree ("tenant_id","doctor_id","department_id");--> statement-breakpoint
CREATE INDEX "doctor_departments_department_idx" ON "doctor_departments" USING btree ("tenant_id","department_id");--> statement-breakpoint
CREATE INDEX "doctor_branches_branch_active_idx" ON "doctor_branches" USING btree ("tenant_id","branch_id","is_active");--> statement-breakpoint
CREATE INDEX "doctor_schedules_doctor_day_idx" ON "doctor_schedules" USING btree ("tenant_id","doctor_id","day_of_week","is_active");--> statement-breakpoint
CREATE INDEX "doctor_schedules_branch_day_idx" ON "doctor_schedules" USING btree ("tenant_id","branch_id","day_of_week","is_active");--> statement-breakpoint
CREATE INDEX "doctor_breaks_schedule_idx" ON "doctor_breaks" USING btree ("tenant_id","schedule_id");--> statement-breakpoint
CREATE INDEX "doctor_leaves_doctor_range_idx" ON "doctor_leaves" USING btree ("tenant_id","doctor_id","start_at");--> statement-breakpoint
CREATE INDEX "doctor_leaves_tenant_status_idx" ON "doctor_leaves" USING btree ("tenant_id","status");