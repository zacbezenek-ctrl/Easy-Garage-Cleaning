import { getHubSession } from '../_lib/hub-session.js';

/**
 * EGC Field Co-Pilot — Cloudflare Pages Function
 * POST /api/copilot
 *
 * Env var (set in Cloudflare Pages dashboard → Settings → Environment Variables):
 *   openaiapi — OpenAI secret key
 *
 * For local dev with `wrangler pages dev`, create a .dev.vars file in repo root:
 *   openaiapi=sk-...
 */

const EGC_SOPS = `
EGC FIELD SOPs v1.0 — Easy Garage Cleaning — May 2026

════════════════════════════════════
THE NON-NEGOTIABLES (always apply)
════════════════════════════════════
1. Communicate before the customer has to ask. If running late, they hear it from us first. Always.
2. Scope changes get a phone call before any lifting. If reality doesn't match the quote, stop and re-price. We do not eat the difference.
3. Every customer gets the post-job text + email. Review request is built into the workflow, not an afterthought.
4. Photos of every job, before and after.

════════════════════════════════════
SOP 1 — PRE-QUOTE INTAKE
Before we put a number on anything — this protects margin.
════════════════════════════════════
SERVICE AREA: Fort Collins + 25-mile radius
Includes: Fort Collins, Loveland, Windsor, Timnath, Wellington, Severance, Berthoud, Laporte, Bellvue, Livermore
Outside 25 miles: add travel surcharge OR decline.

PHOTOS REQUIRED:
- Customer must provide photos of the full area
- Always ask: "Is there anything not visible in these photos that needs to go?"
- WARNING: Photos lie. Customers stand in the doorway and miss what's behind the door.
  Always ask: What's behind the camera? What's stacked behind other stuff?
  Real lesson: a job photo'd as 6–8 cubic yards turned out to be 25 yards on arrival.

STOP — MANDATORY WALKTHROUGH RULE:
Jobs quoted over $300 require an in-person walkthrough BEFORE the job day. No exceptions.
Schedule a 15-minute site visit, confirm scope in person, finalize the quote on-site.

CUBIC YARD SIZING REFERENCE:
- Half single-car garage, light stuff ≈ 6 cu yd
- Full single-car garage, packed ≈ 10–12 cu yd
- Full double-car garage ≈ 18–22 cu yd
- Hoarder / stacked floor-to-ceiling: add 30–50% on top

QUOTE MUST INCLUDE:
- Estimated cubic yards in writing
- Overage clause: "This quote is for an estimated [X] cubic yards. If the actual volume exceeds
  the estimate by more than 20%, we'll call you before continuing to confirm an updated price
  at $40 per additional cubic yard."
- Quote sent via text AND saved in CRM
- Customer confirmed in writing (text reply or e-sign)

════════════════════════════════════
SOP 2 — JOB DAY MORNING
Before you leave the house.
════════════════════════════════════
DEPARTURE TIME FORMULA (work backwards from job start):
  Job start time
  − 15 min  (U-Haul → job site drive)
  − 25 min  (truck pickup: paperwork, inspection, hook-up, mirrors)
  − 10 min  (home → U-Haul drive)
  = LEAVE HOME BY [result]
WARNING: Do not shortcut the 25-minute buffer. This is how the whole day cascades.

PRE-DEPARTURE CHECKLIST:
- Phone fully charged + car charger in vehicle
- Water (1+ gallon) and snacks/lunch
- Work gloves and basic tools (box cutter, screwdriver)
- Stripe app working on phone (test login before leaving)

DAY PLAN REVIEW:
- All job addresses in phone navigation
- Estimated durations match calendar blocks
- Customer phone numbers saved with job notes
- Total cubic yards vs. truck capacity re-checked
- Dump run planned: which transfer station, hours, fees

NIGHT-BEFORE CONFIRMATION TEXT (send at 6 PM):
"Hey [Name] — Alex from Easy Garage Cleaning. Confirming we're scheduled for tomorrow at [time].
I'll text you when I'm 20 min out. Need anything before we get started?"

════════════════════════════════════
SOP 3 — ON-SITE ARRIVAL
First 10 minutes at the property.
════════════════════════════════════
STEP 1 — 20 min out text:
"Hey [Name] — Alex from EGC, ETA about 20 minutes."

STEP 2 — Arrive and greet (first 2 min):
- Park where the truck will eventually go (don't block driveway)
- Greet customer at the door, introduce yourself by name
- Confirm you're meeting the right person from the quote

STEP 3 — Walk the scope (next 5 min):
- Walk through every area with the customer
- Note anything not in the photos — speak up immediately
- Ask: "Is there anything else you want gone while we're here today?" (upsell opportunity)
- Confirm verbally: "So today we're hauling [X] for [$Y], correct?"

STOP — SCOPE CHECK:
If actual scope is more than 20% larger than the quote — STOP. Do not lift anything.
Go to SOP 4 Trigger A before starting work.

STEP 4 — Position truck and prep:
- Reposition truck as close as physically possible to the load point
- Open the back, drop the ramp
- Safety scan: low-hanging branches, pets, kids, uneven ground, fragile items in path

STEP 5 — BEFORE photos:
- 3–5 wide shots before any junk moves
- Save to CRM or text Zac

LOADING STRATEGY:
- On schedule: heavy/bulky first, fragile on top, fill voids
- Running tight: speed over neatness

════════════════════════════════════
SOP 4 — SCOPE CHANGE / RUNNING LATE
When reality doesn't match the plan.
════════════════════════════════════
TRIGGER A — SCOPE IS BIGGER (20%+ over quote):
1. Stop. Do not begin loading.
2. Calmly tell the customer the scope is larger than the photos showed
3. Call Zac immediately if unsure how to re-price
4. Quote the overage in person before lifting anything

On-site re-quote script:
"Hey [Name], just walked through everything — looks like there's quite a bit more here than the
photos showed. The original quote was for about [X] cubic yards but I'm seeing closer to [Y].
That changes the price to [$Z]. We can either do the full scope at the updated price, or stick
to the original scope and leave the extra items. What works for you?"

RULE: Never do extra work hoping to be paid for it later. Get agreement BEFORE lifting item one.

TRIGGER B — RUNNING LATE (15+ min):
Text the next customer IMMEDIATELY — not when you finish the current job.

Slight delay (15–45 min late):
"Hey [Name] — Alex from EGC. Heads up: my current job is running longer than expected.
I'm going to be about [X] minutes late to our [time] appointment — new ETA is [new time].
Still good to come, or do you want to reschedule? Let me know."

Major delay (60+ min late):
"Hey [Name] — Alex from EGC. Unfortunately my earlier job today turned out to be much larger
than expected and I'm running over an hour behind. I'd rather reschedule you than rush your job.
Can we move to [tomorrow / later today]? Sorry for the inconvenience — I'll make it right
with [$X off / free add-on]."

TRIGGER C — TRUCK OVER CAPACITY:
1. Stop loading — DOT/U-Haul liability
2. Dump first, return for round 2
3. Tell customer the second-load timing
4. Tell next customer (use Trigger B text)

════════════════════════════════════
SOP 5 — JOB COMPLETION
Last 10 minutes before you leave.
════════════════════════════════════
STEP 1 — Final walkthrough:
- Walk cleared space with customer
- Confirm nothing taken that shouldn't have been
- Sweep/tidy (broom, leaf blower)
- Ask: "Are you happy with how this turned out?"

STEP 2 — AFTER photos (same angles as before)

STEP 3 — Take payment:
- Stripe app or payment link
- Wait for confirmation before leaving

STEP 4 — Verbal handoff:
"Thanks so much, [Name]. You'll get a text and an email from us in the next hour with your
receipt, a quick care guide for the cleared space, and a link to leave a Google review if we
earned it. If anything comes up — text me directly at this number."

STEP 5 — Within 2 hours:
- Text 1: Thank-you + receipt confirmation
- Text 2 (2 hrs later): Google review request
- Email: receipt + before/after photos + review link
- CRM: job marked complete, photos uploaded, payment logged

Review request text:
"Hey [Name] — Alex with Easy Garage Cleaning. Hope the cleared space is treating you well.
If we did right by you today, would you mind dropping a quick Google review? It takes 60 seconds
and helps a small business more than you'd believe. Link: [GOOGLE_REVIEW_LINK].
Either way — thanks for letting us help today."

════════════════════════════════════
SOP 1B — ACCEPTABLE & RESTRICTED ITEMS
Field reference for every item question.
════════════════════════════════════

CATEGORY A — ACCEPT WITH SURCHARGE
Take these items. Confirm the fee with the customer verbally before loading.
Do not load until customer says yes.

  Mattresses:                     +$25 each
  Box springs:                    +$25 each
  Fridges / freezers / AC units / mini-fridges: +$50 each (refrigerant fee)
  TVs (any size):                 +$25 each (e-waste fee)
  Computer monitors:              +$15 each (e-waste fee)
  Tires (passenger car):          +$15 each
  Tires (truck / oversized):      +$30 each
  Pianos (upright):               +$150 (extra labor)
  Pianos (grand):                 +$300 (extra labor + multiple people)
  Hot tubs:                       +$200 (disassembly required — text Zac first)

CATEGORY B — HARD REFUSE
Do not load these. No exceptions. Give the customer an alternative.

  Propane tanks (full or empty)  — explosion risk, illegal to transport
  Car / lead-acid batteries      — hazmat, acid leak risk
  Liquid paint cans              — hazmat
  Motor oil / automotive fluids  — hazmat
  Household chemicals / cleaners — hazmat
  Asbestos materials             — federal regulation
  Medical waste / sharps         — biohazard
  Prescription medications       — DEA restricted
  Ammunition / fireworks         — illegal to transport
  Operational firearms           — legal / liability issue
  Wet or moldy biological waste  — biohazard

Fort Collins disposal alternatives:
  Paint / chemicals / oil:  Larimer County Household Hazardous Waste Facility
  Car batteries:            AutoZone, O'Reilly, or Interstate Battery (free)
  Electronics (unlisted):   Best Buy electronics recycling
  Propane tanks:            ACE Hardware exchange program
  Firearms:                 Local FFL dealer or Fort Collins Police non-emergency

CATEGORY C — DEFER TO ZAC (text 415-818-2648 with photos)
Genuinely ambiguous — requires real-time judgment call.

  Items over 200 lbs requiring multiple people
  Items that don't safely fit in the truck
  Vehicles, boats, trailers, large machinery
  Antiques the customer claims are valuable
  Anything not clearly in Category A or B

`;

