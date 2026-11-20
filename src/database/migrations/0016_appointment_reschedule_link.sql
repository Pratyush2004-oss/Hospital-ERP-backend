ALTER TABLE "appointments" ADD COLUMN "rescheduled_from_appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_fk" FOREIGN KEY ("tenant_id","rescheduled_from_appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_rescheduled_from_unique" ON "appointments" USING btree ("tenant_id","rescheduled_from_appointment_id") WHERE "appointments"."rescheduled_from_appointment_id" is not null;--> statement-breakpoint
COMMENT ON COLUMN "appointments"."rescheduled_from_appointment_id" IS
  'Replacement model: points at the superseded appointment. The original row is RESCHEDULED and releases its slot.';
