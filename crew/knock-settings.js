/* Every canvassing number lives here so it can change after legal review without a code change.
   The admin Settings screen edits a stored copy (Firestore knock_settings/current); mergeSettings
   lays the stored values over these defaults and rejects anything out of range. */

export const OUTCOMES = Object.freeze(['no_answer', 'not_interested', 'come_back', 'look', 'sold', 'skipped_sign']);

export const OUTCOME_LABELS = Object.freeze({
  no_answer: 'No answer',
  not_interested: 'Not interested',
  come_back: 'Come back',
  look: 'Look',
  sold: 'Sold',
  skipped_sign: 'Skipped (sign)',
});

export const PACKAGES = Object.freeze(['The Works', 'Full Property Reset', 'Garage Transformation', 'Quick Clear']);

export const SALE_STATUSES = Object.freeze(['booked', 'cancelled', 'completed', 'paid']);

export const ROLES = Object.freeze(['knocker', 'lead', 'admin']);

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  // City rules. A neighborhood names one of these keys; a neighborhood whose city has no rule is locked.
  cities: {
    'fort-collins': {
      name: 'Fort Collins',
      timeZone: 'America/Denver',
      latitude: 40.5853,
      longitude: -105.0844,
      startTime: '09:00',
      end: 'sunset',
      sunsetOffsetMinutes: 0,
      warnMinutes: 15,
      graceMinutes: 15,
      requiresPermit: true,
    },
  },
  shift: {
    idleAutoEndHours: 4,
  },
  sale: {
    depositRate: 0.2,
    cancelBusinessDays: 3,
    refundCutoffHours: 24,
    defaultJobStartTime: '08:00',
    // Extra non-business days (YYYY-MM-DD), e.g. Colorado state holidays if legal review adds them.
    extraHolidays: [],
    checklist: [
      { key: 'contractSigned', label: 'Contract signed on this device and emailed to the customer' },
      { key: 'noticesHanded', label: 'Two printed cancellation notices handed to the customer' },
      { key: 'rightToCancelTold', label: 'Customer told about their right to cancel' },
    ],
  },
  commission: {
    rate: 0.25,
    acceleratorEnabled: true,
    acceleratorThreshold: 8000,
    acceleratorRate: 0.3,
    leadOverrideEnabled: true,
    leadOverrideRate: 0.03,
  },
  payroll: {
    trainingHourlyRate: 15.16,
    // Pay periods: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'. Weekly/biweekly count from anchorDate (a Monday).
    period: 'biweekly',
    anchorDate: '2026-10-05',
  },
  plan: {
    doorsPerHour: 14,
    answerRate: 0.35,
    lookRate: 0.08,
    closeRate: 0.22,
    averageTicket: 1600,
    revenuePerHour: 138,
  },
  gate: {
    minimumHours: 40,
    decisionHours: 150,
    goPerHour: 100,
    fixPerHour: 70,
  },
  goBacks: {
    maxAttemptsPerSeason: 3,
    notInterestedRestMonths: 6,
    // Season resets each year on this month-day.
    seasonStart: '01-01',
    // Time-of-day buckets used to suggest a different visit time.
    buckets: [
      { key: 'morning', label: 'Morning', start: '09:00', end: '12:00' },
      { key: 'midday', label: 'Midday', start: '12:00', end: '15:00' },
      { key: 'afternoon', label: 'Late afternoon', start: '15:00', end: '17:00' },
      { key: 'evening', label: 'Evening', start: '17:00', end: '23:59' },
    ],
  },
  coverage: {
    hereNowMinutes: 30,
  },
  map: {
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  integrations: {
    // 'manual' keeps every hand-off on the admin screen. 'stripe' / 'quo' are used only when the
    // server also has STRIPE_SECRET_KEY / QUO_API_KEY configured.
    deposit: 'manual',
    text: 'manual',
    job: 'manual',
    walkthroughUrl: '/crew/gameplan',
  },
});

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function mergeDeep(base, patch) {
  if (!isObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(out[key])) out[key] = mergeDeep(out[key], value);
    else if (value !== undefined) out[key] = structuredClone(value);
  }
  return out;
}

