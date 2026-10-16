# W19 native completion handoff

W19 uses existing native form **EGC Job Completion Confirmation**, `7HCRlKJs4VZx4KwNmDa6`, and workflow `1fbd6b3e-d5fb-422f-ba33-ae437c3e92f7`. It is separate from PR #130's optional completion tag. This follow-up is based on merged PR #138 (`aaf04bf`), whose reviewed head is unchanged. It performs no workflow activation, submission, provider write, credential or permission change.

## Native association and existing access

The native coordinator saved form version 5 on October 16, 2026: seven completion fields, then required STANDARD Contact Email (`id=email`, key `email`), then generated Submit. Label: **Customer email (not crew email)**. Sticky Contact is off. Existing Business Profile preferences were inspected without changes: Allow Duplicate Contact off, Email primary, Phone secondary. Desktop, 390px layout, keyboard order and empty-email validation passed without submission.

The assigned lead copies the exact customer email from authenticated Crew Tools into that native field. The launch URL carries **only canonical job ID and opaque completion reference**, plus optional `notrack=true`. It carries no contact ID, email, phone, customer name, work notes or payment data. No supported contact-ID URL key is required or invented. The form still requires deliberate human entry and submission.

**Permission blocker:** ordinary `crew_lead` has no existing email-read entitlement. Current field projections expose phone, not email; Firestore job/customer reads require business access. The obsolete full SDK read attempted by `crew/prejob.html` does not grant permission. This implementation displays email only for a current assigned lead who independently has existing business access. It returns only normalized saved `job.email` after a bounded exact-contact GET confirms the same email, contact ID and location. Missing job email is never filled from CRM. Missing/mismatched/unreadable email or insufficient access stops launch and directs operations to review. Ordinary crew-lead use needs a separately authorized permission decision; no roles, claims or rules change here.

Email and launch link remain in memory, clearing on refresh/account/sign-out/offline/render changes. Copy is explicit, with a selectable read-only fallback. Assignment and job revision are rechecked after provider reads. Customer PII is never put in the launch URL or persisted by this card.

## Canonical completion and receipt

1. `GET /api/field-completion-handoff?jobId=...` requires the authenticated current assigned job lead, including managers. It verifies the applied canonical `complete` event, required checklist, verified original before/after photos, saved notes/issues and actual completion time.
2. Explicit `POST /api/field-completion-handoff` prepares one durable intent for `(job ID, completion request ID, native form ID)`. A root-independent business claim survives signing-key rotation; repeated taps/lost prepare responses reuse it. The reference uses the existing purpose root with `egc/w19-completion-ref/v1`. Original completion actor and confirming lead stay distinct. Unclaimed references expire after seven days without automatic replacement.
3. Native Form Submitted calls `https://easygaragecleaning.com/api/w19-completion-gate` with JSON `{"reference":"{{contact.egc_completion_reference}}","contactId":"{{contact.id}}"}`. Both picker tokens are verified. The mutable contact reference is a lookup hint, not a receipt. Optional `submissionId` requires a verified immutable source; none was found in the picker.
4. The server reads documented `GET /forms/submissions` using existing credentials. It verifies actual receipt ID, exact form/contact/location/job/reference and creation instant within the issuance window. It exhausts bounded pagination and rejects unknown/malformed/truncated results. Without an ID it chooses the earliest exact match by creation time then ID only after the complete bounded scan. A supplied ID must match strictly. Date search is padded by one day because provider date-filter timezone is unspecified; accepted instants remain strict.
5. The gate rechecks fresh lead account/assignment, canonical contact/location and immutable closeout after provider reads. A transaction fences job revision and the nested completion event, updates the business/handoff claim and creates a unique provider-submission claim. It stores the immutable canonical `completionSnapshot` and `completion_verified` state.

Wrong workflow contact or wrong receipt rejects without retargeting. A mistyped native email can affect a different contact before the gate; rejection needs operations review, never automatic resubmission. Mutable contact fields are not job-specific storage. Canonical field completion/event and server-only `w19CompletionHandoffs.completionSnapshot` retain actual date and notes across multiple jobs for one contact. Form-entered notes/time never replace canonical evidence.

