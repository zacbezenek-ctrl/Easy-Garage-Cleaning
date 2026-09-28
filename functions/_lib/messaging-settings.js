/* Owner-tunable cadence for the server messaging scheduler. The record lives
   in the server-only messaging_settings collection; a missing record means
   the defaults below, and an invalid one stops automatic sends (fail closed)
   rather than guessing what the owner meant. */
export const MESSAGING_SETTINGS = 'messaging_settings';
// Off until the owner has approved the templates and wants the server to own
// reminders. While off, the Hub keeps its legacy browser triggers and the
// cron only runs dry runs.
export const serverMessagingEnabled = (env = {}) => env.EGC_SERVER_MESSAGING_ENABLED === 'true';
export const MESSAGING_SETTINGS_ID = 'automation';
export const MAX_SENDS_PER_TICK = 25;
export const DEFAULT_MESSAGING_SETTINGS = Object.freeze({
  paused: false,
  // Days after the invoice due date. Each stage falls in its own 7-day
  // payment_reminder window, so every stage is one claim-once send; the
  // approved-send cadence rule also keeps consecutive reminders 7 days apart.
  paymentReminderDays: Object.freeze([1, 7, 14]),
  // Days before the service date for an approved but unpaid deposit.
  depositReminderDaysBefore: Object.freeze([3]),
  // Days before estimate.validUntil (the Hub reminder has always been one day).
  estimateExpiringDaysBefore: 1,
  // Denver wall-clock window for day-before reminders (inside 08:00-20:00).
  dayBeforeWindow: Object.freeze({ start: '09:00', end: '19:00' }),
  maxSendsPerTick: MAX_SENDS_PER_TICK,
});

const KEYS = Object.keys(DEFAULT_MESSAGING_SETTINGS);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, details) => Object.assign(new Error(message), { code: 'messaging_settings_invalid', status: 503, details });
const days = (value, min, max) => Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every(day => Number.isInteger(day) && day >= min && day <= max) && value.every((day, index) => index === 0 || day > value[index - 1]);
// Stages that share a cadence window would collapse into one claim-once key.
const windows = (value, cadence, sign) => new Set(value.map(day => Math.floor(sign * day / cadence))).size === value.length;

export function normalizeMessagingSettings(doc) {
  if (doc === null || doc === undefined) return { ...DEFAULT_MESSAGING_SETTINGS, source: 'default' };
  if (!object(doc)) throw fail('The messaging schedule settings are unreadable. Automatic messages are paused until they are fixed.');
  const input = Object.fromEntries(KEYS.filter(key => doc[key] !== undefined).map(key => [key, doc[key]]));
  const settings = { ...DEFAULT_MESSAGING_SETTINGS, ...input };
  const invalid = [];
  if (typeof settings.paused !== 'boolean') invalid.push('paused');
  if (!days(settings.paymentReminderDays, 0, 60) || !windows(settings.paymentReminderDays, 7, 1)) invalid.push('paymentReminderDays');
  if (!days(settings.depositReminderDaysBefore, 1, 30) || !windows(settings.depositReminderDaysBefore, 3, -1)) invalid.push('depositReminderDaysBefore');
  if (!Number.isInteger(settings.estimateExpiringDaysBefore) || settings.estimateExpiringDaysBefore < 0 || settings.estimateExpiringDaysBefore > 14) invalid.push('estimateExpiringDaysBefore');
  const window = settings.dayBeforeWindow;
  if (!object(window) || !HHMM.test(window.start || '') || !HHMM.test(window.end || '') || window.start >= window.end || window.start < '08:00' || window.end > '20:00') invalid.push('dayBeforeWindow');
  if (!Number.isInteger(settings.maxSendsPerTick) || settings.maxSendsPerTick < 0 || settings.maxSendsPerTick > MAX_SENDS_PER_TICK) invalid.push('maxSendsPerTick');
  if (invalid.length) throw fail('The messaging schedule settings need review. Automatic messages are paused until they are fixed.', { fields: invalid });
  return {
    paused: settings.paused, paymentReminderDays: [...settings.paymentReminderDays], depositReminderDaysBefore: [...settings.depositReminderDaysBefore],
    estimateExpiringDaysBefore: settings.estimateExpiringDaysBefore, dayBeforeWindow: { start: window.start, end: window.end },
    maxSendsPerTick: settings.maxSendsPerTick, source: 'saved', revision: doc.revision || '',
  };
}

export async function readMessagingSettings(store) {
  return normalizeMessagingSettings(await store.read(MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID));
}
