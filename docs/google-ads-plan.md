# Google Ads plan: profitable junk removal leads (NoCo)

Prepared September 27, 2026. Based on (1) a live audit of Google Ads account
`699-991-7719` through the NotFair Google Ads MCP, (2) the GA4 property behind
`G-CV7HJ2QGHX`, (3) Keyword Planner data for Fort Collins, Loveland, Windsor,
Wellington and Larimer County, and (4) research into how profitable junk-removal
operators run Google Ads. Sources are listed at the bottom.

---

## 1. What to do, in order

1. **Fix tracking before spending another dollar** (section 5). Right now,
   Google can't see phone calls from the website, every conversion is worth $1,
   and booked jobs never get back to Google. Smart bidding optimizes toward
   whatever you feed it, and today that's form fills.
2. **Apply for Local Services Ads (LSA) this week.** Junk removal is an LSA
   category. With LSA you pay per lead, not per click, and the ads sit above
   the Search ads. Verification takes weeks, so start now so it's live by
   March.
3. **Rebuild one tight Search campaign** from the existing "Core" campaign
   (section 4): exact and phrase match only, Presence-only geo, no Display,
   no Search Partners, no AI Max, and hours limited to when someone answers
   the phone.
4. **Delete the Performance Max campaign and don't run PMax again** until
   Search is profitable and offline conversions are flowing.
