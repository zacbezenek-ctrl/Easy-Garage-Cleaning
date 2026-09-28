/**
 * EGC Website Lead relay — Cloudflare Pages Function
 * POST /api/web-lead
 *
 * The quote forms POST natively to Web3Forms (the email leg). fb-capture.js
 * mirrors the same submission here. This function writes the lead directly to
 * HighLevel, then forwards it to the existing Zapier instant-text/CAPI hook.
 *
 * The Zap then fires the team SMS alert + Meta CAPI Lead, and — once you add an
 * "AI by Zapier" step + an OpenPhone "Send Message" step — texts the lead back
 * in Tyler's voice, exactly like the Facebook flow (which uses Zapier's free
 * built-in AI and your existing OpenPhone connection — no API keys anywhere).
 *
 * To make that Zap setup trivial, the relay hands it three ready-to-use fields:
 *   lead_first_name  — first name only (for the greeting)
 *   lead_timing      — "in-hours" or "out-of-hours" (Mon–Sat 07:00–19:00 MT),
 *                      computed server-side so the AI step needs no Formatter
 *   lead_phone_e164  — the lead's number in +1XXXXXXXXXX form (OpenPhone "To")
 * plus the usual name/phone/items/source/subject and Meta fbc/fbp/fbclid.
 * Only leads that checked the SMS consent box are ever sent to the hook.
 *
 * HighLevel write order (every step after the contact upsert is non-fatal):
 *   1. POST /contacts/upsert           name/phone/email/postalCode/city only —
 *                                      never the source or owner, so an existing
 *                                      contact keeps its first-touch attribution
 *   2. PUT  /contacts/{id}             source + owner, new/ownerless contacts only
 *   3. GET  /opportunities/search      the contact's opportunities in the pipeline:
 *                                      one open past New Lead, or won, is left
 *                                      alone (tag egc-repeat-inquiry); a failed
 *                                      search writes no opportunity (tag
 *                                      egc-needs-triage); job-applicant contacts
 *                                      are not searched and get no opportunity
 *   4. DELETE /contacts/{id}/tags      the opposite consent tag and state tags
 *                                      that no longer apply — before any add
 *      POST /contacts/{id}/tags        identity tags (egc-website-lead, consent,
 *                                      egc-svc-*, egc-src-*, egc-ch-*, egc-item-*,
 *                                      egc-out-of-area, egc-repeat-inquiry,
 *                                      egc-needs-triage) in one request
 *   5. PUT  /contacts/{id}             Lead Product / What do you need help with /
 *                                      Campaign, plus Lead Source on first touch
 *   6. POST /contacts/{id}/notes       the lead details note
 *   7. POST /opportunities/upsert      New Lead stage, estimated value, source
 *   8. PUT  /opportunities/{id}        Opp GCLID / Lead Source / UTM fields
 * No tag that starts an existing HighLevel workflow is ever added here.
 *
 * Config (Cloudflare Pages → Variables and Secrets, PRODUCTION):
 *   WEBSITE_LEAD_HOOK_URL — Zapier Catch Hook URL.
 *   HIGHLEVEL_API_KEY, HIGHLEVEL_LOCATION_ID — HighLevel (required for CRM sync)
 *   HIGHLEVEL_PIPELINE_ID, HIGHLEVEL_NEW_LEAD_STAGE_ID, HIGHLEVEL_USER_ID — optional
 *   HIGHLEVEL_INTAKE_TAG — optional extra tag for website leads that checked the
 *                          SMS consent box (off unless set; it may start a texting
 *                          workflow, so it is never added without consent)
 */

const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const MAX_BODY = 32 * 1024;
const FIELDS = ['name', 'phone', 'email', 'items', 'service_type', 'job_size', 'what_to_remove', 'photo_description', 'source', 'subject', 'city', 'serviceZip', 'preferred_date', 'preferred_timing', 'booking_slot', 'estimated_range', 'flow_type', 'sms_consent', 'request_id', 'fbc', 'fbp', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'landing_url', 'referrer', 'page_url', 'page_service', 'page_variant', 'in_service_area'];
const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';

// In-area ZIPs for the 7 service towns — the one list in this file.
const SERVICE_AREA_ZIPS = new Set([
  '80521', '80522', '80523', '80524', '80525', '80526', '80527', '80528', // Fort Collins
  '80537', '80538', '80539', // Loveland
  '80550', '80551', // Windsor (80550 also covers part of Severance)
  '80547', // Timnath
  '80549', // Wellington
  '80546', // Severance
  '80535', // LaPorte
]);

// HighLevel custom field IDs (location KlgLwRaQSPz5G1YXsmc6).
const CONTACT_FIELD = {
  leadProduct: '4yHT0EBBt4nYxeZT6M6D', // SINGLE_OPTIONS: Garage Cleanout | Junk Pickup
  leadSource: 'IVtks5sLi8Xi79B81kze', // SINGLE_OPTIONS — first touch only
  campaign: 'IKhn620CwInVv30h04Gm', // TEXT
  helpWith: 'zdiv0Kh93i1s8UiOyhS9', // TEXT — "What do you need help with"
};
const OPPORTUNITY_FIELD = {
  gclid: '6QIVCGxYtFx3lrEaj6CM',
  leadSource: '9bLDZpTKoBch8Xk3OFPu',
  utmSource: 'xOENZM7WDXoH8ViivIYL',
  utmCampaign: '43RqKb4zAt1c4IUolFXS',
};

