# Door-to-door canvassing ("Knock")

EGC Knock is the phone app commission knockers use all day to log doors, and the screens the owner uses to
assign territory, watch results and pay commission. It lives inside this site at **`/crew/knock`**,
signs in with the existing **Hub accounts**, and stores everything in the existing Firestore project
(`egcw-1ec83`) through server APIs. It works with no signal: every tap is queued on the phone and synced later.

## Where it lives

| Part | Files |
| --- | --- |
| Phone app | `crew/knock.html`, `crew/knock.css`, `crew/knock-app.js` (shell, sign-in, sync), `crew/knock-rep.js` (shift and doors), `crew/knock-sale.js`, `crew/knock-map.js`, `crew/knock-stats-ui.js`, `crew/knock-admin.js` (admin screens), `crew/knock-outbox.js` (offline queue), `crew/manifest-knock.webmanifest` |
| Rules shared by phone and server | `crew/knock-time.js` (NOAA sunset, knocking window), `crew/knock-sale-rules.js` (cancellation deadline, holidays, deposit refund), `crew/knock-money.js` (commission, pay periods, CSV), `crew/knock-stats.js` (shift clock, scoreboard, gate, coverage), `crew/knock-doors.js` (house state, go-backs, addresses), `crew/knock-settings.js` (every number) |
| Server | `functions/api/knock-me.js`, `knock-territory.js`, `knock-sync.js`, `knock-reports.js`, `knock-admin.js`; `functions/_lib/knock-*.js` |
| Map library | `crew/knock-leaflet.js` / `.css` (Leaflet 1.9.4, BSD-2, bundled because the site CSP allows only same-origin scripts) |
| County import | `scripts/knock-import-larimer.mjs` |
| Tests | `tests/knock-*.test.mjs`, `tests/knock-emulator.test.mjs`, `tests/knock.browser.mjs`, preview server `tests/knock-dev-server.mjs` |

## Look and feel

The screens follow the EGC Knock redesign (Claude Design, October 2026).
- **Design system:** the tokens and components are in `crew/knock.css`: colors with a dark set, type, spacing, buttons, outcome buttons, dots, badges, cards, meters, sheets, toast, tab bar and the admin shell.
- **Icons and building blocks:** the 24px line icons and shared pieces (`icon`, `dot`, `badge`, `banner`, `seg`, `meter`, `sheet`) are in `crew/knock-ui.js`. Icons are drawn with SVG elements, never HTML strings.
- **Rules the screens keep:**
  - Outcome buttons sit in the thumb zone and are at least 72px tall.
  - Every outcome color comes with a label or a letter (N, C, X, L, $, S).
  - The sync pill is the one place that says whether the phone is synced.
  - The toast sits under the sunset bar, never over the outcome buttons.
  - Admins get a navy sidebar on a laptop, and the Admin tab with section chips on a phone.

## Roles and accounts

* **Sign-in is the Hub's.** A knocker needs a Hub account (employee signup, then the owner approves it in the
  Hub, or a staff invitation). Google and email-link sign-in were not added: this repo already has one sign-in
  system with approval and session revocation, and a second one would split accounts.
* **Canvassing approval is separate.** The first time someone opens `/crew/knock` they get a
  *pending* canvassing profile and can do nothing. An admin approves them under **Admin > Reps**.
  **Deactivate** is one tap and takes effect on their next request (their queued doors stay on the phone).
* **Per rep:** on the City permit list (yes/no), cleared for Premium (yes/no), knocker or lead, their lead,
  and logged training minutes. A rep can start a shift only when **active and on the permit list**.
* **Admins** are the Hub's business users (`zacb`, `tylerg`, `alexk`, or managers with staff-role access).
  Only admins read customer details, change settings, assign territory or export payroll.
* **Leads** knock like reps and see their team's scoreboard. No team lead commission is enabled by default.
* **Staying signed in** (owner decision, 2026-10-19). Knock, Crew Tools and the Hub share one sign-in. It lasts until
  it goes **7 days without use**: once a sign-in is an hour old, the next request from the phone renews it for another
  7 days (`functions/_lib/hub-session.js`, renewed in `functions/_middleware.js`). There is no fixed maximum. Rejecting
  an employee account in the Hub's staff account review, a sign-in reset or a password change still ends its sessions
  on their next request, and a renewal checks the account first. An owner or manager set in `HUB_AUTH_USERS_JSON` is
  signed out the same way when their password hash there changes or the account is removed (their sign-ins from before
  this release are never renewed and end at their 12-hour expiry). Knock's offline copy of who is signed in lasts the
  same 7 days, and signing out of Crew home or the Hub removes it, as Knock's own sign-out does.
