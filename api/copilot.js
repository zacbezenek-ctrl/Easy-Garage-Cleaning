/**
 * EGC Field Co-Pilot — Vercel Serverless Function
 * POST /api/copilot
 *
 * Set in Vercel dashboard → Project Settings → Environment Variables:
 *   OPENAI_API_KEY   — your OpenAI secret key
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
`;

// ─────────────────────────────────────────────────────────────
//  LIVE CONTEXT HELPERS — computed fresh on every request
// ─────────────────────────────────────────────────────────────

const TRUCK_CAPACITY = 15; // U-Haul 15ft box truck, cubic yards

/** Full MT datetime object with all derived fields */
function getMTContext() {
  const now = new Date();
  const tz  = { timeZone: 'America/Denver' };

  const dateStr = now.toLocaleDateString('en-US', {
    ...tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    ...tz, hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const dayOfWeek = now.toLocaleDateString('en-US', { ...tz, weekday: 'long' });
  const hour24    = parseInt(now.toLocaleString('en-US', { ...tz, hour: '2-digit', hour12: false }), 10);
  const minute    = now.getMinutes();
  const totalMins = hour24 * 60 + minute; // minutes since midnight MT

  // Dump sites (Larimer County = closes 16:30, Fort Collins Transfer = closes 18:00)
  const dumpCloseMins   = 16 * 60 + 30; // 4:30 PM
  const transferCloseMins = 18 * 60;    // 6:00 PM
  const minsUntilDump   = Math.max(0, dumpCloseMins - totalMins);
  const minsUntilTransfer = Math.max(0, transferCloseMins - totalMins);

  // Approximate sunset (MDT summer ≈ 8:15 PM, MST winter ≈ 5:30 PM)
  // Simple seasonal estimate — good enough for field use
  const month = now.getMonth() + 1; // 1-12
  const sunsetHour = (month >= 4 && month <= 9) ? 20 : 17; // summer vs winter
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

/** Format minutes as "1 hr 20 min" or "45 min" */
function fmtMins(m) {
  if (m <= 0) return '0 min';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min} min`;
  if (min === 0) return `${h} hr`;
  return `${h} hr ${min} min`;
}

/**
 * Parse a time string like "9:00 AM", "9:00 AM – 12:00 PM", "14:30"
 * Returns minutes since midnight, or null if unparseable.
 */
function parseTimeMins(str) {
  if (!str) return null;
  // Take first time token
  const match = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const ampm = (match[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

/** Compute truck capacity from jobs list */
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

/** Find the next scheduled (not started) job and compute time until it */
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

/** Build the full schedule section string */
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

// ─────────────────────────────────────────────────────────────
//  HANDLER
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — same origin only
  const origin  = req.headers.origin || '';
  const allowed = /easygaragecleaning\.com/.test(origin)
               || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)
               || /vercel\.app$/.test(origin);
  res.setHeader('Access-Control-Allow-Origin',  allowed ? origin : 'https://easygaragecleaning.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { user = 'field', query, schedule = [], leads = [], history = [] } = req.body || {};

  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' });

  if (!process.env.openaiapi) {
    console.error('openaiapi not set in Vercel environment variables');
    return res.status(500).json({ error: 'Server misconfigured — contact Zac' });
  }

  // ── Build live context ──────────────────────────────────────
  const mt      = getMTContext();
  const truck   = computeTruckStatus(schedule);
  const nextJob = getNextJobContext(schedule, mt.totalMins);

  // Format leads for system prompt
  const leadsText = leads.length === 0
    ? 'No leads in database.'
    : leads.slice(0, 30).map((l, i) => {
        const name    = l.name || l.full_name || l.customerName || 'Unknown';
        const phone   = l.phone || l.customerPhone || '—';
        const status  = l.status || 'new';
        const amount  = l.quoteAmount || l.amount || '—';
        const service = l.services || l.serviceType || '—';
        const date    = l.scheduledDate || l.preferredDate || '—';
        const notes   = l.notes ? ` | ${l.notes}` : '';
        return `Lead ${i + 1}: ${name}, ${phone}, status: ${status}, quote: ${amount}, service: ${service}, date: ${date}${notes}`;
      }).join('\n');

  const userLabel = {
    TylerG: 'Tyler (lead handler — office/phone)',
    ZacB:   'Zac (owner)',
    AlexK:  'Alex (field operator — on-site)',
  }[user] || `${user} (field)`;

  // Dump status string
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

  // Next job string
  const nextJobStr = nextJob
    ? `Next job: ${nextJob.name} in ${fmtMins(nextJob.minsUntil)} (starts at ${nextJob.job.timeWindow || nextJob.job.scheduledTime})`
    : 'No more jobs scheduled after this point today.';

  // ── System prompt ───────────────────────────────────────────
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

=== LEADS / PIPELINE (${leads.length} total) ===
${leadsText}

=== EGC FIELD SOPs v1.0 ===
${EGC_SOPS}

=== INSTRUCTIONS ===
You have FOUR sources of information to answer questions:
1. Current Mountain Time (above) — use this for ALL time questions. You know exactly what time it is.
2. Today's schedule (above) — use this for scheduling, timing, and "am I on track" questions.
3. Truck status (above) — use this for ALL capacity questions.
4. EGC Field SOPs — use this for procedure questions.

CRITICAL RULES:

ITEM ACCEPTANCE — HIGHEST PRIORITY RULE:
For ANY question about whether to accept, take, haul, or transport a specific item type —
if that item is NOT explicitly listed in the SOPs as an approved item to haul, you MUST respond:
"Not explicitly covered in SOPs — text Zac at 415-818-2648 to confirm before accepting. I'll log this for the next SOP update."
DO NOT infer permission from the absence of restriction. If the SOPs don't explicitly say "we take X," the answer is NOT automatically yes.
Always defer on (non-exhaustive list): mattresses, tires, refrigerators, freezers, TVs, electronics, propane tanks, paint, chemicals, ammunition, firearms, medications, medical waste, asbestos, hot tubs, pianos.
This rule overrides everything else. No exceptions.

TIME / SCHEDULE / CAPACITY RULES:
- For time questions ("what time is it", "how long until my next job"): compute from live data above. NEVER say "not in the SOPs."
- For schedule questions ("am I on track", "can I fit a dump run"): use schedule + current time to do the math. NEVER say "not in the SOPs."
- For capacity questions ("can I take more stuff", "how much room do I have"): use Truck Status above. NEVER say "not in the SOPs."
- For dump timing questions: use dump status + current time. NEVER say "not in the SOPs."
- ONLY use "Not in the SOPs — text Zac" for genuinely novel situations not covered by SOPs OR live data (medical emergencies, legal disputes, customer threats, etc.).

ANSWER FORMAT (use this every time):
ACTION: [specific action in 1-2 sentences]
SCRIPT (if a customer text is needed): [exact text, ready to copy-paste]
BASIS: [which SOP section OR which live context data this is based on]`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(Array.isArray(history) ? history : []).slice(-8).filter(m => m?.role && m?.content),
    { role: 'user', content: query.trim() },
  ];

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.openaiapi}`,
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
      return res.status(502).json({ error: 'AI error — try again in a moment' });
    }

    const data   = await r.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) return res.status(502).json({ error: 'Empty response from AI' });

    return res.status(200).json({ answer, tokens: data.usage?.total_tokens });

  } catch (e) {
    console.error('Fetch error:', e);
    return res.status(500).json({ error: 'Network error — try again' });
  }
}