// Tags that start existing HighLevel workflows. The relay never adds these.
export const WORKFLOW_TRIGGER_TAGS = new Set(['jr', 'fb-garage-quote-active', 'gc-quote-open', 'gc-quote-cold', 'egc-junk-sales-exit', 'egc-garage-sales-exit', 'egc-review-requested', 'egc-review-ready', 'active-sequence', 'mct-texted-today']);

/* ---------------- Lead classification (pure helpers) ---------------- */

const SERVICE_LABELS = {
  'single-item': 'Single item',
  furniture: 'Furniture removal',
  mattress: 'Mattress removal',
  appliance: 'Appliance removal',
  'fridge-freon': 'Refrigerator / freon appliance',
  exercise: 'Exercise equipment removal',
  curbside: 'Curbside pickup',
  'hot-tub': 'Hot tub removal',
  shed: 'Shed / playset removal',
  yard: 'Yard debris removal',
  construction: 'Construction debris removal',
  estate: 'Estate cleanout',
  hoarder: 'Hoarder cleanout',
  basement: 'Basement / attic cleanout',
  storage: 'Storage unit cleanout',
  commercial: 'Commercial / property cleanout',
  'garage-cleanout': 'Garage cleanout',
  'garage-cleaning': 'Garage cleaning',
  'garage-org': 'Garage organization',
  'few-items': 'A few items',
  'partial-load': 'Partial load',
  other: 'Junk removal (not specified)',
};
const GARAGE_LINE = new Set(['garage-cleanout', 'garage-cleaning', 'garage-org']);
const SINGLE_ITEM_FAMILY = new Set(['furniture', 'mattress', 'appliance', 'fridge-freon', 'exercise']);

// Ordered: the first rule that matches a field wins. Distinct job types come
// before item words, "garage cleanout" before "garage cleaning", and
// realtor / real estate (commercial) before estate.
const SERVICE_RULES = [
  ['hoarder', /\bhoard(?:er|ers|ing)?\b/],
  ['commercial', /\b(?:commercial|business(?:es)?|office\s+(?:clean\w*|move\w*|space|building)|retail|warehouse|restaurant|real\s*estate|realtors?|property\s+(?:manag\w*|clean\w*)|landlords?|tenants?|rental\s+(?:turnover|unit|property))\b/],
  ['estate', /\bestates?\b|\bdownsiz\w*|\bprobate\b/],
  ['hot-tub', /\bhot[\s-]?tubs?\b|\bjacuzzis?\b|\bspas?\b/],
  ['garage-org', /\borgani[sz]\w*|\bshelv\w*|\boverhead\s+(?:rack|storage)\w*|\bmakeover\b|\btransformation\b|\bturnaround\b/],
  ['garage-cleanout', /\bgarage\s*(?:clean[\s-]?outs?|clear[\s-]?outs?|junk|haul\w*)\b|\bclean[\s-]?out\s+(?:of\s+)?(?:my\s+|the\s+|our\s+)?garage\b|\bgarage\s*(?:\+|&|and|or)\s*(?:full|other)\b|\bfull\s+(?:garage|space\s+cleanout|cleanout)\b|\b(?:\d|single|one|two|three)[\s-]?car\b|\b(?:large|medium|small|full|packed)\s+garage\b/],
  ['garage-cleaning', /\bgarage\s+cleaning\b|\bdeep[\s-]?clean\w*|\bpressure[\s-]?wash(?:ing)?\b|\bfloor\s+(?:clean\w*|wash\w*)/],
  ['shed', /\bsheds?\b|\bplay\s*sets?\b|\bswing\s*sets?\b|\btrampolines?\b/],
  ['yard', /\b(?:back)?yards?\b|\bbrush\b|\bbranch\w*|\blimbs?\b|\bgreen\s+waste\b|\blandscap\w*|\bstumps?\b/],
  ['construction', /\bconstruction\b|\brenovat\w*|\bremodel\w*|\bdrywall\b|\bdemo(?:lition)?\b|\bdebris\b|\blumber\b|\bshingles?\b|\bconcrete\b/],
  ['basement', /\bbasements?\b|\battics?\b|\bcrawl\s*spaces?\b/],
  ['storage', /\bstorage\b/],
  ['fridge-freon', /\bfridges?\b|\brefrigerat\w*|\bfreezers?\b|\bfreon\b|\b(?:a\/c|ac)\s+units?\b|\bair\s+condition\w*|\bdehumidif\w*|\bwine\s+coolers?\b/],
  ['appliance', /\bappliances?\b|\bwashers?\b|\bdryers?\b|\bwashing\s+machines?\b|\bstoves?\b|\bovens?\b|\bdishwashers?\b|\bwater\s+heaters?\b|\bmicrowaves?\b/],
  ['mattress', /\bmattress\w*|\bbox[\s-]?springs?\b|\bbed\s*frames?\b/],
  ['exercise', /\btreadmills?\b|\belliptical\w*|\bexercise\b|\bgym\s+equipment\b|\bhome\s+gym\b|\bweight\s+(?:bench|set|machine|rack)\w*|\bpeloton\b|\bstationary\s+bike\b|\browing\s+machines?\b/],
  ['furniture', /\bcouch\w*|\bsofas?\b|\bsectionals?\b|\bloveseats?\b|\brecliners?\b|\bfurniture\b|\bdressers?\b|\barm\s*chairs?\b|\bchairs?\b|\btables?\b|\bdesks?\b|\bcabinets?\b|\bpianos?\b|\bfutons?\b|\bbookcases?\b|\bentertainment\s+cent(?:er|re)s?\b/],
  ['curbside', /\bcurb[\s-]?side\b|\bcurb\b/],
  ['few-items', /\bfew\s+items?\b|\bcouple\s+(?:of\s+)?items\b|\b2\s*[–—-]\s*5\s+items\b|\bsmall\s+load\b/],
  ['partial-load', /\bpartial\b|\bhalf[\s-]?(?:a\s+)?(?:truck|load|garage)\b|\bquarter[\s-]?(?:truck|load)\b|\bsmall[\s_-]?(?:plus|light)\b/],
  ['single-item', /\bsingle(?:[\s-]items?)?\b|\bone\s+(?:bulky\s+)?item\b|\b1\s+item\b/],
  ['garage-cleanout', /\bgarage\b/],
];

