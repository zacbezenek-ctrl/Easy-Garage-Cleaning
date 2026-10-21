# Accepted quote portal invitations

New staff-recorded approvals and signed walkthrough saves request a private client portal invitation. The HighLevel server handoff reads the saved job and sends it automatically. Staff can see the invitation status and retry a definite failure in **Estimates & payments**.

- Delivery uses the saved customer's phone via HighLevel SMS, or email when there is no valid phone number. The linked contact's identity and location must match the saved job.
- Job notifications and HighLevel DND are respected. Existing accepted jobs are not bulk enrolled; only new approval requests are eligible automatically.
- Jobs linked to a business account are never sent a homeowner invitation. The ledger records `suppressed` with reason `business_account_job` before any HighLevel call. A link added while the contact is being checked still records the suppression before any message is claimed, and the job is re-read after the claim: a link or notification opt-out saved in between releases the claim as `suppressed`, and a job that cannot be re-read releases it as a retryable `storage_unavailable`, before HighLevel is called. The company's members open the project from the Business Hub (see `docs/business-client-hub.md`).
- The private link lasts 30 days. The portal session lasts seven days. Tokens are never saved in staff-readable job documents or returned from the invitation endpoint.
- A conditional storage claim in the server-only `portal_invitations` collection limits sending to one invitation per job. The job contains a display copy only; stale scheduling edits, repeated saves, and concurrent requests do not resend a submitted message.
- `submitted` means HighLevel accepted the message; it does not prove carrier or inbox delivery. Check the HighLevel conversation for final delivery.
- Definite rejection can be retried. A timeout, server error, or lost delivery-status write is marked uncertain and never automatically resent. Check HighLevel before manually sharing a fresh link.
- The Hub retries newly requested, definitely unsent invitations when a manager loads or refreshes the Hub, with a ten-minute interval and a five-attempt limit, while server messaging (`EGC_SERVER_MESSAGING_ENABLED`) is off; once it is on, the signed messaging cron runs the same retry instead. The initial send happens on the acceptance request itself. For a quote author's signed walkthrough (not a manager), that request is the walkthrough's pending HighLevel sync, which a manager's Hub page runs on load (up to three jobs per load, with backoff) whether or not server messaging is on.
- **Quiet hours.** Every automatic send (the approval and walkthrough HighLevel sync, the Hub's page-load retry and the cron) follows the project's existing rule for automatic customer messages: only between 08:00 and 20:00 Denver time (`QUIET_HOURS` in `functions/_lib/message-policies.js`). Outside it the ledger records `deferred` with reason `quiet_hours` and `notBefore` (the next 8:00 AM), spends no attempt, and the next automatic retry after that time sends it. The Hub shows **Portal invitation waits for 8 AM (quiet hours)**.
- **Messaging pause.** While the owner's `messaging_settings/automation` record has `paused: true` (or cannot be interpreted), automatic sends record `deferred` with reason `messaging_paused` (or `messaging_settings_invalid`) and wait. If the record cannot be read at all, nothing is sent or recorded.
- Only a manager's own **Retry portal delivery** / **Send portal now** click (`manual: true`) sends during quiet hours or the pause. `EGC_MESSAGING_ENABLED` and `EGC_MESSAGING_DRY_RUN` (the quote builder's "Customer messaging is turned off") do not govern this invitation; removing `HIGHLEVEL_API_KEY`, setting the pause, or turning job notifications off are what stop it.
- A closed job (status or pipeline stage cancelled, canceled, no-show, completed, invoiced, paid, review requested, closed or superseded) is never told its quote is approved, by any sender. The Hub shows **Portal not sent · job is closed** and offers no retry.

## Required production configuration

Existing Cloudflare Pages production secrets must include:

- `HUB_SESSION_SECRET`: dedicated random staff/session signing secret (also signs portal links unless `CUSTOMER_PORTAL_SECRET` is provided).
- `HUB_AUTH_USERS_JSON`: configured staff accounts with generated PBKDF2 password hashes. This is required for authorized Hub operations; do not restore legacy embedded credentials.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: credentials for project `egcw-1ec83`, with the Firestore access needed to read jobs and write delivery metadata. Keep the JSON encrypted in Cloudflare, outside the repository.
- `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID`: contact read/upsert and conversation-message write access; an operational SMS/email sender in the existing account.

