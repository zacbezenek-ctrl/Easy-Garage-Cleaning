import test from 'node:test';
import assert from 'node:assert/strict';
import * as map from '../functions/_lib/jobber-import-map.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { csvSource, graphqlSource, planJobberImport, runJobberImport, sourceFingerprint, normalizeResolutions, parseArgs, writeReportFile, JOBS_COLLECTION_SAFE_LIMIT } from '../scripts/jobber-import.mjs';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { resolveDispatchLineage } from '../functions/_lib/dispatch-lineage.js';
import { dispatchSearch } from '../functions/_lib/dispatch-search.js';
import { customerMoneyState } from '../functions/_lib/customer-payments.js';
import { financialFacts, summarizeFinancialJobs } from '../functions/_lib/operations-financials.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-09-22T18:00:00.000Z'; // 12:00 PM Tuesday in Denver
const csv = rows => rows.map(row => row.map(value => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(',')).join('\r\n') + '\r\n';
const CLIENT_HEADERS = ['J-ID','Display Name','Company Name','Title','First Name','Last Name','Main Phone #s','Mobile Phone #s','Work','Home','Text Message Enabled Phone #','E-mails','Tags','Billing Street 1','Billing Street 2','Billing City','Billing State','Billing Zip code','Service Property Name','Service Street 1','Service Street 2','Service City','State','Zip','Lead Source','Created Date','Is Company?','Archived'];
const client = (jid, first, last, { phone = '', mobile = '', email = '', street = '', company = '', isCompany = 'false', archived = 'false' } = {}) => {
  const row = Object.fromEntries(CLIENT_HEADERS.map(header => [header, '']));
  Object.assign(row, { 'J-ID': jid, 'Display Name': [first, last].filter(Boolean).join(' '), 'First Name': first, 'Last Name': last, 'Main Phone #s': phone, 'Mobile Phone #s': mobile, 'E-mails': email, 'Company Name': company, 'Is Company?': isCompany, Archived: archived,
    'Service Street 1': street, 'Service City': street ? 'fort collins' : '', State: street ? 'Colorado' : '', Zip: street ? '80525' : '' });
  return CLIENT_HEADERS.map(header => row[header]);
};
const CLIENT_ROWS = () => [
  client('1001_5001', 'Synthetic', 'Alpha', { phone: '970.555.0101', email: 'alpha@example.invalid', street: '101 Synthetic Street' }),
  client('1002_5002', 'Synthetic', 'Bravo', { email: 'BRAVO@Example.invalid', street: '102 Synthetic Ave' }),
  client('1002_5003', 'Synthetic', 'Bravo', { email: 'bravo@example.invalid', street: '202 Second Synthetic Rd' }),
  client('1003_5004', 'Synthetic', 'Charlie', { phone: '(970) 555-0103, 970-555-0113', street: '103 Synthetic Ct (side door)' }),
  client('1004_5005', 'Synthetic', 'Delta', { phone: '+1 970 555 0104', street: '104 Synthetic Dr' }),
  client('1005_5006', 'Synthetic', 'Echo', { email: 'echo@example.invalid', street: '105 Synthetic Ln' }),
  client('1006_5007', 'Synthetic', 'Echo Twin', { email: 'Echo@example.invalid', street: '105 Synthetic Ln' }),
  client('1007_5008', '', '', { phone: '970-555-0107', company: 'Synthetic Foxtrot LLC', isCompany: 'true', street: '107 Synthetic Pkwy' }),
  client('1008_5009', 'Synthetic', 'Golf', { street: '108 Synthetic Way', archived: 'true' }),
];
const CLIENTS = () => csv([CLIENT_HEADERS, ...CLIENT_ROWS()]);
const VISIT_HEADERS = ['Job #','Date','Times','Title','Client name','Client email','Client phone','Service street','Service city','Service province','Service ZIP','Completed','Assigned to','Line items','One-off job ($)','Visit based ($)','Job type'];
const visit = (job, date, times, name, { email = '', phone = '', street = '', completed = '', assigned = 'Synthetic Crew A', value = '', type = 'One-off', title = 'Garage cleanout' } = {}) => [job, date, times, title, name, email, phone, street, 'Fort Collins', 'CO', '80525', completed, assigned, 'Cleanout x1', value, '', type];
const VISITS = () => csv([VISIT_HEADERS,
  visit('2001', 'Sep 24, 2026', '9:00 AM - 11:00 AM', 'Synthetic Alpha', { phone: '9705550101', value: '$250.00' }),
  visit('2001', 'Sep 25, 2026', '9:00 AM - 1:00 PM', 'Synthetic Alpha', { phone: '9705550101', value: '$200.00', assigned: 'Synthetic Crew B' }),
  visit('2002', 'Sep 10, 2026', '1:00 PM - 3:00 PM', 'Synthetic Charlie', { phone: '970 555 0113', completed: 'Sep 10, 2026', value: '$400.00' }),
  visit('2003', 'Sep 15, 2026', '8:00 AM - 10:00 AM', 'Synthetic Bravo', { email: 'bravo@example.invalid' }),
  visit('2004', 'Oct 1, 2026', '10:00 AM - 12:00 PM', 'Synthetic Delta', { phone: '970-555-0104' }),
  visit('2005', 'Oct 2, 2026', '10:00 AM - 12:00 PM', 'Synthetic Unknown', { phone: '970-555-0199' }),
  visit('2006', 'Oct 5, 2026', '8:00 AM - 10:00 AM', 'Synthetic Charlie', { street: '103 Synthetic Court', type: 'Recurring', title: 'Garage tidy' }),
  visit('2007', 'Mar 3, 2024', '9:00 AM - 10:00 AM', 'Synthetic Alpha', { email: 'alpha@example.invalid', completed: 'Mar 3, 2024' }),
]);
const INVOICE_HEADERS = ['Invoice #','Client name','Client email','Client phone','Status','Subject','Issued date','Due date','Job #s','Total ($)','Balance ($)','Tax amount ($)'];
const INVOICES = () => csv([INVOICE_HEADERS,
  ['3001', 'Synthetic Alpha', 'alpha@example.invalid', '', 'Awaiting Payment', 'Garage cleanout', 'Sep 1, 2026', 'Sep 15, 2026', '1999', '$450.00', '$200.00', '$0.00'],
  ['3002', 'Synthetic Charlie', '', '970-555-0103', 'Past Due', 'Garage tidy', '08/20/2026', '09/03/2026', '2002, 1998', '$300.00', '$300.00', '$21.00'],
  ['3003', 'Synthetic Bravo', 'bravo@example.invalid', '', 'Paid', 'Paid work', 'Aug 1, 2026', 'Aug 15, 2026', '', '$100.00', '$0.00', ''],
  ['3004', 'Synthetic Charlie', '', '970-555-0103', 'Draft', 'Draft work', '', '', '', '$80.00', '$80.00', ''],
  ['3005', 'Synthetic Stranger', 'stranger@example.invalid', '', 'Awaiting Payment', 'Other', 'Sep 5, 2026', 'Sep 19, 2026', '', '$90.00', '$90.00', ''],
]);
const RECURRING = () => csv([['Job #','Title','Client name','Client email','Client phone','Visit frequency','Scheduled start on'],
  ['2006', 'Garage tidy', 'Synthetic Charlie', '', '970-555-0103', 'Every 2 weeks on Mondays', 'Oct 5, 2026'],
  ['2008', 'Monthly reset', 'Synthetic Alpha', 'alpha@example.invalid', '', 'Weekly on Mondays and Thursdays', 'Sep 3, 2026']]);
const FILES = () => ({ clients: CLIENTS(), visits: VISITS(), invoices: INVOICES(), recurring: RECURRING() });
const RESOLVED = { clients: { 1004: { customerId: 'customer_delta_a' }, 1005: { action: 'create' }, 1006: { customerId: 'jobber_client_1005' } }, jobs: { 2005: { action: 'skip' } }, invoices: { 3005: { action: 'skip' } } };
const HUB_CUSTOMERS = () => [
  { id: 'customer_alpha', name: 'Synthetic Alpha', phone: '(970) 555-0101', email: 'alpha.old@example.invalid' },
  { id: 'customer_bravo', name: 'Synthetic Bravo', phone: '', email: 'bravo@example.invalid' },
  { id: 'customer_delta_a', name: 'Synthetic Delta', phone: '9705550104', email: '' },
  { id: 'customer_delta_b', name: 'Synthetic Delta Other', phone: '970-555-0104', email: '' },
];
const HUB_JOBS = () => [{ id: 'existing-job', type: 'job', customerId: 'customer_alpha', status: 'scheduled' }, { id: '_egc_schedule_lock_2026-09-24', recordType: 'schedule_lock' }];
const PII = /Synthetic (?:Alpha|Bravo|Charlie|Delta|Echo|Foxtrot|Golf|Crew)|alpha@|bravo@|echo@|555-?0101|5550101|0103|Synthetic Street|Synthetic Ave/i;

function memoryStore({ customers = HUB_CUSTOMERS(), jobs = HUB_JOBS(), docs = [], roster = [] } = {}) {
  const rows = new Map(), commits = [];let tick = 0, hook = null, lose = false;
  const put = (collection, row) => rows.set(`${collection}/${row.id}`, { ...structuredClone(row), revision: row.revision || `seed-${++tick}` });
  customers.forEach(row => put('customers', row)); jobs.forEach(row => put('jobs', row)); docs.forEach(([collection, row]) => put(collection, row));
  const scan = prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => structuredClone(row));
  return { rows, commits, beforeCommit: fn => { hook = fn; }, loseNext: () => { lose = true; },
    customers: async () => scan('customers/'), jobs: async () => scan('jobs/'), resources: async () => scan('dispatchResources/'), roster: async () => structuredClone(roster),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) ?? null),
    commit: async writes => {
      if (hook) { const fn = hook; hook = null; fn(rows); }
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, current = rows.get(key);
        assert.ok(!seen.has(key), 'no duplicate writes per commit');seen.add(key);
        if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('Changed'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `w${++tick}` });
      if (lose) { lose = false; throw Object.assign(new Error('Lost'), { code: 'dispatch_outcome_unknown', status: 503 }); }
    } };
}
const blockFetch = t => t.mock.method(globalThis, 'fetch', async url => { throw new Error('Unexpected network call to ' + url); });

test('CSV parsing handles BOM, CRLF, quoted commas, doubled quotes, quoted line breaks and blank rows', () => {
  const parsed = map.parseCsv('﻿J-ID,Name\r\n"1_2","Doe, ""Synthetic"""\r\n\r\n"3_4","two\nlines"\n5_6,last');
  assert.deepEqual(parsed.headers, ['J-ID', 'Name']);
  assert.deepEqual(parsed.rows.map(row => [row.line, row.cells]), [[2, ['1_2', 'Doe, "Synthetic"']], [4, ['3_4', 'two\nlines']], [6, ['5_6', 'last']]]);
  assert.throws(() => map.parseCsv('a,b\n"open,1'), /never closed/);
  assert.throws(() => map.parseCsv('\r\n \r\n'), /no header/);
  assert.throws(() => map.parseCsv(null), /as text/);
});

test('Jobber export headers resolve to canonical fields; a mapping overrides and problems are reported', () => {
  assert.equal(map.headerKey('Main Phone #s'), 'mainphonenumbers');assert.equal(map.headerKey('Balance ($)'), 'balance');assert.equal(map.headerKey('J-ID'), 'jid');assert.equal(map.headerKey('Job #'), 'jobnumber');
  const clients = map.mapColumns('clients', CLIENT_HEADERS);
  assert.deepEqual(clients.missing, []);
  assert.equal(CLIENT_HEADERS[clients.columns.state], 'State');assert.equal(CLIENT_HEADERS[clients.columns.billingState], 'Billing State');assert.equal(CLIENT_HEADERS[clients.columns.mainPhones], 'Main Phone #s');
  assert.deepEqual(clients.unknownHeaders, ['Tags']);
  const visits = map.mapColumns('visits', ['Job #', 'Visit Day', 'Client name', 'Mystery'], { date: 'visit day' });
  assert.equal(visits.columns.date, 1);assert.deepEqual(visits.missing, []);assert.deepEqual(visits.unknownHeaders, ['Mystery']);
  const broken = map.mapColumns('invoices', ['Invoice #', 'Status', 'Invoice #'], { balance: 'Amount owing', __proto__: 'x', colour: 'Status' });
  assert.deepEqual(broken.missing, ['balance', 'clientName or clientEmail or clientPhone']);
  assert.equal(broken.problems.length, 2);assert.deepEqual(broken.duplicateHeaders, ['Invoice #']);
  assert.throws(() => map.mapColumns('quotes', []), /Unknown Jobber export kind/);
});

