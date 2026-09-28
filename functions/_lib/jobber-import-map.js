/** Jobber → Hub import mapping (JOB-CUT). Pure functions only: no storage, no
 * network and no ambient clock. Jobber exports and reports show local wall times,
 * which are read as America/Denver; instants with an offset are converted. Money
 * is integer cents and an unknown amount stays null, never 0. Hub ids are derived
 * from Jobber ids so a rerun targets the same documents.
 *
 * Phone and email rules mirror normalizePhoneE164/normalizeEmail in P4-02's
 * customer-identity.js (not merged yet); import them from there once it lands. */
import { localInstant } from './operations-portal-records.js';
import { validDate, addDays, denverToday } from './dispatch-time.js';

export const JOBBER_TIME_ZONE = 'America/Denver';
export const JOBBER_IMPORT_ACTOR = 'jobber-import';
const fail = (code, message) => Object.assign(new Error(message), { code: 'jobber_import_' + code, status: 400 });
const text = (value, max = 4000) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const line = (value, max = 400) => text(value, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
const pad = value => String(value).padStart(2, '0');
const unique = values => [...new Set(values.filter(Boolean))];
const flag = value => /^(true|yes|y|1|x)$/i.test(String(value ?? '').trim());

/** RFC 4180 CSV: quoted commas, doubled quotes, quoted line breaks, CRLF and a
 * UTF-8 BOM. Blank rows are dropped; `line` is the 1-based line a row starts on. */
export function parseCsv(input) {
  if (typeof input !== 'string') throw fail('csv_invalid', 'The CSV export could not be read as text.');
  const source = input.replace(/^﻿/, ''), rows = [];
  let row = [], cell = '', quoted = false, lineNo = 1, rowLine = 1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') lineNo++; cell += c; }
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); rows.push({ line: rowLine, cells: row }); row = []; cell = ''; rowLine = ++lineNo;
    } else cell += c;
  }
  if (quoted) throw fail('csv_unterminated', 'A quoted value in the CSV export is never closed. Export the report again.');
  if (cell !== '' || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }); }
  const records = rows.filter(entry => entry.cells.some(value => value.trim() !== ''));
  if (!records.length) throw fail('csv_empty', 'The CSV export has no header row.');
  const [head, ...body] = records;
  return { headers: head.cells.map(value => value.trim()), rows: body };
}

/** "Job #" → jobnumber, "Balance ($)" → balance, "E-mails" → emails, "J-ID" → jid. */
export const headerKey = header => String(header ?? '').toLowerCase().replace(/#/g, ' number ').replace(/\(\s*\$\s*\)|\$/g, '').replace(/[^a-z0-9]+/g, '');

const CLIENT_LINK = ['clientName','clientEmail','clientPhone'];
const SERVICE_ADDRESS = { propertyName: ['servicepropertyname','propertyname'], street: ['servicestreet','servicestreet1','street','street1','address'], city: ['servicecity','city'], state: ['serviceprovince','servicestate','province','state'], zip: ['servicezip','servicezipcode','servicepostalcode','zipcode','zip','postalcode'] };
const CLIENT_COLUMNS = { clientName: ['clientname','client','name'], clientEmail: ['clientemail','clientemails','email','emails'], clientPhone: ['clientphone','clientphones','phone','phonenumber'] };
/** Default header aliases. The client export headers follow Jobber's Clients →
 * Export (CSV); the report headers follow the Insights → Reports column names.
 * A --mapping file overrides any field when an export labels a column differently. */
export const JOBBER_COLUMNS = Object.freeze({
  clients: { required: ['jid'], oneOf: [['displayName','firstName','lastName','companyName']], fields: {
    jid: ['jid','jobberid','clientid'], displayName: ['displayname','name','clientname'], firstName: ['firstname'], lastName: ['lastname'],
    companyName: ['companyname','company'], isCompany: ['iscompany'], title: ['title'],
    emails: ['emails','email','emailaddress','emailaddresses'],
    mainPhones: ['mainphonenumbers','mainphonenumber','mainphone','phone','phonenumber','phones','phonenumbers'],
    mobilePhones: ['mobilephonenumbers','mobilephonenumber','mobilephone','mobile'], smsPhones: ['textmessageenabledphonenumber','textmessageenabledphonenumbers'],
    workPhones: ['workphonenumbers','workphonenumber','workphone','work'], homePhones: ['homephonenumbers','homephonenumber','homephone','home'],
    propertyName: ['servicepropertyname','propertyname'], street1: ['servicestreet1','servicestreet','street1','street','address'], street2: ['servicestreet2','street2'],
    city: ['servicecity','city'], state: ['servicestate','serviceprovince','state','province'], zip: ['servicezipcode','servicezip','servicepostalcode','zipcode','zip','postalcode'],
    billingStreet1: ['billingstreet1','billingstreet'], billingStreet2: ['billingstreet2'], billingCity: ['billingcity'], billingState: ['billingstate','billingprovince'], billingZip: ['billingzipcode','billingzip','billingpostalcode'],
    archived: ['archived','isarchived'], isLead: ['islead','lead'], leadSource: ['leadsource'], createdDate: ['createddate','createdon','createdat'],
  } },
  visits: { required: ['jobNumber','date'], oneOf: [CLIENT_LINK], fields: {
    jobNumber: ['jobnumber','job','jobno'], date: ['date','visitdate','startdate','startat','scheduledstart','scheduledstarton','scheduleddate','visitstart','start'],
    times: ['times','visittimes','scheduledtimes','time'], endDate: ['enddate','endat','visitend','scheduledend'], duration: ['scheduledduration','scheduleduration','duration'],
    title: ['title','jobtitle','visittitle'], ...CLIENT_COLUMNS, ...SERVICE_ADDRESS,
    completedAt: ['completedat','completed','completeddate','completedon','visitcompleted','visitcompletedat'], assignedTo: ['assignedto','visitsassignedto','teammembers','team'],
    lineItems: ['lineitems','lineitemslist','lineitemnames'], oneOffValue: ['oneoffjob','oneoffjobcost','oneoff'], visitBasedValue: ['visitbased','visitbasedcost'],
    jobType: ['jobtype','type'], instructions: ['instructions','visitinstructions','jobinstructions'],
  } },
  invoices: { required: ['invoiceNumber','status','balance'], oneOf: [CLIENT_LINK], fields: {
    invoiceNumber: ['invoicenumber','invoice','invoiceno'], status: ['status','invoicestatus'], subject: ['subject','description'],
    ...CLIENT_COLUMNS, ...SERVICE_ADDRESS, jobNumbers: ['jobnumbers','jobnumber','jobs','job'],
    issuedOn: ['issueddate','issuedon','issued','dateissued','invoicedate'], dueOn: ['duedate','dueon','due'], paidOn: ['markedpaidon','paidon','paiddate','datepaid'],
    total: ['total','invoicetotal'], balance: ['balance','balancedue','amountdue','outstandingbalance','outstanding'], preTaxTotal: ['pretaxtotal','subtotal'], taxAmount: ['taxamount','tax'],
  } },
  recurring: { required: ['jobNumber','visitFrequency'], oneOf: [CLIENT_LINK], fields: {
    jobNumber: ['jobnumber','job','jobno'], title: ['title','jobtitle'], ...CLIENT_COLUMNS, ...SERVICE_ADDRESS,
    visitFrequency: ['visitfrequency','frequency','schedule','recurrence'], billingFrequency: ['billingfrequency'], billingType: ['billingtype'],
    visitsAssignedTo: ['visitsassignedto','assignedto'], lineItems: ['lineitemslist','lineitems'], startOn: ['scheduledstarton','scheduledstart','startdate','starton','start'],
    endOn: ['scheduledendon','scheduledend','enddate','endon','end'], closedOn: ['closedon','closed'],
  } },
});
export const JOBBER_EXPORT_KINDS = Object.freeze(Object.keys(JOBBER_COLUMNS));

/** Resolves canonical fields to column indexes. An explicit mapping wins; unknown
 * mapping fields and absent mapped headers are problems, never silently ignored. */
export function mapColumns(kind, headers, override = {}) {
  const spec = JOBBER_COLUMNS[kind];
  if (!spec) throw fail('kind_invalid', 'Unknown Jobber export kind.');
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw fail('mapping_invalid', `The column mapping for ${kind} must map field names to CSV headers.`);
  const keys = headers.map(headerKey), columns = {}, taken = new Set(), problems = [];
  for (const [field, header] of Object.entries(override)) {
    if (!Object.hasOwn(spec.fields, field)) { problems.push(`Unknown ${kind} mapping field "${field}".`); continue; }
    const index = typeof header === 'string' && headerKey(header) ? keys.indexOf(headerKey(header)) : -1;
    if (index < 0 || taken.has(index)) problems.push(`The ${kind} mapping for "${field}" names a column that is not in the export.`);
    else { columns[field] = index; taken.add(index); }
  }
  for (const [field, aliases] of Object.entries(spec.fields)) {
    if (field in columns) continue;
    const index = aliases.map(alias => keys.findIndex((key, at) => key === alias && !taken.has(at))).find(at => at >= 0);
    if (index !== undefined) { columns[field] = index; taken.add(index); }
  }
  const missing = [...spec.required.filter(field => !(field in columns)), ...spec.oneOf.filter(group => !group.some(field => field in columns)).map(group => group.join(' or '))];
  const seen = new Set(), duplicateHeaders = [];
  keys.forEach((key, at) => { if (key && seen.has(key)) duplicateHeaders.push(headers[at]); seen.add(key); });
  return { columns, missing, problems, unknownHeaders: headers.filter((header, at) => header && !taken.has(at)), duplicateHeaders };
}
const cellOf = (row, columns) => field => columns[field] === undefined ? '' : String(row.cells[columns[field]] ?? '').trim();

/** US-first E.164. Bare ten digits (or eleven with a leading 1) and +1 numbers
 * are NANP. An explicit + with any other country code stays international and is
 * never folded into +1. Anything unusable normalizes to ''. */
export function normalizePhoneE164(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value).trim().replace(/^tel:\s*/i, '').replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, '');
  if (!raw || raw.length > 64) return '';
  const digits = raw.replace(/\D/g, ''), plus = raw.startsWith('+');
  if (plus && digits[0] !== '1') return /^[2-9]\d{7,14}$/.test(digits) ? '+' + digits : '';
  const nanp = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : !plus && digits.length === 10 ? digits : '';
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(nanp) ? '+1' + nanp : '';
}

