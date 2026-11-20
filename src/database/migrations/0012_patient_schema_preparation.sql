CREATE TYPE "public"."patient_address_type" AS ENUM('HOME', 'WORK', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."patient_marital_status" AS ENUM('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'OTHER');--> statement-breakpoint
ALTER TABLE "patient_profiles" ADD COLUMN "marital_status" "patient_marital_status";--> statement-breakpoint
ALTER TABLE "patient_profiles" ADD COLUMN "profile_image_key" varchar(512);--> statement-breakpoint
ALTER TABLE "patient_addresses" ADD COLUMN "address_type" "patient_address_type" DEFAULT 'HOME' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_addresses" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_emergency_contacts" ADD COLUMN "email" varchar(320);--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contacts_patient_phone_unique" ON "patient_contacts" USING btree ("tenant_id","patient_id","phone") WHERE "patient_contacts"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contacts_patient_email_unique" ON "patient_contacts" USING btree ("tenant_id","patient_id",lower("email")) WHERE "patient_contacts"."email" is not null;--> statement-breakpoint
CREATE INDEX "patient_addresses_patient_type_idx" ON "patient_addresses" USING btree ("tenant_id","patient_id","address_type");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_addresses_primary_unique" ON "patient_addresses" USING btree ("tenant_id","patient_id","address_type") WHERE "patient_addresses"."is_primary";