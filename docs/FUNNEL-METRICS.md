# EGC Job Funnel, Contribution and Business Pulse: Design (revision 2)

> **Living spec.** This is the funnel design approved on 2026-09-28 (revision 2), copied into the repository by FUN-01 and kept current by every FUN-* unit: a unit that changes a rule updates this file in the same commit. The "Status" line below describes the design review, not the repository. The machine-readable rules (eligibility, vocabularies, reason codes, calendar, cycle and event-integrity rules) live in `functions/_data/funnel-definitions.data.json`; where this document and that file disagree, the file is what runs and this document must be corrected.
>
> **FUN-01 in the repository**
>
> | File | What it is |
> |---|---|
> | `functions/_data/funnel-definitions.data.json` | The canonical definitions. Edit only this file, then run `node scripts/funnel-definitions.mjs --write`. |
> | `functions/_lib/funnel-definitions.data.js` | Generated Hub copy (the exact JSON text; Pages Functions bundles do not rely on JSON import attributes). |
> | `egc-platform/packages/funnel-definitions/` | `@egc/funnel-definitions`: the byte-identical platform copy, `definitionsHash`, and `src/generated.ts` pinning the Hub-computed hash. |
> | `scripts/funnel-definitions.mjs` | `--write` regenerates the copies; `--check` (default) fails on drift. `tests/funnel-definitions.test.mjs` runs the same check. |
> | `functions/_lib/funnel-definitions.js` | `funnelDefinitions()`, `definitionsHash()`, vocabularies and reason codes, the single eligibility function (`hubRecordEligibility` with `hubEligibilityFields` for masked scans, `ghlContactEligibility` with folded tags (`ghlTagKey`) and contact flags, a superset of the platform's current exclusions, `stripeEligibility`, `funnelEligibility`; `operations-financials`, the bridge evidence scan and the M3 `moneyJob` gate use it), the service-line pre-fill (`funnelServiceLine`) and the metric-dimension bucket (`funnelDimensionValue`, unknown when missing). |
> | `functions/_lib/funnel-calendar.js` | The one business calendar (Mon–Sat 07:00–19:00 Denver, US federal holidays on their actual date), business-minute math, Denver day/week buckets, pulse periods, the in-progress comparison truncation and the last-year comparison (same weekday for day and week periods, same date otherwise). Web-lead `lead_timing` uses it (holidays off, legacy output unchanged). |
> | `functions/_lib/funnel-events.js` | `funnelEventWrite(store, clock, event)`: one create-only `funnelEvents/{fe_…}` write to add to the business commit; the device-clock rule (`resolveDeviceClock`); index list. |
> | `firestore.rules`, `firestore.indexes.json` | `funnelEvents` is server-only; composite indexes `(type, denverDate)`, `(projectId, occurredAt)`, `(jobId, occurredAt)`, and `(type, recordedAt)` for the FUN-37 feed's `types[]` filter (the unfiltered `(recordedAt, id)` cursor uses the automatic single-field index). |
>
> **FUN-02 in the repository** (booking, dispatch, handoff and approval events)
>
> | Where | What it writes |
> |---|---|
> | `functions/_lib/dispatch-funnel.js` | The shared booking and schedule-event rules: `bookingInput` / `bookingPatch` (visit facts), `reasonInput` (reschedule, cancel and no-show codes; `other_legacy` is reserved for history), `lateCancel`, `cancelPatch`, `noShowProblem`, `visitFunnelWrites` (the events of one visit change) and `dispatchFunnelOptions` (the live lists `GET /api/dispatch` returns as `funnel`). |
> | Dispatch `schedule.create` | The visit records `bookingChannel`, `channelSelfReported`, `bookedBy`, `visitPurpose` (a walkthrough is always `walkthrough`; a job defaults to `service`, the legacy meaning of every job), `reworkOfJobId` (rework only; the visit joins that job's project) or `membershipId` (member visits only), and `crmLinkReason` (kept only when the visit has no CRM contact; `vocabularies.crmLinkReasons`). A new project also stores `highlevelContactId`, `crmLinkReason` and, for a repeat, `previousProjectId`. The Dispatch create form asks how the visit was booked (required), its purpose (service, install, return or rework with the original job ID), how the customer heard about us, and, when the customer search reports `crmLinked: false`, why there is no CRM contact (required). A recurring-plan occurrence is `recurring_plan`. The older booking wizard (`employee-booking.js`) sends no booking facts, so its visits keep an unknown channel (`null`). |
> | Every visit change (dispatch, self-service shift pickup, the bridge scheduler, GHL adoption) | In the visit's own commit: `walkthrough.booked` / `job.scheduled` on the first placement on the calendar; `*.rescheduled` on every later change of the start instant, with `fromStartAt` / `toStartAt`, `reasonCode`, `initiatedBy` and `occurrence` (the visit's `scheduleOccurrence`, the number of start instants it has been placed at; taking it off the calendar is a reschedule without `toStartAt` that saves the placement a legacy visit without a counter implies, so placing it again is a reschedule with `occurrence: 2`, never a second booking; an end-time change alone is none); `*.cancelled` with `reasonCode`, `initiatedBy` and `lateCancel` (cancelling an already-cancelled visit, which the bridge allows, writes none); `job.no_show`; `job.restored` / `walkthrough.restored`; `job.assigned` when a job's crew changes to a non-empty crew. Company blocks never have events. Dispatch asks *Why is this visit moving?* (reason and who asked, both required) whenever the visit's start changes: in the job editor and on a Lanes drag (a split job starts at its earliest segment). A crew change or phone tap-assign at the same time needs no reason. |
> | Cancel | `cancellationReasonCode` next to the free-text `cancellationReason` (a cancel sent without a code, from an older client or the MCP scheduler, records `other_legacy`, as FUN-04 maps history), `cancellationInitiatedBy` and `lateCancel` (a customer cancel within `metricWindows.lateCancelHours` of the start; `false` for EGC or system cancels and for a visit that was never placed; `null` when nobody said who asked or the saved start cannot be read). |
> | `schedule.no_show` | A new final action for a placed customer **job** from one hour before its start, with a required `noShow` reason: `status: no_show`, `noShowAt`, `noShowBy`, `noShowReasonCode`; its day locks are freed and the provider appointment is **not** changed (a GHL no-show status can fire customer workflows; FUN-30 decides). A walkthrough no-show is the walkthrough visit's own outcome (FUN-05 `walkthrough.no_show`), so dispatch refuses it (`409 dispatch_no_show_walkthrough`). Readers treat a no-show as closed, like a cancel: the crew app leaves it out of *active* and refuses status, checklist, material, photo and crew cost changes (notes stay open; a manager can still record costs), a running job clock stops at `noShowAt`, and automatic payment and estimate-expiry reminders stop. The bridge cannot cancel a no-show (`409 schedule_terminal_visit_requires_review`). |
> | Bridge scheduler / adoption | `mutateScheduledVisit` records `bookingChannel: mcp` for integration actors (`null` for a human) and accepts optional `reasonCode` / `initiatedBy` on update and cancel (via `bridge`; the platform `schedule.mutate` schema does not carry them yet, so bridge cancels record `other_legacy`); cancelling an already cancelled visit keeps the original cancellation's time, actor and reason facts; its new projects record `highlevelContactId`. Bridge events carry the prepared bridge `via` (`mcp`, `portal` or `bridge`), the same one its `hub_audit` entry records. A newly adopted GHL self-booking is `walkthrough.booked` / `job.scheduled` with `channel: ghl_self_booking`, dated by the provider booking time (`clockSource: provider`, idempotency `ghlAdoption:<source>:<sourceId>`); a local-job adoption keeps its channel unknown, and an adoption that links a visit the Hub already booked writes nothing. |
> | Walkthrough handoff | `deal.sold` (amount and estimate revision, with the source `walkthroughId`) on the iPad signature time under the two-sided device bounds (walkthrough `startedAt` - 1 h, its scheduled date - 1 day, now + 5 min); a revision first writes `deal.approval_superseded` for the job's live sale (FUN-03 `funnelSale`: a portal or handoff sale, also one a legacy browser revision already marked superseded, never a staff-recorded approval, which has no sale), so sold minus superseded is the current contract. The handoff commit saves the new sale as the job's `funnelSale`. A walkthrough that has no outcome and was never Started (FUN-05) gets `walkthroughOutcome` with `outcome: sold_on_site` in FUN-05's shape (`finishedAt` and `clockSource` of the `deal.sold`, `performedBy`, `recordingStatus: null`, `requestId` = the handoff request, `deviceAt`, `occurrence {number, date, time, startAt, scheduleOccurrence}`, `repTime: not_started`, `source: walkthrough_handoff`) in the same commit. A Started walkthrough gets its outcome, completion and `walkthrough.completed` from its own Finish, and a recorded outcome is never overwritten. The new job's booking channel is `hub_in_person`. |
> | Recording approval | `scope.reviewed` in the same `:commit` as `reviewedWalkthroughScope` and its receipt (`applyRecordingApproval` takes an injected clock and the bridge `via` its audit entry records). |
>
> **FUN-37 in the repository** (the bridge funnel event feed, §4.3)
>
> | Where | What it does |
> |---|---|
> | `egc-platform/services/operations/src/hub-command-policy.ts` | `hub.funnel.events`, `hub.walkthrough.outcomes` and `hub.funnel.case` in the one bridge policy table: reads for an owner or manager, or an integration worker with a delegate the Hub verifies against `EGC_OPERATIONS_HUB_DELEGATES_JSON` (the delegate's current Hub role must be owner or manager). The shared wire formats: the feed cursor `f1~<recordedAt>~<eventId>`, the case cursor, the page limit (200) and the `types[]` limit (30, Firestore's `in` limit). `hub-commands.ts` holds the strict API schemas. |
> | `functions/_lib/funnel-feed.js` | The Hub reads, registered in `operations-hub-commands.js`. **Feed**: a keyset page on `(recordedAt, id)`, never an offset, oldest first; `nextCursor` is the last event delivered (the given cursor when none were), `hasMore` asks for the next page. Only *settled* events are served: recorded at or before `settledThrough` = now − 5 minutes (`FUNNEL_FEED_SETTLE_MS`), so an event whose commit lands after a later-stamped one is delivered before the cursor passes it. Every event therefore reaches a consumer at least 5 minutes after it is recorded (a Finish reaches FUN-09 about 5–6 minutes later). **Writer rule:** an event's `recordedAt` (the `funnelEventWrite` clock) must be taken at most 5 minutes before the commit that writes it lands; an event that commits later is permanently behind every consumer cursor, with no signal. A batch writer stamps each commit, never one time for a whole run: FUN-04's backfill, and today the recurring horizon loop (`recurring-plan-service.js` `extendHorizon` → `createOccurrence`), which runs up to 10 sequential `mutateDispatch` commits (each a scan, locks and a commit) with one shared `now`, each emitting `job.scheduled`; a slow Firestore can push a later occurrence past the window (follow-up: stamp each occurrence with its own clock). The window stays at 5 minutes rather than 2 for that reason. **Outcomes**: the feed over `walkthrough.completed`, `walkthrough.no_show` and the `deal.sold` of a signed handoff that set `sold_on_site`, joined (at the page's `readTime`) to the visit's `walkthroughOutcome` (current or archived occurrence, matched by the event's source request) for the reason (a `rescheduled` reason lives only there), recording status, the occurrence's `startedAt` (FUN-08) and `outcomeRevision` (the occurrence number, for the FUN-09 dedupe key). A sale that did not set the outcome (a revision, or a Started visit whose Finish records it) is scanned and skipped. A Finish or No-show whose visit record is gone or disagrees is still delivered from its event with `detail: 'event_only'` and a `detailReason`. A handoff sale whose visit record is gone (a jobs doc deleted through the legacy client SDK) cannot be told from a revision or a Started visit's sale, so it is never delivered as an outcome: it is listed in `unverified` (`{eventId, cursor, type, visitId, reason: 'visit_missing'}`) for a person to review. **Case**: `{projectId \| jobId \| highlevelContactId}` ordered by `(occurredAt, id)`; a job (or walkthrough visit) is its project's case, and one without a project is read by its own id. A project case also reads its source records' events by their own ids, because a walkthrough or job gets its `projectId` only when a project is made from it (`dispatch-service.js` back-fills the origin), so its earlier FUN-05 Start/Finish/no-show events carry only `walkthroughId`: the ledger query is one OR over `projectId`, the project's `sourceWalkthroughId` (as `walkthroughId`), its `sourceRecordId` when that is a job (as `jobId`), the key job's own id, and the walkthrough the source job or key job was made from (its `sourceWalkthroughId`, as `walkthroughId`) (`case.matches`). The last covers a rework booked from a legacy job that came from a legacy walkthrough: dispatch-service makes `project_<walkthrough>` with the job as `sourceRecordId` and no `sourceWalkthroughId`, and back-fills only the job, so the walkthrough's events carry only its id. The source job is read at the case's `readTime`. Page one takes its Firestore `readTime` (`asOf`) from its first read, and every page reads the job, the project and the events at that `readTime`, for up to 50 minutes. A cursor continues only its own case: its digest covers the whole cursor and the key, every page derives the case again from the key at the cursor's `readTime` and refuses a cursor that names another query, and a `readTime` more than a minute after now (`FUNNEL_CASE_CURSOR_SKEW_MS`; Firestore's clock is Google's, not the Worker's) is refused. The digest is not a secret; what a cursor can still choose (an older snapshot or a position within its own case) is what its reader could ask for anyway. Unknown projects and jobs are `404 hub_funnel_case_not_found`. **Projections** are allowlists: the event's identity, times and clock provenance, entity ids, actor, `via`, source collection, eligibility flags and the definitions' data fields minus any whose name marks a cost, pay, fee or margin figure (`privateFieldName`); never the fingerprint or the idempotency key. `source.id` is `null` when it is a private record id (`_egc_` receipts, `secure_` records) or carries the event's idempotency key, so request receipts (`dispatchOperations`, `walkthroughVisitOperations`, `walkthroughHandoffs`) never expose their `requestId`. That containment check cannot apply to a backfill key, which is `backfill:<collection>/<source.id>`: for a backfill event the feed shows only the source document id (the part of `source.id` before the first `:`, `null` when that is private), never a `<docId>:<field>:<subId>` sub-record such as a Stripe Checkout session id. Test and internal events stay in the feed, flagged. Errors are `hub_command_invalid`, `hub_funnel_cursor_invalid` (400), `hub_funnel_cursor_expired` (409, restart the case), `hub_funnel_storage_unavailable` / `hub_funnel_storage_incomplete` (503, retry). |
> | `firestore.indexes.json` | Adds `(walkthroughId, occurredAt)` and `(highlevelContactId, occurredAt)` for the case read; its OR query uses one index per branch: `(projectId, occurredAt)`, `(walkthroughId, occurredAt)` and `(jobId, occurredAt)` (deploy the indexes before calling it). |
> | `tests/firestore-emulator-funnel-feed.test.mjs` | The REST contracts on the Firestore emulator: keyset feed pages with the `types[]` filter and the settle horizon, the case's OR query paged at one pinned `readTime`, and pinned `batchGet` reads. |
>
> The platform consumer keeps only its cursor (for example in `sync_cursors`); anything it derives from the feed is rebuildable from the Hub by replaying from `sinceCursor: null`.
>
> **Runbook: a feed stuck on `503 hub_funnel_storage_incomplete`.** The feed fails closed on a `funnelEvents` row it cannot verify (malformed, or a `type` these definitions do not define, for example one written by a newer build or a preview deployment against the production project), and no cursor can pass it. If a consumer reports this code on more than a few retries: open the Hub's Pages Functions log and find `hub_funnel_storage_incomplete: funnelEvents row <id> …` (the error's `details.eventId` names the same row inside the Hub; the bridge relays only the code). A type from a newer build: deploy that build's definitions, and never delete the row. A malformed field: repair it in the Firebase console from its source record (`source.collection`/`source.id`), or copy the document to `funnelEventsQuarantine/<id>` and delete it from `funnelEvents`, noting why. The consumers resume from their own cursors; nothing else is needed.
>
> **FUN-08 in the repository** (scheduling constraints in the v2 extraction, §5 step 5)
>
> | Where | What it does |
> |---|---|
> | `egc-platform/packages/schemas/src/conversation-extraction.ts` | `schedulingConstraints` in the strict v2 model output: `preferredWeekdays {weekdays[]}`, `timeOfDay {dayParts[]}` (morning, midday, afternoon, evening), `notBeforeMention` and `notAfterMention {mention}`, `unavailableMentions[] {mention}` (at most 10), `crewSizeMention {people, mention}`, `durationHoursMention {hours, mention}` and `urgency {level}` (asap, soon, flexible). Each is null unless the transcript states it and carries its own `sourceQuote`; `mention` is the customer's own words, and no field holds a date. Extractions stored before FUN-08 read as `schedulingConstraints: null` (never extracted, which is not "none found"), and their new counters `droppedSchedulingConstraints` / `clearedSchedulingValues` read as 0. |
> | `egc-platform/packages/ai/src/conversation-extraction.ts` | The prompt asks for quoted constraints with the date words copied, never converted. Post-validation takes one constraint at a time. It is dropped when its quote is not a whole-word normalized substring of the transcript (or is only function words), when its `mention` is not words inside its own quote, or when it fails the strict schema. Weekdays, day parts, people and hours its words do not say are cleared, and a weekday list, day-part list or urgency left with nothing its quote says is dropped. Repeated unavailable mentions and any past ten are dropped. The constraints never enter the walkthrough scope the Hub stores (`walkthroughExtractionFromConversation`), so nothing customer-facing comes from them. |
> | `egc-platform/packages/ai/src/scheduling-constraints.ts` | Resolution in code, with no clock. `schedulingAnchorFromOutcome(item)` reads one `hub.walkthrough.outcomes` item: its `startedAt` (the outcome's own occurrence) gives the Denver date of that instant, so a Start at 23:30 Denver is that day, on daylight-saving days too. Without a Start it takes `occurrence.date`, the scheduled date, flagged `anchor_scheduled_date` (a visit signed or recorded without tapping Start). With neither, the anchor is unknown (`anchor_unknown`) and only dates with a spoken year resolve. The extraction's `occurredAt` (the upload time) is never read. `walkthroughSchedulingConstraints(extraction, outcome)` returns Denver dates: `notBefore.date` is the first acceptable day ("after X" is the day after X; "from X" or plain X is its first day), `notAfter.date` the last ("before X" is the day before X; "by the end of October" is the 31st), and `unavailable[]` is `{from, to or null, weekdays}`. "The end of October" names its last day for "by" and "before" alike (the 31st), is either the 21st or the 31st for "not until", and an absence "before the end of the month" runs through the 31st. A date range ("the 19th to the 23rd", "October 19 through 23", "Oct 19-23", "between the 19th and the 23rd") is one span; "10-19" alone is not read. Words people read two ways ("next Tuesday" said on a Monday, "next Monday" said on a Saturday or Sunday, "this weekend" said on a Sunday, "next weekend", "by next week", "not until the end of the month", a weekday said on that weekday) are `ambiguous` with `candidates`. Words it cannot read with certainty are `unresolved` with a `reason`: named holidays ("before Thanksgiving") until the resolver moves to the shared Denver calendar FUN-09 adds to `@egc/funnel-definitions`, "the end of the week", a weekday that does not match the date, a month (or a date in it) that ended up to 60 days back and a day of the month up to a week back (said about the past, never rolled to next year or next month). Both keep the quote for the phone person. Crew size and hours stay hints. Nothing in production calls the resolver yet: FUN-09 must call `walkthroughSchedulingConstraints(conversationExtractionSchema.parse(row.extraction.conversation), outcomeItem)` and attach the result to the follow-up task (an unparsed shape does not throw, but only a parsed one has clipped, validated mentions); FUN-11's proposer uses only resolved dates. |
> | Spoken-value support (same file) | `spokenUrgencies`, `spokenDayParts` and `spokenWeekdays` decide which values a quote supports. A negation among the four words before an urgency word ("not super urgent", "no need to rush", "not in a big rush") makes the quote flexible only; a negated part of the day ("not in the morning", "can't do mornings") is not supported; a negation ends at punctuation, so "No, it's urgent" is urgent. "Early" is the morning only when no later part of the day or date follows it. "Sat", "sun" and "wed" count only before a date or a part of the day, or beside another weekday. |
> | `tests/scheduling-constraints-anchor.test.mjs` | The cross-bridge contract: real FUN-05 visits (a Start at 23:30 Denver, and one on the fall-back day) and a real FUN-02 handoff signed without a Start, through the real FUN-37 outcome feed, into the platform anchor and resolver. |
>
> "Constraints dropped for lack of a supporting quote" (metrics B, AI notes quality) is `validation.droppedSchedulingConstraints`, counted over extractions whose `schedulingConstraints` is not null.
>
> Definitions 2026-09-28.2 added `vocabularies.crmLinkReasons`, the `instant` data type with `fromStartAt` / `toStartAt` on both reschedule events, `occurrence` on `job.no_show`, and the `walkthrough.restored` event type (a restored walkthrough cancellation is never labelled a job).
>
> **FUN-29 in the repository** (service line and funnel path on every project)
>
> | Where | What it does |
> |---|---|
> | `functions/_data/funnel-definitions.data.json` | `dimensionRulesVersion` (1) versions the derivation rules. `serviceLineSources.precedence` is `explicit`, `visitPurpose`, `businessAccount`, `catalogCategory` (every catalog category maps to a service line; the definitions test fails when the catalog gains an unmapped one), `relatedProject` (a repeat inherits the recorded line of the project it continues), `ghlGarageHelpRequested`, `salesExitService`, `legacyJobType`. `funnelPathSources.precedence` is `explicit`, `visitPurpose` (member visit), `bookingChannel` (`recurring_plan` → recurring, `b2b_hub` → B2B request, `portal` → rebook), `recurringSeries` (a recurring plan or a legacy visit cadence), `businessAccount` (B2B request), `walkthrough` (the project has, or was sold on, an on-site walkthrough), `repeat` (a repeat template, rebook request or previous project → rebook). A list of values (a legacy project's visits) decides only when the values the rules know agree. |
> | `functions/_lib/funnel-definitions.js` | `funnelServiceLine` gained the catalog and related-project sources and list inputs; `funnelPathFor` is its path twin (undecided is `null`: there is no unknown path; metrics use `funnelDimensionValue`); `dimensionRulesVersion()`. |
> | `functions/_lib/funnel-dimensions.js` | The one place that turns Hub records into rule inputs (`visitDimensionFacts`; the legacy mapping `legacyDimensionFacts` that FUN-04 and the backfill use), resolves them (`resolveDimensions`: a staff pick wins; an undecided value is `null`, never guessed; a staff "Not sure yet" is the explicit `unknown` bucket), and writes `projects/{id}` fields `serviceLine`, `serviceLineSource`, `funnelPath`, `funnelPathSource`, `dimensionRulesVersion`, `dimensionsUpdatedAt`, `dimensionsUpdatedBy` (`projectDimensionPatch`). An existing project changes only on better evidence: an undecided value takes any decided one, a staff pick replaces anything, a derived value replaces a derived value from a lower source, and nothing but a pick replaces a pick. `projectDimensionBuckets` gives the metric buckets (the project's current values, else `unknown`). |
> | Dispatch `schedule.create` | `booking.serviceLine` / `booking.funnelPath` are the optional one-tap picks. The new project gets the resolved values in the create commit; a visit that joins a project (a walkthrough's job, a rework) refines it under the project's revision in the same commit. `walkthrough.booked` / `job.scheduled` carry the project's values (a visit placed later reads them from its project). The Create job form pre-fills both from `GET /api/funnel-dimensions` (the same facts and rules, dispatcher only) and requires the tap only when nothing decides a value (a project that holds "Not sure yet" starts empty, so it is answered again); an untouched pre-fill is not sent, so the server derives it again with its real source. With `FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED=true` the pre-fill also reads the GHL field "Facebook - Garage Help Requested" (read-only, once per customer per form: later refreshes send `suggest=false`) to *suggest* junk removal or transformation. A suggestion left untouched is sent as `booking.serviceLineSuggested` and saved under the `ghlGarageHelpRequested` rule, so a visit purpose, business account, sold catalog lines or an earlier project still outrank it; only a changed select is saved as the staff member's pick. |
> | Other project writers | The bridge scheduler, GHL booking adoption and `portal.project.ensure` set both on the projects they create (no picks; existing records through the legacy mapping). A bridge update that first places a visit saved unscheduled books it with its project's values, as dispatch does. The Employee Hub booking wizard and MCP (`schedule.mutate` create) do not ask for the picks yet: their projects keep what the booking's own facts decide (often `null`) until later evidence (a signed handoff, a B2B link, a joining dispatch booking), or until the backfill fills what their records decide. A signed walkthrough handoff marks its job as sold on a walkthrough, passes its signed lines as catalog evidence, refines the walkthrough's project (the gameplan saves `serviceType: 'Garage transformation'`, so an undecided project becomes a transformation; a pick made at booking stays) and records the values on `deal.sold`. Linking work to a business account (`link_project`) refines the project to commercial B2B on the B2B path unless a pick or better evidence says otherwise; unlinking does not change recorded values. |
> | `scripts/backfill-project-dimensions.mjs` | Dry run by default. `--apply` fills only the dimension a project lacks, from the legacy mapping, with updateTime preconditions and a `dispatchOperations` receipt per commit; a recorded value is never replaced, and projects no Hub record decides are listed and stay unknown. |
>
> Definitions 2026-09-28.4 (the FUN-32 merge) add the `jobber` section (the Jobber cutover day, finding codes with their guard surfaces, and the HighLevel markers of Jobber-app records) and the `jobber_after_cutover` coverage reason to 2026-09-28.3 (FUN-20).
>
> Definitions 2026-09-28.5 (the FUN-36 merge) added the `change_order.proposed` event type, and 2026-09-28.6 (the FUN-29 merge) added `dimensionRulesVersion`, `serviceLineSources.catalogCategory` / `relatedProject` and `funnelPathSources` (FUN-29 built them as 2026-09-28.3; the merge renumbered them).
>
> Owner decisions that are still defaults in the definitions: holidays (US federal, actual date), the repeat window (30 days), the lost-reason list, the self-reported channel list and the cutover date (`eventIntegrity.cutoverDate` is `null` until FUN-02/03/33 ship, so every period reports `pre_cutover_history`). The Jobber cutover day (`jobber.cutoverDate`, FUN-32) is a separate owner decision and is also `null`.


Status: design only. No repository files were changed.
Revised 2026-09-28 against integration HEAD `eee1649`. HEAD includes P4-02, P1-03, P1-05, P1-07, CAT-DATA, BRIDGE, SEC-C, P3-01, P3-13, MCP-01, and P4-01 (which shipped the portal review-click tracking planned as P4-13). F-EXP is staged for merge.
Inputs:
- the four source maps (hub-lifecycle, ghl-platform, money-costs, walkthrough-flow);
- `maps/*.json` proposedUnits, `spec-*.md` and `orchestration-state.md`;
- the critic's review (37 corrections, 26 additions).

Section 1 records how each critic item was handled.

---

## 0. Summary for the owner

1. **One funnel, one key.** Every piece of sold work is a **project** (`projectId`). A project runs from the inquiry, through the walkthrough, quote, sale, schedule, visits, invoice and payment, to review and repeat business. It also carries the HighLevel contact id, which links it back to the lead and to ad spend.
2. **Every stage is a recorded event.** Every Hub write that moves a project also writes one immutable `funnelEvents` row in the *same* Firestore commit. Counts and timings come from those events. Amounts come from the ledgers (estimate revisions, the payment ledger, labor, expenses and Stripe). Nobody re-types a number.
3. **What counts as a lead.** A lead is an *inbound-demand event* classified by origin:
   - a website form receipt;
   - a Facebook lead-form submission;
   - a first call or text from a contact who has no open deal;
   - a phone booking with no earlier inquiry.

   A HighLevel "opportunity created" record is never counted as a lead, because the Hub creates opportunities itself. New demand is reported separately from repeat and account demand.
4. **From walkthrough to phone guy to schedule:**
   - The rep taps **Start walkthrough**, asks for recording consent, and the iPad records.
   - **Finish** requires an outcome. The to-do for the phone guy is created **at Finish, for every walkthrough**, even when the recording failed or the customer declined recording.
   - The AI job notes attach when they are ready. The phone guy confirms the *internal* notes.
   - A deterministic proposer shows the **3 best open slots**.
   - He can book a *job* only after the customer has approved a price. Otherwise he sends a quote or rebooks the walkthrough.
   - Before any booking, the confirm screen shows the exact messages the customer will receive. Nothing books or sends to a customer without that tap.
5. **Contribution per job is computed per sold project:**
   - It equals net revenue − (crew labor at real pay rates + OT premium + payroll burden + materials + dump fees + subcontract/other + Stripe fees).
   - Return, install and rework visits add their costs to the original project. Walkthrough time is an acquisition cost.
   - Each component is *final*, *provisional* or *unknown*. An unknown value is never counted as $0.
6. **"Give me the pulse on the business"** calls `egc.business_pulse`.
   - Hub numbers come from the Hub through the signed bridge, and lead and ad numbers come from the platform. Both sides use one shared definitions file.
   - The headline sentences are fixed templates filled in with the numbers, not AI-written.
   - Existing MCP tools that report sales or revenue from AI-extracted evidence are retired or re-sourced, so Claude cannot give you two different revenue numbers.
7. **Customer-facing automations get an inventory.** Several things already message customers automatically:
   - the Zapier AI text-back;
   - the GHL nurture workflows;
   - the portal invitation auto-queued after a handoff;
   - five browser auto-fires on save;
   - browser reminders.

   Each one is registered as an owner-approved fixed template or turned off (FUN-30).
8. **No Google Sheet as a source.** HighLevel is the CRM and the Hub is the source of truth. An optional export can come later. It would be generated, owner-only or aggregate-only, and never read back.

**What "100% accurate" means here:** every number equals the recorded events and ledgers as of `asOf`. Anything not fully recorded is labelled *partial* or *unknown*, together with a count and the list of records that make it so. It is never silently zero. Section 9.3 lists what cannot be guaranteed.

---

## 1. How the critic's findings were handled

| Item | Disposition | Where |
|---|---|---|
| C1 platform already has a lead funnel | **Partly accepted.** Adopted: FUN-14 extends the existing platform tables instead of adding a parallel `lead_events` table; AI-extracted `customer_events` are *evidence only* and never feed a Hub-owned pulse number; repeat inquiries get per-cycle granularity. **Not adopted as written:** changing `leads_contact_uq` to one row per cycle. `leads` keeps its per-contact meaning because lead-audit, customer-state, meta-conversions, the portal lead list and about ten MCP tools read it that way. Cycles become a child table `lead_cycles` (plus `lead_inquiries`), `customer_events` gets `cycle_id`, and `canonicalEventId` includes the cycle id. This gives the same result (repeat inquiries stop collapsing) without breaking any reader. | FUN-14 |
| C2 more MCP tools answer "pulse" questions | Accepted. Every listed tool is superseded, re-sourced or limited to lead-side facts. `egc.record_user_confirmed_outcome` refuses Hub-owned facts. | FUN-31, §8.4 |
| C3 Meta CAPI values come from Postgres | Accepted. CAPI downstream stages and values are driven by Hub events. | FUN-31 |
| C4 an inquiry is not an opportunity creation | Accepted. Inquiries are classified by origin, and Hub-created opportunities are marked and never counted. | §2.3, FUN-13/14/35 |
| C5 separate new demand from repeat demand | Accepted | §2.3, metrics A |
| C6 first touches and phone numbers outside GHL | Accepted. All four published numbers, the Zapier/Quo texts and `/api/quo-send` are covered. | FUN-16, FUN-30 |
| C7 Jobber is still a booking path | Accepted | FUN-32 (guard), FUN-04 (history mapping) |
| C8 to-do fires on the wrong event | Accepted. The to-do is created at `walkthrough.completed`, routed per outcome, with an alert task when a recording is missing or failed. The SLA clock starts at `finishedAt`. | FUN-09, §5 |
| C9 booking unpriced work | Accepted. Booking a job requires a current approval; otherwise the phone person can only rebook the walkthrough or draft a quote. | FUN-11, §5 |
| C10 AI notes reaching the customer | **Accepted, with a factual correction.** `portalInstructions` (employee-operations.js:149) is the *internal* Action Center dialog, and `customer-portal.js` does not read `reviewedWalkthroughScope` at HEAD. The risk is still real: `dispatch-service.js:376` copies `reviewedWalkthroughScope` onto jobs next to `customerInstructions`, and P2-07 quote drafts will take customer scope from it. The split is adopted: the phone role confirms `internalJobNotes`, and customer-visible scope stays with manager/owner. | FUN-10 |
| C11 gaps in the approval rule | Accepted. (a) The confirm dialog shows the exact template text from the FUN-30 registry. (b) Every GHL write that could fire a workflow is flag-gated until FUN-30 classifies it. (c) The phone role gets a scoped `followup.book` capability instead of `dispatch.write`. | FUN-11/12/30/35 |
| C12 existing automatic customer sends | Accepted | FUN-30, §10 |
| C13 five browser auto-fires; status overwrites | Accepted | FUN-27, FUN-04 |
| C14 atomic capture needs refactoring | Accepted. The portal and Stripe writers move to `:commit`, and idempotency-key conventions are defined. | FUN-01/03/33 |
| C15 paid-in-full can reopen | Accepted | FUN-33 |
| C16 rebook array is truncated | Accepted. `rebook.requested` is emitted at write time. | FUN-03 |
| C17 sale time has no lower bound | Accepted | FUN-01 clock rules, FUN-02 |
| C18 anchor for relative dates | Accepted. The anchor is `walkthroughVisit.startedAt`. | FUN-08 |
| C19 size limits and consent | Accepted | FUN-06, FUN-34 |
| C20 walkthrough labor never captured | Accepted | FUN-05 |
| C21 P1-03 as built | Accepted. Verified at HEAD: job-labor-cost.js:6 `JOB_COSTING_MAX_DAYS = 92` and :34 `includeTravel = false`. | FUN-21, §6 |
| C22 the contribution unit is the project | Accepted | §6 |
| C23 revenue by service is not available today | Accepted | FUN-29, metric coverage rules |
| C24 cash formula | Accepted | metrics E, §9 |
| C25 Stripe carries non-job charges | Accepted | FUN-17, FUN-25 |
| C26 CAC/ROAS definitions | Accepted | §6.6, metrics G |
| C27 one business calendar | Accepted | FUN-01 |
| C28 variance should measure person-hours | Accepted | metrics D |
| C29 pay privacy | Accepted | §8.3, FUN-22/23/24/28 |
| C30 deterministic headline | Accepted | FUN-22 |
| C31 in-progress comparisons | Accepted | FUN-22 |
| C32 consistent snapshot | **Accepted, with a limit.** A Firestore `readTime` read must fall within the last hour (7 days only with PITR enabled), so one pulse computation has to finish inside that window. FUN-38 rollups keep it short. | FUN-22, FUN-38 |
| C33 GHL stages echo the Hub | Accepted. GHL stage history is used for drift checks only. | FUN-14, FUN-25 |
| C34 no-show and cancel precision | Accepted | FUN-02, FUN-04 |
| C35 walkthrough show-rate denominator | Accepted | metrics B |
| C36 migration numbering | Accepted. The journal at HEAD ends at `0013_action_kinds_v2`, and 0014–0016 are contested (P3-03 against MCP-OAUTH/MCP-AUDIT). FUN-07, FUN-14, FUN-15 and FUN-34 take numbers at merge time. | §11 |
| C37 gift/credit writes are browser-owned | Accepted | FUN-36, FUN-27 |
| A1 service line and funnel path | Accepted | FUN-29, FUN-01 |
| A2–A5 sales, walkthrough-health, phone and capacity metrics | Accepted | §7, FUN-07/09/11/16 |
| A6 quality and risk | Accepted. `reworkOfJobId` goes in FUN-02, `damage_claim` in FUN-19, and CSAT in FUN-40 (optional). | |
| A7 Google rating | Accepted as optional. The rating is *unknown* until connected and is never inferred from clicks. | FUN-40 |
| A8 Garage Guard retention | Accepted | FUN-20 |
| A9 LTV | Accepted | metrics G |
| A10 B2B | Accepted | metrics I |
| A11 labor metrics and the Gusto invariant | Accepted | metrics F, FUN-25 |
| A12 cost capture beyond receipts | **Accepted, with a constraint.** The stocked-item cost must be a new owner-entered `standardUnitCostCents` in catalog settings. CAT-DATA retail prices are never cost. Commission and non-hourly pay become owner decisions. | FUN-19, FUN-21, §13 |
| A13 revenue edge cases | Accepted | §6 |
| A14 liabilities | Accepted | metrics E |
| A15 overhead and net profit | Accepted as optional | FUN-39 |
| A16 non-API spend and the leadgen check | Accepted | FUN-15, FUN-25 |
| A17 durable web-lead receipt | **Accepted.** It is a delivery receipt with a sealed payload that is deleted after sync, not a lead store. GHL stays the lead record, and the legacy Firestore `leads` collection stays closed. | FUN-13 |
| A18 sales-cycle and identity rules | Accepted | FUN-01, FUN-14, FUN-25 |
| A19 test and internal exclusions | Accepted | FUN-01, FUN-25 |
| A20 automation inventory | Accepted | FUN-30 |
| A21 re-point customer-state and CAPI | Accepted | FUN-31 (lead-audit classifier reused in FUN-14) |
| A22 Jobber guard | Accepted. History mapping stays in FUN-04 so there is only one backfill. | FUN-32 |
| A23 proposer constraints | Accepted | FUN-11 |
| A24 performance | Accepted | FUN-38, FUN-24 summary default |
| A25 privacy guards | Accepted | FUN-22 deny-list tests, FUN-10, FUN-24 |
| A26 more owner decisions | Accepted | §13 |
| Refuted "only client-side computation" | Accepted and corrected. Only contribution is client-side today. `operations-financials` already computes sold, completed and cash revenue on the server, and customer-state computes its own revenue, which FUN-31 removes from every pulse path. | |

Other changes since revision 1 (HEAD moved on):
- FUN-18 and FUN-21 build on P1-03, which is merged.
- FUN-11 uses the P1-07 travel estimates, which are merged.
- FUN-05 depends on P1-08 (the sales role), not P2-12.
- The bridge commands build on the merged BRIDGE registry, which uses `hub.<domain>.<verb>` names such as `hub.dispatch.overview`.

---

## 2. The funnel model

### 2.1 Keys

- **Project (`projectId`)** is the case and the unit of contribution.
  - Every `schedule.create` of a `walkthrough` or `job` ensures a project exists (FUN-02).
  - Existing projects keep the form `project_<walkthroughId>`.
  - A direct phone booking with no walkthrough gets `project_<jobId>`.
  - A repeat job gets a new project with `previousProjectId`.
  - A B2B request gets one project per request (`businessAccountId` + request id).
  - Each Garage Guard member visit and each recurring-plan occurrence is its own project, priced per visit (FUN-20, M12).
- **Visit purpose** is stored on every job doc: `visitPurpose`, one of `walkthrough | service | install | return | rework | member_visit`. It is set at booking (FUN-02). A rework visit carries `reworkOfJobId`, and a member visit carries `membershipId`.
- **Lead link**:
  - `highlevelContactId`, plus `highlevelOpportunityId` when one exists;
  - otherwise the explicit `crmLinkReason`, which counts the project as *unattributed*, never dropped;
  - the platform cycle id, joined through the inquiry.
- **Walkthrough → job**: `sourceWalkthroughId` / `convertedJobId`. Repeat lineage: `sourceTemplateJobId`, `recurringPlanId`, `sourceRebookingRequestId`.
- **Platform links**: `tasks.portal_visit_id` and `walkthroughs.portal_visit_id` hold the walkthrough id; `contacts.provider_id` holds `highlevelContactId`.
- **Identity**: P4-02 `phoneE164`/`emailLower` (merged). Merged or deleted GHL contacts are resolved through the existing `provider_mappings` / `customer_occurrence_aliases` tables. A project whose contact id no longer resolves becomes a data-quality item.

### 2.2 Who owns which fact

| Fact | Source of truth | Read by the pulse via |
|---|---|---|
| Ad spend | Meta / Google Ads APIs; owner-entered ledger for other channels | platform `ad_spend_daily`, `spend_entries` (FUN-15) |
| Contacts, conversations, calls, GHL pipeline | GHL (+ Quo lines, per FUN-16) | platform mirror |
| Web inquiry receipt | Hub `web_lead_receipts` + `inquiry.received` event (FUN-13) | bridge feed (FUN-37) → platform |
| Inquiry classification, sales cycles, first response | *derived* in platform `lead_inquiries`/`lead_cycles` (FUN-14) | platform |
| Follow-up to-dos | platform Action Center (`tasks`, `operation_events`) | platform |
| Recordings, transcripts, extraction | platform `walkthroughs` | platform |
| Walkthrough visit through job, quote, sale, invoice, payment, costs, reviews, repeat business | **Hub** | bridge (FUN-23/37); Hub screen directly |
| Charges, fees, refunds, disputes | Stripe → Hub payment ledger | Hub (reconciled to Stripe by FUN-25) |
| Labor | Hub employee vault timecards (P1-03 engine) | Hub |
| AI-extracted milestones (`customer_events`) | platform | **evidence only**: shown in timelines, never counted for a Hub-owned stage |

### 2.3 Demand: what counts as an inquiry (C4, C5)

An **inquiry** is an inbound-demand event. Opportunities are only a join key and are never counted.

| Origin | Recorded where | Timestamp | New or repeat |
|---|---|---|---|
| `web_form` (all lead-form pages, including ads.html after the fix) | Hub `web_lead_receipts/{inquiryId}` + `inquiry.received` event, written before the GHL sync | Hub `receivedAt` (server) | new unless the contact is an existing customer |
| `fb_lead_form` | GHL contact attribution (`facebookLeadId` / leadgen id) in the platform mirror | GHL `dateAdded` of that submission (provider) | same rule |
| `inbound_call`, `inbound_sms` | first inbound call or SMS from a contact with no open cycle (GHL mirror; Quo lines through FUN-16) | `calls.started_at` / `messages.occurred_at` | same rule |
| `phone_booking_without_inquiry` | `walkthrough.booked` for a contact with no inquiry inside the repeat window | booking `recordedAt` | same rule |
| `b2b_request` | `business_accounts.requests[]` | `requests[].createdAt` | new account → new; existing account → **account demand** |
| `portal_rebook` | `rebook.requested` event (FUN-03) | server | always **repeat demand** |

- **Existing customer** means the contact or customer (P4-02 identity) has at least one completed Hub project before the inquiry, or belongs to an active B2B account. Their inquiries are **repeat demand**. They are excluded from CPL and CAC denominators and reported as "Repeat and account demand".
- **Hub-created opportunities are marked.** `advanceOpportunity` creates them with `source:'egc-hub'` and records the id in a Hub receipt (FUN-35), so the platform never counts them.
- **Excluded everywhere** (FUN-01): test and internal contacts or jobs, vendors, hiring-calendar contacts, and the GHL tags `egc-test`, `test`, `internal`, `vendor`, `routing-canary`, `dnc` and `do-not-contact`. Also excluded: the source "EGC synthetic routing validation", Stripe `livemode=false` and `cs_test_` records.

### 2.4 Sales cycles (A18)

- A cycle opens on a qualifying inquiry from a contact who has no open cycle. There is **one open cycle per contact**, even when GHL holds the contact in both the junk and garage pipelines.
- A further inquiry within the **repeat window** (owner decision; default 30 days since the cycle's last activity) joins the open cycle.
- A cycle closes when its project records `deal.sold` (the project then carries the funnel) or `deal.lost`.
- A cycle with no event for 90 days is *reported* as expired. This is computed, never written.
- The cycle rules, the business calendar and the reason codes live in one definitions file that the Hub and the platform share (FUN-01).

### 2.5 Service line and funnel path (A1, C23)

- **Service line**: `garage_transformation` (organization/cleanout/reset), `junk_removal`, `garage_guard_visit`, `commercial_b2b`, `unknown`.
- **Funnel path**: `walkthrough`, `remote_photo_video_quote`, `direct_phone_booking`, `b2b_request`, `rebook`, `member_visit`, `recurring`.

Both are set on the project at booking (FUN-29) and pre-filled from:
- the GHL field "Facebook - Garage Help Requested";
- catalog categories on line items (after P2-05);
- `salesExitService` (garage vs junk);
- the legacy job type.

When none of these determines the value, the booking asks for one tap. The service line takes "Not sure yet" (the explicit `unknown` bucket); an undecided path stays `null`. The funnel path is pre-filled from the visit purpose (member visit), the booking channel (recurring plan, B2B hub, portal rebook), a recurring series, a business account, a walkthrough on the project, and repeat lineage, in that order. The rules are versioned (`dimensionRulesVersion`), and the same rules map existing projects through the legacy mapping (FUN-04, `scripts/backfill-project-dimensions.mjs`). FUN-29 in the repository (above) lists the writers. P2-05 itemized handoffs have shipped; their lines count as catalog evidence once they name catalog items, and until then a signed gameplan job is a garage transformation by its saved service name unless the booking recorded a pick.

---

## 3. Funnel stages

"Capture change" is what must change so the stage is recorded every time. All Hub timestamps are ISO UTC, and every event also stores its America/Denver date.

| # | Stage | Entered when | Source of truth | Timestamp | Capture change |
|---|---|---|---|---|---|
| S0 | Marketing spend (period input) | Daily spend per campaign or ad set; non-API channels monthly | Meta/Google Ads (provider); owner spend ledger (`attested`) | provider report date → Denver date | **FUN-15** |
| S1 | New inquiry | Inbound-demand event from a contact with no open cycle, classified by origin (§2.3) | Hub `web_lead_receipts` + GHL (FB forms, calls, SMS) + Quo lines; derived `lead_inquiries`/`lead_cycles` | web `receivedAt` (server); provider times for FB/calls/SMS | **FUN-13**: ads.html relay fix, `inquiryId`, durable receipt. **FUN-35**: structured attribution; Hub-created opportunities marked. **FUN-14**: classifier and cycles. **FUN-16**: every published number. **FUN-25**: leadgen check. |
| S1r | Repeat / account demand | Portal rebook, request from an existing B2B account, inquiry from an existing customer | Hub `rebook.requested`, `business_accounts.requests`; platform flag | server / provider | **FUN-03** emits `rebook.requested` at write time (the array keeps only 10 entries); **FUN-14** flags repeat |
| S2 | First touch / first human response | First automated touch and first human SMS/email/call after the inquiry | GHL mirror + Hub `message_sends` + Quo/Zapier (FUN-16) | `messages.occurred_at` / `calls.started_at` | **FUN-14** reuses the lead-audit classifier and counts Hub/MCP API sends as human (via `message_sends` ids / `userId`). **FUN-30** marks registered automations. Latency is reported raw and in business hours. |
| S3 | Walkthrough booked | Hub walkthrough visit created, or a GHL self-booking adopted | Hub `jobs` + `dispatchOperations` / `_egc_schedule_op_*` / `_egc_adoption_*` receipts | receipt `createdAt`; adopted: `adoptionOriginalBookingAt` (provider) | **FUN-02**: `walkthrough.booked` with channel, bookedBy, project, CRM link, service line/path (FUN-29). Auto-adoption is an owner decision. **FUN-25** flags unadopted GHL appointments. **FUN-32** flags Jobber requests created after cutover. |
| S4 | Walkthrough started | Rep taps **Start**; consent is asked; recording starts unless declined | Hub `walkthroughVisit.startedAt` + `walkthrough.started` | server; an offline replay uses the device time within bounds (`device_validated`) | **FUN-05** (API plus the rep's work segment), **FUN-06** (UI) |
| S5 | Walkthrough finished (outcome) | **Finish** with outcome `sold_on_site`, `quote_to_follow`, `not_interested`(+reason), `customer_no_show` or `rescheduled`; a signed handoff sets `sold_on_site` | Hub `walkthroughOutcome` + `walkthroughCompletedAt`; events `walkthrough.completed` / `walkthrough.no_show`; `not_interested` also writes `deal.lost` | server | **FUN-05/06**: the next Start is blocked until an outcome is recorded; **FUN-25** flags missing outcomes; show rate uses the final occurrence |
| S6 | Recording uploaded and processed, or declined/failed | Upload accepted; extraction reaches `draft`; or `recordingStatus` is declined/failed | platform `walkthroughs` (+ storage); Hub `walkthroughOutcome.recordingStatus` | new `uploaded_at`, `processed_at` | **FUN-06, FUN-07, FUN-34** |
| S7 | Follow-up to-do created | At `walkthrough.completed`, routed by outcome; an alert task when a recording is missing or failed | platform `tasks` + `operation_events` | `tasks.created_at`; the SLA clock starts at `finishedAt` | **FUN-09** (fed by FUN-37) |
| S8 | Notes confirmed / scope approved | Phone person confirms the internal job notes; manager/owner approves the customer-visible scope | Hub `walkthroughVisit.internalJobNotes` + `notes.confirmed`; `reviewedWalkthroughScope` + `operation_recording_approvals` + `scope.reviewed` | server | **FUN-10**, **FUN-02** |
| S9 | Quote drafted / revised | Estimate saved through a server path | Hub `estimate` + `moneyOperations` receipts (M3, P2-07) | receipt `createdAt` | M3/P2-07 call `funnelEventWrite`; the browser path is retired (**FUN-27**) |
| S10 | Quote sent | A human confirms the send | Hub `estimate.sentAt` + `message_sends` / `portal_invitations` | server | the P2-07 send emits `quote.sent`; **FUN-27** removes all five browser auto-fires |
| S11 | Sold | Portal e-sign, signed handoff, or staff-recorded verbal approval with amount, revision and evidence | Hub `customerApproval` + `walkthroughHandoffs` / `moneyOperations` | device time bounded on both sides / server / `attested` | **FUN-02** (handoff bounds), **FUN-03** (portal `:commit`), M3 `estimate.record_approval` → `deal.sold`; a supersede writes `deal.approval_superseded`; M14 revision binding |
| S12 | Lost / reopened | Lost with a reason code (including `not_interested` at Finish), or reopened | Hub `projects/{id}.outcome` + `deal.lost` / `deal.reopened` | server | **FUN-12**, **FUN-05**; the GHL status write is gated by FUN-30 |
| S13 | Deposit paid | Ledger entry of kind `deposit` | Stripe → Hub ledger (M3); offline via M3 | Stripe `charge.created` (provider); offline `receivedAt` (`attested`) | **FUN-33** (`:commit` refactor, kind rule), **FUN-17** (fees) |
| S14 | Scheduled / rescheduled | First placement on the calendar; every later move | `dispatchOperations` (before/after) | receipt `createdAt` | **FUN-02**: reason code, `initiatedBy`, occurrence counter. **FUN-11**: `proposalRank`/`proposalHash`. **FUN-25** flags GHL-side moves. |
| S15 | Crew assigned | Assignment changes | `dispatchOperations` | receipt `createdAt` | **FUN-02** `job.assigned` |
| S16 | Dispatched / arrived / started | Crew status taps | `jobs/{id}/fieldEvents` | `createdAt` (server) | **FUN-03** (structured from/to status, `dispatchedAt`); **FUN-18** (taps drive timecard segments) |
| S17 | Visit completed | Closeout gates pass | Hub `completedAt` + `fieldExecution.completion` | server | **FUN-03**; **FUN-19** (expense attestation) |
| S18 | Project closed | The last non-cancelled visit is completed and none is scheduled | computed from events; recorded once as `project.closed` (`clockSource: system`; `occurredAt` = the last completion) | last `completedAt` | **FUN-25** records it; **FUN-21** uses it as the contribution period date |
| S19 | Invoiced | M3 `invoice.issue` | Hub `invoice` + receipt | receipt | M3 calls the helper; **FUN-27** retires the browser path |
| S20 | Paid in full / balance reopened; refunds, disputes | The balance reaches 0 at the current revision; later reopened; a Stripe refund or dispute | Hub ledger + `stripe_events` | provider + `recordedAt` | **FUN-33** (`paid_in_full` bound to the revision, `balance_reopened`), **FUN-17** |
| S21 | Costs final | All inputs closed (§6.5) | FUN-21 engine | `project.costs_finalized` / `costs_restated` (`system`) | **FUN-21**, **FUN-25** |
| S22 | Review requested / clicked; CSAT | Approved review send; portal click; survey answer | `message_sends` (`review_request`); `jobs.reviewClicks` (shipped in P4-01); GHL review workflows count as automation | server | **FUN-03** (`review.clicked` event), **FUN-30** (GHL-side sends), **FUN-40** (optional CSAT and posted reviews) |
| S23 | Repeat: rebook, next job, membership | Rebook request; repeat booked; membership started, renewed, failed or cancelled | Hub rebook events, P1-05 recurring plans (merged), `memberships` + `stripe_events` | server / Stripe | **FUN-03**, **FUN-12** (`rebook.booked`), **FUN-20** |
| S24 | Cancelled, late-cancelled, no-show | Dispatch cancel; no-show action | `dispatchOperations`; events keep history after a restore | server | **FUN-02**: `reasonCode` next to the existing free-text `cancellationReason`; `lateCancel` computed when a customer cancels within 24 h of the start; a new `no_show` action (the statuses `noshow`/`no_show` are already recognized). **FUN-04** maps legacy data. |

---

## 4. Event ledgers

### 4.1 Hub `funnelEvents/{eventId}` (server-only, append-only)

```
id              'fe_' + sha256(type|entityId|idempotencyKey)[0:40]
schemaVersion   1
type            FUNNEL_EVENT_TYPES (funnel-definitions)
occurredAt      ISO UTC           clockSource  server|device_validated|provider|attested|system|backfill
recordedAt      ISO UTC (server)  denverDate   'YYYY-MM-DD' of occurredAt
projectId, jobId, walkthroughId, customerId, highlevelContactId, highlevelOpportunityId, businessAccountId
actor           {id, kind: human|integration|customer|system, role}    via  hub|field|portal|mcp|bridge|stripe|cron|backfill
data            typed payload: amountCents, estimateRevision, fromStatus, toStatus, reasonCode, initiatedBy,
                occurrence, fromStartAt, toStartAt, lateCancel, channel, channelSelfReported, method, kind, outcome, recordingStatus,
                proposalRank, proposalHash, visitPurpose, serviceLine, funnelPath
source          {collection, id}      // the authoritative receipt this event mirrors
isTest, isInternal   from the single eligibility function
```

**Types:**
- **Demand:** `inquiry.received`
- **Walkthrough:** `walkthrough.booked`, `walkthrough.rescheduled`, `walkthrough.started`, `walkthrough.completed`, `walkthrough.no_show`, `walkthrough.cancelled`, `walkthrough.restored` (FUN-02), `notes.confirmed`, `scope.reviewed`
- **Quote and deal:** `quote.drafted`, `quote.revised`, `quote.sent`, `deal.sold`, `deal.approval_superseded`, `deal.lost`, `deal.reopened`, `change_order.proposed` (FUN-36 `decision.prompt`), `change_order.approved`, `change_order.declined`
- **Money:** `payment.received`, `payment.refunded`, `payment.disputed`, `payment.dispute_closed`, `invoice.issued`, `invoice.voided`, `credit.issued`, `credit.redeemed`, `gift_card.sold`
- **Visit:** `job.scheduled`, `job.rescheduled`, `job.assigned`, `job.dispatched`, `job.arrived`, `job.started`, `job.completed`, `job.cancelled`, `job.restored`, `job.no_show`, `job.paid_in_full`, `job.balance_reopened`
- **Project:** `project.closed`, `project.costs_finalized`, `project.costs_restated`
- **After the job:** `review.requested`, `review.clicked`, `csat.received`, `rebook.requested`, `rebook.contacted`, `rebook.booked`
- **Membership:** `membership.started`, `membership.renewed`, `membership.payment_failed`, `membership.cancelled`, `membership.visit_used`

**Rules:**
- **Atomic writes.** `funnelEventWrite()` returns a `{collection, id, patch}` write with `exists:false`, like SEC-B `auditWrite()`. Callers add it to the `:commit` that changes the business record, so the event can never drift from the record.
- **Writers that must be converted first (C14).** These currently write a single document with `patchJob`, which cannot carry a second document, so they move to `:commit`:
  - `customer-payments` `recordStripeCheckout` / `recordCrewStripePayment`, today a single-doc `patchJob` with an `updateTime` precondition (FUN-33);
  - `customer-portal` `approve_estimate`, `respond_decision`, rebooking (:423), `record_review_click` and `apply_gift_credit` (FUN-03; converted: `commitDocuments` in `firestore-job.js`).
  - Dispatch, walkthrough-handoff, the recording approval and field execution already commit receipts; each writer is verified in its unit.
- **Idempotency keys** (FUN-01):
  - `requestId` wherever one exists;
  - the Stripe `event.id` (webhooks) or `sessionId` (checkout returns);
  - the GHL adoption `operationId`;
  - the portal `request_id`;
  - the backfill key `source.collection/source.id`. When one source document yields several events of the same type for the same entity (two `stripeSessions` on one job, several statuses rebuilt from one job), `source.id` names each sub-record as `<docId>:<field>:<subId>`, for example `jobs/job-1:stripeSessions:cs_live_x`, so each gets its own event id. The bridge feed (FUN-37) shows only `<docId>` as `source.id`, so a sub-record id such as a Checkout session id stays in the Hub.
- **Clock rules** (FUN-01, C17):
  - A device time is accepted as `device_validated` only if it is **≤ now+5 min** and **≥ max(walkthroughVisit.startedAt − 1 h, scheduled date − 1 day)**.
  - Outside those bounds it is stored as `attested`: counted, but excluded from timing metrics. An out-of-bounds device time is **never used as `occurredAt`**, because sold counts and revenue are bucketed by the Denver date of `occurredAt`:
    - before the bounds → `occurredAt` is the lower bound (or the server time, if the bound is later);
    - in the future, or with no bound to check (no start and no scheduled date) → `occurredAt` is the server time.
  - The raw device time is kept as `deviceAt` with the `clockReasons`, for review. A device-derived `occurredAt` therefore always lies in [`earliestOccurredAt`, now + 5 min], so a skewed or reset phone clock can neither move a sale into another day or month nor make the commit fail.
- **Reading.** Counts and timings come from events. Amounts come from the ledgers and the current approved estimate revision. FUN-25 proves that events and ledgers agree.
- **Access.** Firestore rules deny all SDK access. Owner and manager sessions read through the API, and platform consumers read through the bridge (FUN-37).
- **Indexes:** `(type, denverDate)`, `(projectId, occurredAt)`, `(jobId, occurredAt)`; for the feed, `(recordedAt, id)` (the automatic single-field index) and `(type, recordedAt)` for its `types[]` filter; for the case read, `(walkthroughId, occurredAt)` and `(highlevelContactId, occurredAt)`.
- **Backfill (FUN-04, dry-run by default):**
  - It rebuilds events from `dispatchOperations`, `_egc_*` receipts, `fieldEvents`, `walkthroughHandoffs`, `operation_recording_approvals`, `stripeSessions`, `customerOperations`, `business_audit`, the surviving `rebookingRequests`, `portal_invitations` and `message_sends`.
  - JOB-CUT history is imported with `source:'jobber'` and `clockSource:'backfill'`. Browser-written facts are imported as `attested`.
  - It **never infers paid, completed or reviewed from `status`**, because `review_requested` overwrites `paid`/`completed` (C13).
  - Legacy `noshow`/`no_show` statuses become `job.no_show`, and free-text cancel reasons become `reasonCode:'other_legacy'`.
  - It reports every fact it cannot recover. Periods before the cutover date report `coverage.reasons: ['pre_cutover_history']`.

### 4.2 Platform: extend `leads` / `customer_events` (FUN-14; no parallel funnel)

- **`lead_inquiries`**, one row per inbound-demand event: `id, workspace_id, lead_id, contact_id, origin, source_record_id` (Hub inquiryId, GHL leadgen id, message/call id), `occurred_at, clock_source, is_repeat_demand, cycle_id, rule_version`.
- **`lead_cycles`**, a child of `leads`: `id, lead_id, opened_by_inquiry_id, opened_at, closed_at, close_reason` (sold, lost, or expired as computed), `hub_project_id, first_automation_touch_at, first_human_response_at, first_human_actor, rule_version`.
- **`customer_events.cycle_id`**. `canonicalEventId` includes the cycle, so repeat inquiries no longer collapse.
- **First response** uses the existing lead-audit call/SMS classifier, with one correction: sends that carry a Hub `message_sends` id or a staff `userId` count as human even when GHL reports `source:'api'`. Registered automations from FUN-30 count as automation touches.
- **Evidence-only rule.** AI- or regex-extracted `customer_events` (`job_sold`, `revenue_collected`, `walkthrough_completed`, `quote_delivered` and similar) are never inputs to a pulse number for a Hub-owned stage. The report layer enforces this in code, and a test proves it.
- **GHL opportunity stage history** is kept only to check drift against the Hub. Hub-written stages are never evidence (C33).

### 4.3 Bridge feed (FUN-37)

- `hub.funnel.events {sinceCursor, types[], limit}` is a cursor on `(recordedAt, id)`.
- `hub.walkthrough.outcomes {sinceCursor}`.
- `hub.funnel.case {projectId | jobId | highlevelContactId}`.

Projections exclude every cost, pay, fee and margin field. The feed drives the FUN-09 reconciler, the FUN-14 cycle closure and FUN-31 CAPI.

As built (see *FUN-37 in the repository* above): owner, manager and delegated integration reads; keyset cursors, never offsets; only events recorded at least 5 minutes ago are served, so a writer must stamp `recordedAt` within 5 minutes of its commit and every consumer sees an event 5 or more minutes after it is recorded; case pages share one Firestore `readTime` and include the events of the project's source records.

---

## 5. Walkthrough → phone guy → schedule

1. **Booking.** The phone guy books the walkthrough in the Hub, or the customer self-books in the GHL walkthrough calendar and the Hub adopts it.
   - `walkthrough.booked` records the channel, the booker, the service line and the path.
   - If the contact has no web or FB attribution, the booking form requires "How did you hear about us?" (one tap). The answer is stored as `channelSelfReported` (`attested`).
   - After the Jobber cutover, no walkthrough is booked in Jobber (FUN-32 flags any that are).
2. **Start on site (iPad, Hub gameplan).** The rep taps **Start walkthrough** and reads the one-line consent prompt ("Everyone present agrees to a recording"). The rep then taps **Recording OK** or **Customer declined recording**. The Start tap:
   - records `startedAt`;
   - opens the rep's *work* timecard segment on the walkthrough visit id, prompting clock-in first if needed (C20);
   - starts `MediaRecorder` when consent is given: `audio/mp4` AAC on Safari via `isTypeSupported`, about 48 kbps, and a real file extension;
   - holds a screen wake lock;
   - saves the audio chunks to IndexedDB every second;
   - warns on screen lock or backgrounding and starts a new *part* on resume;
   - **rolls over to a new part at about 20 MB or 20 minutes**, instead of stopping at 23 MB (C19).
3. **Finish (one required screen).** The rep picks the outcome: *Signed on site* (goes to the existing signed handoff and deposit), *Quote to follow*, *Not interested* (reason), *No-show* or *Rescheduled*.
   - The Finish commit writes `walkthrough.completed` (or `walkthrough.no_show`), plus `deal.lost` for *Not interested*, and closes the rep's segment.
   - The parts upload in order with a progress bar, retrying with the same `requestId`. The chunks are deleted only after the server confirms.
   - An **"Unsent recordings on this iPad"** badge stays until everything is uploaded.
   - A Voice Memos `.m4a` can be uploaded instead. Files over 24 MB are segmented on the server (FUN-34).
   - If recording was declined, the rep types three short notes on the Finish screen instead.
   - The next Start stays blocked until this walkthrough has an outcome.
4. **The to-do is created at Finish, not at extraction (C8).** The platform reconciler reads `hub.walkthrough.outcomes` every 60 s and routes by outcome. The feed serves only events recorded at least 5 minutes ago (FUN-37), so a task appears about 5–6 minutes after Finish; the SLA clock still starts at `finishedAt`:

   | Outcome | Task for the phone person |
   |---|---|
   | `quote_to_follow` | **Quote and follow-up** |
   | `sold_on_site` | **Confirm-only callback**: details and deposit status |
   | `customer_no_show` / `rescheduled` | **Rebook walkthrough** |
   | `not_interested` | none (the lost reason is already recorded) |

   - **Due time**: `finishedAt` + the policy minutes, counted in business hours from the single FUN-01 calendar.
   - **Owner**: from the P3-04 policy.
   - **Dedupe key**: `stableUuid('walkthrough:<visitId>:followup:<outcomeRevision>')`.
   - **Alert task**: if a recording was expected but none has arrived after 2 business hours, or processing failed or ran out of attempts, an alert task goes to the rep and a manager: "re-upload or type the notes". No walkthrough can fall through silently.
5. **AI notes attach when ready.** After transcription and extraction, the reconciler edits the task (as the integration actor) to add:
   - deterministic **Job notes** labelled *AI draft – confirm*;
   - the recording link;
   - `schedulingConstraints`. Every constraint carries a `sourceQuote`, which must be a normalized substring of the transcript or the constraint is dropped. Relative dates are resolved in code against **`walkthroughVisit.startedAt`** (C18). Upload time is never used; a standalone upload falls back to the scheduled date, flagged.
6. **The phone guy works it (Hub "My follow-ups", mobile).** He calls the customer and confirms the **internal** job notes with one tap, which writes `internalJobNotes` and `notes.confirmed` (FUN-10). Customer-visible scope is approved only by a manager or owner (the existing recording approval, `scope.reviewed`). The proposer shows **3 slots**. Booking is gated by what the customer has approved (C9):

   | Case state | What the slot tap can do |
   |---|---|
   | A current `customerApproval` exists (portal e-sign or signed handoff) | Book the **job** |
   | The customer gives a verbal yes on the call | The phone guy records a staff verbal approval (M3 `estimate.record_approval`) with amount, estimate revision and evidence (call id or note). That writes `deal.sold` with `clockSource:'attested'`, and the job can then be booked. The approval or deposit link goes out only as an approved send. |
   | No approval | The tap can only **book a walkthrough** (for rebook tasks) or open a **P2-07 quote draft** (sent by an explicit human send). A job is never scheduled before a sale. |
7. **Confirm and book.** The dialog shows:
   - customer, time, crew and duration;
   - **the exact text of every customer message this booking will trigger**, taken from the FUN-30 automation registry (the GHL confirmation and reminder workflow templates) or from the MSG-CORE preview;
   - a notify toggle. Booking with notify ON is blocked if any triggered workflow is unregistered.

   The tap goes through the scoped `followup.book` capability (C11c):
   - The Hub checks over the operations bridge that the task is open, owned by the caller and linked to this visit.
   - It then calls `mutateDispatch schedule.create/update` with `requestId = uuid(taskId|slot|crew)`, `sourceWalkthroughId` and `proposalHash`.
   - It cannot cancel other jobs or reassign crews outside the proposal.
   - A 409 conflict recomputes the proposal.
   - On success the task auto-completes with `{jobId, dispatchRequestId, proposalRank, proposalHash}`, and `job.scheduled` (or `walkthrough.booked`) is emitted.
8. **Other outcomes.**
   - *No answer*: snooze, which logs an attempt.
   - *Customer declined*: **Lost** with a reason, which writes `deal.lost`. The GHL opportunity status write stays flag-gated until FUN-30 confirms that no customer workflow fires on it.

### 5.1 Auto-scheduling approach

**Use a deterministic opening finder, fed by LLM-extracted constraints, with one human tap to approve. An LLM never picks the time, and nothing auto-books.**

How the proposer works (`functions/_lib/schedule-proposal.js`):
- **Kind**: a job, or a walkthrough on the reps' calendars.
- **Duration**: from `quote-duration.js` (line items → `estimatedDurationMin` → default). AI-extracted hours and crew size are shown only as flagged hints.
- **Crew**: size and skills from P1-DS-06 when it exists, otherwise `crewNeeded` from the estimate. Vehicle or dump trailer via `vehicleId`.
- **Travel**: padding from the P1-07 estimates (address/zip), which are merged.
- **Time of day**: the customer's preferred arrival window.
- **Window**: `dispatchOpenings` from max(today, notBefore). It pages 14-day windows up to 6 weeks and returns **"no opening in N days"** as its own signal (A5).
- **Ranking**: unavailable dates are removed; preferred weekdays come first, then the earliest slot. It returns the top 3 with the dispatch revision, `asOf` and a `proposalHash`.
- **Multi-day jobs** are flagged and routed to the dispatcher, because `dispatchOpenings` accepts only single-day windows.
- **Freshness**: the proposal is computed when the task is opened and never stored, so it cannot go stale. The hash of the chosen proposal is stored on the booking receipt, so proposal acceptance can be audited (A23).

Why this approach:
- **Accuracy.** `dispatchOpenings` reads authoritative jobs, day locks, the dispatch revision, availability and blocked days in a consistency-checked snapshot, with DST handling. An LLM can invent free time, mis-resolve "next Tuesday", or follow prompt text hidden in a transcript.
- **Conflict safety.** The final write is always `mutateDispatch`'s atomic commit, so even a stale proposal cannot double-book.
- **The approval rule.** Booking triggers customer messages, so a human tap is mandatory in either design.
- **Testing and cost.** The finder is reproducible, testable with an injected clock, and free per proposal.
- **Where the AI helps.** The model's job is extracting constraints with visible quotes.

MCP later reuses the same proposer (P1-DS-15 `egc.find_openings`), and books only through the SEC-B two-step confirm (D-005).

---

## 6. Contribution per job (unit = sold project)

### 6.1 Unit and period (C22)
- **The unit is the project.** Its visits (`service`, `install`, `return`, `rework` through `reworkOfJobId`) are cost carriers. Contract value lives on the job that holds the approved estimate.
- **Rework and callback visits** add their cost to the original project, which lowers its contribution.
- **Walkthrough-type docs are excluded.** Their labor goes to acquisition cost (§6.6).
- **Member visits and recurring occurrences** are their own projects, each priced per visit.
- **Period**: the Denver date of `project.closed`, which is the completion of the last visit. Every component is pinned to the project, whatever its own date (timecard workDate, `incurredOn`, `verifiedAt`).
- **Cancelled projects** stay in contribution when they kept money or used labor (A13). This covers a forfeited deposit, a cancellation fee, and a crew dispatched to a lockout. Their period is the cancel date.

### 6.2 Formula (integer cents)

```
contributionCents = netRevenueCents − directCostCents          marginPct = contributionCents / netRevenueCents

netRevenueCents = contractCents            approved estimate revision, selected lines (money-core quoteCents),
                                             including explicit discount/adjustment lines (P2-05)
                + approvedChangeCents      money-core, unless the revision already carries that decisionId (P2-11)
                + retainedCancellationCents forfeited deposit / cancellation fee (owner policy)
                − contraCreditCents        credit redemptions of class courtesy | referral
                − refundCents              Stripe refunds (FUN-17) + recorded offline refunds
                − writeOffCents            M3 void/write-off with a reason
                − salesTaxCents            only if tax applies (owner/accountant); otherwise product lines are flagged
  Tips are excluded on BOTH sides: never revenue, never labor cost.
  Purchased gift cards and Garage Guard credit are payments, not contra-revenue.
  member visit: contractCents = allocated membership revenue per visit (FUN-20, owner decision)
  recurring:    contractCents = pricePerVisitCents (M12); until then 'unknown', never $0

directCostCents = laborCents + burdenCents + materialsCents + disposalCents + subcontractCents
                + otherDirectCents + processingFeeCents − recoveryIncomeCents [+ vehicleCents if enabled]
```

### 6.3 Components and sources

- **laborCents** comes from P1-03 `computeJobLaborCost` (merged).
  - It is called per visit over **that visit's own work-date span**, chunked to ≤92 days. Chunk boundaries align to the configured workweek start, so each call sees whole employee-weeks and the OT premium allocation stays correct. A test proves that the chunked total equals a single-range computation (C21).
  - `includeTravel` comes from the owner setting (recommended: on). The engine default is `false`.
  - Labor = segment minutes × the snapshotted `timecard.hourlyRate`, plus the OT premium allocated by hours within the employee-week.
  - Segments come from crew taps and FUN-18 auto-attribution.
  - Owner and non-hourly labor is costed at the owner shadow rate or the non-hourly rule (owner decisions), otherwise *unknown*.
  - Bonus allocation to jobs is an owner decision. Bonus already raises the OT regular rate inside P1-03.
- **burdenCents** = laborCents × burdenRate. The rate is an effective-dated setting (accountant-supplied, or a Gusto read-back later), with no default.
- **materials / disposal / subcontract / other / recoveryIncome** = Σ F-EXP `fieldExpenses` (status recorded, state applied) by kind (FUN-19).
  - The closeout **"None"** tap per kind makes a known 0.
  - A shared dump load is split across jobs by explicit shares.
  - `payer: crew_reimbursable` entries are never *also* counted as labor.
- **Stocked items** (shelving, totes, racks) use the owner-entered catalog `standardUnitCostCents` per item used, marked *provisional* until an actual expense replaces it. CAT-DATA `retailPrice*`, `split.productCents` and `split.laborCents` are **price, never cost**.
- **processingFeeCents** = Σ Stripe `balance_transaction.fee` for the project's charges + dispute fees − refunded fees (FUN-17).
  - The fee on a tip portion goes to a separate "tip processing" overhead line (owner decision), not the job.
  - A non-Stripe processor needs a manual fee entry, otherwise the component is *unknown*.
- **vehicleCents** = P1-07 estimated miles × costPerMile, only if the owner enables it. Otherwise it is listed as *excluded*, never 0.
- **Sales commission** per sold project is an owner decision. If adopted, it is a direct cost from a commission rule.

### 6.4 Precedence (never double count)

| Component | Primary | Allowed fallback (flagged) | Never used as cost |
|---|---|---|---|
| Labor | P1-03 segments × rate | `costs.labor` only as a manager override with a reason when P1-03 finds zero segments (`manual_override`, provisional) | the $20/crew-hour constant, `hoursOnSite`, CAT-DATA `laborCents` |
| Materials / disposal / other | F-EXP + closeout attestation | `costs.*` only for projects closed before the cutover date (`manual_legacy`, provisional); `standardUnitCostCents` for stocked items (provisional) | CAT-DATA retail or `productCents` |
| Fees | Stripe balance transaction | `costs.processing` for non-Stripe processors | a 3% estimate |
| Revenue | approved estimate revision (money-core) | none | `invoice.amount`, `j.total‖priceQuoted`, GHL `monetaryValue`, platform `customer_events.value_cents` |

### 6.5 Status and burden
- **final**: every input is closed. That means:
  - the employee-weeks containing the project's segments are approved;
  - no receipts are pending;
  - closeout is attested on every visit;
  - fees are known;
  - the burden rate is set;
  - the project is closed.
- **provisional**: a value exists but can still change: a pending or in-progress week, burden not yet set, a legacy manual cost, a standard-cost stocked item, or an open project. The reasons are listed.
- **unknown**: a required input is missing. The component is `null`, and the project's `contributionCents` is `null`, with `partialKnown{revenueCents, knownCostCents, missing[]}`.
- **Burden**: until the rate is supplied, labor shows as "before burden" with status *provisional* and reason `burden_rate_unset`. The rate is effective-dated so that past periods restate correctly.
- **Restatement**: a later refund, timecard edit or expense change writes `project.costs_restated`, and period reports show `restatedSince`.

### 6.6 Acquisition economics (per channel and cohort, not per project) (C26)

```
walkthroughLaborCents(case) = P1-03 labor on walkthrough visit ids (segments opened by FUN-05 Start/Finish)
cohortCAC(channel, M)       = (spend(channel, M) + walkthroughLabor of cycles opened in M)
                              / newCustomers whose first deal.sold came from cycles opened in M   [maturity: M+60 days]
blendedCAC(channel, period) = (spend + walkthroughLabor in period) / new customers with first deal.sold in period  (labelled blended)
revenueROAS                 = sold revenue of new-customer projects attributed to channel / spend(channel)
contributionROAS            = contribution of those projects / spend(channel)   (inherits contribution status)
contributionAfterAcquisition= Σ contribution − walkthroughLabor − spend
LTV (realized)              = Σ project contribution + membership contribution per customer to date
LTV:CAC; CAC payback months = cohortCAC / average monthly contribution per acquired customer
```
- Phone-rep time is not captured per lead and is listed as *excluded*.
- Repeat and account demand is never in the denominator.
- CAC and CPL are *understated* until non-API spend is entered (FUN-15), and this is disclosed.

### 6.7 Unknown today (so contribution is honestly *unknown* or *provisional* until these are fixed)
- **Labor inputs:** no burden rate; owner and non-hourly labor not costed; sparse job-segment taps (hours default to "general").
- **Stripe:** no fees, refunds or disputes recorded.
- **Recurring and membership revenue:** recurring occurrences unpriced (M12). Garage Guard amounts are stored and member visits are counted from FUN-20 (counting is behind `GARAGE_GUARD_VISIT_TRACKING_ENABLED`); a membership recorded before FUN-20 has no billing period until its next renewal, so its deferred revenue and MRR stay unknown (`noLedger`). A billing period whose visits the ledger did not track throughout (the flag off, or the membership not linked to a Hub customer, at any of its Stripe events, or visits counted in the browser dialog) has unknown utilization, deferred revenue and breakage (`visitsUntracked`, `unknownUsed`, `unknownBreakage`); so does a period that closed with a completed member visit nobody had counted yet (until it is counted or settled), and a period whose plan changed mid-year once a visit follows the change. The visits used, visit revenue and recognized revenue of any range that such a period overlaps are unknown too, even in a month where no period closes (`unknownVisits`), and so are those of any range in which a member the ledger did not follow from its start may have been live without a ledger year (a live member with no period, or a range before its first ledger year that it had not cancelled before), those of an open year whose account job shows a browser visit count that no Stripe event has flagged yet (the GET view reads the account jobs), and those of any range ending after a member's ledger fell out of step with Stripe (a `ledgerError`, a missed renewal or an unclosed cancellation). The A8 revenue totals are then null, not partial sums.
- **Cost capture:** F-EXP not yet merged; subcontractor and vehicle costs not modelled; no standard cost for stocked items.
- **Owner decisions pending:** sales tax, commission and bonus allocation.
- **Current computation:** manual costs treat unknown as $0 (HEAD `jobEconomics`), and the only contribution computation today runs client-side.

---

## 7. Metrics catalog

Every metric uses the envelope `{key, label, value, unit, status: complete|partial|unknown, coverage{included, excluded, reasons[]}, asOf, compare?, drill}`.
- Ratios return `{num, den, value}`, and `unknown` means `value: null`.
- Counts come from events, and money comes from ledgers.
- Buckets are Denver days and Mon–Sun weeks.
- Everything passes the single FUN-01 eligibility function.
- Every metric can be grouped by service line and funnel path.

### A. Demand and marketing (platform, joined to the Hub through the bridge)
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| New inquiries | count of `lead_inquiries` of new-demand origins that opened or joined a cycle, by Denver date and origin; Hub-created opportunities are never counted | partial while any published number is not ingested (FUN-16), if GHL sync lag is >10 min, or if FUN-25 leadgen/receipt checks fail; ads.html leads are *unknown* before FUN-13 | owner, manager, phone |
| Repeat and account demand | count of portal rebooks + requests from existing B2B accounts + inquiries from existing customers | complete for Hub sources; identity-dependent (P4-02) | owner, manager |
| Inquiries by channel (first touch) | new inquiries grouped by structured attribution (FUN-35 fields, else `lead_original_attribution`, else `channelSelfReported`), with an explicit `unknown` bucket | partial when unknown is >10% (share shown) | owner |
| After-hours inquiry share | new inquiries outside the FUN-01 business calendar / all new inquiries | inherits | owner |
| Ad spend | Σ `ad_spend_daily.spendCents` + Σ `spend_entries` by channel | unknown if a platform is not connected; partial for missing days or inside the 3-day restatement window; manual channels flagged `attested` | owner |
| Cost per lead | spend(channel) / new inquiries(channel) | null if spend or attribution is unknown | owner |
| Speed to lead | median/p90 minutes from inquiry to first human response, **raw and business-hours adjusted**; % within 5 and 60 business minutes; first automation touch reported separately | partial where the actor is unclassified or the line is not ingested | owner, phone |
| Calls and missed calls per number | inbound, answered, missed (answered=false) and unknown-outcome (null) per published number; missed-call callback time = missed inbound → first human callback | unknown outcomes always shown; partial per number until FUN-16 | owner, phone |
| Lead → walkthrough booked (cohort) | cycles opened in the cohort with `walkthrough.booked` within 30 days / cycles opened | cohort immature until 30 days; unattributed Hub projects listed | owner |

### B. Walkthrough pipeline
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| Walkthroughs booked | count of `walkthrough.booked` by channel and booker | partial if FUN-25 finds unadopted GHL appointments or FUN-32 finds Jobber requests | owner, manager |
| Walkthrough show rate | on each walkthrough's **final occurrence** dated in the period: completed / (completed + no_show); reschedules are never no-shows (a `walkthrough.completed` with outcome `rescheduled` counts in neither); customer cancels within 24 h shown as a separate *late cancel* bucket | partial while any past walkthrough lacks an outcome (count listed); unknown before FUN-05 | owner |
| Walkthroughs completed | count of `walkthrough.completed` with outcome ≠ `rescheduled` | same | owner, manager |
| Recording coverage and pipeline health | completed walkthroughs with a processed recording / completed walkthroughs (declined shown separately); upload lag (finishedAt → uploaded_at); processing failure rate by error code | unknown before FUN-07 timestamps | owner, manager |
| AI notes quality | % of internal notes confirmed without edits; fields changed; constraints dropped for lack of a supporting quote | post FUN-08/10 | owner |
| Follow-up SLA and timeline | % of follow-up tasks with a first attempt before due; medians of finish → to-do → first attempt → booked; **walkthroughs with no follow-up task (must be 0)** | unknown while the reconciler flag is off | owner, phone |
| Follow-up outcomes | distribution of task outcomes (booked, quote sent, lost, rebook) and attempts per booking | post FUN-09/12 | owner, phone |

### C. Sales
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| On-site close rate | `sold_on_site` / completed walkthroughs | partial while outcomes are missing | owner |
| Walkthrough → quote rate | completed walkthroughs with `quote.sent` within 14 days or `sold_on_site` / completed walkthroughs | cohort maturity | owner |
| Walkthrough → sold (30 days) | projects with `deal.sold` within 30 days of completion / completed walkthroughs | cohort maturity | owner |
| Quotes sent and quote close rate | count of `quote.sent`; sold among quotes sent in the cohort / quotes sent; median walkthrough → quote sent | pre-cutover browser "sends" excluded (flagged) | owner, manager |
| Sold projects and sold revenue; average ticket | count of `deal.sold`; Σ amountCents − Σ `deal.approval_superseded` by the Denver date of occurredAt; average = revenue / count | complete after cutover; `attested` counted but excluded from timing | owner, manager |
| Rep performance | close rate, average ticket and estimate accuracy per walkthrough rep (`walkthroughOutcome.performedBy`) and per phone person (follow-up owner or booker) | reps see only their own rows | owner; each rep (own) |
| Lost by reason; stalled | count of `deal.lost` by reasonCode; stalled = open projects with no event for 21 days (computed) | complete once recorded | owner, phone |
| Sales cycle length | median days inquiry → sold and walkthrough → sold | excludes `attested`/`backfill` timings; partial without a lead link | owner |
| Proposal acceptance | bookings with a proposalRank / bookings from follow-ups; rank distribution (audited by proposalHash) | post FUN-11 | owner |

### D. Operations and capacity
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| Sold-not-scheduled backlog | projects with `deal.sold` and no `job.scheduled`, not cancelled; count and Σ contract cents | complete | owner, manager, phone |
| Booked future revenue | Σ approved contract cents of scheduled, non-cancelled visits in [today, today+14/30] | recurring occurrences without a price are *unknown* until M12 | owner, manager |
| Forward booked capacity; first bookable slot | scheduled crew-hours / available crew-hours for the next 7/14 days (weekly availability − PTO − blocks); first opening for a standard 1-crew × 4 h job (default crew) | unknown until P1-08 weekly availability; "no opening in N days" shown | owner, manager |
| Days to schedule; lead time | median sold → first `job.scheduled`; median scheduled → service date | timing excludes `attested` | manager |
| Visits and projects completed; completed revenue | count of `job.completed` and `project.closed`; Σ net revenue of closed projects | complete for server closeouts | owner, manager |
| On-time arrival | `job.arrived` inside [arrivalWindowStart, arrivalWindowEnd] / arrivals with a window | only jobs with windows (others counted as excluded) | manager |
| Duration and labor-hours variance | elapsed: (jobTime work minutes − estimatedDurationMin)/estimate; **person-hours: (P1-03 work person-hours − estimatedDurationMin × crewSize)/estimate, grouped by estimator** | `jobTime.needsReview` and untracked-heavy jobs excluded and counted | owner, manager |
| Reschedules, cancellations, late cancels, no-shows | counts by reasonCode and initiatedBy; cancellation rate = cancelled / scheduled | pre-cutover reasons are `other_legacy` | owner, manager |
| Crew utilization by role | scheduled hours / available hours, separately for crew, walkthrough/sales and phone; billable ratio = job-attributed work hours / paid hours | provisional while timecards are pending; unknown without availability | owner, manager |
| Revenue per crew-hour | completed revenue / job-attributed work hours | partial when untracked hours are >10% of paid hours (share shown) | owner |
| Quality and risk | field issues opened/resolved; approved change-order Σ cents; **rework rate and rework cost** (via `reworkOfJobId`); damage claims (F-EXP `damage_claim`) | complete after cutover | owner, manager |

### E. Money (Hub ledger, reconciled to Stripe)
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| Cash collected, by line | **job cash** = Σ `payment.received` with kind ∈ {deposit, balance} and method ≠ gift_credit, by the Denver date of occurredAt (Stripe charge time; offline receivedAt); **separate lines**: Garage Guard subscription cash (FUN-20), gift-card sales (FUN-36), tips (pass-through, not revenue) | partial for pre-M3 offline history (`legacy:manual` undated) and while FUN-25 Stripe reconciliation fails | owner |
| Refunds, disputes, fees, net cash | Σ refunds, Σ disputes, Σ fees; net = gross cash − refunds − disputes − fees | unknown before FUN-17 (then backfilled) | owner |
| Unclassified Stripe activity | count and Σ of balance transactions that are neither a job checkout, a subscription invoice nor a gift-card sale | always shown; never netted into job cash | owner |
| Deposits and deposit compliance | Σ deposits; projects with a deposit before the first service date / sold projects serviced in the period | complete after cutover; crew payments without a purpose classed by the FUN-33 rule (flagged) | owner |
| AR and aging | Σ balanceCents of completed/invoiced projects **including reopened balances**, bucketed 0–7/8–30/31–60/60+ days past invoice due (or completion) | complete; open payment reviews shown separately | owner, manager |
| Days to collect | median completion → the **final** `job.paid_in_full` crossing | post-cutover | owner |
| Open payment reviews | count and Σ amountCents of `payment_reviews` with status open | complete | owner |
| Tips collected vs paid out | Σ tip ledger entries (M8) vs timecard tips paid through payroll | post M8 | owner |
| Credits and gift-card liability | issued and redeemed by class; gift-card liability = Σ `credit.issued` − Σ `credit.redeemed` (class gift_purchase); gift-card cash = Σ `gift_card.sold` (the `giftCardSales` ledger), a separate cash line | legacy free-text credits are class `unknown`; gift cards sold before the Hub enter the liability through `credit.issue` (class gift_purchase, with the original sale reference) and have no `gift_card.sold` | owner |
| Garage Guard | active/new/cancelled members; churn **voluntary vs involuntary** (payment_failed → past_due); renewal rate; visit utilization (used ÷ included); deferred revenue for unused visits; MRR from Stripe amounts | unknown while the sync flag is off; amounts unknown before FUN-20 | owner |

### F. Contribution and labor
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| Contribution per project | §6 | per-component status; null if any component is unknown | owner (managers: standard-rate view, §8.3) |
| Period contribution and margin | Σ over projects closed in the period, reported separately for final, provisional and unknown (count + known revenue); margin on final, plus a provisional line | counts per status always shown; unknown never zero-filled | owner |
| Contribution per crew-hour; cost mix | contribution / work hours; each cost as % of net revenue | inherits | owner |
| Labor | OT hours and premium (P1-03), labor % of net revenue, untracked ("general") share of paid hours, timecard approval backlog | provisional while weeks are open; partial if the Gusto invariant fails | owner (managers aggregate at standard rate) |
| Overhead and net profit | from books (FUN-39), labelled book basis, lagging until month close | **unknown** until connected | owner |

### G. Acquisition economics
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| CAC (cohort and blended) | §6.6 | unknown without spend; partial with an unattributed share; phone labor excluded (listed) | owner |
| ROAS (revenue and contribution) | §6.6 | inherits spend, attribution and contribution coverage | owner |
| Contribution after acquisition | §6.6 | same | owner |
| LTV, LTV:CAC, CAC payback | §6.6 | cohort maturity; identity-dependent | owner |

### H. Customers, retention, reviews
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| New customers and repeat rate | customers whose first project closed in the period; repeat rate = customers with ≥2 closed projects / customers with ≥1; repeat revenue share; B2B counted at **account** level | ambiguous identities listed; pre-cutover lineage partial (Jobber history via FUN-04) | owner |
| Service line and path mix | revenue, contribution and average ticket by service line and by path, grouped by the project's current values (`projectDimensionBuckets`) | `unknown` bucket always shown, split into never-decided (`null`) and "Not sure yet" projects for the data-quality list | owner |
| Reviews | `review.requested` (approved sends + registered GHL workflows as automation); click rate = clicked / requested; CSAT average and response rate (FUN-40); Google rating and count (FUN-40) | GHL-sent link clicks are not tracked (flagged); rating **unknown** until connected, never inferred | owner, manager |
| Rebook conversion | `rebook.booked` / `rebook.requested` | post FUN-03/12 | owner |

### I. B2B
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| B2B accounts and requests | active accounts and properties; requests per account and property; request → project conversion; first-response time (createdAt → first staff action); request → scheduled; revenue, contribution and AR by account and property (invoice dueDate and terms) | a data-quality item for accounts near `LIMITS.requests = 300` | owner, manager |

### J. Data quality (always included)
| Metric | Formula | Coverage rule | Audience |
|---|---|---|---|
| Coverage score and blockers | % of the period's projects with complete events and final costs, plus the count of each blocker (§9.2) | always reported; it is what turns the other metrics partial | owner, manager |

---

## 8. MCP pulse

### 8.1 Tools (class `read`; MCP-01 `defineTool`; cursor pagination)

| Tool | Input | Output |
|---|---|---|
| `egc.business_pulse` | `{period: today\|wtd\|last_week\|mtd\|last_month\|qtd\|last_quarter\|ytd\|custom, from?, to? (Denver YYYY-MM-DD), compare?: previous_period\|same_period_last_year\|none, sections?: [demand, walkthroughs, sales, operations, money, contribution, acquisition, customers, b2b, followups, data_quality], detail?: summary\|full}` | `{asOf, definitionsHash, period{from, to, timeZone:'America/Denver', inProgress, elapsedThrough}, sources[{name, asOf, lagSeconds, status}], headline[≤6 templated sentences], sections{name: metrics[]}, dataQuality[{kind, count, drill}]}`. The default is `summary` (headline + section totals). Full metric lists come from `detail:'full'` or the drill tools. |
| `egc.funnel_report` | `{from, to, cohort: inquiry_date\|event_date, groupBy?: week\|channel\|booker\|rep\|service_line\|path}` | stage counts, stage conversions `{num, den}`, median/p90 time between stages, maturity flags |
| `egc.funnel_case` | `{projectId\|jobId\|customerId\|highlevelContactId}` | ordered timeline of Hub events + platform inquiries/cycles + tasks + recordings (evidence items labelled), current stage, open blockers |
| `egc.project_contribution` | `{projectId\|jobId}` | components with value, source, status and reasons, and the formula trace (owner only) |
| `egc.contribution_report` | `{from, to, groupBy: project\|service_line\|path\|crew\|channel\|week, status?, cursor}` | paged rows and totals by status |
| `egc.money_summary` | `{from, to}` | cash by line, refunds, fees, AR aging, payment reviews, credits, liabilities (reuses M10 `money.dashboard`) |
| `egc.data_quality` | `{kind?, cursor}` | the records that make metrics partial, each with a Hub deep link and the fix action |
| `egc.metric_definitions` | `{key?}` | definition, formula, sources and coverage rules, so Claude can explain any number |
| Reused | `egc.whats_overdue` (P3-11), `egc.find_openings` (P1-DS-15) | follow-ups and openings |

### 8.2 Composition
- **Hub numbers come only from bridge read commands** (FUN-23): `hub.metrics.pulse`, `hub.funnel.report`, `hub.funnel.case`, `hub.contribution.project`, `hub.contribution.report`, `hub.money.dashboard` (M10), `hub.data_quality` and `hub.metrics.definitions`. They are computed by the single FUN-22 engine, which also serves the Hub Pulse screen.
- **Platform numbers** (demand, spend, speed to lead, recording pipeline, follow-up SLA) come from platform metric functions (FUN-14, FUN-15, FUN-09). The Hub screen reaches the same functions through the existing operations proxy, so the screen and the MCP read identical code on both sides.
- **The MCP joins the two sides** on `highlevelContactId`/cycle→project only. It never recomputes Hub money from Postgres.
- **Definitions check.** Both sides report `definitionsHash`. If they differ, the joined metrics are `unknown` with reason `definitions_mismatch`.
- **Source outage.** If a source is down, its section is `unknown` with a reason, and the other sections still return.
- **Consistent snapshots (C32).** The Hub reads every collection at one Firestore REST `readTime` (`asOf = readTime`). The platform reads in one `REPEATABLE READ` transaction.

### 8.3 Roles and pay privacy (C29)
- Grants are bound to a Hub user and role (MCP-OAUTH part B). Integration actors get no pulse.
- **owner**: everything, including labor at actual rates and per-employee cost.
- **manager**: all sections, with labor at an owner-set **standard blended rate**, labelled "standard-rate labor". Any grouping with fewer than 3 distinct employees has its labor and contribution suppressed. No per-employee pay, no ad-spend detail by default (owner decision).
- **phone / sales**: the follow-ups, demand and sales sections for their own cases only. **No cost, fee, labor, margin or contribution field** appears, which a projection test enforces.
- The FUN-28 sheet is owner-only or aggregate-only.

### 8.4 Existing MCP tools that report Hub-owned numbers (C2, FUN-31)
| Tool | Change |
|---|---|
| `egc.revenue_summary` | `superseded_by: egc.money_summary / egc.business_pulse` |
| `egc.jobs_by_status`, `egc.addon_attach_rates` (Postgres jobs) | superseded; add-on attach rate re-sourced from Hub line items after P2-05 |
| `egc.walkthrough_conversion` | `superseded_by: egc.funnel_report` |
| `egc.lead_conversion_funnel` | lead side from `lead_cycles`; booked, sold and completed from the Hub bridge |
| `egc.operational_report` | limited to lead-side facts; Hub stages and money read from the bridge or removed; description changed |
| `egc.sales_rep_performance` | re-sourced from Hub events (performedBy, follow-up owner) + lead assignment |
| `egc.sales_pipeline`, `egc.stale_opportunities` | kept as GHL views; values labelled "CRM estimate, not revenue"; never used by the pulse |
| `egc.record_user_confirmed_outcome` | **refuses Hub-owned facts** (booking, walkthrough completion, sale, lost, completion, revenue, cash); lead-side facts only |
| `egc.reconcile_customer_state`, `egc.customer_timeline`, `egc.operational_event_evidence` | outputs labelled *evidence*; never counted |

### 8.5 Headline and periods
- **Headline (C30).** At most 6 sentences from fixed templates bound to metric keys, each carrying the metric's status and `asOf`, for example: *"Sold 7 projects worth $18,420 (complete, as of 10:42) — up $2,100 on last month through the same day and hour."* No LLM writes pulse text on the server. Claude's own narration must quote those values as given.
- **In-progress periods (C31).** `today`, `wtd`, `mtd`, `qtd` and `ytd` are marked `inProgress`, and are compared with the prior period truncated to the same elapsed day and hour.
- **Same period last year.** Day and week periods move back 364 days (52 weeks), so Monday is compared with a Monday and a Monday–Sunday week with one; month, quarter, year and custom periods keep the calendar date (Feb 29 becomes Feb 28). The rule is `calendar.periods.sameLastYearAlignment` in the definitions.

---

## 9. Accuracy guarantees and limits

### 9.1 Definition
Every number equals the recorded events and ledgers as of `asOf`. Anything not fully recorded carries status partial or unknown, a machine reason code, a count and a drill-down to the records. It is never a silent zero or a guess.

### 9.2 Invariants (FUN-25 nightly and on demand; failures turn the affected metrics partial and list the records)
- **Event completeness:**
  - every completed visit has `job.completed`;
  - every ledger entry has its payment event;
  - every handoff has `deal.sold`;
  - every cancel has `job.cancelled`;
  - every past walkthrough has an outcome;
  - every completed walkthrough has a follow-up task, or its outcome needs none.
- **Ledger and event agreement.** Σ `payment.received` (excluding tips; gift-credit redemptions included as applied, not as cash) = the ledger's applied paidCents. Net `deal.sold` − superseded = the current approved contract.
- **Stripe.** Every live balance transaction is classified by metadata (portal or crew job checkout, subscription invoice, gift-card sale). Job charges, refunds, disputes and fees per Denver day equal the Hub ledger. Non-job charges are excluded by rule and listed, and unclassifiable ones become data-quality items. `livemode=false` is excluded. Missed webhooks are replayed through the idempotent recorder.
- **GHL.** Sync cursor lag is under 10 minutes, and period contact and opportunity counts match GHL totals. GHL-vs-Hub stage *drift* is reported, never used as evidence. Unadopted walkthrough-calendar appointments are listed.
- **Meta.** The Marketing API leadgen count per form per day equals the GHL contacts carrying those leadgen ids, which catches lead-form leads that never reached GHL.
- **Web receipts.** Every `web_lead_receipts` row is synced to GHL, or is retrying and listed.
- **Labor.** Approved paid hours per employee-week = job-attributed + general + untracked hours. Approved timecard gross per pay period = the Gusto gross-wages read-back; otherwise labor is partial.
- **CAPI.** Values sent to Meta equal the Hub `deal.sold` and `payment.received` values (FUN-31).
- **Identity and exclusions:**
  - projects without a CRM link are listed;
  - ambiguous P4-02 identities are listed;
  - contact ids that no longer resolve (merged or deleted) are listed;
  - Hub test records linked to real GHL contacts are flagged, and so are real records linked to test contacts.
- **Jobber.** Requests, jobs and invoices created after the cutover, Jobber visits and payments after it, settled imported balances and HighLevel records the Jobber app created are flagged (FUN-32, `jobberGuard/latest`).
- **Automations.** A new or changed GHL workflow or Zap not in the FUN-30 registry is flagged.

### 9.3 Mechanisms
- Atomic `:commit` event capture with deterministic ids.
- One definitions file (`definitionsHash`) shared by the Hub and the platform, with a CI drift check.
- Golden fixtures run through the Hub screen, the bridge command and the MCP tool must produce identical numbers.
- One snapshot per read (`readTime` / `REPEATABLE READ`).
- Clock provenance on every event, with device-time bounds.
- Injected clocks, and tests for DST, cross-midnight work and week boundaries.
- FUN-27 rules lockdown of every money and lifecycle field.
- Closed-day rollups (FUN-38) are caches keyed by `definitionsHash`, recomputed on restatement and never used as a source.
- Restatement visibility (`restatedSince`).
- Privacy deny-list tests on every projection (the B2B jobs projection, portal DTOs, crew views, GHL custom fields, CAPI payloads, the sheet).

### 9.4 Cannot be guaranteed (always disclosed)
- **Ad platforms:** their restatements, attribution windows and modelled conversions.
- **AI extraction:** anything the AI extracted until a human confirms it.
- **Facts nobody records:** unreported cash, expenses skipped despite the attestation, calls on lines that are not ingested, and phone-rep time.
- **External data we don't control:** Google reviews actually posted (until connected), GHL-owned contact quality (duplicates and merges), and GHL workflow content changes made outside the registry (detected only as far as the GHL API exposes them).
- **History:** anything before the cutover, and Jobber history beyond what JOB-CUT imports.
- **Owner-supplied inputs:** non-Stripe processor fees unless entered, and payroll burden and owner labor until supplied.
- **Timing precision:** GHL timing is limited to the 5-minute poll when webhooks are absent.

---

## 10. Customer-facing automation register (the approval rule; FUN-30)

A customer-facing send is allowed only in one of two ways:
- **(a)** a human approves that specific message: the MSG-CORE preview/confirm, the SEC-B confirm token, or a crew per-message tap;
- **(b)** an **owner-approved fixed template** registered as `owner_automation`, with its trigger, text hash, approver and date.

Everything else is disabled.

| Existing automation | Today | Default disposition (owner decides) |
|---|---|---|
| Zapier WEBSITE_LEAD_HOOK → OpenPhone "AI text-back in Tyler's voice" | AI-written content, no human review | **Retire the AI text**; replace it with a fixed owner-approved instant reply (keeps speed to lead) |
| GHL "Garage instant text + nurture", "Junk Lead Nurture", FB router | GHL workflows | register each step's fixed template; disable any LC Conversation AI auto-reply |
| Portal invitation auto-queued on handoff sync ("Portal text queued in HighLevel") | automatic after the on-site signature | register as `owner_automation` (transactional, fixed template) or require a tap |
| Browser auto-fires on save: estimate-ready, estimate-approved, deposit-received, invoice-issued, payment-received (employee-suite.js:280) | tag writes that trigger GHL workflows | **retire** (FUN-27); sends go through approved-send |
| Browser `customerAutomationEnabled` estimate-expiring and invoice-overdue reminders | fires on a manager page refresh | **retire**; M7 / MSG-CRON approved reminders replace them |
| `egc-job-scheduled`, `egc-walkthrough-scheduled`, `egc-reminder-<N>d` tags | GHL confirmation and reminder workflows | register the templates; show their text in every booking confirm dialog |
| `egc-review-requested`, `egc-job-complete`, `egc-review-ready` tags | may trigger GHL review workflows | register or disable; review asks go through MSG-CORE `review_request` |
| GHL opportunity status/stage changes, and contact field changes (FUN-12, FUN-35) | unknown workflow triggers | FUN-12/35 writes stay **flag-gated** until the inventory shows no customer-facing trigger |
| Crew on-my-way via `/api/quo-send` (legacy prejob) | crew tap per message | allowed (per-message human tap); migrate to MSG-CORE `on_my_way` |

---

## 11. Units (build order)

The units are listed in dependency order. "Planned as" names the existing unit a FUN unit extends; `new` marks a real gap. FUN-07, FUN-14, FUN-15 and FUN-34 take migration numbers at merge time (C36).

| Order | Unit | Title | Depends on | Planned as |
|---|---|---|---|---|
| 1 | FUN-01 | Funnel definitions + event ledger library | SEC-B | new |
| 2 | FUN-13 | Website lead intake reliability (ads.html fix, inquiryId, durable receipt) | FUN-01, MSG-CRON | new |
| 3 | FUN-15 | Ad spend ingestion + manual spend ledger + leadgen counts | — | new |
| 4 | FUN-30 | GHL/Zapier automation and trigger inventory + registry | MSG-CORE | new |
| 5 | FUN-02 | Booking, dispatch, handoff and approval events; reason codes; no-show; visit purpose | FUN-01 | new |
| 6 | FUN-03 | Field and portal events (portal writers to `:commit`) | FUN-01 | new |
| 7 | FUN-29 | Service line and funnel path | FUN-01, FUN-02 | new |
| 8 | FUN-20 | Garage Guard amounts, member visits, churn | M2, FUN-01 | M13 extension |
| 9 | FUN-18 | Field status taps drive timecard job segments | P1-03, FUN-03 | new |
| 10 | FUN-32 | Jobber coexistence guard | JOB-CUT, FUN-01 | new (JOB-CUT follow-up) |
| 11 | FUN-05 | Walkthrough visit API + rep time segments | FUN-01, P1-08 | new (walkthrough map FUN-WT-7) |
| 12 | FUN-33 | Payment events and paid-in-full on the ledger (`:commit` refactor) | FUN-01, M3 | new |
| 13 | FUN-36 | Server credits, gift cards and remaining browser lifecycle writers | M3, FUN-01 | new |
| 14 | FUN-19 | Closeout expense attestation + cost kinds | F-EXP | F-EXP extension |
| 15 | FUN-35 | Structured attribution, repeat inquiries, CRM object provenance | FUN-13, FUN-30 | new |
| 16 | FUN-37 | Bridge funnel event feed | BRIDGE, FUN-02, FUN-05 | BRIDGE extension |
| 17 | FUN-06 | iPad walkthrough recorder | FUN-05, HUB-REG | new (FUN-WT-1; overlaps hub-ui "Hub PWA… media permissions") |
| 18 | FUN-07 | Recording API fixes + pipeline timestamps | P3-03 | new (FUN-WT-2) |
| 19 | FUN-34 | Long recordings: segmentation, stitching, retention | FUN-07 | new |
| 20 | FUN-17 | Stripe fees, refunds, disputes, classification | FUN-33 | new |
| 21 | FUN-04 | Backfill (dry-run) incl. JOB-CUT history | FUN-02, FUN-03, FUN-33, JOB-CUT | new |
| 22 | FUN-14 | Platform per-cycle lead model + first response | FUN-01, FUN-13, FUN-37, MSG-CORE | new (extends `leads`/`customer_events`) |
| 23 | FUN-16 | Phone lines and off-GHL sends (conditional) | FUN-14, FUN-30 | new |
| 24 | FUN-08 | Scheduling constraints in extraction | P3-02, FUN-05, FUN-37 | P3-02 scope addition |
| 25 | FUN-09 | Follow-up to-do on walkthrough completion | FUN-37, FUN-05, P3-04, P1-08 | new (FUN-WT-3, revised) |
| 26 | FUN-10 | Internal job notes vs customer-visible scope | FUN-09, P3-09, P3-10 | P3-09/P3-10 extension |
| 27 | FUN-12 | Deal outcomes, attempts, rebook link | FUN-02, FUN-03, FUN-09, FUN-30 | new |
| 28 | FUN-11 | Schedule proposal + gated one-tap booking | FUN-08, FUN-09, FUN-10, FUN-30, P1-DS-05, P1-08, M3 | new (FUN-WT-6; P1-DS-15 reuses it) |
| 29 | FUN-21 | Project contribution engine | P1-03, F-EXP, M3, FUN-02, FUN-17, FUN-18, FUN-19, FUN-20, FUN-36 | M9 (amended) |
| 30 | FUN-22 | Business pulse engine + data-quality envelope | FUN-01, FUN-02, FUN-03, FUN-04, FUN-21, FUN-29, FUN-33 | M10 + hub-ui "Weekly business dashboard" engine |
| 31 | FUN-27 | Lock browser writes; retire browser auto-fires | M3, FUN-03, FUN-33, FUN-36 | SEC-01 phase 2 |
| 32 | FUN-25 | Nightly reconciliation + data-quality records | FUN-22, FUN-14, FUN-17, FUN-30, FUN-32 | new |
| 33 | FUN-38 | Closed-day pulse rollups | FUN-22, FUN-25 | new |
| 34 | FUN-23 | Bridge metric read commands | BRIDGE, FUN-22 | BRIDGE extension + M10 `money.dashboard` |
| 35 | FUN-26 | Hub Pulse screen | FUN-22, FUN-09, HUB-REG | hub-ui "Weekly business dashboard" (UI) |
| 36 | FUN-24 | MCP `egc.business_pulse` + drill-down tools | FUN-23, FUN-14, FUN-15, FUN-09, MCP-READS, MCP-OAUTH | mcp.json "Compound tools" |
| 37 | FUN-31 | Re-point customer-state, CAPI and superseded MCP tools | FUN-37, FUN-14, FUN-24 | new |
| 38 | FUN-28 | Optional read-only Sheets export (owner-only or aggregate-only) | FUN-24 | new (optional) |
| 39 | FUN-39 | Optional books connector (overhead, net profit) | FUN-24 | new (optional) |
| 40 | FUN-40 | Optional CSAT + posted-review tracking | MSG-CORE, FUN-03 | P4-13 extension (optional) |

### 11.1 Unit scopes

- **FUN-01 Funnel definitions + event ledger library.**
  - `functions/_lib/funnel-definitions.js` plus a canonical `funnel-definitions.data.json`. The platform copies the JSON as a package, and a CI drift check (SITE-0 pattern) plus `definitionsHash` keep the two identical. The file holds:
    - **eligibility across systems**: Hub recordType, `_egc_`/`secure_` ids, isTest/test, internal with a reason; GHL exclusion tags (folded, so `egc test` matches `egc-test`), contact flags (`dnd`, `doNotContact`, `isVendor`, `isInternal`, the test flags) and the synthetic source, a superset of the platform's current customer-state and CAPI exclusions; Stripe livemode/`cs_test_`;
    - **vocabularies**: event types and payload schemas; reason codes (cancel, reschedule, lost, walkthrough outcome, no-show); service-line and path taxonomy;
    - **calendar and period rules**: one business-hours and holiday calendar, onto which web-lead `leadTiming` migrates; the repeat window and cycle rules; Denver day/week bucketing and the in-progress truncation helper;
    - **event integrity rules**: clockSource rules with device-time bounds; idempotency-key conventions; the cutover date.
  - `funnel-events.js` `funnelEventWrite()`, rules (server-only) and indexes.
  - `operations-financials` and the M3 `moneyJob` adopt the shared eligibility.
  - Tests: DST, hash stability, injected clock.
- **FUN-02 Booking, dispatch, handoff and approval events.**
  - **Dispatch.** `schedule.create` ensures a project and records channel, `channelSelfReported`, bookedBy, `visitPurpose`, `reworkOfJobId`/`membershipId`, and the CRM link or `crmLinkReason`. It emits `walkthrough.booked`/`job.scheduled`.
  - **Reschedule** emits from/to, `reasonCode` and `initiatedBy`, plus an occurrence counter. **Assign** is covered.
  - **Cancel** writes `reasonCode` next to the existing free-text `cancellationReason`, plus the computed `lateCancel`. **Restore** is covered. A new job `no_show` action.
  - **operations-scheduling / adoption** emit booking events with provider clocks.
  - **walkthrough-handoff** writes `deal.sold` with the two-sided device-time bounds and sets `walkthroughOutcome: sold_on_site` in the same commit.
  - **operation-recording-approval** emits `scope.reviewed`.
- **FUN-03 Field and portal events.**
  - **Field:** `fieldEvents` get structured `fromStatus`/`toStatus`; `dispatchedAt` is written; `job.dispatched/arrived/started/completed` events are added in the field commit.
  - **Portal:** the writers move from `patchJob` to `:commit` with events, idempotent by portal `request_id`:
    - `approve_estimate` → `deal.sold` (server clock);
    - `respond_decision` → `change_order.*`;
    - the rebooking request → `rebook.requested`, written at write time;
    - `record_review_click` → `review.clicked`;
    - `apply_gift_credit` → `credit.redeemed`.
  - **In the repository (FUN-03).** `functions/_lib/job-funnel-events.js` builds every event below with `funnelEventWrite`; the event is a create-only write in the same `:commit` as the change, so a failed or conflicting save records neither. A private record (`recordType`, `_egc_`, `secure_`) gets no event and its change saves as before; an event the ledger refuses (`funnel_event_*`, e.g. an amount over $1M) is a 503 that saves nothing, never a "refresh" 409.
    - **Field** (`POST /api/field-jobs`, `via: field`, server clock, key `requestId`, source `fieldEvents/{requestId}`, actor the crew user and role). Every status tap and closeout receipt in `jobs/{id}/fieldEvents` stores `fromStatus` (the field status shown before the tap, including `paused`/`waiting`/`delayed`) and `toStatus`. The job stores `dispatchedAt`/`dispatchedBy` on each dispatch, like `arrivedAt`. Events: `job.dispatched` (scheduled/confirmed/crew assigned → dispatched), `job.arrived`, `job.started` (written with the job's first `startedAt`, so once per job: resuming after a pause, or starting again after a cancel and restore, is not a new start) and `job.completed` (with the job's `visitPurpose` when set). Dispatch cancel/restore keeps the field times, so the portal status ignores a field time on a cancelled or no-show visit and one from before `restoredAt` (a restored visit shows "scheduled" until the crew taps again). Delays, waits, pauses, notes, checklists and photos write no funnel event. A replayed or recovered tap is answered from its receipt and writes nothing.
    - **Portal** (`via: portal`, server clock of the portal handler, key `portalRequest`: the page's `request_id`, a stable digest when it is not 8–120 characters of `[A-Za-z0-9_-]`, or a server-minted id when the page sends none; actor `customer` for the link owner, the collaborator id with role `collaborator`, or the company member actor with role `business`; source `jobs/<jobId>:<field>[:<subId>]`).
      - `approve_estimate` → `deal.sold` at the bound `amount_cents` and `estimate_revision` (plus `serviceLine`/`funnelPath` when the job carries valid values), source `jobs/<jobId>:customerApproval:<key>`. The saved approval stores the request that saved this signature as `customerApproval.requestId` (the page's `request_id`, or the server-named key) and the revision it binds as `estimateRevision`. A retry of that page `request_id` returns the saved signature (`replayed: true`) without writing only while the saved record is still that portal signature: `source: customer_portal`, the same `estimateRevision` and the same total. `customerApproval.requestId` can outlive its signature: the legacy **Record approval** button merges a staff approval into the map with `set(merge)` and keeps it, and a revision (legacy or M3) marks the approval superseded and keeps it. A `request_id` the saved approval names that no longer matches that signature is spent: `409 CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT`, nothing written, and a staff approval is never returned as the customer's signature. M3 `estimate.record_approval` replaces the map without a `requestId`, so a `request_id` whose `deal.sold` is still the job's live sale (`funnelSale.eventId`) is refused the same way when the signature would record a sale at another total, never a second `deal.sold` under the same key. After a re-signature at the live sale's total, `requestId` is not the sale's key (the sale's key is `funnelSale.key`). A total the ledger cannot hold refuses the approval (503) rather than saving it without its sale.
        - **The job's live sale (`funnelSale`).** Every commit that writes `deal.sold` also saves the job's top-level `funnelSale` `{jobId, cents, estimateRevision, key, eventId, soldAt}` (`key` is the event's idempotency key, `eventId` its `funnelEvents` id), and every commit that retires it with `deal.approval_superseded` clears or replaces it. It is the only record of which sale the ledger counts for the job. The Hub's browser writers (the legacy estimate editor and the always-visible **Record approval** button, `employee-suite.js`, MONEY_API_ENABLED off) rewrite `customerApproval` but save named fields with `set(merge)` and never touch `funnelSale`, and `firestore.rules` refuses any browser SDK write that sets or changes it. So the sale is never inferred from `customerApproval.status` or `source`. A `funnelSale` naming another job (a cloned visit) is not this job's sale.
        - **Sale bookkeeping.** With no live sale, a portal signature writes `deal.sold`, including after a staff-recorded approval (M3 `estimate.record_approval` or **Record approval**, which write no sale). A signature at the live sale's total is the same sale (a double tap, a stale tab, a signature after a staff-recorded approval of a sale already live, or after a handoff sale) and writes nothing. A signature at a different total first writes `deal.approval_superseded` for the live sale, in the same commit. So portal $800 → **Record approval** → a stale tab signs $800 nets $800, and portal $800 → legacy revise to $900 → **Record approval** (or M3 `record_approval`) → a tab signs $900 nets $900.
        - **Hub revisions.** An M3 `estimate.save` material revision retires the job's live sale: `deal.approval_superseded` (the sale's amount and `estimateRevision`; `via` hub or mcp, key the money `requestId`, source its `moneyOperations` receipt, server clock) and `funnelSale: null` in the revision's own commit, whether the approval is still current, a legacy browser revision already superseded it, or a staff approval replaced it. The approval is marked superseded (`supersededRequestId` names the revision) as before; a revision with no live sale writes no event. The legacy browser estimate editor cannot write events, so a sale it supersedes stays live until the next server writer retires it (the next portal signature or handoff at a different total, or an M3 revision; FUN-27 retires the editor). With these, portal approve $800 → Hub revise to $900 → portal approve $900 nets $900 of `deal.sold` minus superseded.
        - **Limits.** The net equals the current contract for sales these writers record. A job approved before the sale writers shipped has no `funnelSale`, so the next signature on it records its sale then (dated at that signature) and retires nothing; FUN-04 backfills history under the rules in its section. FUN-02 and FUN-03 must deploy together: a handoff `deal.sold` saved without `funnelSale` would be counted again by a portal re-signature (until FUN-04 sets its `funnelSale`).
      - `respond_decision` → `change_order.approved` / `change_order.declined` with the decision's price change in cents (as `approvedChangeTotal` counts it). A page `request_id` is a UUID (the CHANGE-ORDERS format; anything else is `400 CUSTOMER_PORTAL_REQUEST_INVALID`) and is saved lowercased as `responseRequestId`; the event key is saved as `responseEventKey` (that UUID, or a server-named key when the page sends none), so `responseRequestId` only ever names a page request. A retry of the same `request_id` returns the saved answer (`replayed: true`); the same `request_id` on another question is `409 CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT`. Both responses show the decision as the page view does (no staff fields or request bookkeeping).
      - `request_rebook` → `rebook.requested` when the request is written (the job keeps only the last 10 requests). A page `request_id` is saved as `requestId` (the event key); a retry with the same kind, timing, preferred date, preferred crew and notes returns the saved request (`replayed: true`), and changed details under a saved `request_id` are `409 CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT` (never silently dropped). The page starts a new `request_id` when the form is edited or after that conflict. Without a `request_id` the event is keyed by the saved request `id`. The existing same-content duplicate check still writes nothing.
      - `record_review_click` → `review.clicked`, once per click `request_id`; the per-viewer one-minute repeat rule writes nothing.
      - `apply_gift_credit` → `credit.redeemed` (amount applied; `creditClass` when the card names a known class), committed with the job payment and the account-root wallet; the redemption `request_id` makes a retry a no-op.
      - The portal page sends a `request_id` (a UUID) with approvals, decision answers and rebooking requests, keeps it on the button or form until the request saves, and resends it on a retry. For approvals, a binding conflict or `CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT` (which reload the estimate) starts a new one, and so does any load, including the 20-second quiet poll, that changes the shown estimate's revision, total or fingerprint.
    - Not in FUN-03: `payment.received` for a gift-credit redemption (FUN-33/FUN-36) and the M3 staff approval's own `deal.sold` (it would go through `saleWrites()` in `job-funnel-events.js`, like the portal and the handoff, so it saves `funnelSale` too).
    - **Every future `deal.sold` / `deal.approval_superseded` writer** uses `saleWrites()` (or, to retire, clears `funnelSale` with its supersede, as `moneySupersedeWrite()` does), never its own reading of `customerApproval`.
- **FUN-04 Backfill (dry-run by default).** The §4.1 rules, including JOB-CUT history mapping, the "never infer from status" rule, and legacy no-show and cancel-reason mapping. It produces an unrecoverable-facts report and records the cutover date.
  - **Sales and `funnelSale` (FUN-03 contract).** Live writers retire only the sale the job's `funnelSale` names, never an approval they did not record. The backfill keeps these rules so nothing is counted or retired twice:
    - a sale the ledger already holds is never backfilled: the job's `funnelSale` names it (also when a legacy browser revision has since marked its approval superseded; the next live writer retires it);
    - for a job without `funnelSale`, a `deal.sold` backfilled for its current approved approval saves `funnelSale` (that event's key and id) in the same commit, under the job's revision precondition, so a later live signature or revision sees it;
    - an approval that ended before the job's sale writers ran is backfilled as a matched `deal.sold` + `deal.approval_superseded` pair or not at all, never a lone supersede. No live writer retires such an approval (including a legacy `estimate_revised` one without `supersededRequestId`), because it is not a `funnelSale`;
    - a handoff `deal.sold` already in the ledger without `funnelSale` (only if FUN-02 shipped before FUN-03) gets its `funnelSale` set, not a second sale.
- **FUN-05 Walkthrough visit API + rep time.**
  - `POST /api/walkthrough-visit` with `{start | finish | no_show, outcome, reasonCode, recordingStatus: recorded | declined | failed_device, requestId, deviceAt}`, for the sales, owner and manager roles.
  - It writes `walkthroughVisit.startedAt`, `walkthroughOutcome{outcome, reasonCode, finishedAt, performedBy, recordingStatus}` and `walkthroughCompletedAt`, plus the events. `not_interested` also writes `deal.lost`. Everything is atomic, with receipts and revision preconditions.
  - The next Start is blocked while one of the rep's walkthroughs lacks an outcome.
  - Start and Finish open and close the rep's work segment on the visit id through `employee-vault`/`employee-job-time`, prompting clock-in if needed.
  - Walkthroughs stay excluded from field-jobs.
  - **As built** (`functions/_lib/walkthrough-visit.js`, `functions/api/walkthrough-visit.js`; POST behind `EGC_WALKTHROUGH_VISIT_ENABLED`):
    - Body `{action: start|finish|no_show, visitId, requestId, expectedRevision, outcome?, reasonCode?, recordingStatus?, deviceAt?, skipTimecard?, actorId?}`. Performers: with stored staff roles, the P1-08 `quotes.author` capability (owner, manager, sales); otherwise a dispatch-level owner/manager or the signed `sales` role. A sales rep records only visits assigned to them (or that they started); an owner or manager can record any, including an outcome for a rep's open visit. `GET ?visitId=` returns the visit, the viewer's open walkthrough and their shift state.
    - One commit holds the visit patch (revision precondition), the rep's sealed timecard (revision precondition), the funnel events, the rep's lock `walkthroughVisitLocks/rep_<hash>` and the receipt `walkthroughVisitOperations/{requestId}` (both server-only). The lock blocks the rep's next Start (`409 walkthrough_visit_outcome_required`) until the open visit has an outcome; a lock whose visit got an outcome elsewhere (a signed handoff) is released by the next Start.
    - Reasons: `not_interested` needs a `lost` reason (and writes `deal.lost`), `customer_no_show` a `noShow` reason, `rescheduled` a `reschedule` reason (kept on `walkthroughOutcome` and in the FUN-37 outcome feed; `walkthrough.completed` carries only lost reasons). Finish needs `recordingStatus` except for a no-show. `customer_no_show` (the `no_show` action, which needs no Start, or a Finish) writes `walkthrough.no_show` with `occurrence`. Every other outcome writes `walkthrough.completed`. Only a visit that took place gets `walkthroughCompletedAt = finishedAt`: `customer_no_show` and `rescheduled` leave it unset. **Consumer rule:** a `walkthrough.completed` with outcome `rescheduled` is neither a completion nor a no-show ("Walkthroughs completed" and the show rate exclude it, metrics B).
    - `startedAt`/`finishedAt` are the events' `occurredAt` (the §4.1 device-clock rule). An outcome is never dated before its Start: a Finish/No-show time earlier than `startedAt` (even inside the C17 `startedAt − 1 h` slack) is written as `attested` at `startedAt` for every event of that tap, and the raw device time stays on `walkthroughOutcome.deviceAt`.
    - Rep time: Start switches the rep's active shift to a `work` segment on the visit id, marked `visitKind: 'walkthrough'` (409 `walkthrough_visit_clock_in_required` when not clocked in; `skipTimecard: true` is the explicit opt-out after that prompt, recorded as `repTime.status: skipped`). The timecard keeps the P1-03 policy: a stale device time is refused unless `EGC_OFFLINE_CLOCK_ENABLED`.
    - When the starter's active segment is on the visit, their Finish/No-show **always closes it**: `segment_closed`, or `segment_closed_server_time` when the timecard refuses the device time (a late offline replay with offline clock times off; the outcome keeps its C17 `finishedAt`). `skipTimecard` on Finish/No-show is honoured only when the timecard cannot be written (`walkthrough_visit_time_unavailable`: vault read-only or unreadable; `walkthrough_visit_time_invalid`: the timecard needs manager review): the segment is then `left_open` for a manager to close. Also recorded: `already_ended` (the rep switched or clocked out), `other_performer` (a manager never edits the rep's timecard, so the rep's segment runs until their next switch or clock-out), `not_opened` and `not_started`. Job status, schedule and payments are not changed; `projects/{id}.outcome` stays with FUN-12.
    - **Occurrences.** Each Start/outcome snapshots the occurrence it belongs to on `walkthroughVisit.occurrence` / `walkthroughOutcome.occurrence`: `{number, date, time, startAt, scheduleOccurrence}`, where `number` is FUN-02's `scheduleOccurrence` when the visit has one (else 1) and never goes down. A `customer_no_show` or `rescheduled` outcome closes only its occurrence: once Dispatch moves the visit to another start (or FUN-02 counts a new placement), the next Start or No-show moves the earlier `walkthroughVisit` start and `walkthroughOutcome` into `walkthroughOccurrences[]` (the last 20 are kept; the events stay the full history) and records the rebooked occurrence in the same commit. Until the visit is moved, and for every other outcome, Start/Finish/No-show return `409 walkthrough_visit_closed`. The read returns `rebookPending` and `previousOccurrences`. So the §5 step 4 "Rebook walkthrough" follow-up moves the same visit in Dispatch; it never needs a new visit. FUN-02 dependency: Dispatch must keep allowing a move of a walkthrough whose FUN-05 outcome is `customer_no_show` or `rescheduled` (FUN-05 leaves its status `scheduled`), and a visit marked with Dispatch's own terminal `no_show` status must be restored to a startable status before its rebooked Start.
    - **Job costing.** `/api/job-costing` (`computeJobLaborCost`) leaves `visitKind: 'walkthrough'` segments out of `jobs` and `totals` (§6.1) and reports them under `walkthroughLabor {costedAs: 'acquisition', visits, totals}` for the §6.6 `walkthroughLaborCents`; coverage covers both. FUN-21 builds contribution on `jobs` only.
    - **Errors.** `walkthrough_visit_*` codes pass through. A funnel event the visit or account cannot produce (`funnel_event_*`) and a commit Firestore refuses as `400 INVALID_ARGUMENT` are `400 walkthrough_visit_invalid` (discard the request); only a lost or unreadable commit reply is `503 walkthrough_visit_outcome_unknown` (retry the same request).
- **FUN-06 iPad walkthrough recorder.**
  - Start/Finish UI in the gameplan, with the consent tap and a "declined" path that shows a typed-notes field.
  - `microphone=(self)` for `/crew/gameplan(.html)`.
  - Recording: `isTypeSupported` mime, about 48 kbps, file extensions, IndexedDB chunks, wake lock, interruption detection, and size/time part roll-over at about 20 MB or 20 minutes.
  - Upload: XHR progress, retry with the same requestId, an "unsent recordings" list, and an accept list that includes `.m4a`/`audio/x-m4a`.
  - A WebKit/iPad device test checklist.
- **FUN-07 Recording API fixes + timestamps.**
  - Accept `audio/x-m4a|audio/m4a` (stored as `audio/mp4`) and use filenames with extensions.
  - Specific error codes instead of `recording_processing_failed`.
  - New columns `uploaded_at`, `processed_at`, `transcribe_model`, `extraction_model`, `part_index`, `part_count`, `recording_group_id`.
  - A synthetic canary checks the model ids, the extension behaviour and the duration limit.
  - Hub error labels, and platform metric functions for recording coverage, lag and failures.
- **FUN-34 Long recordings.**
  - Streamed uploads of more than 24 MB (up to about 200 MB) are segmented on the server with ffmpeg in the Railway image into parts under 24 MB / 1400 s.
  - Parts are transcribed in order, and the stitched transcript carries part offsets. Extraction runs once over the stitched transcript.
  - Retention: audio is deleted after the owner-set number of days and transcripts after N days. An owner action deletes on customer request, with an audit entry.
- **FUN-08 Scheduling constraints.**
  - Added to the P3-02 v2 schema: `preferredWeekdays`, `timeOfDay`, `notBefore`/`notAfterMention`, `unavailableMentions`, `crewSizeMention`, `durationHoursMention`, `urgency`. Each is nullable and carries a `sourceQuote`.
  - Quote-substring validation drops unsupported items.
  - Relative dates are resolved in code against `walkthroughVisit.startedAt`, read through FUN-37. The fallback is the scheduled date, flagged.
- **FUN-09 Follow-up to-do on completion.**
  - A platform reconciler (60 s, flag `EGC_OPERATIONS_WALKTHROUGH_FOLLOWUP_ENABLED`) reads `hub.walkthrough.outcomes` and routes each outcome to its task.
  - Minimum delay: the feed serves an outcome only once it is 5 minutes old (FUN-37's settle window), so tasks appear about 5–6 minutes after Finish. Due times and SLA metrics count from `finishedAt`, so they are unaffected.
  - The outcome feed's `unverified` list (a handoff sale whose walkthrough record was deleted) raises a review task for a manager instead of a follow-up, since the sale may be a revision or a Started visit's sale.
  - `dueAt` comes from `finishedAt` plus the policy, in business hours. The owner comes from P3-04. Notes are attached when the extraction arrives. An alert task covers missing or failed recordings.
  - The `phone` role is added to the platform `actorSchema`/`authorize` and `recording-contracts`.
  - The dedupe key includes the outcome revision.
  - Includes platform metric functions for the SLA and the finish → booked timeline.
- **FUN-10 Internal notes vs customer scope.**
  - `walkthroughVisit.internalJobNotes{text, confirmedBy, confirmedAt, sourceRecordingId, edited, fieldsChanged[]}` via `/api/walkthrough-notes` (phone, sales and manager roles), with a receipt and `notes.confirmed`.
  - These notes are copied only to crew-internal instructions, never to customer-facing fields. `reviewedWalkthroughScope` stays owner/manager.
  - The Action Center and My follow-ups render the notes with "Open recording". An MCP read is added for staff only.
  - The duplicate recording evidence is removed.
  - Portal-DTO deny tests.
- **FUN-11 Schedule proposal + gated one-tap booking.** Implements §5 steps 6–7 and §5.1:
  - `schedule-proposal.js`;
  - the approval gate (M3 `estimate.record_approval` for verbal approvals);
  - the constraints (P1-DS-06 when present, P1-07 travel, vehicle, arrival window, multi-day routed to the dispatcher);
  - 6-week paging and `proposalHash`;
  - `/api/followup-book` with the `followup.book` capability, which verifies task ownership over the bridge;
  - the confirm dialog showing the registered template texts;
  - the 409 recompute, and task auto-completion.
- **FUN-12 Deal outcomes.**
  - `projects/{id}.outcome` lost/reopen with the owner's reason list, and the matching events.
  - Completing a follow-up requires an outcome; a snooze logs an attempt.
  - `schedule.create` accepts `sourceRebookingRequestId`, which writes `rebook.booked` and `rebook.contacted`.
  - The GHL opportunity-lost write is flag-gated by FUN-30.
- **FUN-13 Website lead intake reliability.**
  - Fix the ads.html relay (its `preventDefault` runs before the fb-capture listener).
  - fb-capture generates an `inquiryId`.
  - web-lead writes the server-only `web_lead_receipts/{inquiryId}` and `inquiry.received` *before* the GHL sync. The receipt holds `{receivedAt, formSource, pagePath, attributionHash, sealedPayload (SEC-B purpose key, deleted after sync), ghlSyncStatus, attempts, contactId, opportunityId}`.
  - Failed syncs retry through the MSG-CRON signed scheduler.
  - Unify the Meta pixel id, and add a book.html Lead event with an `eventID` for deduplication.
  - The legacy Firestore `leads` collection stays closed.
  - **As built (FUN-13).**
    - `fb-capture.js` gives each submitted set of answers a v4 `inquiry_id`. The same answers are sent again only after the relay failed, and then under the same id (the Hub records the lead once); changed answers get a new one. `window.EGCLeadCapture.relay(form)` is the direct path for pages whose own handler cancels the native submit; `ads.html` now calls it, so ads leads reach `/api/web-lead`.
    - The Meta Lead `eventID` is the `inquiry_id`: `ads.html` passes it on its existing Lead, and `fb-capture.js` fires a Lead for forms marked `data-meta-lead` (book.html, set in `_generate_site.py` `render_book`). The relay hands `inquiry_id` to the Zap for the CAPI `event_id`.
    - **Pixel unification is held for the owner.** `ads.html` and `thank-you.html` still report to the paid-campaign pixel `861741726934219` (every other page uses the loader's `970332989051988`). Nothing in the repository shows whether an active ad set or a thank-you URL custom conversion optimizes on `861741726934219`, and moving it would silently stop those conversions. Once the owner confirms nothing depends on it, remove `data-meta-pixel-id` from both pages' loader tags, change their `noscript` pixel ids to `970332989051988`, and update the pixel assertion in `tests/public-audit-fixes.test.mjs`. Until then an ads-page browser Lead and a CAPI Lead sent to the other dataset do not deduplicate against each other.
    - `functions/_lib/web-lead-intake.js` (behind `WEB_LEAD_RECEIPTS_ENABLED`): the receipt and its `inquiry.received` event (origin `web_form`; `source` = the receipt; no event for client hub help) are created in one create-only commit before any HighLevel call. The receipt also carries `inquiryId`, `fingerprint` (the idempotency check: the same id with different answers is 409 `web_lead_idempotency_conflict`), `claimId`, `retryAt`, `lastError` (a code, never provider text), `abandonReason`, `abandonedAt`, `syncedAt`, `relayStatus`, `funnelEventId`, `createdContactId` (the HighLevel contact a failed attempt created), `delayedTag` (only with the optional `WEB_LEAD_DELAYED_SYNC_TAG=true`: `added | failed` on a late sync, `cleared | clear_failed` on an on-time one; otherwise null), `opportunitySkipped` and, once deleted, `payloadPurgedAt`. The sealed payload uses the `egc/seal/web-lead-receipt/v1` AES-GCM purpose key bound to the receipt path and is set to null once HighLevel has the lead. `formSource` is `ads_landing | book | home | site_page | client_hub_help | unknown`, from the page path.
    - **Sealed size.** A sealed value has its own bound, 256 KiB of UTF-8 JSON (`SEAL_MAX_BYTES`), separate from the 4096-character token limit, so any lead the 32 KB `/api/web-lead` body limit admits (even all 3-byte characters, with the first name copied into `lead_first_name`) is sealed and opened again. `sealWebLead` opens every seal once more before the receipt is written; a lead that cannot be sealed, or does not open to the same lead, is receipted with `payloadSealed: false` rather than with a payload no retry could read.
    - Retries run on the signed `/api/messaging-cron` tick, with or without server messaging, never in Denver quiet hours. They run after the reminder run, from what it left and at most a third of the subrequest budget. A retry is charged its worst case, 12: the claim, seven HighLevel calls (upsert, the optional delayed tag, tags, opportunity check, note, pipelines, opportunity) and two settle rounds, so the default budget's third (13) fits one retry per tick. Time is bounded on the tick's own clock (ms since it started; the Railway worker gives up at 120 s): no new retry starts once the tick is 30 s old; the claim is one Firestore write (20 s timeout); each of the retry's HighLevel calls has its 15 s timeout cut to what is left before 75 s, and a call with under 1 s left is not started, so the sync fails as a whole (`web_lead_retry_out_of_time`, retried on the usual backoff; a note or tag call is never skipped quietly); and the retry settles in rounds of a Firestore read and write (20 s timeouts each), a second round only while it still ends by 115 s. So even when every call hangs until its timeout, the retry pass ends 5 s inside the worker's timeout; a retry left unsettled is synced again once its claim expires (see At-least-once). Backoff is 5, 15, 45, 120, 360, 720, 1440 minutes, then `abandoned` after 8 attempts (about 45 hours).
    - A retry never sends the Zapier text; only the request that received the lead does, exactly as before. **Nothing in HighLevel needs changing.** All follow-up and customer communication stays in HighLevel, and the Hub only makes sure the lead reaches it. With `WEB_LEAD_DELAYED_SYNC_TAG` unset (the default), a retried sync makes the same contact upsert, source and consent tag, and detail note calls as an on-time sync, with no extra tag call. So a lead synced late (after a HighLevel outage, up to about 45 hours) starts the HighLevel automations late, exactly as if it had just arrived. A retried sync differs from an on-time one only where it protects work the team may already have done from the Web3Forms email:
      - its detail note starts with `Delivered late by the Hub retry: the first HighLevel sync failed. Check whether someone already followed up.`;
      - it never creates or moves an opportunity for a contact that existed before the lead, because someone may have worked it from the Web3Forms email: `opportunitySkipped: 'existing_contact'` (HighLevel's upsert answer says `new: true` for a contact it just created; without that flag the contact counts as existing). When the contact was created by this lead's own earlier attempt (`createdContactId`), it opens the new-lead opportunity only if that contact has no opportunity in the pipeline at all, open, won, lost or abandoned (the search asks for `status=all`; `existing_opportunity` otherwise), because the upsert matches the contact's opportunity in the pipeline and would reopen a closed deal at the new-lead stage. An earlier attempt's opportunity upsert can land even though its answer was lost, and the team may have closed that deal since. It skips the opportunity when the check fails (`opportunity_check_failed`). The detail note says why the opportunity was left alone, so the team can add one.
    - **Optional extra: the `egc-delayed-sync` tag (`WEB_LEAD_DELAYED_SYNC_TAG=true`, exactly `"true"`; also needs the ledger on).** Only for an owner who chooses to have late leads skip an instant reply, and it needs HighLevel workflow filters (see the optional part of the owner checklist). With it on:
      - a retried sync adds the tag `egc-delayed-sync` with its own `POST /contacts/{id}/tags` (the method every other Hub tag writer uses), right after the contact upsert and before the legacy `PUT` of the source and consent tags, so a workflow those tags start already sees it. A `Contact Created` trigger can still fire before the tag lands, so filtered workflows need a short wait before the tag check.
      - The tag is contact-wide, so an on-time sync of an existing contact removes it (`DELETE /contacts/{id}/tags`) before its own tags, and that contact's next website instant reply is not skipped. Nothing else removes it: a Facebook lead ad, a native HighLevel form, a call or a text never clears it, so on a contact that once had a late sync it can stay for good. That is why only website-lead workflows may filter on it.
      - Turning it off again leaves the tag on the contacts that have it (nothing removes it any more), so remove the workflow filters first.
    - With the tag flag unset, or the ledger off (flag or Firestore), nothing adds or removes the tag. With the ledger off, the HighLevel calls are the legacy ones, apart from the changes listed under Live at deploy.
    - **At-least-once.** A lead is synced at least once, not exactly once. If the HighLevel sync succeeds but its result cannot be saved (every settle read or write fails; retries try two rounds, the request three), the receipt stays `syncing` and the cron syncs the lead again after its 10-minute claim, as a late sync: HighLevel gets the contact upsert and tags again and a second detail note (same `Idempotency-Key`), the opportunity is left alone (the contact now exists), and no second Zapier text is sent. The same holds when the receipt commit's outcome is unknown and cannot be re-read: the request falls back to the direct sync, reads the receipt once more before the Zapier relay, and then tries once more to mark that receipt synced; only if that fails too does the cron sync it again. If that read before the relay finds the receipt under another claim (a concurrent copy of the same submission holds it and sends the one text), the request skips the relay (`relay.skipped: 'already-received'`) and leaves that receipt alone, so the customer is not texted twice. If the read fails, the request relays as before, so the lead's text is never lost. A commit refused because the receipt already exists (a concurrent copy of the same submission, a double tap or an fb-capture resend, owns it) never falls back: when the receipt cannot be re-read either, the copy answers 503 `web_lead_receipt_busy` and neither syncs nor relays, so the customer is not texted twice; a resend replays the receipt.
    - **Retention.** An abandoned receipt keeps its sealed payload for the owner for 30 days (its `retryAt` is then the purge date); the first tick after that sets it to null and records `payloadPurgedAt`, with no HighLevel call. The payload key derives from `HUB_SESSION_SECRET` while `HUB_PURPOSE_KEY_SECRET` is unset, so rotating the session secret makes every unsynced sealed lead unreadable (it is abandoned as `payload_unreadable`); set `HUB_PURPOSE_KEY_SECRET` before turning the ledger on.
    - **Visibility.** The tick's response carries a `webLeads` summary (due, attempted, synced, failed, abandoned, held, purged, notAttempted, deferred; `held` counts ads leads a closed ads gate stopped, which `abandoned` leaves out) that the Railway worker adds to its `messaging_cron` log line and `messaging_cron:last_result` cursor as `webLeads*` counts, on completed ticks and on the 409 `messaging_cron_disabled` tick alike. An abandoned or unavailable retry pass also logs an error line. Individual receipts are inspected in the Firestore console until FUN-25 lists them.
    - **Undercount.** A ledger outage (read or commit fails) falls back to the direct sync, so the lead is delivered but has no receipt and no `inquiry.received` event. The response says `receipt: {status: 'unavailable'}` and the function logs a count-only `{"event":"web_lead_receipt_unavailable"}` line (no lead data). FUN-25 reconciles web-form inquiries against HighLevel contacts tagged `egc-website-lead` to find them.
    - Ads landing page leads are receipted and counted but held (no HighLevel sync, no text, no sealed payload) until `WEB_LEAD_ADS_RELAY_ENABLED=true`, because before the fix they never reached the automations that sync would start. An ads lead accepted while the gate was open whose first sync failed is not synced once the gate has closed: its retry abandons it as `ads_relay_disabled` (it is not retried if the gate reopens), and its sealed lead is kept for the same 30 days as any abandoned lead.
    - **Client hub help** has no Web3Forms copy. With the ledger on, a hub help message whose sync failed but will be retried answers 202 `{ok: true, accepted: true, receipt: {status: 'failed'}}`, and `customer-portal.html` then says the message is still on its way (overnight that can take until morning) with the office number, instead of "The team can see it in HighLevel". One nothing can retry (no sealed payload) answers exactly as the legacy relay did (502 when HighLevel fails, 503 when nothing is configured), so the customer sees the error and can resend. So does one HighLevel refuses outright (`highlevel_rejected`, a 4xx other than 408/429, which a retry would only repeat until it is abandoned about 45 hours later): it answers 502 and its receipt is abandoned at once (`abandonReason: 'highlevel_rejected'`, sealed copy kept 30 days), so the customer's resend is never followed by a late duplicate. It answers 502 only once that abandonment is saved: if every settle write fails, the receipt is still due and the cron owns it, so the answer is 202 queued instead and the cron retries the message (it reaches the team once HighLevel accepts it, or is abandoned after about 45 hours). Website leads HighLevel refuses keep retrying (a fixed API key, scope or stage id lets them through, and the Web3Forms email has them meanwhile), and a hub help message queued after a 5xx that HighLevel later refuses is retried until it is abandoned.
    - **Live at deploy, even with both flags unset.** Ads page leads now reach `/api/web-lead`, where they are held exactly as before (Web3Forms email only). book.html fires a browser Meta Lead with `eventID` = `inquiry_id`: until the owner maps `inquiry_id` to the CAPI `event_id` in the `WEBSITE_LEAD_HOOK_URL` Zap (same dataset as the pixel), SMS-consented book leads are counted twice in Meta. The Zap receives a new `inquiry_id` field. HighLevel lead notes gain an `Inquiry ID:` line, and the note `Idempotency-Key` uses `inquiry_id` first. Every HighLevel call now has a 15 s timeout (a retry's calls are cut further to end by 75 s into the tick). fb-capture also maps a form field named `ZIP` to `serviceZip`.
    - **Owner checklist before `WEB_LEAD_RECEIPTS_ENABLED=true`.** Nothing in HighLevel needs changing: no workflow, trigger, filter, tag or pipeline edit. With `WEB_LEAD_DELAYED_SYNC_TAG` unset, a lead synced late (after a HighLevel outage) starts the HighLevel automations late, exactly as if it had just arrived.
      - Set `HUB_PURPOSE_KEY_SECRET` (see Retention).
      - Check HighLevel's opportunity search on a test contact (a read, nothing is changed). Give the test contact one open and one closed (won or lost) opportunity in the `HIGHLEVEL_PIPELINE_ID` pipeline. Then call `GET /opportunities/search` with the location's API key and exactly the parameters a late sync sends: `locationId`, `contactId` (the test contact), `pipelineId`, `status=all`, `limit=100`, `page=1`. Confirm that the answer holds only that contact's opportunities (the contact filter is honoured), including the closed one. The Hub keeps these parameters as they are for now.
        - If other contacts' opportunities come back, or the call fails, a late sync never opens an opportunity for a contact its own earlier attempt created (`opportunitySkipped: 'opportunity_check_failed'`; the detail note asks the team to add one). That is safe but manual; report it so the query can be fixed.
        - If the closed one is missing, keep the ledger off and report it: a late sync could then reopen a closed deal at the new-lead stage.
      - Expect at-least-once delivery (see At-least-once): an occasional second detail note on a contact is normal, and the contact upsert and the source and consent tags are sent again. On a test contact, confirm that sending tags the contact already has does not start their workflows a second time. The legacy relay already repeats these calls when a lead is resent.
      - **Optional, only if you want late leads to skip an instant reply** (this does change HighLevel; skip it otherwise). Set `WEB_LEAD_DELAYED_SYNC_TAG=true`, then:
        - On a test contact, confirm the late-sync tag really lands and clears. Let one synthetic lead fail its first sync and be retried (for example, submit it while `HIGHLEVEL_API_KEY` is briefly unset and restore the key before its 5-minute retry). Then check the contact shows `egc-delayed-sync` and the receipt says `delayedTag: 'added'`. Send that contact an on-time lead and check the tag is gone (`delayedTag: 'cleared'`). If either says `failed` or `clear_failed`, the location's API scopes do not allow tag writes and the filter below cannot work: unset the flag again.
        - Add an "unless tagged `egc-delayed-sync`" filter only to the instant-reply workflows a website lead starts: those triggered by the `egc-website-lead`, `egc-client-hub-help`, `egc-sms-consent` or `egc-no-sms-consent` tags, and those triggered by `Contact Created` (a brand-new contact carries the tag only when a late website sync just created it). In the `Contact Created` ones, put a short wait (about 1 minute) before the check. Do not add it to workflows for other channels (Facebook lead ads, native HighLevel forms, calls, texts) or to opportunity triggers: only an on-time website lead removes the tag, so there it would silence that contact's replies indefinitely.
        - Audit every workflow started by opportunity created, pipeline stage changed or opportunity status changed for instant customer messages. Move any you want skipped for late leads to a tag-triggered workflow with the filter. A late sync can still open a new-lead opportunity (only for a contact its own failed attempt created that has no opportunity in the pipeline, open or closed), and the tag cannot safely filter those triggers.
        - To turn the flag off again, remove those filters first: contacts keep the tag once nothing removes it.
- **FUN-35 Structured attribution and provenance** (flag-gated until FUN-30 signs off).
  - GHL contact custom fields: first-touch fields written once, and last-touch `utm_*`, `gclid`, `msclkid`, `fbclid`, `fbc`, `fbp`, landing, referrer, `inquiry_at`, `inquiry_id`.
  - A new opportunity is opened only when none is open; otherwise the contact gets the tag `egc-repeat-inquiry` and a note.
  - `advanceOpportunity` creates opportunities with `source:'egc-hub'` and a Hub receipt.
  - The booking form requires `channelSelfReported` when the contact has no attribution.
- **FUN-14 Platform per-cycle lead model.**
  - The §4.2 tables and columns: `lead_inquiries`, `lead_cycles`, `customer_events.cycle_id`, and the cycle in `canonicalEventId`.
  - The origin classifier, fed by FUN-37 for Hub receipts, bookings and outcomes.
  - The new-vs-repeat flag.
  - First automation touch and first human response using the lead-audit classifier, with the `message_sends`/`userId` fix; latency raw and in business hours.
  - The evidence-only rule enforced in the report layer.
  - Lead-side metric functions with sync `asOf` and coverage.
- **FUN-15 Ad spend.**
  - Meta Marketing API (system-user `ads_read`) and Google Ads API (developer token) daily spend, impressions and clicks by campaign and ad set into `ad_spend_daily` (cents; account time zone and Denver date), with a 3-day restatement re-pull.
  - Owner-only `spend_entries` for non-API channels, with a receipt and `attested` clock.
  - Meta leadgen counts per form per day.
  - Read-only toward the ad platforms, with health tracked in `sync_cursors`.
- **FUN-16 Phone lines and off-GHL sends** (conditional).
  - For each published number (970-999-1818, 970-999-1308, 970-658-9454, 970-999-1403), confirm the provider and whether calls and SMS reach GHL.
  - Ingest the rest (Quo webhooks for calls, missed calls and SMS, including the Zapier→OpenPhone texts and the `/api/quo-send` texts) into `calls`/`messages` with the number, direction, actor and answered flag.
  - Per-number coverage. Close the unit if the owner moves the numbers into GHL LC Phone instead.
- **FUN-30 Automation inventory and registry.**
  - A read-only inventory of GHL workflows: the public API lists workflows; triggers and message steps come from the internal workflow API or an owner export. It also covers Zaps and Conversation-AI auto-replies.
  - A Hub `automation_registry` holding `{id, trigger, channel, templateText, templateHash, classification: owner_automation | disabled | internal, approvedBy, approvedAt}`.
  - The list of Hub writes that trigger each workflow.
  - Automation-touch classification for speed to lead.
  - A monthly owner re-attestation.
  - Gives the FUN-11 dialog its texts, and gives the FUN-12/35 flags their go/no-go.
- **FUN-33 Payment events.**
  - `recordStripeCheckout` and `recordCrewStripePayment` move to `:commit` with events, idempotent by `sessionId`/`event.id`.
  - `occurredAt` = Stripe `charge.created`.
  - Payment kind rule: crew payments without a purpose count as a deposit if made before the service date and ≤ the deposit amount, otherwise as a balance, and are flagged.
  - M3 offline actions call the helper.
  - `paidInFullAt` and `paidInFullRevision` are recorded. `job.paid_in_full` is bound to the revision, and `job.balance_reopened` fires on a revision, change order, refund or re-sign.
  - Gift-credit redemptions are marked non-cash.
  - Job `status` is kept for the UI but never read by metrics.
- **FUN-17 Stripe fees, refunds, disputes.**
  - Expand `latest_charge.balance_transaction` and store `feeCents`, `netCents` and `balanceTransactionId`, with the tip-portion fee allocated.
  - Webhooks `charge.refunded`, `refund.updated` and `charge.dispute.created/closed/funds_withdrawn/funds_reinstated` become negative ledger entries with events, and reopen balances where needed.
  - Every balance transaction is classified by metadata and stored for FUN-25.
  - A dry-run backfill from the Stripe API.
- **FUN-18 Field taps drive timecard segments.** For clocked-in assigned crew: Dispatched opens travel, Start opens work, and Complete returns to general. Segments are flagged `autoAttributed` and editable with history. Dispatched prompts clock-in. Idempotent requestIds.
- **FUN-19 Closeout expense attestation + kinds.**
  - Closeout requires each of dump fee and materials to be entered, or "None".
  - New kinds: `subcontractor`, `fuel`, `damage_claim` (linked to damage photos) and `recovery_income` (negative).
  - A `payer` field: company_card | crew_reimbursable | account_billed.
  - Shared-load split with explicit shares.
  - Catalog `standardUnitCostCents` for stocked items, owner-entered via P2-03/P2-04 settings.
- **FUN-20 Garage Guard.**
  - Store `amount_paid`/`amount_total`/discount/promo on `stripe_events` and `memberships`.
  - Member visits carry `membershipId`. The idempotent `visitsRemaining` decrement at completion emits `membership.visit_used`.
  - Revenue allocation per the owner decision.
  - Churn classed as voluntary or involuntary; renewal events; deferred revenue.
  - Manual browser `garageGuard` edits are flagged.
  - **As built** (`functions/_lib/garage-guard-ledger.js`, `functions/_lib/garage-guard-visits.js`, `functions/api/garage-guard-members.js`; definitions 2026-09-28.3 add `vocabularies.garageGuardPlans` and `membershipChurnClasses` and the data fields `plan`, `churnClass`, `discountCents`, `breakageCents`):
    - **Amounts.** `stripe-webhook` wraps the membership store with `garageGuardLedgerStore`, so the commit that records a Stripe event (behind `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED`, as before) also writes `stripe_events/{eventId}.amounts` (amount paid, total, subtotal, due, discount, promotion codes, coupons, currency, invoice and session ids; `null` when Stripe did not say) and on `memberships/{id}`: `amountPaidCents`, `amountTotalCents`, `discountCents`, `promotionCodes`, `couponIds`, `currency` (from the newest payment by Stripe `created`), `checkout`, the paid `invoices[]` and `lifetimePaidCents` (subscription cash is invoice `amount_paid` only; a checkout is never counted as cash). A ledger failure never blocks recording the membership: it saves `ledgerError` on the membership and receipt. Nothing clears it, so the A8 summary treats that member's ledger as out of step from then on (see A8 summary).
    - **Billing periods** (`periods[]`). The first paid checkout or invoice opens one (the first invoice confirms a checkout-opened period instead of opening a second); each `subscription_cycle` renewal closes it and opens the next; a proration or manual invoice pays into the open period. A period starts at its invoice's subscription-line `period.start` (only `type: subscription` or `parent.type: subscription_item_details` lines, as `invoiceSubscription` reads them; proration lines and invoice items swept into the invoice are ignored), or when it was opened. Each period keeps `plan`, `paidCents`, `visitsIncluded`, `visitsTracked`, `visitsUsed`, `recognizedCents`, `visits[]` and `adjustments[]`; closing sets `breakageCents = paidCents - recognizedCents` on the renewal or cancel date.
      - **Unknown breakage.** `visitsTracked` is `GARAGE_GUARD_VISIT_TRACKING_ENABLED` as the webhook saw it when the period opened, at each later Stripe event and at its close (switching it off and on between two events is not seen), and it is also false once the membership was not linked to a Hub customer (`needs_review` or `unlinked`) at any of those events, because the Hub counts no visit of an unlinked member. Breakage is known only for a period the ledger tracked throughout; otherwise it closes with `breakageCents: null` and `breakageUnknown` saying why: `visits_untracked`; `visits_unresolved` (when a tracked period closes, the webhook lists the membership's member-visit jobs with one exact `membershipId` query; any completed in the period that is still `pending`, `not_recorded` or `needs_review` is kept in `unresolvedVisitJobIds`, and the breakage stays unknown until each is counted in that period as a late visit or settled with `visits.reconcile` `jobIds`, or the period is fully used; the listed jobs the ledger has not counted that could still land in the period (a visit job, never a server record, that is not cancelled or no-show and was completed in the period or is not completed yet) are fenced at their listed revision in the close's commit, at most 100 (`LEDGER_LIMITS.fences`: those not completed yet first, nearest the close by `date`, then the period's listed visits; the list is never made unknown for it), and `visit.link` writes the membership, so a link or a completion that lands between the listing and the commit makes the event retry with a fresh listing; `unresolvedVisitJobIds: null` means the jobs could not be listed, or more than 60 of the period's own completed visits are uncounted (cancelled and no-show jobs, scheduled jobs and visits of other years never count toward that limit): a failure listing them answers 503 so Stripe redelivers while the event is less than an hour old (`VISIT_LIST_RETRY_MS`), and after that the membership, churn and receipt are recorded anyway with `visitsUnlisted {at, code}` on the closed period and the receipt, so a listing that keeps failing never blocks the membership record; a later `visits.reconcile` lists the membership's visits again and fills the list when it can, and a year it still cannot list (the listing keeps failing, or more than 60 of its visits are waiting) stays unknown until a manager confirms none of its visits is waiting (`confirmEmptyPeriodIds`, see Manual edits)); `manual_edit` (the account job's visit counts differed from the membership's at close, or a manual-edit flag was open; `countsAtClose` keeps both counts); `payment_disputed` (a `cancellation_details.reason` of `payment_disputed`, until FUN-17 records the dispute outcome); `unknown_allocation` (a visit or reconcile in it has unknown revenue); `amount_unknown`; `pre_ledger`. `membership.renewed` and `membership.cancelled` then carry no `breakageCents` (unknown is left out, never 0 or the whole price). A late visit applied to such a period adds visit revenue and leaves its breakage unknown (except that counting or settling its last unresolved visit makes a `visits_unresolved` period's breakage known). While open, the same period's deferred revenue is unknown.
      - **Plan changes.** A proration invoice with another plan records `planChanges[]` on the open period, which keeps the `visitsIncluded` it opened with (a plan change does not reset or top up the member's visit count). Price paid ÷ included visits no longer describes one plan, so from then on its member visits have unknown revenue (`allocatedCents: null`) and, once one does, its breakage is unknown, pending an owner decision (§13 decision 11). A plan change that resets the billing anchor bills a new year from the change: when a non-cycle paid invoice's subscription line ends after the open period's `periodEnd`, the open period now runs to that end (the member paid through it, so visits before it are not held as `awaiting_renewal`), recorded as a `planChanges[]` entry with `previousPeriodEnd` and `periodEnd`.
    - **Members recorded before FUN-20.** The first ledger write on a membership that was already past `pending` without a ledger marks it `preLedger: true` for good and saves `provisionalStartedAt` (the Stripe time of the event that set its live status, so it was live at least since then). A `preLedger` member never gets `startedAt` or `membership.started`, even after a failed renewal that is then paid (only a membership the ledger followed from the start, with no `ledgerError`, can be `past_due` without ever having been active). When its pre-ledger year renews or ends, a closed stub period `pre_ledger` (amounts, visits used and breakage unknown) is added, so the renewal or lapse is counted.
    - **Events** in the same commit, keyed by the Stripe `event.id`, `clockSource: provider`, `via: stripe`: `membership.started` (first time active; amount, discount, plan), `membership.renewed` (amount, discount, the closed period's breakage), `membership.payment_failed` (amount due), `membership.cancelled` (`churnClass`, `initiatedBy: system` when involuntary, breakage). The events are append-only, so their `breakageCents` is the breakage as known at the close. A service visit that nobody had linked as a member visit by then and that is linked into that year afterwards joins the closed period's `unresolvedVisitJobIds`, so the period's breakage (which the A8 summary reads) is unknown again until the visit is counted there, which lowers the period's `breakageCents`, or settled; the event keeps the breakage known at the close.
    - **Churn.** `involuntary` when Stripe's `cancellation_details.reason` is `payment_failed`/`payment_disputed`, or it is absent and the member was `past_due` (dunning); `voluntary` for `cancellation_requested`, or absent while `active`; otherwise unknown. Stored as `memberships.churn {class, source, reason, feedback, statusAtCancel, at}` and on the receipt; the free-text cancellation comment is never kept.
    - **Member visits.** A member visit is a job with `membershipId` (FUN-02 books it with `visitPurpose: member_visit`; `visit.link` marks an existing service visit of the member's customer, and refuses one completed, or dated, before the membership's `startedAt`). `visit.link` also refuses (`409 visit_before_period`) a visit before the membership's oldest year on file when it has no `startedAt` (a member recorded before FUN-20: one year before `currentPeriodEnd`, or with none on file the later of when the Hub recorded it and its provisional start). The field completion commit records `membershipVisit: {status: pending}` (not on a job already `applied` or `reconciled`, so a job completed again keeps its state); with `GARAGE_GUARD_VISIT_TRACKING_ENABLED` the handler then applies it (`applyMembershipVisit`, via `waitUntil`), and managers can apply it with `visit.apply`. One commit decrements `visitsRemaining`, logs the visit in the open period with `allocatedCents` (§13 decision 11: `floor(paid / included)`, the last included visit takes the remainder, never more than the period still holds; `null` when the amount is unknown or the plan changed; the visit's `occurrence` is its place in its own period, `visitsUsed + 1`), sets the job's `membershipVisit.status: applied` (the idempotency guard; the job carries the occurrence and `periodId` but no money, because managers can read jobs: a visit's revenue is kept only in the server-only membership ledger and shown to the owner), mirrors the count onto the account job's `garageGuard` and writes `membership.visit_used` (`clockSource: system`, `occurredAt` = the completion, derived key `garageGuardVisit:<jobId>`, with `occurrence`, `amountCents`, `plan`; `isTest` also follows the membership's Stripe `livemode`).
      - A visit belongs to the billing period it was **completed** in, not the one open when it is applied. A closed period covers visits from its start until it closed, but never past the `periodEnd` it was paid for. A visit completed before a renewal or cancellation but applied later is logged in that closed period (`afterClose`, `periodClosed`): its `recognizedCents` rises, its `breakageCents` falls by the same amount (or becomes known, when the period was waiting on that visit), and `visitsRemaining` and the account mirror are not touched. `visit.link` also takes a cancelled membership's visit when it was completed in a closed period of the membership, so that visit can be counted there; a visit completed after the cancellation is refused (`409 membership_not_active`). Linking a completed visit into a closed period adds it to that period's `unresolvedVisitJobIds` (result `periodId`, `periodClosed`), so its breakage is unknown until the visit is counted or settled. Every link writes the membership (`lastVisitLinkAt`, `lastVisitLinkJobId`) at the revision it read, never only verifies it.
      - The ledger is the record of what was counted: a visit already in a period's `visits[]` (or covered by a reconcile) whose job marker was reset (a job reopened and completed again) gets its marker restored and returns `duplicate`/`reconciled`; it is never counted twice. If only its `membership.visit_used` event remains, the visit is `needs_review: already_counted`.
      - A visit completed on or after the open period's `periodEnd` while its renewal is unpaid (dunning) belongs to a year not yet paid for: it is `needs_review: awaiting_renewal` and nothing is decremented. Once the renewal is paid, a manager's `visit.apply` counts it in the new year. If the membership is cancelled instead, the visit belongs to no paid year: it is `needs_review: after_paid_period` (completed after the closed period's `periodEnd` and before it closed), never booked into the old year, and a manager settles it with `visits.reconcile` `jobIds`. A membership with no billing period (recorded before FUN-20) takes only visits in its current Stripe year [`currentPeriodEnd` − 1 year, `currentPeriodEnd`); with no period end on file the later of `createdAt` and `provisionalStartedAt` bounds it.
      - A visit the membership cannot take (`membership_not_found`, `membership_unlinked`, `customer_mismatch`, `visit_before_membership`, `visit_before_period` (before the open period with no closed period that can take it, such as a `pre_ledger` stub, or before a pre-FUN-20 member's current year), `awaiting_renewal`, `after_paid_period`, `membership_not_active`, `visits_unknown`, `no_visits_remaining`, `account_job_changed`, `manual_edit_open`, `already_counted`) is `needs_review` and nothing is decremented.
    - **Manual edits.** The browser "Garage Guard status" dialog now saves `source: 'hub_manual'`. Once the server has mirrored a membership, an account-job `garageGuard` whose plan, status or visit counts differ from the membership is flagged `memberships.manualEdit {status: open, fields, rewritten, observed, expected}` on the next Stripe event or visit, and shown live by the GET view. A Stripe event flags only the fields that still differ after its own commit: the mirror always rewrites plan, status and visits included, and a renewal restores the visit count, so a browser count settled by a renewal is not flagged (the closed year keeps it in `countsAtClose` with its breakage unknown), and a flag already open is resolved (`resolution: renewal_reset`, `resolvedBy: stripe_webhook`) once the renewal's mirror matches. A save that changed only `nextVisit` or `renewalDate` is not drift (the next server mirror restores `source` and `membershipId`) and never blocks counting. Visits are not counted while the account job's counts still differ from the membership (the stored flag stays open for the owner until reconciled). `visits.reconcile` (owner or manager, a 10–500 character note) sets the true count, recognizes the visits used outside the Hub at the per-visit allocation as the period's next visits (an `adjustments[]` entry; the open period's `visitsUsed` moves by the change, on the period's own `visitsIncluded`), mirrors it and resolves the flag. Its optional `jobIds` (up to 20 completed member visits of this membership that the reconciled count already includes) are marked `membershipVisit.status: reconciled` in the same commit and listed on the adjustment, so they can never be applied on top of that count; this is also how a manager closes out a `needs_review` visit without counting it. A job a closed year is waiting on (in its `unresolvedVisitJobIds`) is always accepted: when it is no longer a completed, uncounted member visit of this membership (cancelled as a duplicate, reopened, deleted, moved to another membership or counted elsewhere), it is only dropped from that year's list (`droppedJobIds` on the adjustment, the result and the audit entry) and never marked, so a later completion is still counted where it belongs. A reconcile also lists the membership's member visits again for any closed year whose list is unknown (`null`), fencing in its commit the listed jobs that could still land in that year, and fills the list only when the listing works and 60 or fewer of that year's visits are waiting. A year it still cannot list is settled only by `confirmEmptyPeriodIds` (the ids of up to 40 closed years whose list is `null`; any other id is `409 period_not_unlisted`): the manager confirms that no member visit of that year is waiting, so its list becomes empty and its breakage is settled, with `visitsConfirmedEmpty {at, by, requestId, note}` on the period and the ids on the adjustment, the result and the `hub_audit` entry, whose reason is the required note. While confirming, a listing that still fails does not fail the reconcile; a named year the listing does fill is listed, not confirmed.
    - **API.** `GET /api/garage-guard-members?period=…` (owner/manager): members with link, visits, churn, manual-edit flags and `testMode`; member visits by state (`scheduled`, `pending`, `not_recorded`, `applied`, `reconciled`, `needs_review`, `cancelled`); and the A8 summary (`garageGuardSummary`). Each membership shows `preLedger`, its open period's `visitsTracked` and `unresolvedPeriods` (closed years whose breakage waits on member visits: `periodId`, `closedAt`, `jobIds`, `null` when never listed, and `unlisted`); the owner also sees `lifetimePaidComplete` next to `lifetimePaidCents` (false for a `preLedger` member, whose earlier years the ledger never saw) and each applied visit's `allocatedCents` read from the ledger. The view's `coverage` is incomplete (`visitsUnresolved`, `unresolvedVisits`) while a completed member visit of a live-mode membership is `pending`, `not_recorded` or `needs_review`, and (`manualEdits`, `coverage.manualEdits`) while a live-mode membership has a manual edit open, stored or seen live on its account job. The view passes the account jobs it read to the A8 summary, so an account job whose visit counts differ from its membership makes that open year's totals (and the owner's `deferredCents` for that member) unknown before any Stripe event or visit stores the flag. `POST` takes `visit.apply`, `visit.link` and `visits.reconcile` (with optional `jobIds` and `confirmEmptyPeriodIds`) with a `requestId` receipt in `garage_guard_operations` and a `hub_audit` entry in the same commit; funnel event errors answer `409 funnel_event_idempotency_conflict` or `400 funnel_event_invalid` instead of a retry message.
    - **A8 summary.** Stripe test-mode memberships (`livemode: false`, the shared `stripeEligibility` rule) are left out of every number and counted in `coverage.excluded.testMode`. Members active, new (`startedAt` in the period), cancelled; churn counts by class, and churn rates = cancellations of members live at the period start ÷ members live at the period start (`churn.ofActiveAtStart`). A member is live at the start when its `startedAt`, or for a member recorded before FUN-20 its provisional start (`provisionalStartedAt`, or while still live the Stripe time of the event that set its status), is before the period and it had not cancelled; provisional ones are counted in `members.activeAtStartProvisional` and `coverage` `provisionalStart`. A cancellation of a member who joined in the period is outside the rate by definition (`churn.startedInPeriod`); one whose start cannot be placed is `coverage` `unknownChurnPopulation`, never mixed into the rate. Renewal rate (including a pre-ledger member's `pre_ledger` stub, and its `currentPeriodEnd` while it has no period yet as awaiting payment); visit utilization of closed and open periods; visits used in the period including `unallocatedVisits`. The visits used (`visits.usedInPeriod`), visit revenue and recognized revenue are null whenever the ledger may not hold every visit of the range, whether or not a period closes in it: a live member with no open period (`noLedger`: every member recorded before FUN-20 until its first renewal), a member recorded before FUN-20 (no ledger `startedAt`) in a range before its first ledger year, unless it had cancelled before the range, or a billing period overlapping the range that is a `pre_ledger` stub (its plan year before `periodEnd`), was not tracked throughout, has a browser count against it (`manual_edit` at its close, or a manual edit open on its membership while it is open: a stored flag, or in the GET view an account job whose visit counts differ from the membership now, which no Stripe event or visit has flagged yet) or closed with unresolved visits, or a range ending after the member's ledger fell out of step with Stripe (`ledgerStaleFrom`: a `ledgerError`, from when it was recorded; an open period whose `periodEnd` is before the membership's `currentPeriodEnd`, a renewal the ledger missed, from that `periodEnd`; a cancelled membership whose period is still open, from the cancellation) (coverage `unknownVisits` counts those members; `visits.knownUsedInPeriod` is the floor). For such an out-of-step member, breakage is also unknown in a range holding that point or any later close (the close it missed, or a close that may have closed the wrong year), deferred revenue and MRR (read from its open period, which may be the wrong year) are unknown, and `coverage` `ledgerErrors` counts it. An unknown amount paid is not such a gap: a tracked period still logs each visit, with unknown revenue (`unknownAllocation`). For the owner only: subscription cash, visit revenue, adjustment revenue, breakage, deferred revenue, MRR, and `memberLtv {basis: 'revenue', members, totalCents, averageCents}` = realized `lifetimePaidCents` per member to date over members whose every payment the ledger recorded (a `startedAt`, not `preLedger`, a ledger in step with Stripe, `lifetimePaidComplete`, which needs at least one invoice on file: a member recorded only from its checkout is not counted as $0). Utilization counts only periods the ledger tracked throughout with no browser count against them; deferred revenue is unknown for an open period that is untracked, has a visit of unknown revenue, or whose membership has an open manual edit or a ledger out of step with Stripe. A closed period with `visits_unresolved` breakage counts as `unknownUsed`. Everything it cannot establish is counted in `coverage` (`noLedger`, `unknownStart`, `provisionalStart`, `unknownChurnPopulation`, `unknownCash`, `unknownAllocation`, `unknownBreakage`, `unknownDeferred`, `unknownMrr`, `unknownIncluded`, `unknownUsed`, `unknownVisits`, `visitsUntracked`, `unknownLifetime`, `manualEdits`, `ledgerErrors`), never zero-filled. Each revenue total (`subscriptionCashCents`, `visitRevenueCents`, `adjustmentRevenueCents`, `breakageCents`, `recognizedCents`, `deferredCents`, `mrrCents`) is null when any contribution to it is unknown, never a partial sum (so with `GARAGE_GUARD_VISIT_TRACKING_ENABLED` off, the production default, visit, recognized and deferred revenue are null for every range a live member's year overlaps, in every month, and breakage is null whenever such a year closes in the range; breakage is a known 0 only in a range where no year closes); `revenue.knownCents` keeps the sum of the known contributions of each, a floor on the total, to read next to `coverage`.
    - **Moved to FUN-21/FUN-22.** Member revenue share needs the period's total business revenue, which only the single FUN-22 pulse engine computes: its numerator is this summary's `revenue.recognizedCents` (subscription revenue recognized in the period: visits, adjustments and breakage), and the share is unknown while that is null. Contribution-basis member LTV (§6.6) needs FUN-21 project contribution and adds it to `memberLtv` per `link.customerId`.
- **FUN-36 Server credits, gift cards and remaining browser writers.**
  - `credit.issue` with class gift_purchase | garage_guard | referral | courtesy (courtesy credits over a threshold are owner-only).
  - `gift_card.sell` records cash plus a liability.
  - `decision.prompt` (customerDecisions on the server clock) and `rebook.mark_contacted`.
  - Receipts, `hub_audit` entries and events.
  - The employee-suite browser paths are switched to these actions (flagged).
  - **As built:** `functions/_lib/customer-lifecycle.js` + `POST/GET /api/customer-lifecycle` (owner/manager; writes only with `CUSTOMER_LIFECYCLE_API_ENABLED=true`). Each action is one `:commit`: the changed job (updateTime precondition), verify-only fences on the account-lineage hops, a `lifecycleOperations/{requestId}` receipt, a `hub_audit` entry and the events.
    - `credit.issue` writes a classed card on the customer's account root (`giftWallet.cards[]`, the same chain the portal reads; an empty `customerAccountOwnerJobId` means the job is the account, as in the portal) → `credit.issued`. Each card records `issuedByOwner`. `gift_purchase` via `credit.issue` is owner-only, only for cards sold before the Hub, needs the original sale reference, and claims that reference exactly like a sale (below), so a card is never imported twice or on top of a recorded sale. A manager's `garage_guard` credit needs an active, Stripe-backed Garage Guard membership, read as the portal reads it (the account root's `garageGuard`, else the job's own legacy `membership`): `source` `stripe` with the `sub_…` subscription id in `membershipId` (what the FUN-20/M2 Stripe sync mirrors), `plan` lite, guard or black, `status` exactly `active` (not paused, past_due, pending or cancelled) and a whole `visitsRemaining` above 0. Otherwise only the owner can issue it, because Garage Guard credit is payment-class (§6.2) and a relabelled courtesy credit would read as retained revenue. The Hub's "Garage Guard status" editor (`opsSetCustomerMembership`, unchanged) replaces `garageGuard` without `source` or `membershipId`, so a membership a manager types there never qualifies; on a real member such an edit also removes the marker until the next Stripe event mirrors it back. With `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED` off no membership is Stripe-backed, so only the owner issues Garage Guard credit. The Hub form has no default credit type and offers a manager only the types they may issue.
    - **Owner limits bind a manager's running total per customer account, not each credit:** every card a non-owner issued on that account in the last 30 Denver days (today included) in the same group, plus the new amount. Groups: courtesy + referral (the contra-revenue classes) against `COURTESY_CREDIT_OWNER_LIMIT_CENTS` (default $100.00); Garage Guard credits + a manager's gift-card sales (payment-class) against `PREPAID_CREDIT_OWNER_LIMIT_CENTS` (default $1,000.00). The owner's own cards never count. A card with no class (written by the flag-off browser tool, or before FUN-36) counts toward the courtesy + referral total when its `issuedBy` names someone other than the owner and its `issuedAt` is readable and inside the window, so turning the API on does not start a manager's total at $0. A counted card with an unreadable amount makes the total unknown and refuses the manager. The wallet is on the account document written under its updateTime precondition, so two racing credits cannot both pass. The GET view returns `account.managerIssued` (`contraCents`, `prepaidCents`, `since`) and `account.garageGuard.eligible`, and the Hub form checks both before sending.
    - `gift_card.sell` writes the cash to the server-only `giftCardSales/{requestId}` ledger (`gift_card.sold`, `attested` at the received time) and the liability as a `gift_purchase` card (`credit.issued`). It never touches job payment fields. The Hub form has a "Date received" (Denver) field: today is stamped by the server clock, an earlier day (up to a year back) is sent as noon in Denver on that day, so the cash lands on its Denver day. A manager's sale paid `other` needs the owner (no evidence to reconcile); the form does not offer it to managers. The same payment entered twice is refused (`lifecycle_sale_duplicate`, 409, naming the earlier sale or pre-Hub card): a create-only `giftCardSaleRefs/{sha256(normalized reference)}` claim (compared without case, spaces or punctuation; keyed by the reference alone, with the method, `pre_hub` for an imported card, kept as data) is written in the same commit, so the same check entered as `check` and again as `other` is caught. A different payment with a colliding reference must make its reference more specific.
    - **Until FUN-27 the limits are advisory.** What is enforced today: every change saved through `/api/customer-lifecycle` (the Hub form when the flag is on) is checked there: credits and sales against the running totals, the Stripe-backed membership rule and the `other`-sale rule, and credits and decisions against the full lists. What is not: the `jobs` rule still lets any business SDK session write any field, so a manager with devtools can write `giftWallet`, `customerDecisions`, `rebookingRequests` or `garageGuard` directly, with no receipt, audit entry or event, including a forged Stripe marker on `garageGuard`. The Hub's own "Garage Guard status" button also still writes `garageGuard` from the browser with no receipt or audit entry, but what it writes carries no Stripe marker, so it cannot make an account eligible for a manager's Garage Guard credit. The limits bind every path only once FUN-27 denies browser writes to those fields.
    - `decision.prompt` appends a pending `customerDecisions` entry stamped with the server clock → `change_order.proposed` (amountCents = the proposed price change, 0 allowed). Customer notification stays the Hub's separate confirmed "Decision needed" trigger, keyed by the decision id (`communication:<jobId>:decision-needed:<decisionId>`) like the legacy path, so each decision gets its own CRM note and log entry.
    - `rebook.mark_contacted` marks one pending `rebookingRequests` entry contacted → `rebook.contacted`.
    - Full lists (20 credits, 20 decisions) are refused instead of trimmed, so a live balance or an approved change order is never dropped. There is no archive action yet: the refusal tells the manager to have the owner get the fully used credits or answered decisions archived in the database (follow-up: `credit.archive_used` / `decision.archive_answered`).
- **FUN-21 Project contribution engine.** Implements §6: project unit, precedence, component statuses, P1-03 chunked calls, burden, owner shadow rate, credit classes, change-order de-duplication, cancellation revenue, standard cost, restatement. Adds a read-only `GET /api/job-costing?view=contribution` and replaces the browser `jobEconomics`.
- **FUN-22 Pulse engine.**
  - A pure computation at one Firestore `readTime` over all sections, with in-progress truncated comparisons.
  - Deterministic headline templates.
  - Role projections: owner actuals; standard-rate labor for others; suppression when fewer than 3 employees.
  - Deny-list tests on cost, pay, fee and margin fields.
  - Golden fixtures shared with the platform.
- **FUN-38 Rollups.** Closed-day rollups in the server-only `pulseRollups`, keyed by `definitionsHash`, recomputed on restatement events. Only the open day is computed live, which keeps qtd/ytd with comparisons within Pages Functions limits.
- **FUN-23 Bridge metric commands.** The §8.2 command list, with owner/manager delegates, role projections, summary-by-default and pagination.
- **FUN-25 Reconciliation.** All the §9.2 invariants. It writes `dataQuality` records and records `project.closed`, `project.costs_finalized` and `project.costs_restated`.
- **FUN-26 Hub Pulse screen.** A registered screen (HUB-REG), mobile-first at 375 px:
  - tiles with coverage badges and a period selector;
  - a funnel view, contribution by status, and the data-quality list with deep links;
  - platform sections fetched through the operations proxy.

  It retires the localStorage scorecard.
- **FUN-24 MCP pulse.** The §8.1 tools, the definitions-hash check and the role scopes, with contract-test fixtures.
- **FUN-31 Re-pointing.**
  - customer-state reports drop Hub-owned stages and money, or read them from the bridge.
  - meta-conversions `WALKTHROUGH_BOOKED`, `JOB_WON`, `JOB_COMPLETED`, `REVENUE_COLLECTED` and `Purchase` are driven by Hub events, with values from `deal.sold`/`payment.received`. Already-accepted events are left as they are.
  - The §8.4 tool changes.
- **FUN-27 Lockdown.**
  - Firestore rules deny SDK writes to `estimate`, `customerApproval`, `deposit`, `payment`, `invoice`, `costs`, `status`, `completedAt`, `cancelledAt`, `garageGuard`, `giftWallet`, `customerDecisions`, `communicationLog`, `rebookingRequests` and the review-request fields, and deny job deletes. Until then the FUN-36 credit limits (running totals, Garage Guard membership, `other` sales) and full-list refusals bind only the server path.
  - Remove the five lifecycle auto-fires and the `customerAutomationEnabled` reminders.
  - Rules tests.
- **FUN-32 Jobber guard.** A read-only Jobber GraphQL check for requests, jobs and invoices created after the cutover. Detects GHL contacts and opportunities created by the Jobber app. Records the cutover date in the definitions file.
  - **In the repository (FUN-32):** the Jobber cutover day is `jobber.cutoverDate` in the definitions (`null` until the owner decides; separate from `eventIntegrity.cutoverDate`), with `jobber.findings` (each finding code, its surfaces `booking | billing | messaging` and its scope `customer | job`) and `jobber.ghlAppMarkers` (how Jobber-app records are recognized). `vocabularies.coverageReasons` gains `jobber_after_cutover` for metrics a stray makes partial.
  - `scripts/jobber-guard.mjs` (library `functions/_lib/jobber-guard.js`, shared read-only client `functions/_lib/jobber-graphql.js`) lists requests, jobs and invoices created on or after the cutover, Jobber visits on or after it, Jobber payments entered on or after it, imported balances Jobber has since settled, and HighLevel contacts and opportunities the Jobber app added on or after it, each matched to a Hub customer. `--save` stores a complete check in the server-only `jobberGuard/latest` (with a `jobberGuardRuns/<runId>` summary); `GET /api/jobber-guard` shows it to owners and managers. FUN-25 reads that state (or runs the same library) for its data-quality list.
  - Per-surface switches, off by default, act from the cutover day: `EGC_JOBBER_GUARD_BOOKING` (no game plan reaches the Zap that creates a Jobber job), `EGC_JOBBER_GUARD_BILLING` (no Hub `invoice.issue`, and no automatic deposit or payment reminder, while the customer has an open Jobber bill) and `EGC_JOBBER_GUARD_MESSAGING` (no automatic reminder while Jobber may message the customer about open work or an open invoice). Holds never cancel Hub work or send anything. docs/JOBBER-CUTOVER.md section 10 is the owner guide.
  - Mapping JOB-CUT history into funnel facts stays with FUN-04 (A22); funnel events are refused for `recordType` rows such as `jobber_history`, so FUN-04 decides that mapping.
- **FUN-28 / FUN-39 / FUN-40 (optional):**
  - **FUN-28**: a generated Sheets export, owner-only or aggregate-only.
  - **FUN-39**: a read-only QuickBooks P&L for overhead and net profit, labelled "book basis".
  - **FUN-40**: a first-party 1–5 CSAT sent through an approved send and the portal, plus a read-only Google Business Profile or GHL Reputation rating.

---

## 12. Owner process rules (staff discipline; enforced by the system where possible)

1. **Walkthrough rep: Start and Finish every walkthrough in the Hub.** Start asks for consent. If the customer declines, tap *Declined* and type three notes at Finish. Enforced: Finish requires an outcome, the next Start is blocked, and FUN-25 flags walkthroughs past their end time.
2. **Recordings: record in the Hub on the iPad (preferred).** If you used Voice Memos, upload it to the same walkthrough the same day. Enforced: the "Unsent recordings" badge and the missing-recording alert task.
3. **Phone person: work only from My follow-ups, and close every to-do with an outcome** (booked, quote sent, lost with a reason, or a snooze that logs an attempt). Enforced: completing a task requires an outcome, and overdue items show on the Hub home and in the pulse.
4. **Never book a job without a price approval on record.** For a verbal yes, record it in the Hub with the amount (the Hub asks for it). The approval and deposit link go out only as an approved send. Enforced: the FUN-11 gate.
5. **Book, move and cancel only in the Hub.** Never do it in the GHL calendar or in Jobber after the cutover. The only exception is customer self-booking, which the Hub adopts. Enforced: FUN-25 and FUN-32 list strays.
6. **Ask "How did you hear about us?"** when a contact has no attribution. Enforced: a required field in that case.
7. **Crew: clock in, then use the status taps at the moment they happen.** Enforced: Dispatched prompts clock-in, and labor auto-attributes to the job.
8. **Book return, install and rework visits as that visit type,** linked to the original job. Enforced: `visitPurpose` is required on `schedule.create`.
9. **At closeout, enter every dump fee and material purchase with a receipt photo, or tap "None".** Mark who paid (company card or reimbursable). Enforced: the closeout gate.
10. **Payments:**
    - take them through Stripe links or card;
    - record cash and checks in the Hub the same day, with method, date and reference;
    - refund only in Stripe;
    - issue credits and sell gift cards only in the Hub, choosing a credit class.

    Enforced: required fields, webhooks, and FUN-27 rules.
11. **Change prices only through estimate revisions or portal change orders.** Enforced: FUN-27.
12. **Give every cancellation, reschedule, no-show and lost deal a reason code.** Enforced: required fields.
13. **Managers approve timecards weekly, by Monday noon.** Enforced: the pulse shows pending weeks and provisional contribution.
14. **Owners who work jobs clock in like crew.**
15. **Enter non-API ad spend monthly** (Local Services Ads, Yelp, Angi, Thumbtack, Nextdoor, mailers, signs, wraps, sponsorships), with a receipt.
16. **Use isTest customers for training and demos, never real customers.** Mark the owner's own and case-study jobs as internal, with a reason.
17. **No customer messages outside the approved-send flow or a registered owner automation.** Do not edit GHL workflow texts or Zaps without updating the FUN-30 registry. Enforced: FUN-25 flags registry drift.
18. **Every published phone number must ring into an ingested system** (GHL, or Quo via FUN-16).

---

## 13. Owner decisions (with recommended defaults)

**People and roles**
1. **Who the phone person and walkthrough rep are.** Default: Hub accounts with roles `phone` and `sales` (P1-08), named now.
2. **Who confirms the AI job notes.** Default: the phone person confirms the *internal* notes. Customer-visible scope, prices and quotes stay with the manager/owner (P2-12).

**Labor cost**

3. **Payroll burden rate.** Default: get it from the accountant or Gusto. Until then contribution shows "before burden (provisional)", never a guess.
4. **Owner labor on jobs.** Default: owners clock in and are costed at a shadow rate equal to the crew-lead rate.
5. **Non-hourly pay (salary, per-job helpers, contractors).** Default: salary is costed at an effective hourly rate the owner sets; per-job helpers and contractors are entered as F-EXP `subcontractor`.
6. **Bonus allocation.** Default: not allocated to jobs (overhead); it keeps raising the OT regular rate as P1-03 does.
7. **Sales commission per sold project.** Default: none unless the owner sets a rule; if set, it is a direct cost.
8. **Travel time.** Default: included in job labor (`includeTravel=true`).
9. **Walkthrough and phone labor.** Default: acquisition cost (CAC), not job cost.

**Costs and revenue rules**

10. **Vehicle and mileage.** Default: excluded and labelled "excluded"; can be enabled later with a cost per mile.
11. **Garage Guard revenue per member visit.** Default: plan price paid ÷ included visits, recognized at visit completion. Unused visits at cancel become breakage revenue on the cancel date. As built (FUN-20): the last included visit of a period takes the rounding remainder, and the unused visits of a period that renews also become breakage, on the renewal date, because the included visits reset. The Guard plan's checkout text promises that unused visits convert to $100 EGC gift cards; if that is honored, the owner issues a `garage_guard` credit (FUN-36), and the breakage becomes that credit's liability instead. Breakage is recorded only when the ledger counted every visit of the period; otherwise it is unknown (null). **Pending owner decision:** how a mid-year plan change prices member visits (today the visits after it have unknown revenue).
12. **Courtesy and referral credits.** Default: contra-revenue. Purchased gift cards and membership credit count as payment.
13. **Gift-card sales.** Default: sold only through the Hub (Stripe link or offline), recorded as cash plus a liability.
14. **Cancellation fees and deposit forfeiture.** Default: follow the signed terms; a forfeited deposit is revenue on the cancel date. Today the handoff hard-codes deposit = 50%.
15. **Deposit before booking phone-sold jobs.** Default: booking is allowed with `deposit_due`; the deposit link goes out as an approved send; compliance is tracked.
16. **Tip processing fees.** Default: the fee on the tip portion is overhead ("tip processing"), and tips pass through in full.
17. **Sales tax on product lines.** Default: ask the accountant; product lines stay flagged until decided.
18. **Stocked-item standard costs.** Default: the owner enters `standardUnitCostCents` for shelving, totes and racks in catalog settings.

**Reporting rules**

19. **Revenue basis for contribution.** Default: accrual at project close, with sold, completed and cash all shown.
20. **Service-line taxonomy.** Default: garage transformation, junk removal, Garage Guard visit, commercial/B2B.
21. **Repeat-inquiry window.** Default: 30 days.
22. **Week definition.** Default: Monday–Sunday, America/Denver.
23. **Business hours and holidays.** Default: Mon–Sat 07:00–19:00 America/Denver (web-lead's current rule), with US federal holidays.
24. **Data cutover date.** Default: the ship date of FUN-02/03/33. Earlier periods are labelled partial.

**Integrations and access**

25. **Ad platform access.** Default: grant read-only Meta (system-user `ads_read`) and Google Ads API access. Start the Google developer-token application now, because approval takes weeks.
26. **Who enters non-API spend.** Default: the owner, monthly.
27. **Phone numbers (four published).** Default: first verify which reach GHL, then ingest Quo webhooks (FUN-16), or consolidate into GHL LC Phone.
28. **Customer self-booking of walkthroughs in GHL.** Default: allowed, with auto-adoption on (`EGC_BOOKING_AUTO_RECONCILE=true`) after a dry-run check.
29. **Jobber.** Default: set a cutover date, import history with JOB-CUT, then no new Jobber requests, jobs or invoices.
30. **Books (overhead and net profit).** Default: connect QuickBooks read-only later (FUN-39) if it is the book of record; until then these are unknown.
31. **Posted Google reviews and rating.** Default: not now; connect Google Business Profile later (FUN-40).
32. **CSAT survey.** Default: yes after FUN-40, through an approved send.

**Automations and customer messages**

33. **Each existing automation (§10).** Default: retire the Zapier AI text and replace it with a fixed instant-reply template; register the GHL nurture, confirmation and reminder templates; register the portal invitation; retire the browser auto-fires and reminders.
34. **Booking confirmations for phone-booked jobs.** Default: the notify toggle is ON when all triggered workflows are registered.
35. **Follow-up routing per walkthrough outcome.** Default: as in §5 step 4.
36. **Follow-up SLA.** Default: due 4 business hours after the walkthrough finishes.
37. **Lost-reason list.** Default: price, timing, chose competitor, DIY, no response, not a fit, other (with a note).

**Recordings, visibility and exports**

38. **Recording consent script and retention.** Default: a one-line verbal consent at Start; audio kept 90 days and transcripts 2 years; deletion on customer request.
39. **Manager view of labor.** Default: standard blended rate; actual rates are owner-only.
40. **MCP visibility.** Default: the owner sees everything; managers see aggregates at standard rates; phone/sales see their own follow-ups and sales with no cost fields.
41. **Google Sheet.** Default: none now. If wanted later, FUN-28: owner-only or aggregate-only, generated, and never read back.

---

## 14. Sheet recommendation

Do **not** connect a Google Sheet or another CRM as a source or an input.
- HighLevel is already the CRM (contacts, conversations, pipeline). The Hub is the operational and financial source of truth. The platform holds the derived lead history.
- A sheet that people type into becomes a second source of truth. That is exactly why today's localStorage scorecard cannot be trusted.

For spreadsheet access:
1. **Now:** M11 accountant CSV exports from the Hub (invoices, payments, project costs).
2. **Optional later (FUN-28):** a scheduled, read-only push of pulse snapshots into a Google Sheet, built as follows:
   - A service account writes one protected tab per report, titled "GENERATED — edits are overwritten".
   - Each run fully replaces the tab and stamps every row with `asOf`, `definitionsHash` and each metric's status and coverage.
   - The tabs hold values only, with no formulas that compute business numbers, and the system never reads the sheet back.
   - The data comes from the same FUN-23/FUN-24 path as the MCP and the Hub screen, so they cannot disagree.
   - **The sheet is owner-only**, or holds aggregates only. Anyone the Drive file is shared with can read every cell, so it must never contain per-employee labor, pay rates or per-crew cost for small groups.

---

## 15. Verification items before build (owner or device)

- **Device and model checks.** An iPad/WebKit test of recording: mime type, chunk concatenation, wake lock, interruption and roll-over. Run the synthetic canary for the model ids (`gpt-transcribe`, `gpt-5.6-luna`), the no-extension failure and the duration limit.
- **Phones.** Whether Quo mirrors calls and SMS into GHL, and what 970-999-1308, 970-658-9454 and 970-999-1403 route to.
- **GHL.** Whether GHL Marketplace webhook subscriptions exist; whether `/opportunities/upsert` resets an existing opportunity's stage and value; whether `PUT /contacts/{id}/tags` works.
- **Zapier and legacy leads.** Whether off-repo Zaps still write the legacy Firestore `leads` collection or send CAPI Lead events.
- **Platform environment.** Whether `EGC_OPERATIONS_ENABLED` is on in production, and the `STORAGE_DRIVER` on Railway.
- **Dispatch data.** The saved-crew resource shape for the proposer's default crew.
- **Jobber usage.** Whether walkthrough requests are still created in Jobber today.
- **Firestore.** Whether PITR is enabled, which extends the `readTime` window from 1 hour to 7 days.