/** Case-insensitive exact address. Dots and plus tags are kept: two mailboxes
 * are never folded into one identity. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^mailto:/i, '').toLowerCase();
  return raw.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : '';
}

/** Jobber cells can hold several numbers or addresses. Order is kept (first is
 * primary) and duplicates collapse; unusable entries are counted, not guessed. */
export function phoneList(...values) {
  const phones = [], invalid = [];
  for (const value of values) for (const part of String(value ?? '').split(/\s*[\n;,|]\s*|\s+\/\s+/)) {
    if (!part.trim()) continue;
    const phone = normalizePhoneE164(part);
    if (phone) { if (!phones.includes(phone)) phones.push(phone); } else invalid.push(line(part, 64));
  }
  return { phones, invalid };
}
export function emailList(...values) {
  const emails = [], invalid = [];
  for (const value of values) for (const part of String(value ?? '').split(/[\s,;]+/)) {
    if (!part) continue;
    const email = normalizeEmail(part);
    if (email) { if (!emails.includes(email)) emails.push(email); } else invalid.push(line(part, 254));
  }
  return { emails, invalid };
}

const STATES = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE',districtofcolumbia:'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV',newhampshire:'NH',newjersey:'NJ',newmexico:'NM',newyork:'NY',northcarolina:'NC',northdakota:'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA',rhodeisland:'RI',southcarolina:'SC',southdakota:'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA',westvirginia:'WV',wisconsin:'WI',wyoming:'WY',colo:'CO' };
/** Trims and collapses each part, moves parenthetical notes ("(side door)") out of
 * the address, turns state names into USPS codes and keeps a 5 or 5+4 ZIP. */
