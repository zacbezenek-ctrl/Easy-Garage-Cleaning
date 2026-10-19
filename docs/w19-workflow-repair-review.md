# W19 native mapping repair - review only

Inspected main `f062a63ab4f63f77847fc6229beff46eaedd047e` and PR146 on
2026-10-19. PR146 is merged; its W19 concurrent-claim re-read fix is already in
main. This patch neither reimplements that fix nor changes its pricing/terms.
The existing estimator draft is separate and untouched.

Live observations supplied by the native audit: workflow
`1fbd6b3e-d5fb-422f-ba33-ae437c3e92f7` is Saved/Draft; webhook body is only
`{"schemaOnly":true}`; verified branch removes the contact from this workflow;
legacy completion date/work-note actions are unbound, balance has no
field/operator, invoice task has no due date. Form notifications are off.

## What is already implemented

- `functions/api/field-completion-handoff.js` authenticates the signed Hub user
  and requires the current assigned lead. `w19CompletionProof` checks canonical
  completed work, original actor, field event, checklist and verified photos.
- `functions/_lib/w19-completion-handoff.js` stores a server-issued opaque
  reference bound to that exact completion, job, contact, location and lead.
  Current assignment, proof and linked contact are rechecked before claiming.
- `functions/_lib/w19-form-submissions.js` uses bounded provider GETs. It checks
  exact form/contact/job/reference/time, complete pagination and earliest exact
  receipt if no submission ID is supplied. No submission ID must be invented.
- The gate's first acknowledged claim returns `completion.verified:true` and
  `completion.proceed:true`. Repeat/uncertain claims never release a second
  action. Top-level `proceed` remains false, task status `not_enabled`, and
  `opportunity.canUpdate` false. Money readiness is advisory, never payment or
  commission settlement. The PR146 race fix is preserved.

## Exact native repair steps for later approved configuration work

These steps have NOT been executed by this patch. Keep Saved/Draft throughout.

1. Keep trigger restricted to **EGC Job Completion Confirmation**,
   `7HCRlKJs4VZx4KwNmDa6`. Preserve required job `pKArVLKFAIEzNPMPJ7EL`,
   completion time `vKgUZFHSywW7IVYaAzUv`, evidence `KM4Wdv2Ds6YruppSRcol`,
   unfinished work `kFSdQ8SxNnjZsK15lffJ`, concerns `5DfNkQVbwwPusGxwv6WI`,
   lead label `Zg99AdjT6VclE9qcVedI`, reference `WypOwqgzXpVP0we0Jf35`
   and standard email `email`. Neither lead label nor entered time authorizes
   identity/completion: the server's canonical proof is authoritative.
2. Keep autoresponder and email notification off, required customer email and
   Sticky Contact off. Verify existing dedup association settings before any
   separately authorized test. Do not substitute crew email or a made-up email.
3. Keep `{"schemaOnly":true}` only for schema discovery. The real webhook is
   `POST https://easygaragecleaning.com/api/w19-completion-gate`, JSON, save
   response enabled. Its real body must contain **only** `reference` and
   `contactId`: choose the native reference field and current workflow contact
   from verified GHL pickers. Record actual picker tokens/evidence; this patch
   does not invent their token syntax. `schemaOnly` must be absent. The reference
   is a server-issued capability; do not hand-create it or pass customer email.
4. Verify the refreshed response schema exposes boolean `ok`,
   `completion.verified`, and `completion.proceed`. Use **AND**, each equal to
   boolean **true**. Never gate on a truthy string, top-level `proceed`, `ok`
   alone, submission success message, zero balance or a contact custom field.
5. Keep the successful completion branch limited to removing the contact from
   the current workflow. The API already records the immutable completion
   receipt locally. Leave error, duplicate, pending and uncertain paths without
   consequential actions; reconcile by reading, never resubmit blindly.
6. Remove/disable the unbound legacy completion-date and work-note actions and
   the empty balance condition/invoice task in the proposed draft. Do not map
   them to trigger/contact values. A job-specific stage/task/financial branch
   needs a separate verified target and authorization; none is supplied here.
   Do not mark payment or commission settled on completion.
7. Keep publish and activation flags unchanged. The schema probe is not an
   end-to-end test and supplies synthetic zero amounts, not real money evidence.

## Ordinary crew and the required email field

The current form requires customer email, but ordinary crew do not have email
read entitlement. Main intentionally returns `identity_required` and blocks
native launch for those users. They can record the existing authenticated Hub
completion evidence without learning customer email. Do not broaden Firestore
rules, roles or contact/email endpoints to make the native form open.

Main's manual-email native lane works only for an actual assigned lead who also
independently has existing business/email access. Do not fake assignment to make
an office user eligible. If the desired lane is an ordinary crew native form
with no email disclosure, the current native association mechanism cannot meet
it: a supported server-associated contact method must first be verified. No
such API/token/picker contract was provided by the audit. This remains a precise
native-integration blocker, not permission to invent a contact-ID prefill key or
to expose email. No runtime access change is proposed.

## Local review contract and verification

`functions/_lib/w19-workflow-contract.js` is a pure, non-runtime lint for recorded
native observations, not the GHL API schema. It checks exact identities, only
reference/contact body bindings with evidence, strict completion booleans,
nonconsequential branches, and preservation of the email-access boundary. It
always reports `activationAllowed:false`, `submissionAllowed:false` and no
payment/commission authority. There are no provider/storage imports or calls.

Six focused tests cover identity, the current schema-only/unbound configuration,
invented picker values, strict booleans, forbidden task/payment/access changes
and no execution capability. Runtime GHL submission/receipt association,
webhook picker serialization, downstream behavior and crew/browser smoke tests
were not performed. No live configuration, job, customer, payment or commission
record was changed. The stale-quote scanner and credential discovery were not
run. This PR is additive review tooling/documentation, not a claim that W19 is
activated or that its remaining native association blocker is solved.

