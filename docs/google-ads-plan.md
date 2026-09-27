# Google Ads plan: profitable junk removal leads (NoCo)

Prepared September 27, 2026. Based on:
1. A live audit of Google Ads account `699-991-7719` through the NotFair Google
   Ads MCP.
2. The GA4 property behind `G-CV7HJ2QGHX`.
3. Keyword Planner data for Fort Collins, Loveland, Windsor, Wellington and
   Larimer County.
4. Research into how profitable junk-removal operators and agencies run
   Google Ads.

Sources are listed at the bottom. Industry numbers come mostly from agencies
and are labeled as such.

---

## 1. What to do, in order

1. **Fix tracking before spending another dollar** (section 5). Right now,
   Google can't see phone calls from the website, every conversion is worth $1,
   and booked jobs never get back to Google. Smart bidding optimizes toward
   whatever you feed it, and today that's form fills.
2. **Apply for Local Services Ads (LSA) this week.** Junk removal is an
   eligible category. LSA charges per lead (about $48–60 per lead for junk
   removal as of Sep 2026), and those leads close at 60–70% when answered
   fast. Verification takes weeks, so start now so it's live by March.
3. **Rebuild one tight Search campaign** from the existing "Core" campaign
   (section 4): exact and phrase match only, Presence-only geo, no Display,
   no Search Partners, no AI Max, and hours limited to when someone answers
   the phone.
4. **Delete the Performance Max campaign and don't run PMax again** until
   Search is profitable and booked-job conversions are flowing back to Google.
