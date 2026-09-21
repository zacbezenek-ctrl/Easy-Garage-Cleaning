CREATE TABLE "appointment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" text NOT NULL,
	"resource_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_appointment_id" text,
	"response" jsonb,
	"last_error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "walkthroughs" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "workspace_id" text DEFAULT 'egc' NOT NULL;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "portal_job_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "portal_visit_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "portal_customer_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "portal_project_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "portal_revision" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "upload_request_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "audio_content_type" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "audio_filename" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "audio_bytes" integer;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "processing_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "approval_request_id" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "approved_revision" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "approval_payload" jsonb;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "approval_fingerprint" text;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD COLUMN "extraction_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_operations_key_uq" ON "appointment_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "appointment_operations_resource_idx" ON "appointment_operations" USING btree ("resource_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "walkthroughs_upload_request_uq" ON "walkthroughs" USING btree ("workspace_id","upload_request_id");--> statement-breakpoint
CREATE INDEX "walkthroughs_processing_idx" ON "walkthroughs" USING btree ("status","processing_lease_until");