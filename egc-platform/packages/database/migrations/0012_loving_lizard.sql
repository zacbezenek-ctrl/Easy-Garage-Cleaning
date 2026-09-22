CREATE TABLE "customer_occurrence_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"occurrence_id" text NOT NULL,
	"namespace" text NOT NULL,
	"record_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_occurrence_links" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"from_occurrence_id" text NOT NULL,
	"to_occurrence_id" text NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"kind" text NOT NULL,
	"original_source_type" text NOT NULL,
	"original_source_record_id" text NOT NULL,
	"authoritative_portal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"merged_into_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_events" ADD COLUMN "occurrence_id" text;--> statement-breakpoint
ALTER TABLE "customer_occurrence_aliases" ADD CONSTRAINT "customer_occurrence_aliases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrence_aliases" ADD CONSTRAINT "customer_occurrence_aliases_occurrence_id_customer_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."customer_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrence_links" ADD CONSTRAINT "customer_occurrence_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrence_links" ADD CONSTRAINT "customer_occurrence_links_from_occurrence_id_customer_occurrences_id_fk" FOREIGN KEY ("from_occurrence_id") REFERENCES "public"."customer_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrence_links" ADD CONSTRAINT "customer_occurrence_links_to_occurrence_id_customer_occurrences_id_fk" FOREIGN KEY ("to_occurrence_id") REFERENCES "public"."customer_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrences" ADD CONSTRAINT "customer_occurrences_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_occurrences" ADD CONSTRAINT "customer_occurrences_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_occurrence_alias_identity_uq" ON "customer_occurrence_aliases" USING btree ("namespace","record_id","kind");--> statement-breakpoint
CREATE INDEX "customer_occurrence_alias_contact_idx" ON "customer_occurrence_aliases" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "customer_occurrence_links_contact_idx" ON "customer_occurrence_links" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "customer_occurrences_contact_idx" ON "customer_occurrences" USING btree ("contact_id","kind");--> statement-breakpoint
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_occurrence_id_customer_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."customer_occurrences"("id") ON DELETE set null ON UPDATE no action;