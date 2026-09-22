# Canonical customer intelligence release

This release moves sales reporting to persisted, source-linked customer evidence. CRM fields remain provider facts; they are no longer the entire business state. Employee Hub remains the walkthrough and job authority.

## Evidence and reporting

`@egc/customer-state` reconciles messages, calls and stored transcripts, appointments, opportunities, jobs, walkthroughs, notes, exact Hub records and user-confirmed assertions. Extraction is cached by source identity, content hash and extractor version. Structured semantic extraction validates every proposed excerpt against the source and distinguishes customer commitments from voicemail, automation, proposals and conditional language. Incomplete source coverage remains visible.

The additive migration creates immutable original attribution, extracted evidence, canonical events, operational assertions and customer snapshots. Recurring communication occurrences and verified payment receipts keep separate identities. Provider mirrors share milestone identities. Assertions preserve their exact source, field, timestamp and value without replacing provider data; matching later provider evidence resolves the discrepancy. An assertion with an unknown occurrence date remains operational truth but cannot acquire a fabricated period date or Meta event time.

Reports distinguish walkthroughs, media quotes and direct jobs. Each activity counter specifies its occurrence window and evidence; each cohort metric specifies numerator, denominator, acquisition window and maturity. Sold and collected values are separate. Unknown amounts remain unknown, with a verified subtotal available separately. Historical conversion counts are distinct from the current active pipeline.

Supported MCP reads include `egc.operational_report`, `egc.customer_timeline` and `egc.customer_state_diagnostics`. Existing funnel, revenue, pipeline and customer reads expose the same canonical state. `egc.reconcile_customer_state` and `egc.record_user_confirmed_outcome` require write authorization. The Employee Hub Sales evidence view and Railway reporting pages use this shared model. Legacy recording entry links to the actual Hub.

## Booking and conversion reconciliation

Booking identity uses customer, visit kind and Denver scheduled time. The provider adapter reads before creating, re-reads an ambiguous result before retrying and binds verified records to the exact Hub visit. The repair worker discloses missing provider records, missing links, cancelled mirrors, duplicates and incomplete coverage. It never invents a booking from an ambiguous transcript.

Meta uses the supported backend service and MCP `meta.conversions.preview`, `sync`, `retry` and `status` operations. Existing deterministic lead/stage IDs are preserved. Missing canonical state, incomplete conversational extraction, unverified occurrence time, excluded contacts and do-not-contact assertions prevent sending. Original attribution and normalized/hashed matching identifiers are retained. Verified value is optional; quoted or estimated revenue is never substituted for collected cash. Durable leases, attempts and immutable first-send payloads protect retries and replay.

`META_CAPI_BACKFILL_START_AT` explicitly widens the historical boundary without relaxing provider event-age or acceptance checks. New stages are controlled by `META_CAPI_EVENT_STAGES`; Lead is supported but requires explicit configuration to avoid replaying existing form-lead ingestion. This release preserves the existing dataset and campaign mappings.

## Deployment and acceptance

Build API, MCP, worker and reporting portal with the customer-state package. Run the additive migration before readiness. Worker extraction reuses the existing configured OpenAI credential; secrets never enter source or logs. Operator-confirmed historical facts can be loaded once through `EGC_USER_CONFIRMED_BOOTSTRAP_JSON`; deterministic assertion identity makes restarts idempotent. The preferred ongoing write path is the authenticated MCP assertion tool.

Deployments must be verified by actual Git revisions and runtime reads. First reconcile in Meta shadow mode, compare every counted conversion with its original call/text or operational evidence, then enable the verified sender and inspect provider acceptance. Local tests and CI do not certify production history.

At preparation time, all four Railway services were accessible, while the signed Cloudflare Employee Hub bridge remained disabled and its portal signing key was absent from the API. The available local Cloudflare identity belongs to a different account. Code deployment cannot certify or activate that bridge without the correct existing account configuration. Preserve this distinction in diagnostics and release acceptance.

The final production comparison, accepted/rejected Meta event counts, deployed revisions and any remaining blockers belong in the operational release/status record after live verification. Private customer transcripts and the independent source audit are retained outside the repository.
