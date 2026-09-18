CREATE TYPE "public"."actor_type" AS ENUM('customer', 'human', 'automation', 'system');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('new', 'confirmed', 'cancelled', 'showed', 'noshow', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."lead_state" AS ENUM('NEVER_CONTACTED', 'OUTREACH_ATTEMPTED_NO_REPLY', 'CUSTOMER_RESPONDED', 'ACTIVE_CONVERSATION', 'BOOKED', 'LOST', 'DO_NOT_CONTACT');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"calendar_id" text,
	"assigned_user_id" text,
	"title" text,
	"status" "appointment_status" DEFAULT 'new' NOT NULL,
	"appointment_created_at" timestamp with time zone,
	"appointment_start_at" timestamp with time zone NOT NULL,
	"appointment_end_at" timestamp with time zone,
	"notes" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"text" text NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"status" text,
	"recording_url" text,
	"answered" boolean,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'ghl' NOT NULL,
	"provider_id" text NOT NULL,
	"location_id" text,
	"first_name" text,
	"last_name" text,
	"name" text,
	"email" text,
	"phone" text,
	"source" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"appointment_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"service_address" text,
	"garage_size" text,
	"service_type" text,
	"junk_volume_yards" numeric(6, 2),
	"items_remove" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items_keep" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items_relocate" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organization_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_notes" text,
	"estimated_labor_hours" numeric(6, 2),
	"scheduled_at" timestamp with time zone,
	"price_cents" integer,
	"deposit_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"source" text,
	"current_state" "lead_state" DEFAULT 'NEVER_CONTACTED' NOT NULL,
	"assigned_user_id" text,
	"last_human_outreach_at" timestamp with time zone,
	"last_customer_response_at" timestamp with time zone,
	"first_booked_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid NOT NULL,
	"type" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"pipeline_id" text,
	"pipeline_stage_id" text,
	"status" text,
	"monetary_value_cents" integer,
	"assigned_user_id" text,
	"source" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"resource_type" text NOT NULL,
	"provider_id" text NOT NULL,
	"canonical_field" text,
	"display_name" text,
	"field_type" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "walkthroughs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audio_object_key" text,
	"transcript" text,
	"extraction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_provider_uq" ON "appointments" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "appointments_created_idx" ON "appointments" USING btree ("appointment_created_at");--> statement-breakpoint
CREATE INDEX "appointments_start_idx" ON "appointments" USING btree ("appointment_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_transcripts_call_uq" ON "call_transcripts" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_provider_message_uq" ON "calls" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "calls_contact_time_idx" ON "calls" USING btree ("contact_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_provider_id_uq" ON "contacts" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "contacts_phone_idx" ON "contacts" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_provider_uq" ON "conversations" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "jobs_scheduled_idx" ON "jobs" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_contact_uq" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "leads_state_idx" ON "leads" USING btree ("current_state");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "messages_contact_time_idx" ON "messages" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_codes_hash_uq" ON "oauth_authorization_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_expires_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_access_hash_uq" ON "oauth_tokens" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_refresh_hash_uq" ON "oauth_tokens" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_access_expires_idx" ON "oauth_tokens" USING btree ("access_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_provider_uq" ON "opportunities" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "opportunities_contact_idx" ON "opportunities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_type_entity_uq" ON "outbox_events" USING btree ("type","entity_id");--> statement-breakpoint
CREATE INDEX "outbox_status_available_idx" ON "outbox_events" USING btree ("processing_status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_mappings_provider_resource_id_uq" ON "provider_mappings" USING btree ("provider","resource_type","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_provider_event_uq" ON "webhook_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_status_idx" ON "webhook_events" USING btree ("processing_status");