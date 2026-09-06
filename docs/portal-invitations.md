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
