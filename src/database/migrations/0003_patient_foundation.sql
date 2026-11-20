CREATE TYPE "public"."blood_group" AS ENUM('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE');--> statement-breakpoint
CREATE TYPE "public"."patient_contact_type" AS ENUM('MOBILE', 'HOME', 'WORK', 'GUARDIAN', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."patient_document_type" AS ENUM('IDENTITY_PROOF', 'INSURANCE', 'REFERRAL', 'MEDICAL_HISTORY', 'CONSENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."patient_gender" AS ENUM('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('ACTIVE', 'INACTIVE', 'DECEASED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "patient_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"patient_code" varchar(40) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"date_of_birth" date,
	"gender" "patient_gender" DEFAULT 'UNKNOWN' NOT NULL,
	"blood_group" "blood_group",
	"status" "patient_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "patient_profiles_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_profiles_birth_date_check" CHECK ("patient_profiles"."date_of_birth" is null or "patient_profiles"."date_of_birth" <= current_date)
);
--> statement-breakpoint
CREATE TABLE "patient_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_type" "patient_contact_type" DEFAULT 'MOBILE' NOT NULL,
	"phone" varchar(32),
	"email" varchar(320),
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contacts_reachable_check" CHECK ("patient_contacts"."phone" is not null or "patient_contacts"."email" is not null)
);
--> statement-breakpoint
CREATE TABLE "patient_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"address_line_1" varchar(255) NOT NULL,
	"address_line_2" varchar(255),
	"city" varchar(120),
	"state" varchar(120),
	"postal_code" varchar(20),
	"country" varchar(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_emergency_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"relationship" varchar(60) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_type" "patient_document_type" NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"mime_type" varchar(150) NOT NULL,
	"file_size" bigint NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_documents_file_size_check" CHECK ("patient_documents"."file_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "patient_profiles" ADD CONSTRAINT "patient_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_profiles" ADD CONSTRAINT "patient_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_addresses" ADD CONSTRAINT "patient_addresses_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_emergency_contacts" ADD CONSTRAINT "patient_emergency_contacts_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patient_profiles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_profiles_tenant_code_unique" ON "patient_profiles" USING btree ("tenant_id","patient_code");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_profiles_tenant_user_unique" ON "patient_profiles" USING btree ("tenant_id","user_id") WHERE "patient_profiles"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "patient_profiles_tenant_status_idx" ON "patient_profiles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "patient_profiles_tenant_name_idx" ON "patient_profiles" USING btree ("tenant_id","full_name");--> statement-breakpoint
CREATE INDEX "patient_contacts_patient_idx" ON "patient_contacts" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contacts_primary_unique" ON "patient_contacts" USING btree ("tenant_id","patient_id") WHERE "patient_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "patient_addresses_patient_idx" ON "patient_addresses" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_emergency_contacts_patient_idx" ON "patient_emergency_contacts" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_documents_storage_key_unique" ON "patient_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "patient_documents_patient_type_idx" ON "patient_documents" USING btree ("tenant_id","patient_id","document_type","created_at");--> statement-breakpoint
CREATE INDEX "patient_documents_uploaded_by_idx" ON "patient_documents" USING btree ("uploaded_by");