test('phones normalize to E.164 like P4-02 customer identity; emails to exact lowercase', () => {
  for (const value of ['970-555-0101', '(970) 555-0101', '+1 970 555 0101', '1.970.555.0101', 'tel:9705550101', '970 555 0101 ext 12', 9705550101]) assert.equal(map.normalizePhoneE164(value), '+19705550101', String(value));
  assert.equal(map.normalizePhoneE164('+44 20 7946 0958'), '+442079460958');
  for (const value of ['555-0101', '070-555-0101', '970-055-0101', '', null, '+1 970 555 010']) assert.equal(map.normalizePhoneE164(value), '', String(value));
  assert.deepEqual(map.phoneList('(970) 555-0103, 970-555-0113', '970.555.0103\n', 'n/a'), { phones: ['+19705550103', '+19705550113'], invalid: ['n/a'] });
  assert.equal(map.normalizeEmail(' Mailto:First.Last+egc@Example.Invalid '), 'first.last+egc@example.invalid');
  assert.equal(map.normalizeEmail('not an email'), '');
  assert.deepEqual(map.emailList('A@example.invalid; b@example.invalid a@EXAMPLE.invalid, nope'), { emails: ['a@example.invalid', 'b@example.invalid'], invalid: ['nope'] });
});

test('addresses normalize state names, ZIP+4, case and parenthetical notes; keys ignore USPS spelling', () => {
  assert.deepEqual(map.normalizeAddress({ street1: ' 103  Synthetic Ct (side door) ', street2: 'Unit 2', city: 'FORT COLLINS', state: 'colorado', zip: 'ZIP 805251234' }),
    { street1: '103 Synthetic Ct', street2: 'Unit 2', city: 'Fort Collins', state: 'CO', zip: '80525-1234', line: '103 Synthetic Ct, Unit 2, Fort Collins, CO 80525-1234', notes: ['side door'] });
  assert.equal(map.normalizeAddress({ city: 'Loveland', state: 'co', zip: '80537' }).line, 'Loveland, CO 80537');
  assert.equal(map.normalizeAddress({}).line, '');
  assert.equal(map.addressKey('103 Synthetic Court, North'), map.addressKey('103 synthetic ct n'));
  assert.notEqual(map.addressKey('103 Synthetic Ct'), map.addressKey('104 Synthetic Ct'));
});

test('money is exact integer cents and unknown stays null', () => {
  assert.equal(map.jobberMoneyCents('$1,234.50'), 123450);assert.equal(map.jobberMoneyCents('1234.5'), 123450);assert.equal(map.jobberMoneyCents('USD 0'), null);
  assert.equal(map.jobberMoneyCents('(12.00)'), -1200);assert.equal(map.jobberMoneyCents('-$5'), -500);assert.equal(map.jobberMoneyCents('$-5.25'), -525);assert.equal(map.jobberMoneyCents('-0.00'), 0);
  for (const value of ['', '  ', '12.345', '1,23.00', 'abc', null, undefined, {}]) assert.equal(map.jobberMoneyCents(value), null, String(value));
  assert.equal(map.jobberMoneyCents(123.45), 12345);assert.equal(map.jobberMoneyCents(0.1 + 0.2), 30);assert.equal(map.jobberMoneyCents(Number.NaN), null);
  assert.equal(map.moneyLabel(123450), '$1,234.50');assert.equal(map.moneyLabel(-500), '-$5.00');assert.equal(map.moneyLabel(null), 'unknown');
});

test('Jobber local dates and times are read as Denver wall clock; offsets convert and DST gaps need review', () => {
  assert.deepEqual(map.parseJobberDate('Sep 24, 2026'), { date: '2026-09-24', time: '' });
  assert.deepEqual(map.parseJobberDate('Thu Sep 24, 2026 9:00 AM'), { date: '2026-09-24', time: '09:00' });
  assert.deepEqual(map.parseJobberDate('Thursday, September 24th, 2026 at 1:30pm'), { date: '2026-09-24', time: '13:30' });
  assert.deepEqual(map.parseJobberDate('9/24/2026'), { date: '2026-09-24', time: '' });
  assert.deepEqual(map.parseJobberDate('09/24/26 14:05'), { date: '2026-09-24', time: '14:05' });
  assert.deepEqual(map.parseJobberDate('24 Sept 2026'), { date: '2026-09-24', time: '' });
  assert.deepEqual(map.parseJobberDate('2026-09-24 08:15'), { date: '2026-09-24', time: '08:15' });
  assert.deepEqual(map.parseJobberDate('2026-09-24T15:00:00Z'), { date: '2026-09-24', time: '09:00' }, 'MDT is UTC-6');
  assert.deepEqual(map.parseJobberDate('2026-12-01T16:00:00Z'), { date: '2026-12-01', time: '09:00' }, 'MST is UTC-7');
  assert.deepEqual(map.parseJobberDate('2026-09-25T05:30:00Z'), { date: '2026-09-24', time: '23:30' }, 'a UTC date can be the previous Denver day');
  assert.deepEqual(map.parseJobberDate('2026-09-24T09:00:00-0600'), { date: '2026-09-24', time: '09:00' });
  for (const value of ['2026-02-30', '13/01/2026', 'Smarch 3, 2026', 'Monday 24 2026', 'Sep 24, 2026 25:00', '2026-09-24 24:00', '']) assert.equal(map.parseJobberDate(value), null, value);
  assert.deepEqual(map.parseTimes('9:00 AM - 11:00 AM'), { allDay: false, time: '09:00', endTime: '11:00' });
  assert.deepEqual(map.parseTimes('9am–11:30am'), { allDay: false, time: '09:00', endTime: '11:30' });
  assert.deepEqual(map.parseTimes('9 - 11 am'), { allDay: false, time: '09:00', endTime: '11:00' });
  assert.deepEqual(map.parseTimes('11 - 1 pm'), { allDay: false, time: '11:00', endTime: '13:00' });
  assert.deepEqual(map.parseTimes('12:00 PM to 12:30 PM'), { allDay: false, time: '12:00', endTime: '12:30' });
  assert.deepEqual(map.parseTimes('Anytime'), { allDay: true, time: '', endTime: '' });
  assert.equal(map.parseTimes('9:00 AM - soon'), null);assert.equal(map.parseTimes('1 - 2 - 3'), null);
  assert.equal(map.parseClock('12 AM'), '00:00');assert.equal(map.parseClock('noon'), '12:00');assert.equal(map.parseClock('13 PM'), null);
  assert.equal(map.parseDurationMinutes('2 hrs 30 mins'), 150);assert.equal(map.parseDurationMinutes('1.5 hours'), 90);assert.equal(map.parseDurationMinutes('02:15'), 135);assert.equal(map.parseDurationMinutes('soon'), null);
});

test('visit schedules carry Denver dates, derived UTC instants and a review flag instead of guessed times', () => {
  assert.deepEqual(map.visitSchedule({ date: 'Sep 24, 2026', times: '9:00 AM - 11:00 AM' }), { date: '2026-09-24', time: '09:00', endDate: '2026-09-24', endTime: '11:00', allDay: false, startAt: '2026-09-24T15:00:00.000Z', endAt: '2026-09-24T17:00:00.000Z', timeNeedsReview: false });
  assert.deepEqual(map.visitSchedule({ date: 'Sep 24, 2026 9:00 AM', duration: '2 hrs 30 mins' }).endAt, '2026-09-24T17:30:00.000Z');
  assert.equal(map.visitSchedule({ date: 'Nov 1, 2026', times: '1:30 AM - 3:00 AM' }).timeNeedsReview, true, 'an ambiguous fall-back hour is never guessed');
  const gap = map.visitSchedule({ date: '2027-03-14', times: '2:30 AM - 4:00 AM' });
  assert.equal(gap.startAt, null);assert.equal(gap.timeNeedsReview, true);assert.equal(gap.date, '2027-03-14');
  assert.equal(map.visitSchedule({ date: 'Sep 24, 2026', times: 'whenever' }).timeNeedsReview, true);
  assert.equal(map.visitSchedule({ date: 'Sep 24, 2026', times: '3:00 PM - 1:00 PM' }).timeNeedsReview, true);
  assert.deepEqual(map.visitSchedule({ date: 'Sep 24, 2026', times: 'Anytime' }), { date: '2026-09-24', time: '', endDate: '2026-09-24', endTime: '', allDay: true, startAt: null, endAt: null, timeNeedsReview: false });
  assert.deepEqual(map.visitSchedule({ date: '' }).date, '');
  assert.equal(map.visitSchedule({ date: 'someday' }).timeNeedsReview, true);
  const fromInstants = map.scheduleFromInstants({ startAt: '2026-12-01T16:00:00Z', endAt: '2026-12-01T18:00:00Z' });
  assert.deepEqual([fromInstants.date, fromInstants.time, fromInstants.endTime, fromInstants.startAt], ['2026-12-01', '09:00', '11:00', '2026-12-01T16:00:00.000Z']);
  assert.deepEqual(map.scheduleFromInstants({ startAt: '2026-09-24T06:00:00Z', endAt: '2026-09-26T06:00:00Z', allDay: true }), { date: '2026-09-24', time: '', endDate: '2026-09-25', endTime: '', allDay: true, startAt: null, endAt: null, timeNeedsReview: false });
  assert.equal(map.scheduleFromInstants({}).date, '');
  const schedule = map.visitSchedule({ date: 'Sep 22, 2026', times: '11:00 AM - 1:00 PM' });
  assert.equal(map.visitTiming(schedule, NOW), 'upcoming', 'a visit still in progress at noon is not past');
  assert.equal(map.visitTiming(schedule, '2026-09-22T19:00:00.000Z'), 'past');
  assert.equal(map.visitTiming(map.visitSchedule({ date: 'Sep 22, 2026', times: 'Anytime' }), '2026-09-23T05:59:00.000Z'), 'upcoming', 'Denver is still on Sep 22 at 11:59 PM');
  assert.equal(map.visitTiming(map.visitSchedule({ date: 'Sep 22, 2026', times: 'Anytime' }), '2026-09-23T06:01:00.000Z'), 'past');
  assert.equal(map.visitTiming(map.visitSchedule({ date: '' }), NOW), 'unscheduled');
  assert.throws(() => map.visitTiming(schedule, 'not a time'), /valid current time/);
});