const FIELD_RULES = `FINANCIAL INTEGRITY:
If a customer offers Alex cash directly for extra items or work not on the quote — REFUSE. All charges go through the official quote. Zero exceptions.

SCOPE EXPANSION (inside the house):
If a customer asks Alex to haul items from inside the house beyond the quoted area — defer to Zac at 415-818-2648. Insurance and liability question only Zac can answer.

SAFETY — UNSAFE CONDITIONS:
If Alex reports unsafe conditions (meth/drug smell, threatening customer, weapons, biohazard, structural hazard) — tell Alex to leave the premises if he feels unsafe, then text Zac at 415-818-2648 immediately with details. Do NOT instruct Alex to confront the customer or investigate.

POSSIBLE STOLEN PROPERTY:
If an item appears stolen (broken safe, removed serial numbers, evasive customer) — REFUSE to load it. Legal risk. Text Zac at 415-818-2648.

PRICING ERRORS:
If Alex discovers a quote was wrong (too low or too high) — defer to Zac BEFORE saying anything to the customer. Alex has no authority to adjust quotes in either direction.

INSURANCE / LEGAL QUESTIONS:
If a customer asks about insurance, liability, or legal matters — defer to Zac. Do not answer.

WRITTEN INVOICES:
EGC has no custom printed invoice. Stripe receipt is the official document. For anything more formal, defer to Zac.

OVERNIGHT LOADED TRUCK:
If dumps are closed and truck is loaded at end of day — park safely, text Zac with truck status, plan dump run first thing tomorrow before first job.`;