const RATE_FIELDS = [
  ['sale', 'depositRate'], ['commission', 'rate'], ['commission', 'acceleratorRate'], ['commission', 'leadOverrideRate'],
  ['plan', 'answerRate'], ['plan', 'lookRate'], ['plan', 'closeRate'],
];
const POSITIVE_FIELDS = [
  ['shift', 'idleAutoEndHours'], ['sale', 'cancelBusinessDays'], ['sale', 'refundCutoffHours'],
  ['commission', 'acceleratorThreshold'], ['payroll', 'trainingHourlyRate'], ['plan', 'doorsPerHour'],
  ['plan', 'averageTicket'], ['plan', 'revenuePerHour'], ['gate', 'minimumHours'], ['gate', 'decisionHours'],
  ['gate', 'goPerHour'], ['gate', 'fixPerHour'], ['goBacks', 'maxAttemptsPerSeason'], ['goBacks', 'notInterestedRestMonths'],
  ['coverage', 'hereNowMinutes'],
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Returns a list of human-readable problems; empty means valid.
export function validateSettings(settings) {
  const problems = [];
  for (const [group, key] of RATE_FIELDS) {
    const value = settings?.[group]?.[key];
    if (!(typeof value === 'number' && value >= 0 && value <= 1)) problems.push(`${group}.${key} must be a fraction between 0 and 1`);
  }
  for (const [group, key] of POSITIVE_FIELDS) {
    const value = settings?.[group]?.[key];
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) problems.push(`${group}.${key} must be a positive number`);
  }
  if (!(settings?.gate?.goPerHour > settings?.gate?.fixPerHour)) problems.push('gate.goPerHour must be above gate.fixPerHour');
  if (!(settings?.gate?.decisionHours >= settings?.gate?.minimumHours)) problems.push('gate.decisionHours must be at least gate.minimumHours');
  for (const [key, city] of Object.entries(settings?.cities || {})) {
    if (!/^[a-z0-9-]{2,40}$/.test(key)) problems.push(`city key "${key}" must be lowercase letters, digits and dashes`);
    if (!TIME.test(city?.startTime || '')) problems.push(`${key}.startTime must be HH:MM`);
    if (city?.end !== 'sunset' && !TIME.test(city?.end || '')) problems.push(`${key}.end must be "sunset" or HH:MM`);
    if (!(Math.abs(Number(city?.latitude)) <= 90 && Math.abs(Number(city?.longitude)) <= 180)) problems.push(`${key} needs a latitude and longitude`);
    for (const field of ['warnMinutes', 'graceMinutes']) if (!(Number(city?.[field]) >= 0 && Number(city?.[field]) <= 120)) problems.push(`${key}.${field} must be 0-120`);
    try { new Intl.DateTimeFormat('en-US', { timeZone: city?.timeZone }); } catch { problems.push(`${key}.timeZone is not a valid time zone`); }
  }
  if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(settings?.payroll?.period)) problems.push('payroll.period must be weekly, biweekly, semimonthly or monthly');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings?.payroll?.anchorDate || '')) problems.push('payroll.anchorDate must be YYYY-MM-DD');
  if (!/^\d{2}-\d{2}$/.test(settings?.goBacks?.seasonStart || '')) problems.push('goBacks.seasonStart must be MM-DD');
  if (!TIME.test(settings?.sale?.defaultJobStartTime || '')) problems.push('sale.defaultJobStartTime must be HH:MM');
  if (!Array.isArray(settings?.sale?.extraHolidays) || settings.sale.extraHolidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) problems.push('sale.extraHolidays must be a list of YYYY-MM-DD dates');
  if (typeof settings?.map?.tileUrl !== 'string' || !/^https:\/\/[^\s]+\{z\}[^\s]*\{x\}[^\s]*\{y\}/.test(settings.map.tileUrl)) problems.push('map.tileUrl must be an https URL with {z}, {x} and {y}');
  for (const key of ['deposit', 'text', 'job']) {
    const allowed = { deposit: ['manual', 'stripe'], text: ['manual', 'quo'], job: ['manual'] }[key];
    if (!allowed.includes(settings?.integrations?.[key])) problems.push(`integrations.${key} must be one of ${allowed.join(', ')}`);
  }
  return problems;
}

// Stored values laid over the defaults, without validation (the admin editor validates this).
export const overlaySettings = stored => mergeDeep(DEFAULT_SETTINGS, stored);

export function mergeSettings(stored) {
  const merged = mergeDeep(DEFAULT_SETTINGS, stored);
  // Lists replace rather than merge; cities merge per key so a stored city can override one field.
  return validateSettings(merged).length ? structuredClone(DEFAULT_SETTINGS) : merged;
}

export function cityRule(settings, cityKey) {
  return settings?.cities?.[cityKey] || null;
}
