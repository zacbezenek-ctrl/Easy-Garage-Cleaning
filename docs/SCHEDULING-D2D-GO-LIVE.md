# Scheduling and door-to-door go-live

This is your one checklist for the scheduling, crews, estimator and door-to-door (Knock) work. Most of it ships
**off**. A few staff-only parts work as soon as it is deployed: the crew schedule page, the door-to-door panel on the
board, the clock buttons on the crew app home, the Team lead role, and open times that follow the 9:00 to 5:00 day with
jobs starting at 9:30 or later. Nothing new reaches customers or HighLevel until you flip the switches below, in order.

How switches work is the same as in [GO-LIVE.md](GO-LIVE.md#how-to-use-this-page): set the value under **Preview**
first, retry the deployment, check, then do the same under **Production**. A switch is off unless it holds exactly
the value shown. To switch one off, delete it (or set it back as written) and retry the deployment.

- **Cloudflare Pages:** Cloudflare → Workers & Pages → the site project → Settings → Variables and Secrets.
- **Railway:** Railway → EGC project → the service (for example egc-worker) → Variables.

## What changed

**Crews and auto-assign.** Crews now have a priority and the days they work. One button makes Crew 1 and Crew 2
(Monday to Friday) and Crew 3 (Saturday and Sunday); you add the people. When an estimator, a sales or phone booker or
a door-to-door rep books a job, the Hub picks the crew itself: Crew 1 first, Crew 2 if Crew 1 is busy, Crew 3 on
weekends. The work day is 9:00 to 5:00 and jobs start no earlier than 9:30 (walkthroughs may start at 9:00). If no
crew is free, the booking is still saved, marked **Sold: needs crew**, with the next open crew times listed. Bookers
can accept a crew the Hub offers but cannot pick people by hand.

**Crew schedule and team lead.** Crew members open **Crew schedule** from the crew app home and see their own crew's work
for today or the week (first name and town only, no prices). A new role, **Team lead**, sees every crew's schedule.
Owners and managers do too.

**Estimator quote builder and handoff.** At a walkthrough the estimator builds the quote in order: removal first, then
shelving, then extra storage, priced from your pricing menu. Every builder quote with garage work then gets a **Labor**
line on top: the estimated man-hours × $53.00 per man-hour (your decision of 2026-10-19; it was $40.00 on 2026-10-18).
A junk-only quote (truck loads, with their special items and access charges) has no Labor line: $1,000 per truck (owner decision 2026-10-21, was $750) covers
the crew's time (your decision of 2026-10-18). The app fills in the man-hours from its own estimate of the garage work: the walkthrough time model in
person-hours for set-up and sweep-out, sorting a garage with a cleaning base and the cleaning add-ons, plus an hour per
shelving unit and a few minutes per tote, never the truck loads, special items or access (their prices pay for
loading, hauling and disposal), the same for any crew size and never capped at one day. The estimator can adjust them
before sending. The customer sees one amount, "Labor $318.00", never the man-hours or the rate; the estimator, the crew
brief and the HighLevel note keep the man-hours. Installing shelving and storage is billed through this line; for other storage goods (racks, cabinets,
hooks, tracks) the app has no install time yet, so such a quote is sent only once the estimator sets the man-hours by
hand, or you confirm installation is included in the goods price. Man-hours below the estimate show the estimate on
the job for you. When the estimator signs the
handoff, the server prices it again, labor included, and refuses it if anything differs. The estimator can pick one of the open crew times, and the Hub staffs
the job the same way as any other booking. Prices you have not approved yet do not stop the booking, but the job is
**held**: the customer gets no estimate, portal invitation or deposit request until you approve those prices.

**Purchase list and grab list.** A signed walkthrough now records what must be bought (by store, with packs and
product links) and what the crew brings from stock. Hub → **Purchase list** adds up what to buy for upcoming jobs and
lets the office mark items ordered or purchased. The crew job page shows **Grab before you go**.

**Door-to-door app and bridge.** Reps can claim up to 2 neighborhoods themselves (an admin can still assign more), and
**Near me** sorts areas by distance from the phone. When the bridge is on, a sale at the door books the customer and
a crew job in the Hub automatically, and **Walkthrough set** books an estimator walkthrough on the estimator
schedule. Commission follows the rules already in the app: 25% for a direct door sale, and for a walkthrough set at
the door 13% to the rep who set it plus 7% to the estimator. Admin → Sales lists anything that did not reach the Hub,
with the reason and a **Book in Hub** button.

**Reps doing the walkthrough themselves** (owner decision 2026-10-21). On the walkthrough form a rep can tap **Do the
walkthrough now** instead of booking an estimator: the visit is booked to them for right now and the full walkthrough
(every item, vehicles, pricing, signing) opens with the customer filled in. When the rep gets the customer's signature,
the job pays the rep 25% and nothing else: no setter 13% and no estimator 7%. If an estimator takes it over and
signs it instead, it pays like any walkthrough set at the door: 13% to the rep and 7% to that estimator. To turn it on
for a rep, turn on **Walkthroughs** for that rep in Knock Admin → Reps (it applies on their next action, no sign-out
needed). It does not give them the Sales role: they open only the walkthroughs they start this way, never Dispatch,
other customers or anyone else's visits, and they are never booked as an estimator for other reps' walkthroughs.
If the phone or email the rep types already belongs to a customer in the Hub, an estimator is booked instead and the
rep sees "An estimator will do this one." (the same words whenever "do it now" ends with an estimator, so it never
says the customer was known); the rep sees nothing about that customer. The rep's access to their own walkthrough ends
once it is signed, cancelled or lost, and 3 days after its date at the latest. Owners and managers always
have it. Reps without it see only **Set walkthrough**. It needs the bridge
(`EGC_KNOCK_JOB_BRIDGE`) on. On these walkthroughs the rep types their notes (the audio recorder stays with
estimators), the office staffs the crew in Dispatch, and a manager's Hub sends the signed job to HighLevel, as it does
for an estimator's.

**Hub schedule board.** Dispatch → **Board** shows crews, estimators and a **Door-to-door** panel for the day: reps on
shift, their areas, doors knocked, sales and walkthroughs set, with links to the jobs they made. Owners, managers and
team leads can see it. A job or walkthrough already on the loaded board opens in the Hub's own editor; any other opens
its crew page.

**Door-to-door inside the crew hub.** Crew home has a **Door-to-door** tile (and the crew menu a link) for owners,
managers and anyone who already uses Knock on that phone, and Knock's **More** screen links back to **Crew home**. My
money in Knock no longer sends reps to the Hub; with the bridge on it offers **Set a walkthrough at the door** instead.

**Staying signed in.** Staff now stay signed in: a sign-in lasts until it goes 7 days without use (it used to end 12
hours after signing in). Rejecting an employee account in the Hub, a sign-in reset or a password change still signs
that person out on their next request. For the owner and managers set in `HUB_AUTH_USERS_JSON`, a new password hash
there (or removing the account) signs them out on their next request; their sign-ins from before this release are not
renewed and end within 12 hours, so they sign in once more. Signing out of Crew home or the Hub also signs EGC Knock
out on that phone, so Knock never opens offline as someone who signed out.

**HighLevel mirror.** The Hub stays the schedule. HighLevel gets a second record of every booking that matters
(walkthrough booked, job scheduled, moved, cancelled or no-show, crew or estimator assigned): the customer's contact,
one deal per customer job in the EGC Pipeline moved forward to **Walkthrough Appointment** or **Job Scheduled**, and an
internal note with the date, time, crew, address and job breakdown (never prices). It does not need a HighLevel
calendar. For door-to-door customers the note also says **Door to door: sale set by** (or **walkthrough set by**) and
the rep's first name, and a deal or contact the mirror creates gets the source **Door to door**. It never changes the
source of a deal that already exists.

**Profiles and team directory.** Hub → My EGC → **Team directory** shows every staff member's name, photo, roles,
crew, shirt size and birthday (month and day, if they choose to share it). Only you and managers see other people's
birth year, age, phone numbers, emergency contacts and HighLevel user IDs. Customers never see any of it.

**Clock-in.** The crew app home has **Clock in** and **Clock out** buttons, using the same location rules as before.
After each person's first clock-in, clocking in reads far fewer database records.

## Turn-on order

Do these in order. Each step says where the switch lives, what it does, what must be true first and how to undo it.

**Launch defaults (2026-10-18).** At the owner's request, steps 5 to 8 are on without any Cloudflare setting
(`functions/_lib/launch-defaults.js`). A value set in Cloudflare always wins: `false` turns that one off after a retried
deployment. Steps 1 to 4, 9 and 10 still need the owner.

**Before step 1 (developer):** deploy the merged commit everywhere, then publish the database rules and indexes with
`firebase deploy --only firestore:rules,firestore:indexes --project egcw-1ec83` (see
[GO-LIVE.md B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)). This adds the index the door-to-door panel needs,
and the two that keep the crew schedule and a rep's My sales from re-reading old records (both still work, at the old
read cost, until the indexes are built).