test('recurring frequencies map to the P1-05 cadence shape or null for manual setup', () => {
  assert.deepEqual(map.cadenceFromText('Weekly on Mondays', '2026-09-28'), { frequency: 'weekly' });
  assert.equal(map.cadenceFromText('Weekly on Mondays', '2026-09-29'), null, 'a weekday that differs from the first visit is not guessed');
  assert.deepEqual(map.cadenceFromText('Every other week'), { frequency: 'biweekly' });
  assert.deepEqual(map.cadenceFromText('Every 3 weeks on Friday'), { frequency: 'every_n_weeks', intervalWeeks: 3 });
  assert.deepEqual(map.cadenceFromText('Monthly on the 15th'), { frequency: 'monthly', monthlyBy: 'day_of_month', dayOfMonth: 15 });
  assert.deepEqual(map.cadenceFromText('Monthly on the last day of the month'), { frequency: 'monthly', monthlyBy: 'day_of_month', dayOfMonth: 31 });
  assert.deepEqual(map.cadenceFromText('Every 3 months on the last Friday'), { frequency: 'quarterly', monthlyBy: 'nth_weekday', nth: -1, weekday: 5 });
  assert.deepEqual(map.cadenceFromText('Monthly', '2026-10-07'), { frequency: 'monthly', monthlyBy: 'day_of_month', dayOfMonth: 7 });
  for (const value of ['Weekly on Mondays and Thursdays', 'Every 2 months', 'Yearly', 'As needed', '']) assert.equal(map.cadenceFromText(value, '2026-09-28'), null, value);
  assert.deepEqual(map.cadenceFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-09-29'), { frequency: 'biweekly' });
  assert.deepEqual(map.cadenceFromRule('RRULE:FREQ=MONTHLY;BYDAY=2TU'), { frequency: 'monthly', monthlyBy: 'nth_weekday', nth: 2, weekday: 2 });
  assert.deepEqual(map.cadenceFromRule('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1'), { frequency: 'monthly', monthlyBy: 'nth_weekday', nth: -1, weekday: 5 });
  assert.deepEqual(map.cadenceFromRule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1'), { frequency: 'quarterly', monthlyBy: 'day_of_month', dayOfMonth: 31 });
  for (const rule of ['FREQ=WEEKLY;BYDAY=MO,TH', 'FREQ=YEARLY', 'FREQ=MONTHLY;INTERVAL=2', 'FREQ=WEEKLY;INTERVAL=0', 'FREQ=MONTHLY;BYDAY=5MO', null]) assert.equal(map.cadenceFromRule(rule, '2026-09-28'), null, String(rule));
});

test('the client export groups one row per property by J-ID and keeps contacts in order', () => {
  const parsed = map.parseCsv(CLIENTS()), { clients, problems } = map.clientsFromCsv(parsed, map.mapColumns('clients', parsed.headers).columns);
  assert.deepEqual(problems, []);assert.equal(clients.length, 8);
  const bravo = clients.find(entry => entry.jobberId === '1002');
  assert.deepEqual(bravo.emails, ['bravo@example.invalid']);
  assert.deepEqual(bravo.properties.map(property => [property.jobberPropertyId, property.address.line]), [['5002', '102 Synthetic Ave, Fort Collins, CO 80525'], ['5003', '202 Second Synthetic Rd, Fort Collins, CO 80525']]);
  const charlie = clients.find(entry => entry.jobberId === '1003');
  assert.deepEqual(charlie.phones, ['+19705550103', '+19705550113']);assert.deepEqual(charlie.properties[0].address.notes, ['side door']);
  const foxtrot = clients.find(entry => entry.jobberId === '1007');
  assert.equal(foxtrot.name, 'Synthetic Foxtrot LLC');assert.equal(foxtrot.isCompany, true);
  assert.equal(clients.find(entry => entry.jobberId === '1008').archived, true);
  const bad = map.clientsFromCsv({ rows: [{ line: 7, cells: ['C-12'] }] }, { jid: 0 });
  assert.deepEqual(bad.problems, [{ file: 'clients', line: 7, reason: 'jobber_id_invalid' }]);
});

test('Hub record mappers keep imported work unassigned, unscheduled, silent and uncharged', () => {
  const customer = { id: 'customer_alpha', name: 'Synthetic Alpha', phone: '+19705550101', email: 'alpha@example.invalid', address: '101 Synthetic St', highlevelContactId: 'ghl_synthetic' };
  const visits = map.visitsFromCsv(map.parseCsv(VISITS()), map.mapColumns('visits', VISIT_HEADERS).columns).visits;
  const job = map.futureJobRecord({ jobNumber: '2001', jobType: 'one_off', jobberClientId: '1001', visits: visits.filter(entry => entry.jobNumber === '2001').reverse() }, customer, { now: NOW, runId: 'run-a', fingerprint: 'f1' });
  assert.equal(job.id, 'jobber_job_2001');
  assert.deepEqual([job.type, job.status, job.pipelineStatus, job.date, job.time, job.startAt, job.assignedTo, job.crewLead, job.vehicleId], ['job', 'unscheduled', 'unscheduled', '', '', null, '', null, null]);
  assert.deepEqual(job.assignedCrew, []);
  assert.deepEqual([job.needsDispatchReview, job.dispatchReviewReason, job.notify, job.customerAutomationEnabled, job.syncStatus, job.scheduleSource, job.importSource], [true, 'jobber_import', false, false, 'not_needed', 'jobber_import', 'jobber']);
  assert.equal(job.customerId, 'customer_alpha');assert.equal(job.highlevelContactId, 'ghl_synthetic');
  assert.deepEqual(job.jobber.visits.map(entry => entry.date), ['2026-09-24', '2026-09-25'], 'visits are ordered by date');
  assert.equal(job.jobber.valueCents, 45000);assert.equal(job.jobber.assignedTo, 'Synthetic Crew A, Synthetic Crew B');
  assert.match(job.opsNotes, /Jobber job #2001 and needs dispatch review/);assert.match(job.opsNotes, /Thu, Sep 24, 2026 9:00 AM–11:00 AM; Fri, Sep 25, 2026 9:00 AM–1:00 PM/);assert.match(job.opsNotes, /nothing was sent to the customer/);
  assert.match(job.operationalScope.text, /^Garage cleanout\nLine items: Cleanout x1$/);
  for (const key of ['estimate', 'invoice', 'payment', 'deposit', 'priceQuoted', 'total', 'shiftPickupEnabled', 'openShift']) assert.equal(job[key], undefined, key);
  assert.equal(map.futureJobRecord({ jobNumber: '9', visits: [{ ...visits[0], valueCents: null }, visits[1]] }, customer, { now: NOW }).jobber.valueCents, null, 'an unknown visit value keeps the total unknown');
  assert.match(job.opsNotes, /then schedule each of these 2 visits: this job holds one of them, so add the other 1 in Dispatch as new jobs for this customer\./, 'a one-off job with several visits says every visit must be scheduled');
  assert.doesNotMatch(map.futureJobRecord({ jobNumber: '2001', visits: visits.slice(0, 1) }, customer, { now: NOW }).opsNotes, /each of these/);
  assert.doesNotMatch(map.futureJobRecord({ jobNumber: '2001', jobType: 'recurring', visits: visits.slice(0, 2) }, customer, { now: NOW }).opsNotes, /each of these/, 'a recurring job is covered by its repeat plan');
  const split = { id: 'customer_split', firstName: 'Synthetic', lastName: 'Alpha', phone: '+19705550101' };
  assert.equal(map.futureJobRecord({ jobNumber: '2001', visits }, split, { now: NOW }).customer, 'Synthetic Alpha', 'a Hub customer saved with first and last name only still labels its jobs, as Dispatch does');
  assert.equal(map.historyRecord({ ...visits[2], jobberClientId: '1001' }, split, { now: NOW }).customer, 'Synthetic Alpha');
  assert.equal(map.invoiceRecord({ invoiceNumber: '1', balanceCents: 100, jobberClientId: '1001' }, split, { now: NOW }).customer, 'Synthetic Alpha');

  const past = visits.find(entry => entry.jobNumber === '2002'), history = map.historyRecord({ ...past, jobberClientId: '1003' }, customer, { now: NOW, runId: 'run-a' });
  assert.equal(history.id, 'jobber_visit_2002_20260910_1300_1500');
  assert.deepEqual([history.recordType, history.status, history.date, history.time, history.endTime, history.startAt, history.endAt, history.completedAt], ['jobber_history', 'completed', '2026-09-10', '13:00', '15:00', '2026-09-10T19:00:00.000Z', '2026-09-10T21:00:00.000Z', '2026-09-10T21:00:00.000Z']);
  assert.deepEqual(history.assignedCrew, []);assert.equal(history.assignedTo, '', 'Jobber names never become Hub crew assignments');assert.equal(history.jobber.assignedTo, 'Synthetic Crew A');assert.equal(history.jobber.valueCents, 40000);
  assert.equal(history.total, undefined);assert.equal(history.invoice, undefined);

  const invoice = map.invoiceRecord({ invoiceNumber: '3001', status: 'awaiting_payment', subject: 'Garage cleanout', issuedDate: '2026-09-01', dueDate: '2026-09-15', totalCents: 45000, balanceCents: 20000, taxCents: 0, jobNumbers: ['1999'], jobberClientId: '1001' }, customer, { now: NOW, runId: 'run-a', fingerprint: 'f2' });
  assert.equal(invoice.id, 'jobber_invoice_3001');
  assert.deepEqual([invoice.status, invoice.pipelineStatus, invoice.notify, invoice.customerAutomationEnabled], ['invoiced', 'invoiced', false, false]);
  assert.deepEqual({ ...invoice.invoice, lineItems: undefined }, { number: 'JOBBER-3001', status: 'issued', amount: 200, paid: 0, balance: 200, amountCents: 20000, balanceCents: 20000, dueDate: '2026-09-15', issuedAt: '2026-09-01T18:00:00.000Z', issuedDate: '2026-09-01', lineItems: undefined, source: 'jobber_import', imported: true, updatedAt: NOW });
  assert.equal(invoice.invoice.lineItems[0].amount * 100, invoice.invoice.lineItems[0].amountCents);
  assert.match(invoice.invoice.lineItems[0].description, /Original total \$450\.00; \$250\.00 paid in Jobber/);
  assert.equal(invoice.payment, undefined, 'Jobber payments are not recreated as Hub payments');
  assert.equal(invoice.jobber.paidCents, 25000);
  assert.doesNotMatch(JSON.stringify(invoice), /stripe|checkout|cs_|pi_/i);
  assert.match(invoice.opsNotes, /Nothing was charged or sent/);

  const [parsedClient] = map.clientsFromCsv(map.parseCsv(CLIENTS()), map.mapColumns('clients', CLIENT_HEADERS).columns).clients;
  const record = map.customerRecord(parsedClient, { now: NOW, runId: 'run-a', sourceMode: 'csv' });
  assert.deepEqual([record.id, record.name, record.phone, record.email, record.phoneE164, record.emailLower, record.address, record.source], ['jobber_client_1001', 'Synthetic Alpha', '+19705550101', 'alpha@example.invalid', '+19705550101', 'alpha@example.invalid', '101 Synthetic Street, Fort Collins, CO 80525', 'jobber_import']);
  assert.deepEqual(record.provenance, { source: 'jobber', jobberId: '1001', importedAt: NOW, runId: 'run-a', sourceMode: 'csv' });
});

test('masking keeps initials, last four digits, email domain and city only', () => {
  assert.equal(map.maskName('synthetic  Alpha'), 'S*** A***');assert.equal(map.maskPhone('+19705550101'), '***-***-0101');assert.equal(map.maskEmail('alpha@example.invalid'), 'a***@example.invalid');
  assert.equal(map.maskAddress(map.normalizeAddress({ street1: '101 Synthetic St', city: 'Fort Collins', state: 'CO' })), 'Fort Collins, CO');
  assert.deepEqual([map.maskName(''), map.maskPhone(''), map.maskEmail(''), map.maskAddress(null)], ['', '', '', '']);
});

test('the dry run matches Hub customers by normalized phone or email and reports conflicts without writing', async t => {
  blockFetch(t);
  const store = memoryStore(), before = structuredClone([...store.rows]);
  const report = await runJobberImport(store, { source: csvSource(FILES()), now: NOW, runId: 'run-dry', historySince: '2025-01-01' });
  assert.equal(report.mode, 'dry_run');assert.equal(report.aborted, undefined);assert.equal(store.commits.length, 0);assert.deepEqual([...store.rows], before);assert.equal(report.writes.receipt, null);
  const cleanStore = memoryStore(), clean = { source: csvSource(FILES()), now: NOW, runId: 'run-dry', resolutions: RESOLVED, historySince: '2025-01-01' };
  const reviewed = await runJobberImport(cleanStore, clean);
  await runJobberImport(cleanStore, { ...clean, expectFingerprint: reviewed.sourceFingerprint, expectPlanFingerprint: reviewed.planFingerprint });
  assert.equal(cleanStore.commits.length, 0, 'even a clean plan with the right fingerprint writes nothing without apply');
  const decision = id => report.matches.find(entry => entry.jobberClientId === id);
  assert.deepEqual(decision('1001'), { jobberClientId: '1001', action: 'match', customerId: 'customer_alpha', matchedBy: ['phone'] });
  assert.deepEqual(decision('1002'), { jobberClientId: '1002', action: 'match', customerId: 'customer_bravo', matchedBy: ['email'] });
  assert.deepEqual([decision('1003').action, decision('1007').action, decision('1008').action], ['create', 'create', 'create']);
  assert.deepEqual(report.conflicts.map(entry => [entry.code, entry.jobberClientId, entry.customerCandidates || entry.jobberClientIds]).sort(), [
    ['ambiguous_customer', '1004', ['customer_delta_a', 'customer_delta_b']], ['duplicate_in_jobber', '1005', ['1006']], ['duplicate_in_jobber', '1006', ['1005']]]);
  assert.deepEqual(report.warnings.find(entry => entry.code === 'matched_customer_differs'), { code: 'matched_customer_differs', jobberClientId: '1001', customerId: 'customer_alpha', differences: ['email'] });
  assert.ok(report.warnings.some(entry => entry.code === 'client_without_contact' && entry.jobberClientId === '1008'));
  assert.deepEqual(report.warnings.filter(entry => entry.code === 'past_visit_not_completed'), [{ code: 'past_visit_not_completed', jobNumber: '2003', date: '2026-09-15' }]);
  assert.deepEqual(report.unmappable.map(entry => [entry.kind, entry.jobNumber || entry.invoiceNumber, entry.reason]), [['upcoming_job', '2005', 'client_not_found'], ['invoice', '3005', 'client_not_found']]);
  assert.deepEqual(report.blockedByClient, [{ kind: 'upcoming_job', id: 'jobber_job_2004', jobberClientId: '1004' }]);
  assert.deepEqual(report.blocking.map(entry => entry.code), ['unresolved_conflicts', 'unmappable_records', 'records_blocked_by_client_conflict']);
  assert.deepEqual(report.preview.upcomingJobs, ['jobber_job_2001', 'jobber_job_2006']);
  assert.deepEqual(report.preview.invoices, ['jobber_invoice_3001', 'jobber_invoice_3002']);
  assert.equal(report.counts.visits.beforeHistorySince, 1);assert.equal(report.counts.visits.history, 1);
  assert.deepEqual(report.counts.invoices.skippedByStatus, { paid: 1, draft: 1 });assert.equal(report.counts.invoices.openBalanceCents, 50000, 'only linked open balances count');
  assert.deepEqual(report.recurringPlans, [{ jobNumber: '2006', customerId: 'jobber_client_1003', cadence: { frequency: 'biweekly' }, cadenceText: 'Every 2 weeks on Mondays', startDate: '2026-10-05', time: '08:00', endTime: '10:00', endsOn: null, needsManualSetup: false, status: 'report_only' },
    { jobNumber: '2008', customerId: 'customer_alpha', cadence: null, cadenceText: 'Weekly on Mondays and Thursdays', startDate: '2026-09-03', time: '', endTime: '', endsOn: null, needsManualSetup: true, status: 'report_only' }]);
  assert.deepEqual(report.counts.jobsCollection, { current: 2, planned: 5, projected: 7, safeLimit: JOBS_COLLECTION_SAFE_LIMIT, overLimit: false, allowed: false });
  assert.doesNotMatch(JSON.stringify(report), PII, 'the report carries no names, full phones, emails or street addresses');
  assert.match(report.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test('apply refuses without the reviewed fingerprint or while anything is blocking', async t => {
  blockFetch(t);
  const store = memoryStore(), source = csvSource(FILES());
  const blocked = await runJobberImport(store, { source, apply: true, now: NOW, runId: 'run-b', expectFingerprint: sourceFingerprint(source) });
  assert.equal(blocked.aborted.code, 'jobber_import_blocked');
  const resolved = await runJobberImport(store, { source, apply: true, now: NOW, runId: 'run-c', resolutions: RESOLVED, expectFingerprint: sourceFingerprint(source) });
  assert.equal(resolved.aborted.code, 'jobber_import_fingerprint_mismatch', 'the resolutions are part of the reviewed input');
  const missing = await runJobberImport(store, { source, apply: true, now: NOW, runId: 'run-d', resolutions: RESOLVED });
  assert.equal(missing.aborted.code, 'jobber_import_fingerprint_mismatch');
  assert.equal(store.commits.length, 0);
});

test('apply creates only, in receipt-tracked batches with the customer identity guard, and a rerun is a no-op', async t => {
  const network = blockFetch(t);
  const store = memoryStore(), source = csvSource(FILES()), options = { source, now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const dry = await runJobberImport(store, { ...options, runId: 'run-review' });
  assert.deepEqual(dry.blocking, []);assert.deepEqual(dry.conflicts, []);
  const report = await runJobberImport(store, { ...options, apply: true, runId: 'run-apply', expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint, batchSize: 3 });
  assert.equal(report.aborted, undefined);assert.equal(report.mode, 'apply');assert.equal(report.writes.receipt, 'jobberImport/run-apply');
  assert.deepEqual(report.writes.planned, { customers: 4, jobs: 6 });assert.deepEqual(report.writes.committed, { customers: 4, jobs: 6 });
  assert.deepEqual(report.preview.customers, ['jobber_client_1003', 'jobber_client_1005', 'jobber_client_1007', 'jobber_client_1008']);
  const [receiptCreate, ...rest] = store.commits, finalize = rest.pop();
  assert.deepEqual(receiptCreate.map(write => [write.collection, write.id, write.revision]), [['jobberImport', 'run-apply', undefined]]);
  assert.equal(rest.length, 4);
  for (const batch of rest) {
    const business = batch.filter(write => ['customers', 'jobs'].includes(write.collection) && !write.verify);
    assert.ok(business.length > 0 && business.length <= 3);
    for (const write of business) assert.equal(write.revision, undefined, `${write.id} is create-only (exists:false)`);
    const receipt = batch.find(write => write.collection === 'jobberImport');assert.ok(receipt.revision, 'the receipt advances with an updateTime precondition');
    assert.equal(Boolean(batch.find(write => write.collection === 'customerIdentityState')), business.some(write => write.collection === 'customers'));
    assert.equal(Boolean(batch.find(write => write.collection === 'dispatchState')), business.some(write => write.collection === 'jobs' && !write.patch.recordType), 'batches that create jobs or balances advance the dispatch revision like every dispatch writer');
  }
  assert.equal(rest[0].find(write => write.collection === 'customerIdentityState').revision, undefined, 'the first guard write creates the identity revision');
  assert.ok(rest[1].find(write => write.collection === 'customerIdentityState').revision, 'later batches chain on the revision this run wrote');
  assert.equal(rest[1].find(write => write.collection === 'dispatchState').revision, undefined);assert.ok(rest[2].find(write => write.collection === 'dispatchState').revision);
  assert.deepEqual(rest.map(batch => batch.filter(write => write.verify).map(write => [write.id, write.revision])), [[], [['existing-job', 'seed-5']], [['existing-job', 'seed-5']], [['jobber_job_2006', store.rows.get('jobs/jobber_job_2006').revision]]],
    'a batch joining an existing root verifies its revision; a root imported in an earlier batch is re-read and verified');
  const owner = id => store.rows.get(`jobs/${id}`).customerAccountOwnerJobId ?? null;
  assert.deepEqual(['jobber_job_2001', 'jobber_invoice_3001', 'jobber_job_2004', 'jobber_job_2006', 'jobber_invoice_3002', 'jobber_visit_2002_20260910_1300_1500'].map(owner), ['existing-job', 'existing-job', null, null, 'jobber_job_2006', null]);
  assert.deepEqual(report.accountRoots, [{ customerId: 'customer_alpha', rootJobId: 'existing-job', source: 'existing' }, { customerId: 'customer_delta_a', rootJobId: 'jobber_job_2004', source: 'imported' }, { customerId: 'jobber_client_1003', rootJobId: 'jobber_job_2006', source: 'imported' }]);
  assert.deepEqual(finalize.map(write => [write.collection, write.patch.status]), [['jobberImport', 'completed']]);
  const receipt = store.rows.get('jobberImport/run-apply');
  assert.deepEqual([receipt.status, receipt.committed, receipt.committedBatches.length, receipt.sourceFingerprint, receipt.planFingerprint], ['completed', { customers: 4, jobs: 6 }, 4, dry.sourceFingerprint, dry.planFingerprint]);
  assert.deepEqual(receipt.recurringPlanProposals.map(plan => plan.jobNumber), ['2006', '2008']);
  assert.doesNotMatch(JSON.stringify(receipt), PII);
  const written = [...store.rows].filter(([key]) => key.startsWith('jobs/jobber_')).map(([, row]) => row);
  assert.equal(written.length, 6);
  for (const row of written) {
    assert.deepEqual([row.notify, row.customerAutomationEnabled, row.syncStatus, row.assignedTo, row.importSource], [false, false, 'not_needed', '', 'jobber'], `${row.id} can never trigger a Hub send, retry or crew assignment`);
    assert.deepEqual(row.assignedCrew, []);
    for (const key of ['closeoutSyncStatus', 'lifecycleSync', 'portalInvitation', 'shiftPickupEnabled', 'openShift', 'payment', 'deposit', 'estimate', 'highlevelAppointmentId']) assert.equal(row[key], undefined, `${row.id}.${key}`);
  }
  const job = store.rows.get('jobs/jobber_job_2004');
  assert.deepEqual([job.customerId, job.status, job.needsDispatchReview, job.notify], ['customer_delta_a', 'unscheduled', true, false]);
  assert.equal(store.rows.get('jobs/jobber_invoice_3001').customerId, 'customer_alpha');
  assert.equal(store.rows.get('jobs/jobber_job_2006').customerId, 'jobber_client_1003');
  assert.equal(store.rows.get('jobs/jobber_visit_2002_20260910_1300_1500').customerId, 'jobber_client_1003');
  assert.equal(store.rows.get('customers/jobber_client_1006'), undefined, 'a resolved duplicate merges into the other Jobber client');
  assert.equal(store.rows.get('customers/customer_alpha').revision, 'seed-1', 'existing customers are never modified');
  assert.equal(store.rows.get('jobs/existing-job').revision, 'seed-5', 'existing jobs are never modified');
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('jobs/_egc_')).length, 1, 'no schedule locks are written');

  const commits = store.commits.length, rerunDry = await runJobberImport(store, { ...options, runId: 'run-again' });
  assert.deepEqual(rerunDry.writes.planned, { customers: 0, jobs: 0 });
  assert.deepEqual([rerunDry.counts.clients.alreadyImported, rerunDry.counts.jobs.alreadyImported, rerunDry.counts.invoices.alreadyImported, rerunDry.counts.visits.historyAlreadyImported], [5, 3, 2, 1]);
  assert.deepEqual(rerunDry.changedSinceImport, []);assert.deepEqual(rerunDry.blocking, []);
  const rerun = await runJobberImport(store, { ...options, apply: true, runId: 'run-again', expectFingerprint: rerunDry.sourceFingerprint, expectPlanFingerprint: rerunDry.planFingerprint });
  assert.equal(rerun.aborted, undefined);assert.equal(store.commits.length, commits, 'a rerun writes nothing, not even a receipt');
  assert.equal(network.mock.callCount(), 0, 'no provider (HighLevel, Stripe, messaging) is ever contacted');
});

test('a customer created during the import stops it cleanly; the rerun finishes without duplicates', async t => {
  blockFetch(t);
  const store = memoryStore(), source = csvSource(FILES()), options = { source, now: NOW, resolutions: RESOLVED, historySince: '2025-01-01', batchSize: 2 };
  const { sourceFingerprint: fingerprint, planFingerprint } = await runJobberImport(store, { ...options, runId: 'run-review' });
  let calls = 0;
  const commit = store.commit;
  store.commit = async writes => { if (++calls === 3) store.rows.set('customerIdentityState/revision', { ...store.rows.get('customerIdentityState/revision'), lastRequestId: 'someone-else', revision: 'other-writer' }); return commit(writes); };
  const stopped = await runJobberImport(store, { ...options, apply: true, runId: 'run-race', expectFingerprint: fingerprint, expectPlanFingerprint: planFingerprint });
  assert.equal(stopped.aborted.code, 'jobber_import_hub_changed');
  assert.deepEqual(stopped.writes.committed, { customers: 2, jobs: 0 });assert.equal(store.rows.get('jobberImport/run-race').status, 'aborted');
  store.commit = commit;
  const again = await runJobberImport(store, { ...options, runId: 'run-review-2' });
  assert.deepEqual(again.writes.planned, { customers: 2, jobs: 6 });assert.deepEqual(again.blocking, []);
  const finished = await runJobberImport(store, { ...options, apply: true, runId: 'run-finish', expectFingerprint: again.sourceFingerprint, expectPlanFingerprint: again.planFingerprint });
  assert.equal(finished.aborted, undefined);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('customers/jobber_client_')).length, 4);
  assert.equal([...store.rows.keys()].filter(key => /^jobs\/jobber_/.test(key)).length, 6);

  const late = memoryStore(), review = await runJobberImport(late, { ...options, runId: 'review' }), read = late.read;let reads = 0;
  late.read = async (collection, id) => { const row = await read(collection, id); return collection === 'customerIdentityState' && ++reads === 2 ? { ...row, lastRequestId: 'someone-else' } : row; };
  const after = await runJobberImport(late, { ...options, apply: true, runId: 'run-late', expectFingerprint: review.sourceFingerprint, expectPlanFingerprint: review.planFingerprint });
  assert.equal(after.aborted.code, 'jobber_import_hub_changed');
  assert.deepEqual(after.writes.committed, { customers: 2, jobs: 0 }, 'the committed batch is still reported when the guard moves after it');
  assert.equal(after.writes.batches.length, 1);assert.equal(late.rows.get('jobberImport/run-late').status, 'aborted');
});

test('a target created concurrently is never overwritten; a lost response is confirmed by the receipt', async t => {
  blockFetch(t);
  const source = csvSource(FILES()), options = { source, now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const store = memoryStore(), { sourceFingerprint: fingerprint, planFingerprint } = await runJobberImport(store, { ...options, runId: 'review' });
  let armed = true;const commit = store.commit;
  store.commit = async writes => { if (armed && writes.some(write => write.id === 'jobber_client_1003')) { armed = false; store.rows.set('customers/jobber_client_1003', { id: 'jobber_client_1003', name: 'Manual entry', revision: 'manual' }); } return commit(writes); };
  const stopped = await runJobberImport(store, { ...options, apply: true, runId: 'run-conflict', expectFingerprint: fingerprint, expectPlanFingerprint: planFingerprint });
  assert.equal(stopped.aborted.code, 'jobber_import_hub_changed');assert.equal(store.rows.get('customers/jobber_client_1003').name, 'Manual entry');
  assert.deepEqual(stopped.writes.committed, { customers: 0, jobs: 0 });

  const lost = memoryStore(), review = await runJobberImport(lost, { ...options, runId: 'review' });
  let count = 0;const original = lost.commit;
  lost.commit = async writes => { if (++count === 2) lost.loseNext(); return original(writes); };
  const report = await runJobberImport(lost, { ...options, apply: true, runId: 'run-lost', expectFingerprint: review.sourceFingerprint, expectPlanFingerprint: review.planFingerprint });
  assert.equal(report.aborted, undefined);assert.deepEqual(report.writes.committed, { customers: 4, jobs: 6 });
  assert.equal(lost.commits.filter(batch => batch.some(write => write.id === 'jobber_client_1003')).length, 1, 'the lost batch is not repeated');
});

test('planner edge cases: split job links, stable prior imports, duplicate invoice numbers and unknown statuses', () => {
  const base = csvSource(FILES()), hub = { customers: HUB_CUSTOMERS(), jobs: [] };
  const split = { ...base, visits: [...base.visits, { ...base.visits[0], schedule: { ...base.visits[0].schedule, date: '2026-09-26' }, client: { name: '', phones: ['+19705550103'], emails: [], street: '' } }] };
  assert.ok(planJobberImport(split, hub, { now: NOW, resolutions: RESOLVED }).report.conflicts.some(entry => entry.code === 'job_links_to_several_clients' && entry.jobNumber === '2001'));
  const prior = planJobberImport(base, { customers: HUB_CUSTOMERS(), jobs: [{ id: 'jobber_job_2001', customerId: 'customer_bravo' }] }, { now: NOW, resolutions: RESOLVED });
  assert.deepEqual(prior.report.matches.find(entry => entry.jobberClientId === '1001'), { jobberClientId: '1001', action: 'already_imported', customerId: 'customer_bravo', matchedBy: ['previous_import'] }, 'an earlier import decision is kept stable');
  assert.ok(prior.records.jobs.every(record => record.id !== 'jobber_job_2001'));
  const gone = planJobberImport(base, { customers: HUB_CUSTOMERS(), jobs: [{ id: 'jobber_invoice_3001', customerId: 'customer_deleted' }] }, { now: NOW, resolutions: RESOLVED });
  assert.ok(gone.report.conflicts.some(entry => entry.code === 'previous_customer_missing' && entry.jobberClientId === '1001'));
  const invoices = [...base.invoices, { ...base.invoices[0], balanceCents: 100 }, { ...base.invoices[1], line: 99 }, { ...base.invoices[0], invoiceNumber: '3009', status: '', statusText: 'Mystery' }];
  const plan = planJobberImport({ ...base, invoices }, hub, { now: NOW, resolutions: RESOLVED });
  assert.ok(plan.report.conflicts.some(entry => entry.code === 'duplicate_invoice_number' && entry.invoiceNumber === '3001'));
  assert.ok(plan.report.duplicates.some(entry => entry.kind === 'invoice' && entry.invoiceNumber === '3002'), 'an identical repeated row is a harmless duplicate');
  assert.ok(plan.report.unmappable.some(entry => entry.invoiceNumber === '3009' && entry.reason === 'invoice_status_unknown' && entry.blocking));
  const imported = planJobberImport({ ...base, invoices }, hub, { now: NOW, resolutions: { ...RESOLVED, invoices: { ...RESOLVED.invoices, 3009: { action: 'import' } } } });
  assert.ok(imported.records.jobs.some(record => record.id === 'jobber_invoice_3009'));
  const orphanHistory = { ...base, visits: [{ ...base.visits[2], client: { name: 'Synthetic Nobody', phones: [], emails: [], street: '' } }] };
  const history = planJobberImport(orphanHistory, hub, { now: NOW, resolutions: RESOLVED });
  assert.ok(history.report.warnings.some(entry => entry.kind === 'history' && entry.code === 'client_not_found'));
  assert.ok(!history.report.blocking.some(entry => entry.code === 'unmappable_records'), 'unlinked history is reported but does not block the cutover');
  const withoutInvoices = planJobberImport({ ...base, included: { ...base.included, invoices: false } }, { customers: HUB_CUSTOMERS(), jobs: [{ id: 'jobber_invoice_4000', customerId: 'customer_alpha' }] }, { now: NOW, resolutions: RESOLVED });
  assert.ok(!withoutInvoices.report.warnings.some(entry => entry.code === 'imported_invoice_no_longer_open'), 'no invoice export means no paid-in-Jobber guess');
});

function firestoreRest(seed) {
  const docs = new Map(), commits = [], verified = [], ROOT = 'projects/egcw-1ec83/databases/(default)/documents';let tick = 0, transactions = 0;
  const put = (path, data) => docs.set(path, { name: `${ROOT}/${path}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-22T00:00:00.${String(++tick).padStart(6, '0')}Z` });
  for (const [path, data] of seed) put(path, data);
  const fetcher = async (env, input, options = {}) => {
    const url = new URL(input), path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, '');
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (path === ':beginTransaction') return Response.json({ transaction: `synthetic-transaction-${++transactions}` });
    if (path === ':rollback') return Response.json({});
    if (path === ':batchGet') {
      const { documents, transaction } = JSON.parse(options.body);
      assert.match(transaction, /^synthetic-transaction-/);verified.push(...documents.map(name => name.slice(ROOT.length + 1)));
      return Response.json(documents.map(name => docs.has(name.slice(ROOT.length + 1)) ? { found: docs.get(name.slice(ROOT.length + 1)) } : { missing: name }));
    }
    if (path === ':commit') {
      const { writes, transaction } = JSON.parse(options.body);
      if (transaction) writes.transaction = transaction;
      for (const write of writes) { const key = write.update.name.slice(ROOT.length + 1), existing = docs.get(key); if (write.currentDocument?.exists === false ? existing : existing?.updateTime !== write.currentDocument?.updateTime) return Response.json({}, { status: 412 }); }
      commits.push(writes);
      for (const write of writes) { const key = write.update.name.slice(ROOT.length + 1); put(key, { ...decodeFirestoreFields(docs.get(key)?.fields || {}), ...decodeFirestoreFields(write.update.fields) }); }
      return Response.json({ commitTime: '2026-09-22T00:00:01Z' });
    }
    assert.equal(options.method || 'GET', 'GET');
    if (!path.includes('/')) return Response.json({ documents: [...docs].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([, doc]) => doc) });
    return docs.has(path) ? Response.json(docs.get(path)) : Response.json({}, { status: 404 });
  };
  return { docs, commits, verified, fetcher, get: path => docs.has(path) ? decodeFirestoreFields(docs.get(path).fields) : null };
}

test('through the real Firestore REST adapter every import write is create-only and the receipt is revision-checked', async t => {
  blockFetch(t);
  const rest = firestoreRest([['customers/customer_alpha', { name: 'Synthetic Alpha', phone: '(970) 555-0101' }], ['jobs/existing-job', { type: 'job', customerId: 'customer_alpha', status: 'scheduled' }]]);
  const store = dispatchStorage({}, rest.fetcher), files = FILES(), source = csvSource({ clients: csv([CLIENT_HEADERS, ...CLIENT_ROWS().filter(row => ['1001', '1003'].includes(row[0].split('_')[0]))]), invoices: files.invoices });
  const options = { source, now: NOW, resolutions: { invoices: { 3005: { action: 'skip' } } } };
  const dry = await runJobberImport(store, { ...options, runId: 'rest-review' });
  assert.deepEqual(dry.blocking, []);assert.equal(rest.commits.length, 0);
  const report = await runJobberImport(store, { ...options, apply: true, runId: 'rest-apply', expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
  assert.equal(report.aborted, undefined);assert.deepEqual(report.writes.committed, { customers: 1, jobs: 2 });
  for (const write of rest.commits.flat()) {
    const [collection] = write.update.name.split('/documents/')[1].split('/');
    if (['customers', 'jobs'].includes(collection)) assert.deepEqual(write.currentDocument, { exists: false }, write.update.name);
    if (collection === 'jobberImport' && write !== rest.commits[0][0]) assert.match(write.currentDocument.updateTime, /^2026-09-22T/, 'receipt updates carry an updateTime precondition');
    if (['customerIdentityState', 'dispatchState'].includes(collection)) assert.deepEqual(write.currentDocument, { exists: false }, 'the first guard revision is created, later ones are chained');
  }
  assert.deepEqual(rest.verified, ['jobs/existing-job'], 'the existing account root is verified inside a transaction');
  assert.equal(rest.commits.at(-2).transaction, 'synthetic-transaction-1', 'the batch commits in the transaction that verified the root');
  assert.equal(rest.get('jobs/jobber_invoice_3001').customerAccountOwnerJobId, 'existing-job');assert.equal(rest.get('jobs/jobber_invoice_3002').customerAccountOwnerJobId, undefined, 'the first imported record of a new customer is its root');
  assert.equal(rest.get('dispatchState/revision').lastRequestId, 'rest-apply-0001');
  assert.deepEqual(rest.commits[0].map(write => write.currentDocument), [{ exists: false }], 'the receipt is created first');
  const customer = rest.get('customers/jobber_client_1003');
  assert.deepEqual(customer.provenance, { source: 'jobber', jobberId: '1003', importedAt: NOW, runId: 'rest-apply', sourceMode: 'csv' });
  assert.equal(rest.get('jobs/jobber_invoice_3001').customerId, 'customer_alpha');assert.equal(rest.get('jobs/jobber_invoice_3002').invoice.balanceCents, 30000);
  assert.equal(rest.get('customerIdentityState/revision').lastRequestId, 'rest-apply-0001');
  assert.equal(rest.get('jobberImport/rest-apply').status, 'completed');
  assert.equal(rest.get('customers/customer_alpha').name, 'Synthetic Alpha');
  const commits = rest.commits.length;
  const again = await runJobberImport(store, { ...options, runId: 'rest-again' });
  await runJobberImport(store, { ...options, apply: true, runId: 'rest-again', expectFingerprint: again.sourceFingerprint, expectPlanFingerprint: again.planFingerprint });
  assert.equal(rest.commits.length, commits, 'a rerun through Firestore writes nothing');
});

test('the jobs-collection limit blocks large history imports until explicitly allowed', async t => {
  blockFetch(t);
  const filler = Array.from({ length: JOBS_COLLECTION_SAFE_LIMIT - 3 }, (_, index) => ({ id: `synthetic-${index}`, type: 'job', status: 'completed' }));
  const store = memoryStore({ jobs: filler }), options = { source: csvSource(FILES()), now: NOW, resolutions: RESOLVED };
  const report = await runJobberImport(store, { ...options, runId: 'limit' });
  const limit = report.blocking.find(entry => entry.code === 'jobs_collection_limit');
  assert.deepEqual([limit.current, limit.planned, limit.projected, limit.safeLimit], [497, 7, 504, 500]);assert.match(limit.message, /sales-followup-exit\.js/);
  const narrowed = await runJobberImport(store, { ...options, runId: 'limit', historySince: '2026-09-01' });
  assert.equal(narrowed.counts.jobsCollection.projected, 503, 'narrowing history lowers the projection');
  const allowed = await runJobberImport(store, { ...options, runId: 'limit', allowLargeJobsCollection: true });
  assert.deepEqual(allowed.blocking, []);assert.equal(allowed.counts.jobsCollection.allowed, true);
});

test('reruns report Jobber changes after import instead of overwriting Hub records', async t => {
  blockFetch(t);
  const store = memoryStore(), options = { now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const first = await runJobberImport(store, { ...options, source: csvSource(FILES()), runId: 'review' });
  await runJobberImport(store, { ...options, source: csvSource(FILES()), apply: true, runId: 'apply', expectFingerprint: first.sourceFingerprint, expectPlanFingerprint: first.planFingerprint });
  const files = FILES();
  files.visits = files.visits.replace('"Sep 24, 2026",9:00 AM - 11:00 AM', '"Sep 24, 2026",10:00 AM - 12:00 PM');
  files.invoices = files.invoices.replace('3001,Synthetic Alpha,alpha@example.invalid,,Awaiting Payment', '3001,Synthetic Alpha,alpha@example.invalid,,Paid');
  assert.notEqual(files.visits, FILES().visits);assert.notEqual(files.invoices, FILES().invoices);
  const before = structuredClone(store.rows.get('jobs/jobber_job_2001'));
  const rerun = await runJobberImport(store, { ...options, source: csvSource(files), runId: 'rerun' });
  assert.deepEqual(rerun.changedSinceImport, [{ id: 'jobber_job_2001', kind: 'upcoming_job', jobNumber: '2001' }]);
  assert.deepEqual(rerun.warnings.filter(entry => entry.code === 'imported_invoice_no_longer_open'), [{ code: 'imported_invoice_no_longer_open', id: 'jobber_invoice_3001', jobberStatus: 'paid' }]);
  assert.deepEqual(rerun.writes.planned, { customers: 0, jobs: 0 });assert.deepEqual(store.rows.get('jobs/jobber_job_2001'), before);
});

test('missing columns, unreadable CSV and unparseable ids block the import with line numbers', () => {
  const bad = csvSource({ clients: 'J-ID,Display Name\nC-9,Synthetic Kilo\n', visits: 'Date,Client name\nSep 24, 2026,Synthetic Kilo\n', invoices: 'a,b\n"open' });
  assert.deepEqual(bad.blocking.map(entry => [entry.code, entry.file]), [['columns_invalid', 'visits'], ['csv_invalid', 'invoices']]);
  assert.deepEqual(bad.blocking[0].missing, ['jobNumber']);
  assert.deepEqual(bad.problems, [{ file: 'clients', line: 2, reason: 'jobber_id_invalid' }]);
  assert.equal(bad.included.visits, undefined);
  const plan = planJobberImport(bad, { customers: [], jobs: [] }, { now: NOW });
  assert.deepEqual(plan.report.blocking.map(entry => entry.code), ['columns_invalid', 'csv_invalid', 'unmappable_records']);
  assert.throws(() => csvSource({ visits: VISITS() }), /client export/);
  const rows = CLIENT_ROWS(), split = csvSource({ clients: [csv([CLIENT_HEADERS, ...rows.slice(0, 2)]), csv([[...CLIENT_HEADERS].reverse(), ...rows.slice(2).map(row => [...row].reverse())])] });
  assert.deepEqual(split.blocking, []);assert.equal(split.clients.length, 8, 'Bravo\'s two property rows span both parts and still group into one client');
  assert.equal(split.clients.find(entry => entry.jobberId === '1002').properties.length, 2);assert.deepEqual(split.clients.find(entry => entry.jobberId === '1002').lines, ['1:3', '2:2']);
  const splitBad = csvSource({ clients: [CLIENTS(), 'Name\nSynthetic Lima\n'] });
  assert.deepEqual(splitBad.blocking.map(entry => [entry.code, entry.file, entry.missing]), [['columns_invalid', 'clients#2', ['jid']]]);assert.equal(splitBad.included.clients, undefined);
  assert.throws(() => csvSource({ clients: CLIENTS() }, { quotes: {} }), /mapping file/);
  const mapped = csvSource({ clients: CLIENTS(), visits: VISITS().replace('Job #', 'Work order') }, { visits: { jobNumber: 'Work order' } });
  assert.deepEqual(mapped.blocking, []);assert.equal(mapped.visits.length, 8);
});

test('resolutions are validated strictly and cannot reach prototypes', () => {
  const clean = normalizeResolutions(JSON.parse('{"clients":{"12":{"action":"skip"},"__proto__":{"action":"create"}}}'.replace(',"__proto__":{"action":"create"}', '')));
  assert.deepEqual(Object.keys(clean.clients), ['12']);assert.equal(Object.getPrototypeOf(clean.clients), null);
  assert.throws(() => normalizeResolutions(JSON.parse('{"clients":{"__proto__":{"action":"create"}}}')), /exactly one of/);
  assert.throws(() => normalizeResolutions({ clients: { 12: { customerId: '_egc_schedule_lock_x' } } }), /exactly one of/);
  assert.throws(() => normalizeResolutions({ clients: { 12: { action: 'merge' } } }), /exactly one of/);
  assert.throws(() => normalizeResolutions({ jobs: { 12: { jobberClientId: '1', action: 'skip' } } }), /exactly one of/);
  assert.throws(() => normalizeResolutions({ quotes: {} }), /may only contain/);
  assert.deepEqual({ ...normalizeResolutions({ invoices: { 'INV-9': { action: 'import' } } }).invoices }, { 'INV-9': { action: 'import' } });
  const plan = planJobberImport(csvSource(FILES()), { customers: HUB_CUSTOMERS(), jobs: [] }, { now: NOW, resolutions: { ...RESOLVED, clients: { ...RESOLVED.clients, 1003: { customerId: 'customer_missing' } } } });
  assert.deepEqual(plan.report.conflicts.map(entry => [entry.code, entry.jobberClientId]), [['resolution_customer_missing', '1003']]);
});

const encoded = (type, id) => btoa(`gid://Jobber/${type}/${id}`);
function jobberApi(t, { throttleOnce = false } = {}) {
  const calls = [];let throttled = !throttleOnce;
  const nodes = {
    clients: [[{ id: encoded('Client', 1001), name: 'Synthetic Alpha', firstName: 'Synthetic', lastName: 'Alpha', isCompany: false, isArchived: false, isLead: false, phones: [{ number: '970-555-0199', primary: false }, { number: '970.555.0101', primary: true }], emails: [{ address: 'alpha@example.invalid', primary: true }], billingAddress: null, properties: [{ id: encoded('Property', 5001), street1: '101 Synthetic Street', street2: '', city: 'Fort Collins', province: 'CO', postalCode: '80525' }] }],
      [{ id: encoded('Client', 1003), name: 'Synthetic Charlie', firstName: 'Synthetic', lastName: 'Charlie', isCompany: false, isArchived: false, isLead: false, phones: [{ number: '970-555-0103', primary: true }], emails: [], billingAddress: null, properties: [] }]],
    visits: [[{ id: encoded('Visit', 1), title: 'Garage cleanout', startAt: '2026-09-24T15:00:00Z', endAt: '2026-09-24T17:00:00Z', allDay: false, completedAt: null, isComplete: false, client: { id: encoded('Client', 1001) }, property: { street1: '101 Synthetic Street', city: 'Fort Collins', province: 'CO', postalCode: '80525' }, job: { jobNumber: 2001, jobType: 'ONE_OFF', title: 'Garage cleanout' }, assignedUsers: { nodes: [{ name: { full: 'Synthetic Crew A' } }] }, amounts: { visitBasedBillingTotal: null } },
      { id: encoded('Visit', 2), title: 'Garage tidy', startAt: '2026-09-10T19:00:00Z', endAt: '2026-09-10T21:00:00Z', allDay: false, completedAt: '2026-09-10T21:05:00Z', isComplete: true, client: { id: encoded('Client', 1003) }, property: null, job: { jobNumber: 2002, jobType: 'ONE_OFF', title: 'Garage tidy' }, assignedUsers: { nodes: [] }, amounts: { visitBasedBillingTotal: null } }]],
    jobs: [[{ jobNumber: 2006, title: 'Garage tidy', client: { id: encoded('Client', 1003) }, property: null, visitSchedule: { startDate: '2026-10-05T06:00:00Z', endDate: null, startTime: '2026-10-05T14:00:00Z', endTime: '2026-10-05T16:00:00Z', next: { date: '2026-10-05' }, recurrenceSchedule: { calendarRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', friendly: 'Every 2 weeks on Mondays' }, assignedTo: { nodes: [] } } }]],
    invoices: { past_due: [[{ id: encoded('Invoice', 77), invoiceNumber: '3002', subject: 'Garage tidy', invoiceStatus: 'past_due', issuedDate: '2026-08-20T18:00:00Z', dueDate: '2026-09-03T18:00:00Z', client: { id: encoded('Client', 1003) }, properties: { nodes: [] }, jobs: { nodes: [{ jobNumber: 2002 }] }, amounts: { total: 300, invoiceBalance: 300, taxAmount: 21 } }]] },
  };
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const host = new URL(url).hostname;
    assert.equal(host, 'api.getjobber.com', 'only Jobber is contacted');
    if (String(url).endsWith('/oauth/token')) { assert.equal(init.body.get('grant_type'), 'refresh_token'); return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 }); }
    assert.equal(init.headers.Authorization, 'Bearer synthetic-access-token');assert.equal(init.headers['X-JOBBER-GRAPHQL-VERSION'], '2025-04-16');
    if (!throttled) { throttled = true; return Response.json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 300, throttleStatus: { currentlyAvailable: 100, restoreRate: 50 } } } }); }
    const { query, variables } = JSON.parse(init.body), field = /\b(clients|visits|jobs|invoices)\(/.exec(query)[1];
    const book = field === 'invoices' ? nodes.invoices[variables.filter.status] || [[]] : nodes[field], page = variables.after ? Number(variables.after) : 0;
    return Response.json({ data: { [field]: { nodes: book[page] || [], pageInfo: { hasNextPage: page + 1 < book.length, endCursor: page + 1 < book.length ? String(page + 1) : null } } } });
  };
  return { calls, fetcher };
}

test('the GraphQL source pages through Jobber read-only, backs off when throttled and maps to the same Hub ids', async t => {
  blockFetch(t);
  const api = jobberApi(t, { throttleOnce: true }), sleeps = [];
  const env = { JOBBER_CLIENT_ID: 'synthetic-client', JOBBER_CLIENT_SECRET: 'synthetic-secret', JOBBER_REFRESH_TOKEN: 'synthetic-refresh' };
  const source = await graphqlSource(env, { fetcher: api.fetcher, sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [4000]);
  assert.equal(api.calls.filter(call => call.url.endsWith('/graphql')).length, 8, 'one throttled try, then visits 1 + invoice statuses 3 + clients 2 + recurring 1 pages');
  assert.deepEqual(source.clients.map(entry => [entry.jobberId, entry.phones]), [['1001', ['+19705550101', '+19705550199']], ['1003', ['+19705550103']]]);
  assert.deepEqual(source.visits.map(entry => [entry.jobNumber, entry.client.jobberId, entry.completed, entry.schedule.date, entry.schedule.time]), [['2001', '1001', false, '2026-09-24', '09:00'], ['2002', '1003', true, '2026-09-10', '13:00']]);
  assert.deepEqual(source.recurring[0].cadence, { frequency: 'biweekly' });assert.equal(source.recurring[0].time, '08:00');
  assert.deepEqual([source.invoices[0].invoiceNumber, source.invoices[0].balanceCents, source.invoices[0].issuedDate, source.invoices[0].jobNumbers], ['3002', 30000, '2026-08-20', ['2002']]);
  const plan = planJobberImport(source, { customers: HUB_CUSTOMERS(), jobs: [] }, { now: NOW });
  assert.deepEqual(plan.report.blocking, []);
  assert.deepEqual(plan.writes.map(write => write.id), ['jobber_client_1003', 'jobber_job_2001', 'jobber_visit_2002_20260910_1300_1500', 'jobber_invoice_3002'], 'the same ids the CSV path produces');
  assert.equal(plan.records.jobs[0].customerId, 'customer_alpha');
  assert.equal(plan.records.jobs[1].completedAt, '2026-09-10T21:05:00.000Z');
});

test('GraphQL failures never echo tokens or provider bodies', async t => {
  blockFetch(t);
  const env = { JOBBER_CLIENT_ID: 'synthetic-client', JOBBER_CLIENT_SECRET: 'synthetic-secret', JOBBER_REFRESH_TOKEN: 'synthetic-refresh-secret' };
  await assert.rejects(graphqlSource({}, {}), /Set JOBBER_CLIENT_ID/);
  await assert.rejects(graphqlSource(env, { fetcher: async () => Response.json({ error: 'invalid_grant synthetic-refresh-secret' }, { status: 401 }) }), error => error.code === 'jobber_import_graphql_auth_failed' && !/synthetic-refresh-secret|invalid_grant/.test(error.message));
  let first = true;
  const failing = async url => { if (first) { first = false; return Response.json({ access_token: 'synthetic-access-token' }); } return Response.json({ errors: [{ message: 'Field "secretThing" leaked synthetic-access-token' }] }); };
  await assert.rejects(graphqlSource(env, { fetcher: failing }), error => error.code === 'jobber_import_graphql_failed' && !/synthetic-access-token|secretThing/.test(error.message));
  let token = true;
  const broken = async () => { if (token) { token = false; return Response.json({ access_token: 'synthetic-access-token' }); } return Response.json({ data: { visits: { nodes: [], pageInfo: { hasNextPage: true, endCursor: '' } } } }); };
  await assert.rejects(graphqlSource(env, { fetcher: broken }), /pagination did not finish/);
});

test('command-line arguments default to a dry run and reject ambiguous or unsafe combinations', () => {
  const fingerprint = 'a'.repeat(64);
  assert.deepEqual(parseArgs(['--clients', 'c.csv']), { source: 'csv', files: { clients: ['c.csv'] }, mapping: '', resolutions: '', historySince: '', report: '', apply: false, expectFingerprint: '', expectPlan: '', reviewedReport: '', allowLargeJobsCollection: false, help: false });
  const full = parseArgs(['--clients=c.csv', '--visits', 'v.csv', '--invoices', 'i.csv', '--recurring', 'r.csv', '--mapping', 'm.json', '--resolutions', 'res.json', '--history-since', '2025-01-01', '--report', 'out.json', '--apply', '--expect-fingerprint', fingerprint, '--expect-plan', 'b'.repeat(64), '--reviewed-report', 'dry.json', '--allow-large-jobs-collection']);
  assert.deepEqual([full.apply, full.expectFingerprint, full.expectPlan, full.reviewedReport, full.historySince, full.files.recurring, full.allowLargeJobsCollection], [true, fingerprint, 'b'.repeat(64), 'dry.json', '2025-01-01', ['r.csv'], true]);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--expect-plan', fingerprint]), /only used with --apply/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--apply', '--expect-plan', 'xyz']), /64-character planFingerprint/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--reviewed-report', 'dry.json']), /only used with --apply/);
  assert.deepEqual(parseArgs(['--clients', 'part1.csv', '--clients=part2.csv']).files.clients, ['part1.csv', 'part2.csv'], 'split exports are passed as repeated flags');
  assert.equal(parseArgs(['--source=graphql']).source, 'graphql');
  assert.throws(() => parseArgs([]), /client export is required/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--expect-fingerprint', fingerprint]), /only used with --apply/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--apply', '--expect-fingerprint', 'abc']), /64-character/);
  assert.throws(() => parseArgs(['--source=graphql', '--clients', 'c.csv']), /cannot be combined/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--history-since', '2025-13-01']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--clients']), /incomplete/);assert.throws(() => parseArgs(['--clients', '--apply']), /incomplete/);
  assert.throws(() => parseArgs(['--clients', 'c.csv', '--send']), /Unknown/);assert.throws(() => parseArgs(['--source', 'jobber-api', '--clients', 'c.csv']), /csv or graphql/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('deterministic ids reject unsafe Jobber identifiers', () => {
  assert.equal(map.hubIds.customer('1001'), 'jobber_client_1001');assert.equal(map.hubIds.customer('../x'), '');
  assert.equal(map.hubIds.job('2001'), 'jobber_job_2001');assert.equal(map.hubIds.job('20a'), '');
  assert.equal(map.hubIds.invoice('INV-9'), 'jobber_invoice_INV-9');assert.equal(map.hubIds.invoice('9/..'), '');
  assert.equal(map.hubIds.visit('2002', { date: '2026-09-10', time: '', endTime: '' }), 'jobber_visit_2002_20260910_anytime');
  assert.equal(map.hubIds.visit('2002', { date: '' }), '');
  assert.equal(map.jobberNumericId(encoded('Client', 12345), 'Client'), '12345');assert.equal(map.jobberNumericId(encoded('Visit', 9), 'Client'), '');assert.equal(map.jobberNumericId('%%%'), '');
});

test('Jobber report formats: decimal-hour durations and Rails timestamps with a spaced offset or UTC', () => {
  assert.equal(map.parseDurationMinutes('0.5'), 30, 'the Visits report exports Scheduled duration as decimal hours');
  assert.equal(map.parseDurationMinutes('2'), 120);assert.equal(map.parseDurationMinutes('1.25'), 75);
  for (const value of ['0', '0.0', '800', '-1', '1.2.3']) assert.equal(map.parseDurationMinutes(value), null, value);
  assert.equal(map.visitSchedule({ date: 'Sep 24, 2026 9:00 AM', duration: '2.5' }).endAt, '2026-09-24T17:30:00.000Z');
  assert.deepEqual(map.parseJobberDate('2026-09-24 09:00:00 -0600'), { date: '2026-09-24', time: '09:00' });
  assert.deepEqual(map.parseJobberDate('2026-12-01 16:00:00 +0000'), { date: '2026-12-01', time: '09:00' });
  assert.deepEqual(map.parseJobberDate('2026-09-25 05:30:00 UTC'), { date: '2026-09-24', time: '23:30' }, 'a UTC timestamp can fall on the previous Denver day');
  assert.deepEqual(map.denverWallClock('2026-09-24T15:00:00Z'), { date: '2026-09-24', time: '09:00' });
  for (const value of ['2026-09-24 09:00:00 CST', '2026-09-24 9:00 -0600', 'yesterday UTC']) assert.equal(map.parseJobberDate(value), null, value);
});

test('a real-shaped client export: extra Jobber columns are ignored, phones split on semicolons and emails on commas', () => {
  const extra = ['Fax Phone #s', 'Other Phone #s', 'Billing Country', 'Service Country', 'CFT[Door Code and Trim Code]', 'PFT[office]', 'Receives automatic visit/job/quote/invoice follow-ups?'];
  const columns = map.mapColumns('clients', [...CLIENT_HEADERS, ...extra]);
  assert.deepEqual(columns.missing, []);assert.deepEqual(columns.problems, []);assert.deepEqual(columns.unknownHeaders, ['Tags', ...extra]);
  const row = client('1101_5101', 'Synthetic', 'Juliet', { phone: '970-555-0121;970-555-0122', email: 'juliet@example.invalid, juliet.work@example.invalid', company: 'Synthetic Juliet LLC', isCompany: 'false', archived: 'true', street: '121 Synthetic St' });
  const text = csv([[...CLIENT_HEADERS, ...extra], [...row, '970-555-0199', '970-555-0198', 'US', 'US', '1234', 'Synthetic office', 'true']]);
  const [parsed] = csvSource({ clients: text }).clients;
  assert.deepEqual(parsed.phones, ['+19705550121', '+19705550122'], 'fax and other phones are never used for matching');
  assert.deepEqual(parsed.emails, ['juliet@example.invalid', 'juliet.work@example.invalid']);
  assert.deepEqual([parsed.name, parsed.isCompany, parsed.archived], ['Synthetic Juliet', false, true]);
});

test('Hub matching trusts the saved phone and email over stale derived identity keys', () => {
  const customers = [
    { id: 'customer_alpha', name: 'Synthetic Alpha', phone: '(970) 555-0101', phoneE164: '+19705550188', email: '' },
    { id: 'customer_moved', name: 'Synthetic Moved', phone: '970-555-0177', phoneE164: '+19705550103', email: 'moved@example.invalid', emailLower: 'bravo@example.invalid' },
    { id: 'customer_keys_only', name: 'Synthetic Keys', phoneE164: '+19705550107' },
  ];
  const plan = planJobberImport(csvSource(FILES()), { customers, jobs: [] }, { now: NOW, resolutions: RESOLVED });
  const decision = id => plan.report.matches.find(entry => entry.jobberClientId === id);
  assert.deepEqual([decision('1001').action, decision('1001').customerId], ['match', 'customer_alpha']);
  assert.equal(decision('1003').action, 'create', 'a stale phoneE164 left behind on another customer is not a match');
  assert.equal(decision('1002').action, 'create', 'a stale emailLower is not a match either');
  assert.deepEqual([decision('1007').action, decision('1007').customerId], ['match', 'customer_keys_only'], 'a row with only derived keys still matches');
  assert.ok(!plan.report.warnings.some(entry => entry.code === 'matched_customer_differs' && entry.jobberClientId === '1001'), 'the stale key is not reported as a difference');
});

test('imported upcoming work is found in dispatch and scheduled only through dispatch conflict checks and day locks', async t => {
  blockFetch(t);
  const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew One', role: 'crew' }];
  const store = memoryStore({ roster, jobs: HUB_JOBS().filter(row => !row.recordType) }), options = { source: csvSource(FILES()), now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const dry = await runJobberImport(store, { ...options, runId: 'review' });
  await runJobberImport(store, { ...options, apply: true, runId: 'apply', expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
  assert.deepEqual([...store.rows.keys()].filter(key => key.startsWith('jobs/_egc_')), [], 'the import itself never takes calendar capacity');
  const found = await dispatchSearch(store, manager, { q: 'jobber_job', status: 'unscheduled' }, new Date(NOW));
  assert.deepEqual(found.results.map(({ job }) => job.id).sort(), ['jobber_job_2001', 'jobber_job_2004', 'jobber_job_2006']);
  assert.ok(found.results.every(({ job }) => !job.date && job.assignedCrew.length === 0));
  const history = await dispatchSearch(store, manager, { q: 'jobber_visit' }, new Date(NOW));
  assert.deepEqual(history.results, [], 'history records stay out of dispatch');
  const job = store.rows.get('jobs/jobber_job_2001'), schedule = (target, requestId = randomUUID()) => ({ action: 'schedule.update', requestId, jobId: target.id, expectedRevision: target.revision, changes: { date: '2026-09-24', time: '09:00', endTime: '11:00', assignedCrew: ['crew1'] } });
  const saved = await mutateDispatch(store, manager, schedule(job), NOW);
  assert.deepEqual([saved.job.id, saved.job.status, saved.job.date, saved.job.startAt, saved.job.assignedCrew], ['jobber_job_2001', 'scheduled', '2026-09-24', '2026-09-24T15:00:00.000Z', ['crew1']]);
  assert.equal(store.rows.get('jobs/_egc_schedule_lock_2026-09-24').entries.length, 1, 'dispatch wrote the day lock');
  assert.equal(store.rows.get('jobs/jobber_job_2001').notify, false, 'scheduling does not switch customer notifications on');
  await assert.rejects(mutateDispatch(store, manager, schedule(store.rows.get('jobs/jobber_job_2006')), NOW), error => error.code === 'dispatch_conflict', 'a second imported job cannot double-book the same crew');
});

test('imported balances, upcoming work and history never become a card charge or Hub revenue', async t => {
  blockFetch(t);
  const store = memoryStore(), options = { source: csvSource(FILES()), now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const dry = await runJobberImport(store, { ...options, runId: 'review' });
  await runJobberImport(store, { ...options, apply: true, runId: 'apply', expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
  const imported = [...store.rows].filter(([key]) => key.startsWith('jobs/jobber_')).map(([, row]) => row);
  assert.equal(imported.length, 6);
  for (const row of imported) assert.deepEqual(customerMoneyState(row), { total: 0, paid: 0, balance: 0 }, `${row.id} authorizes no portal or crew card charge`);
  const invoice = store.rows.get('jobs/jobber_invoice_3001');
  assert.equal(invoice.invoice.amount, 200, 'the Hub finance board still shows the carried-over balance');
  const facts = financialFacts(invoice);
  assert.deepEqual([facts.eligible, facts.quote, facts.completion, facts.payments.length], [true, null, null, 0]);
  assert.equal(financialFacts(store.rows.get('jobs/jobber_visit_2002_20260910_1300_1500')).eligible, false, 'history is not an operational job');
  for (const [from, to] of [['2024-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z'], ['2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z']]) {
    const report = summarizeFinancialJobs(imported, from, to);
    assert.deepEqual([report.revenueSoldCents, report.revenueCompletedCents, report.cashCollectedCents], [0, 0, 0], 'Jobber revenue is not counted again in the Hub');
  }
});

test('imported jobs and balances join one account root, so Dispatch create and Garage Guard linking keep working', async t => {
  blockFetch(t);
  const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true }, roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }];
  const store = memoryStore({ roster, jobs: HUB_JOBS().filter(row => !row.recordType) }), options = { source: csvSource(FILES()), now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  const create = customerId => mutateDispatch(store, manager, { action: 'schedule.create', requestId: randomUUID(), customerId, kind: 'job', changes: {} }, NOW);
  const before = await create('customer_alpha');
  assert.equal(store.rows.get(`jobs/${before.job.id}`).customerAccountOwnerJobId, 'existing-job', 'before the import the customer has one account root');
  const dry = await runJobberImport(store, { ...options, runId: 'review' });
  assert.deepEqual(dry.conflicts, []);
  const applied = await runJobberImport(store, { ...options, apply: true, runId: 'apply', expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
  assert.equal(applied.aborted, undefined);
  const jobs = await store.jobs();
  for (const [customerId, root] of [['customer_alpha', 'existing-job'], ['jobber_client_1003', 'jobber_job_2006'], ['customer_delta_a', 'jobber_job_2004']]) {
    const lineage = await resolveDispatchLineage(store, { customerId, jobs: jobs.filter(row => row.customerId === customerId) });
    assert.equal(lineage.metadata.rootJobId, root, `${customerId} still has exactly one account root, as Garage Guard linking requires`);
  }
  for (const [customerId, root, label] of [['customer_alpha', 'existing-job', 'Synthetic Alpha'], ['jobber_client_1003', 'jobber_job_2006', 'Synthetic Charlie']]) {
    const created = await create(customerId), saved = store.rows.get(`jobs/${created.job.id}`);
    assert.deepEqual([saved.customerId, saved.customerAccountOwnerJobId, saved.customer], [customerId, root, label], `new work for ${customerId} needs no source job selection`);
  }
});

test('a customer with several account roots or a broken account chain blocks until a root is chosen', () => {
  const source = csvSource(FILES()), plan = (jobs, extra = {}) => planJobberImport(source, { customers: HUB_CUSTOMERS(), jobs }, { now: NOW, resolutions: { ...RESOLVED, ...extra } });
  const jobs = [{ id: 'alpha-a', type: 'job', customerId: 'customer_alpha', revision: 'r1' }, { id: 'alpha-b', type: 'cleanout', customerId: 'customer_alpha', revision: 'r2' },
    { id: 'alpha-c', type: 'job', customerId: 'customer_alpha', customerAccountOwnerJobId: 'alpha-b', revision: 'r3' }, { id: 'alpha-walkthrough', type: 'walkthrough', customerId: 'customer_alpha', revision: 'r4' },
    { id: 'alpha-history', type: 'job', recordType: 'jobber_history', customerId: 'customer_alpha', revision: 'r5' }];
  const several = plan(jobs);
  assert.deepEqual(several.report.conflicts, [{ code: 'customer_has_multiple_account_roots', customerId: 'customer_alpha', jobberClientIds: ['1001'], rootCandidates: ['alpha-a', 'alpha-b'] }], 'walkthroughs and history are not account candidates, as in dispatch');
  assert.ok(several.report.blocking.some(entry => entry.code === 'unresolved_conflicts'));
  const chosen = plan(jobs, { customers: { customer_alpha: { accountRootJobId: 'alpha-b' } } });
  assert.deepEqual(chosen.report.conflicts, []);assert.deepEqual(chosen.report.blocking, []);
  assert.deepEqual(chosen.records.jobs.filter(row => row.customerId === 'customer_alpha').map(row => [row.id, row.customerAccountOwnerJobId]), [['jobber_job_2001', 'alpha-b'], ['jobber_visit_2007_20240303_0900_1000', undefined], ['jobber_invoice_3001', 'alpha-b']], 'history never joins the account');
  assert.deepEqual(chosen.accountRoots.find(root => root.customerId === 'customer_alpha'), { customerId: 'customer_alpha', rootJobId: 'alpha-b', source: 'resolution', revision: 'r2' });
  assert.deepEqual(plan(jobs, { customers: { customer_alpha: { accountRootJobId: 'alpha-c' } } }).report.conflicts.map(entry => [entry.code, entry.accountRootJobId]), [['account_root_resolution_invalid', 'alpha-c']], 'only a verified root can be chosen');
  const broken = plan([{ id: 'alpha-a', type: 'job', customerId: 'customer_alpha', customerAccountOwnerJobId: 'gone', revision: 'r1' }, { id: 'alpha-b', type: 'job', customerId: 'customer_alpha', customerAccountOwnerJobId: 'bravo-root', revision: 'r2' }, { id: 'bravo-root', type: 'job', customerId: 'customer_bravo', revision: 'r3' }]);
  assert.deepEqual(broken.report.conflicts.map(entry => [entry.code, entry.customerId, entry.jobIds]), [['customer_account_link_invalid', 'customer_alpha', ['alpha-a', 'alpha-b']]], 'a missing or cross-customer owner is never followed');
  const cycle = plan([{ id: 'alpha-a', type: 'job', customerId: 'customer_alpha', customerAccountOwnerJobId: 'alpha-b', revision: 'r1' }, { id: 'alpha-b', type: 'job', customerId: 'customer_alpha', customerAccountOwnerJobId: 'alpha-a', revision: 'r2' }]);
  assert.equal(cycle.report.conflicts[0].code, 'customer_account_link_invalid');
  assert.equal(plan([{ id: 'alpha-a', type: 'job', customerId: 'customer_alpha' }]).report.conflicts[0].code, 'customer_account_link_invalid', 'a root without a verifiable revision is refused, as dispatch refuses it');
  assert.throws(() => normalizeResolutions({ customers: { customer_alpha: { accountRootJobId: '_egc_schedule_lock_x' } } }), /exactly one of/);
  assert.doesNotMatch(JSON.stringify(several.report.conflicts), PII);
});

test('a re-rooted account or a dispatch change during apply stops the import before the batch is written', async t => {
  blockFetch(t);
  const options = { source: csvSource(FILES()), now: NOW, resolutions: RESOLVED, historySince: '2025-01-01' };
  for (const [collection, id, change] of [['jobs', 'existing-job', { customerAccountOwnerJobId: 'elsewhere' }], ['dispatchState', 'revision', { lastRequestId: 'synthetic-dispatch-request' }]]) {
    const store = memoryStore(), dry = await runJobberImport(store, { ...options, runId: 'review' });
    let calls = 0;const commit = store.commit;
    store.commit = async writes => { if (++calls === 2) store.rows.set(`${collection}/${id}`, { ...store.rows.get(`${collection}/${id}`), ...change, id, revision: 'concurrent' }); return commit(writes); };
    const stopped = await runJobberImport(store, { ...options, apply: true, runId: 'run-' + collection, expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
    assert.equal(stopped.aborted.code, 'jobber_import_hub_changed', collection);
    assert.deepEqual(stopped.writes.committed, { customers: 0, jobs: 0 });
    assert.equal([...store.rows.keys()].filter(key => /^(customers\/jobber_client_|jobs\/jobber_)/.test(key)).length, 0, 'nothing from the stopped batch was written');
  }
});

test('one-off Jobber jobs with several upcoming visits are listed so each visit is scheduled by hand', async t => {
  blockFetch(t);
  const extra = csv([visit('2009', 'Oct 7, 2026', '9:00 AM - 11:00 AM', 'Synthetic Charlie', { phone: '970-555-0103' }), visit('2009', 'Nov 20, 2026', '1:00 PM - 3:00 PM', 'Synthetic Charlie', { phone: '970-555-0103' }),
    visit('2006', 'Oct 19, 2026', '8:00 AM - 10:00 AM', 'Synthetic Charlie', { phone: '970-555-0103', type: 'Recurring', title: 'Garage tidy' }),
    visit('2010', 'Oct 8, 2026', '8:00 AM - 10:00 AM', 'Synthetic Charlie', { phone: '970-555-0103', type: 'Recurring' }), visit('2010', 'Oct 22, 2026', '8:00 AM - 10:00 AM', 'Synthetic Charlie', { phone: '970-555-0103', type: 'Recurring' })]);
  const store = memoryStore(), report = await runJobberImport(store, { source: csvSource({ ...FILES(), visits: VISITS() + extra }), now: NOW, runId: 'multi', resolutions: RESOLVED, historySince: '2025-01-01' });
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.multiVisitJobs.map(({ id, jobType, visitCount, dates }) => [id, jobType, visitCount, dates]), [
    ['jobber_job_2001', 'one_off', 2, ['2026-09-24', '2026-09-25']], ['jobber_job_2009', 'one_off', 2, ['2026-10-07', '2026-11-20']], ['jobber_job_2010', 'recurring', 2, ['2026-10-08', '2026-10-22']]],
  'a recurring job with a plan proposal is covered by the plan; one without a proposal is listed');
  assert.deepEqual(report.multiVisitJobs[1].visits, ['Wed, Oct 7, 2026 9:00 AM–11:00 AM', 'Fri, Nov 20, 2026 1:00 PM–3:00 PM']);assert.equal(report.multiVisitJobs[1].alreadyImported, false);
  assert.deepEqual([report.counts.visits.multiVisitJobs, report.counts.visits.visitsToAddByHand], [3, 3]);
  assert.equal(report.preview.upcomingJobs.filter(id => id === 'jobber_job_2009').length, 1, 'still one Hub job per Jobber job, so a Jobber reschedule never duplicates it on a rerun');
  const planned = (await planJobberImport(csvSource({ ...FILES(), visits: VISITS() + extra }), { customers: HUB_CUSTOMERS(), jobs: [] }, { now: NOW, resolutions: RESOLVED })).records.jobs.find(row => row.id === 'jobber_job_2009');
  assert.match(planned.opsNotes, /Jobber visits \(2\): Wed, Oct 7, 2026 9:00 AM–11:00 AM; Fri, Nov 20, 2026 1:00 PM–3:00 PM\./);assert.match(planned.opsNotes, /schedule each of these 2 visits/);
  assert.deepEqual(planned.jobber.visits.map(entry => entry.date), ['2026-10-07', '2026-11-20']);
  assert.doesNotMatch(JSON.stringify(report.multiVisitJobs), PII);
});

test('apply refuses a plan that the Hub or the clock changed since the reviewed dry run and describes the difference', async t => {
  blockFetch(t);
  const store = memoryStore(), options = { source: csvSource(FILES()), resolutions: RESOLVED, historySince: '2025-01-01' }, expect = dry => ({ expectFingerprint: dry.sourceFingerprint, expectPlanFingerprint: dry.planFingerprint });
  const dry = await runJobberImport(store, { ...options, now: NOW, runId: 'review' });
  assert.match(dry.planFingerprint, /^[a-f0-9]{64}$/);assert.equal(Object.keys(dry.plan.writes).length, 10);assert.equal(dry.plan.clients['1001'], 'match customer_alpha');
  const later = '2026-09-24T18:00:00.000Z'; // job 2001's Sep 24 morning visit is now past and was never completed
  const unquoted = await runJobberImport(store, { ...options, now: later, apply: true, runId: 'apply-1', expectFingerprint: dry.sourceFingerprint });
  assert.equal(unquoted.aborted.code, 'jobber_import_plan_changed');assert.equal(unquoted.aborted.difference, undefined);
  const drifted = await runJobberImport(store, { ...options, now: later, apply: true, runId: 'apply-2', ...expect(dry), reviewedPlan: dry.plan });
  assert.equal(drifted.aborted.code, 'jobber_import_plan_changed', 'the source fingerprint alone would have let this through');
  assert.deepEqual(drifted.aborted.difference, { writesAdded: { count: 0, items: [] }, writesRemoved: { count: 0, items: [] }, writesChanged: { count: 1, items: ['jobs/jobber_job_2001'] }, clientsChanged: { count: 0, items: [] } });
  assert.match(drifted.aborted.message, /0 writes added, 0 removed, 1 changed, 0 client decisions changed/);
  store.rows.set('customers/customer_charlie', { id: 'customer_charlie', name: 'Synthetic Charlie', phone: '970-555-0103', revision: 'manual' });
  const rematched = await runJobberImport(store, { ...options, now: NOW, apply: true, runId: 'apply-3', ...expect(dry), reviewedPlan: dry.plan });
  assert.deepEqual(rematched.aborted.difference.clientsChanged.items, [{ jobberClientId: '1003', reviewed: 'create jobber_client_1003', now: 'match customer_charlie' }]);
  assert.deepEqual(rematched.aborted.difference.writesRemoved.items, ['customers/jobber_client_1003']);
  assert.deepEqual(rematched.aborted.difference.writesChanged.items, ['jobs/jobber_invoice_3002', 'jobs/jobber_job_2006', 'jobs/jobber_visit_2002_20260910_1300_1500']);
  assert.equal(store.commits.length, 0);
  store.rows.delete('customers/customer_charlie');
  const minuteLater = '2026-09-22T18:01:00.000Z', applied = await runJobberImport(store, { ...options, now: minuteLater, apply: true, runId: 'apply-4', ...expect(dry) });
  assert.equal(applied.aborted, undefined, 'the run\'s own timestamps and runId never change the plan');
  assert.deepEqual(applied.writes.committed, { customers: 4, jobs: 6 });assert.equal(store.rows.get('jobs/jobber_job_2001').createdAt, minuteLater);
});

test('the report file is replaced with mode 0600 even when an older report was readable by others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobber-report-'));
  try {
    const path = join(dir, 'dry-run.json');
    await writeFile(path, 'old report', { mode: 0o644 });await chmod(path, 0o644);
    await writeReportFile(path, '{"mode":"dry_run"}\n');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), '{"mode":"dry_run"}\n');
    assert.deepEqual(await readdir(dir), ['dry-run.json'], 'no temporary file is left behind');
    await assert.rejects(writeReportFile(join(dir, 'missing', 'x.json'), '{}'));
    assert.deepEqual(await readdir(dir), ['dry-run.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
