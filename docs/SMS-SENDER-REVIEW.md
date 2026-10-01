# Review the exact SMS sender

The Action Center requires an explicitly selected sender for each new SMS send. The sender is shown beside the recipient in the draft and send review, stored in the approval fingerprint and outbound payload, and checked against the provider's returned sender before delivery can complete the task. Email behavior is unchanged.

## Deployment and configuration

1. Deploy the same release to the Hub and platform services, including database migration `0016_action_sms_sender`. The migration adds sender matching to the database completion guard; it does not change any saved draft, approval, phone setting, or message.
2. On the API service only, set `EGC_OPERATIONS_SMS_FROM_NUMBERS` to the explicitly authorized, verified location-owned numbers in canonical E.164 form, separated by commas. For example, an isolated test deployment can use `+15555551644,+15555551818`. Do not use synthetic numbers in production. An unset list, malformed entry, or unknown selected number blocks new SMS sends. This is an allowlist, never a default sender or a change to HighLevel's phone configuration.
3. Keep the existing send enablement and credential requirements. Adding an allowlist alone does not enable sending. Test both configured lines with synthetic contacts in the approved environment before live acceptance.

## Existing drafts and retries

- An old SMS draft with no sender remains readable. Open Edit, choose the intended line, save, and review the new revision. Existing approval does not authorize an inferred sender.
- Changing a sender changes the draft revision and fingerprint. It requires a fresh approval. An edit that wins the task lock before the durable execution claim prevents the stale send.
- An execution already started for a revision is read back only, including legacy executions without a pinned sender. Retrying never chooses another line or sends another copy. A legacy receipt without approved sender evidence cannot complete the task under the new guard.
- A provider receipt from a different or missing sender stays unverified. A matching body or recipient alone cannot certify delivery. Failed/undelivered receipts remain failures.
- Do not rewrite previous approvals or execution payloads to add a sender retroactively. Do not use an account default or message history to infer the intended line.

## Acceptance checklist

Verify that both authorized lines appear as choices; a new SMS starts with no selection; the chosen line is visible in detail, approval and send review; changing the line requires review; a wrong-line receipt cannot complete; and retries of an uncertain send only read it back. Include phone-width layout, cancelled editors, a slow sender-list request, signout, and stale-revision rejection. Native PostgreSQL concurrency, browser/device acceptance, and authorized live receipt checks remain release gates until run in their supported environments.