* **From the crew hub.** Crew home (`/crew/`) shows a **Door-to-door** tile, and the crew menu a **Door-to-door** link,
  to business users (Knock's admins) and to anyone who has already signed in to Knock on that phone. Showing them
  never creates a canvassing profile; only opening Knock does. Knock's **More** screen links back to **Crew home**.
  The installed app opens `/crew/knock` directly (its manifest `id` is still `/crew/knock.html`, so installed apps
  keep their identity), and the **EGC Knock** wordmark goes Home without reloading the app. With no signal, Crew home
  shows the crew offline page, whose **Open EGC Knock** button leads back (Knock is cached whole on the phone).
* **Owners' Start in-home walkthrough** saves the look and sends it before the walkthrough opens in the same tab, with
  the door's address. If Knock refuses the look (on a break, outside knocking hours) it says **Look not saved** and
  offers **Open walkthrough**. A walkthrough already open on that device for another customer is kept: it shows
  **Knock sent <address>** with **Start new for this door** or **Keep the open one**; one holding nothing but an earlier
  Knock door's address moves to the new door.

## Run it locally

Needs Node 22+ (the repo's version), and for the emulator, Java 21.

```bash
npm install --ignore-scripts
```

```bash
node tests/knock-dev-server.mjs --demo
```

Open the printed URL and sign in as `Rep.One`, `ZacB`, `Rep.Two` (pending) or `Lead.One` with the
password it prints. The preview uses an in-memory copy of Firestore with synthetic houses; `--houses file.json`
loads houses written by the import (`--out`), and `--demo` adds a synthetic week of results.

Tests:

```bash
node --test tests/knock-*.test.mjs
```

```bash
npm install --no-save --ignore-scripts firebase-tools@15.30.2 @firebase/rules-unit-testing@5.0.2 firebase@12.19.0 playwright@1.63.0
```

```bash
node node_modules/playwright/cli.js install chromium
```

```bash
node tests/knock.browser.mjs
```

```bash
EGC_FIREBASE_EMULATOR_TEST=1 node scripts/emulator-exec.mjs --project demo-egc-knock "node --test tests/knock-emulator.test.mjs"
```

The browser test signs in as a rep, starts a shift, logs five doors offline (reloading the app offline in the
middle), reconnects, and checks the admin coverage and scoreboard. Both emulator commands also run in
`.github/workflows/egc-firestore-ci.yml`.

## Territory and the Larimer County import

1. **Admin > Territory > Seed the 24 neighborhoods** creates them with tier, status (the five held ones stay
   locked), platted house count, town and county key.
2. Load the houses with the import script. It reads Larimer County's public Parcels MapServer
   (`https://maps1.larimer.org/arcgis/rest/services/MapServices/Parcels/MapServer`): layer 1 subdivision
   polygons by each neighborhood's county key, then layer 0 address points inside them. It checks the field
   names first (`?f=json`), pages past the 1,000-record limit, waits between requests and retries.
   **It never reads layer 3 (owner names and mailing addresses)** and refuses any layer but 0 and 1.

```bash
node scripts/knock-import-larimer.mjs --neighborhood kechter-farm
```

```bash
node scripts/knock-import-larimer.mjs --all --out knock-houses.json
```

   Writing to production Firestore needs the service account and an explicit flag (nothing is written without it):

```bash
FIREBASE_SERVICE_ACCOUNT_JSON='<the JSON>' node scripts/knock-import-larimer.mjs --all --production --yes-write-production
```

   Each neighborhood prints its imported count next to the platted count, how many addresses have unit
   numbers and how many sit outside the neighborhood's town; after storing it reads the count back.

* **Stored per house:** street, number, unit (if any), latitude and longitude, plus flags. No names, no
  mailing addresses, no owners.
* **Units:** addresses with BLDG/STE/APT/# or a letter/dash suffix, and several address points at one street
  address, are flagged. **Admin > Territory > Exclude N unit addresses** removes condos and townhomes in one
  tap; **Houses** brings single ones back.
* **Other towns:** an address whose incorporated town differs from the neighborhood's (for example 3
  unincorporated addresses in Fossil Lake Ranch) imports locked until reviewed.
* **Re-importing is safe:** addresses are updated by field, so outcomes, exclusions and no-knock flags stay.

Last full import (2026-10-06): 11,721 houses. Most neighborhoods are within a few houses of the platted count.
The big gaps are held neighborhoods: Timnath Ranch 812 vs 1,261 and Serratoga Falls 326 vs 583 (newer filings
without address points yet, or filings the county key misses). Highland Meadows imported 1,442 vs 1,335.
Check those county keys before opening them.

**Assigning:** Admin > Territory assigns a whole neighborhood or single streets to a rep. Reps see and can
log only what is assigned to them. **Premium** neighborhoods need a rep cleared for Premium; **Hold**
neighborhoods, and any neighborhood whose town has no rule in settings, are locked for everyone.

**Reps choosing their own area:** with Settings > Territory "Reps may claim open neighborhoods" on (the
default; `settings.territory.selfClaim`), a rep opens **Choose area** (Home or More) and sees their areas and
the open neighborhoods they may claim, nearest first by the phone's GPS ("2.6 mi away", from the
neighborhood's center, else its bbox, else its houses). A claim is a whole neighborhood, one rep per
neighborhood, at most `settings.territory.maxSelfClaims` (default 2) at once; holds, Premium clearance, town
rules and neighborhoods with no imported houses stay unclaimable, and other reps are never named. A claim
lasts until the rep releases it or an admin removes it (Admin > Territory labels it "Self-picked"; an admin
assignment of the same neighborhood replaces it). Claiming and releasing need signal; a release is blocked on
the phone while doors there have not synced, and the server still accepts a door logged before the release
but refuses one logged after it. The chosen area ("Work here") drives the knock screen's suggested house and
the map's "Knock nearest". A neighborhood with no stored center is placed once from a sample of its houses.

**No-knock list:** paste the City's no-solicitation addresses into Admin > Territory > No-knock list,
**Preview**, then **Apply**. Reps flag a no-soliciting sign with **Skipped (sign)**. Either way the house
never shows as knockable again (an admin can clear a City entry; a rep's sign is cleared only by undoing it).

**Coverage** (Admin > Coverage): houses knocked, percent, looks, sales, last knocked and who is there now,
per neighborhood and per street.

## Knocking

* **Shift clock with breaks.** Knocking time excludes breaks. A shift idle for 4 hours ends at its last door.
* **One tap per door:** No answer, Not interested, Come back (optional day and time), Look (optional quoted
  price), Sold (opens the sale form), Skipped (sign). Optional **Car parked outside** toggle. After a tap the
  app moves to the next house on the street (same side, then back along the other side). **Undo** and **Edit**
  the last door. Knocks are append-only: undo and edit are new records, never changes.
* **Map and list views** color each house by its latest outcome, show the rep's GPS position and the nearest
  house not yet knocked. Map tiles need signal; the list and the colors work offline. GPS starts with the
  app (not only the Knock screen) and pauses while the app is hidden; a refused or missing location shows a
  banner with the fix. The map opens on the rep's territory (or chosen area), moves to the rep at the first
  fix, and when nothing can show it says why (not approved, nothing claimed or assigned, all locked, no
  houses yet) with the button that fixes it.
* **Go-backs:** a house whose last outcome is No answer or Come back, up to 3 tries a season, with a
  suggestion to try a different time of day. Not interested rests for 6 months.
* **Offline:** the app opens from the phone's own copy, queues every tap in IndexedDB and syncs in order when
  signal returns. A sign-in that expired while offline keeps the queue until the rep signs in again.

### The legal clock (Fort Collins; every number is in settings)

* Doors are allowed from **9:00 am to sunset**. Sunset is computed with the NOAA solar equations for
  40.5853, -105.0844 in America/Denver (for example 6:34 pm on 2026-10-06, 4:57 pm on 2026-11-01).
* A countdown shows all day; it turns orange **15 minutes** before sunset.
* After sunset new doors are blocked, but the rep may log **the door they were at within 15 minutes**; that door
  is flagged for the admin (**Admin > Flags**). Doors logged outside the hours, on a City no-knock house or on
  an excluded house are flagged too.
* Each town is a rule in `settings.cities` (start time, sunset or a fixed end, offsets, warning and grace
  minutes, coordinates and time zone). Add Windsor or Timnath there after legal review, then clear the hold.

## Sales

* **Sold** opens the form: package (The Works, Full Property Reset, Garage Transformation, Quick Clear),
  ticket, 25% default deposit, customer name, phone and email, job date, and the checklist the rep must tick:
  contract signed on the device and emailed; two printed cancellation notices handed over; customer told
  about the right to cancel. Nothing is saved until every item is ticked.
* **Right to cancel:** ends at midnight at the end of the third business day after the sale. Business days
  exclude Sundays and federal holidays and include Saturdays; when a fixed-date holiday falls on a weekend
  both the date and the observed weekday are skipped (only ever lengthening the window). The job date cannot
  be before the day after the deadline.
* **Deposit:** defaults to 25% of the ticket ($400 on $1,600), fully refundable until the deadline, then
  refundable until 24 hours before the job. Each sale saves its own rate and amount; later settings changes
  do not change that agreement or its Stripe description.
* **Payment dates:** Hub quotes sent from 2026-10-19 use `SENT_25_75`: deposit due when the customer approves the
  quote; remainder due on job day, in America/Denver. Quotes sent earlier keep `FINAL_25_75`: deposit due seven
  calendar days before the job, or on walkthrough day when the walkthrough falls within that week.
  Knock direct sales do not store a verified walkthrough date, so their form does not assert that the deposit
  is due today or invent a walkthrough-based due date.
* **Customer contact details exist only on the sale** (`knock_sales`). Houses and door records never hold them.
* **Lifecycle** (Admin > Sales): booked, completed, paid (with the amount collected), cancelled; reinstate and
  move the job date.
* **Hand-offs**, each with a manual fallback that works with no integration at all:
  * **Job:** manual. The repo's Jobber connection is read-only (client and request lookup), so an admin
    creates the job in the Hub or Jobber and records the reference here.
  * **Deposit link:** manual (mark collected), or a Stripe Checkout link made with the repo's Stripe helpers
    when `STRIPE_SECRET_KEY` is set and settings say `stripe`. **Check payment** reads the session back from
    Stripe, so the existing webhook is untouched.
  * **Customer text:** manual (text from HighLevel, then mark sent), or **one** HighLevel SMS per sale when the
    server has `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID`, settings say `highlevel` and the customer agreed
    at the door. It goes through the repo's HighLevel messenger: the contact is upserted from the sale, then
    checked for Do Not Disturb and the `egc-no-sms-consent` tag. It is claimed before sending, never sent twice
    and never retried after an unclear answer. There is no bulk text anywhere. It is registered in the
    automation registry as `hub.knock_sale_receipt`. Before switching it on, check that no HighLevel Contact
    Created workflow would also text a new canvassing customer.
* **Walkthrough:** the Hub's walkthrough (`/crew/gameplan`) is business-only, so the Look sheet links to it only
  for business users. Pre-filling its address and writing its result back to the door needs a change in
  `crew/gameplan.html` (it reads only `walkthroughId` today).

## Booking into the Hub (Knock bridge)

Behind `EGC_KNOCK_JOB_BRIDGE` (exactly `true`; owner decision D8, 2026-10-17). Unset, Knock sales stay manual hand-offs
and every sync answer and record is as before. Code: `functions/_lib/knock-bridge.js`, `functions/_lib/knock-walkthroughs.js`,
`functions/api/knock-job-bridge.js`, `knock-crew-openings.js`, `knock-walkthrough-slots.js`; phone: `crew/knock-sale.js`,
`crew/knock-walkthrough.js`, the slot picker in `crew/knock-ui.js`.

* **Start times (owner rule):** jobs start at 9:30 am or later for job dates on and after 2026-10-15
  (`functions/_lib/job-start-policy.js`). Always: the sale form's start has a 9:30 minimum and the default start is
  9:30 (a stored 8:00 default is read as 9:30 on those dates, never rejected, so no saved settings are lost). With the
  bridge on: a sale event with an earlier start is refused (`knock_sale_job_time`) and can be fixed with **Edit and
  resend**; an admin's earlier start is refused and a kept 8:00 start moved onto such a date becomes 9:30, noted in the
  sale's history. With the bridge off an explicit start is stored as sent and an admin date move is as before (the
  office books those jobs by hand, and Dispatch itself refuses an early start).
* **In-person sale:** the form adds **Town** (from the neighborhood) and **ZIP**, and **Crew and day**: the crew starts
  the Hub has open on and after the earliest job date (`GET /api/knock-crew-openings`; each slot is only day, time,
  end, crew label and priority), or, with no signal or nothing open, a day and morning/afternoon. After the sale syncs
  (the sync answers `bridge:{kind:'sale',status:'pending'}`) the phone calls `POST /api/knock-job-bridge`, which:
  1. resolves or creates the Hub customer (`resolveCustomer`, the canonical upsert; a new customer records
     `acquisition {channel:'door_to_door', ...}`). An existing customer matched by phone or email whose name does not
     agree with the door's (a typo, a shared phone) is not linked unseen: the booking waits for the office (`review`,
     `customer_identity_review`), and the office's **Book in Hub** after that review links them (or it books the job by
     hand in Dispatch). Titles and household words (Mrs, the, family) are not names; two full names agree on a shared
     word other than both first names (a household with one surname, or a fuller name), a one-word name on any shared
     word (a shorter name). A shared first name alone ("John Smith" and "John Doe") or a door name with nothing to compare
     ("J", "Mrs") waits for the office; a Hub record with no name links;
  2. books the crew job through `mutateDispatch` as the server actor `knock-bridge`, request id = the sale id (a repeat
     replays, never a second job), for the sale's job date and start as they stand (the rep's pick, or a date the
     office set before the job was in the Hub; the rep's ask stays in `schedule`), with the ticket on the job's
     `d2d.ticket` (the HighLevel deal's value; crew views never include it). It is not a Hub price (`priceQuoted` or
     `total`): Knock collects a door sale's deposit and the rest (`handoff.deposit`, customer receipts), so the Hub's
     money (its deposit, balance, closeout card and field pay) never charges it; with `EGC_DISPATCH_CREW_AUTO_ASSIGN` on
     the server picks the crew: the time asked for with any free crew (Crew 1 first), else the nearest other start that
     day, else the nearest day within a week, else the asked-for time with no crew (Sold: needs crew). With auto-assign
     off the job waits as Sold: needs crew;
  3. stores the outcome on the sale (`handoff.job` mode `hub`, the Hub job id, day, time, crew label). The rep sees
     "Booked: Crew 2, Mon Oct 26, 9:30 am" or "Booked: office will confirm the crew" (My sales; My money adds the Hub
     job's live day, crew and status).
  The sale itself is never lost because of scheduling. When the booking lands on another day or start than asked (no
  crew was free then), the sale's `jobDate` and `jobStartTime` move with it, so the customer text, the refund cutoff and
  every list name the booked time; what the rep asked for stays in `schedule` and `handoff.job.requested`, the sale's
  history and the job's notes say why, and the admin card says to confirm the day with the customer before texting.
  A date the office set while (or since) the booking ran is never overwritten: the Hub job moves to it as soon as the
  booking is saved (the history says so). When the Hub cannot take that time, Admin shows **The Hub job needs you** with
  both days and the reason (`handoff.job.hubChange` `move`, never "no crew was free"), and **Try again** moves it.
* **Retries and the office:** only a fault that clears by itself (dispatch storage, a schedule that changed during the
  search, a save that raced another, a lost answer: `TRANSIENT` in `knock-bridge.js`) is retried, after a wait of 1
  minute doubling to an hour (`retryAfter`, enforced by the server whatever the phone does; the phone keeps the same
  wait per item and books in the background, never holding up the next door's sync). Any other refusal (a customer the
  Hub cannot match safely, a booking dispatch refuses, records that need review, a bug), and the eighth failed try,
  is `review`: the phone stops asking and the office sees the code and reason in Admin > Sales, with **Book in Hub**.
  A phone that lost the sync answer still books: a replayed sale or walkthrough not booked yet comes back
  `bridge:{status:'pending'}` again, and My sales re-queues any the server still lists as booking.
* **Admin changes follow the Hub job:** cancelling a booked sale in Knock admin cancels its Hub job (reason
  `customer_changed_plans`; the cancellation itself never waits on the Hub, and a Hub failure is saved on
  `handoff.job.hubChange` and shown with **Try again**). A sale cancelled while its booking is in flight never keeps a
  job: the booking stops before the save when it sees the cancellation, a job saved meanwhile is cancelled at once,
  and one saved without the sale learning it (a lost answer) is found by its dispatch receipt when the office cancels
  (or the phone asks again) and cancelled too. Reinstating restores the job, and books a reinstated sale that has no
  Hub job (one the office must review stays for that review); a failure the change made moot (a cancellation that
  could not reach the Hub, then the sale reinstated) is cleared, so a healthy job never shows **The Hub job needs
  you**. A new job date moves the Hub job first, keeping its length (the crew is picked again with auto-assign on; a
  day with no crew free leaves it as Sold: needs crew), also a job saved without the sale learning it (found by its
  dispatch receipt and linked by the move), and a time the Hub refuses (a hand-staffed crew that cannot make it) is
  refused with `knock_hub_move_refused`, so the sale and its job never disagree.
* **Booked length by package** (`crew/knock-sale-rules.js` `PACKAGE_JOB_MINUTES`, planning defaults Dispatch adjusts):
  Quick Clear 3 h, Garage Transformation 6 h, The Works 7 h, Full Property Reset 7.5 h; anything else 6 h.
* **Walkthrough set** (a seventh door outcome, letter W, teal; counts as an answered door and as "Walkthroughs set" on
  the scoreboard): the rep takes the customer's name and phone and picks an estimator hour (`GET
  /api/knock-walkthrough-slots`, next 10 days, 9:00-5:00, the estimator's first name and an opaque handle only), or a day
  and morning/afternoon offline. Estimators are staff with the `walkthrough_estimating` skill (staff directory on), else
  staff whose role is sales, never the rep who set it. Booking re-checks the hour: that estimator, else another free
  then, else the nearest free hour, else an undated walkthrough in Dispatch's To schedule list. A dated booking the Hub
  refuses for any reason that does not clear by itself also goes to To schedule, with the reason in its notes, so a
  walkthrough promised at the door always reaches Dispatch; one that cannot reach the Hub at all (a customer the Hub
  cannot match safely) is listed in Admin > Sales under **Door walkthroughs not in the Hub yet** (one bounded query on
  `knock_walkthroughs.status == 'set'`) with its reason and **Book in Hub**. The same request writes
  `knock_setters/<Hub walkthrough id>` (13% setter + 7% estimator, D6b; nothing is earned until the walkthrough
  converts and is collected).
* **Do the walkthrough now** (REP-WALKTHROUGH, owner decision 2026-10-21): on the same form, a rep an admin turned
  **Walkthroughs** on for in Knock Admin → Reps (`knock_reps.walkthroughSelf`, recorded with `walkthroughSelfBy` and
  `walkthroughSelfAt`), or anyone who already runs walkthroughs (an owner, a manager, an estimator; `knock-me` answers
  `walkthroughNow`) does the walkthrough themselves. It is Knock's own right, not the Sales role
  (`functions/_lib/knock-self-walkthrough.js`): the walkthrough APIs (`/api/walkthrough-handoff`, `/api/walkthrough-visit`,
  `/api/quote-draft`, `/api/pricing-config?parts=walkthrough`) accept such a rep only for a request naming their own
  self-run visit (`d2d.selfRun`, assigned to them alone) or the job its handoff saved, and never give Dispatch,
  customer lookups, crew openings, other visits or a place in the estimator pool. A self-run visit is booked only for a
  customer that booking created: when the door's phone or email links a customer the Hub already had, a Knock-only
  rep's walkthrough goes to an estimator ("This customer is already in the Hub, so the office sends an estimator") and
  the answer carries nothing stored about that customer (`EXISTING_CUSTOMER`); owners, managers and estimators, who
  see customers anyway, still self-run. Every switch change is kept in `walkthroughSelfLog` (newest last, capped).
  Not covered: the audio recorder and walkthrough notes, so on these walkthroughs the rep types notes at Finish. The door and a `walkthrough` event with `selfRun: true`, today and the tapped time,
  are sent at once; the bridge books the Hub visit to the rep (no openings search; `bookSelfRun`) and answers
  `selfRun` with the Hub walkthrough id, and the phone opens `/crew/gameplan?walkthroughId=…` on it (the full builder
  menu, vehicles, pricing and signing; customer details come from the Hub visit, never the address bar). Offline the
  button says so and offers Set walkthrough. A rep who may not run walkthroughs, or a visit the Hub refuses to book to
  them, gets an estimator as above; an admin's own tap books the admin, and an admin booking another rep's door from
  Admin > Sales books an estimator. A refused one is fixed and sent again like any walkthrough (Edit and resend), as
  "do it now" or for an estimator. The setter record carries `selfRun` and the rep's staff key, and no estimator: when
  the rep signs the handoff the job pays the rep's direct-sale 25% alone (`repRanWalkthrough`), never 13% + 7%; if
  anyone else signs it (an estimator took it over), it is an ordinary door walkthrough: 13% to the rep and 7% to the
  signer. Admin > Money shows it as "walkthrough the rep ran (25%)" (CSV
  `door_walkthrough_commission_included`).
* The walkthrough is on the estimator's own day (crew home's walkthrough cards,
  `/api/field-jobs`), on their crew schedule page (`/crew/schedule`: a walkthrough shows only to the person it is
  assigned to, on no crew, as "Walkthrough", opening the walkthrough page) and in Hub dispatch. Customer details live
  only on `knock_walkthroughs` (server-only, like `knock_sales`). The estimator handle (`ref`) is an HMAC of the staff
  key under a secret derived from `HUB_SESSION_SECRET`, so it cannot be matched against guessed usernames.
* **One walkthrough per house:** a second walkthrough at a house where one stands is refused
  (`knock_walkthrough_exists`), and another rep's Sold or Walkthrough set there is refused
  (`knock_walkthrough_other_rep`): one attribution per house, and no estimator sent to a customer who already bought.
  Walkthrough set is also refused where the house has an open door sale (any rep's, the rep's own too: booked, with a
  job date no more than 30 days ago, `SOLD_OPEN_DAYS`; `knock_house_sold`) or another channel's native form claim
  (`knock_form_channel_conflict`). A completed, paid or cancelled sale, or an earlier season's, leaves the house open (a
  walkthrough there is new work); the office frees a house whose job is done by marking the sale completed. These checks read the
  house's form fence (`knock_form_revisions`) first and the sync commit verifies it unchanged, so two syncs deciding
  about one house at the same moment never both commit: the later one is answered 503 `knock_house_busy` (the phone
  keeps its changes and syncs again, then gets the refusal).
* **Switching to a sale:** the rep who set a walkthrough (or asked for a native GHL walkthrough request) may still log
  Sold at that house. A booked walkthrough is named in the sale's Hub job notes for the office to cancel and keeps
  `supersededBySaleId`; so is one whose visit was saved but whose answer was lost (found by its dispatch receipt). One
  not booked yet is withdrawn (`status: 'superseded'`) and never books: a visit saved for it anyway (a booking in
  flight, or a lost answer) is recorded on it and cancelled in the Hub (reason `duplicate_booking`, `booking.withdrawn`),
  with no setter record.
* **HighLevel:** the bridge sends nothing to HighLevel. Each Knock-made job carries data for the schedule mirror
  (`EGC_GHL_SCHEDULE_MIRROR`): `source: 'door_to_door'`, `d2d: {kind: 'sale'|'walkthrough', repKey, saleId |
  setterEventId, houseId, contactSource: 'Door to door', at, ticket (a sale's signed price: its deal's value)}` and
  `ghlTags: ['egc-d2d-sale']` or
  `['egc-d2d-walkthrough']`. The mirror writes `Door to door: sale|walkthrough set by <rep first name>` in its note
  and the source "Door to door" on a contact or opportunity it creates. It adds the D2D tag to the contact only with
  `EGC_GHL_D2D_TAGS=true` (off; registered as a potential workflow trigger, gate `D9B.d2d_tags`), once with the
  booking. See [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md).
* **Rep's day:** the door's time and the knocking window are taken when Sold or Walkthrough set is tapped, so a customer
  still signing after sunset is not lost; a refused sale or walkthrough opens its form again with everything typed
  (**Edit and resend**, same id).
* **Reads:** each new sale or walkthrough costs one customer resolution, one openings search over a week and one
  dispatch save (a walkthrough at most two searches and three saves); a repeat reads only the receipts, and a phone
  asking before its retry is due, or about one the office must look at, reads only the record. With
  `EGC_DISPATCH_WINDOWED_READS=true` (recommended before turning the bridge on) the customer is matched through the
  customer search index (two keyed queries while every customer has current keys) and the searches and saves read a
  window of jobs; without it each of those scans the whole customers and jobs collections. The sale form reads crew
  slots once per job length for the life of the form.

## Money

* **Commission:** D2D direct close is 25%; appointment setter is 13% plus estimator 7% (20% total, owner decision 2026-10-17);
  direct estimator is 7%. A walkthrough a rep runs and signs themselves is their direct close: 25% only (owner decision
  2026-10-21). Junk removal is excluded, and there is no team lead commission or accelerator
  enabled by default. These channel rates must not stack. Service classification, calculation base,
  attribution and contract approval remain required before monetary results are payable.
* **Earning:** current `knock-collected-v3` terms earn on recorded full customer collection, independently of
  job completion. Partial receipts, refunds, cancellations with receipts and unverified terms stay under
  review. Older saved contracts retain their original conditions and enabled bonuses; current settings
  never rewrite historical terms. A customer receipt is not a commission payout.
* **Per rep, per pay period:** booked, pending, earned, paid and balance. Reps see their own (More > My money);
  admins see everyone, record payouts and export **Commission**, **Training** and **Sales** CSVs
  (Admin > Money). Payout cadence is biweekly; the default 2026-10-05 anchor is an unconfirmed draft.
  Payroll export remains blocked until the complete contract and anchor have explicit approval.
* **Training** is logged separately (Admin > Reps) and exported at the hourly rate in settings ($15.16).
* Worker classification and payroll setup require their own review; these percentages do not approve either.

## Scoreboard

Per rep, team, neighborhood or day: knocking hours, doors, answers, looks, sales, booked revenue and booked
revenue per knocking hour, each against the plan (14 doors/h, 35% answer, 8% look, 22% close, $1,600 ticket,
$138/h), plus the look rate with and without a car outside. **The gate** (admins): under 40 knocking hours it is
Too early; between 40 and 150 hours it shows a provisional band; after 150 hours $100+/h is Go, $70-$100 is
Fix, under $70 is Stop.

## Settings

Admin > Settings edits every number above (city rules, shift idle hours, deposit rate, cancellation business
days, refund cutoff, extra holidays, checklist text, commission rates and accelerator, lead override, training
rate, pay period, plan targets, gate thresholds, go-back limits, map tile URL, integration modes). Values are
validated before saving.

### Existing settings: explicit operator action before launch

`loadSettings` overlays the stored `knock_settings/current.settings` document on the defaults. A stored
20% deposit or enabled accelerator/lead override therefore remains effective after this code change.
Production overrides have not been verified by this change, and no stored settings or sales are migrated.

An authorized operator must inspect **Admin > Settings** and, if the stored policy differs from the launch
requirements, explicitly save a 25% deposit with the accelerator and lead override disabled for future
sales. Preserve the other reviewed settings. A compensation edit invalidates approval bound to the old
values; the reviewed approval process must reconfirm the exact contract, service scope, collection policy
and actual payroll anchor. Do not infer a pay date or copy an approval from defaults. Existing sales retain
their deposit and commission snapshots; discrepancies in signed terms require individual finance review.

## Deploy

The page and the functions deploy with the site (Cloudflare Pages from `main`). Then:

1. **Rules:** no publish is required. The live rules end with a deny-all catch-all, so the `knock_*`
   collections are already server-only; the blocks in `firestore.rules` only make that explicit.
   **Index:** create `knock_houses (neighborhoodId, updatedAt)`. The phones refresh their houses after every
   door, and with the index each refresh reads only the houses that changed. Without it nothing breaks, but
   each refresh reads the rep's whole neighborhoods (about 500 document reads instead of a handful). The
   index can be created on its own in the Firebase console (Firestore > Indexes > Composite). Publishing
   either file with the command below (needs the owner's Firebase login) also releases every other change to
   it on `main`, so do it deliberately:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes --project egcw-1ec83
```

2. No new environment variables are required. The server already has `HUB_SESSION_SECRET`,
   `FIREBASE_SERVICE_ACCOUNT_JSON` and, for the optional hand-offs, `STRIPE_SECRET_KEY`, `HIGHLEVEL_API_KEY`
   and `HIGHLEVEL_LOCATION_ID`.
3. Sign in at `/crew/knock` as the owner, seed the neighborhoods, run the import with `--production`,
   approve reps, mark the permit list, assign territory.
4. Before switching the deposit or text integration from `manual`, test with Stripe test keys and your own
   phone as the HighLevel contact.

## Privacy and security

* Every `knock_*` collection is server-only in `firestore.rules`; the emulator test proves no signed-out, rep,
  lead or owner SDK session can read or write them.
* The APIs enforce: a rep reads and writes only their own shifts, doors and sales and reads only houses in
  their assigned, unlocked territory; only admins read every customer, change settings or export.
* Houses are addresses and outcomes only. The payroll sales CSV has no customer contacts.
* No secrets are in the client or the repo. The import refuses to write production without explicit flags.

## Known limits and follow-ups

* Map tiles come from `tile.openstreetmap.org`; OSM's usage policy discourages heavy use. Switch
  `settings.map.tileUrl` to a commercial provider if the team grows.
* iOS can evict a website's storage after weeks unused; installed to the home screen it is kept. Reps should
  sync before closing out.
* Legal review items: confirm Fort Collins solicitation hours and permit rules, whether Colorado state holidays
  (e.g. Frances Xavier Cabrini Day, Cesar Chavez Day) should be added to `sale.extraHolidays`, and the cancel
  notice wording.
