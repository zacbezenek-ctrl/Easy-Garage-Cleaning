CREATE TABLE "customer_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"opportunity_id" uuid,
	"appointment_id" uuid,
	"job_id" uuid,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"human_review_needed" boolean DEFAULT false NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_action" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_cents" integer,
	"currency" text,
	"value_verified" boolean DEFAULT false NOT NULL,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"source_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"extractor_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"extracted_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_pointer" text,
	"error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_operational_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'user_confirmed' NOT NULL,
	"exact_text" text NOT NULL,
	"source_reference" text NOT NULL,
	"actor_id" text NOT NULL,
	"asserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"occurred_at_verified" boolean DEFAULT false NOT NULL,
	"value_cents" integer,
	"currency" text,
	"status" text DEFAULT 'pending_reconciliation' NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_state_snapshots" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"state" text NOT NULL,
	"intent_stage" text NOT NULL,
	"pipeline" text NOT NULL,
	"reconciliation_status" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"last_reconciled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_original_attribution" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"attribution" jsonb NOT NULL,
	"source_record_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provenance" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_evidence" ADD CONSTRAINT "customer_evidence_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_evidence" ADD CONSTRAINT "customer_evidence_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_operational_assertions" ADD CONSTRAINT "customer_operational_assertions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_state_snapshots" ADD CONSTRAINT "customer_state_snapshots_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_state_snapshots" ADD CONSTRAINT "customer_state_snapshots_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_original_attribution" ADD CONSTRAINT "lead_original_attribution_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_original_attribution" ADD CONSTRAINT "lead_original_attribution_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_events_contact_idx" ON "customer_events" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_events_type_time_idx" ON "customer_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_evidence_source_uq" ON "customer_evidence" USING btree ("source_type","source_record_id");--> statement-breakpoint
CREATE INDEX "customer_evidence_contact_idx" ON "customer_evidence" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_assertions_contact_idx" ON "customer_operational_assertions" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "customer_snapshots_state_idx" ON "customer_state_snapshots" USING btree ("state","reconciliation_status");