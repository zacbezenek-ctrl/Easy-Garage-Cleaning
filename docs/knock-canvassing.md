# Door-to-door canvassing ("Knock")

EGC Knock is the phone app commission knockers use all day to log doors, and the screens the owner uses to
assign territory, watch results and pay commission. It lives inside this site at **`/crew/knock.html`**,
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
* **Canvassing approval is separate.** The first time someone opens `/crew/knock.html` they get a
  *pending* canvassing profile and can do nothing. An admin approves them under **Admin > Reps**.
  **Deactivate** is one tap and takes effect on their next request (their queued doors stay on the phone).
* **Per rep:** on the City permit list (yes/no), cleared for Premium (yes/no), knocker or lead, their lead,
  and logged training minutes. A rep can start a shift only when **active and on the permit list**.
* **Admins** are the Hub's business users (`zacb`, `tylerg`, `alexk`, or managers with staff-role access).
  Only admins read customer details, change settings, assign territory or export payroll.
* **Leads** knock like reps and see their team's scoreboard. No team lead commission is enabled by default.

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
* **Payment dates:** Hub quotes use `FINAL_25_75`: deposit due seven calendar days before the job, or on
  walkthrough day when the walkthrough falls within that week; remainder due on job day, in America/Denver.
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

## Money

* **Commission:** D2D direct close is 25%; appointment setter is 13% plus estimator 7% (20% total, owner decision 2026-10-17);
  direct estimator is 7%. Junk removal is excluded, and there is no team lead commission or accelerator
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
3. Sign in at `/crew/knock.html` as the owner, seed the neighborhoods, run the import with `--production`,
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
