CREATE TABLE "communication_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"provider_message_id" text,
	"response" jsonb,
	"last_error" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "communication_executions" ADD CONSTRAINT "communication_executions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "communication_executions_request_uq" ON "communication_executions" USING btree ("actor_id","request_id");--> statement-breakpoint
CREATE INDEX "communication_executions_contact_idx" ON "communication_executions" USING btree ("contact_id","created_at");