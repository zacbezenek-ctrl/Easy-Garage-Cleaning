# Meta CRM conversion feedback

EGC detects `WALKTHROUGH_BOOKED` and `JOB_WON` from its normalized operational database. The existing worker reconciles every minute, independent of the five-minute GHL importer. MCP can preview, reconcile, retry and report the same durable ledger. Ordinary leads/form submissions are never emitted.

## Destination evidence (20 September 2026)

Ad account `1344010387790776` belongs to EGC business `1283578753966787`. Dataset `1262944809378035` (Easy Garage Cleaning & Junk Removal) received three server `CONVERTED` events on September 15 and is referenced by a prior QUALITY_LEAD ad set. Dataset `970332989051988` has website PageView activity and is referenced by an OFFSITE_CONVERSIONS/LEAD ad set. These independently support `1262944809378035` as the CRM destination. The current Sept 15 Offer ad set uses QUALITY_LEAD, but its promoted object did not reveal the dataset through the connector.

No Meta credentials/configuration existed in the inspected API, worker or MCP Railway variable inventories. Events Manager UI was unavailable. Before production, verify the source of the existing three CONVERTED events and the CRM funnel mapping; overlapping GHL sends must not count the same stage twice. Adding these custom event names does not automatically map them into Meta's conversion-leads funnel. Do not change the ad-set optimization target as part of activation.

## Business definitions

- One first walkthrough and one first customer conversion per internal lead. Rescheduling, repeat sync, amount changes and payload-version changes do not create another conversion. Future repeat purchases/final revenue require a separate stage/identity design.
- Walkthrough: appointment belongs to an explicitly configured walkthrough calendar, status is new/confirmed/showed, and the provider's booking-creation timestamp is known. Appointment start and firstBookedAt alone do not substitute for booking creation.
- Won: opportunity status won with a captured transition; or an actual service job in a qualifying state. Scheduled/confirmed jobs require a valid linked appointment on the configured customer-job calendar. Walkthrough-linked jobs and drafts cannot count as won. In-progress/completed service jobs can qualify with durable transition evidence.
- Value: positive reliable job/opportunity cents divided by 100, USD. Unknown/zero/invalid values omit both value and currency. Deposits are never substituted for total value. These are booked/won values, not final collected revenue.
- Initial attribution takes precedence. Facebook/Meta origin plus paid ad evidence is required. Conflicting organic/referral evidence requires review. Ad/campaign IDs prove origin; they do not match a person.
- Actual explicitly identified Meta lead IDs, fbc/fbp, normalized SHA-256 email/phone are used where present. Generic GHL IDs and attribution `mediumId` are never guessed to be Meta lead IDs. Most inspected current Facebook contacts had phone matching and no preserved Meta lead ID.

Calendar inventory verified through live GHL:

| Purpose | Calendar ID |
| --- | --- |
| EGC Customer Walkthroughs (staff scheduled) | `qsibYaxFPm16uyovdIc5` |
| EGC Customer Jobs (staff scheduled) | `KuLHTd1509oEl3KntLmF` |

## Ledger and delivery semantics

`meta_conversion_events` retains IDs, stage/time, safe attribution, destination, optional value, payload version, hashed matching payload, status, attempts, retry time, safe Meta response and timestamps. `meta_conversion_attempts` records every attempt. `meta_conversion_runs` records reconciliation outcomes. `meta_conversion_tests` is a separate synthetic-test audit. Tokens, auth headers, unfiltered provider errors and raw contact records never belong in these tables or MCP responses.

Database triggers capture new operational win transitions across existing writers without changing GHL business workflows. Historical records with unknown win times remain unknown. The worker registers the calendar IDs in `sync_cursors` so database triggers use the same explicit calendar configuration; all sender services must use identical settings. Migration runs are serialized with a PostgreSQL advisory lock.

The event ID is a deterministic SHA-256 identity from lead + stage. A primary key suppresses duplicate discoveries. Atomic committed leases protect concurrent worker/MCP senders. The exact payload freezes after the first attempt. Each HTTP request carries one event, uses a 15-second timeout, and succeeds only on an acknowledged `events_received: 1`. Unknown outcomes retry with the identical ID/name/time. Backoff ranges from 30 seconds to one hour, with at most 12 attempts. Accepted events cannot be retried through MCP.

Distributed delivery cannot guarantee exactly-once across an external network. Meta documents a 48-hour deduplication window; EGC stops all retries at 47 hours from the first attempt and flags manual review. Do not delete ledger rows or regenerate IDs to force a retry. Events older than seven days, future timestamps, changed destinations and events before the configured activation boundary are withheld. Expired records are marked skipped; timestamps are never refreshed to bypass the age limit.

