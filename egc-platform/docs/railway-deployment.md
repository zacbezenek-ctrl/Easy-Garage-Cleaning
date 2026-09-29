# Railway production deployment

This runbook deploys the EGC operational platform as four services plus managed Postgres.

## Services

Create one Railway project with:

- `egc-postgres` — managed PostgreSQL.
- `egc-worker` — background GHL reconciliation, transcript synchronization, webhook repair, outbox write-back, and database migrations.
- `egc-api` — verified GHL webhook receiver, canonical operations service, recording processor and inbound-reply reconciliation.
- `egc-mcp` — OAuth-protected, scoped and audited read/write tools for ChatGPT.
- `egc-portal` — legacy authenticated platform views. The existing Cloudflare Employee Hub remains the operational schedule, customer, project and job authority.

Redis is not required by the current V1 worker.

## Repository source

Use the GitHub repository:

`zacbezenek-ctrl/Easy-Garage-Cleaning`

Deploy the reviewed and merged `main` commit. Verify the actual deployment's commit hash; a redeploy of an old deployment can reuse its old source snapshot.

With the connected Railway tools, update each existing service's `EGC_RELEASE_SHA` to the merged commit using `set_variables` with `skipDeploys:false`. This triggers a new source deployment from the configured branch. Confirm `list_deployments.meta.commitHash` equals the intended commit before proceeding; the environment variable alone is not proof. This path deployed commit `153fb907ae2b483c5ffc4f52f77567223b219562` on September 22 after the generic `redeploy` action reused the previous source snapshot. Do not create replacement services to work around source selection.

All application services use repository root `/` as the build context, with watch path `/egc-platform/**`.

Set the custom Dockerfile paths:

| Service | Dockerfile |
| --- | --- |
| egc-api | `/egc-platform/infra/docker/Dockerfile.api` |
| egc-mcp | `/egc-platform/infra/docker/Dockerfile.mcp` |
| egc-worker | `/egc-platform/infra/docker/Dockerfile.worker` |
| egc-portal | `/egc-platform/infra/docker/Dockerfile.portal` |

Railway injects `PORT`; the API, MCP, and portal honor it automatically.

## Networking

Generate public HTTPS domains for:

- `egc-mcp` — required for ChatGPT.
- `egc-api` — required for GHL webhooks and voice walkthrough proxy traffic if the portal cannot use private networking.
- `egc-portal` — internal staff access.

The worker requires no public domain.

Use private networking from portal to API when possible. Set `API_URL` to the API service's Railway private URL.

## Postgres

Attach the managed Postgres `DATABASE_URL` to all four application services.

The worker runs checked-in Drizzle migrations before starting. API and MCP use pre-deploy command `pnpm --filter @egc/database migrate:runtime`. The migrator serializes concurrent migration runners with a PostgreSQL advisory lock. API and MCP readiness checks also verify the communication ledger; HTTP 200 alone is not functional acceptance.

## Persistent audio

For V1, attach a persistent Railway volume to `egc-api` at:

`/data/egc`

Set:

```
STORAGE_DRIVER=filesystem
STORAGE_PATH=/data/egc
```

R2/S3 can replace this later without changing the walkthrough database model.

## Shared / service variables

Never commit secret values.

### All DB-backed services

```
NODE_ENV=production
DATABASE_URL=<Railway Postgres reference>
```

### egc-worker

```
GHL_LOCATION_ID=<EGC GHL location>
GHL_PRIVATE_INTEGRATION_TOKEN=<private integration token>
GHL_WRITEBACK_ENABLED=true
```

The OAuth client secret is not required for the private-integration-token sync path. Keep it available only if/when the deployment switches to GHL OAuth.

The signed messaging cron is off unless `EGC_MESSAGING_CRON_ENABLED=true` (`EGC_MESSAGING_CRON_DRY_RUN=true` asks the Hub for dry runs only). It then also needs `API_BEARER_TOKEN=<same value as egc-api>` to sign its `/api/messaging-cron` requests. That value is the API's root service-signing secret: whoever holds it can sign any API-to-Hub service request, for any actor and path, not only the cron. Setting it on the worker extends that trust to the worker process. The Hub runs the messaging schedule only for the `messaging-cron-worker` integration actor on `/api/messaging-cron`, but its other service endpoints cannot tell which process signed. Leave the cron off, and the secret unset on the worker, until that trade-off is accepted. A purpose-scoped worker signing key is a planned follow-up.

### egc-api

```
API_BEARER_TOKEN=<random 32+ byte value>
OPENAI_API_KEY=<OpenAI API key>
GHL_LOCATION_ID=<EGC location>
GHL_PRIVATE_INTEGRATION_TOKEN=<existing private integration token>
STORAGE_DRIVER=filesystem
STORAGE_PATH=/data/egc
```

### egc-mcp

