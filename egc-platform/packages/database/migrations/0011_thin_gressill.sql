CREATE TABLE "operations_service_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"nonce" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operations_service_nonces_issuer_nonce_uq" ON "operations_service_nonces" USING btree ("issuer","nonce");--> statement-breakpoint
CREATE INDEX "operations_service_nonces_expiry_idx" ON "operations_service_nonces" USING btree ("expires_at");