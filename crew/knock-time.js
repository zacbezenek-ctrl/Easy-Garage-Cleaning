/* Canvassing time rules shared by the knock page and its Pages Functions (no DOM, no network).
   Sunset uses the NOAA solar equations (gml.noaa.gov/grad/solcalc) and is rounded to the minute
   the same way NOAA's calculator displays it. Calendar arithmetic uses UTC noon so the device
   time zone never shifts a date; wall times are converted through Intl for the city's zone. */

const DAY_MS = 86400000;
const rad = degrees => degrees * Math.PI / 180;
const deg = radians => radians * 180 / Math.PI;

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function addDays(date, amount) {
  if (!validDate(date) || !Number.isInteger(amount)) return null;
  return new Date(Date.parse(date + 'T12:00:00Z') + amount * DAY_MS).toISOString().slice(0, 10);
}

export function weekday(date) {
  return new Date(Date.parse(date + 'T12:00:00Z')).getUTCDay();
}

const partsCache = new Map();
function formatter(timeZone) {
  if (!partsCache.has(timeZone)) {
    partsCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return partsCache.get(timeZone);
}

// Wall-clock parts of an instant in a zone: { date: 'YYYY-MM-DD', hour, minute, second, minutes }.
export function zonedParts(instant, timeZone = 'America/Denver') {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) % 24, minute = Number(parts.minute), second = Number(parts.second);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute, second, minutes: hour * 60 + minute };
}

export function zonedDate(instant, timeZone = 'America/Denver') {
  return zonedParts(instant, timeZone)?.date || null;
}

function offsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)), p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant (ms) of a wall time on a date in a zone. A time skipped by a DST jump resolves forward.
export function zonedInstant(date, time = '00:00', timeZone = 'America/Denver') {
  if (!validDate(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  let ms = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(ms, timeZone);
  if (second !== ms) ms = Math.max(ms, second);
  return ms;
}

export function startOfZonedDay(date, timeZone = 'America/Denver') {
  return zonedInstant(date, '00:00', timeZone);
}

export function formatClock(instant, timeZone = 'America/Denver') {
  const p = zonedParts(instant, timeZone);
  if (!p) return '';
  const suffix = p.hour >= 12 ? 'pm' : 'am';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${hour12}:${String(p.minute).padStart(2, '0')} ${suffix}`;
}

/* ---- NOAA solar position ---- */

function julianDay(year, month, day) {
  if (month <= 2) { year -= 1; month += 12; }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + b - 1524.5;
}

const centuries = jd => (jd - 2451545.0) / 36525.0;

function geomMeanLongSun(t) {
  let l0 = 280.46646 + t * (36000.76983 + t * 0.0003032);
  l0 %= 360;
  return l0 < 0 ? l0 + 360 : l0;
}

const geomMeanAnomalySun = t => 357.52911 + t * (35999.05029 - 0.0001537 * t);
const eccentricityEarthOrbit = t => 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

function sunEqOfCenter(t) {
  const m = rad(geomMeanAnomalySun(t));
  return Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
}

function sunApparentLong(t) {
  const trueLong = geomMeanLongSun(t) + sunEqOfCenter(t);
  const omega = 125.04 - 1934.136 * t;
  return trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
}

function obliquityCorrection(t) {
  const seconds = 21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813));
  const e0 = 23 + (26 + seconds / 60) / 60;
  const omega = 125.04 - 1934.136 * t;
  return e0 + 0.00256 * Math.cos(rad(omega));
}

function sunDeclination(t) {
  return deg(Math.asin(Math.sin(rad(obliquityCorrection(t))) * Math.sin(rad(sunApparentLong(t)))));
}

function equationOfTime(t) {
  const epsilon = obliquityCorrection(t), l0 = rad(geomMeanLongSun(t));
  const e = eccentricityEarthOrbit(t), m = rad(geomMeanAnomalySun(t));
  let y = Math.tan(rad(epsilon) / 2);
  y *= y;
  const eTime = y * Math.sin(2 * l0) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * m);
  return deg(eTime) * 4;
}

function hourAngleSunrise(latitude, declination) {
  const lat = rad(latitude), dec = rad(declination);
  const arg = Math.cos(rad(90.833)) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec);
  return arg < -1 || arg > 1 ? NaN : Math.acos(arg);
}

// Minutes after 00:00 UTC on the date (may exceed 1440) for sunrise or sunset.
function riseSetUtcMinutes(rise, jd, latitude, longitude) {
  const t = centuries(jd);
  let hourAngle = hourAngleSunrise(latitude, sunDeclination(t));
  if (!rise) hourAngle = -hourAngle;
  const delta = longitude + deg(hourAngle);
  return 720 - 4 * delta - equationOfTime(t);
}

function riseSet(rise, date, latitude, longitude) {
  if (!validDate(date)) return null;
  const jd = julianDay(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
  const first = riseSetUtcMinutes(rise, jd, latitude, longitude);
  const refined = riseSetUtcMinutes(rise, jd + first / 1440, latitude, longitude);
  if (!Number.isFinite(refined)) return null;
  const exact = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + refined * 60000;
  // NOAA displays sunrise/sunset rounded to the nearest minute; the legal clock uses that minute.
  return Math.round(exact / 60000) * 60000;
}

export function sunsetInstant(date, latitude, longitude) {
  return riseSet(false, date, latitude, longitude);
}

export function sunriseInstant(date, latitude, longitude) {
  return riseSet(true, date, latitude, longitude);
}

/* ---- The knocking window for a city on a given instant ---- */

/* rule: { timeZone, latitude, longitude, startTime 'HH:MM', end: 'sunset' | 'HH:MM',
           sunsetOffsetMinutes, warnMinutes, graceMinutes }
   Returns the day's window and where `now` sits in it:
     phase 'before'  - before the start time (no new doors)
           'open'    - doors allowed; warning=true inside the last warnMinutes
           'grace'   - after the end; only the door already in progress may be logged (flagged)
           'closed'  - after end + grace */
export function knockWindow(rule, now = Date.now()) {
  const timeZone = rule?.timeZone || 'America/Denver';
  const today = zonedDate(now, timeZone);
  const startAt = zonedInstant(today, rule?.startTime || '09:00', timeZone);
  let endAt;
  if (!rule?.end || rule.end === 'sunset') {
    const sunset = sunsetInstant(today, Number(rule?.latitude), Number(rule?.longitude));
    endAt = sunset == null ? startAt : sunset + Number(rule?.sunsetOffsetMinutes || 0) * 60000;
  } else {
    endAt = zonedInstant(today, rule.end, timeZone);
  }
  const warnMs = Math.max(0, Number(rule?.warnMinutes ?? 15)) * 60000;
  const graceMs = Math.max(0, Number(rule?.graceMinutes ?? 15)) * 60000;
  const graceEndAt = endAt + graceMs;
  let phase;
  if (now < startAt) phase = 'before';
  else if (now < endAt) phase = 'open';
  else if (now < graceEndAt) phase = 'grace';
  else phase = 'closed';
  return {
    date: today, timeZone, startAt, endAt, graceEndAt, phase,
    warning: phase === 'open' && endAt - now <= warnMs,
    msToEnd: Math.max(0, endAt - now),
    msToStart: Math.max(0, startAt - now),
    endLabel: formatClock(endAt, timeZone),
    startLabel: formatClock(startAt, timeZone),
  };
}

// A door may be logged when the window is open, or in grace when it finishes a door already started.
export function doorAllowed(window, { finishingDoor = false } = {}) {
  if (window.phase === 'open') return { allowed: true, afterEnd: false };
  if (window.phase === 'grace' && finishingDoor) return { allowed: true, afterEnd: true };
  return { allowed: false, afterEnd: window.phase !== 'before' };
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