```
MCP_PUBLIC_ORIGIN=https://<egc-mcp-public-domain>
MCP_ALLOWED_HOSTS=<egc-mcp-hostname>
MCP_OAUTH_USER=<private EGC admin username>
MCP_OAUTH_PASSWORD=<random 20+ character password>
```

`MCP_BEARER_TOKEN` is optional and should only be set for internal diagnostic clients. ChatGPT uses OAuth. It is read-only; set `MCP_BEARER_WRITE_ENABLED=true` only while a startup verification that writes is running (`EGC_OPERATIONS_CANARY_ON_START`, `META_CAPI_VERIFY_ON_START` with its dry-run sync, `META_CAPI_TEST_ON_START`), then remove it. Without it the Meta verification skips its write-scoped checks and logs `bearer_write_disabled`.

With `EGC_OPERATIONS_ENABLED=true`, one-step MCP customer sends (`conversations.send_message`, `send_sms`, `egc.send_followup`) are paused and refused unless `EGC_MCP_DIRECT_SENDS_ENABLED=true`. Drafts queued with `actions.propose` (kind `followup_message`) can be approved by an owner or manager in the Employee Hub, but approval does not send. Sending an approved draft needs the Hub one-tap send (Phase 3) or MCP two-step confirmation (Phase 6), and neither is enabled yet. Until one ships, approved follow-up drafts have no send or completion path and can only be cancelled, unless you set `EGC_MCP_DIRECT_SENDS_ENABLED=true` to let ChatGPT send one-step messages again (with the recipient and do-not-contact checks, and `actions.complete_from_message` for completion).

### egc-portal

```
API_URL=<egc-api private or public origin>
API_BEARER_TOKEN=<same value as egc-api>
PORTAL_BASIC_USER=<private staff username>
PORTAL_BASIC_PASSWORD=<random strong password>
```

## Health checks

Configure:

- egc-api: `/health`
- egc-mcp: `/health`
- egc-portal: `/api/health`

The worker is a background process and should use process/restart monitoring instead of HTTP health checks.

## Initial validation

After the worker is live:

1. Verify the migration runner exits successfully and the worker remains running.
2. Verify contacts begin appearing in Postgres.
3. Verify conversations/messages, opportunities, appointments, and calls reconcile.
4. Verify a recent call transcript appears in `call_transcripts`.
5. Open the portal and confirm lead/customer/pipeline pages render live records.
6. Check `https://<mcp-host>/.well-known/oauth-protected-resource`.
7. Check `https://<mcp-host>/.well-known/oauth-authorization-server`.
8. Check `https://<mcp-host>/health` returns HTTP 200.
9. Connect the MCP in ChatGPT and complete the OAuth login.
10. Run the EGC three-day lead audit acceptance prompt.

## GHL webhook

Configure GHL to send supported webhook events to:

`https://<egc-api-host>/webhooks/ghl`

The receiver verifies the GHL Ed25519 signature. Webhooks provide low latency; the five-minute worker reconciliation remains the repair/fallback path.

Register subscriptions in the authenticated HighLevel Marketplace app configuration. A private integration token alone does not register webhooks. The receiver rejects missing/invalid signatures and other locations before queuing, persists duplicate-safe receipts, and returns a retryable failure if persistence fails. Unsupported/deletion payloads remain visible for review instead of silently deleting operational history.

## Employee Hub activation

Deploy the root site and Pages Functions to the existing Cloudflare Pages project. Keep `EGC_OPERATIONS_ENABLED=false` until both sides of the signed bridge are deployed and verified. Existing Meta variables and behavior are independent; do not alter them as part of this release.

| Variable | Services |
| --- | --- |
| `EGC_OPERATIONS_WORKSPACE=egc` | API, MCP, Cloudflare |
| `EGC_OPERATIONS_ENABLED=true` | API, MCP, Cloudflare and legacy Railway portal, after bridge verification |
| `EGC_OPERATIONS_API_ORIGIN` | MCP and Cloudflare; existing API HTTPS origin |
| `EGC_PORTAL_ORIGIN` | API; existing Employee Hub HTTPS origin |
| `EGC_OPERATIONS_MCP_SIGNING_SECRET` | Identical strong server-only secret on API and MCP |
| `EGC_OPERATIONS_PORTAL_SIGNING_SECRET` | Identical strong server-only secret on API and Cloudflare |
| `GHL_WALKTHROUGH_CALENDAR_ID`, `GHL_JOBS_CALENDAR_ID` | API; verified existing provider calendars |

Use distinct cryptographically random signing keys. Never put keys in browser code, requests shown to users, logs or Git. Hub requests carry the authenticated user's actual role; MCP requests carry the verified integration principal. Human recording/draft approvals require a real signed-in Hub owner or manager.

