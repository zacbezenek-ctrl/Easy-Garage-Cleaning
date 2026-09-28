# Customer identity normalization and backfill (P4-02)

This is the groundwork for account-level customer login (a magic link sent by phone or email). The Firestore Hub
`customers` collection stays the only source of truth. This unit adds two derived, optional lookup keys to each
customer. It also adds a backfill that links legacy jobs to exactly one existing customer. It never merges,
renames or deletes customers.

## Fields

| Collection | Field | Meaning |
| --- | --- | --- |
| `customers` | `phoneE164` | `normalizePhoneE164(phone)`, e.g. `+19705550100`. `''` when the saved phone is missing or unusable. |
| `customers` | `emailLower` | `normalizeEmail(email)`: trimmed and lowercased. `''` when missing or invalid. |
| `customers` | `identityNormalizedAt` | When the backfill or a walkthrough handoff last set the two keys. |
| `jobs` | `customerId` | Set only on legacy jobs that had none, and only when the evidence names exactly one customer. |
| `jobs` | `customerLinkSource`, `customerLinkEvidence`, `customerLinkedAt` | Provenance of a backfill link: `identity_backfill`, the matching evidence (`crm_contact`, `phone`, `email`, plus `name` or `address` when they confirmed a lone phone or email), and the run time. |

Both keys are derived from the saved `phone` and `email` fields and never replace them. Code that reads them must
recompute from `phone` and `email` and treat any mismatch as stale. `findCustomerCandidates` already does this.

### Normalization rules (`functions/_lib/customer-identity.js`)

- Phone numbers are read US-first. Bare 10 digits, bare 11 digits starting with `1`, and `+1` followed by 10
  digits are NANP numbers, whatever separators they carry. The area code and exchange must start with 2–9. A `+`
  followed by any other country code is kept as that international number (8–15 digits) and is never folded into
  `+1`: `+64 9 523 4567` is `+6495234567`, not a Turks & Caicos `+1 649` number, and `+9705550100` is
  `+9705550100`. International numbers without a `+` are unusable. A leading `tel:` and a trailing
  `ext`/`x`/`#` extension are dropped. Anything else becomes `''`.
- Email is `trim().toLowerCase()`, with `mailto:` removed. Dots and `+tags` are kept, so two different mailboxes are
  never folded into one identity. An invalid address becomes `''`.

## Writers that store the keys

- `resolveCustomer` (manager intake and verified CRM contacts) stores the keys when it creates a customer. It also
  stores them when it first links a CRM contact to a customer.
- `linkScheduledCustomer` (operations integration) does the same on create and on its first provider link.
- `adoptScheduledVisit` (verified booking adoption) stores the keys on the customers it creates.
- `saveWalkthroughHandoff` already fences the customer revision. When the customer's keys are missing or stale,
  that fence now also writes them, in the same atomic commit. Otherwise it stays a read-only fence.

Customers created before this unit get their keys from the backfill.

## Lookup: `findCustomerCandidates(store, {phone, email})`

This runs bounded `runQuery` equality lookups on `customers.phoneE164` and `customers.emailLower`. It returns
`customerId` only when **exactly one** customer matches **and** coverage is complete. In each of these cases it
returns no match:

- one phone is shared by two customers,
- the phone matches one customer and the email matches another,
- a stored key no longer matches the saved phone or email (reported as `coverage.complete: false`),
- another customer holds the same CRM contact,
- a job under that CRM contact is already linked to a different customer,
- the matched customer's stored CRM contact is not a safe record ID (reported as `coverage.complete: false`).

Every lookup is a bounded, field-masked `runQuery`. The CRM job history selects only `type`, `recordType`,
`customerId` and `highlevelContactId`, so signatures, handoff payloads and finance never leave Firestore.

For a unique match, the result also lists that CRM contact's jobs. Legacy jobs show `customerId: ''`. Callers
must fail closed when `customerId` is empty. The lookup never writes and never merges.

## Backfill script

```
node scripts/backfill-customer-identity.mjs                    # DRY RUN (default): plan + report, writes nothing
node scripts/backfill-customer-identity.mjs --report out.json  # also save the JSON report (mode 0600)
node scripts/backfill-customer-identity.mjs --apply            # write, with revision preconditions
```

The script needs `FIREBASE_SERVICE_ACCOUNT_JSON`, the same service account the Pages Functions use. It prints the
JSON report to stdout and a one-line summary to stderr. It exits with code 1 if the run aborted.

What `--apply` does:

1. It writes `phoneE164`, `emailLower` and `identityNormalizedAt` on each customer whose keys are missing or
   stale. Every write carries that customer's `updateTime` precondition. A customer changed meanwhile is skipped
   and listed under `writes.changedDuringRun`.
2. It reads `customerIdentityState/revision` and `dispatchState/revision` (creating either if it is absent), then
   takes a fresh snapshot of `customers` and `jobs`. Customer resolution, booking adoption and every Dispatch
   write use the same guards.
