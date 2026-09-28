# Jobber → EGC Hub cutover

Unit **JOB-CUT**. This document covers three things:

1. what replaces each Jobber feature and whether it is ready,
2. how Jobber's clients, jobs and visits, recurring jobs and open invoices move into the Hub, and
3. the conditions that must all be true before Jobber is switched off.

**Rule for the whole cutover:** the Firestore Hub (Cloudflare Pages Functions in `functions/`) is the only source of truth
for customers, jobs, crews, schedule, quotes, invoices and payments. Jobber data is copied **into** the Hub once. You can
rerun the import during the parallel run to pick up stragglers, and reruns never duplicate records. Nothing is written
back to Jobber, and the two systems are never kept in sync.

The import tool is `scripts/jobber-import.mjs`. The pure mapping rules are in `functions/_lib/jobber-import-map.js`, and
the tests are in `tests/jobber-import.test.mjs`. The tool:

- is a **dry run by default**,
- **never sends a customer message**, never charges a card and never talks to HighLevel or Stripe,
- never assigns crew, and
- never schedules over existing dispatch work.

> **Status snapshot:** taken from integration branch `claude/amazing-shannon-n614n7` at `2d0a20d` on 2026-09-28 (read
> from the unit commits on the branch, which run ahead of the table in `docs/BUILD-PROGRESS.md`). Merged units at that
> point: P0-1, P0-2, P0-3, M15, P1-02, P3-00, P1-04, P4-15, P4-01, P1-01, B2B-SEAMS, LI-CORE, SEC-B, SITE-0, MSG-CORE,
> SEC-A, M2 and MCP-01. Every other unit named below was either being built or was still planned. Check
> `docs/BUILD-PROGRESS.md` and `git log` for the current state before you use the table.

## 1. Feature map

Status values:

- **available**: on the integration branch today, including features that existed before this build.
- **in progress (unit)**: a unit is being built.
- **planned (unit)**: the unit is listed in `docs/BUILD-PROGRESS.md` but has not started.
- **out of scope (reason)**: EGC will not replace it.