function pathOf(value) {
  try { return new URL(String(value || '')).pathname || ''; } catch { return ''; }
}

function serviceText(value) {
  let text = String(value || '').toLowerCase();
  if (/^\//.test(text)) {
    try { text = decodeURIComponent(text); } catch {}
    text = text.replace(/\.html?$/, '').replace(/[/_-]+/g, ' ');
  }
  // The business name is not a service request; "garage / estate" is a size.
  return text.replace(/easy\s*garage\s*cleaning(?:\.com)?/g, ' ').replace(/garage\s*\/\s*estate/g, 'full garage').trim();
}

function matchService(value) {
  const text = serviceText(value);
  if (!text) return '';
  for (const [slug, re] of SERVICE_RULES) if (re.test(text)) return slug;
  return '';
}

function serviceResult(slug) {
  const garage = GARAGE_LINE.has(slug);
  return { slug, line: garage ? 'garage' : 'junk', leadProduct: garage ? 'Garage Cleanout' : 'Junk Pickup', label: SERVICE_LABELS[slug] || SERVICE_LABELS.other };
}

// Maps whatever the form sent to one of the fixed service slugs. Fields are
// read most-specific first; a generic "single item" is refined by a later field
// that names the item (e.g. "Single item" on the couch variant → furniture).
function matchLeadService(lead) {
  const fields = [lead.service_type, lead.page_service, lead.items, lead.what_to_remove, lead.job_size, pathOf(lead.page_url), pathOf(lead.landing_url), lead.subject];
  for (let i = 0; i < fields.length; i++) {
    const slug = matchService(fields[i]);
    if (!slug) continue;
    if (slug === 'single-item') {
      for (const later of fields.slice(i + 1)) {
        const refined = matchService(later);
        if (SINGLE_ITEM_FAMILY.has(refined)) return serviceResult(refined);
      }
    }
    return serviceResult(slug);
  }
  return serviceResult('other');
}

export function normalizeService(lead = {}) {
  const service = matchLeadService(lead);
  // The Google Ads landing page sells junk removal only, so a garage haul
  // booked there is a junk job (the slug keeps the detail for reporting).
  if (service.line === 'garage' && deriveChannel(lead) === 'gads-lp') return { ...service, line: 'junk', leadProduct: 'Junk Pickup' };
  return service;
}

const SERVICE_VALUES = {
  'single-item': 125, furniture: 125, mattress: 125, appliance: 125, 'fridge-freon': 125, exercise: 125, curbside: 125,
  'few-items': 325, 'partial-load': 325,
  'hot-tub': 600,
  shed: 400, yard: 400, construction: 400,
  estate: 525, hoarder: 525, basement: 525, storage: 525, 'garage-cleanout': 525, commercial: 525,
  'garage-cleaning': 650, 'garage-org': 650,
  other: 250,
};

function dollars(raw) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 && n <= 50000 ? n : 0;
}

function priceFrom(value) {
  const text = String(value || '');
  const range = /\$\s*([\d,]+)(?:\.\d+)?\s*(?:–|—|-|to)\s*\$?\s*([\d,]+)/i.exec(text);
  const plus = /\$\s*([\d,]+)(?:\.\d+)?\s*\+/.exec(text);
  if (range && (!plus || range.index <= plus.index)) {
    const low = dollars(range[1]), high = dollars(range[2]);
    if (low && high >= low) return Math.round((low + high) / 2);
  }
  if (plus) {
    const low = dollars(plus[1]);
    if (low) return low + 150; // "$650+" → 800
  }
  return 0;
}

// Estimated opportunity value: the price range the lead saw, else a
// service default from the published ranges.
export function valueFor(lead = {}, service = normalizeService(lead)) {
  for (const key of ['job_size', 'estimated_range', 'items']) {
    const value = priceFrom(lead[key]);
    if (value) return value;
  }
  return SERVICE_VALUES[service && service.slug] || SERVICE_VALUES.other;
}

const SOURCE_LABELS = {
  'google-ads': 'Google Paid',
  'google-organic': 'Google Organic',
  'meta-ads': 'Facebook Paid',
  'meta-organic': 'Facebook Organic',
  nextdoor: 'Nextdoor',
  gbp: 'Google Business Profile',
  referral: 'Referral',
  direct: '',
};
const PAID_MEDIUM = /^(?:cpc|ppc|cpm|cpv|paid|paid[\s_-]?(?:social|search|media|ads?)|ads?|display|sponsored|retargeting)$/;
const META_SOURCE = /^(?:facebook|instagram|fb|ig|meta)$/;
const ORGANIC_MEDIUM = /^(?:organic|social|post|profile|bio|referral)$/;

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

