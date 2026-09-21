CREATE TABLE "meta_conversion_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'unknown' NOT NULL,
	"response" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "meta_conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"appointment_id" uuid,
	"job_id" uuid,
	"opportunity_id" uuid,
	"event_type" text NOT NULL,
	"event_time" timestamp with time zone,
	"dataset_id" text NOT NULL,
	"attribution" jsonb NOT NULL,
	"value_cents" integer,
	"currency" text,
	"payload_version" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_token" text,
	"response" jsonb,
	"error" text,
	"retryable" boolean DEFAULT true NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_conversion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "meta_conversion_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"accepted" boolean NOT NULL,
	"response" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "won_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "won_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_conversion_attempts" ADD CONSTRAINT "meta_conversion_attempts_event_id_meta_conversion_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."meta_conversion_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversion_attempt_number_uq" ON "meta_conversion_attempts" USING btree ("event_id","attempt_number");--> statement-breakpoint
CREATE INDEX "meta_conversion_events_status_idx" ON "meta_conversion_events" USING btree ("status","next_attempt_at");
--> statement-breakpoint
-- Capture new operational transitions at the database boundary so every existing
-- API/MCP/worker write path participates. Never manufacture dates for old rows.
CREATE FUNCTION egc_capture_opportunity_win() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.won_at := OLD.won_at;
    IF NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won' AND OLD.won_at IS NULL THEN
      NEW.won_at := COALESCE(NEW.provider_updated_at, CURRENT_TIMESTAMP);
    END IF;
  ELSE
    -- An imported already-won row has no observed transition. Creation time is
    -- not win time, even when the import happens shortly after creation.
    -- Only the trusted local create-won operation supplies won_at explicitly.
    -- The GHL importer never supplies it for historical rows.
    IF NEW.status IS DISTINCT FROM 'won' THEN NEW.won_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER egc_opportunity_win BEFORE INSERT OR UPDATE ON opportunities
FOR EACH ROW EXECUTE FUNCTION egc_capture_opportunity_win();
--> statement-breakpoint
CREATE FUNCTION egc_job_conversion_qualified(
  job_status text, job_contact_id uuid, job_appointment_id uuid,
  job_service_type text, job_scheduled_at timestamp with time zone
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  appointment_calendar_id text;
  appointment_status text;
  job_calendars jsonb := '[]'::jsonb;
  walkthrough_calendars jsonb := '[]'::jsonb;
BEGIN
  IF job_status NOT IN ('scheduled','confirmed','in_progress','completed') OR
    COALESCE(job_service_type, '') ~* 'walk[[:space:]]*through|estimate|consultation' THEN
    RETURN false;
  END IF;

  -- The conversion reconciler publishes server-verified allowlists here. These
  -- are calendar IDs, never credentials, and are shared across all write paths.
  BEGIN
    SELECT cursor::jsonb INTO job_calendars FROM sync_cursors
      WHERE key = 'meta.conversions.job_calendar_ids';
    SELECT cursor::jsonb INTO walkthrough_calendars FROM sync_cursors
      WHERE key = 'meta.conversions.walkthrough_calendar_ids';
  EXCEPTION WHEN invalid_text_representation THEN
    -- A malformed configuration must not break an existing operational write.
    RETURN false;
  END;
  IF jsonb_typeof(job_calendars) IS DISTINCT FROM 'array' THEN job_calendars := '[]'::jsonb; END IF;
  IF jsonb_typeof(walkthrough_calendars) IS DISTINCT FROM 'array' THEN walkthrough_calendars := '[]'::jsonb; END IF;

  SELECT calendar_id, status::text INTO appointment_calendar_id, appointment_status
    FROM appointments WHERE id = job_appointment_id AND contact_id = job_contact_id;
  IF appointment_calendar_id IS NOT NULL AND walkthrough_calendars ? appointment_calendar_id THEN RETURN false; END IF;
  IF job_status IN ('in_progress','completed') THEN RETURN true; END IF;
  RETURN job_scheduled_at IS NOT NULL AND appointment_calendar_id IS NOT NULL
    AND job_calendars ? appointment_calendar_id
    AND appointment_status IN ('new','confirmed','showed');
END $$;
--> statement-breakpoint
CREATE FUNCTION egc_capture_job_win() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.won_at := OLD.won_at;
    IF OLD.won_at IS NULL
      AND egc_job_conversion_qualified(NEW.status, NEW.contact_id, NEW.appointment_id, NEW.service_type, NEW.scheduled_at)
      AND NOT egc_job_conversion_qualified(OLD.status, OLD.contact_id, OLD.appointment_id, OLD.service_type, OLD.scheduled_at) THEN
      NEW.won_at := CURRENT_TIMESTAMP;
    END IF;
  ELSIF egc_job_conversion_qualified(NEW.status, NEW.contact_id, NEW.appointment_id, NEW.service_type, NEW.scheduled_at) THEN
    NEW.won_at := CURRENT_TIMESTAMP;
  ELSE
    NEW.won_at := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER egc_job_win BEFORE INSERT OR UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION egc_capture_job_win();
--> statement-breakpoint
ALTER TABLE meta_conversion_events ADD CONSTRAINT meta_conversion_status_check
CHECK (status IN ('pending','processing','accepted','failed','skipped'));
--> statement-breakpoint
ALTER TABLE meta_conversion_events ADD CONSTRAINT meta_conversion_attempts_check CHECK (attempt_count >= 0);