1. **Faster schedule reads.** `EGC_DISPATCH_WINDOWED_READS=true` on Cloudflare Pages.
   - Does: Dispatch, bookings and the door-to-door bridge read only the dates they need instead of every job and
     customer. This keeps the database under its daily read limit.
   - First: your developer runs `node scripts/backfill-customer-search-keys.mjs` (a preview), then the same with
     `--apply`. Then, required, `node scripts/dispatch-window-audit.mjs` (read only): it lists jobs whose date the
     faster reads cannot place, which would stop counting as busy time. Repair each one's date in the Hub and run it
     again until it lists none; run it again after any import of jobs. Setting the value `shadow` for a day first is
     optional: it compares old and new reads in the logs.
   - Roll back: delete it. Reads go back to full scans.
2. **Team roles, skills and Team directory.** `EGC_STAFF_DIRECTORY_ENABLED=true` on Cloudflare Pages.
   - Does: turns on roles and skills in Hub → Staff directory, the Team directory and the shirt size and birthday
     fields. You need it to make Eli a team lead, mark estimators and reps, and record HighLevel user IDs.
   - First: your developer runs the two staff migrations, `staff-profile-pay-roles-v1` and
     `employee-account-staff-roles-v1` (dry run, then apply; [GO-LIVE.md 3.1](GO-LIVE.md#31-team-roles-staff-directory)).
   - Roll back: delete it. Saved roles and profile fields stay; the screens say they are off.
3. **Roles decide access.** `EGC_STAFF_ROLE_ACCESS=true` on Cloudflare Pages (an existing switch).
   - Does: Sales and Phone can book and move walkthroughs and jobs, so their bookings get a crew automatically.
   - First: step 2, and everyone's role is right in Staff directory
     ([GO-LIVE.md 3.5](GO-LIVE.md#35-staff-roles-grant-access-owner-decision-on)).
   - Roll back: delete it. Access goes back to the configured business users.
4. **Set up crews and people in the Hub** (no switch): see **Owner setup in the Hub** below, items 1 to 5.
5. **Automatic crew pick.** `EGC_DISPATCH_CREW_AUTO_ASSIGN`: **on by default** since 2026-10-18 (launch default; set it to `false` on Cloudflare Pages to turn it off).
   - Does: every new job booked by a booker, an estimator's signed handoff, the door-to-door bridge, the AI booking
     tool or a HighLevel adoption gets the first free crew. A manager's own new booking with nobody chosen gets one too,
     unless they untick **Assign the first free crew automatically**.
   - First: Crew 1, 2 and 3 exist and have members and a lead. Crews with no members are never picked.
   - Roll back: delete it. Jobs keep the crews they have; new jobs wait for a manager.
6. **Purchase list and grab list.** `EGC_JOB_MATERIALS`: **on by default** since 2026-10-18 (launch default; set it to `false` on Cloudflare Pages to turn it off).
   - Does: turns on Hub → Purchase list, the job breakdown and the crew's **Grab before you go** list.
   - First: nothing beyond the deploy.
   - Roll back: delete it. The purchase list says it is off; saved materials stay on the jobs.
7. **Quote builder.** `EGC_QUOTE_BUILDER_ENABLED`: **on by default** since 2026-10-18 (launch default; set it to `false` on Cloudflare Pages to turn it off). Approve the menu prices on the live Hub: a quote with a draft price is saved but not sent.
   - Does: walkthroughs open the guided builder. Quotes with unapproved prices are saved but not sent, and signed jobs
     with unapproved prices are held (no estimate or deposit request) until you approve them.
   - First: nothing to set; it is on. Approve the menu prices and check the labor rate on the live Hub (setup items 6
     to 8) before estimators send quotes. Quotes priced the old way that were not sent yet will need to be rebuilt in
     the builder before they can be sent.
   - Roll back: set it to `false`. Walkthroughs use their old quote again. Jobs already held stay held until re-signed.
8. **Door-to-door bridge.** `EGC_KNOCK_JOB_BRIDGE`: **on by default** since 2026-10-18 (launch default; set it to `false` on Cloudflare Pages to turn it off).
   - Does: a sale at the door books the customer and a crew job in the Hub; **Walkthrough set** books an estimator.
     Cancelling, reinstating or re-dating a sale in Knock admin follows through to the Hub job. Check Knock → Admin →
     Sales once a day: it lists anything that did not reach the Hub. Fix a duplicate customer in the Hub before you
     press **Book in Hub**.
   - First: steps 1 and 5, estimators have the **Walkthrough estimating** skill, reps are approved in Knock admin.
   - Roll back: delete it. Sales go back to manual hand-offs. Jobs already booked stay in the Hub.
9. **Crew schedule and door-to-door panel** (already on after the deploy; nothing to set).
   - `EGC_CREW_SCHEDULE` and `EGC_D2D_BOARD` on Cloudflare Pages are emergency off switches.
   - Roll back: set either to exactly `false` to hide that page or panel at once.
10. **HighLevel mirror.** `EGC_GHL_SCHEDULE_MIRROR=true` on Cloudflare Pages, and `EGC_GHL_TAG_DRAIN_ENABLED=true` on
    Railway → egc-worker (skip that one if the tag outbox already turned it on).
    - Does: every booking change reaches HighLevel as described above, with no calendar needed. Problems show on Hub
      → Integrations → HighLevel schedule mirror, with **Retry**.
    - First: in HighLevel, list every workflow started by **Pipeline Stage Changed** (Walkthrough Appointment, Job
      Scheduled), **Opportunity Created**, **Contact Created/Changed** and **Note Added**, with what it sends. This is
      [LAUNCH-ACCEPTANCE](LAUNCH-ACCEPTANCE.md) gate 2. Also run the opportunity-search check in
      [GO-LIVE.md](GO-LIVE.md#before-stage-2). egc-worker's `API_BEARER_TOKEN` must match the Hub's. Leave
      `HIGHLEVEL_JOB_CALENDAR_ID` (Pages) and `GHL_JOBS_CALENDAR_ID` (Railway) unset, and keep
      `GHL_WALKTHROUGH_CALENDAR_ID=qsibYaxFPm16uyovdIc5` on Railway.
    - Roll back: delete `EGC_GHL_SCHEDULE_MIRROR`. Nothing new is queued. Only delete the egc-worker switch if the tag
      outbox is off too.
11. **Door-to-door tags (optional, last).** `EGC_GHL_D2D_TAGS=true` on Cloudflare Pages.
    - Does: adds `egc-d2d-sale` or `egc-d2d-walkthrough` to a door-to-door customer's HighLevel contact, once, when
      the job is booked. Tags can start HighLevel workflows, including texts.
    - First: step 10 has run cleanly for a while, and you have listed every HighLevel workflow on these two tags. The
      rep already texts the sale receipt at the door, so a second welcome text would be a duplicate. The note line and
      **Door to door** source do not need this switch.
    - Roll back: delete it. Tags already added stay on contacts.

## Owner setup in the Hub

1. **Crews.** Dispatch → Crews & vehicles → **Create Crew 1/2/3**. Open each crew, add its members and choose its
   lead. If Crew 3 does not work Sundays, untick Sunday.
2. **Eli as team lead.** Hub → Staff directory → Eli → role **Team lead · sees every crew**.
3. **Estimators.** Staff directory → each estimator → skill **Walkthrough estimating**. Only people with this skill
   get door-to-door walkthroughs and show as estimators on the board.
4. **Door-to-door reps.** Staff directory → each rep → skill **Door-to-door sales**. Approve each rep in Knock →
   Admin as before.
5. **HighLevel user IDs.** Hub → Team directory → each estimator → HighLevel user ID (copied from HighLevel's staff
   settings). Their walkthrough deals are then assigned to them in HighLevel.
Items 6 to 8 are on the live Hub: the quote builder is on by default (turn-on step 7).

6. **Approve menu prices.** Hub → Catalog & pricing → Menu prices. Approve up to 100 per save (**Tick all in this
   step** helps). Check the Home Depot prices before you approve them. Held jobs that your approval covers are
   released automatically.
7. **Labor rate and goods markup.** In Menu prices, the **Labor** card shows the rate every builder quote charges per
   man-hour: $53.00, your decision of 2026-10-19. It is already approved, so nothing needs ticking. To change it, type
   the new rate, review and save; quotes saved at the old rate are saved again before they are sent, and a job the customer already
   signed keeps the rate it was signed at (a held one is released by your price approvals as usual). Installation is
   billed through the Labor line; tick the installation box only if installation is included in the goods price. It
   lets quotes with storage goods the app cannot time go out without the estimator's own man-hours, and releases
   builder quotes saved before the Labor line existed. The goods markup (default × 1.30) is
   changed on the Pricing tab, which shows only while catalog pricing is on; otherwise the default applies.
8. **Cleaning base prices.** In Menu prices, enter the cleaning-only amount for each of the four garage sizes before
   approving them. Their draft amounts came from the old walkthrough prices, which already included hauling, so
   approving them unchanged would charge hauling twice. **Tick all** leaves them out on purpose.
9. **Knock commission terms.** Knock → Admin → Settings: save the settings once, mark each package **Garage only**,
   **Junk** or **Needs review**, enter the reference of your signed commission plan, confirm the first day of the
   two-week pay cycle, then **Approve commission terms**. Until then no commission is payable.
10. **Workday.** Hub → Dispatch rules: check the day reads 9:00 to 5:00. A start time you saved earlier is kept.
11. **Database index (developer).** The `firebase deploy` command in **Turn-on order**. Without it the door-to-door
    panel still loads but says job links may be missing.
12. **Firebase Blaze.** In the Firebase console, move project `egcw-1ec83` to the Blaze (pay as you go) plan and set a
    budget alert. The free plan's daily read limit was already hit once; the new screens add reads. Then check Hub →
    Integrations reads normally ([LAUNCH-ACCEPTANCE](LAUNCH-ACCEPTANCE.md) gate 1).
13. **Estimator iPad check.** Sign in on the iPad as an estimator with the Sales role and open a walkthrough's game
    plan. It should load. This fix was checked in code only, never on the real iPad.

## Decisions still needed

Each has a recommendation. Until you decide, the Hub keeps doing what the item says it does today.

- **Self-claimed areas.** Reps may claim up to 2 neighborhoods each, exclusively, until released. *Recommended:
  keep.* Change it in Knock → Admin → Settings → Territory.
- **Crew 3 on Sundays.** The public booking page treats Sunday as closed, but Crew 3 is set up for Saturday and
  Sunday. *Recommended:* untick Sunday unless Crew 3 really works Sundays.
- **Which packages are garage-only for commission.** Package names alone do not settle it. *Recommended:* mark only
  packages that are entirely garage work as Garage only, and anything mixed as Needs review.
- **Setter commission (13% + 7%) and the estimator's 7%.** Tracked and held until you approve them: approve the
  direct-sale terms first, then "Approve walkthrough-setting and estimator terms" in Knock → Admin → Settings.
  After that, jobs paid in full pay the setter's 13% and the estimator's 7% (7% on an estimator's own walkthrough
  sales) in the Money statement. *Recommended:* approve once the direct-sale terms are approved. Until then the Knock
  reports show which rep set each walkthrough, so nothing is lost. Also update your pricing workbook's door-to-door
  split row to 13% and 7% so it matches the app. Record every payout in Money: a share that changes after it was
  paid (a later price change, refund or cancellation, or a different estimator) then holds the statement for you
  instead of being paid twice, and nothing is clawed back automatically. A junk-only quote, and a walkthrough signed
  by someone other than the estimator the door booking named, wait until the office classifies them.
- **Short payments, overpayments, refunds and rounding.** No rule exists, so these hold commission for review.
  *Recommended:* keep holding them until you write the rule.
- **Team directory privacy.** Teammates see shirt size and birthday month and day by default; each person can hide
  their birthday. *Recommended: keep.* The youngest allowed birth date is 14 years ago. *Recommended:* keep 14 unless
  you never hire under 16.
- **Installation of shelving and storage.** *Decided 2026-10-18:* every builder quote with garage work has a Labor line,
  the estimated man-hours × $53.00 per man-hour (*decided 2026-10-19*; $40.00 before), and installation is billed
  through it. The man-hours are filled in from the app's estimate of the garage work and the estimator can adjust them. Change the rate in Menu prices.
- **Junk removal.** *Decided 2026-10-18:* "the truck price covers the crew's time": $1,000 per truck since 2026-10-21;
  $750 before (quarter, half and three-quarter loads $250, $500 and $750). A junk-only quote has no Labor line,
  and no quote's labor estimate counts truck-load, hauling or disposal time. Builder quotes saved earlier that day (an
  estimate with truck-load time, a line naming the man-hours) are saved again before they are sent; signed jobs keep
  what was signed.
- **Junk-only quotes on a cleanout walkthrough.** *Applied 2026-10-18, owner to confirm:* a junk-only quote prices the
  hauling only, so the homeowner signs one only when the walkthrough records no garage work (sorting plan "Everything
  goes" or "Customer labels before arrival", no deep clean, pressure wash, mouse trapping, shelving, totes or pest-waste
  cleanup). A sorted cleanout needs the garage cleaning base (and its Labor line), which is held until you approve the
  base's cleaning-only amount in Menu prices. The signed estimate's scope is the quote's own lines ("Junk removal only:
  …" for a junk-only quote), never the walkthrough's "Garage cleanout and reset". Builder quotes sent before the
  2026-10-18 Labor rules and not yet approved are held from the customer until the office saves and sends them again
  (`node scripts/stale-builder-quotes.mjs` lists them).
- **Install times for storage goods.** *Open:* the app times shelving units (1 hour each) and totes, nothing else yet.
  Until install times are set for racks, cabinets, hooks and tracks, a quote with them waits for the estimator to set
  the man-hours by hand. *Recommended:* give install times per product (or per group) so the estimate covers them.
- **Labor on the commission base.** The Labor line is part of the job total, so the setter's 13% and the
  estimator's 7% (both on the whole price) include it. *Recommended: keep*, since it is the price the customer pays.
- **Goods markup.** *Recommended:* keep the default until your pricing workbook is approved.
- **Minimum charge and deposit for builder quotes.** No minimum is applied today, and builder quotes use the standard
  new-quote deposit rule. *Recommended:* choose the minimum before turning on the builder.
- **Bought or kept in stock.** Shelving and storage products are treated as bought for each job. *Recommended:
  keep*; mark only items you truly stock as stock.
- **Door-to-door tags in HighLevel.** *Recommended:* leave `EGC_GHL_D2D_TAGS` off until you want a workflow on them.
- **HighLevel forms into the Hub.** A HighLevel form does not become a Hub walkthrough request yet; it needs new
  HighLevel access. *Recommended:* leave for later; it is not needed for this go-live.

## Known limitations

- **Distances** in Near me are straight-line ("about 2 mi"), not driving distance. The map does not draw area outlines;
  reps claim areas from the Choose area list.
- **Crew changes do not flow to booked jobs.** Changing a crew's members later does not update jobs already booked to
  that crew. Someone on two crews makes those crews block each other.
- **The automatic pick does not look at crew size.** A 2-person job can get a 3-person crew and the other way round.
- **No free crew** means the job waits as **Sold: needs crew** for the office.
- **Team leads** see every crew's jobs, but not estimators' walkthroughs, and can open only the jobs they are on.
- **A refused clock-in** can only be retried from the job page in Today's work.
- **Held jobs** (unapproved prices): approving their prices releases them, up to 25 per save. A job priced the old
  way, outside the builder, is released only when it is rebuilt in the builder and signed again, or by an owner
  release, which has no button yet (ask your developer).
- **Purchase list:** a crew's **Loaded** tick shows after Refresh, and **Mark all** saves job by job.
- **Labor man-hours** are filled in from the app's estimate when the quote is built. The crew size does not change
  them. If the walkthrough's fullness changes afterwards, a saved quote keeps its man-hours and shows the new estimate
  next to them; the estimator presses **Reset to estimate** (or adjusts them). The signed job records the estimate for
  the signed walkthrough. Adjusted man-hours change the price, not the booked time: Dispatch books the time estimate.
- **HighLevel mirror:** a returning customer whose earlier deals are all won or lost waits for a person. Open a deal
  for the new job in HighLevel, then press **Retry** on Integrations. A burst of edits makes one note per edit, the
  older ones marked "(since changed)".
- **HighLevel contacts in dry run:** while messaging is in dry run, the mirror never creates a HighLevel contact. A
  brand-new door-to-door customer's update waits (about 4 hours, then shows as stuck) until their contact is linked,
  for example by the Hub's normal booking sync. Then press **Retry**.
- **No job booking tags without a jobs calendar.** The old HighLevel jobs calendar was deleted, so job bookings get no
  `egc-job-scheduled` or reminder tag. HighLevel reminder workflows that wait for those tags do not run for jobs.
- **If HighLevel refuses the "Door to door" source** on a new deal, the deal is still created, just without it.
- **Commission:** a sale made offline under old terms but synced after you change the terms gets no terms and stays
  held; sales booked before your first approval stay held; an installment plan is held until the last payment.
- **Door-to-door panel:** "walkthroughs set" counts by the day the job reached the Hub, and planned shifts are not
  shown, only shifts that happened. Estimators' open time there is a suggestion; the Hub checks every booking.
- **Door-to-door bridge:** a walkthrough whose customer cannot be matched safely waits in Knock Admin → Sales instead
  of Dispatch. Reinstating a sale whose Hub job someone cancelled by hand in Dispatch does not restore that job.
- **Profiles:** the manager **Edit profile** form does not change shirt size, birthday or HighLevel user ID; use Team
  directory. The crew app has no link to the Team directory yet.
