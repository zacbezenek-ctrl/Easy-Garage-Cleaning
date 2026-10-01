# Website lead intake safety

This is a local reconstruction against `cb0369bdc0cbf21bf56783857e691c7ec5ee2204`.
It does not recover the lost 15-file candidate or establish deployment, provider
workflow, emulator, browser, or physical-device acceptance.

## Intake boundary

- Both on-time and delayed intake leave pre-existing contacts' opportunities
  alone, whether open, won, lost, or abandoned. Intake never resets stage,
  amount, owner, followers, or a closed outcome
- Only a contact newly created by this receipt can receive an opportunity.
  Every status is searched first; any existing row, incomplete response or
  failed lookup prevents creation. Empty means an empty array and explicit zero
  total, not missing or unparseable metadata
- The write uses the provider's create endpoint, never upsert. A deal that races
  the lookup cannot be overwritten by this code. A create error or missing ID
  retains the receipt for retry; the retry searches before any further create
- Provider `new` must be an actual boolean, and the returned contact must have
  an explicit array of string tags. Missing/malformed identity or tags are
  `identity_unknown`, even if submitted text claims the person is a customer
- `applicant`, case-insensitive and with `-`, `_`, `:`, or space-separated
  lifecycle suffixes, is `job_applicant`. Applicant/unknown records receive no
  intake sales tags, opportunity calls, or Zapier relay. Their detail note is
  retained for review. The code does not infer identity from names or wording
- Missing HighLevel configuration also prevents the Zapier sales relay;
  receipt-enabled intake keeps the existing failure/retry behavior
- A failed website detail note cannot settle the receipt as synced. Its sealed
  payload remains retryable. The existing client-hub-help fallback to a saved
  internal comment is retained

## Safe tag method is off by default

`WEB_LEAD_SAFE_TAGS_ENABLED` is enabled only by the exact string `true`.
Unset, false, differently cased, or whitespace-padded values leave it off. Off
preserves the legacy PUT for otherwise eligible contacts; identity/opportunity
protection is always active. On uses additive POST and treats tag-write failure
as retryable, preserving unrelated lifecycle and recruiting tags.

The flag removes no consent or DND tags. Conflicting historical consent markers
must be reviewed; adding a consent marker is not an override of DND. Before any
activation, inspect all provider tag/contact/note/opportunity triggers, consent
and DND guards, and published/paused/draft workflows. Additive tags that did not
previously land can activate customer messaging. This document and a green
synthetic test do not authorize turning the flag on or enrolling contacts.

## Reviewed-send checklist

1. Open the exact contact and its current conversation, consent/DND state,
   pipeline, booking status, and prior outbound history
2. Keep explicit applicants in recruiting. For unknown identity, determine the
   correct record first; do not relabel from message wording or replay tags to
   force a sales route
3. Review the actual message, recipient and sender before a manual send. Verify
   the approved-send result/history before retrying an unknown outcome
4. For a delayed lead, check whether anyone already replied or booked it. A
   receipt marked synced proves detail delivery, not workflow completion or
   permission for another text

## Known limits and release checks

- Existing contact upsert and detail-note calls remain and can themselves invoke
  external workflows. This code cannot guarantee those workflows are silent
- Verify the real upsert response includes authoritative tags and `new`. Missing
  tags deliberately hold routing; the code does not guess or make extra reads
- Provider duplicate-creation settings and idempotency semantics require an
  approved synthetic integration check. Create-only protects worked state;
  this is not a claim of exactly-once opportunity creation across provider races
- The inquiry receipt/event is written before identity is known. Existing
  downstream applicant classification must still reconcile the actual contact;
  this patch does not backfill projections or repair historical sales queues
- Existing receipts, sealing, create-only commits, retry budget, quiet hours,
  claim expiry, backoff and payload retention remain. No migration is required
- Keep the safe-tags flag off pending the workflow audit. No live provider,
  queue, customer, credential, permission, deployment or message changes were
  performed as part of this reconstruction

## API contracts

Verified against the official v3 documentation:

- [Create Opportunity](https://marketplace.gohighlevel.com/docs/ghl/opportunities/create-opportunity/index.html): POST `/opportunities/`
- [Add Tags](https://marketplace.gohighlevel.com/docs/ghl/contacts/add-tags/index.html): POST `/contacts/:contactId/tags`
- [Upsert Contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/index.html): boolean `new` distinguishes created versus existing contacts

## Local regression

Run `node --test tests/web-lead-intake.test.mjs tests/booking-slots-flag-off.test.mjs tests/sales-booking.test.mjs tests/funnel-calendar.test.mjs tests/operations-suite.test.mjs tests/messaging-cron.test.mjs tests/automation-registry.test.mjs` and the full `npm test` regression.
The historical BOOK-25 snapshot is left unchanged. Its test applies only the
explicit expected opportunity search/create API migration, while still checking
all original booking values, relay payloads, notes and receipt bytes.
