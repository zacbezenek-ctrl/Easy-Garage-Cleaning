# Accepted quote portal invitations

New staff-recorded approvals and signed walkthrough saves request a private client portal invitation. The HighLevel server handoff reads the saved job and sends it automatically. Staff can see the invitation status and retry a definite failure in **Estimates & payments**.

- Delivery uses the saved customer's phone via HighLevel SMS, or email when there is no valid phone number. The linked contact's identity and location must match the saved job.
- Job notifications and HighLevel DND are respected. Existing accepted jobs are not bulk enrolled; only new approval requests are eligible automatically.
- The private link lasts 30 days. The portal session lasts seven days. Tokens are never saved in staff-readable job documents or returned from the invitation endpoint.
- A conditional storage claim in the server-only `portal_invitations` collection limits sending to one invitation per job. The job contains a display copy only; stale scheduling edits, repeated saves, and concurrent requests do not resend a submitted message.
- `submitted` means HighLevel accepted the message; it does not prove carrier or inbox delivery. Check the HighLevel conversation for final delivery.
- Definite rejection can be retried. A timeout, server error, or lost delivery-status write is marked uncertain and never automatically resent. Check HighLevel before manually sharing a fresh link.
- The Hub retries newly requested, definitely unsent invitations when a manager loads or refreshes the Hub, with a ten-minute interval and a five-attempt limit. The initial send happens on the acceptance request itself; retry processing is not a background scheduler.

## Required production configuration

Existing Cloudflare Pages production secrets must include:

- `HUB_SESSION_SECRET`: dedicated random staff/session signing secret (also signs portal links unless `CUSTOMER_PORTAL_SECRET` is provided).
- `HUB_AUTH_USERS_JSON`: configured staff accounts with generated PBKDF2 password hashes. This is required for authorized Hub operations; do not restore legacy embedded credentials.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: credentials for project `egcw-1ec83`, with the Firestore access needed to read jobs and write delivery metadata. Keep the JSON encrypted in Cloudflare, outside the repository.
- `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID`: contact read/upsert and conversation-message write access; an operational SMS/email sender in the existing account.

Publish the reviewed Firestore rules from this repository as part of the secure portal setup. Configure secrets in Cloudflare and redeploy before using the feature. The invitation code does not fall back to anonymous Firestore access.

As of September 6, 2026, the Cloudflare production settings showed the HighLevel connection, but did not contain `HUB_SESSION_SECRET`, `HUB_AUTH_USERS_JSON`, or `FIREBASE_SERVICE_ACCOUNT_JSON`. Automatic invitations therefore remain unavailable until the secure Hub/portal setup is completed.

## Validation

Run `node --test tests/*.test.mjs` and `node --check employee-suite.js`. The invitation tests simulate external delivery and cover valid signed links, both approval hooks, concurrency, duplicate saves, recipient mismatch, DND, missing configuration, email fallback, rejection, ambiguous outcomes, authentication, and recurring-job state. No live customer messages are sent by the tests.

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