5. **Launch at $45/day in October** with a seasonal hook ("Park inside before
   the first snow"), cut to about $25/day for mid-December through February,
   and scale in March when demand peaks.
6. **Judge the channel on cost per booked job, not cost per click.** Use the
   kill and scale rules in section 8.

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
  CPC was about $7.10.
- **Search-term leaks:** a lot of the traffic was people looking for
  **municipal trash service**: "republic trash fort collins", "ram waste",
  "waste management fort collins", "gallegos trash", "trash service fort
  collins", "fort collins yard waste pickup". Also dumpster searches ("bin
  there dump that") and DIY searches ("where to drop off mattress"). Section 6
  covers the negatives.
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
and nearly all of it happens after the click. So the order is: phones and
speed-to-lead first, landing page second, and only then more budget.

**Targets:** cost per lead ≤ $60, cost per booked job ≤ $110 (about 30% of
ticket), and revenue ROAS ≥ 4x in the first 90 days, moving toward 6x or more
once offline conversions let Google optimize for booked jobs.

**Demand ceiling:** at full impression share in peak season, the realistic
maximum is about 300–400 relevant clicks a month across NoCo, which is about
$2.5–3.2k/mo of useful Search spend. Past that point, more budget buys
irrelevant clicks. To grow further you add geography (Greeley, Berthoud,
Johnstown) or add LSA and Meta, not bigger Search bids.

---

## 4. Campaign blueprint

### 4a. Local Services Ads (apply now)

- Apply at ads.google.com/local-services-ads under the **Junk removal**
  category. You'll need the background check, business registration, and
  proof of insurance.
- Service area: Fort Collins, Loveland, Windsor, Wellington, Timnath,
  Severance, LaPorte, Berthoud. Job types: every junk and cleanout type you
  actually do.
- LSA ranking depends on **review count and rating, responsiveness (answer
  rate), hours, and proximity**. Set LSA hours to the hours you actually pick
  up, and answer every LSA call live, because missed calls hurt your ranking.
- **Dispute every invalid lead** (wrong service, spam, outside the area)
  within the dispute window. Credits are real money.
- Set the budget in LSA to roughly 5–8 leads a week to start.

### 4b. Search: "Junk Removal NoCo" (rebuild of "Core")

**Settings:**
- Networks: Google Search only. Search Partners OFF, Display OFF, AI Max OFF.
- Locations: Fort Collins, Loveland, Windsor, Wellington, Timnath, Severance,
  LaPorte, Berthoud (city targets, not all of Larimer County, which pulls in
  Estes Park and Red Feather). **Presence: people in or regularly in your
  targeted locations.**
- Schedule: Mon–Sat 7:00–19:00 MT, matching your HighLevel in-hours window.
  Only run Sunday or evenings if someone will answer within 5 minutes.
- Devices: all. Most of the spend will be mobile, which is normal for this
  category.
- Budget: $45/day to start.
- Bidding, step by step:
  1. **Weeks 1–3:** Maximize Clicks with a **$12 max CPC cap**, or Manual CPC
     at $8–11 on exact match.
  2. **Once you have 15 or more conversions in 30 days:** Maximize
     Conversions.
  3. **Once you have 30 or more in 30 days, with booked-job imports
     flowing:** Target CPA at about 1.2x the actual CPA.
  4. **Later:** Maximize Conversion Value when job values are imported.

**Ad groups.** Use exact + phrase match, and point each group at the matching
page that already exists on the site:

| Ad group | Keywords (exact + phrase) | Final URL |
|---|---|---|
| Junk Removal (core) | junk removal fort collins, junk removal near me, junk removal, junk removal services, junk removal company, junk hauling fort collins, junk haulers near me, junk pickup near me, junk removal loveland / windsor / wellington / timnath | /junk-removal-fort-collins-co (city pages for city terms) |
| Same-Day | same day junk removal, junk removal today, junk removal open now | /same-day-junk-removal-fort-collins-co |
| Furniture / Couch / Mattress | furniture removal (near me / fort collins), couch removal, sofa removal, mattress removal, mattress pickup, mattress disposal near me | /furniture-removal-…, /couch-removal-…, /mattress-removal-… |
| Appliances / Hot Tub | appliance removal, refrigerator removal, fridge disposal near me, washer dryer removal, hot tub removal, spa removal | /appliance-removal-…, /refrigerator-removal-…, /hot-tub-removal-… |
| Garage Cleanout | garage cleanout, garage junk removal, garage clean out service, garage cleaning service | /garage-cleanouts-fort-collins-co |
| Estate / House Cleanout | estate cleanout, house cleanout, property cleanout, hoarder cleanout, basement cleanout, storage unit cleanout | /property-cleanout-fort-collins-co, /estate-cleanout-fort-collins |

**Ads.** Write one RSA per group with 15 headlines and 4 descriptions. Pin
headline 1 to "{Service} Fort Collins". Rotate these angles:
- Price anchor: "Single Items From $99", "Most Garages $400–$650",
  "Flat Rate — No Hourly Billing". Make sure these match the site: the old ads
  said "$139 up to 4 cu yd" while `/pricing` says $99–150.
- Speed: "Same-Day & Next-Day Pickup", "Text a Photo, Get a Price in 5 Min".
- Local trust: "Local & Family-Run, Not a Franchise", "Licensed & Insured",
  "{N} 5-Star Google Reviews".
- Seasonal (Oct–Nov): "Park Inside Before the First Snow".

**Assets:**
- Call asset: must use the **same tracked number** as the landing pages.
- Sitelinks: Pricing, What We Take, Book Online, Before & After.
- Callouts: Flat Rate, Same-Day, We Donate & Recycle, Swept Clean.
- Structured snippet (Services): Furniture, Appliances, Hot Tubs, Garage
  Cleanouts, Estate Cleanouts.
- Price asset: your 4 tiers.
- Location asset: link your Google Business Profile.
- Image assets: real before/after photos.

### 4c. Competitor campaign ("Conquest"): hold

It's not a bad idea: price-shoppers searching "how much does 1-800-GOT-JUNK
cost" are real buyers. But it was misconfigured, and one conversion proves
nothing. Relaunch at **$10/day** only after Core hits its targets, with
Presence-only and Display off. Never put a competitor's trademark in ad text.

### 4d. What not to run

- **Performance Max:** your own data shows 97% of its clicks came from
  Display/YouTube. PMax needs 30 or more real conversions a month and
  booked-job values to work, and you have neither.
- **Display, Search Partners, broad match, AI Max:** not until you have
  offline conversion data. Each one widens reach, and with no signal to steer
  by, that reach goes to junk traffic.
- **Garage-transformation keywords as a main product:** there are about 30
  searches a month combined. Sell transformations on-site and on Meta.

---

## 5. Tracking: must be in place before launch

1. **One customer phone number per traffic source, tracked.** Use a Google
   forwarding number on the landing pages ("Calls from website" conversion via
   the gtag phone snippet, counted at **≥ 60 seconds**) *or* a HighLevel
   number pool with dynamic number insertion. Either way, a Google Ads visitor
   who calls from a service page has to be counted. Put that same number on
   the Google Ads call asset.
2. **Conversion actions:**
   - **Primary:** Calls from ads ≥ 60s, Calls from website ≥ 60s, and
     `generate_lead` (web form). Give each a value of about $100, roughly
     expected revenue × close rate, instead of $1.
   - **Secondary** (observe only): `form_submit`, `sms_click`, `phone_call`
     clicks.
3. **Booked-job offline conversions.** The `gclid` already lands in HighLevel.
   Add an import:
   - Trigger: a HighLevel opportunity moves to Won / Job Completed (or a
     Jobber job/invoice is completed).
   - Action: send a Google Ads **"Booked Job"** offline conversion with the
     `gclid` and the **actual invoice value**. Use the HighLevel Google Ads
     workflow action or a Zapier "Google Ads: Send Offline Conversion" step.
   - Once 15 or more come in a month, make "Booked Job" the primary goal.
     That's when Google starts bidding for jobs instead of form fills.
4. **Turn on Enhanced Conversions for Leads.** It uses the hashed phone and
   email the quote form already collects.
5. Rename GA4 property "test 1" so imported conversion names are readable.

---

## 6. Negative keywords

Keep the existing lists ("EGC Core Negatives", "Junk & Service Waste
Blockers"). Add the following, all phrase match unless noted.

**Municipal trash service** (your biggest observed leak): trash service, trash
pickup, trash collection, trash company, trash companies, garbage service,
garbage pickup, garbage pick up, garbage collection, recycling pickup,
recycle pickup, curbside, yard waste pickup, bulk trash pickup, republic,
republic services, ram waste, waste management, gallegos, windsor disposal,
waste connections, trash schedule, pickup schedule.

**Dumpster and roll-off:** bin there dump that, roll off, rolloff, bagster,
dumpster rental. "dumpster" and "rent a dumpster" are already on the lists.

**DIY and disposal-site intent:** where to, where can i, drop off, drop-off,
dump near me, dump hours, dump fees, transfer station, landfill, household
hazardous, hazardous waste, paint disposal, tire disposal, battery disposal,
electronics recycling, e-waste.

**Jobs and business intent:** business, franchise, start a, starting a,
contracts, insurance, software, equipment, trailer, truck for sale, jobs near
me, indeed.

**Vehicles and scrap:** junk car, junk cars, car removal, cash for, scrap,
scrap metal, salvage, junkyard, pick n pull, sell my.

**Unrelated cleaning:** move out cleaning, house cleaning, maid, carpet,
pressure washing, gutter.

**Donation-only intent:** donation pickup, habitat restore, arc thrift. Keep
this group only if you don't want donation searchers. Some are good leads.

**Do not negate "disposal".** "refrigerator disposal near me" produced one of
your only conversions.

---

## 7. Landing page and speed-to-lead

- **Above the fold on every ad landing page:** a click-to-call button with the
  tracked number, a price range, "Text a photo for a price", review
  stars/count, and same-day availability.
- **Page speed:** analytics already loads after interaction, which is good.
  Keep LCP under 2.5s on mobile.
- **Speed-to-lead:**
  - Answer live during ad hours.
  - Set up missed-call text-back in OpenPhone/Quo or HighLevel immediately.
  - The HighLevel instant-text relay for web leads already exists; confirm it
    fires within 60 seconds.
  - Every unanswered ad call costs about $55–90 in media alone.
- **Close more on-site:** every junk-removal job is a chance to pitch the
  garage transformation. Track the upsell rate. It's where Google's CAC
  gets paid back several times over.

---

## 8. 90-day rollout, budget, and kill/scale rules

| When | Budget (Search) | Actions |
|---|---|---|
| Now → Oct 5 | $0 | Tracking fixes (section 5), phone-number unification, LSA application, negatives, rebuild Core, delete PMax. |
| Oct 6 → Nov 2 | $45/day | Launch. Review search terms **daily** for 2 weeks, then twice a week. "Before the first snow" ads. |
| Nov 3 → Dec 14 | $35–45/day | Switch to Maximize Conversions once ≥15 conv. Pause ad groups with ≥$150 spend and 0 leads. Test Conquest at $10/day if Core is on target. |
| Dec 15 → Feb 28 | $20–30/day | Seasonal trough. Hold the core terms at a lower budget, lean on LSA, and gather reviews. Get the booked-job import live. |
| Mar 1 → | $60–90/day | Spring peak. Scale to the demand ceiling; Target CPA once ≥30 conv/mo. |

**Kill rule:** after $1,000 of Search spend (about 125 clicks), if cost per
lead is over $120 **or** there are fewer than 3 booked jobs, stop and diagnose
(search terms → landing page → phone answer rate) before spending more.

**Scale rule:** if cost per booked job stays ≤ $110 for 2 consecutive weeks
**and** you're losing more than 20% impression share to budget, raise the
budget 20% a week until the demand ceiling.

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

1. Add the section 6 negatives to "Junk & Service Waste Blockers" and link
   that list to all Search campaigns.
2. Conquest and Garage Cleaning campaigns: Display OFF, geo → PRESENCE.
3. Core: add ad schedule Mon–Sat 07–19 and switch bidding to Maximize Clicks
   with a $12 cap.
4. Merge "Garage Cleaning: Fort Collins" into Core as the Garage Cleanout ad
   group.
5. Remove the Performance Max campaign.
6. Set the guardrail monthly cap to $1,500.
7. Re-enable Core at $45/day (**only after** the section 5 tracking is live).

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
