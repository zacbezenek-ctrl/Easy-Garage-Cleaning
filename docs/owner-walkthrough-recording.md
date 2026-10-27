# Owner walkthrough recording

Dispatch → **Record walkthrough** is available only to the signed Hub owner.
Select the existing Hub customer and employee, enter the address, work scope and
reason, then review before saving. This is separate from Create job.

- **Hub-only** saves the Denver date and exact start/end, preserving any contact
  link. No provider request, appointment, HighLevel tag/mirror intent or message.
- **Import existing appointment** requires exact appointment and calendar IDs.
  The server verifies the linked contact, phone/email, location, calendar and
  active appointment with exact start/end. Calendar names do not classify it.
  The owner identifies it as a walkthrough and reviews the provider assignment
  alongside the separately selected Hub employee. No mapping or assignment is
  changed. The provider address is displayed; the owner supplies the operational
  address to use for this visit.

Imports are snapshots. The server rereads the provider on save and immediately
before committing. Changed, canceled, unavailable or ambiguous-DST records are
refused. Changes after that read remain outside the Hub transaction. Review
HighLevel again before using an import if the customer later reschedules.
The window is today through 180 days, same-day duration up to four hours. A
visit earlier today may be recorded but is not marked completed.

Native Dispatch conflict checks, day locks, roster checks, audit and funnel
records remain in place. An atomic appointment claim blocks imports with new
request IDs or different dates/customers. Legacy Hub appointment links are also
checked. Lost responses replay a durable owner/request receipt. The browser
retains an uncertain request in owner-scoped session storage and offers
**Verify saved recording** after reopening. Preview alone writes nothing.

The server-owned `recorded_visit_*` identity and
`ownerWalkthrough.providerWrites = blocked` policy prevent
later calendar sync, tag/mirror intents and HighLevel handoff retries. Only the
owner may edit these records. Hub-only edits remain silent. Imported time/status
changes are refused in ordinary Dispatch: review the existing appointment in
HighLevel. Separate jobs created from accepted walkthroughs keep their existing
quote/payment flow. Compensation and global calendar mappings are unchanged.

## Release

1. Review tests and CI on the draft PR. Keep it unmerged until the rule below is
   published, because merging starts the Pages production deployment.
2. Publish `firestore.rules` to the Hub's existing Firebase project before making
   the new action available. The rule blocks SDK creation, mutation and deletion
   of these visits. Receipt collections remain server-only under the catch-all.
   No indexes, credentials or data migration are needed.
3. Merge only this repair and deploy Cloudflare Pages from that exact commit. Verify the new script,
   owner-only endpoint and rejection for other roles without live bookings.
   Railway needs no release: its scheduler resolves the visit through the Pages
   bridge, which rejects recorded snapshots before any provider call.
4. The authorized operator can then record confirmed visits and verify exact
   Hub readback. A proposed reschedule must wait for customer agreement.

No new environment switch or provider workflow edit is required. No provider
writes means this action cannot trigger appointment confirmations. It does not
suppress independent messages from existing provider appointments/workflows.

Rollback: hide the new UI while retaining the API, guards and Firestore rule for
saved records. Do not clear their policy or contact links to resume ordinary
sync. A full rollback requires reviewing those records first.
