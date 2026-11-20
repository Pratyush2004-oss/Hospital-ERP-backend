ALTER TABLE "doctors" ADD COLUMN "doctor_code" varchar(50);--> statement-breakpoint
-- Existing profiles predate doctor codes: derive one from the registration
-- number (already unique per tenant) before enforcing NOT NULL.
UPDATE "doctors" SET "doctor_code" = left("registration_number", 50) WHERE "doctor_code" IS NULL;--> statement-breakpoint
ALTER TABLE "doctors" ALTER COLUMN "doctor_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "registration_council" varchar(150);--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "consultation_language" jsonb;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doctor_branches" ADD COLUMN "currency" char(3) DEFAULT 'USD' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_tenant_code_unique" ON "doctors" USING btree ("tenant_id","doctor_code");--> statement-breakpoint
CREATE INDEX "doctor_branches_doctor_active_idx" ON "doctor_branches" USING btree ("tenant_id","doctor_id","is_active");