CREATE TABLE "ad_spend_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"account_id" text NOT NULL,
	"report_date" date NOT NULL,
	"denver_date" date NOT NULL,
	"account_time_zone" text NOT NULL,
	"level" text NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_name" text,
	"ad_set_id" text,
	"ad_set_name" text,
	"currency" text NOT NULL,
	"spend_cents" integer NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"pulled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_spend_daily_platform_ck" CHECK ("ad_spend_daily"."platform" in ('meta_ads','google_ads')),
	CONSTRAINT "ad_spend_daily_level_ck" CHECK (("ad_spend_daily"."level"='ad_set' and "ad_spend_daily"."ad_set_id" is not null) or ("ad_spend_daily"."level"='campaign' and "ad_spend_daily"."ad_set_id" is null)),
	CONSTRAINT "ad_spend_daily_amounts_ck" CHECK ("ad_spend_daily"."spend_cents">=0 and coalesce("ad_spend_daily"."impressions",0)>=0 and coalesce("ad_spend_daily"."clicks",0)>=0)
);
--> statement-breakpoint
CREATE TABLE "ad_sync_days" (
	"source" text NOT NULL,
	"account_id" text NOT NULL,
	"report_date" date NOT NULL,
	"denver_date" date NOT NULL,
	"time_zone" text NOT NULL,
	"time_zone_aligned" boolean NOT NULL,
	"currency" text,
	"total_cents" integer,
	"total_impressions" integer,
	"total_clicks" integer,
	"lead_count" integer,
	"breakdown_gap_cents" integer,
	"row_count" integer NOT NULL,
	"settled" boolean NOT NULL,
	"first_pulled_at" timestamp with time zone NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	"restated_at" timestamp with time zone,
	CONSTRAINT "ad_sync_days_pk" PRIMARY KEY("source","account_id","report_date"),
	CONSTRAINT "ad_sync_days_source_ck" CHECK ("ad_sync_days"."source" in ('meta_ads','google_ads','meta_leadgen')),
	CONSTRAINT "ad_sync_days_totals_ck" CHECK (case when "ad_sync_days"."source"='meta_leadgen' then "ad_sync_days"."lead_count">=0 and "ad_sync_days"."total_cents" is null else "ad_sync_days"."total_cents">=0 and "ad_sync_days"."currency" is not null and "ad_sync_days"."lead_count" is null end)
);
--> statement-breakpoint
CREATE TABLE "meta_leadgen_daily" (
	"page_id" text NOT NULL,
	"form_id" text NOT NULL,
	"form_name" text,
	"denver_date" date NOT NULL,
	"lead_count" integer NOT NULL,
	"lead_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "meta_leadgen_daily_pk" PRIMARY KEY("form_id","denver_date"),
	CONSTRAINT "meta_leadgen_daily_count_ck" CHECK ("meta_leadgen_daily"."lead_count">=0 and jsonb_array_length("meta_leadgen_daily"."lead_ids")="meta_leadgen_daily"."lead_count")
);
--> statement-breakpoint
CREATE TABLE "spend_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"first_date" date NOT NULL,
	"last_date" date NOT NULL,
	"receipt_reference" text NOT NULL,
	"clock_source" text DEFAULT 'attested' NOT NULL,
	"entered_by" text NOT NULL,
	"attested_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_entries_channel_ck" CHECK ("spend_entries"."channel" ~ '^[a-z][a-z0-9_]{1,39}$' and "spend_entries"."channel" not in ('meta_ads','google_ads') and "spend_entries"."channel" !~ '(^|_)(facebook|fb|instagram|insta|ig|meta|google|googleads|adwords|gads|youtube|yt)(ads?)?(_|$)|^(facebook|instagram|google|adwords|youtube)'),
	CONSTRAINT "spend_entries_amount_ck" CHECK ("spend_entries"."amount_cents">=0 and "spend_entries"."currency"='USD' and "spend_entries"."clock_source"='attested'),
	CONSTRAINT "spend_entries_period_ck" CHECK ("spend_entries"."last_date">="spend_entries"."first_date" and "spend_entries"."last_date"-"spend_entries"."first_date"<366),
	CONSTRAINT "spend_entries_status_ck" CHECK ("spend_entries"."status" in ('active','voided','superseded') and ("spend_entries"."status"='active')=("spend_entries"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "spend_entries" ADD CONSTRAINT "spend_entries_supersedes_id_spend_entries_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."spend_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_daily_row_uq" ON "ad_spend_daily" USING btree ("platform","account_id","report_date","campaign_id",coalesce("ad_set_id", ''));--> statement-breakpoint
CREATE INDEX "ad_spend_daily_denver_idx" ON "ad_spend_daily" USING btree ("denver_date","platform");--> statement-breakpoint
CREATE INDEX "ad_sync_days_denver_idx" ON "ad_sync_days" USING btree ("denver_date","source");--> statement-breakpoint
CREATE INDEX "meta_leadgen_daily_page_idx" ON "meta_leadgen_daily" USING btree ("page_id","denver_date");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_entries_request_uq" ON "spend_entries" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_entries_supersedes_uq" ON "spend_entries" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "spend_entries_period_idx" ON "spend_entries" USING btree ("workspace_id","status","first_date","last_date");--> statement-breakpoint
-- Owner spend entries are append-only evidence. The only change ever allowed is closing an
-- active entry once (voided, or superseded by its correction) with the next revision.
CREATE OR REPLACE FUNCTION egc_spend_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'spend_entry_append_only' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'active' THEN
    RAISE EXCEPTION 'spend_entry_closed' USING ERRCODE='23514';
  END IF;
  IF NEW.status NOT IN ('voided','superseded') OR NEW.revision<>OLD.revision+1 OR NEW.closed_at IS NULL OR nullif(btrim(NEW.closed_by),'') IS NULL OR
     (to_jsonb(NEW)-ARRAY['status','revision','closed_at','closed_by','close_reason','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','revision','closed_at','closed_by','close_reason','updated_at']) THEN
    RAISE EXCEPTION 'spend_entry_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS egc_spend_entries_guard ON spend_entries;
--> statement-breakpoint
CREATE TRIGGER egc_spend_entries_guard BEFORE UPDATE OR DELETE ON spend_entries FOR EACH ROW EXECUTE FUNCTION egc_spend_entry_guard();