| Jobber feature | EGC equivalent | Status |
| --- | --- | --- |
| Clients / CRM | Hub `customers` collection. Dispatch customer search and verified customer resolution (`/api/customer-resolve`, phone/email matching, CRM contact verification). HighLevel keeps contacts, conversations and pipeline. Jobber clients arrive through this import. | available. Phone/email identity keys and their backfill: in progress (P4-02) |
| Requests | Website lead forms go to HighLevel (`/api/web-lead`, `/api/lead-intake`), then a free walkthrough is booked in the Hub (booking modal or Dispatch "walkthrough"). The game plan's "today's Jobber requests" picker (`/api/jobber-requests`) stops being useful at cutover. | available. Retiring `/api/jobber-*`: planned (NEW, not yet assigned to a unit) |
| Quotes | Walkthrough game-plan pricing, signed handoff (`walkthrough-handoff`), Hub estimate, and customer-portal approval with a deposit. | available. One line-item model and money core: available as libraries (LI-CORE, merged; not yet wired into screens). Garage catalog: in progress (CAT-DATA). Catalog pricing, itemized handoff, option toggling, server estimate service: planned (P2-02 to P2-12) |
| Jobs and visits | Hub `jobs` created and changed only through Dispatch (`schedule.create/update/cancel/restore`), plus the crew job page. | available. Per-day visit state and assignment segments: planned (P1-10) |
| Scheduling / calendar | Dispatch day, week and crew views, the openings finder (`/api/dispatch-openings`), customer arrival windows (P1-04), and complete crew schedule pagination and lock fixes (P1-01). | available. Month view, lanes, tap-to-assign: planned (P1-11) |
| Dispatch / routing | Dispatch board with crew and vehicle resources, day locks and conflict checks. A directions link on every job. | available. Travel-time estimates: in progress (P1-07). Route optimization: out of scope (a small crew count does not justify it) |
| Multi-crew | Several employees per job (`assignedCrew`), crew lead, crews and vehicles as resources, open-shift pickup. | available. Staff directory: planned (P1-08). Roster rules and permissions: planned (P1-09). Split and multi-day assignments: planned (P1-10) |
| Time tracking / timesheets | Hub time clock (`employee-timecards`), job timers (`field-execution-time`), manager approvals, Gusto sync of approved time (`/api/gusto-sync`). | available. Weekly timesheet, Colorado/federal overtime and payroll CSV: in progress (P1-03). Time-off workflow: planned (P1-06). Timesheet review UI and location policy: planned (P1-15) |
| Invoicing | Hub finance: issue, update and print invoices. The customer portal shows the invoice. | available (written from the browser today). Invoice-from-estimate math: available as a library (LI-CORE). Server money API and ledger: planned (M3). Invoice document, send and batch invoicing: planned (M4, M5, M6) |
| Online payments | Stripe Checkout from the customer portal (deposit or balance) and crew card payments (`/api/job-payment`), both recorded durably by the Stripe webhook (M2). | available. Manager screen for Stripe payments held for review (API only today): planned (NEW, not yet assigned to a unit) |
| Payment reminders | "Invoice overdue" HighLevel automation, switched on per job (fires from a manager's Hub session). | available (legacy). Approved-send core: available, off by default and not wired to reminders (MSG-CORE). Scheduled, idempotent reminders: planned (M7) |
| Tipping | None yet. Tips are excluded from balances by the money core (LI-CORE). | planned (M8) |
| Recurring jobs | Visit cadence and the "next visit" action in the Hub schedule, saved through Dispatch as a repeat of a template job (`sourceTemplateJobId`). | available. Recurring plans (server record, generator, UI): in progress (P1-05). Horizon cron: planned (P1-14) |
| Client hub (portal) | Per-job customer portal: estimate approval, deposits and payments, collaborators, job-day rules, rebooking and change orders. Correctness fixes and review tracking (P4-01) and link revocation (P4-15, API only). | available. Account-level portal, magic-link login, invoices and documents: planned (P4-03 to P4-14) |
| Reviews | Review request through HighLevel (Hub "Review request" trigger, crew post-job review request), with the review card and click tracking in the portal (P4-01). | available |
| Reporting (revenue / job costing) | Hub dashboard metrics, finance board with job economics, contribution scorecard, operations revenue summary (MCP, MCP-01 registry). | available (basic). Labor costing from real timecards: in progress (P1-03). Job costing, dashboard and money CSV: planned (M9, M10, M11) |
| Expense tracking | Hub "Enter actual costs" per job. | available (per-job costs). Field capture of materials and dump fees: in progress (F-EXP) |
| Notifications (on-my-way, reminders) | Appointment confirmations and reminders run as HighLevel workflows fed by Hub schedule sync. Crew arrival text (legacy `/api/quo-send`). | available (legacy). Approved-send core with owner-approved templates: available, off by default (MSG-CORE). Legacy send hardening: in progress (F-LEG). Crew notifications: planned (P1-12). Day-before reminders and on-my-way through approved sends: planned (P1-13) |
| Mobile app for crew | Crew web app: "My day", job page, checklists, photos, time clock. | available. Installable PWA shell: in progress (F-PWA). Hub mobile shell pass: in progress (HUB-REG) |
| Offline | Single-action retry on the crew job page only. | in progress (F-PWA: offline action outbox for field actions and the time clock) |
| Online booking | Public booking form (`/book`) through web lead to the HighLevel calendar, plus Hub openings for staff. | available |
| Marketing / automations (GHL) | HighLevel stays the marketing and CRM layer: nurture, pipeline, conversations, review requests. The Hub is authoritative for operations. | available |
| Job forms / checklists | Pre-job and post-job checklists and client checklists on crew pages. | available |
| Photos and attachments | Field photos stored in private Google Drive and served through an authorized proxy. | available |
| Team roles and permissions | Business access for owner and managers, centralized identity (P1-02), server-owned records locked out of browser writes (SEC-A), server-only Hub audit log and two-step confirmations (SEC-B). | available (hard-coded managers). Data-driven roles: planned (SEC-12) |
| Payroll | Gusto sync of approved timecards. | available. Payroll CSV and overtime: in progress (P1-03) |
| Jobber data import | `scripts/jobber-import.mjs` (this document). | in progress (JOB-CUT) |
| QuickBooks sync | None. | out of scope. EGC does not run a two-way accounting sync. The bookkeeper takes the money CSV (M11) or Stripe reports |
| GPS tracking | None. Only an optional location stamp on clock-in. | out of scope. No continuous crew tracking (privacy, battery, not needed at EGC's size). Clock-in location policy is P1-15 |

## 2. What moves, and where it lands

| Jobber data | Hub record | Rules |
| --- | --- | --- |
| Client that matches exactly one Hub customer by normalized phone (E.164) or email | the **existing** `customers/<id>`. It is never modified. | The client's jobs and invoices point at that customer. If the name, phone or email differ, a `matched_customer_differs` warning lists what differs. |
| Client with no Hub match | `customers/jobber_client_<jobberClientId>` | Gets `provenance: {source:'jobber', jobberId, importedAt, runId, sourceMode}` and `source: 'jobber_import'`. Also gets `phoneE164`/`emailLower` using the P4-02 rules. Extra phones, emails and properties go under `jobber`. |
| Upcoming or unscheduled visits of a Jobber job | **one** `jobs/jobber_job_<jobNumber>` per Jobber job | The job is `unscheduled` (no date or time) and unassigned, with `needsDispatchReview: true`, `notify: false`, `customerAutomationEnabled: false`, `syncStatus: 'not_needed'` and `scheduleSource: 'jobber_import'`. Jobber's dates, crew names and value are copied into `opsNotes` and `jobber.visits`. The import takes no calendar capacity (no day locks). The job reaches the calendar only when a dispatcher schedules it through Dispatch, which runs the same conflict checks and day locks as any other job (covered by a test that schedules an imported job and is refused a double booking). For recurring jobs only the job itself comes over; set up the repeat after scheduling the next visit. A **one-off job with several upcoming visits** still becomes one Hub job: that job holds one visit, and the report lists the job under `multiVisitJobs` with every visit date so the others are added in Dispatch by hand (its internal note says "schedule each of these N visits"). A recurring job with several visits and no `recurringPlans` entry is listed there too. One job per Jobber job keeps ids stable: the CSV reports carry no visit id, so a per-visit id would change when a visit is rescheduled in Jobber and a rerun would duplicate it. |
| Completed past visit | `jobs/jobber_visit_<jobNumber>_<YYYYMMDD>_<HHMM>[_<HHMM>]` | History record: `recordType: 'jobber_history'`, `status: 'completed'`, Denver `date/time` plus UTC `startAt/endAt`. `recordType` keeps it out of dispatch, dispatch search, crew, conflict and revenue-fact readers. Firestore rules classify `jobber_history` as server-owned, so browser sessions can read it but never change, relabel or delete it. Jobber crew names stay under `jobber.assignedTo` and never become Hub assignments. |
| Past visit **not** completed ("late") | not imported | Listed as `past_visit_not_completed`. Close these out in Jobber before the final export. |
| Open invoice (awaiting payment, past due, sent not due) with a balance above 0 | `jobs/jobber_invoice_<invoiceNumber>` | An **opening balance**. `invoice.amount` is the unpaid balance, and one line reads "Balance carried over from Jobber invoice #N", with the original total and the amount paid in Jobber in its description. Money paid in Jobber stays in Jobber, so no Hub payment is invented. The record is `status: 'invoiced'`, `invoice.imported: true`, `notify: false`, `customerAutomationEnabled: false`, with no estimate or quoted total. It is never charged: the portal and crew card payments derive the chargeable amount from the approved quote, which is $0 here (tested), and the Hub's automatic overdue reminder needs `customerAutomationEnabled: true`. It does not count as Hub revenue sold or completed. Collect the balance and record it with Hub finance → Record payment. It is a balance, not work: Dispatch lists it under Unscheduled (as `invoiced`) but refuses to schedule it. |
| Paid, draft, bad-debt or void invoice | not imported | Counted in `counts.invoices.skippedByStatus`. They remain in the Jobber archive. |
| Recurring job | reported only | `recurringPlans` in the report, also stored on the `jobberImport/<runId>` receipt, in the P1-05 plan shape (`cadence`, `startDate`, `time`, `endTime`, `endsOn`). `needsManualSetup` is set when the Jobber frequency cannot be expressed exactly (several weekdays, yearly, or a weekday different from the first visit). P1-05 is not merged, so no plan drafts are written. |
| Quotes, requests, client notes and attachments, timesheets, expenses, products and services, custom fields, cards on file | not imported | Archive the exports (section 3, step 6). Re-quote any open Jobber quote from a Hub walkthrough or estimate. Cards on file cannot be exported: customers pay through Stripe Checkout. |

Every id is derived from a Jobber id, so a rerun targets the same documents. Every write is **create-only** (Firestore
`currentDocument.exists=false`). Existing Hub customers and jobs are never overwritten.

**Customer account lineage.** Dispatch `schedule.create` and Garage Guard membership linking both require exactly one
account root per customer (`functions/_lib/dispatch-lineage.js`): every operational job of a customer points at the root
through `customerAccountOwnerJobId`, or is the root. Imported `jobber_job_*` and `jobber_invoice_*` rows are operational
(`type: 'job'`, no `recordType`), so the import links them:

- the customer already has **one** verified root in the Hub: every imported job and balance points at it
  (`source: 'existing'` in the report's `accountRoots`);
- the customer has **no** operational job yet: the first imported record (lowest Jobber job number, else lowest invoice
  number) becomes the root and the others point at it (`source: 'imported'`);
- the customer has **several** roots, or an ownership chain that is missing, circular or crosses to another customer: a
  blocking conflict, `customer_has_multiple_account_roots` or `customer_account_link_invalid`, lists the verified roots
  (`rootCandidates`). Choose one in the resolutions file (`customers.<customerId>.accountRootJobId`, below), or fix the
  link in the Hub, or skip the client. Dispatch already asks for a source job on every new visit for such a customer;
  the import does not change that.

History rows (`recordType: 'jobber_history'`) never join an account. Chains are followed on the Hub snapshot with the
same rules as `verifiedAccountRoot`, and apply verifies the revision of an existing root in the same commit as the
records that join it.

A rerun reports, and never overwrites:

- `changedSinceImport`: a Jobber job or invoice changed after it was imported.
- `imported_invoice_no_longer_open`: Jobber now shows an imported invoice as paid or closed. A customer probably paid
  through an old Jobber link, so record that payment in the Hub.

Each apply commits in batches of up to 100 records. The same Firestore commit also:

- advances the run receipt `jobberImport/<runId>` with an `updateTime` precondition;
- when the batch creates customers, advances `customerIdentityState/revision`, the guard that `/api/customer-resolve`
  and operations adoption advance and Garage Guard linking verifies;
- when the batch creates jobs or balances, advances `dispatchState/revision`, the guard that every Dispatch mutation,
  crew availability change, operations adoption and MCP/operations scheduling change (`mutateScheduledVisit`) advances;
- when the batch joins an existing account root, verifies that root's revision.

Both guards are read before the Hub snapshot, so if one of those writers lands mid-run, the next batch is refused and the
import stops cleanly. Rerun the dry run and apply; records already imported are skipped. If a commit response is lost,
the receipt is the proof of what committed.

**Not fenced:** writers that advance neither guard. These are the MCP/operations customer link
(`linkScheduledCustomer`, which creates `ghl_<contactId>` customers), and legacy Hub screens that write `customers` and
`jobs` straight from the browser. A customer they create mid-run is not seen by the import, which could then create a
duplicate `jobber_client_*` customer. So **pause MCP and scheduling-link activity, Dispatch and legacy Hub customer edits
while apply runs** (section 5, Day 0).

## 3. Export from Jobber (exact steps)

Only an **admin** Jobber user can export clients; reports need an admin or the Reports permission. Every export below is
**emailed** to the address you log in to Jobber with, not downloaded. The menu paths were checked against Jobber's help
center on 2026-09-28 (see Sources at the end). Jobber relabels menus and columns from time to time, so the tool never
depends on exact labels.

**How headers are matched.** Matching ignores case, spaces and punctuation, reads `#` as "number" and ignores `($)`. For
example, `Job #` and `job number` are the same field, and so are `Balance ($)` and `balance`. Every dry run lists
`missing` required fields and `unknownHeaders` for each file **before** anything can be written. If Jobber labels a
column differently, pass a mapping file such as `--mapping map.json` containing
`{"visits":{"date":"Visit date"},"invoices":{"balance":"Amount owing"}}`.

**What was verified, and how.**

- **Menus, file splitting, one row per property, `J-ID`, `Job #`, `Assigned to`, `Visit based ($)`, `Scheduled
  duration` (decimal hours) and the Yes/No `Completed` filter** come from Jobber's help center articles (Export Client
  Information, How to Make Mass Updates to Clients, Reports Basics, Visits Report, Invoices Report, Recurring Jobs Report).
- **The client export's exact header spellings** (`J-ID`, `Display Name`, `First Name`, `Last Name`, `Company Name`,
  `Main Phone #s`, `Mobile Phone #s`, `Work`, `Home`, `Text Message Enabled Phone #`, `Fax Phone #s`, `Other Phone #s`,
  `E-mails`, `Service Property Name`, `Service Street 1`, `Service Street 2`, `Service City`, `State`, `Zip`,
  `Billing …`, `Is Company?`, `Archived`, `Lead Source`, `Title`, `Created Date`, `Tags`, `CFT[…]` and `PFT[…]` custom
  fields) come from a third-party import spec written against a real 778-row Jobber export. That export separated phone
  numbers with semicolons and emails with commas, and wrote `true`/`false` for `Is Company?` and `Archived`; the parser
  accepts all of these. `Fax Phone #s`, `Other Phone #s`, tags and custom fields are reported as `unknownHeaders` and
  never used for matching.
- **The report columns** follow the field names of Jobber's report export API (`VisitReportSelectedColumns`,
  `InvoiceReportSelectedColumns`, `RecurringJobReportSelectedColumns` in Jobber's published GraphQL schema).
- The help center pages themselves are blocked from the build container, so they were read through search results, not
  opened. Treat the first dry run as the final check that the headers match.

1. **Freeze first.** Close out late visits: mark each one completed, or delete it if it never happened. Make sure every
   upcoming visit is on the right client.
2. **Clients.** Open **Clients** in the side navigation, then **More Actions** (top right) → **Export Clients** →
   **CSV**. Export **all clients** with no tag filter. Jobber emails the file. Each file holds at most 1,500 rows, so a
   bigger client list arrives as several attachments: pass each one with a repeated `--clients` flag. A client with
   several properties appears once per property, and `J-ID` is `<clientId>_<propertyId>`. Required: `J-ID` and a name
   column.
3. **Visits.** Open **Insights → Reports** and choose **Visits** under *Work reports*.
   - Filter "start within" your `--history-since` date (or the first day you want history for) through **12 months
     ahead**, with *Completed* set to **All**.
   - **Export to CSV → All columns**.
   - Needed: `Job #`, the visit date column, and one of `Client name`/`Client email`/`Client phone`.
   - Strongly recommended: `Times`, `Completed`, `Title`, `Assigned to`, the `Service …` address columns, `Line items`,
     `One-off job ($)`, `Visit based ($)`, `Job type`, `Scheduled duration`. Jobber writes `Scheduled duration` as
     decimal hours (`0.5` is 30 minutes); the parser reads it that way and uses it only when `Times` has no end time.
   - The date filter only returns visits with a start date inside the range, so **unscheduled visits are left out**.
     Give them a date in Jobber before exporting, or use the GraphQL source, which reads them.
4. **Invoices.** Open **Insights → Reports → Invoices**.
   - Date range: **all time**, or at least back to the oldest unpaid invoice.
   - **Export to CSV → All columns**.
   - Needed: `Invoice #`, `Status`, `Balance ($)` and a client column.
   - Recommended: `Total ($)`, `Issued date`, `Due date`, `Subject`, `Job #s`, `Tax amount ($)`.
   - Include paid invoices too. That is how a rerun detects an imported balance that was later paid in Jobber.
5. **Recurring jobs (optional).** Open **Insights → Reports → Recurring jobs**, then **Export to CSV → All columns**.
   Needed: `Job #`, `Visit frequency` and a client column. Recommended: `Scheduled start on`, `Scheduled end on`,
   `Visits assigned to`.
6. **Archive.** Save these files, plus PDFs of open invoices and any open quotes, to the private EGC Google Drive. Do not
   commit them to git: they contain customer data.

<details><summary>Accepted header keys (generated from <code>JOBBER_COLUMNS</code>)</summary>

Keys are headers after normalization (lowercase letters and digits only, `#` → `number`, `($)` dropped).

**clients.** Required: `jid`, plus a name column (`displayName`, `firstName`, `lastName` or `companyName`).

| Field | Accepted header keys |
| --- | --- |
| `jid` | `jid`, `jobberid`, `clientid` |
| `displayName` / `firstName` / `lastName` / `companyName` / `isCompany` | `displayname`, `name`, `clientname` / `firstname` / `lastname` / `companyname`, `company` / `iscompany` |
| `emails` | `emails`, `email`, `emailaddress`, `emailaddresses` |
| `mainPhones` / `mobilePhones` / `smsPhones` / `workPhones` / `homePhones` | `mainphonenumbers`, `mainphone`, `phone`, `phones`, … / `mobilephonenumbers`, `mobile` / `textmessageenabledphonenumber` / `workphonenumbers`, `work` / `homephonenumbers`, `home` |
| `propertyName`, `street1`, `street2`, `city`, `state`, `zip` | `servicepropertyname`, `servicestreet1`, `servicestreet2`, `servicecity`, `servicestate`/`state`, `servicezipcode`/`zip` (and plain `street`, `city`, `province`, `postalcode`) |
| `billingStreet1`, `billingStreet2`, `billingCity`, `billingState`, `billingZip` | `billingstreet1`, `billingstreet2`, `billingcity`, `billingstate`, `billingzipcode` |
| `archived`, `isLead`, `leadSource`, `createdDate` | `archived`, `islead`, `leadsource`, `createddate` |

**visits.** Required: `jobNumber`, `date`, plus a client column (`clientName`, `clientEmail` or `clientPhone`).

| Field | Accepted header keys |
| --- | --- |
| `jobNumber` | `jobnumber`, `job`, `jobno` |
| `date` | `date`, `visitdate`, `startdate`, `startat`, `scheduledstart`, `scheduleddate`, `visitstart`, `start` |
| `times`, `endDate`, `duration` | `times`, `visittimes`, `time` / `enddate`, `endat` / `scheduledduration`, `duration` |
| `title` | `title`, `jobtitle`, `visittitle` |
| `clientName`, `clientEmail`, `clientPhone` | `clientname`, `client`, `name` / `clientemail`, `email` / `clientphone`, `phone` |
| service address | `servicepropertyname`, `servicestreet`, `servicecity`, `serviceprovince`, `servicezip` |
| `completedAt` | `completedat`, `completed`, `completeddate`, `completedon`, `visitcompleted` |
| `assignedTo`, `lineItems`, `jobType`, `instructions` | `assignedto`, `visitsassignedto` / `lineitems`, `lineitemslist` / `jobtype` / `instructions` |
| `oneOffValue`, `visitBasedValue` | `oneoffjob`, `oneoffjobcost` / `visitbased`, `visitbasedcost` |

**invoices.** Required: `invoiceNumber`, `status`, `balance`, plus a client column.

| Field | Accepted header keys |
| --- | --- |
| `invoiceNumber`, `status`, `subject` | `invoicenumber`, `invoice`, `invoiceno` / `status`, `invoicestatus` / `subject`, `description` |
| `issuedOn`, `dueOn`, `paidOn` | `issueddate`, `issuedon`, `invoicedate` / `duedate`, `dueon` / `markedpaidon`, `paidon` |
| `total`, `balance`, `preTaxTotal`, `taxAmount` | `total`, `invoicetotal` / `balance`, `balancedue`, `amountdue`, `outstanding` / `pretaxtotal`, `subtotal` / `taxamount`, `tax` |
| `jobNumbers` | `jobnumbers`, `jobnumber`, `jobs`, `job` |
| client and service address columns | as for visits |

**recurring.** Required: `jobNumber`, `visitFrequency`, plus a client column.

| Field | Accepted header keys |
| --- | --- |
| `visitFrequency` | `visitfrequency`, `frequency`, `schedule`, `recurrence` |
| `startOn`, `endOn`, `closedOn` | `scheduledstarton`, `startdate` / `scheduledendon`, `enddate` / `closedon` |
| `visitsAssignedTo`, `lineItems`, `billingType`, `billingFrequency` | `visitsassignedto`, `assignedto` / `lineitemslist` / `billingtype` / `billingfrequency` |

</details>

### How values are read

- **Time zone.** Jobber exports local wall times, which are read as **America/Denver**. A value that carries `Z`, `UTC`
  or an offset (the GraphQL source, or a Rails-style `2026-09-24 09:00:00 -0600`) is converted to Denver time. Imported
  records store the Denver `date`/`time`/`endDate`/`endTime` plus derived UTC `startAt`/`endAt`. The machine running the
  import can be in any time zone: nothing reads the device time zone.
- **DST.** A time that does not exist or occurs twice at a daylight-saving change is never guessed. The record keeps its
  date and is flagged `timeNeedsReview`.
- **Dates** accepted: `Sep 24, 2026`, `Thu Sep 24, 2026 9:00 AM`, `9/24/2026`, `9/24/26`, `24 Sep 2026`, and ISO.
  **Times** accepted: `9:00 AM - 11:00 AM`, `9am–11:30am`, `9 - 11 AM`, `09:00 to 11:00`, `Anytime`.
  **Durations**: a bare number is decimal hours, as Jobber's Visits report writes `Scheduled duration` (`1.5` is 90
  minutes); `2 hrs 30 mins`, `90 min` and `02:30` also work. A duration fills in a missing end time only.
