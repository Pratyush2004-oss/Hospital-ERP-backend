ALTER TABLE "doctor_leaves" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_rejection_check" CHECK ("doctor_leaves"."status" <> 'REJECTED' or ("doctor_leaves"."rejected_by" is not null and "doctor_leaves"."rejected_at" is not null));