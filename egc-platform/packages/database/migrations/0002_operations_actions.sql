CREATE TABLE "operation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"task_revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid,
	"revision" integer,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"source" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_id" text DEFAULT 'egc' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "portal_job_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "portal_visit_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "portal_revision" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "time_zone" text DEFAULT 'America/Denver' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "waiting_on" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_condition" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "draft_payload" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approval_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "operation_approvals" ADD CONSTRAINT "operation_approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_approvals_exact_idx" ON "operation_approvals" USING btree ("workspace_id","task_id","task_revision","fingerprint");--> statement-breakpoint
CREATE INDEX "operation_briefs_workspace_time_idx" ON "operation_briefs" USING btree ("workspace_id","generated_at");--> statement-breakpoint
CREATE INDEX "operation_events_task_idx" ON "operation_events" USING btree ("workspace_id","task_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_requests_key_uq" ON "operation_requests" USING btree ("workspace_id","actor_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_workspace_dedupe_uq" ON "tasks" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "tasks_workspace_due_idx" ON "tasks" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_portal_job_idx" ON "tasks" USING btree ("workspace_id","portal_job_id");