The server-driven schedule mirror is off unless `EGC_SCHEDULE_SYNC_WORKER=true` is set on BOTH egc-api and Cloudflare Pages, and it needs the `jobs` (`providerSyncOwner`, `syncStatus`) composite index from `firestore.indexes.json` (`firebase deploy --only firestore:indexes`); without the index `schedule.sync_due` fails closed and page loads keep retrying. Every 2 minutes the API then asks the Hub for at most 25 due operations-owned visits (`schedule.sync_due`, oldest dispatch change first; pending, error, or a manual page retry left `syncing` for 10 minutes), runs the existing `schedule.sync_provider` for each with automations off (a calendar mirror, never a customer message) under the visit's own mirror key (`<sync key>:mirror`), and hands failures back to the Hub (`schedule.sync_failed`), which sets `syncStatus: error` with a 10, 20, 40 … 1280 minute backoff. Provider keys never collide: each Hub schedule change stores its own sync key (`schedule-mutate:<requestId>` for a bridge or MCP change, the dispatch request id for a dispatch change), the page's sync and its Retry buttons use that key with automations on, MCP `egc.schedule_visit` syncs under its own requestId, and the loop appends `:mirror`. The loop counts its own failures per key (`syncWorkerAttempts`, apart from the page's `syncAttempts`). After 8 of them on one key, or at once when the appointment ledger refuses the key outright (`appointment_idempotency_payload_conflict`, `appointment_changed_since_acceptance`: no retry under that key can succeed), the loop parks the visit (`syncReviewRequired`). A parked visit shows "Sync needs review" in the Hub whoever failed last; a manager's Retry or Retry all clears `syncFailureKey` and `syncReviewRequired`, so the loop picks the visit up again with a fresh budget once the page's own backoff has passed, and a new schedule change (a new key) is never held back by an old park. Only the `schedule-sync-worker` principal may call either command, and only from inside egc-api: `/operations/rpc` refuses both (`schedule_sync_queue_internal_only`) whatever actor a signed envelope claims. Each `schedule.sync_due` is the loop's check-in (`scheduleSyncState/worker`); manager page loads stop auto-retrying those visits only while the Hub flag is on AND the loop checked in within 10 minutes, so a stopped or misconfigured API loop hands the retries back to the page on its own, and the page then ignores the loop's backoff. The Retry buttons stay available in every mode, and visits without a CRM contact, with walkthrough-handoff CRM steps still pending, or cancelled before any booking stay with the page. A mirror replayed after a page error write puts the visit back to `synced` instead of looping. If a sync that resolved an older schedule writes HighLevel after a newer change was already mirrored, the Hub refuses that bind, puts the visit back to `pending` under a fresh drift key, and the next tick (or page retry) re-mirrors the Hub schedule. The stale write can also bind while the visit is still `pending` (before the newer sync binds), which the Hub cannot tell from a normal refusal; so with `EGC_SCHEDULE_SYNC_WORKER=true` on egc-api every `schedule.sync_provider` there (page, MCP or loop) reads the appointment back after binding, and if it no longer holds the bound time it re-queues the visit the same way (logged as `schedule.provider.drift`) and answers `schedule_provider_drift`, which the loop counts in `stateConflicts`. Flag off, there is no extra read. In every mode the page's own `synced` write after a sync is conditional: it is skipped when a drift re-queue (`pending` with `syncError: schedule_provider_drift`) landed while that sync ran, so it can never mark a visit synced over HighLevel's stale time. Tick results are in `sync_cursors` (`schedule_sync:last_result`, `schedule_sync:last_success`): this tick's counts (including `stateConflicts`, whether the check-in was recorded and whether the scan covered every queued row) and the Hub's backlog (owned, backing off, parked, oldest failure in minutes). The API logs one error line when the scan was capped, every selected sync failed, HighLevel drifted from the Hub, or visits are parked. Turning the Hub flag off mid-tick stops the tick at its next recorded failure (`schedule.sync_provider` does not read the flag, so selected visits that sync cleanly before then still sync, under the mirror key with automations off). Turn on the API side first, then the Hub; turn off the Hub first.

After activation, the API independently processes unanswered replies every minute. It uses an explicitly configured verified owner or the sole authoritative Hub owner; unresolved ownership remains an exception. Automatic reconciliation begins at durable activation, with explicit bounded historical reconciliation available through MCP. Shared appointment and note ledgers protect native Hub and MCP retries. Unknown provider outcomes require verification, never a blind replacement.

Temporarily set `EGC_OPERATIONS_VERIFY_ON_START=true` on MCP to verify authenticated loopback discovery and an existing read without exposing tokens. With the bridge enabled, `EGC_OPERATIONS_CANARY_ON_START=true` additionally creates and completes one clearly labeled, unlinked internal task per release. It sends no customer communication and makes no provider booking. Inspect the allowlisted `operations_startup_verification` log, then remove the temporary flags.

Complete the [production acceptance matrix](../../docs/operations-production-acceptance.md). Keep blocked live scenarios explicit; isolated tests do not certify live recordings, webhook subscriptions, payment evidence or Hub deployment.
