CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grant_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text,
	"client_label" text NOT NULL,
	"binding_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_rate_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "principal_role" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "principal_assertion" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "principal_role" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "principal_assertion" text;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_uq" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_name_idx" ON "oauth_clients" USING btree ("client_name");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grant_requests_nonce_hash_uq" ON "oauth_grant_requests" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "oauth_grant_requests_expires_idx" ON "oauth_grant_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_rate_limit_events_bucket_idx" ON "oauth_rate_limit_events" USING btree ("bucket","occurred_at");--> statement-breakpoint
CREATE INDEX "oauth_rate_limit_events_occurred_idx" ON "oauth_rate_limit_events" USING btree ("occurred_at");