// Returns { key, label }: key feeds the egc-src-* tag, label is the HighLevel
// Lead Source option ('' for direct traffic).
export function deriveLeadSource(lead = {}) {
  const source = String(lead.utm_source || '').trim().toLowerCase();
  const medium = String(lead.utm_medium || '').trim().toLowerCase();
  const paid = PAID_MEDIUM.test(medium);
  const referrer = hostOf(lead.referrer).toLowerCase();
  let key = 'direct';
  if (lead.gclid || lead.gbraid || lead.wbraid || (/^(?:google|adwords|google[\s_-]?ads)$/.test(source) && paid)) key = 'google-ads';
  else if ((lead.fbclid && !(META_SOURCE.test(source) && ORGANIC_MEDIUM.test(medium))) || (META_SOURCE.test(source) && paid)) key = 'meta-ads';
  else if (source === 'nextdoor' || /(?:^|\.)nextdoor\.com$/.test(referrer)) key = 'nextdoor';
  else if (/^(?:gbp|gmb|google[\s_-]?business(?:[\s_-]?profile)?)$/.test(source) || /^(?:gbp|gmb)$/.test(medium)) key = 'gbp';
  else if (META_SOURCE.test(source)) key = 'meta-organic';
  else if (source === 'google') key = 'google-organic';
  else if (source === 'referral' || medium === 'referral') key = 'referral';
  else if (/(?:^|\.)google\./.test(referrer)) key = 'google-organic';
  else if (/(?:^|\.)(?:facebook|instagram)\.com$/.test(referrer)) key = 'meta-organic';
  return { key, label: SOURCE_LABELS[key] };
}

// Which form/page produced the lead → egc-ch-* tag.
export function deriveChannel(lead = {}) {
  const source = String(lead.source || '').trim();
  const path = pathOf(lead.page_url) || pathOf(lead.landing_url);
  if (/^google-junk-lp$/i.test(source) || /google\s*ads\s*lp/i.test(source) || /^\/junk-removal-quote(?:\.html)?\/?$/i.test(path)) return 'gads-lp';
  if (/\bads\b/i.test(source) || /^\/ads(?:\.html)?\/?$/i.test(path)) return 'meta-lp';
  if (lead.flow_type === 'walkthrough' && /^\/book(?:\.html)?\/?$/i.test(path)) return 'book';
  return 'web';
}

function zipOf(value) {
  const match = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(String(value || ''));
  return match ? match[1] : '';
}

// ZIP-based service area check. A known ZIP outside the list, or the page's
// own "no", marks the lead out of area.
export function serviceArea(lead = {}) {
  const zip = zipOf(lead.serviceZip);
  const claimed = String(lead.in_service_area || '').trim().toLowerCase();
  const outOfArea = claimed === 'no' || Boolean(zip && !SERVICE_AREA_ZIPS.has(zip));
  const status = outOfArea ? 'no' : (zip || claimed === 'yes') ? 'yes' : 'unknown';
  return { zip, status, outOfArea };
}

function cleanTag(value) {
  const tag = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9 _:-]{0,60}$/.test(tag) ? tag : '';
}

// Identity tags for a (non client-hub) website lead. The optional intake tag
// is filtered like every other tag: a configured workflow trigger is dropped.
export function leadTags(lead = {}, { consentTag, service = normalizeService(lead), origin = deriveLeadSource(lead), channel = deriveChannel(lead), area = serviceArea(lead), applicant = false, repeat = false, triage = false, intakeTag = '' } = {}) {
  const intake = lead.sms_consent === 'yes' ? cleanTag(intakeTag) : '';
  const tags = [
    'egc-website-lead',
    consentTag || (lead.sms_consent === 'yes' ? 'egc-sms-consent' : 'egc-no-sms-consent'),
    `egc-svc-${service.line}`,
    `egc-src-${origin.key}`,
    `egc-ch-${channel}`,
    `egc-item-${service.slug}`,
    ...(area.outOfArea ? ['egc-out-of-area'] : []),
    ...(repeat ? ['egc-repeat-inquiry'] : []),
    ...(applicant || triage ? ['egc-needs-triage'] : []),
    ...(intake ? [intake] : []),
  ];
  return [...new Set(tags.filter(tag => !WORKFLOW_TRIGGER_TAGS.has(tag)))];
}

// State tags describe this request only. One that no longer applies is
// removed (before the new tags land) so a stale ZIP typo, an old quote or a
// resolved triage never keeps a later inquiry out of the speed-to-lead text.
// Unknown state (no ZIP, no search) leaves the tag alone.
export function staleStateTags({ contactTags = null, area = { status: 'unknown' }, searched = false, repeat = false, triage = false } = {}) {
  const has = tag => !contactTags || contactTags.includes(tag);
  const stale = [];
  if (area.status === 'yes' && has('egc-out-of-area')) stale.push('egc-out-of-area');
  if (searched && !repeat && has('egc-repeat-inquiry')) stale.push('egc-repeat-inquiry');
  // Only with the contact's real tags: an unknown tag list could hide an applicant.
  if (searched && !triage && contactTags && contactTags.includes('egc-needs-triage')) stale.push('egc-needs-triage');
  return stale;
}