- **Money** is integer cents: `$1,234.50` becomes 123450, and `(12.00)` becomes -1200. An unreadable or missing amount
  stays **unknown**, never 0. An open invoice with an unknown balance is blocking.
- **Phones and emails** use the P4-02 rules. Phones become US-first E.164: extensions are dropped, and an explicit `+`
  with another country code stays international. Emails are lowercased exactly (dots and `+tags` are kept). A cell can
  hold several values. Values that cannot be read are counted, never guessed.
- **Addresses.** Whitespace is collapsed and state names become USPS codes (`Colorado` → `CO`). ZIP and ZIP+4 are kept.
  An all-lowercase or all-caps city is title-cased. Parenthetical notes such as `(side door)` are moved out of the
  address into the client's property notes.

### Linking visits and invoices to clients (CSV)

The Visits and Invoices reports have no client id, so a row is linked to exactly one Jobber client by one of these, in
order:

1. its client phone or email;
2. its client name **and** service street.

A row that links to no client, or to more than one, is reported with masked details. For an upcoming job or an open
invoice this is **blocking**, because the record would otherwise be lost. Settle it in Jobber or in the resolutions
file. Unlinked **history** rows are warnings only. The GraphQL source carries real client ids and needs no matching.

## 4. Import runbook

**Requirements:**