## Completion-only response

A first acknowledged atomic claim returns `ok:true`, `status:completion_verified`, and:

```json
{
  "proceed": false,
  "completion": { "verified": true, "proceed": true, "status": "verified" },
  "taskStatus": "not_enabled",
  "jobId": "canonical-job-id",
  "contactId": "exact-canonical-contact",
  "opportunityId": null,
  "opportunity": { "status": "missing", "canUpdate": false, "id": null },
  "financial": { "status": "review_required" },
  "balance": null
}
```

It also returns actual saved completion time, America/Denver date, original completion actor, confirming lead and verified notes/issues. The date is not schedule, submission time or browser clock. Stored snapshots are allowlisted and checked against canonical proof before output; stored properties cannot override authorization flags.

Only exact booleans `ok:true`, `completion.verified:true`, `completion.proceed:true` permit a single completion-only mapping. Duplicate and uncertain commit responses return `completion.proceed:false`; verified state remains when the durable claim is found. **Legacy top-level `proceed` always remains false** because it previously authorized a task. New claims use `taskStatus:not_enabled` and issue no task marker. Local verification does not prove downstream native mappings succeeded; uncertain downstream actions require separate reconciliation and must not be blindly repeated.

Money, opportunity and staffed-hour task readiness do not block completion acceptance. Existing `w19Balance()` still requires a current dated approved quote, matching own amount/revision/fingerprint when present, unified approved changes and fully reconciled verified job receipts. Unavailable/conflicting money returns `financial.status:review_required`, `balance:null`, never zero. Verified advisory money has integer approved/applied/balance cents and USD. A canonical revision change during optional reads discards readiness as `not_checked`. These snapshots authorize no financial action.

Only the exact saved opportunity ID may be read, with matching contact/location. Missing/invalid/unavailable/mismatched data cannot block completion. Exact verification returns top-level `opportunityId` for future routing, but **`opportunity.canUpdate:false` always** in this change. No newest/triggering/contact-wide deal is guessed. A future reviewed financial branch must use exact ID and confirmed balance before choosing **EGC Pipeline → Job Completed Balance Due** or **Paid in Full—Completed**. Completion alone cannot choose either.

No payment, invoice, commission, customer acceptance or customer-message status changes. Existing 25%/75% terms and due rules remain unchanged. Completion does not mean a balance is paid, an invoice sent, or a task created.

## Durable recovery

Collections `w19CompletionHandoffs`, `w19CompletionClaims`, `w19CompletionSubmissions` retain existing server-only rules. Only job operational metadata `w19CompletionHandoff` is patched. Receipt read failures remain prepared with a visible retry-by-read message; the Hub never submits/resubmits the native form. Cancellations, removed jobs, changed contact/lead/location/evidence and expired unclaimed references fail closed. Historical jobs are untouched unless explicitly prepared by an authorized assigned lead.

Terminal `completion_verified` stays visible after expiry or later setup/provider-read failures and cannot launch another form. Existing **`released_unconfirmed` / task `unknown`** records remain unchanged, without reset/conversion/retry. Their old exact task marker remains for operations reconciliation.

## Configuration and activation blockers

All activation values remain unset by default. This worker does not merge, deploy or enable workflows.