export function normalizeAddress(parts = {}) {
  const notes = [];
  const clean = value => line(String(value ?? '').replace(/\(([^)]*)\)/g, (_, note) => { if (note.trim()) notes.push(line(note, 200)); return ' '; }), 300).replace(/^[\s,]+|[\s,]+$/g, '');
  const street1 = clean(parts.street1), street2 = clean(parts.street2), rawCity = clean(parts.city), rawState = clean(parts.state);
  const city = rawCity === rawCity.toLowerCase() || rawCity === rawCity.toUpperCase() ? rawCity.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase()) : rawCity;
  const state = /^[A-Za-z]{2}$/.test(rawState) ? rawState.toUpperCase() : STATES[rawState.toLowerCase().replace(/[^a-z]/g, '')] || rawState;
  const zipMatch = /(\d{5})(?:[-\s]?(\d{4}))?/.exec(String(parts.zip ?? '')), zip = zipMatch ? zipMatch[1] + (zipMatch[2] ? '-' + zipMatch[2] : '') : '';
  const locality = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { street1, street2, city, state, zip, line: [street1, street2, locality].filter(Boolean).join(', '), notes };
}
const ABBREVIATIONS = { street:'st',avenue:'ave',av:'ave',drive:'dr',road:'rd',lane:'ln',court:'ct',circle:'cir',boulevard:'blvd',place:'pl',parkway:'pkwy',trail:'trl',terrace:'ter',highway:'hwy',north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',apartment:'apt',suite:'ste' };
/** Comparison key: case, punctuation and common USPS suffix/direction spellings ignored. */
export const addressKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(word => ABBREVIATIONS[word] ?? word).join(' ');
export const nameKey = value => String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "$1,234.50" → 123450, "(12.00)" or "-$12" → -1200. Numbers (GraphQL floats)
 * round to the cent. Anything else, including 3+ decimals, is null. */
export function jobberMoneyCents(value) {
  if (typeof value === 'number') { const cents = Math.round(value * 100); return Number.isFinite(value) && Number.isSafeInteger(cents) ? cents || 0 : null; }
  if (typeof value !== 'string') return null;
  let raw = value.trim(), negative = false;
  if (/^\(.*\)$/.test(raw)) { negative = true; raw = raw.slice(1, -1).trim(); }
  if (raw.startsWith('-')) { negative = !negative; raw = raw.slice(1).trim(); }
  raw = raw.replace(/^(?:US)?\$\s*/i, '');
  if (raw.startsWith('-')) { negative = !negative; raw = raw.slice(1).trim(); }
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(/,/g, '').split('.'), cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents ? -cents : cents;
}

const WALL = new Intl.DateTimeFormat('en-CA', { timeZone: JOBBER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Denver wall-clock date and time for an ISO instant that carries Z or an
 * offset. Rails-style "2026-09-24 09:00:00 -0600" and "… UTC" are accepted. */
export function denverWallClock(instant) {
  if (typeof instant !== 'string') return null;
  const iso = instant.trim().replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, '$1T').replace(/\s*(?:UTC|Z)$/i, 'Z').replace(/\s+([+-]\d{2}:?\d{2})$/, '$1');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
  const ms = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(WALL.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "9:00 AM", "9am", "12 PM", "21:30", "noon" → HH:MM (24h), else null. */
export function parseClock(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (raw === 'noon') return '12:00';
  if (raw === 'midnight') return '00:00';
  let match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/.exec(raw);
  if (match) { const hour = Number(match[1]), minute = Number(match[2] || 0); return hour >= 1 && hour <= 12 && minute < 60 ? pad(hour % 12 + (match[3] === 'p' ? 12 : 0)) + ':' + pad(minute) : null; }
  match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw);
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? pad(match[1]) + ':' + match[2] : null;
}

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthNumber = name => { const key = name.toLowerCase().replace(/\.$/, ''); return MONTH_NAMES.findIndex(month => month === key || month.slice(0, 3) === key || key === 'sept' && month === 'september') + 1; };
const isoDate = (year, month, day) => { const date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`; return validDate(date) ? date : null; };
function withClock(date, clock) {
  if (!date) return null;
  if (!clock) return { date, time: '' };
  const time = parseClock(clock);
  return time ? { date, time } : null;
}
/** Local Jobber dates: ISO (an offset converts to Denver), M/D/YYYY, M/D/YY,
 * "Sep 24, 2026", "Thu Sep 24, 2026 9:00 AM" and "24 Sep 2026", each with an
 * optional time. Returns {date, time:''|HH:MM} or null. */
export function parseJobberDate(value) {
  const raw = line(value, 80);
  if (!raw) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(\s?(?:Z|UTC|[+-]\d{2}:?\d{2}))?)?$/i.exec(raw);
  if (match) {
    if (match[6]) return denverWallClock(raw);
    const date = isoDate(match[1], match[2], match[3]);
    if (!date) return null;
    if (match[4] === undefined) return { date, time: '' };
    return Number(match[4]) < 24 && Number(match[5]) < 60 ? { date, time: `${match[4]}:${match[5]}` } : null;
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:,?\s+(?:at\s+)?(.+))?$/i.exec(raw);
  if (match) return withClock(isoDate(match[3].length === 2 ? 2000 + Number(match[3]) : match[3], match[1], match[2]), match[4]);
  match = /^(?:[a-z]{3,9}\.?,?\s+)?([a-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(.+))?$/i.exec(raw);
  if (match && monthNumber(match[1])) return withClock(isoDate(match[3], monthNumber(match[1]), match[2]), match[4]);
  match = /^(\d{1,2})\s+([a-z]{3,9}\.?),?\s+(\d{4})(?:,?\s+(?:at\s+)?(.+))?$/i.exec(raw);
  if (match && monthNumber(match[2])) return withClock(isoDate(match[3], monthNumber(match[2]), match[1]), match[4]);
  return null;
}

/** "9:00 AM - 11:00 AM", "9am–11:30am", "9 - 11 AM", "09:00 to 11:00", "Anytime". */
export function parseTimes(value) {
  const raw = line(value, 80).toLowerCase();
  if (!raw) return null;
  if (/^(?:any ?time|all ?day)$/.test(raw)) return { allDay: true, time: '', endTime: '' };
  const parts = raw.split(/\s*(?:-|–|—|\bto\b)\s*/);
  if (parts.length > 2 || !parts[0]) return null;
  const [first, second] = parts, meridiem = value => /[ap]\.?\s*m?\.?$/.test(value);
  const endTime = second === undefined ? '' : parseClock(second);
  if (second !== undefined && !endTime) return null;
  let time = parseClock(first);
  if (second !== undefined && !meridiem(first) && meridiem(second) && /^\d{1,2}(?::\d{2})?$/.test(first)) {
    const pm = /p/.test(second), same = parseClock(first + (pm ? ' pm' : ' am')), other = parseClock(first + (pm ? ' am' : ' pm'));
    time = same && same < endTime ? same : other && other < endTime ? other : time;
  }
  return time ? { allDay: false, time, endTime } : null;
}

/** Jobber's Visits report exports "Scheduled duration" as decimal hours ("0.5"
 * is 30 minutes). Also "2 hrs 30 mins", "2h 30m", "1.5 hours", "90 min" and
 * "02:30" → minutes. */
export function parseDurationMinutes(value) {
  const raw = line(value, 60).toLowerCase();
  if (!raw) return null;
  const clock = /^(\d{1,3}):(\d{2})$/.exec(raw);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null;
  if (/^\d{1,4}(?:\.\d{1,4})?$/.test(raw)) { const total = Math.round(Number(raw) * 60); return total > 0 && total <= 31 * 1440 ? total : null; }
  const hours = /(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\b/.exec(raw), minutes = /(\d+)\s*m(?:in(?:ute)?s?)?\b/.exec(raw);
  if (!hours && !minutes) return null;
  const total = Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
  return total > 0 && total <= 31 * 1440 ? total : null;
}

const EMPTY_SCHEDULE = Object.freeze({ date: '', time: '', endDate: '', endTime: '', allDay: false, startAt: null, endAt: null, timeNeedsReview: false });
function finishSchedule(date, time, endDate, endTime) {
  const startAt = localInstant(date, time), endAt = localInstant(endDate, endTime);
  return { date, time, endDate, endTime, allDay: false, startAt, endAt, timeNeedsReview: !startAt || !endAt || endAt <= startAt || Date.parse(endAt) - Date.parse(startAt) > 31 * 86400000 };
}
/** A CSV visit's Denver schedule. Missing or DST-invalid times keep the date and
 * set timeNeedsReview; they are never shifted to a guessed hour. */
export function visitSchedule({ date, times, endDate, duration } = {}) {
  if (!line(date)) return { ...EMPTY_SCHEDULE };
  const start = parseJobberDate(date);
  if (!start) return { ...EMPTY_SCHEDULE, timeNeedsReview: true };
  const window = line(times) ? parseTimes(times) : null, end = line(endDate) ? parseJobberDate(endDate) : null;
  if (window?.allDay) return { ...EMPTY_SCHEDULE, date: start.date, endDate: end?.date && end.date > start.date ? end.date : start.date, allDay: true };
  const time = window?.time || start.time;
  let finishDate = end?.date || start.date, finish = window?.endTime || end?.time || '';
  const minutes = parseDurationMinutes(duration), startAt = time ? localInstant(start.date, time) : null;
  if (startAt && !finish && minutes) ({ date: finishDate, time: finish } = denverWallClock(new Date(Date.parse(startAt) + minutes * 60000).toISOString()));
  const schedule = time && finish ? finishSchedule(start.date, time, finishDate, finish) : { ...EMPTY_SCHEDULE, date: start.date, time, endDate: finishDate, endTime: finish, startAt, timeNeedsReview: true };
  return Boolean(line(times)) && !window ? { ...schedule, timeNeedsReview: true } : schedule;
}
/** A GraphQL visit's schedule from its instants (null start = unscheduled). */
export function scheduleFromInstants({ startAt, endAt, allDay } = {}) {
  if (!startAt) return { ...EMPTY_SCHEDULE };
  const start = denverWallClock(startAt), end = endAt ? denverWallClock(endAt) : null;
  if (!start) return { ...EMPTY_SCHEDULE, timeNeedsReview: true };
  if (allDay) { const last = end ? (end.time === '00:00' ? addDays(end.date, -1) : end.date) : start.date; return { ...EMPTY_SCHEDULE, date: start.date, endDate: last && last > start.date ? last : start.date, allDay: true }; }
  return end ? finishSchedule(start.date, start.time, end.date, end.time) : { ...EMPTY_SCHEDULE, date: start.date, time: start.time, endDate: start.date, startAt: localInstant(start.date, start.time), timeNeedsReview: true };
}
/** 'unscheduled' | 'past' | 'upcoming' relative to an injected ISO `now`. */
export function visitTiming(schedule, now) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw fail('clock_invalid', 'A valid current time is required.');
  if (!schedule?.date) return 'unscheduled';
  if (schedule.endAt) return Date.parse(schedule.endAt) <= nowMs ? 'past' : 'upcoming';
  return (schedule.endDate || schedule.date) < denverToday(new Date(nowMs)) ? 'past' : 'upcoming';
}

function completion(value, schedule) {
  const raw = line(value, 80);
  if (!raw) return { completed: false, completedAt: null };
  if (/^(no|false|incomplete)$/i.test(raw)) return { completed: false, completedAt: null };
  if (/^(yes|true|complete|completed)$/i.test(raw)) return { completed: true, completedAt: schedule.endAt || null };
  const parsed = parseJobberDate(raw);
  if (!parsed) return { completed: true, completedAt: null };
  const at = parsed.time ? localInstant(parsed.date, parsed.time) : parsed.date === schedule.endDate && schedule.endAt ? schedule.endAt : localInstant(parsed.date, '12:00');
  return { completed: true, completedAt: at };
}
const jobTypeOf = value => /recur/i.test(value) ? 'recurring' : /one.?off/i.test(value) ? 'one_off' : '';
const jobNumberOf = value => { const match = /^#?\s*(\d{1,12})$/.exec(String(value ?? '').trim()); return match ? String(Number(match[1])) : ''; };
const invoiceNumberOf = value => { const match = /^#?\s*([A-Za-z0-9][A-Za-z0-9-]{0,39})$/.exec(String(value ?? '').trim()); return match ? match[1] : ''; };
const INVOICE_STATUS = { awaitingpayment:'awaiting_payment', unpaid:'awaiting_payment', pastdue:'past_due', overdue:'past_due', late:'past_due', sentnotdue:'sent_not_due', sent:'sent_not_due', paid:'paid', draft:'draft', baddebt:'bad_debt', void:'void', voided:'void' };
export const invoiceStatus = value => INVOICE_STATUS[String(value ?? '').toLowerCase().replace(/[^a-z]/g, '')] || '';
export const OPEN_INVOICE_STATUSES = Object.freeze(['awaiting_payment','past_due','sent_not_due']);
const linkFields = get => {
  const { phones } = phoneList(get('clientPhone')), { emails } = emailList(get('clientEmail'));
  return { name: line(get('clientName'), 200), phones, emails, street: addressKey(get('street')) };
};
const serviceAddress = get => normalizeAddress({ street1: get('street'), city: get('city'), state: get('state'), zip: get('zip') });

/** Jobber's client export has one row per property (J-ID = client_property).
 * Rows are grouped per client; contacts and properties are merged in order. */
export function clientsFromCsv({ rows }, columns) {
  const clients = new Map(), problems = [];
  for (const row of rows) {
    const get = cellOf(row, columns), jid = /^(\d{1,15})(?:_(\d{1,15}))?$/.exec(get('jid'));
    if (!jid) { problems.push({ file: 'clients', line: row.line, reason: 'jobber_id_invalid' }); continue; }
    const client = clients.get(jid[1]) || { source: 'csv', jobberId: jid[1], name: '', firstName: '', lastName: '', companyName: '', isCompany: false, phones: [], emails: [], invalidContacts: 0, properties: [], billingAddress: null, archived: false, isLead: false, leadSource: '', lines: [] };
    const firstName = line(get('firstName'), 100), lastName = line(get('lastName'), 100), companyName = line(get('companyName'), 200), isCompany = flag(get('isCompany'));
    const person = [firstName, lastName].filter(Boolean).join(' '), name = line(isCompany && companyName ? companyName : get('displayName') || person || companyName, 200);
    if (!client.name && name) Object.assign(client, { name, firstName, lastName, companyName, isCompany });
    const phones = phoneList(get('mainPhones'), get('mobilePhones'), get('smsPhones'), get('workPhones'), get('homePhones')), emails = emailList(get('emails'));
    client.phones = unique([...client.phones, ...phones.phones]);
    client.emails = unique([...client.emails, ...emails.emails]);
    client.invalidContacts += phones.invalid.length + emails.invalid.length;
    const address = normalizeAddress({ street1: get('street1'), street2: get('street2'), city: get('city'), state: get('state'), zip: get('zip') }), propertyId = jid[2] || '';
    if (address.line && !client.properties.some(property => property.jobberPropertyId === propertyId && property.address.line === address.line)) client.properties.push({ jobberPropertyId: propertyId, name: line(get('propertyName'), 120), address });
    const billing = normalizeAddress({ street1: get('billingStreet1'), street2: get('billingStreet2'), city: get('billingCity'), state: get('billingState'), zip: get('billingZip') });
    if (!client.billingAddress && billing.line) client.billingAddress = billing;
    client.archived ||= flag(get('archived'));
    client.isLead ||= flag(get('isLead'));
    client.leadSource ||= line(get('leadSource'), 120);
    client.lines.push(row.line);
    clients.set(jid[1], client);
  }
  return { clients: [...clients.values()], problems };
}

export function visitsFromCsv({ rows }, columns) {
  const visits = [], problems = [];
  for (const row of rows) {
    const get = cellOf(row, columns), jobNumber = jobNumberOf(get('jobNumber'));
    if (!jobNumber) { problems.push({ file: 'visits', line: row.line, reason: 'job_number_invalid' }); continue; }
    const schedule = visitSchedule({ date: get('date'), times: get('times'), endDate: get('endDate'), duration: get('duration') });
    visits.push({ source: 'csv', line: row.line, jobNumber, jobType: jobTypeOf(get('jobType')), title: line(get('title'), 200), client: linkFields(get), address: serviceAddress(get), schedule,
      ...completion(get('completedAt'), schedule), assignedTo: line(get('assignedTo'), 300), lineItems: text(get('lineItems'), 2000), instructions: text(get('instructions'), 2000),
      valueCents: jobberMoneyCents(get('oneOffValue')) ?? jobberMoneyCents(get('visitBasedValue')) });
  }
  return { visits, problems };
}

export function invoicesFromCsv({ rows }, columns) {
  const invoices = [], problems = [];
  for (const row of rows) {
    const get = cellOf(row, columns), invoiceNumber = invoiceNumberOf(get('invoiceNumber'));
    if (!invoiceNumber) { problems.push({ file: 'invoices', line: row.line, reason: 'invoice_number_invalid' }); continue; }
    const totalCents = jobberMoneyCents(get('total')), balanceCents = jobberMoneyCents(get('balance'));
    invoices.push({ source: 'csv', line: row.line, invoiceNumber, status: invoiceStatus(get('status')), statusText: line(get('status'), 60), subject: line(get('subject'), 200), client: linkFields(get), address: serviceAddress(get),
      jobNumbers: unique((get('jobNumbers').match(/\d{1,12}/g) || []).map(jobNumberOf)), issuedDate: parseJobberDate(get('issuedOn'))?.date || '', dueDate: parseJobberDate(get('dueOn'))?.date || '',
      totalCents, balanceCents, taxCents: jobberMoneyCents(get('taxAmount')), paidOn: parseJobberDate(get('paidOn'))?.date || '' });
  }
  return { invoices, problems };
}

export function recurringFromCsv({ rows }, columns) {
  const recurring = [], problems = [];
  for (const row of rows) {
    const get = cellOf(row, columns), jobNumber = jobNumberOf(get('jobNumber'));
    if (!jobNumber) { problems.push({ file: 'recurring', line: row.line, reason: 'job_number_invalid' }); continue; }
    const startDate = parseJobberDate(get('startOn'))?.date || '', cadenceText = line(get('visitFrequency'), 200);
    recurring.push({ source: 'csv', line: row.line, jobNumber, title: line(get('title'), 200), client: linkFields(get), address: serviceAddress(get), cadenceText, cadence: cadenceFromText(cadenceText, startDate),
      startDate, endsOn: parseJobberDate(get('endOn'))?.date || '', closedOn: parseJobberDate(get('closedOn'))?.date || '', time: '', endTime: '', assignedTo: line(get('visitsAssignedTo'), 300),
      lineItems: text(get('lineItems'), 2000), billingType: line(get('billingType'), 60), billingFrequency: line(get('billingFrequency'), 120) });
  }
  return { recurring, problems };
}

/** Jobber GraphQL EncodedIds are base64 "gid://Jobber/<Type>/<number>". */
export function jobberNumericId(value, type) {
  if (typeof value !== 'string' || !value) return '';
  if (/^\d{1,15}$/.test(value)) return value;
  let decoded = '';
  try { decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
  const match = /^gid:\/\/Jobber\/([A-Za-z]+)\/(\d{1,15})$/.exec(decoded);
  return match && (!type || match[1] === type) ? match[2] : '';
}
const day = value => typeof value === 'string' ? denverWallClock(value)?.date || parseJobberDate(value)?.date || '' : '';
const gqlAddress = value => normalizeAddress({ street1: value?.street1 ?? value?.street, street2: value?.street2, city: value?.city, state: value?.province, zip: value?.postalCode });
export function clientFromGraphql(node) {
  const jobberId = jobberNumericId(node?.id, 'Client');
  const order = list => [...(list || [])].sort((a, b) => Number(Boolean(b?.primary)) - Number(Boolean(a?.primary)));
  const phones = phoneList(...order(node?.phones).map(phone => phone?.number)), emails = emailList(...order(node?.emails).map(email => email?.address));
  const firstName = line(node?.firstName, 100), lastName = line(node?.lastName, 100), companyName = line(node?.companyName, 200), isCompany = node?.isCompany === true;
  const properties = (Array.isArray(node?.properties) ? node.properties : []).map(property => ({ jobberPropertyId: jobberNumericId(property?.id, 'Property'), name: line(property?.name, 120), address: gqlAddress(property) })).filter(property => property.address.line);
  const billing = node?.billingAddress ? gqlAddress(node.billingAddress) : null;
  return { source: 'graphql', jobberId, name: line(isCompany && companyName ? companyName : node?.name || [firstName, lastName].filter(Boolean).join(' ') || companyName, 200), firstName, lastName, companyName, isCompany,
    phones: phones.phones, emails: emails.emails, invalidContacts: phones.invalid.length + emails.invalid.length, properties, billingAddress: billing?.line ? billing : null,
    archived: node?.isArchived === true, isLead: node?.isLead === true, leadSource: line(node?.leadSource, 120), lines: [] };
}
const clientRef = node => ({ jobberId: jobberNumericId(node?.id, 'Client'), name: '', phones: [], emails: [], street: '' });
export function visitFromGraphql(node) {
  const schedule = scheduleFromInstants({ startAt: node?.startAt, endAt: node?.endAt, allDay: node?.allDay === true }), job = node?.job || {};
  const completed = node?.isComplete === true || node?.visitStatus === 'COMPLETED' || Boolean(node?.completedAt);
  const names = (node?.assignedUsers?.nodes || []).map(user => line(user?.name?.full, 80)).filter(Boolean);
  return { source: 'graphql', jobberVisitId: jobberNumericId(node?.id, 'Visit'), jobNumber: jobNumberOf(job.jobNumber), jobType: job.jobType === 'RECURRING' ? 'recurring' : job.jobType === 'ONE_OFF' ? 'one_off' : '',
    title: line(node?.title || job.title, 200), client: clientRef(node?.client), address: gqlAddress(node?.property), schedule, completed,
    completedAt: completed ? (typeof node?.completedAt === 'string' && Number.isFinite(Date.parse(node.completedAt)) ? new Date(node.completedAt).toISOString() : schedule.endAt) : null,
    assignedTo: names.join(', '), lineItems: '', instructions: text(node?.instructions || job.instructions, 2000),
    valueCents: node?.amounts?.visitBasedBillingTotal == null ? null : jobberMoneyCents(node.amounts.visitBasedBillingTotal) };
}
export function invoiceFromGraphql(node) {
  const amounts = node?.amounts || {};
  return { source: 'graphql', invoiceNumber: invoiceNumberOf(node?.invoiceNumber), status: invoiceStatus(node?.invoiceStatus), statusText: line(node?.invoiceStatus, 60), subject: line(node?.subject, 200),
    client: clientRef(node?.client), address: gqlAddress(node?.properties?.nodes?.[0]), jobNumbers: unique((node?.jobs?.nodes || []).map(job => jobNumberOf(job?.jobNumber))),
    issuedDate: day(node?.issuedDate), dueDate: day(node?.dueDate), totalCents: amounts.total == null ? null : jobberMoneyCents(amounts.total),
    balanceCents: amounts.invoiceBalance == null ? null : jobberMoneyCents(amounts.invoiceBalance), taxCents: amounts.taxAmount == null ? null : jobberMoneyCents(amounts.taxAmount), paidOn: '' };
}
export function recurringFromGraphql(node) {
  const schedule = node?.visitSchedule || {}, startTime = denverWallClock(schedule.startTime), endTime = denverWallClock(schedule.endTime);
  const next = schedule.next, rule = schedule.recurrenceSchedule?.calendarRule, startDate = day(schedule.startDate);
  const names = (schedule.assignedTo?.nodes || []).map(user => line(user?.name?.full, 80)).filter(Boolean);
  return { source: 'graphql', jobNumber: jobNumberOf(node?.jobNumber), title: line(node?.title, 200), client: clientRef(node?.client), address: gqlAddress(node?.property),
    cadenceText: line(schedule.recurrenceSchedule?.friendly, 200), cadence: cadenceFromRule(rule, startDate) || cadenceFromText(schedule.recurrenceSchedule?.friendly, startDate),
    startDate, endsOn: day(schedule.endDate), closedOn: '', time: startTime?.time || '', endTime: endTime?.time || '', nextDate: typeof next?.date === 'string' && validDate(next.date) ? next.date : '',
    assignedTo: names.join(', '), lineItems: '', billingType: '', billingFrequency: '' };
}

const WEEKDAY = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const weekdayOf = date => validDate(date) ? new Date(date + 'T12:00:00Z').getUTCDay() : null;
/** RFC 5545 RRULE → the P1-05 recurring cadence shape, or null when the rule
 * cannot be expressed there (several weekdays, yearly, a weekday that differs
 * from the first visit). null means "set this plan up by hand". */
export function cadenceFromRule(rule, startDate = '') {
  if (typeof rule !== 'string' || !rule.trim()) return null;
  const parts = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').map(part => part.split('=')).filter(pair => pair.length === 2).map(([key, value]) => [key.toUpperCase(), value.toUpperCase()]));
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1, days = parts.BYDAY ? parts.BYDAY.split(',') : [];
  if (!Number.isInteger(interval) || interval < 1) return null;
  if (parts.FREQ === 'WEEKLY') {
    if (days.length > 1 || interval > 52) return null;
    if (days.length === 1 && validDate(startDate) && WEEKDAY[days[0].toLowerCase()] !== weekdayOf(startDate)) return null;
    return interval === 1 ? { frequency: 'weekly' } : interval === 2 ? { frequency: 'biweekly' } : { frequency: 'every_n_weeks', intervalWeeks: interval };
  }
  if (parts.FREQ !== 'MONTHLY' || ![1, 3].includes(interval)) return null;
  const frequency = interval === 3 ? 'quarterly' : 'monthly';
  if (parts.BYMONTHDAY) { const day = Number(parts.BYMONTHDAY); return day === -1 ? { frequency, monthlyBy: 'day_of_month', dayOfMonth: 31 } : Number.isInteger(day) && day >= 1 && day <= 31 ? { frequency, monthlyBy: 'day_of_month', dayOfMonth: day } : null; }
  if (days.length === 1) {
    const match = /^([+-]?\d)?([A-Z]{2})$/.exec(days[0]), nth = match?.[1] ? Number(match[1]) : parts.BYSETPOS ? Number(parts.BYSETPOS) : NaN, weekday = WEEKDAY[match?.[2]?.toLowerCase()];
    return weekday !== undefined && [1, 2, 3, 4, -1].includes(nth) ? { frequency, monthlyBy: 'nth_weekday', nth, weekday } : null;
  }
  if (!days.length && validDate(startDate)) return { frequency, monthlyBy: 'day_of_month', dayOfMonth: Number(startDate.slice(8)) };
  return null;
}
const DAY_WORDS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const ORDINAL_WORDS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 };
const COUNT_WORDS = { other: 2, two: 2, three: 3, four: 4, five: 5, six: 6 };
/** Jobber's plain-text frequency ("Weekly on Mondays", "Every 2 weeks on Tuesday",
 * "Monthly on the 15th", "Every 3 months on the last Friday") → P1-05 cadence. */
export function cadenceFromText(value, startDate = '') {
  const raw = line(value, 200).toLowerCase();
  if (!raw) return null;
  const dayNames = DAY_WORDS.filter(day => new RegExp(`\\b${day}s?\\b`).test(raw));
  let match = /^(?:weekly|every week)\b/.exec(raw) ? ['', '1'] : /^every (\d{1,2}|other|two|three|four|five|six) weeks?\b/.exec(raw);
  if (match) {
    const weeks = COUNT_WORDS[match[1]] || Number(match[1]);
    if (!weeks || weeks > 52 || dayNames.length > 1 || dayNames.length === 1 && validDate(startDate) && DAY_WORDS.indexOf(dayNames[0]) !== weekdayOf(startDate)) return null;
    return weeks === 1 ? { frequency: 'weekly' } : weeks === 2 ? { frequency: 'biweekly' } : { frequency: 'every_n_weeks', intervalWeeks: weeks };
  }
  match = /^(?:monthly|every month)\b/.exec(raw) ? ['', '1'] : /^every (\d{1,2}|three) months?\b/.exec(raw) || (/^quarterly\b/.test(raw) ? ['', '3'] : null);
  if (!match) return null;
  const months = COUNT_WORDS[match[1]] || Number(match[1]);
  if (![1, 3].includes(months)) return null;
  const frequency = months === 3 ? 'quarterly' : 'monthly', nth = /\bthe (first|1st|second|2nd|third|3rd|fourth|4th|last) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(raw);
  if (nth) return { frequency, monthlyBy: 'nth_weekday', nth: ORDINAL_WORDS[nth[1]], weekday: DAY_WORDS.indexOf(nth[2]) };
  if (/\blast day\b/.test(raw)) return { frequency, monthlyBy: 'day_of_month', dayOfMonth: 31 };
  const day = /\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)?\b/.exec(raw) || /\bday (\d{1,2})\b/.exec(raw);
  if (day) { const number = Number(day[1]); return number >= 1 && number <= 31 ? { frequency, monthlyBy: 'day_of_month', dayOfMonth: number } : null; }
  return dayNames.length ? null : validDate(startDate) ? { frequency, monthlyBy: 'day_of_month', dayOfMonth: Number(startDate.slice(8)) } : null;
}

/** Deterministic Hub document ids. A Jobber client, job, completed visit or
 * invoice always maps to the same id, so rerunning an import never duplicates. */
export const hubIds = Object.freeze({
  customer: jobberId => /^\d{1,15}$/.test(jobberId || '') ? `jobber_client_${jobberId}` : '',
  job: jobNumber => /^\d{1,12}$/.test(jobNumber || '') ? `jobber_job_${jobNumber}` : '',
  visit: (jobNumber, schedule) => /^\d{1,12}$/.test(jobNumber || '') && validDate(schedule?.date) ? `jobber_visit_${jobNumber}_${schedule.date.replace(/-/g, '')}_${(schedule.time || '').replace(':', '') || 'anytime'}${schedule.endTime ? '_' + schedule.endTime.replace(':', '') : ''}` : '',
  invoice: number => /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(number || '') ? `jobber_invoice_${number}` : '',
});

export function customerRecord(client, { now, runId, sourceMode }) {
  const phone = client.phones[0] || '', email = client.emails[0] || '', address = client.properties[0]?.address || client.billingAddress;
  return { id: hubIds.customer(client.jobberId), name: client.name, ...(client.firstName ? { firstName: client.firstName } : {}), ...(client.lastName ? { lastName: client.lastName } : {}), ...(client.companyName ? { companyName: client.companyName } : {}),
    phone, email, address: address?.line || '', phoneE164: normalizePhoneE164(phone), emailLower: normalizeEmail(email), source: 'jobber_import',
    provenance: { source: 'jobber', jobberId: client.jobberId, importedAt: now, runId, sourceMode },
    jobber: { otherPhones: client.phones.slice(1), otherEmails: client.emails.slice(1), properties: client.properties.map(property => ({ jobberPropertyId: property.jobberPropertyId, name: property.name, address: property.address.line, notes: property.address.notes })),
      billingAddress: client.billingAddress?.line || '', isCompany: client.isCompany, archived: client.archived, isLead: client.isLead, leadSource: client.leadSource },
    createdAt: now, updatedAt: now, createdBy: JOBBER_IMPORT_ACTOR };
}

// Imported work is never linked to a crew or a provider sync, and customer
// notifications and automatic reminders start off: nothing reaches a customer
// until a manager schedules or messages from the Hub.
const jobBase = (customer, now) => ({ type: 'job', customerId: customer.id, customer: customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(' '), phone: customer.phone || '', email: customer.email || '', assignedCrew: [], assignedTo: '',
  scheduleSource: 'jobber_import', importSource: 'jobber', syncStatus: 'not_needed', notify: false, customerAutomationEnabled: false, timeZone: JOBBER_TIME_ZONE, createdAt: now, updatedAt: now, createdBy: JOBBER_IMPORT_ACTOR });
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dayLabel = date => validDate(date) ? DAY_LABEL.format(new Date(date + 'T12:00:00Z')) : 'no date';
const clockLabel = time => { if (!/^\d{2}:\d{2}$/.test(time || '')) return ''; const hour = Number(time.slice(0, 2)); return `${hour % 12 || 12}:${time.slice(3)} ${hour < 12 ? 'AM' : 'PM'}`; };
export const moneyLabel = cents => Number.isInteger(cents) ? (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'unknown';
export const scheduleLabel = schedule => !schedule?.date ? 'unscheduled' : schedule.allDay ? `${dayLabel(schedule.date)} (anytime)` : [dayLabel(schedule.date), [clockLabel(schedule.time), schedule.endDate && schedule.endDate !== schedule.date ? `${dayLabel(schedule.endDate)} ${clockLabel(schedule.endTime)}` : clockLabel(schedule.endTime)].filter(Boolean).join('–')].filter(Boolean).join(' ') + (schedule.timeNeedsReview ? ' (time needs review)' : '');
export const sortVisits = visits => [...visits].sort((a, b) => (a.schedule.date || '9999').localeCompare(b.schedule.date || '9999') || (a.schedule.time || '').localeCompare(b.schedule.time || ''));

/** Upcoming or unscheduled Jobber visits of one job become ONE unscheduled,
 * unassigned Hub job flagged for dispatch review. Its Jobber dates are kept as
 * notes only: the dispatcher schedules it through dispatch's conflict checks.
 * A one-off job with several visits says so: this job holds one of them and the
 * rest are added in Dispatch (the planner lists them in multiVisitJobs). */
export function futureJobRecord(group, customer, { now, runId, fingerprint = '' }) {
  const visits = sortVisits(group.visits), first = visits[0] || {}, title = line(first.title, 200) || `Jobber job #${group.jobNumber}`;
  const names = unique(visits.flatMap(visit => String(visit.assignedTo || '').split(/\s*,\s*/))), values = visits.map(visit => visit.valueCents);
  const valueCents = values.length && values.every(Number.isInteger) ? values.reduce((sum, value) => sum + value, 0) : null;
  const scope = text([title, first.lineItems && 'Line items: ' + first.lineItems, first.instructions && 'Instructions: ' + first.instructions].filter(Boolean).join('\n'), 4000);
  const shown = visits.slice(0, 10).map(visit => scheduleLabel(visit.schedule)), more = visits.length > 10 ? `; and ${visits.length - 10} more` : '';
  const next = group.jobType !== 'recurring' && visits.length > 1 ? `then schedule each of these ${visits.length} visits: this job holds one of them, so add the other ${visits.length - 1} in Dispatch as new jobs for this customer.` : 'then schedule it here.';
  const opsNotes = text(`Imported from Jobber job #${group.jobNumber} and needs dispatch review before scheduling. Jobber ${visits.length === 1 ? 'visit' : `visits (${visits.length})`}: ${shown.join('; ')}${more}.${names.length ? ` Jobber crew: ${names.join(', ')}.` : ''}${group.jobType === 'recurring' ? ' This is a recurring Jobber job: set up its repeat plan in the Hub after scheduling the next visit.' : ''} Jobber value: ${moneyLabel(valueCents)}. Confirm the price, crew and time, ${next} Customer notifications and automatic reminders are off; nothing was sent to the customer.`, 5000);
  return { id: hubIds.job(group.jobNumber), ...jobBase(customer, now), title, serviceType: title, address: first.address?.line || customer.address || '', highlevelContactId: customer.highlevelContactId || '',
    date: '', time: '', endDate: '', endTime: '', startAt: null, endAt: null, crewLead: null, crewId: null, vehicleId: null, crewNeeded: 1, travelBufferMinutes: 20,
    status: 'unscheduled', pipelineStatus: 'unscheduled', needsDispatchReview: true, dispatchReviewReason: 'jobber_import',
    ...(scope ? { operationalScope: { text: scope, updatedBy: JOBBER_IMPORT_ACTOR, updatedAt: now, reason: 'Imported from Jobber', approvalKind: 'staff_operational_instructions' } } : {}), opsNotes,
    jobber: { jobNumber: group.jobNumber, jobType: group.jobType || '', jobberClientId: group.jobberClientId, visitCount: visits.length, visits: visits.slice(0, 50).map(({ schedule }) => ({ date: schedule.date, time: schedule.time, endDate: schedule.endDate, endTime: schedule.endTime, allDay: schedule.allDay, timeNeedsReview: schedule.timeNeedsReview })),
      assignedTo: names.join(', '), valueCents, runId, importedAt: now, importFingerprint: fingerprint } };
}

/** A completed past visit becomes a read-only history record. recordType keeps
 * it out of dispatch, crew, conflict and finance-fact readers. */
export function historyRecord(visit, customer, { now, runId }) {
  const { schedule } = visit, title = line(visit.title, 200) || `Jobber job #${visit.jobNumber}`;
  return { id: hubIds.visit(visit.jobNumber, schedule), ...jobBase(customer, now), recordType: 'jobber_history', title, serviceType: title, address: visit.address?.line || customer.address || '',
    date: schedule.date, time: schedule.time, endDate: schedule.endDate, endTime: schedule.endTime, startAt: schedule.startAt, endAt: schedule.endAt, ...(schedule.allDay ? { allDay: true } : {}), ...(schedule.timeNeedsReview ? { timeNeedsReview: true } : {}),
    status: 'completed', pipelineStatus: 'completed', completedAt: visit.completedAt || schedule.endAt || null,
    jobber: { jobNumber: visit.jobNumber, jobType: visit.jobType || '', jobberClientId: visit.jobberClientId, assignedTo: visit.assignedTo || '', valueCents: visit.valueCents ?? null, lineItems: visit.lineItems || '', runId, importedAt: now } };
}

/** An open Jobber invoice becomes an opening balance: the Hub invoice amount is
 * the unpaid balance (payments taken in Jobber stay in Jobber), so no payment is
 * fabricated. It is flagged imported and is never charged by the import. */
export function invoiceRecord(invoice, customer, { now, runId, fingerprint = '' }) {
  const balance = invoice.balanceCents, dollars = balance / 100, number = invoice.invoiceNumber;
  const paidCents = Number.isInteger(invoice.totalCents) && Number.isInteger(balance) ? invoice.totalCents - balance : null, title = invoice.subject || `Jobber invoice #${number}`;
  const description = `Original total ${moneyLabel(invoice.totalCents)}; ${moneyLabel(paidCents)} paid in Jobber before the move to the EGC Hub.`;
  const dates = [invoice.issuedDate && `issued ${dayLabel(invoice.issuedDate)}`, invoice.dueDate && `due ${dayLabel(invoice.dueDate)}`].filter(Boolean).join(', ');
  return { id: hubIds.invoice(number), ...jobBase(customer, now), title, serviceType: title, address: invoice.address?.line || customer.address || '', date: '', time: '', endDate: '', endTime: '',
    status: 'invoiced', pipelineStatus: 'invoiced',
    invoice: { number: `JOBBER-${number}`, status: 'issued', amount: dollars, paid: 0, balance: dollars, amountCents: balance, balanceCents: balance, dueDate: invoice.dueDate || '',
      issuedAt: invoice.issuedDate ? localInstant(invoice.issuedDate, '12:00') : null, issuedDate: invoice.issuedDate || '',
      lineItems: [{ name: `Balance carried over from Jobber invoice #${number}`, description, quantity: 1, amount: dollars, amountCents: balance }], source: 'jobber_import', imported: true, updatedAt: now },
    opsNotes: text(`Imported open balance of ${moneyLabel(balance)} from Jobber invoice #${number}${dates ? ` (${dates})` : ''}. ${description} Collect it and record the payment in Hub finance. Nothing was charged or sent to the customer by the import.`, 5000),
    jobber: { invoiceNumber: number, status: invoice.status, totalCents: invoice.totalCents ?? null, paidCents, balanceCents: balance, taxCents: invoice.taxCents ?? null, subject: invoice.subject || '', jobNumbers: invoice.jobNumbers || [],
      issuedDate: invoice.issuedDate || '', dueDate: invoice.dueDate || '', jobberClientId: invoice.jobberClientId, runId, importedAt: now, importFingerprint: fingerprint } };
}

/** Report-only recurring plan proposal in the P1-05 plan input shape. */
export function recurringPlanProposal(recurring, { customerId, nextVisit = null }) {
  const startDate = nextVisit?.date || recurring.nextDate || recurring.startDate || '';
  return { jobNumber: recurring.jobNumber, customerId, title: recurring.title || `Jobber job #${recurring.jobNumber}`, cadence: recurring.cadence || null, cadenceText: recurring.cadenceText || '',
    startDate, time: nextVisit?.time || recurring.time || '', endTime: nextVisit?.endTime || recurring.endTime || '', endsOn: recurring.endsOn || null,
    needsManualSetup: !recurring.cadence || !validDate(startDate), status: 'report_only' };
}

/** Report masking: first initials, last four phone digits, first email letter
 * and domain, and city/state only. Ids are not personal data. */
export const maskName = value => String(value ?? '').trim().split(/\s+/).filter(Boolean).map(word => word[0].toUpperCase() + '***').join(' ');
export const maskPhone = value => { const digits = String(value ?? '').replace(/\D/g, ''); return digits.length >= 4 ? '***-***-' + digits.slice(-4) : digits ? '***' : ''; };
export const maskEmail = value => { const [local, domain] = String(value ?? '').split('@'); return domain ? (local[0] || '') + '***@' + domain : value ? '***' : ''; };
export const maskAddress = address => address?.city ? [address.city, address.state].filter(Boolean).join(', ') : address?.line ? '***' : '';
export const maskedClient = client => ({ jobberClientId: client?.jobberId || '', name: maskName(client?.name), phone: maskPhone(client?.phones?.[0]), email: maskEmail(client?.emails?.[0]), area: maskAddress(client?.properties?.[0]?.address || client?.billingAddress) });