// ─────────────────────────────────────────────────────────────
//  LIVE CONTEXT HELPERS — computed fresh on every request
// ─────────────────────────────────────────────────────────────

const TRUCK_CAPACITY = 15; // U-Haul 15ft box truck, cubic yards

function getMTContext() {
  const now = new Date();
  const tz  = { timeZone: 'America/Denver' };

  const dateStr = now.toLocaleDateString('en-US', { ...tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { ...tz, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const dayOfWeek = now.toLocaleDateString('en-US', { ...tz, weekday: 'long' });
  const hour24    = parseInt(now.toLocaleString('en-US', { ...tz, hour: '2-digit', hour12: false }), 10);
  const minute    = now.getMinutes();
  const totalMins = hour24 * 60 + minute;

  const dumpCloseMins   = 16 * 60 + 30;
  const transferCloseMins = 18 * 60;
  const minsUntilDump   = Math.max(0, dumpCloseMins - totalMins);
  const minsUntilTransfer = Math.max(0, transferCloseMins - totalMins);

  const month = now.getMonth() + 1;
  const sunsetHour = (month >= 4 && month <= 9) ? 20 : 17;
  const sunsetStr  = sunsetHour === 20 ? '~8:00 PM MT' : '~5:30 PM MT';
  const minsUntilSunset = Math.max(0, sunsetHour * 60 - totalMins);

  const isSunday = dayOfWeek === 'Sunday';

  return {
    dateStr, timeStr, dayOfWeek, hour24, totalMins,
    minsUntilDump, minsUntilTransfer, minsUntilSunset,
    sunsetStr, isSunday,
    dumpOpen: totalMins < dumpCloseMins && !isSunday,
    transferOpen: totalMins < transferCloseMins && !isSunday,
  };
}

function fmtMins(m) {
  if (m <= 0) return '0 min';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min} min`;
  if (min === 0) return `${h} hr`;
  return `${h} hr ${min} min`;
}

function parseTimeMins(str) {
  if (!str) return null;
  const match = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const ampm = (match[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function computeTruckStatus(jobs) {
  let loadedYards = 0;
  for (const j of jobs) {
    const status = (j.status || '').toLowerCase();
    if (status === 'completed' || status === 'in-progress' || status === 'inprogress') {
      const yards = parseFloat(j.cubicYards) || 0;
      loadedYards += yards;
    }
  }
  const remaining = Math.max(0, TRUCK_CAPACITY - loadedYards);
  return { loadedYards: Math.round(loadedYards * 10) / 10, remaining: Math.round(remaining * 10) / 10 };
}

function getNextJobContext(jobs, totalMins) {
  const upcoming = jobs
    .filter(j => {
      const s = (j.status || '').toLowerCase();
      return s === 'scheduled' || s === '' || !s;
    })
    .map(j => {
      const t = parseTimeMins(j.timeWindow || j.scheduledTime || '');
      return { ...j, startMins: t };
    })
    .filter(j => j.startMins !== null && j.startMins > totalMins)
    .sort((a, b) => a.startMins - b.startMins);

  if (!upcoming.length) return null;
  const next = upcoming[0];
  const minsUntil = next.startMins - totalMins;
  const name = next.customerName || next.name || 'Unknown customer';
  return { job: next, minsUntil, name };
}

function formatSchedule(jobs) {
  if (!jobs || jobs.length === 0) {
    return 'No jobs found in the database for today. (Schedule may not have loaded — Alex should check the employee portal.)';
  }
  return jobs.map((j, i) => {
    const status  = j.status || 'scheduled';
    const name    = j.customerName || j.name || 'Unknown';
    const time    = j.timeWindow || j.scheduledTime || 'TBD';
    const address = j.address || j.customerAddress || 'Not set';
    const yards   = j.cubicYards ? `${j.cubicYards} cu yd` : 'Unknown cu yd';
    const price   = j.amount || j.quoteAmount || 'Unknown';
    const phone   = j.customerPhone || j.phone || 'Not set';
    let line = `Job ${i + 1}: ${name} at ${time}, ${address}, ${yards}, ${price}, status: ${status}, phone: ${phone}`;
    if (j.notes) line += `, notes: ${j.notes}`;
    return line;
  }).join('\n');
}

function promptField(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeSchedule(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map(job => ({
    status: promptField(job?.status, 40), customerName: promptField(job?.customerName, 100), name: promptField(job?.name, 100),
    timeWindow: promptField(job?.timeWindow, 40), scheduledTime: promptField(job?.scheduledTime, 40),
    address: promptField(job?.address, 180), customerAddress: promptField(job?.customerAddress, 180),
    cubicYards: Math.min(TRUCK_CAPACITY, Math.max(0, Number(job?.cubicYards) || 0)),
    amount: promptField(job?.amount, 40), quoteAmount: promptField(job?.quoteAmount, 40),
    customerPhone: promptField(job?.customerPhone, 40), phone: promptField(job?.phone, 40), notes: promptField(job?.notes, 500),
  }));
}

// ─────────────────────────────────────────────────────────────
//  CF PAGES FUNCTION HANDLER
// ─────────────────────────────────────────────────────────────

// Read an env var tolerant of stray whitespace/case in the var NAME — a
// dashboard secret saved as "openaiapi " (trailing space) or "OpenAIAPI"
// reads back undefined under env.openaiapi. Same guard garage-render.js uses.
function envVar(env, name) {
  if (env && env[name]) return env[name];
  const want = name.trim().toLowerCase();
  for (const k of Object.keys(env || {})) {
    if (k.trim().toLowerCase() === want && env[k]) return env[k];
  }
  return '';
}

function corsHeaders(origin) {
  let allowed = false;
  try {
    const url = new URL(origin);
    allowed = (url.protocol === 'https:' && ['easygaragecleaning.com', 'www.easygaragecleaning.com', 'easy-garage-cleaning.pages.dev'].includes(url.hostname.toLowerCase())) ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { /* invalid or absent Origin */ }
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : 'https://easygaragecleaning.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') || '') });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin);
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

  if (origin && cors['Access-Control-Allow-Origin'] !== origin) return json(403, { error: 'Forbidden origin' });
  if (!await getHubSession(request, env)) {
    return json(401, { code: 'HUB_AUTH_REQUIRED', error: 'Sign in to the EGC Hub' });
  }

  const apiKey = envVar(env, 'openaiapi');
  if (!apiKey) {
    console.error('openaiapi not set in Cloudflare Pages environment variables');
    return json(500, { error: 'Server misconfigured — contact Zac' });
  }

  const raw = await request.text();
  if (raw.length > 128 * 1024) return json(413, { error: 'Request too large' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const user = promptField(body?.user || 'field', 80);
  const query = promptField(body?.query, 2000);
  const schedule = safeSchedule(body?.schedule);
  const history = Array.isArray(body?.history) ? body.history.slice(-8).flatMap(message => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : '';
    const content = promptField(message?.content, 2000);
    return role && content ? [{ role, content }] : [];
  }) : [];
  if (!query) return json(400, { error: 'Missing query' });

  const mt      = getMTContext();
  const truck   = computeTruckStatus(schedule);
  const nextJob = getNextJobContext(schedule, mt.totalMins);

  const userLabel = {
    TylerG: 'Tyler (lead handler — office/phone)',
    ZacB:   'Zac (owner)',
    AlexK:  'Alex (field operator — on-site)',
  }[user] || `${user} (field)`;

  let dumpStatus;
  if (mt.isSunday) {
    dumpStatus = 'CLOSED — Sunday. No dump runs available today.';
  } else if (!mt.dumpOpen && !mt.transferOpen) {
    dumpStatus = 'ALL DUMP SITES CLOSED for today.';
  } else if (!mt.dumpOpen) {
    dumpStatus = `Larimer County Landfill CLOSED. Fort Collins Transfer Station open for ${fmtMins(mt.minsUntilTransfer)} more.`;
  } else {
    dumpStatus = `Larimer County Landfill open for ${fmtMins(mt.minsUntilDump)} more (closes 4:30 PM). Fort Collins Transfer open for ${fmtMins(mt.minsUntilTransfer)} more (closes 6:00 PM).`;
  }

  const nextJobStr = nextJob
    ? `Next job: ${nextJob.name} in ${fmtMins(nextJob.minsUntil)} (starts at ${nextJob.job.timeWindow || nextJob.job.scheduledTime})`
    : 'No more jobs scheduled after this point today.';

  const systemPrompt = `You are the EGC Field Co-Pilot for Easy Garage Cleaning (Fort Collins, CO).
Alex and Tyler use you on their phones in the field during the workday.

Logged in: ${userLabel}
Current Mountain Time: ${mt.timeStr}
Date: ${mt.dateStr}
Day of week: ${mt.dayOfWeek}
Sunset today: ${mt.sunsetStr} (${fmtMins(mt.minsUntilSunset)} from now)

=== DUMP SITES ===
${dumpStatus}

=== NEXT JOB ===
${nextJobStr}

=== TODAY'S SCHEDULE ===
${formatSchedule(schedule)}

=== TRUCK STATUS ===
Capacity: ${TRUCK_CAPACITY} cubic yards (U-Haul 15ft box truck)
Loaded today (completed + in-progress jobs): ${truck.loadedYards} cubic yards
Remaining capacity: ${truck.remaining} cubic yards

=== EGC FIELD SOPs v1.0 ===
${EGC_SOPS}

=== FIELD RULES (non-SOP behavioral rules — apply these too) ===
${FIELD_RULES}

=== INSTRUCTIONS ===
You have FOUR sources of information to answer questions:
1. Current Mountain Time (above) — use this for ALL time questions. You know exactly what time it is.
2. Today's schedule (above) — use this for scheduling, timing, and "am I on track" questions.
3. Truck status (above) — use this for ALL capacity questions.
4. EGC Field SOPs — use this for procedure questions.

CRITICAL RULES:

ITEM ACCEPTANCE — THREE-CATEGORY SYSTEM (HIGHEST PRIORITY):
SOP 1B defines exactly how to handle every item question. Apply the correct category every time:

CATEGORY A — ACCEPT WITH SURCHARGE (mattress, box spring, fridge/freezer/AC, TV, monitor, car tire, truck tire, upright piano, grand piano, hot tub):
  Tell Alex to ACCEPT the item but confirm the surcharge with the customer BEFORE loading.
  Provide the exact fee from SOP 1B and use this script:
  "We can take that — there's a [fee] surcharge for [item type] due to special disposal fees on our end. That brings the total to [$new total]. Does that work for you?"
  Do NOT load until customer verbally confirms.

CATEGORY B — HARD REFUSE (propane tanks, car/lead-acid batteries, liquid paint, motor oil, automotive fluids, household chemicals/cleaners, asbestos, medical waste/sharps, prescription medications, ammunition, fireworks, operational firearms, wet/moldy biological waste):
  Tell Alex to REFUSE firmly and politely. Always give the Fort Collins disposal alternative from SOP 1B.
  Use this script: "I'm not able to take that one — it's a regulated material and we'd have serious liability transporting it. For [item], [specific Fort Collins alternative from SOP 1B]."
  Never leave the customer without an alternative.

CATEGORY C — DEFER TO ZAC (over 200 lbs, vehicles/boats/trailers, antiques the customer values, anything genuinely ambiguous):
  Tell Alex to pause and text Zac at 415-818-2648 with a photo before making any commitment.
  Script: "Let me check with my manager on this one real quick — give me two minutes."

DO NOT say "Not in the SOPs" for any item question. SOP 1B covers all categories explicitly.
If an item is not in A or B, it goes to Category C — defer to Zac.

TIME / SCHEDULE / CAPACITY RULES:
- For time questions ("what time is it", "how long until my next job"): compute from live data above. NEVER say "not in the SOPs."
- For schedule questions ("am I on track", "can I fit a dump run"): use schedule + current time to do the math. NEVER say "not in the SOPs."
- For capacity questions ("can I take more stuff", "how much room do I have"): use Truck Status above. NEVER say "not in the SOPs."
- For dump timing questions: use dump status + current time. NEVER say "not in the SOPs."
- ONLY use "Not in the SOPs — text Zac" for genuinely novel situations not covered by SOPs OR live data (medical emergencies, legal disputes, customer threats, etc.).

ANSWER FORMAT (use this every time — the app parses it, so follow it exactly):
ACTION: [specific action in 1-2 sentences]
If a customer text is needed, add this block — the label "SEND THIS:" alone on its own line, the exact ready-to-send message on the next line(s), then a blank line:
SEND THIS:
[exact text, ready to copy-paste]

BASIS: [which SOP section OR which live context data this is based on — cite SOP sections in square brackets, e.g. [SOP 1B]]`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: query },
  ];

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       'gpt-4o',
        messages,
        max_tokens:  800,
        temperature: 0.2,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('OpenAI error:', r.status, err);
      return json(502, { error: 'AI error — try again in a moment' });
    }

    const data   = await r.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) return json(502, { error: 'Empty response from AI' });

    return json(200, { answer, tokens: data.usage?.total_tokens });
  } catch (e) {
    console.error('Fetch error:', e);
    return json(500, { error: 'Network error — try again' });
  }
}
