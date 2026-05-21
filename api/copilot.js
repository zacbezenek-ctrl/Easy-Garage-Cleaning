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

function getMountainTime() {
  const now  = new Date();
  const opts = { timeZone: 'America/Denver' };
  const date = now.toLocaleDateString('en-US',  { ...opts, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString('en-US',  { ...opts, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `${date} · ${time}`;
}

function getTimeFlags() {
  const now    = new Date();
  const mtHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Denver', hour: '2-digit', hour12: false }), 10);
  const mtDay  = now.toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'long' });
  const flags  = [];

  if (mtDay === 'Sunday') {
    flags.push('⚠️  SUNDAY — Larimer County Landfill and Timberline Recycling CLOSED. No dump runs possible today.');
  }

  const dumpHoursLeft = Math.max(0, 16 - mtHour);
  if (dumpHoursLeft <= 2 && dumpHoursLeft > 0) {
    flags.push(`⏰  Larimer County dump closes in ~${dumpHoursLeft} hour(s). Fort Collins Transfer open until 6 PM.`);
  } else if (mtHour >= 16) {
    flags.push('🚫  Larimer County Landfill closed for today. Fort Collins Transfer Station open until 6 PM.');
  }

  if (mtHour >= 17) {
    flags.push('🕔  Past 5 PM — Done by Dinner deadline. Wrap up and confirm completion with customer.');
  }

  return flags.length ? flags.join('\n') : 'No time-sensitive flags.';
}

function formatSchedule(jobs) {
  if (!jobs || jobs.length === 0) return 'No jobs scheduled today.';
  return jobs.map((j, i) => {
    const parts = [
      `JOB ${i + 1}: ${j.customerName || j.name || 'Unknown'}`,
      `  Address:    ${j.address || j.customerAddress || 'Not set'}`,
      `  Window:     ${j.timeWindow || j.scheduledTime || j.scheduledDate || 'TBD'}`,
      `  Est. cu yd: ${j.cubicYards || 'Unknown'}`,
      `  Quote:      ${j.amount || j.quoteAmount || 'Unknown'}`,
      `  Phone:      ${j.customerPhone || j.phone || 'Not set'}`,
      `  Status:     ${j.status || 'scheduled'}`,
    ];
    if (j.notes)         parts.push(`  Notes:      ${j.notes}`);
    if (j.depositAmount) parts.push(`  Deposit:    ${j.depositAmount} required`);
    return parts.join('\n');
  }).join('\n\n');
}

export default async function handler(req, res) {
  // CORS — same origin only (easygaragecleaning.com)
  const origin = req.headers.origin || '';
  const allowed = /easygaragecleaning\.com$/.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin);
  res.setHeader('Access-Control-Allow-Origin',  allowed ? origin : 'https://easygaragecleaning.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { user = 'field', query, schedule = [], history = [] } = req.body || {};

  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' });

  if (!process.env.openaiapi) {
    console.error('openaiapi not set in Vercel environment variables');
    return res.status(500).json({ error: 'Server misconfigured — contact Zac' });
  }

  const userLabel = {
    TylerG: 'Tyler (lead handler — office/phone)',
    ZacB:   'Zac (owner)',
    AlexK:  'Alex (field operator — on-site)',
  }[user] || `${user} (field)`;

  const systemPrompt = `You are the EGC Field Co-Pilot — a real-time operations assistant for Easy Garage Cleaning in Fort Collins, CO. Alex and Tyler use you on their phones during the workday.

CORE RULES — follow every one, every response:
1. Give a specific action, not a list of considerations.
2. If the answer requires customer communication, write the exact text to send. Format it as:
   SEND THIS:
   [exact message ready to copy-paste, with [Name] bracketed where needed]
3. End every answer with the SOP reference: [SOP 1], [SOP 4 Trigger A], etc.
4. If the question is NOT covered by the SOPs or schedule context, say exactly:
   "Not in the SOPs — text Zac. I'll note this for the next SOP update." Do NOT invent procedure.
5. Keep the non-script portion under 60 words. Scripts can be as long as needed.
6. If safety is at risk, say so first.

LOGGED IN: ${userLabel}
MOUNTAIN TIME: ${getMountainTime()}

TIME FLAGS:
${getTimeFlags()}

TODAY'S SCHEDULE:
${formatSchedule(schedule)}

EGC FIELD SOPs v1.0:
${EGC_SOPS}`;

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
        max_tokens:  700,
        temperature: 0.25,
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