3. It links a legacy operational job (`job`, `cleanout`, `reorg` or `walkthrough`, with no `recordType`, not
   `_egc_`/`secure_`, and no `customerId`) only when its CRM contact, phone and email evidence together name
   exactly one customer. Customers whose ID is unusable are never written or linked, but their phone, email and
   CRM contact still count as competing evidence. On top of that:
   - A job that names a CRM contact links only to the customer that holds that contact.
   - A job matched only by phone or email must not disagree with that customer on any other detail it carries.
   - A job matched by a lone phone or a lone email (no CRM contact, not both) links only when its name (first and
     last name, from `customer`, `customerName` or `name`) or its street line with house number also matches the
     customer. A recycled phone number or a shared inbox therefore never links on its own.
   - Linked jobs must stay consistent with their relatives. Every `customerAccountOwnerJobId` hop must end at the
     same customer, as the customer portal's `verifiedAccountRoot` requires. Related jobs (`sourceWalkthroughId`,
     `customerMemoryInheritedFrom`, `recurrenceParentId`, `sourceTemplateJobId`, and jobs pointing back) and the
     job's `projects/{projectId}` must not belong to another customer.
   - A link must never give a customer a second account root. Dispatch resolves account roots over the customer's
     `job`, `cleanout` and `reorg` records. With more than one root it needs an explicit source job
     (`dispatch_lineage_selection_required`), and the walkthrough handoff and native booking cannot supply one. So
     when the customer would end up with more than one root, every link that adds a new root is held back.
     Legacy jobs that join the customer's existing root still link, and walkthroughs are never roots. A customer
     with no linked history and two or more separate legacy histories therefore gets none of them linked; a
     manager decides which history owns the account.
4. Links that depend on each other (an owner chain or a reference between two legacy jobs) form one component,
   and each component commits atomically. Each job is written with its `updateTime` precondition. The same commit
   fences, with a read-only transaction fence, the matched customer, every existing related job and project the
   checks read, `customerIdentityState/revision` and `dispatchState/revision`. When any of those records changed,
   the whole component is skipped (listed under `writes.changedDuringRun`) and picked up by a rerun; a chain is
   never half linked. A changed identity guard (a customer was created or relinked during the run) stops all
   further links with `aborted.code = customer_identity_backfill_identity_changed`. A changed dispatch guard (any
   Dispatch, booking or availability write during the run) stops them with
   `customer_identity_backfill_schedule_changed`.

Re-running is safe and idempotent. Customers that already have current keys and jobs that already have a
`customerId` are never rewritten. A lost commit response (`dispatch_outcome_unknown`) aborts the run. The next run
plans again from the saved state and does not repeat writes that were applied.

### Report (manager review)

Phone and email values are masked (`+1…0100`, `s…@example.invalid`). Customer IDs that embed a phone number
(legacy gameplan IDs `egc_<digits>`, shown as `egc_…0100`) or look like an email are masked the same way. The
report still names job and customer records and CRM contact IDs, so treat it as confidential. `--report` replaces
any earlier file and writes it with mode 0600; do not paste it into shared channels.

- `customers.duplicateIdentities`: several customers share a phone, email or CRM contact. The backfill never
  merges them. Review them in the Hub and correct the duplicate records by hand. Until then, those identities can
  never auto-link or sign in by that phone or email.
- `customers.skippedIds`: customers whose ID cannot be used as a record link. They are never written, but their
  keys still make matching jobs ambiguous.
- `customers.unusablePhone` / `customers.unusableEmail`: saved values that cannot be normalized.
- `jobs.loneKeyLinks`: jobs linked (or, in a dry run, to be linked) on a lone phone or email confirmed by name or
  street. Spot-check them.
- `jobs.ambiguous`: legacy jobs whose evidence names more than one customer, with each candidate and its evidence.
- `jobs.conflicts`: jobs that matched one customer but were not linked. The reasons are `phone_mismatch`,
  `email_mismatch`, `crm_contact_mismatch`, `crm_contact_unmatched`, `identity_unconfirmed` (a lone phone or
  email without a matching name or street), `customer_id_invalid` (the only match has an unusable ID),
  `lineage_conflict`, `project_conflict`, `account_root_conflict` (linking would give the customer a second
  account root) and `lineage_too_large` (a component too large for one atomic commit).
- `jobs.unmatched`: legacy jobs without any matching customer.
- `managerReview.required` is true whenever `duplicateIdentities`, `ambiguous` or `conflicts` is non-empty.
  To resolve an `account_root_conflict`, link the chosen job by hand and point the customer's other histories at
  it with `customerAccountOwnerJobId`, or leave them unlinked.

### Operational notes

- Run `--apply` in a quiet window, for example after hours. Any Dispatch, booking or availability write during
  the link phase aborts it (`schedule_changed`); rerun it afterwards. `linkScheduledCustomer` (the native CRM link
  path) bumps neither guard. A native CRM link made during the run can therefore create a duplicate customer, or
  link a new visit that becomes a second account root, without the guards seeing it. Each backfill link is still
  fenced on its own job, its customer and its relatives. After an apply, run a dry run and confirm it plans no
  further links and reports no new `duplicateIdentities`.
- The backfill never gives a customer a second account root, so Dispatch, the walkthrough handoff and native
  booking keep creating visits for returning customers without asking for a source job. Customers that already
  had several roots before the run keep them; only links that join an existing root are added for them.
- To undo, find the jobs with `customerLinkSource == 'identity_backfill'` and review them. The customer keys are
  derived data and can stay.
- Equality lookups on `phoneE164`, `emailLower` and `highlevelContactId` use Firestore's automatic single-field
  indexes. No composite index is needed.
