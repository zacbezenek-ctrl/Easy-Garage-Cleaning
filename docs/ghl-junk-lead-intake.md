# HighLevel junk lead intake: what's automatic, what you set up

Written September 27, 2026 for location `KlgLwRaQSPz5G1YXsmc6`.
Scope: **junk removal leads from the website and the Google Ads landing page
(`/junk-removal-quote`)**. Garage-transformation offers are out of scope.

Part 1 is what the code does by itself once it is deployed. Part 2 is the
HighLevel work only you can do, in priority order. Part 3 is the test to run
before a single ad dollar goes to the new page.

---

## Part 1. What the code does automatically

Every quote form on the site (including the new landing page) posts to
Web3Forms for the email copy, and `fb-capture.js` mirrors the same lead to
`/api/web-lead`. That function writes it into HighLevel in this order. Only
step 1 can fail the lead; every later step logs its error and carries on.

1. **Contact upsert** — name, phone, email, ZIP and city only.
2. **Source and owner** — set only for a brand-new contact (or one with no
   source or owner yet). A returning customer keeps their original source.
3. **Pipeline check** — the contact's opportunities in the Marketing Pipeline
   are read **before any tag is written** (see "Opportunity" below).
4. **Tags** — first the tags that no longer apply are removed (the opposite
   consent tag, and stale `egc-out-of-area` / `egc-repeat-inquiry` /
   `egc-needs-triage`), then every new tag is added in **one**
   `POST /contacts/{id}/tags` (the old code used `PUT`, which HighLevel
   rejects; that's why 0 of 604 contacts have these tags today). So a
   workflow that starts on `egc-website-lead` already sees the final consent
   and state tags.
5. **Contact fields** — see the table below.
6. **Note** — "EGC Website Lead Details" (full details, see below).
7. **Opportunity** — Marketing Pipeline, **New Lead** stage, with an estimated
   value and the Opp GCLID / Lead Source / UTM fields.
8. **Text relay** — the Zapier hook (`WEBSITE_LEAD_HOOK_URL`) is called
   **only when the SMS consent box was checked.** No consent means no Zapier
   call, no Meta CAPI event from that Zap, and no automated text.

### Tags the code adds

| Tag | When | Notes |
|---|---|---|
| `egc-website-lead` | every website lead | first time this tag will ever land |
| `egc-sms-consent` / `egc-no-sms-consent` | every lead, one or the other | the latest answer wins: the opposite tag is removed |
| `egc-svc-junk` / `egc-svc-garage` | every lead | service line; every lead from `/junk-removal-quote` is `egc-svc-junk` (a garage haul there is a junk job) |
| `egc-src-…` | every lead | `google-ads`, `google-organic`, `meta-ads`, `meta-organic`, `nextdoor`, `gbp`, `referral`, `direct` |
| `egc-ch-…` | every lead | which form: `gads-lp` (the new landing page), `meta-lp` (`/ads`), `book` (walkthrough booking), `web` (any other site form) |
| `egc-item-…` | every lead | `single-item`, `furniture`, `mattress`, `appliance`, `fridge-freon`, `exercise`, `curbside`, `few-items`, `partial-load`, `hot-tub`, `shed`, `yard`, `construction`, `estate`, `hoarder`, `basement`, `storage`, `commercial`, `other` (plus the garage slugs) |
| `egc-out-of-area` | ZIP is known and not one of the 7 towns, or the page said "no" | in-area ZIPs: Fort Collins 80521–80528, Loveland 80537–80539, Windsor 80550–80551, Timnath 80547, Wellington 80549, Severance 80546 (and 80550), LaPorte 80535. Removed again when a later request has an in-area ZIP |
| `egc-repeat-inquiry` | contact already has an opportunity that is **open past New Lead** or **won** | that opportunity is left alone (not dragged back to New Lead). Removed again when a later request finds no such opportunity. A **lost** opportunity is simply reopened at New Lead |
| `egc-needs-triage` | contact carries an `applicant…` tag, **or** the opportunity check failed | no opportunity is written; a person sorts it out (the note says why). Removed again when a later request checks cleanly |
| `egc-client-hub-help` | Client Hub help requests only | those get this tag (+ `egc-sms-consent` only if they ticked the optional box; an unticked box never removes consent), a pinned note and an internal comment, and never an opportunity |
| value of `HIGHLEVEL_INTAKE_TAG` | only if you set that env var, and only with SMS consent | off by default (item 11); ignored if set to a trigger tag below |

**Tags the code will never add**, because existing workflows start on them:
`jr`, `fb-garage-quote-active`, `gc-quote-open`, `gc-quote-cold`,
`egc-junk-sales-exit`, `egc-garage-sales-exit`, `egc-review-requested`,
`egc-review-ready`, `active-sequence`, `mct-texted-today`.

### Contact fields

| Field | What goes in | Overwrites? |
|---|---|---|
| Lead Product | `Junk Pickup` (or `Garage Cleanout` for garage-line requests from other site forms and `/ads`; always `Junk Pickup` from `/junk-removal-quote`) | yes, latest request |
| Lead Source | `Google Paid`, `Google Organic`, `Facebook Paid`, `Facebook Organic`, `Nextdoor`, `Google Business Profile` or `Referral` | **first touch only** — never overwritten; left blank for direct traffic |
| Campaign | `utm_campaign` from the ad URL | yes, when present |
| What do you need help with | what they typed/picked, e.g. "Hot tub — Soonest available" | yes |

Any click ID (`gclid`, `gbraid`, `wbraid`) makes the lead **Google Paid**, even
without UTM tags.

### Opportunity

- **Pipeline / stage:** Marketing Pipeline → New Lead.
- **Name:** "{Name} — {what they asked for}".
- **Source:** the Lead Source label (or "Website").
- **Duplicates:** duplicate opportunities are blocked in this location, and the
  code upserts, so a second form from the same person updates the same New
  Lead opportunity instead of making another one.
- **Left alone:** an opportunity that is open past New Lead (quoted,
  scheduled…) or **won** is never touched; the contact gets
  `egc-repeat-inquiry` instead. If HighLevel's opportunity search fails, no
  opportunity is written at all and the contact gets `egc-needs-triage`, so a
  scheduled job can never be dragged back to New Lead by a glitch.
- **Value:** the price range the lead saw on the form (midpoint; "$650+"
  counts as $800). With no range, these defaults from the published prices:

| Request | Value |
|---|---|
| Single item (couch, mattress, fridge, washer/dryer, treadmill, curbside) | $125 |
| A few items / partial load | $325 |
| Hot tub | $600 |
| Shed / playset, yard debris, construction debris | $400 |
| Garage cleanout, estate, hoarder, basement, storage, commercial | $525 |
| Not sure / not specified | $250 |

- **Opportunity fields:** Opp GCLID (the `gclid`; `gbraid:…` / `wbraid:…` if
  that's all Google sent), Opp Lead Source, Opp UTM Source, Opp UTM Campaign.
  This is what the booked-job import to Google Ads will read.

### The note on the contact

Service (as typed and normalized), estimated value, job size, request text,
email, ZIP, in-service-area yes/no/unknown, preferred timing, SMS consent
yes/no, UTM campaign, `gclid`/`gbraid`/`wbraid`, lead source + channel, the
landing-page variant (`?v=`), the pipeline check result, and the landing page
URL.

---

## Part 2. Your HighLevel checklist, in priority order

Click paths are for the current HighLevel web app. "Workflows" means
**Automation → Workflows**.

### 0. Before this code is deployed: check who listens for the new tags

These four tags will land on real contacts **for the first time ever** the
moment the code goes live: `egc-website-lead`, `egc-sms-consent`,
`egc-no-sms-consent`, `egc-client-hub-help`.

- [ ] Workflows → set the status filter to **All** (Published **and** Draft /
      paused) → open each workflow → check the **trigger** (Contact Tag
      Added, and any trigger filter on tags) **and every If/Else** for those
      four tags.
- [ ] Any hit you don't want firing yet: pause it or remove the tag condition
      **before** deploying. A forgotten draft that someone publishes later is
      the usual way this goes wrong.
- [ ] Also glance at Zapier / any other tool that watches HighLevel tags.

### 1. Customer reply alert (75 unread customer-last conversations today)

- [ ] First clear the backlog: Conversations → filter **Unread** → reply or
      mark handled.
- [ ] Workflows → Create → **Customer Replied** trigger (SMS; add other
      channels if you use them).
- [ ] First step: If/Else — contact tag starts with / includes `applicant`,
      `spam likely` or `egc-test` → **End**.
- [ ] Otherwise: **Internal Notification** (text + email to whoever answers)
      and **Add Task** "Reply to {{contact.name}}", due in 15 minutes.
- [ ] Then an If/Else: opportunity stage **is New Lead** → **Create/Update
      Opportunity** set to stage **Contacted** (add that stage after New Lead
      if it doesn't exist) with backward moves off. This only ever moves New
      Lead forward and never creates an opportunity.

### 1b. Who answers 999-1818 (remote lead handler + your cell as backup)

- [ ] Give the remote lead handler their own HighLevel user, limited to
      Conversations, Contacts, Opportunities and Calendars (no payments,
      settings or Jobber financials).
- [ ] Settings → Phone Numbers → 999-1818 → route inbound calls to the lead
      handler in the HighLevel app during 7am–7pm Mountain, with the owner's
      personal cell as the fallback ring. Keep the owner's cell out of the
      website, ads and customer texts.
- [ ] Put the owner's cell on the owner's HighLevel user profile so the reply
      alert (item 1) and new-lead alerts reach them when the handler is off.
- [ ] Rule for everyone: call and text customers back only from the HighLevel
      app (it shows 999-1818). A personal number skips HighLevel tracking and
      opt-outs, and an out-of-state area code looks like spam to local
      customers.
- [ ] Turn on call recording for quality checks, with a short recording
      notice in the greeting (some callers are in two-party-consent states).

### 2. Find where (970) 658-9454 rings

It's on the Google Ads call asset and on `/ads`, but it never appears in
HighLevel (Settings → Phone Numbers doesn't list it, and no calls from it are
logged). Calls to it are invisible to your CRM.

- [ ] Call it from another phone and see what rings.
- [ ] Check Quo/OpenPhone, Google Voice and your carrier for forwarding.
- [ ] Then either port/forward it into HighLevel, or replace it on the call
      asset and `/ads` with 999-1818 (or a HighLevel tracking number).
- Until it's fixed, don't rely on it. **The new landing page uses (970)
  999-1818.**

### 3. Junk Lead Nurture sends from the wrong number

Nurture texts go out from **(970) 999-1760**, while replies and calls happen on
**999-1818**, so conversations split across two numbers.

- [ ] Workflows → **Junk Lead Nurture** → **Settings** → From number
      **(970) 999-1818**; turn **Stop on response ON**.
- [ ] Open each SMS step and clear any per-step From number.
- [ ] Settings → My Staff → the assigned user → phone settings. If their
      number is 1760, texts sent "as the assigned user" still come from 1760.
- [ ] New helper workflow: trigger **Call Details / Call Status** → status
      completed, duration at least 30 s → **Remove from Workflow: Junk Lead
      Nurture**. A connected call ends the nurture.

### 4. Facebook router: route "Item Removal & Orginization" explicitly

In **EGC - Sept 10 Facebook service routing**, the answer "Item Removal &
Orginization" (Facebook's spelling) is not routed explicitly.

- [ ] Add a branch **before** the manual-review branch: normalized answer
      **contains `item removal &`** → send it to the branch you want (junk
      nurture, or a task to qualify it by phone).
- [ ] Make the **Else** branch always **create a task**, so nothing falls
      through silently.

### 5. Harden the missed-call workflow

- [ ] **Short "completed" calls:** treat a completed call under ~20 s
      (voicemail pickup, hang-up) as missed.
- [ ] **Double-text guard:** before texting, skip if the contact was already
      texted today, or has an active nurture/speed-to-lead text.
- [ ] **Guards:** skip `applicant…`, `spam likely`, `egc-test`, and existing
      customers with a scheduled job; create a task for those instead of an
      auto-text.

### 6. Junk speed-to-lead text for website and landing-page leads

- [ ] **Decide who sends the first text first.** Today the Zapier hook can text
      consent leads through OpenPhone/Quo. GHL and Zapier must not both text.
      **Zapier audit:** open the Zap behind `WEBSITE_LEAD_HOOK_URL`, check if
      its OpenPhone "Send Message" step is on, and turn it off if GHL will
      send. Keep the team alert and Meta CAPI steps.
- [ ] Workflows → Create → trigger **Contact Tag Added** = `egc-ch-gads-lp`
      **or** `egc-website-lead`.
- [ ] If/Else: has `egc-sms-consent` **and** `egc-svc-junk`, and does **not**
      have `egc-out-of-area`, `egc-repeat-inquiry` or `egc-needs-triage` →
      text. Everyone else → **Add Task** "Call within 5 min" (no text: no
      consent means no text).
- [ ] Send window **8am–8pm recipient time**; From **(970) 999-1818**.
- [ ] Copy that matches the landing page (book a window, price confirmed
      on-site). Example:
      > Hi {{contact.first_name}}, it's Easy Garage Cleaning. Got your junk
      > removal request. What day and time window works for you? When we
      > arrive, we confirm your flat price on-site before we lift anything,
      > and if you approve, we haul it the same visit. Reply STOP to opt out.
- The exact price is set only after the crew sees the job on-site. Photos
  are welcome as planning context, but no text ever promises an exact price.

### 7. Junk quote follow-up that knows the service

`functions/api/highlevel.js` adds `egc-quote-ready` **and** `gc-quote-open` to
every open quote, **junk quotes included** (env `HIGHLEVEL_QUOTE_READY_TAGS`,
default `egc-quote-ready,gc-quote-open`). So junk customers can get the
garage-cleaning quote follow-up.

- [ ] In the workflow triggered by `gc-quote-open`, add a filter/If: **Lead
      Product is not Junk Pickup**.
- [ ] New workflow **Junk quote follow-up**: trigger Contact Tag Added
      `egc-quote-ready`; If Lead Product = **Junk Pickup** → follow-up texts
      (same on-site pricing language), Stop on response ON.

### 8. Won → review request, then referral

- [ ] Workflows → trigger **Opportunity Status Changed → Won** (Marketing
      Pipeline).
- [ ] Wait until the next day, 10am. Skip if the crew already texted the review
      link on-site (check the **Review Requested** field).
- [ ] Set the **Review Requested** field. **Do not add
      `egc-review-requested`**: that's the Hub's trigger tag.
- [ ] Send one neutral ask, the same to every customer: no discount, no gift,
      no "5 stars", and no "tell us first, then review" gate. Example:
      > Hi {{contact.first_name}}, thanks for having Easy Garage Cleaning out.
      > If you have a minute, an honest Google review helps our small local
      > crew a lot: {link}
- [ ] **7 days later, separately:** the referral ask, **only for contacts with
      marketing consent**. Never mention reviews in it, and never tie the
      referral reward to a review.

### 9. Consent and A2P 10DLC

- [ ] Settings → Phone System → **Trust Center / A2P 10DLC**: brand and
      campaign approved, and **both 999-1818 and 999-1760** attached to the
      campaign.
- [ ] The website's consent sentence covers **quote and appointment texts
      only**, not promotions. Don't put website leads into promo blasts or
      referral asks without separate marketing consent.

### 10. Pipeline cleanup before any "Lost → reactivation" automation

- [ ] Opportunities → Marketing Pipeline → find the **121 imported
      placeholder opportunities valued $801 / $139**.
- [ ] Mark them **Lost, reason "Stale import"** (or keep the real ones).
      Check for workflows on *Opportunity Status Changed* first, because a
      bulk change can fire them.
- [ ] Do this **before** building any Lost → reactivation workflow, or those
      121 people all get a reactivation text.

### 11. Optional: `HIGHLEVEL_INTAKE_TAG`

Only once an intake workflow exists that you want the site to start:
Cloudflare → Workers & Pages → `easy-garage-cleaning` → Settings → Variables
and Secrets → **Production** → add `HIGHLEVEL_INTAKE_TAG` (e.g.
`egc-web-intake`) → redeploy. It's added only to leads that checked the SMS
box. Never set it to one of the existing trigger tags listed in Part 1.

---

## Part 3. Pre-launch test for `/junk-removal-quote`

Use phones that are **not already contacts** in HighLevel (Lead Source is
first-touch only, so an existing contact keeps its old value). Afterwards, tag
test contacts `egc-test` and mark the test opportunities Lost.

Test URL:

```
https://easygaragecleaning.com/junk-removal-quote?gclid=TEST-0928&utm_source=google&utm_medium=cpc&v=hottub
```

(Add `&utm_campaign=test-0928` if you also want to see the Campaign field
fill.)

### A. With consent (phone 1, ZIP 80525, Hot tub, Soonest available, box checked)

- [ ] Lands on `/junk-removal-quote-thanks?rid=…` and says "we'll text you
      shortly".
- [ ] **Tag Assistant** (tagassistant.google.com, connected before you
      submit): `generate_lead` fires **on the thanks page** with a
      `transaction_id` equal to the `rid` and value 210 (hot tub $600 × 0.35).
      DevTools console shows no Content-Security-Policy errors for Google
      hosts.
- [ ] **Exactly one text**, from **(970) 999-1818**, within a minute. Not
      from 1760, and not a second one from OpenPhone.
- [ ] HighLevel contact tags: `egc-website-lead`, `egc-sms-consent`,
      `egc-svc-junk`, `egc-src-google-ads`, `egc-ch-gads-lp`,
      `egc-item-hot-tub`. **No** `egc-out-of-area`.
- [ ] Contact fields: Lead Product **Junk Pickup**, Lead Source **Google
      Paid**, What do you need help with **"Hot tub — Soonest available"**.
- [ ] Note "EGC Website Lead Details": Hot tub removal, estimated value $600,
      in service area yes, SMS consent yes, `gclid TEST-0928`, Google Paid ·
      channel gads-lp, variant hottub.
- [ ] Opportunity: Marketing Pipeline / New Lead, value **$600**, **Opp GCLID
      = TEST-0928**, Opp Lead Source Google Paid, Opp UTM Source google.

### B. Without consent (phone 2, same URL, box unchecked)

- [ ] Thanks page says "we'll call you shortly" (no text promised).
- [ ] Tag `egc-no-sms-consent` (not `egc-sms-consent`).
- [ ] **No text at all.** A "Call within 5 min" task appears (once item 6 is
      built).
- [ ] Opportunity and fields are the same as in test A.

### C. Out of area (phone 3, ZIP 80631 Greeley, box checked)

- [ ] Tag `egc-out-of-area`; note says "In service area: no".
- [ ] It gets whatever you decided in item 6 (task, not the standard text).

### D. Clean up

- [ ] Tag all test contacts `egc-test`; mark test opportunities Lost.
- [ ] Make sure `TEST-0928` is never uploaded as an offline conversion.