| Setting | Meaning |
| --- | --- |
| `EGC_W19_COMPLETION_HANDOFF=true` | Enables staff preparation and real gate after reviewed deployment and setup approval. Otherwise real requests return 404. |
| `EGC_W19_COMPLETION_WORKFLOW_READY=true` | Attests verified native association and strict completion-only response/re-entry/uncertain-result handling. No task enablement. |
| `EGC_W19_COMPLETION_ASSOCIATION_MODE=manual_email` | Selects required standard customer email with Sticky Contact off and existing dedup preferences verified. |
| `EGC_W19_COMPLETION_QUERY_KEYS_JSON` | Optional exact pinned pair: jobId `egc_completion_job_id`, reference `egc_completion_reference`. Omit for defaults; no contact/email/arbitrary keys. Old `EGC_W19_COMPLETION_CONTACT_QUERY_KEY` is unused. |
| `EGC_W19_COMPLETION_RECEIPT_FIELDS_JSON` | Optional exact job/reference receipt mapping; omit for verified native IDs. |
| `EGC_W19_COMPLETION_FORM_URL` | Default `https://links.easygaragecleaning.com/widget/form/7HCRlKJs4VZx4KwNmDa6?notrack=true`; pinned verified provider/custom origin and exact form path only. |
| Existing HighLevel key/location, Hub purpose root and Firestore server connection | Reused unchanged; exact contact/form-submission and optional opportunity read access. No new credentials. |

Native IDs: job `pKArVLKFAIEzNPMPJ7EL`; date/time `vKgUZFHSywW7IVYaAzUv`; work `KM4Wdv2Ds6YruppSRcol`; unfinished `kFSdQ8SxNnjZsK15lffJ`; concerns `5DfNkQVbwwPusGxwv6WI`; lead `Zg99AdjT6VclE9qcVedI`; reference `WypOwqgzXpVP0we0Jf35`; standard email `email`. Only job/reference enter the launch URL.

Native coordinator verified the deployed old schema-only route at October 16 00:07:04 GMT. Saved first webhook action `e9dd8cb0-74e9-43bc-a60a-fb9499156149`: POST, Authorization None, Content-Type application/json, body exactly `{"schemaOnly":true}`, Save response enabled. Old HTTP200 sample has `proceed:false` but lacks the new completion object. After the release owner confirms this follow-up deployment, refresh the harmless schema test and verify nested boolean picker fields before mapping completion. Schema-only always bypasses storage/provider/authentication and returns synthetic identities/zero sample amounts, `completion.verified:false`, `completion.proceed:false`, `taskStatus:not_enabled`. Mixed real/schema bodies reject. Never branch on `ok` alone.

Remaining blockers: reviewed/deployed follow-up and refreshed native schema; strict completion-only conditions and job-specific mapping with task/stage/payment actions gated; separately authorized controlled proof of real native association/receipt shape/pagination; operations recovery procedure; ordinary-crew email permission decision. W19 remains Saved/Draft, Publish false. No whole-workflow or real gate execution was authorized here.

Future Cesar task needs staffed-hours policy, a supported computed deadline path and exact provider task acknowledgement/marker reconciliation. Native due value/unit are empty; only Days/Weeks/Months/Years plus time are available, so a one-staffed-hour promise is unconfigured. These requirements do not block canonical completion storage; task delivery stays disabled in code.

**Keep `EGC_GHL_FIELD_COMPLETION_TAG` unset/false** pending its separate workflow/customer-message audit. Preserve shared `EGC_GHL_TAG_OUTBOX` and drain settings. W19 does not require this tag.

## Validation and primary sources

Focused tests use synthetic jobs and mocked HTTP. They cover roles/account/origin, canonical evidence, email permission/minimization/mismatch and assignment races, pinned private launch URL, duplicate/concurrent/invalid receipts, immutable snapshots and tampering, unknown commit recovery, absent financial/opportunity/task readiness, terminal/legacy preservation, Firestore transaction preconditions and UI sign-out/offline/copy races. No provider writes or live jobs are changed.

Interfaces: [Get Form Submissions](https://marketplace.gohighlevel.com/docs/ghl/forms/get-forms-submissions/), [Get Contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/), [deduplication preferences](https://help.gohighlevel.com/support/solutions/articles/48001181714-allow-duplicate-contacts-contact-deduplication-preferences-), [Sticky Contact](https://help.gohighlevel.com/support/solutions/articles/48000979919-sticky-contact-in-forms-surveys-and-calendars), [Form Submitted](https://help.gohighlevel.com/support/solutions/articles/155000002550-workflow-trigger-form-submitted). No documented native form-submission creation endpoint exists in the Forms API catalog; no private widget endpoint is guessed.