5. **Launch at $50/day in October** with a seasonal hook ("Park inside before
   the first snow"). Scale budget with the seasonal index in section 8, but
   don't go dark in winter: clicks get cheaper when competitors pause.
6. **Judge the channel on cost per booked job, not cost per click,** and give
   it 90 days before a final verdict. Section 8 has the checkpoints.

---

## 2. What your account data says

Account `699-991-7719` (America/Denver, auto-tagging on, billing approved).
All 4 campaigns are paused. Lifetime spend is $512 with 2 tracked conversions,
both web forms.

| Campaign | Type | Spend | Clicks | Conv. | What went wrong |
|---|---|---|---|---|---|
| Fort Collins Garage Cleaning | Performance Max | $106 | 397 | 0 | 389 of 397 clicks came from Display/YouTube at about $0.14 each. That's junk traffic. |
| Core: Junk Removal & Cleanouts | Search | $263 | 37 | 1 | Settings were right (Presence, no Display). It only ran about 6 days, so there's too little data to judge. |
| Conquest: Big Chains | Search | $142 | 46 | 1 | **Display was ON** ($40 wasted). **Presence-or-interest** geo meant $105 of the $142 (74%) went to people outside the service area. |
| Garage Cleaning: Fort Collins | Search | $1 | 1 | 0 | Display ON and Presence-or-interest (same problems). |

**Bottom line: Google Search has never actually been tested.** About $250 of
the $512 went to settings mistakes. The clean test was 6 days of the Core
campaign.

Other findings:

- **Impression share:** on the days Core ran, it got 59–67% impression
  share. It lost the rest to Ad Rank (bids and quality), not budget. Average
  CPC was about $7.10, which is at the low end of the $6–12 junk-removal
  range.
- **Search-term leaks:** a lot of the traffic was people looking for
  **municipal trash service**: "republic trash fort collins", "ram waste",
  "waste management fort collins", "gallegos trash", "trash service fort
  collins", "fort collins yard waste pickup". Also dumpster searches ("bin
  there dump that") and DIY searches ("where to drop off mattress"). Section 6
  covers the negatives.
- **One existing negative is blocking buyers.** "EGC Core Negatives" contains
  the phrase negative **`free`**, which blocks every search containing
  "free", including "junk removal free estimate" and "free quote". Replace it
  with specific phrases (section 6).
- **Search demand is small, and it's for junk removal, not garage
  transformations.** Keyword Planner monthly searches in NoCo:
  "junk removal fort collins" 390, "junk removal near me" 170,
  "junk removal" 140, "junk removal services" 50. By contrast,
  "garage cleanout" gets about 10, "garage cleaning service" about 10, and
  "garage organization company" about 10. Takeaway: Google Search is how you
  capture junk-removal demand. Garage transformations get sold as an upsell
  on-site or through Meta and other demand-creation channels. Don't expect
  Google to sell a $2,000 garage makeover off a search.
- **Phone numbers:** the Google Ads call asset and `/ads` use
  **(970) 658-9454**, while the service pages where Google traffic lands use
  **(970) 999-1818**. Calls to 999-1818 from ad clicks are invisible to Google
  Ads.
- **Conversion setup:** the primary conversions are GA4 `generate_lead` and
  "Calls from ads", all valued at the $1 default. There's no website-call
  conversion and no offline (booked-job) import, even though
  `functions/api/web-lead.js` already captures `gclid` into HighLevel.
- **GA4, Apr–Sep:** Paid Search sent 59 sessions and 6 key events. Organic
  sent 289 sessions and 21. The site converts, but the volume is small.

---

## 3. The math that decides profitability

The formula: **cost per booked job = CPC ÷ (click→lead rate × lead→booked rate)**.

Using your pricing (single item $99–150, partial $250–400, standard garage
$400–650, full $650+), assume a blended ticket of about **$375** and about
**55% gross margin** after dump fees, labor and fuel. That's about **$205 gross
profit per job**, which is the most you can pay per job just to break even on
the first visit.

Same budget ($45/day = $1,350/mo at an $8 CPC = about 169 clicks), three
different operators:

| Click→lead | Lead→booked | Leads | Jobs | Revenue | Cost/job | Profit after ads |
|---|---|---|---|---|---|---|
| 6% (no call tracking, slow callbacks) | 35% | 10 | 3.5 | $1,329 | **$381** | **−$619** |
| 10% (decent) | 50% | 17 | 8.4 | $3,164 | $160 | +$390 |
| 15% (fast answer, strong page) | 65% | 25 | 16.5 | $6,170 | **$82** | **+$2,043** |

**The ads are the same in all three rows. What changes is how fast you answer
and how well the page converts.** The difference between "Google Ads doesn't
work for junk removal" and a profitable account is about 4.5x on cost per job,
and nearly all of it happens after the click.

**The third row is realistic, not a best case.** An agency dataset of 29
junk-removal accounts (Jan 2024–Aug 2026) shows 17.7–21.1% click→lead by
service, with $36–58 cost per lead. Phone leads that get answered book at
50–65%. Operators who lose money are usually missing calls. Home-service
businesses miss about 27% of calls, and 85% of callers who don't get through
never call back.

So the order is: phones and speed-to-lead first, landing page second, and
only then more budget.

**Targets:**
- Cost per lead ≤ $60 (agencies report new accounts start at $60–80 and
  settle at $35–50 within about 90 days).
- Cost per booked job ≤ $110 (about 30% of ticket).
- Revenue ROAS ≥ 3x by day 90 and ≥ 5x by day 180, once booked-job imports
  let Google optimize for jobs.

Garage cleanouts ($400–$3,500) can carry $150–250 per booked job and still
clear 5x or more, so they can bid higher than single-item pickups.

**Demand ceiling:** at full impression share in peak season, the realistic
maximum is about 300–400 relevant clicks a month across NoCo, which is about
$2.5–3.2k/mo of useful Search spend. Past that point, more budget buys
irrelevant clicks. To grow further you add geography (Greeley, Berthoud,
Johnstown) or add LSA and Meta, not bigger Search bids.

---

## 4. Campaign blueprint

### 4a. Local Services Ads (apply now)

- **Apply** at ads.google.com/local-services-ads under **Junk removal**.
  You'll need the background check, business registration, and proof of
  insurance.
- **Badge:** since October 2025 the badge is "Google Verified" (it replaced
  Google Guaranteed/Screened).
- **Service area:** Fort Collins, Loveland, Windsor, Wellington, Timnath,
  Severance, LaPorte, Berthoud. Job types: every junk and cleanout type you
  actually do, **and nothing you don't**.
- **Credits:** manual disputes were replaced in 2024 by automatic crediting.
  Leads for job types or areas you listed are no longer credited, so a
  loosely set profile means paying for bad leads. Use "Rate this lead" on
  every lead so the system learns.
- **Ranking:** depends on **review count and rating, responsiveness (answer
  rate), open hours, and proximity**.
  - Aim for 20+ Google reviews at 4.5+ stars, adding 2–5 a month. Ask at
    every job.
  - Set LSA hours to when you actually pick up. Missed calls lower your
    ranking.
- **Budget:** at about $48–60 per lead with 60–70% close, expect about
  $75–95 per booked job, cheaper than Search. Start with a budget for 5–8
  leads a week.
- **Heads-up:** Google is folding LSA into Google Ads as Performance Max with
  pay-per-lead goals. Service-area businesses are scheduled for late 2026,
  with remaining categories in 2027. Historical LSA reports won't carry over,
  so export your lead history monthly once you're live.

### 4b. Search: "Junk Removal NoCo" (rebuild of "Core")

**Settings:**
- Networks: Google Search only. Search Partners OFF, Display OFF, AI Max OFF.
- Locations: Fort Collins, Loveland, Windsor, Wellington, Timnath, Severance,
  LaPorte, Berthoud (city targets, not all of Larimer County, which pulls in
  Estes Park and Red Feather). **Presence: people in or regularly in your
  targeted locations.**
- Schedule: Mon–Sat 7:00–19:00 MT, matching your HighLevel in-hours window.
  Search peaks are 7–10am and 4–7pm. Only run Sunday or evenings if someone
  will answer within 5 minutes.
- Devices: all. Most of the spend will be mobile, which is normal for this
  category.
- Budget: $50/day to start.
- Bidding, step by step:
  1. **Weeks 1–3:** Maximize Clicks with a **$12 max CPC cap**, or Manual CPC
     at $8–11 on exact match.
  2. **Once you have 15 or more conversions in 30 days:** Maximize
     Conversions.
  3. **Once you have 30 or more in 30 days, with booked-job imports
     flowing:** Target CPA at about 1.2x the actual CPA.
  4. **Later:** Maximize Conversion Value when job values are imported.

**Ad groups.** Use exact + phrase match, and point each group at the matching
page that already exists on the site. Item-specific groups tend to earn the
cheapest clicks. One case study bid only on the object being removed (hot tub,
shed) at $20/day and a $5.29 CPC, and booked $1,100–2,000 jobs.

| Ad group | Keywords (exact + phrase) | Final URL |
|---|---|---|
| Junk Removal (core) | junk removal fort collins, junk removal near me, junk removal, junk removal services, junk removal company, junk hauling fort collins, junk haulers near me, junk pickup near me, junk removal loveland / windsor / wellington / timnath | /junk-removal-fort-collins-co (city pages for city terms) |
| Same-Day | same day junk removal, junk removal today, junk removal open now | /same-day-junk-removal-fort-collins-co |
| Furniture / Couch / Mattress | furniture removal (near me / fort collins), couch removal, sofa removal, mattress removal, mattress pickup, mattress disposal near me | /furniture-removal-…, /couch-removal-…, /mattress-removal-… |
| Appliances / Hot Tub / Shed | appliance removal, refrigerator removal, fridge disposal near me, washer dryer removal, hot tub removal, spa removal, shed removal, playset removal | /appliance-removal-…, /refrigerator-removal-…, /hot-tub-removal-…, /shed-cleanout-… |
| Garage Cleanout | garage cleanout, garage junk removal, garage clean out service, garage cleaning service | /garage-cleanouts-fort-collins-co |
| Estate / House Cleanout | estate cleanout, house cleanout, property cleanout, hoarder cleanout, basement cleanout, storage unit cleanout | /property-cleanout-fort-collins-co, /estate-cleanout-fort-collins |

**Ads.** Write one responsive search ad per group with 15 headlines and 4
descriptions. Pin headline 1 to "{Service} Fort Collins". Rotate these angles:
- Price anchor: "Single Items From $99", "Most Garages $400–$650",
  "Flat Rate — No Hourly Billing". Make sure these match the site: the old ads
  said "$139 up to 4 cu yd" while `/pricing` says $99–150. Local low-price
  anchors exist (LoadUp "from $60", Dropcurb "$79 first item"), so lead with
  the flat rate and the full-service value, not the lowest price.
- Speed: "Same-Day & Next-Day Pickup", "Text a Photo, Get a Price in 5 Min".
- Local trust: "Local & Family-Run, Not a Franchise", "Licensed & Insured",
  "{N} 5-Star Google Reviews".
- Seasonal (Oct–Nov): "Park Inside Before the First Snow".

**Assets:**
- Call asset: must use the **same tracked number** as the landing pages.
  Don't use call-only ads; Google has stopped allowing new ones (Feb 2026) and
  existing ones stop serving in Feb 2027.
- Sitelinks: Pricing, What We Take, Book Online, Before & After.
- Callouts: Flat Rate, Same-Day, We Donate & Recycle, Swept Clean.
- Structured snippet (Services): Furniture, Appliances, Hot Tubs, Garage
  Cleanouts, Estate Cleanouts.
- Price asset: your 4 tiers.
- Image assets: real before/after photos.
- Location asset: skip it, or make sure "Get directions" and store visits are
  **not** primary conversions. For a service-area business they inflate
  conversions without being leads.

### 4c. Competitor campaign ("Conquest"): hold

It's not a bad idea: price-shoppers searching "how much does 1-800-GOT-JUNK
cost" are real buyers. But it was misconfigured, and one conversion proves
nothing. Relaunch at **$10/day** only after Core hits its targets, with
Presence-only and Display off. Never put a competitor's trademark in ad text.
While it's paused, add competitor brand names as negatives in Core so those
searches don't leak into generic ad groups.

### 4d. What not to run

- **Performance Max:** your own data shows 97% of its clicks came from
  Display/YouTube. Without booked-job conversions, PMax "fills your CRM with
  spam", and negative keywords don't apply to its Display/YouTube inventory.
- **Display, Search Partners, broad match, AI Max:** not until you have
  offline conversion data. Each one widens reach, and with no signal to steer
  by, that reach goes to junk traffic. Google also treats dumpster searches as
  junk removal under broad match.
- **Garage-transformation keywords as a main product:** there are about 30
  searches a month combined. Sell transformations on-site and on Meta.

---

## 5. Tracking: must be in place before launch

1. **One customer phone number per traffic source, tracked.** Use a Google
   forwarding number on the landing pages ("Calls from website" conversion via
   the gtag phone snippet, counted at **≥ 60 seconds**, the same threshold as
   call assets) *or* a HighLevel number pool with dynamic number insertion.
   Either way, a Google Ads visitor who calls from a service page has to be
   counted. Put that same number on the Google Ads call asset.
2. **Conversion actions:**
   - **Primary:** Calls from ads ≥ 60s, Calls from website ≥ 60s, and
     `generate_lead` (web form). Give each a value of about $100, roughly
     expected revenue × close rate, instead of $1.
   - **Secondary** (observe only): `form_submit`, `sms_click`, `phone_call`
     clicks, and any directions or store-visit actions.
3. **Booked-job offline conversions.** The `gclid` already lands in HighLevel.
   Add an import:
   - Trigger: a HighLevel opportunity moves to Won / Job Completed (or a
     Jobber job/invoice is completed).
   - Action: send a Google Ads **"Booked Job"** offline conversion with the
     `gclid` and the **actual invoice value**. Use the HighLevel Google Ads
     workflow action or a Zapier "Google Ads: Send Offline Conversion" step.
   - What to expect: 2–3 weeks of steady uploads before bidding shifts, and
     6–8 weeks before reports clearly show the change.
   - Once 15 or more come in a month, make "Booked Job" the primary goal. Cost
     per lead often rises 20–40% after this switch while cost per booked job
     falls. That's the goal.
4. **Turn on Enhanced Conversions for Leads.** It's a single account-level
   setting (since April 2026) and uses the hashed phone and email the quote
   form already collects.
5. Rename GA4 property "test 1" so imported conversion names are readable.

---

## 6. Negative keywords

Keep the existing lists ("EGC Core Negatives", "Junk & Service Waste
Blockers"), with one fix, then add the terms below. All are phrase match
unless noted.

**Fix first.** Remove the phrase negative `free` from "EGC Core Negatives"
(it blocks "free estimate" and "free quote"). Replace it with: free junk
removal, free pickup, free furniture pickup, free scrap pickup, free
appliance pickup, free mattress pickup, free dump. "for free", "free drop
off" and "free dump" are already on the other list.

**Municipal trash service** (your biggest observed leak): trash service, trash
pickup, trash collection, trash company, trash companies, garbage service,
garbage pickup, garbage pick up, garbage collection, recycling pickup,
recycle pickup, curbside, yard waste pickup, bulk trash pickup, bulk trash
day, large item pickup, republic, republic services, ram waste, waste
management, gallegos, windsor disposal, waste connections, trash schedule,
pickup schedule.

**Local dump and landfill:** larimer county landfill, trilby, transfer station
(already listed), timberline recycling, hazardous waste facility. Larimer
County's new Central Transfer Station on W. Trilby Rd opened August 2026 and
will drive "dump" searches.

**Dumpster and roll-off:** bin there dump that, roll off, rolloff, bagster,
bin rental. "dumpster" and "rent a dumpster" are already on the lists.

**DIY and disposal-site intent:** where to, where can i, drop off, drop-off,
dump near me, dump hours, dump fees, household hazardous, hazardous waste,
paint disposal, tire disposal, battery disposal, electronics recycling,
e-waste, yourself, reddit, youtube.

**Other meanings of "junk":** junk mail, junk email, spam, junk food, junk
drawer, junk journal, junk jewelry, junk art, junk in the trunk.

**Jobs and business intent:** business, franchise, start a, starting a,
contracts, insurance, software, marketing, llc, equipment, trailer, truck for
sale, u-haul, jobs near me, indeed, employment.

**Vehicles and scrap:** junk car, junk cars, car removal, cash for, we buy,
sell my, scrap, scrap metal, scrap yard, salvage, junkyard, towing, pick n
pull.

**Unrelated services:** move out cleaning, house cleaning, maid, carpet,
pressure washing, gutter, asbestos, biohazard, crime scene, mold, moving
company.

**Out of area:** denver, aurora, boulder, longmont, colorado springs,
cheyenne, greeley. Remove "greeley" if you start serving it.

**Competitor brands** (Core only, while Conquest is paused): got junk,
gotjunk, 1800, junk king, college hunks, junkluggers, loadup, dropcurb.

**Do not negate:**
- "disposal": "refrigerator disposal near me" produced one of your only
  conversions.
- "cheap", "cost", "price": price-shoppers are often small, real jobs. Watch
  them in the search terms report instead.

**Process:** review search terms weekly for the first 2 months, and negate
any irrelevant term that appears twice.

---

## 7. Landing page and speed-to-lead

- **Above the fold on every ad landing page:**
  - a click-to-call button with the tracked number,
  - a price range ("single items from $99"), since hiding price is the
    biggest conversion killer in this category,
  - "Text a photo for a price",
  - review stars and count,
  - same-day availability.
- **Page speed:** analytics already loads after interaction, which is good.
  Keep mobile load under 3 seconds; 53% of mobile users leave slower pages.
- **Speed-to-lead:**
  - Answer live during ad hours.
  - Set up missed-call text-back in OpenPhone/Quo or HighLevel immediately.
  - The HighLevel instant-text relay for web leads already exists; confirm it
    fires within 60 seconds. The chance of reaching a lead drops about 100x
    between a 5-minute and a 30-minute response.
  - Every unanswered ad call costs about $55–90 in media alone.
- **Close more on-site:** every junk-removal job is a chance to pitch the
  garage transformation. Track the upsell rate. It's where Google's cost per
  job gets paid back several times over.

---

## 8. Rollout, budget, and checkpoints

| When | Search budget | Actions |
|---|---|---|
| Now → Oct 5 | $0 | Tracking fixes (section 5), phone-number unification, LSA application, negatives, rebuild Core, delete PMax. |
| Oct 6 → Nov 2 | $50/day | Launch. Review search terms **daily** for 2 weeks, then twice a week. "Before the first snow" ads. |
| Nov 3 → Dec 31 | $45/day | Switch to Maximize Conversions once ≥15 conv. Pause ad groups with ≥$150 spend and 0 leads. Test Conquest at $10/day if Core is on target. Push furniture and move-out angles. |
| Jan → Feb | $35/day | Slowest months, but keep running: clicks are cheaper when competitors pause. Estate cleanouts are strong now. Lean on LSA, gather reviews, get booked-job import live. |
| Mar | $45/day | Ramp up from mid-March. |
| Apr → Aug | $60–90/day | Peak season. Scale to the demand ceiling. Plan for spikes at CSU move-out (mid-May) and Aug 1 lease turnover (furniture, mattresses). Target CPA once ≥30 conv/mo. |

**Checkpoint 1: after $1,000 of Search spend (about 125 clicks).** If you have
fewer than 8 leads (cost per lead above $125), pause and diagnose in this
order: search terms → phone answer rate → landing page. Don't add budget.

**Checkpoint 2: day 90.** Make the real call on cost per booked job.
- Keep going if it's ≤ $110 and revenue ROAS is ≥ 3x.
- If not, cut Search back to the item-specific ad groups that booked jobs,
  and move the rest of the budget to LSA.

**Scale rule:** if cost per booked job stays ≤ $110 for 2 consecutive weeks
**and** you're losing more than 20% impression share to budget, raise the
budget 20% a week until the demand ceiling. One operator reported that just
showing up full-time (instead of 50% of the time) landed their biggest job.

**Guardrail:** set a monthly spend cap in the NotFair guardrails so the
automation can't run past the plan.

---

## 9. Weekly operating rhythm (runnable through the NotFair MCP)

Each week:
1. Pull search terms, add negatives, and promote converting terms to exact
   match.
2. Report spend, clicks, CPC, conversions, and cost per lead **per ad group**,
   plus impression share lost to budget vs. rank.
3. Compare Google-reported leads against HighLevel leads carrying a `gclid` to
   catch tracking drift.
4. Monthly: cost per booked job and ROAS from the booked-job import, against
   the targets in section 3.

---

## 10. Account changes staged for approval (via MCP)

These are ready to run through the NotFair MCP. Nothing has been changed yet.

1. In "EGC Core Negatives", replace the phrase negative `free` with the
   specific free phrases.
2. Add the section 6 negatives to "Junk & Service Waste Blockers". Link that
   list to all Search campaigns.
3. Conquest and Garage Cleaning campaigns: Display OFF, geo → PRESENCE.
4. Core: add ad schedule Mon–Sat 07–19 and switch bidding to Maximize Clicks
   with a $12 cap.
5. Merge "Garage Cleaning: Fort Collins" into Core as the Garage Cleanout ad
   group. Add the item-specific ad groups and new responsive search ads from
   section 4b.
6. Remove the Performance Max campaign.
7. Set the guardrail monthly cap to $1,600.
8. Re-enable Core at $50/day (**only after** the section 5 tracking is live).

---

## 11. Assumptions to confirm

The model in section 3 uses these. Correct any that are off and the targets
get recalculated:
- Average ticket from Google leads: about $375.
- Gross margin: about 55%.
- Lead→booked rate: 50%.
- Someone answers the phone Mon–Sat 7–7.
- (970) 658-9454 is the intended ads tracking line; (970) 999-1818 is the
  main line.
- No existing LSA profile.
- Current Google review count: unknown (it drives both LSA rank and ad copy).

---

## Sources

Account, GA4 and Keyword Planner figures come directly from the connected
accounts. The external sources below were read through search-result
summaries; confirm any number before quoting it to a third party.

- 99 Calls: junk removal ad costs (29 accounts, CPC, click→lead, CPL) —
  https://99calls.com/blog/junk-removal-ads-lead-costs
- 99 Calls: LSA junk removal cost per lead —
  https://99calls.com/LSA-Cost-Estimator/junk-removal-contractor ·
  https://99calls.com/blog/lsa-cost-per-lead-by-industry
- LocaliQ: home services search benchmarks 2025 —
  https://localiq.com/blog/home-services-search-advertising-benchmarks/
- WordStream: Google Ads benchmarks 2025 —
  https://www.wordstream.com/blog/2025-google-ads-benchmarks
- Search Engine Land: LSA vs Search ads leads —
  https://searchengineland.com/google-local-services-ads-vs-search-ads-leads-464015
- PushLeads: junk removal Google Ads —
  https://pushleads.com/junk-removal-marketing/junk-removal-google-ads/
- CurbWaste: Google Ads for junk removal —
  https://www.curbwaste.com/blog/google-ads-for-junk-removal-and-dumpster-rental
- Clicks Geek: Google Ads for junk removal —
  https://clicksgeek.com/google-ads-for-junk-removal/
- AdsByJosh: Google Ads for junk removal —
  https://www.adsbyjosh.net/google-ads-for-junk-removal
- JunkRemovalMktg: reducing cost per conversion —
  https://junkremovalmktg.com/reduce-google-ads-cost-per-conversion/
- Momentum: junk removal lead-gen case study —
  https://www.needmomentum.com/marketing-case-studies/junk-removal-lead-generation/
- Junk Removal Authority: $300k Google Ads mistake —
  https://junkremovalauthority.com/video/our-300000-mistake-on-running-a-junk-removal-adwords-campaign-and-how-you-can-avoid-it/
- Junk Removal Authority: annual cycle —
  https://junkremovalauthority.com/the-annual-cycle-for-junk-removal-businesses/
- PPC Land: call-only ads deprecation —
  https://ppc.land/google-ends-call-ads-in-february-2026-shifts-advertisers-to-rsa-format/
- Google Ads Help: LSA moving into Google Ads —
  https://support.google.com/google-ads/answer/17213585
- Search Engine Journal: LSA into Google Ads —
  https://www.searchenginejournal.com/google-is-bringing-local-services-ads-into-google-ads/582816/
- Blue Corona: LSA dispute deprecation —
  https://www.bluecorona.com/blog/google-local-service-ads-lead-dispute-deprecation
- FreeAgency: Google Verified badge —
  https://freeagency.ai/lsa-update-google-verified-badge/
- Google Ads Help: enhanced conversions for leads —
  https://support.google.com/google-ads/answer/15713840
- Search Engine Land: PMax negative keyword limits —
  https://searchengineland.com/google-ads-expands-negative-keyword-limits-pmax-453154
- CallForce: cost of missed calls —
  https://callforce.global/blog/cost-of-missed-calls-and-slow-lead-response-2026/
- Estes Valley Voice: Larimer County transfer station —
  https://estesvalleyvoice.com/2026/08/08/larimer-county-opens-new-transfer-station-landfill/