## Railway configuration and activation

Use server-side variables on **egc-worker** and **egc-mcp**. Do not put the access token on the portal or in source control. Prefer Railway shared secrets referenced by these two services to avoid divergence.

```dotenv
META_CAPI_MODE=shadow
META_CAPI_DATASET_ID=1262944809378035
META_CAPI_DATASET_VERIFIED_ID=1262944809378035
META_CAPI_API_VERSION=v25.0
META_CAPI_WALKTHROUGH_CALENDAR_IDS=qsibYaxFPm16uyovdIc5
META_CAPI_JOB_CALENDAR_IDS=KuLHTd1509oEl3KntLmF
META_CAPI_FUNNEL_VERIFIED=false
# Add through Railway's secret variable UI only:
META_CAPI_ACCESS_TOKEN=
META_CAPI_TEST_EVENT_CODE=
# Set to actual activation instant, after testing, to prevent historical backfill:
META_CAPI_START_AT=
```

1. Deploy migrations, worker and MCP with `MODE=shadow`. Shadow reconciliation maintains the ledger without sending. Preview and `dryRun:true` do not write at all.
2. In Events Manager for dataset 1262944809378035, supply a Conversions API token through Railway and obtain the Test Events code. No existing Meta Ads connector credential is extracted or reused as a server token.
3. Run `meta.conversions.test`. It sends both stages with the top-level `test_event_code`, synthetic matching data, separate test IDs and a $1 synthetic job value. Confirm both are accepted and visible in Events Manager Test Events. Test records cannot suppress production events.
4. Verify CRM funnel mapping for both exact custom names and the prior CONVERTED sender. Mark `META_CAPI_FUNNEL_VERIFIED=true` only after this is verified. This gate also attests visual test confirmation.
5. Set `META_CAPI_START_AT` to the activation instant and `META_CAPI_MODE=production` on both services. Do not automatically include historical data. A prior successful test for the destination is mandatory. There is no weekly test-expiry requirement.
6. Run preview, then sync. Check accepted counts, failures and Meta diagnostics. API acceptance proves receipt, not successful person matching or attribution; Meta processing/reporting can lag.

`META_CAPI_VERIFY_ON_START=true` on MCP enables a private startup self-check using its existing server bearer. It reports safe aggregate tool/preview health in Railway logs; it adds no public diagnostic endpoint. It is optional and can be disabled after release verification.

Rollback: set `META_CAPI_MODE=shadow` on both services and redeploy. Keep the ledger intact. Never restore a database snapshot that loses accepted conversion IDs. The schema is additive and old application builds can keep running with it.

## MCP and morning brief

- `meta.conversions.preview`: read-only date/lookback inspection, per-record reasons and matching quality; no matching hashes or PII.
- `meta.conversions.sync`: defaults to dry-run. `dryRun:false` reconciles and sends only if all gates pass.
- `meta.conversions.status`: recent runs, pending/failed/accepted events, attribution and matching health, observed cohort rates, sent won value.
- `meta.conversions.retry`: defaults to dry-run, safely retries due failures/expired leases; honors backoff and gates.
- `meta.conversions.test`: privileged explicit synthetic test only; no credentials or custom payload accepted from tool inputs.

Sync/retry/test require the existing write OAuth scope. Preview/status require read scope. Status accepts a lookback up to 90 days. Sync is bounded and automatically reconciled; it is not a backfill approval mechanism.

The existing morning brief can call sync with `dryRun:false`, then status with `days:30`, and a separate status date range for the reporting day. Cohort rates use lead provider creation timestamps and distinct first stages. Missing historical transition timestamps are excluded and noted. This release does not alter the existing morning brief or any ad settings.

## Validation

Run platform typecheck/test/build and `@egc/meta-conversions test:integration` against an isolated PostgreSQL test database. The integration suite refuses non-loopback or non-test database names and intercepts every Meta HTTP request. It exercises migrations, concurrent claims, durable IDs, unknown outcomes/retries, redaction, shadow/dry-run, synthetic tests and both stages. GitHub CI runs it alongside the existing operations integration suite.

Official references: [CRM integration](https://developers.facebook.com/docs/marketing-api/conversions-api/guides/conversions-api-crm-for-platforms), [server event parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event), [customer matching](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters), [test-event body](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/main-body), [deduplication](https://www.facebook.com/business/help/823677331451951).
