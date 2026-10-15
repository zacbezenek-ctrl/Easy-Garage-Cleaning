# Knock native GHL intake foundation

This integration is **disabled by default**. This change does not write production settings, create forms, change workflows, add credentials/scopes, send live provider requests, approve compensation, merge, or deploy. The existing website form and retired `/api/lead-intake` are unchanged.

The separate template worker's proposed canonical mapping and exact missing links are in [knock-template-mapping.md](knock-template-mapping.md). Form values never become final quote prices or accepted legal terms; no document sender is part of this foundation.

## Entry paths and evidence boundaries

The crew app's **GHL quote / walkthrough request** opens two separate actions:

- **Quote / direct sale** uses the signed-in rep's saved Look/quote or existing direct sale.
- **Request a walkthrough** uses the rep's saved Look. It never calls `startSale`, logs Sold, creates a `knock_sale`, records setter attribution, or earns the direct-sale rate. Existing direct sales and conflicting house/channel/rep claims block this path for review.

The original offline sale flow is preserved. A pending or rejected local event must sync successfully before native intake opens. Offline attempts show **not sent to GHL** and make no native-form request. There is no background provider-submission retry. Reopening uses the same server reference; it does not assert whether the customer already submitted.

The source is an authenticated, active rep's canonical `knock_events` Look (including its effective edit/void history) or `knock_sales` record. Creation checks current territory, house exclusions and revision. The handoff stores a SHA-256 source revision, channel, house, authenticated rep, exact form mapping, creation time and 24-hour expiry. A 128-bit random `kf_…` reference is the only value added to the form URL. Customer information, price, address, source IDs, revision hashes and rep IDs never appear in that URL. Hidden rep fields, prices and client claims are not attribution authority. The ordinary sale sync also refuses Sold/direct-sale events on houses claimed for walkthrough requests, and open/verify recheck for later direct-sale conflicts.

The app displays Hub saved, submission verified, contact linked, job/walkthrough linked, collection and commission separately. Local-only saved records are described separately before opening. An iframe load, redirect, timeout, or message is never submission evidence. The frame sends no referrer and offers an explicit retry plus receipt check. A submission receipt does not create a job, sign a contract, collect money, classify commission scope, or make a payout payable. Existing direct-sale snapshots and junk exclusions remain authoritative and unchanged. Existing setter reconciliation still requires a canonical walkthrough and its conversion/collection evidence.

## Configuration still required

The owner-supplied draft form and field inventory is preserved in [`config/knock-native-forms.disabled.json`](../config/knock-native-forms.disabled.json). This is an inert review manifest, not imported runtime configuration or a Firestore seed. It contains the real draft ID `t7xlEHRoJsl2DNBrub1A`, reference field `d7ChXmwhqPhCSgF1l2Jz`, and the reported field keys. `enabled` remains false, `referenceQueryKey` and acceptance are null, and no provider-prefill behavior is assumed from a suffix/key.

The supplied draft is **one shared form** with Direct D2D quote / Walkthrough request choices. The current runtime requires distinct allowlisted forms for the two entry paths, so walkthrough mapping stays null. Either a second verified form or a separately reviewed shared-form design is needed; an editable channel choice must never override the server-bound handoff channel. No Facebook-direct option exists yet. `W19` identity is unknown and has no mapping. Email is optional on the draft but remains required for a direct contract; informational amount/quote/rep fields and preferred time are not price, attribution, schedule or legal authority. Optional SMS consent is reported as unchecked and does not itself send a message.

An authorized operator must separately review the exact stored configuration in server-only `knock_settings/native_forms`. There is no new settings-writing API or automatic migration. Until both dedicated forms and their acceptance records pass the checks, all form launches and receipt verification remain blocked.

Required document shape (empty values deliberately keep this disabled):

```json
{
  "enabled": false,
  "locationId": "",
  "forms": {
    "direct_sale": {
      "formId": "",
      "url": "",
      "referenceFieldId": "",
      "referenceQueryKey": "",
      "acceptance": {}
    },
    "walkthrough_request": {
      "formId": "",
      "url": "",
      "referenceFieldId": "",
      "referenceQueryKey": "",
      "acceptance": {}
    }
  }
}
```

For **each** form, the acceptance object must repeat its exact `formId`, `url`, `referenceFieldId`, `referenceQueryKey` and `locationId`, with `prefillVerified: true`, `submissionReadVerified: true`, `formsReadonlyVerified: true`, `verifiedAt`, `verifiedBy` and a nonempty `evidence` reference. Future timestamps are refused. The two form IDs must differ; the existing website form is explicitly refused. URLs must be HTTPS with exact `/widget/form/<formId>` path, no query/hash/credentials/port, and the exact host `api.leadconnectorhq.com` or `links.easygaragecleaning.com`. A new branded host requires independent review and an explicit allowlist change on both client and server.