function helpSummary(lead, service) {
  const parts = [];
  for (const value of [lead.items, lead.what_to_remove]) {
    const text = String(value || '').trim();
    if (text && !parts.some(part => part.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  return (parts.join(' — ') || service.label).slice(0, 500);
}

function gclidValue(lead) {
  if (lead.gclid) return lead.gclid;
  if (lead.gbraid) return `gbraid:${lead.gbraid}`;
  if (lead.wbraid) return `wbraid:${lead.wbraid}`;
  return '';
}

function customField(id, value) {
  const text = String(value || '').trim();
  return text ? [{ id, field_value: text }] : [];
}

/* ---------------- HighLevel transport ---------------- */

// Read an env var tolerant of stray whitespace in the NAME — a dashboard var
// saved as "WEBSITE_LEAD_HOOK_URL " (trailing space) is a silent footgun: it's
// present but env.WEBSITE_LEAD_HOOK_URL reads undefined. Prefer the exact key;
// otherwise match any key that trims to the requested name.
function envVar(env, name) {
  if (env && env[name]) return env[name];
  for (const k of Object.keys(env || {})) {
    if (k.trim() === name && env[k]) return env[k];
  }
  return '';
}

function resolveHook(env) {
  return envVar(env, 'WEBSITE_LEAD_HOOK_URL');
}

function highLevelConfig(env) {
  return {
    token: envVar(env, 'HIGHLEVEL_API_KEY') || envVar(env, 'GHL_API_KEY'),
    locationId: envVar(env, 'HIGHLEVEL_LOCATION_ID') || envVar(env, 'GHL_LOCATION_ID'),
    pipelineId: envVar(env, 'HIGHLEVEL_PIPELINE_ID') || envVar(env, 'GHL_PIPELINE_ID'),
    stageId: envVar(env, 'HIGHLEVEL_NEW_LEAD_STAGE_ID') || envVar(env, 'GHL_NEW_LEAD_STAGE_ID'),
    assignedTo: envVar(env, 'HIGHLEVEL_USER_ID') || envVar(env, 'GHL_USER_ID'),
    intakeTag: envVar(env, 'HIGHLEVEL_INTAKE_TAG'),
  };
}

// HighLevel error bodies can echo the matching contact (name/phone); keep only
// the error message text.
function safeDetail(data) {
  const message = data && (data.message || data.error || data.msg);
  return (Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : '').slice(0, 160);
}

async function highLevelRequest(config, path, options = {}) {
  const response = await fetch(HIGHLEVEL_API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Version: 'v3',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HighLevel returned ${response.status}`);
    error.status = response.status;
    error.detail = safeDetail(data);
    throw error;
  }
  return data;
}

function logHighLevel(step, error) {
  console.error(`web-lead: HighLevel ${step} failed`, {
    status: (error && error.status) || 0,
    detail: (error && (error.detail || (!error.status && String(error.message || '').slice(0, 160)))) || '',
  });
}

function stageOf(opportunity) {
  return (opportunity && (opportunity.pipelineStageId || opportunity.stageId || (opportunity.pipelineStage && opportunity.pipelineStage.id))) || '';
}

function rowContactId(row) {
  return (row && (row.contactId || (row.contact && row.contact.id))) || '';
}

// GET /opportunities/search is documented with snake_case filters
// (location_id / contact_id / pipeline_id); functions/api/highlevel.js uses the
// camelCase spelling. Try the documented one first and fall back only when
// HighLevel rejects the query. A response that is not limited to this contact
// cannot answer "does this contact already have a job?", so it counts as a
// failure too. Status "all" also returns won / lost opportunities.
const SEARCH_SPELLINGS = [
  { location: 'location_id', contact: 'contact_id', pipeline: 'pipeline_id' },
  { location: 'locationId', contact: 'contactId', pipeline: 'pipelineId' },
];

async function contactOpportunities(config, contactId) {
  let lastError = null;
  for (const names of SEARCH_SPELLINGS) {
    const params = new URLSearchParams({ [names.location]: config.locationId, [names.contact]: contactId, [names.pipeline]: config.pipelineId, status: 'all', limit: '100', page: '1' });
    try {
      const found = await highLevelRequest(config, `/opportunities/search?${params}`);
      if (!Array.isArray(found.opportunities)) throw new Error('HighLevel opportunity search returned no list');
      if (found.opportunities.some(row => rowContactId(row) !== contactId)) throw new Error('HighLevel opportunity search ignored the contact filter');
      return found.opportunities.filter(row => !row.pipelineId || row.pipelineId === config.pipelineId);
    } catch (error) {
      lastError = error;
      // Auth, rate-limit and server errors are not fixed by the other spelling.
      if (error.status && error.status !== 400 && error.status !== 422) break;
    }
  }
  throw lastError;
}

// An opportunity the upsert must not touch: open past New Lead (quoted,
// scheduled…) or won (a completed job). Lost / abandoned ones are revived.
function blockingOpportunity(rows, newLeadStageId) {
  return rows.find(row => {
    const status = String(row.status || 'open').toLowerCase();
    return status === 'won' || (status === 'open' && stageOf(row) !== newLeadStageId);
  }) || null;
}

export async function syncHighLevelLead(env, lead) {
  const config = highLevelConfig(env);
  if (!config.token || !config.locationId) return { configured: false, synced: false };
  const isClientHubHelp = lead.flow_type === 'client_hub_help';
  const service = normalizeService(lead);
  const origin = deriveLeadSource(lead);
  const channel = deriveChannel(lead);
  const area = serviceArea(lead);
  const estimatedValue = valueFor(lead, service);
  const city = /^other\b/i.test(String(lead.city || '').trim()) ? '' : String(lead.city || '').trim();

  // Upsert identity only. Source and owner are first-touch and set below.
  const contactResult = await highLevelRequest(config, '/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify({
      locationId: config.locationId,
      name: lead.name,
      phone: lead.phone,
      ...(lead.email ? { email: lead.email } : {}),
      ...(area.zip ? { postalCode: area.zip } : {}),
      ...(city ? { city } : {}),
    }),
  });
  const contact = contactResult.contact || {};
  const contactId = contact.id || contactResult.id || '';
  if (!contactId) throw new Error('HighLevel did not return a contact ID');
  const contactPath = `/contacts/${encodeURIComponent(contactId)}`;
  const newness = typeof contactResult.new === 'boolean' ? contactResult.new : null;
  const isNewContact = newness === true;
  const firstTouch = isNewContact || (newness === null && !contact.source);

  const identity = {};
  if (firstTouch) identity.source = lead.source || 'EGC Website';
  if (config.assignedTo && (isNewContact || !contact.assignedTo)) identity.assignedTo = config.assignedTo;
  if (Object.keys(identity).length) {
    try {
      await highLevelRequest(config, contactPath, { method: 'PUT', body: JSON.stringify(identity) });
    } catch (error) { logHighLevel('contact source/owner update', error); }
  }

  const consentTag = lead.sms_consent === 'yes' ? 'egc-sms-consent' : 'egc-no-sms-consent';
  const oppositeConsentTag = consentTag === 'egc-sms-consent' ? 'egc-no-sms-consent' : 'egc-sms-consent';
  const contactTags = Array.isArray(contact.tags) ? contact.tags.map(tag => String(tag)) : null;
  const applicant = !isClientHubHelp && Boolean(contactTags && contactTags.some(tag => /^applicant/i.test(tag.trim())));

  // Pipeline state is read before any tag lands, so egc-repeat-inquiry /
  // egc-needs-triage arrive in the same request as the tags that start the
  // speed-to-lead workflow.
  let stageId = config.stageId;
  let pipelineError = null;
  let opportunitySearch = 'skipped';
  let existing = null;
  if (!isClientHubHelp && config.pipelineId && !applicant) {
    try {
      if (!stageId) {
        const data = await highLevelRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
        const pipeline = (data.pipelines || []).find(item => item.id === config.pipelineId);
        stageId = pipeline && pipeline.stages && pipeline.stages[0] && pipeline.stages[0].id || '';
      }
      if (!stageId) throw new Error('HighLevel new-lead pipeline stage is unavailable');
    } catch (error) { pipelineError = error; }
    if (!pipelineError) {
      try {
        existing = blockingOpportunity(await contactOpportunities(config, contactId), stageId);
        opportunitySearch = 'ok';
      } catch (error) {
        opportunitySearch = 'failed';
        logHighLevel('opportunity search', error);
      }
    }
  }
  const repeat = Boolean(existing);
  // Without a trustworthy search the upsert could drag a quoted or scheduled
  // job back to New Lead, so a person sorts the lead out instead.
  const searchFailed = opportunitySearch === 'failed';

  // Client Hub: the text box is optional and covers that one request, so an
  // unchecked box never denies or strips the contact's consent.
  const tags = isClientHubHelp
    ? ['egc-client-hub-help', ...(lead.sms_consent === 'yes' ? ['egc-sms-consent'] : [])]
    : leadTags(lead, { consentTag, service, origin, channel, area, applicant, repeat, triage: searchFailed, intakeTag: config.intakeTag });
  const stale = isClientHubHelp ? [] : [
    // Latest consent answer wins. Skipped when the upsert shows the contact
    // never had the opposite tag.
    ...(!contactTags || contactTags.includes(oppositeConsentTag) ? [oppositeConsentTag] : []),
    ...staleStateTags({ contactTags, area, searched: opportunitySearch === 'ok', repeat, triage: applicant || searchFailed }),
  ];
  // Removals go first: a contact who just declined texts must never carry the
  // old egc-sms-consent next to a freshly added workflow tag, even briefly.
  if (stale.length) {
    try {
      await highLevelRequest(config, `${contactPath}/tags`, { method: 'DELETE', body: JSON.stringify({ tags: stale }) });
    } catch (error) { logHighLevel('stale tag removal', error); }
  }
  let tagsSynced = false;
  try {
    await highLevelRequest(config, `${contactPath}/tags`, { method: 'POST', body: JSON.stringify({ tags }) });
    tagsSynced = true;
  } catch (error) { logHighLevel('tag add', error); }

  if (!isClientHubHelp) {
    const hasLeadSource = Boolean(Array.isArray(contact.customFields) && contact.customFields.some(field => field && field.id === CONTACT_FIELD.leadSource && (field.value || field.field_value || field.fieldValue)));
    const leadSourceFirstTouch = isNewContact || (newness === null && !hasLeadSource);
    const customFields = [
      ...customField(CONTACT_FIELD.leadProduct, service.leadProduct),
      ...customField(CONTACT_FIELD.helpWith, helpSummary(lead, service)),
      ...customField(CONTACT_FIELD.campaign, lead.utm_campaign),
      ...(leadSourceFirstTouch ? customField(CONTACT_FIELD.leadSource, origin.label) : []),
    ];
    try {
      await highLevelRequest(config, contactPath, { method: 'PUT', body: JSON.stringify({ customFields }) });
    } catch (error) { logHighLevel('contact custom fields', error); }
  }

  const pipelineCheck = repeat ? `existing ${String(existing.status || 'open').toLowerCase()} opportunity left alone (egc-repeat-inquiry)`
    : searchFailed ? 'opportunity search failed, no opportunity written (egc-needs-triage)'
    : applicant ? 'job applicant, no opportunity (egc-needs-triage)'
    : opportunitySearch === 'ok' ? 'no conflicting opportunity' : 'not checked';
  const detailLines = [
    isClientHubHelp ? 'EGC CLIENT HUB HELP REQUEST' : 'EGC WEBSITE LEAD DETAILS',
    `Service: ${lead.service_type || lead.items || '—'}`,
    ...(isClientHubHelp ? [] : [
      `Service (normalized): ${service.label} (${service.slug} · ${service.line})`,
      `Estimated value: $${estimatedValue}`,
    ]),
    `Job size: ${lead.job_size || '—'}`,
    `${isClientHubHelp ? 'Message' : 'Removal request'}: ${lead.what_to_remove || lead.items || '—'}`,
    `Photo description: ${lead.photo_description || '—'}`,
    `Email: ${lead.email || '—'}`,
    `Location: ${[lead.city, lead.serviceZip].filter(Boolean).join(' ') || '—'}`,
    ...(isClientHubHelp ? [] : [`In service area: ${area.status}`]),
    `Preferred date / timing: ${[lead.preferred_date, lead.preferred_timing].filter(Boolean).join(' · ') || '—'}`,
    `Requested slot: ${lead.booking_slot || '—'}`,
    `Estimated range shown: ${lead.estimated_range || '—'}`,
    `Form path: ${lead.flow_type || 'standard'}`,
    `SMS consent checked: ${lead.sms_consent === 'yes' ? 'yes' : 'no'}`,
    `Campaign: ${[lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content].filter(Boolean).join(' · ') || 'direct / unavailable'}`,
    `Search attribution: ${[lead.utm_term, lead.gclid && `gclid ${lead.gclid}`, lead.gbraid && `gbraid ${lead.gbraid}`, lead.wbraid && `wbraid ${lead.wbraid}`, lead.msclkid && `msclkid ${lead.msclkid}`].filter(Boolean).join(' · ') || '—'}`,
    ...(isClientHubHelp ? [] : [
      `Lead source: ${origin.label || 'Direct / unknown'} · channel ${channel}`,
      `Landing variant: ${[lead.page_service && `service ${lead.page_service}`, lead.page_variant && `variant ${lead.page_variant}`, lead.in_service_area && `page in-area ${lead.in_service_area}`].filter(Boolean).join(' · ') || '—'}`,
      `Pipeline check: ${pipelineCheck}`,
    ]),
    `Landing page: ${lead.page_url || lead.landing_url || '—'}`,
  ];
  let noteSynced = false;
  try {
    await highLevelRequest(config, `${contactPath}/notes`, {
      method: 'POST', headers: { 'Idempotency-Key': `${isClientHubHelp ? 'client-hub-help-note' : 'website-lead-details'}:${contactId}:${lead.request_id || lead.booking_slot || lead.preferred_date || 'request'}` },
      body: JSON.stringify({ userId: config.assignedTo || undefined, title: isClientHubHelp ? 'EGC Client Hub Help' : 'EGC Website Lead Details', body: detailLines.join('\n').slice(0, 3000), color: '#F15A24', pinned: isClientHubHelp }),
    });
    noteSynced = true;
  } catch (error) { logHighLevel('note', error); }

  const reportedConsentTag = tags.includes(consentTag) ? consentTag : '';
  const base = { configured: true, synced: true, contactId, contactCreated: isNewContact, consentTag: reportedConsentTag, consentTagSynced: tagsSynced, tagsSynced };
  let internalCommentSynced = false;
  if (isClientHubHelp) {
    try {
      await highLevelRequest(config, '/conversations/messages', {
        method: 'POST',
        headers: { 'Idempotency-Key': `client-hub-help:${contactId}:${lead.request_id || 'request'}` },
        body: JSON.stringify({
          type: 'InternalComment',
          contactId,
          message: `Client hub help request from ${lead.name}: ${lead.what_to_remove || lead.items || '—'}${lead.phone ? `\nPhone: ${lead.phone}` : ''}${lead.email ? `\nEmail: ${lead.email}` : ''}`.slice(0, 1200),
          ...(config.assignedTo ? { userId: config.assignedTo } : {}),
        }),
      });
      internalCommentSynced = true;
    } catch (error) { logHighLevel('internal comment', error); }
    if (!noteSynced && !internalCommentSynced) throw new Error('HighLevel could not store the client hub request');
    return { ...base, opportunityId: '', internalCommentSynced };
  }
  const leadInfo = { service: service.slug, leadSource: origin.label, estimatedValue };
  if (!config.pipelineId) return { ...base, ...leadInfo, opportunityId: '' };
  // Job applicants who also fill a quote form are sorted by a person.
  if (applicant) return { ...base, ...leadInfo, opportunityId: '', needsTriage: true };
  if (pipelineError) throw pipelineError;
  if (repeat) return { ...base, ...leadInfo, opportunityId: existing.id || '', repeatInquiry: true, opportunitySearch };
  if (searchFailed) return { ...base, ...leadInfo, opportunityId: '', needsTriage: true, opportunitySearch };

  const itemName = lead.items || (service.slug === 'other' ? 'Website lead' : service.label);
  const body = {
    pipelineId: config.pipelineId,
    locationId: config.locationId,
    name: `${lead.name} — ${itemName}`,
    pipelineStageId: stageId,
    status: 'open',
    contactId,
    monetaryValue: estimatedValue,
    source: origin.label || 'Website',
    followers: config.assignedTo ? [config.assignedTo] : [],
    isRemoveAllFollowers: false,
    followersActionType: 'add',
    ...(config.assignedTo ? { assignedTo: config.assignedTo } : {}),
  };
  const idempotencyKey = `website-lead:${contactId}:${config.pipelineId}`;
  let result;
  try {
    result = await highLevelRequest(config, '/opportunities/upsert', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
  } catch (error) {
    // If this endpoint ever rejects the optional source field, keep the
    // opportunity rather than lose the lead from the pipeline.
    if (error.status !== 400 && error.status !== 422) throw error;
    logHighLevel('opportunity upsert (retrying without source)', error);
    const { source: _source, ...withoutSource } = body;
    result = await highLevelRequest(config, '/opportunities/upsert', { method: 'POST', headers: { 'Idempotency-Key': `${idempotencyKey}:nosource` }, body: JSON.stringify(withoutSource) });
  }
  const opportunityId = result.opportunity && result.opportunity.id || result.id || '';

  const opportunityFields = [
    ...customField(OPPORTUNITY_FIELD.gclid, gclidValue(lead)),
    ...customField(OPPORTUNITY_FIELD.leadSource, origin.label),
    ...customField(OPPORTUNITY_FIELD.utmSource, lead.utm_source),
    ...customField(OPPORTUNITY_FIELD.utmCampaign, lead.utm_campaign),
  ];
  if (opportunityId && opportunityFields.length) {
    try {
      await highLevelRequest(config, `/opportunities/${encodeURIComponent(opportunityId)}`, { method: 'PUT', body: JSON.stringify({ customFields: opportunityFields }) });
    } catch (error) { logHighLevel('opportunity custom fields', error); }
  }
  return { ...base, ...leadInfo, opportunityId, opportunitySearch };
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && !referer) return true;
  return ALLOWED_HOST_RE.test(hostOf(origin) || hostOf(referer));
}

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 11) return '+' + d;
  return '';
}

// Mon–Sat 07:00–19:00 Mountain. Fails to "in-hours" (better to promise a call
// "in a couple minutes" than to wrongly promise tomorrow).
function leadTiming() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday').value;
    let hr = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    if (hr === 24) hr = 0;
    return (wd !== 'Sun' && hr >= 7 && hr < 19) ? 'in-hours' : 'out-of-hours';
  } catch { return 'in-hours'; }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // Honeypot tripped — answer success so bots learn nothing, forward nothing.
  if (body.botcheck) return json(200, { ok: true });

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || phone.replace(/\D/g, '').length < 7) {
    return json(400, { ok: false, error: 'name and phone required' });
  }

  const hook = resolveHook(env);

  const params = new URLSearchParams();
  const flat = {};
  for (const k of FIELDS) {
    const v = String(body[k] || '').trim();
    flat[k] = v;
    if (v) params.set(k, v);
  }
  // Ready-to-map fields for the Zap's AI + OpenPhone steps.
  const extras = {
    lead_first_name: name.split(/\s+/)[0] || '',
    lead_timing: leadTiming(),
    lead_phone_e164: normalizePhone(phone),
  };
  for (const [k, v] of Object.entries(extras)) {
    flat[k] = v;
    if (v) params.set(k, v);
  }

  // A HighLevel outage must not also drop the (consented) text relay.
  let highlevel;
  let highlevelFailed = false;
  try { highlevel = await syncHighLevelLead(env, { ...flat, name, phone, source: flat.source || 'EGC Website' }); }
  catch (error) {
    highlevelFailed = true;
    logHighLevel('lead sync', error);
    highlevel = { configured: true, synced: false, consentTagSynced: false, tagsSynced: false };
  }
  // The Client Hub tells the customer "the team can see it in HighLevel", so a
  // failed sync must fail visibly (and relay nothing, so a retry never texts twice).
  if (highlevelFailed && flat.flow_type === 'client_hub_help') return json(502, { ok: false, error: 'HighLevel lead sync failed' });

  // Consent gate: only leads that checked the SMS box ever reach the hook.
  const relayAllowed = flat.sms_consent === 'yes';
  let relay = { configured: !!hook, sent: false, skipped: hook && !relayAllowed ? 'no-sms-consent' : '' };
  if (hook && relayAllowed) {
    try {
      const resp = await fetch(hook + (hook.includes('?') ? '&' : '?') + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flat),
      });
      relay = { configured: true, sent: resp.ok };
    } catch { relay = { configured: true, sent: false }; }
  }
  if (highlevelFailed && !relay.sent) return json(502, { ok: false, error: 'HighLevel lead sync failed', relay });
  if (!highlevel.configured && !relay.sent) return json(503, { ok: false, error: 'Lead destinations are not configured' });
  return json(200, {
    ok: true,
    highlevel: {
      configured: highlevel.configured,
      synced: highlevel.synced,
      consentTag: highlevel.consentTag || '',
      consentTagSynced: highlevel.consentTagSynced !== false,
      tagsSynced: highlevel.tagsSynced === true,
    },
    relay,
  });
}

// Health/config probe — reports whether the hook is wired (boolean only).
export async function onRequestGet({ env }) {
  const highlevel = highLevelConfig(env);
  return new Response(JSON.stringify({ ok: true, configured: !!resolveHook(env) || Boolean(highlevel.token && highlevel.locationId), highlevel: Boolean(highlevel.token && highlevel.locationId), relay: !!resolveHook(env) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