The full owner checklist for customer messaging (HighLevel scopes, A2P 10DLC, sender number and email domain, workflows to adjust per message kind, the inbound reply webhook, template approval and a dry-run acceptance pass) is in [Customer messaging owner setup](messaging-owner-setup.md).

Publish the reviewed Firestore rules from this repository as part of the secure portal setup. Configure secrets in Cloudflare and redeploy before using the feature. The invitation code does not fall back to anonymous Firestore access.

This page does not record whether production has these secrets today. (On September 6, 2026 the Cloudflare production settings had the HighLevel connection but not `HUB_SESSION_SECRET`, `HUB_AUTH_USERS_JSON` or `FIREBASE_SERVICE_ACCOUNT_JSON`.) Before relying on automatic invitations, confirm that staff can sign in to the Hub (which needs the first two) and that **Hub → Integrations** shows `FIREBASE_SERVICE_ACCOUNT_JSON`, `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID` as ready.

## Validation

Run `node --test tests/*.test.mjs` and `node --check employee-suite.js`. The invitation tests simulate external delivery and cover valid signed links, both approval hooks, concurrency, duplicate saves, recipient mismatch, DND, missing configuration, email fallback, rejection, ambiguous outcomes, authentication, recurring-job state, quiet hours (11:30 PM holds, 8:01 AM sends once), the messaging pause and closed jobs. No live customer messages are sent by the tests.

After configuration, use a deliberately created test job and an owner-controlled destination to verify approval, final HighLevel delivery, and private-link access. Do not replay historical customer approvals as a delivery test.

HighLevel API references: [Send a new message](https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/index.html), [Get contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/index.html).

## Revoking portal links

An owner or manager can end every homeowner portal link and portal session for a customer account without sending anything to the customer.

- `GET /api/customer-portal-revoke?jobId=<job>` returns the verified account job, its current link version, its revision and `collaboratorCount` (active authorized people saved on the account).
- `POST /api/customer-portal-revoke` with `{ "requestId": "<uuid>", "jobId": "<job>", "expectedRevision": "<revision from GET>", "clearCollaborators": true }` increments `customerPortalLinkVersion` on the account job. Every field must be a JSON string except `clearCollaborators`, which must be a boolean when present; anything else returns 400 `CUSTOMER_PORTAL_REVOKE_INVALID_REQUEST`. A stale revision returns 409; retrying the same `requestId` returns the saved result without a second increment. Receipts are kept in the server-only `customerPortalOperations` collection (Firestore rules deny all client access).
- `clearCollaborators` defaults to `true` when omitted. A Hub control for this endpoint should omit it or send `true` unless staff explicitly choose to keep the saved people. In the same atomic commit as the version increment, it empties the account job's saved authorized people (`customerCollaborators`). Collaborator invitations and sessions are rechecked against that list on every request, so they stop working immediately. This matters because anyone holding a leaked owner link could add themselves as an authorized person and mint an invitation before the revocation. The response and receipt record only `removedCollaboratorCount`, never names or contacts. Send `false` only when you are sure the saved people are legitimate. Invitations that carry a link version still end, but older invitations without one keep working.
- Links and sessions created before this feature carry no version and keep working until the account's first revocation. New links from **Copy customer portal** and accepted-quote invitations carry the current version (`lv`) and the verified account job id (`lr`), so they work until the next revocation. Exchanging any link for a portal session binds the session the same way.
- Minting an owner (homeowner) access or session token without an explicit link version throws a programmer error. A token without one would count as version 0 and lock the owner out after the account's first revocation, so every caller must pass `customerPortalLinkVersion` of the verified account job (`readCustomerPortalContext(...).linkVersion`, or `customerPortalLinkAccount(...)` in staff code).
- A token that names an account job (`lr`) is rejected with `CUSTOMER_PORTAL_ACCESS_REVOKED` once its job resolves to a different account job, so moving a job under another account never revives a revoked link. Tokens without `lr` keep the earlier behavior.
- A recurring or linked visit uses its verified account job, so one revocation covers every job in that account.
- Business-account project access is managed from the business account and is not affected.
- After revoking, create a fresh link with **Copy customer portal** and share it only with the customer. The customer can re-add their authorized people from the fresh link.
- Collaborator invitations from `create_collaborator_invite` carry the account's current link version (`lv`) and account job id (`lr`), so a revocation ends them even when `clearCollaborators` is `false`. `save_collaborators` writes with the account job's observed revision, so a save that loaded the account before a revocation committed returns 409 and cannot re-add the cleared people.