- Node 22.
- `FIREBASE_SERVICE_ACCOUNT_JSON` for project `egcw-1ec83`. The dry run also reads the Hub, because matching needs the
  complete customer list.
- Run from a trusted machine. Reports go to files with mode `0600`, also when an earlier report at that path had a
  looser mode (the file is replaced, not rewritten). They contain Jobber and Hub ids, masked names and phones, and
  counts; they contain no full names, phone numbers, emails or street addresses.
- **Before the first `--apply`:** publish this branch's `firestore.rules` to project `egcw-1ec83` (owner action; a
  Cloudflare deploy does not publish rules). It makes `jobber_history` rows read-only for browser sessions and closes
  `jobberImport` to every browser. The import itself works without it, but history rows would stay editable from the
  Hub until the rules are published.

```sh
# 1. Dry run: reads Jobber data and the whole Hub, writes nothing.
node scripts/jobber-import.mjs --clients clients.csv --visits visits.csv --invoices invoices.csv \
  --recurring recurring.csv --history-since 2024-10-01 --report dry-run-1.json

# 2. Review dry-run-1.json:
#    blocking                   must be []
#    conflicts                  ambiguous_customer, duplicate_in_jobber, client_name_missing,
#                               job_links_to_several_clients, duplicate_invoice_number,
#                               inconsistent_prior_import, previous_customer_missing,
#                               resolution_customer_missing, customer_has_multiple_account_roots,
#                               customer_account_link_invalid, account_root_resolution_invalid
#    unmappable                 rows that cannot be linked or read, with CSV line numbers
#                               ("2:14" = second file, line 14)
#    counts.jobsCollection      projected jobs-collection size (see below)
#    warnings                   past_visit_not_completed, matched_customer_differs,
#                               client_without_contact, recurring rows that need manual setup
#    matches                    every Jobber client → Hub customer decision and what it was matched by
#    accountRoots               the account root each customer's imported jobs and balances join
#    multiVisitJobs             one-off jobs with several upcoming visits: every visit listed must be
#                               scheduled (the Hub job holds one) or cancelled by hand
#    recurringPlans             plans to set up by hand (or through P1-05 once merged)
#    source.files.*             missing / unknownHeaders per export

# 3. Fix the data in Jobber and re-export, or settle cases in resolutions.json (below). Repeat until blocking is [].

# 4. Apply exactly what you reviewed. The dry run prints the command, including both fingerprints.
node scripts/jobber-import.mjs --clients clients.csv --visits visits.csv --invoices invoices.csv \
  --recurring recurring.csv --history-since 2024-10-01 --resolutions resolutions.json \
  --apply --expect-fingerprint <sourceFingerprint> --expect-plan <planFingerprint> \
  --reviewed-report dry-run-1.json --report apply-1.json
```