Acceptance must demonstrate all of the following with those actual forms before anyone enables the document:

1. The configured query key prefills **only** the opaque reference field in the real native form. No PII or price is placed in the URL. Verify on mobile, with existing GHL contact state, and after reopening.
2. A real test submission appears in `GET /forms/submissions` with the exact `formId`, submission ID, contact ID, timestamp and the reference at `others[referenceFieldId]` as a scalar string. This implementation intentionally rejects any different or ambiguous reference shape. If the actual field shape differs, update and test the adapter first.
3. The **existing** server integration has working `forms.readonly` and its existing contact-read access. No credentials or scopes were created by this change. A missing scope/403 remains a blocker; do not enable based on a checkbox alone.
4. The contact read returns the same exact contact and configured location. For a saved direct sale, its normalized phone and email must also match the saved customer. For a Look without customer details, the contact association proves only the provider's exact submission/reference relationship; it does not independently prove customer identity or consent.
5. Confirm native-form behavior does not run unapproved workflows, contracts, texts, appointments, payments or financial actions. This code never activates those behaviors. Review native form/workflow configuration separately before allowing any real customer submission.
6. Perform independent code and acceptance review. Do not merge/deploy or enable this foundation merely because synthetic unit tests pass.

## Receipt API and operational limits

All calls require an authenticated active Knock rep; POST uses the existing same-origin JSON guard. Foreign sources, references and receipt replays are refused even for another authenticated rep. Business users do not get an ownership bypass.

- `GET /api/knock-form-handoff` returns setup blockers. Adding `?houseId=<opaque-house-id>` returns only that rep's available source revisions and handoff views within assigned territory.
- `POST {action:"create", houseId, channel, source:{kind,id,revision}}` makes one create-only handoff for that exact rep/channel/source revision. Equivalent retries return the same reference. Cross-channel/rep house claims require manual reconciliation, including legitimate later changes in sales approach; this foundation provides no automatic reassignment.
- `POST {action:"open", reference}` revalidates source, territory, expiry and the full accepted mapping before returning a launch URL.
- `POST {action:"verify", reference, contactId, submissionId}` checks exact IDs from GHL, not iframe messages or client-supplied fields. The current staff UI asks for these two exact provider IDs; automatic receipt discovery is **not implemented**.

The provider adapter performs GETs only, with a 10-second timeout, redirects refused, and a 100-row first-page search limited to the handoff date window. `q` is broad, so only exact form/contact/submission IDs can select evidence. If the exact row is not on that page, verification fails closed; operator pagination/discovery is a later task, not a successful submission. Provider timestamps must fall after handoff creation, before expiry, and no later than server verification time.

Two atomic create-only receipts claim the provider submission (location + submission ID across all forms/reps) and the handoff reference. Equivalent duplicate checks return the same evidence. Mismatched contact, form, location, time, reference, source revision, or a second submission for that reference is refused. Internal version guards use a real Firestore read/write transaction with transactional `batchGet` and a mutation-only commit, without mutating canonical source records. `knock_form_revisions/<houseId>` is changed atomically by ordinary Knock sync whenever it accepts house events, before its separate summary rebuild. The receipt transaction reads that fence (or its absence), so a concurrent new edit/void cannot slip past an old source revision. This also means any later house event requires reloading/reconciling the source. These internal local storage fences exist even while GHL is disabled; they never trigger a provider call. Raw provider payloads, tokens and contact PII are not stored in the receipts or sent back to the browser. Reads and receipt writes do not modify the sale, source event, financial settings, jobs or `knock_setters`.

Expired references and changed mappings/sources require reconciliation; they cannot be silently reused or renewed. A stored receipt remains historical evidence, never financial authorization. `knock_form_handoffs` and existing receipt collections deny direct client SDK access.

## Validation

Run `node --test --test-isolation=none tests/knock-*.test.mjs tests/booking-highlevel.test.mjs`. Synthetic coverage includes foreign reps, tampered hidden fields, missing configuration, duplicate and concurrent receipts, stale/voided revisions, iframe false positives, offline/retry behavior, direct/setter conflicts, junk exclusion, no commission on submission, exact contact checks, provider GET-only behavior and PII-free launch URLs. Local isolation is disabled because this Windows sandbox blocks Node child-process spawning; CI should retain its normal setup.
