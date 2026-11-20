ALTER TABLE "doctors" ALTER COLUMN "experience_years" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "doctors" ALTER COLUMN "experience_years" DROP NOT NULL;