The dry run prints two fingerprints, and `--apply` needs both:

- `sourceFingerprint` is a SHA-256 of the exported data, the resolutions and `--history-since`.
- `planFingerprint` is a SHA-256 of the report's `plan`: every write id with a digest of its content, and every client
  decision. The run's own timestamps and run id are masked, so only a real change moves it. This covers what the source
  fingerprint cannot: the Hub snapshot and the clock. For example, an upcoming visit that became past (and not completed)
  since the dry run is dropped, and a Hub customer added since then turns a "create" into a "match".

`--apply` refuses in four cases, and in each one writes nothing:

- the source fingerprint differs, for example because a file was re-exported or a resolution changed after the review;
- any blocking item remains;
- the plan fingerprint differs. With `--reviewed-report <the dry-run report>`, the refusal lists the writes added,
  removed and changed and the client decisions that changed since that dry run. Run the dry run again and review it;
- the plan is empty. This is what makes a rerun a no-op, with no writes and not even a receipt.

**GraphQL source (optional).** Run `--source=graphql` with `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` and
`JOBBER_REFRESH_TOKEN` set in the local shell.

- It uses the same refresh-token grant as `functions/api/jobber-clients.js` and reads clients, visits (including
  unscheduled ones), active recurring jobs and open invoices, paging with backoff on Jobber's rate limits.
