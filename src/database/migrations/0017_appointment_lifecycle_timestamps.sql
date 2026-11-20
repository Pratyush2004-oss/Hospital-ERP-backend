ALTER TABLE "appointments" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "consultation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "no_show_at" timestamp with time zone;--> statement-breakpoint
COMMENT ON COLUMN "appointments"."checked_in_at" IS
  'Phase 18.5 lifecycle timestamp; set with the CHECKED_IN transition in the same transaction as its event.';
COMMENT ON COLUMN "appointments"."consultation_started_at" IS
  'Phase 18.5 lifecycle timestamp; set with the IN_PROGRESS transition.';
COMMENT ON COLUMN "appointments"."completed_at" IS
  'Phase 18.5 lifecycle timestamp; set with the COMPLETED transition. Payment state is separate.';
COMMENT ON COLUMN "appointments"."no_show_at" IS
  'Phase 18.5 lifecycle timestamp; set with the NO_SHOW transition.';