- The Jobber app then needs the `read_jobs`, `read_scheduled_items` and `read_invoices` scopes, in addition to
  `read_clients`. Adding scopes needs a new consent and refresh token: remove `JOBBER_REFRESH_TOKEN` from Pages so
  `/api/jobber-auth` works again, re-authorize, then save the new token.
- Keep **Refresh Token Rotation OFF**, so a local run does not orphan the deployed token.
- `JOBBER_GRAPHQL_VERSION` (read only by this script, from the local shell) overrides the API version header. The
  default is `2025-04-16`; the deployed `/api/jobber-clients` still pins `2023-11-15`.
- The four queries and the filters the script sends were validated field by field against Jobber's published GraphQL
  schema (introspection), and the paging, throttling and error paths are covered by mocked tests. The path has not been
  run against the live Jobber API, so start with CSV.

### Resolutions file

Resolutions settle conflicts by Jobber id. They are validated strictly, and an unknown key is an error.

```json
{
  "clients": {
    "1004": { "customerId": "customer_abc123" },
    "1005": { "action": "create" },
    "1006": { "customerId": "jobber_client_1005" },
    "1009": { "action": "skip" }
  },
  "jobs":     { "2005": { "jobberClientId": "1003" }, "2010": { "action": "skip" } },
  "invoices": { "3005": { "jobberClientId": "1003" }, "3009": { "action": "import" }, "3011": { "action": "skip" } },
  "customers": { "customer_abc123": { "accountRootJobId": "job_abc_first_visit" } }
}
```

**`clients` entries:**

- `customerId` attaches the client to an existing Hub customer. It can also merge the client into another Jobber client
  being created, as `"jobber_client_<id>"` does for 1006 above.
- `create` keeps a Jobber duplicate as a separate customer.
- `skip` leaves the client and all of its records out.

**`jobs` and `invoices` entries:**

- `jobberClientId` links an unmatched row to a client.
- `import` treats an invoice whose status could not be read as open.
- `skip` drops the row.

**`customers` entries** are keyed by **Hub** customer id. `accountRootJobId` picks, for a customer with several account
roots, the root that imported jobs and balances join. It must be one of the conflict's `rootCandidates`.

### Jobs collection size limit

One live reader still stops working correctly once the `jobs` collection holds more than **500** documents: the sales
follow-up exit check (`functions/_lib/sales-followup-exit.js`, audit #32) reads one 501-row page and refuses above 500.
Past that, HighLevel nurture keeps texting customers who already accepted. (The crew schedule had the same limit, audit
#2; P1-01 fixed it and is merged.)

History records live in `jobs`, so the dry run projects the collection size. If the projection is above 500, apply
refuses until one of these happens:

- a later `--history-since` keeps the import under the limit, or
- a bounded, per-customer follow-up exit query is **deployed** (audit #32, "NEW: legacy send-path hardening", not yet
  assigned to a unit). Then pass `--allow-large-jobs-collection`.

You can also import clients, upcoming jobs and invoices now, and import older history later by moving
`--history-since` back. Reruns are additive and never duplicate.

### After apply

- **Dispatch review.**
  1. Open Dispatch and type `jobber_job` in search. Do not work from the Unscheduled filter alone: it also shows the
     imported `jobber_invoice_*` rows, which are open balances, not work (Dispatch refuses to schedule them).
  2. For each imported job: open it, read the internal notes (Jobber dates, crew, value), confirm the customer, price
     and crew, and schedule it. Dispatch runs every conflict and lock check.
  3. For each entry in the report's `multiVisitJobs`: the Hub job holds one visit. Schedule it, then create each other
     listed visit in Dispatch for the same customer (or cancel it with the customer). Tick every listed date off.
  4. Customer notifications stay off on imported jobs. Tick "Save confirmation and reminder preferences" in the Hub
     schedule's edit dialog only if you want confirmations and reminders to go out.
  5. Record the agreed price on the job's estimate. Imported jobs carry no Hub price, only the Jobber value in notes.
- **Recurring plans.** For each entry in `recurringPlans`, schedule the next visit. Then set its visit cadence in the
  Hub schedule and use "next visit", which is saved through Dispatch as a repeat of that job. Once P1-05 merges, use a
  recurring plan instead.
- **Open balances.** Hub finance shows each imported balance (and marks it overdue if it is past due). Collect it by
  your normal method and use **Record payment**. Automatic reminders stay off unless you enable them per job.
- **Spot-check.** Pick 10 customers from `matches`. Compare their Jobber and Hub records: history visits, open balance,
  upcoming work.

## 5. Parallel run (recommended: 1–2 weeks)

| When | What |
| --- | --- |
| T-7 days | Prerequisites merged and deployed (section 6). Owner checklist items for the Hub done. First CSV export and dry run. Clear conflicts in Jobber and in `resolutions.json`. Train crew on the Hub crew app and time clock. |
| Day 0 (freeze) | Jobber becomes **read-only for new work**: no new clients, quotes, jobs or visits in Jobber. **Turn off Jobber's automatic client communications** (visit reminders, job follow-ups, quote and invoice follow-ups, review requests) so customers do not hear from both systems. Final export and dry run. **While apply runs, pause the writers the import cannot fence:** MCP and AI-assistant scheduling and customer-link actions, customer scheduling links, Dispatch changes and legacy Hub customer and job edits. Then apply with both fingerprints and resume. Dispatch schedules every imported job in the Hub, including every visit listed in `multiVisitJobs`. |
| Days 1–14 | All new work is created, scheduled, clocked, invoiced and paid in the **Hub only**. Jobber is used only to look things up. Crew clock in and complete work only in the Hub. |
| Weekly during the parallel run | Re-export and run a **dry run** with the same resolutions. Act on `changedSinceImport` and `imported_invoice_no_longer_open` by hand: a customer may have paid through an old Jobber invoice link. Apply again only if new stragglers appear. Reruns never duplicate or overwrite. |
| Weekly during the parallel run | Export payroll from the Hub (Gusto sync; the P1-03 CSV once merged) and compare with what Jobber would have produced for the same week. |
| End of the parallel run | Check the cutover condition (section 6). Cut over only when every item is ticked. Otherwise extend the parallel run, or roll back (section 7). |

## 6. Cutover condition

Jobber is switched off only when **all** of these are true, in writing, signed off by the owner.

- [ ] **Phase 1 acceptance flows pass on mobile (375×812) and desktop:**
  - book a walkthrough;
  - walkthrough handoff to a signed job with a deposit;
  - dispatch a multi-crew job (assign, reschedule, cancel or restore) without conflicts;
  - crew day on the phone: My day, job actions, photos, checklists, completion;
  - time clock in and out, manager approval, weekly timesheet;
  - issue an invoice, Stripe portal payment and an offline payment;
  - recurring job (repeat or plan);
  - arrival window shown in the portal.
  The units behind these flows must be merged **and deployed**: P1-01, P1-04 and M2 are merged; P1-03, P1-05, F-PWA and
  HUB-REG are not yet.
- [ ] **Owner checklist complete for everything the flows depend on:** Stripe webhook, HighLevel keys and workflows,
  Gusto, Firebase service account, feature flags set as recommended, and `firestore.rules` published.
- [ ] **Import dry run is clean:** `blocking: []`, **zero unresolved conflicts**, zero blocking `unmappable` rows, and
  the jobs-collection projection within the limit, or explicitly allowed once the bounded follow-up exit check is
  deployed.
- [ ] **Import applied:** the receipt `jobberImport/<runId>` shows `status: 'completed'`. A rerun dry run plans zero
  writes and reports no `changedSinceImport`, or each one has been handled.
- [ ] **Every imported upcoming job has been reviewed:** each `jobber_job_*` is scheduled, cancelled or intentionally
  left unscheduled. The Dispatch `jobber_job` search shows none that are unreviewed (`jobber_invoice_*` rows are
  balances and are settled through finance, not scheduled).
- [ ] **Every visit in `multiVisitJobs` is accounted for:** each listed date of the final apply's report is a scheduled
  Hub job for that customer, or was cancelled with the customer.
- [ ] **Two consecutive weeks of payroll** exported from EGC (approved Hub timecards through Gusto or the payroll CSV)
  and paid without corrections from Jobber.
- [ ] **Invoices and payments reconciled against Stripe for the whole parallel period:**
  - every Stripe charge maps to exactly one Hub job payment, with no unrecorded crew card payments (M2);
  - every Hub "paid" has a Stripe charge or a recorded offline reference;
  - every imported Jobber balance is either still open in both systems or recorded as paid in the Hub.
- [ ] **Crew trained:** every active crew member has run at least one full day in the Hub crew app (clock in, job
  actions, photos, completion, clock out). Managers have used Dispatch and Hub finance for a full week.
- [ ] **Rollback plan rehearsed** (section 7), and the Jobber archive is saved to Drive.

## 7. Rollback plan

Rollback means going back to running operations in Jobber. **Hub records are never deleted**; they remain the record of
what happened in the Hub.

1. **Trigger.** A cutover-condition item fails and cannot be fixed within the parallel period, or the Hub is unavailable
   for more than one working day.
2. **Keep Jobber recoverable.** Leave the Jobber subscription active and read-only (do not cancel it) until **30 days
   after cutover**. Re-enable Jobber's client communications only when you roll back.
3. **Carry work back.** List Hub work created since Day 0: jobs whose id does not start with `jobber_`, created after
   the freeze. Dispatch lists them by date, or use the MCP job search. Re-enter any that must continue in Jobber, then
   cancel them in Dispatch so nothing runs twice.
4. **Money.** Payments taken in the Hub stay recorded in the Hub and in Stripe. Mark the matching Jobber invoices paid
   by hand, citing the Stripe receipt, so nobody is charged twice.
5. **Identify imported data.** Imported records are identifiable by id prefix (`jobber_client_`, `jobber_job_`,
   `jobber_visit_`, `jobber_invoice_`), by `importSource: 'jobber'` or `source: 'jobber_import'`, and by the receipt
   `jobberImport/<runId>`, which lists every created document id. Leave them in place. Nothing reads them in a way that
   affects Jobber.
6. **Re-cutover later.** Run a new dry run. Reruns skip everything already imported.

## 8. Retiring Jobber after cutover

- **HighLevel:** uninstall the **Official Jobber Integration** app (it is listed under the location's Installed Apps).
- **Zapier:** disable the Crew Tools catch-hook branch "game_plan → Create Job in Jobber" (`CREW_WEBHOOK_URL`, see
  `functions/api/crew-hook.js`). Walkthrough handoffs already go through the Hub and HighLevel.
- **Cloudflare Pages:** after the rollback window, remove `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` and
  `JOBBER_REFRESH_TOKEN`. `/api/jobber-clients` and `/api/jobber-requests` then return 501. Delete them, together with
  `/api/jobber-auth` and the Jobber cases in `tests/integration-access.test.mjs`, as a follow-up (NEW, not yet assigned
  to a unit). `scripts/verify-crew.mjs` (CI-14) is not part of this: P3-13 retires it separately.
- **Jobber:** download a final export and invoice PDFs to Drive, then cancel the subscription.

## 9. Known limits of the import (JOB-CUT)

- **Recurring plans are report-only** until P1-05 merges. After that, a small follow-up can create plan drafts from the
  receipt's `recurringPlanProposals`.
- **No dedicated Dispatch badge for imported jobs.** Adding one would edit the shared `dispatch-storage.js` field mask
  and `dispatch-service.js` warnings. Imported jobs are found through the `jobber_job` search and their internal note. Each carries `needsDispatchReview: true` for a future badge or MCP filter. Dispatch does not
  clear the flag when it schedules the job, so it marks imported work, and "still needs review" means
  `needsDispatchReview && !date`.
- **Imported balances appear in Dispatch's Unscheduled filter and board.** A `jobber_invoice_*` row is `type: 'job'`,
  dateless and `invoiced`, so Dispatch lists it next to unscheduled work, and refuses to schedule it
  (`dispatch_terminal_job`). Review imported work with the `jobber_job` search. Hiding balances from the board is a
  Dispatch change outside this unit.
- **Several upcoming visits of one Jobber job are one Hub job.** The other visits are added by hand from
  `multiVisitJobs` (section 4). Automatic per-visit jobs need a stable Jobber visit id, which the CSV reports do not
  carry; with the GraphQL source (which has visit ids) this could be a follow-up.
- **Customers with several account roots need a choice.** Legacy customers whose jobs predate account lineage can have
  several roots. Each one that receives imported jobs or balances blocks the import until
  `customers.<customerId>.accountRootJobId` picks a root (or the client is skipped).
- **Garage Guard counts history.** Garage Guard linking reads at most 151 jobs per customer
  (`garage-guard-membership.js` `JOB_LIMIT`) and counts imported history rows among them, so a customer with a very long
  Jobber history goes to review as `too_many_jobs` instead of linking. Narrow `--history-since` for such customers, or
  link their membership by hand.
- **History rows appear in Hub finance.** The legacy finance board lists every non-walkthrough job, so history records
  show there as $0 "UNBILLED" rows. They carry no money fields and do not change any balance. Once the rules are
  published, finance actions on them fail with a permission error instead of editing history. Hiding `recordType` rows
  there is a Hub UI change for HUB-REG or M3.
- **Imported balances are not payable through the customer portal or a crew card payment.** Both charge only the
  approved quote, and an imported balance has none. Collect it by your usual method and record the payment in the Hub.
- **M3 must recognize opening balances.** LI-CORE's money core (`money-core.js`, merged, not yet wired) derives totals
  from the quote, so it reports an imported balance as `money_quote_missing`. When M3 moves Hub finance onto it, it has
  to treat `invoice.source: 'jobber_import'` / `invoice.imported: true` as an invoice whose own amount is the total.
- **P4-02 is not merged.** Phone and email matching reimplements P4-02's `normalizePhoneE164`/`normalizeEmail` rules
  exactly (`functions/_lib/jobber-import-map.js`); switch the import to import them once `customer-identity.js` lands.
  Matching trusts each Hub customer's saved `phone`/`email` over derived `phoneE164`/`emailLower` keys, which can be
  stale.
- **Header names and the GraphQL queries were checked against Jobber's help center (through search results), its
  published GraphQL schema and a third-party spec of a real export, not against a live Jobber account.** The dry run's
  column report and `--mapping` cover label differences.

## Sources

Jobber help center pages used for the export steps (read through search results on 2026-09-28; the pages themselves are
blocked from the build container):

- [Export Client Information](https://help.getjobber.com/hc/en-us/articles/115009619328-Export-Client-Information):
  Clients → More Actions → Export Clients → CSV; emailed; 1,500 rows per file; admins only.
- [How to Make Mass Updates to Clients](https://help.getjobber.com/hc/en-us/articles/360045644734-How-to-Make-Mass-Updates-to-Clients):
  `J-ID` identifies the record; clients with several properties appear once per property.
- [Reports Basics](https://help.getjobber.com/hc/en-us/articles/115009784848-Reports-Basics): Insights → Reports; admin
  or Reports permission.
- [Visits Report](https://help.getjobber.com/hc/en-us/articles/22081958176407-Visits-Report): Work reports → Visits;
  "start within" date filter; `Job #`, `Assigned to`, `Visit based ($)`; `Scheduled duration` in decimal hours; Export to
  CSV (all or selected columns), emailed.
- [Invoices Report](https://help.getjobber.com/hc/en-us/articles/17291337236247-Invoices-Report) and
  [Recurring Jobs Report](https://help.getjobber.com/hc/en-us/articles/20440772134807-Recurring-Jobs-Report): column
  picker and Export to CSV, emailed.
- Third-party spec of a real Jobber client export (header spellings, `J-ID = {clientId}_{propertyId}`, separators):
  [cleanScheduler tenant customer import](https://github.com/chris-712interactive/cleanScheduler/pull/217).
