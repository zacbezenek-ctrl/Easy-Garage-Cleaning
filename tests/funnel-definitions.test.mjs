import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson, cutoverCoverageReasons, definitionsHash, definitionsProblems, funnelDefinitions, funnelDimensionValue, funnelEligibility, funnelReasonCodes,
  funnelServiceLine, funnelVocabulary, ghlContactEligibility, ghlTagKey, hubEligibilityFields, hubRecordEligibility, isFunnelReasonCode, sha256Hex, stripeEligibility, validateFunnelDefinitions,
} from '../functions/_lib/funnel-definitions.js';
import { salesExitService } from '../functions/_lib/sales-followup-exit.js';
import HUB_COPY from '../functions/_lib/funnel-definitions.data.js';
import { FUNNEL_DEFINITION_PATHS, funnelDefinitionOutputs, funnelDefinitionsDrift, writeFunnelDefinitions } from '../scripts/funnel-definitions.mjs';
import { financialFacts, portalRevenue, summarizeFinancialJobs } from '../functions/_lib/operations-financials.js';
import { moneyJob } from '../functions/_lib/money-service.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { portalEvidence } from '../functions/_lib/operations-portal-records.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const canonicalText = read(FUNNEL_DEFINITION_PATHS.canonical);
const clone = value => JSON.parse(JSON.stringify(value));

test('the shipped definitions are valid and every generated copy matches the canonical JSON (drift check)', () => {
  assert.deepEqual(definitionsProblems(), []);
  const { hash, version, drift } = funnelDefinitionsDrift(root);
  assert.deepEqual(drift, [], 'run node scripts/funnel-definitions.mjs --write and commit the result');
  assert.equal(HUB_COPY, canonicalText, 'the Hub runtime copy is the exact canonical text');
  assert.equal(read(FUNNEL_DEFINITION_PATHS.platformJson), canonicalText, 'the platform package JSON is byte-identical');
  assert.equal(hash, definitionsHash());
  assert.equal(version, funnelDefinitions().definitionsVersion);
  const pinned = read(FUNNEL_DEFINITION_PATHS.platformHash);
  assert.match(pinned, new RegExp(`hubDefinitionsHash = "${definitionsHash()}";`));
  assert.match(pinned, new RegExp(`hubDefinitionsVersion = "${version.replace('.', '\\.')}";`));
});

test('the drift check reports a hand-edited copy and --write repairs it in a temp checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egc-funnel-defs-'));
  try {
    for (const path of Object.values(FUNNEL_DEFINITION_PATHS)) { mkdirSync(join(dir, path, '..'), { recursive: true }); cpSync(join(root, path), join(dir, path)); }
    assert.deepEqual(funnelDefinitionsDrift(dir).drift, []);
    writeFileSync(join(dir, FUNNEL_DEFINITION_PATHS.platformJson), canonicalText.replace('"repeatWindowDays": 30', '"repeatWindowDays": 31'));
    const edited = JSON.parse(canonicalText); edited.cycles.stalledAfterDaysWithoutEvent = 22;
    writeFileSync(join(dir, FUNNEL_DEFINITION_PATHS.canonical), JSON.stringify(edited, null, 2) + '\n');
    const { drift, hash } = funnelDefinitionsDrift(dir);
    assert.deepEqual(drift.map(item => item.path).sort(), [FUNNEL_DEFINITION_PATHS.hubModule, FUNNEL_DEFINITION_PATHS.platformJson, FUNNEL_DEFINITION_PATHS.platformHash].sort());
    assert.notEqual(hash, definitionsHash(), 'a changed rule changes definitionsHash');
    writeFunnelDefinitions(dir);
    assert.deepEqual(funnelDefinitionsDrift(dir).drift, []);
    assert.equal(readFileSync(join(dir, FUNNEL_DEFINITION_PATHS.platformJson), 'utf8'), readFileSync(join(dir, FUNNEL_DEFINITION_PATHS.canonical), 'utf8'));
    assert.match(readFileSync(join(dir, FUNNEL_DEFINITION_PATHS.platformHash), 'utf8'), new RegExp(hash));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a check never writes: a missing Hub copy is reported as drift, importing the script writes nothing, and only --write restores it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egc-funnel-script-'));
  try {
    for (const path of ['package.json', 'scripts/funnel-definitions.mjs', 'functions/_lib/funnel-definitions.js', FUNNEL_DEFINITION_PATHS.canonical, FUNNEL_DEFINITION_PATHS.platformJson, FUNNEL_DEFINITION_PATHS.platformHash]) { mkdirSync(join(dir, path, '..'), { recursive: true }); cpSync(join(root, path), join(dir, path)); }
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const script = join(dir, 'scripts/funnel-definitions.mjs'), hub = join(dir, FUNNEL_DEFINITION_PATHS.hubModule);
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    for (const args of [[], ['--check']]) {
      const result = run(...args);
      assert.equal(result.status, 1, `check ${args}`);
      assert.match(result.stderr, /drift: functions\/_lib\/funnel-definitions\.data\.js missing/);
      assert.equal(existsSync(hub), false, 'a check never writes');
    }
    assert.equal(run('--bogus').status, 2);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => process.exit(0), () => process.exit(3))`], { encoding: 'utf8' });
    assert.equal(imported.status, 3, 'the helpers cannot load without the copy');
    assert.equal(existsSync(hub), false, 'importing the script never writes');
    const written = run('--write');
    assert.equal(written.status, 0, written.stderr);
    assert.equal(readFileSync(hub, 'utf8'), read(FUNNEL_DEFINITION_PATHS.hubModule));
    assert.equal(run('--check').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sync script refuses to generate from invalid definitions', () => {
  assert.throws(() => funnelDefinitionOutputs('{"schemaVersion":1'), /not valid JSON/);
  assert.throws(() => funnelDefinitionOutputs('﻿' + canonicalText), /byte-order mark/);
  const broken = JSON.parse(canonicalText); broken.eventTypes['job.cancelled'].reasons = 'nope';
  assert.throws(() => funnelDefinitionOutputs(JSON.stringify(broken)), /reason list/);
});

test('definitionsHash is sha256 over canonical JSON and is stable across calls, processes and key order', () => {
  const hash = definitionsHash();
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(definitionsHash(), hash);
  assert.equal(sha256Hex(canonicalJson(JSON.parse(canonicalText))), hash);
  const script = join(root, 'scripts/funnel-definitions.mjs');
  const runs = [0, 1].map(() => execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tokyo', LANG: 'tr_TR.UTF-8' } }).trim());
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[0], `funnel definitions ${funnelDefinitions().definitionsVersion} ${hash}`);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  assert.equal(sha256Hex(canonicalJson(reverse(JSON.parse(canonicalText)))), hash, 'key order never changes the hash');
  assert.equal(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(JSON.parse(canonicalText))))), hash, 'whitespace never changes the hash');
  const changed = JSON.parse(canonicalText); changed.metricWindows.lateCancelHours = 25;
  assert.notEqual(sha256Hex(canonicalJson(changed)), hash);
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], Z: true }), '{"Z":true,"a":[{"c":"x","d":null}],"b":1}', 'UTF-16 code-unit order, not locale order');
});

test('the definitions are deep-frozen so no caller can change a shared rule at runtime', () => {
  const definitions = funnelDefinitions();
  assert.equal(Object.isFrozen(definitions), true);
  assert.throws(() => { definitions.eligibility.ghl.syntheticSources.push('x'); }, TypeError);
  assert.throws(() => { definitions.cycles.repeatWindowDays = 1; }, TypeError);
  assert.equal(definitionsHash(), sha256Hex(canonicalJson(JSON.parse(canonicalText))));
});

test('the validator rejects inconsistent definitions instead of letting them reach a caller', () => {
  const base = JSON.parse(canonicalText);
  assert.deepEqual(validateFunnelDefinitions(base), []);
  const cases = [
    [d => { d.timeZone = 'UTC'; }, /America\/Denver/],
    [d => { d.calendar.businessHours.monday = [['19:00', '07:00']]; }, /monday has an invalid interval/],
    [d => { delete d.calendar.businessHours.sunday; }, /all seven days/],
    [d => { d.eventTypes['deal.sold'].required.push('notAField'); }, /deal\.sold has invalid data fields/],
    [d => { d.eventTypes['job.scheduled'].entity = ['nopeId']; }, /job\.scheduled needs entity fields/],
    [d => { delete d.eventTypes['job.cancelled'].reasons; }, /job\.cancelled must name its reason list/],
    [d => { d.dataFields.channel.values = 'vocabularies.missing'; }, /channel references an unknown list/],
    [d => { d.vocabularies.serviceLines.push('garage_transformation'); }, /serviceLines must be a list of unique codes/],
    [d => { d.eligibility.ghl.exclusionTags.test = 'nonsense'; }, /GHL exclusion tag test is invalid/],
    [d => { d.eventIntegrity.idempotencyKeys.requestId.pattern = '(unclosed'; }, /idempotency key requestId is invalid/],
    [d => { d.eventIntegrity.cutoverDate = 'soon'; }, /cutoverDate/],
    [d => { d.serviceLineSources.salesExitService.junk = 'haul_away'; }, /salesExitService maps to an unknown service line/],
    [d => { d.calendar.holidays.rules.push({ id: 'bad', month: 13, day: 1 }); }, /holiday rule bad is invalid/],
    [d => { d.cycles.repeatWindowDays = 0; }, /cycles\.repeatWindowDays/],
    [d => { d.metricDimensions.funnelPath.values = 'vocabularies.nope'; }, /metricDimensions\.funnelPath is invalid/],
    [d => { d.serviceLineSources.precedence.push('crystalBall'); }, /precedence must list known sources once/],
    [d => { d.serviceLineSources.precedence.push('explicit'); }, /precedence must list known sources once/],
    [d => { d.metricDimensions.serviceLine.missingBucket = 'nobody_knows'; }, /missing bucket must be a service line/],
    [d => { d.eventIntegrity.backfillClockSources.push('server'); }, /backfillClockSources must include backfill and never a live clock/],
    [d => { d.eventIntegrity.backfillClockSources = ['attested']; }, /backfillClockSources must include backfill/],
    [d => { d.eligibility.ghl.exclusionTags['Egc Test'] = 'test'; }, /GHL exclusion tag Egc Test is invalid \(tags are folded/],
    [d => { d.eligibility.ghl.exclusionTags.egc_test = 'test'; }, /GHL exclusion tag egc_test is invalid/],
    [d => { d.eligibility.ghl.exclusionTags['egc--test'] = 'test'; }, /GHL exclusion tag egc--test is invalid/],
    [d => { d.eligibility.ghl.tagFolding = 'exact'; }, /tagFolding is fixed/],
    [d => { delete d.eligibility.ghl.exclusionFlags; }, /exclusionFlags is required/],
    [d => { d.eligibility.ghl.exclusionFlags.dnd = 'private_record'; }, /GHL exclusion flag dnd is invalid/],
    [d => { d.eligibility.ghl.exclusionFlags['is-test'] = 'test'; }, /GHL exclusion flag is-test is invalid/],
    [d => { d.calendar.periods.sameLastYearAlignment.day = 'same_day'; }, /sameLastYearAlignment needs same_weekday or same_date/],
    [d => { delete d.calendar.periods.sameLastYearAlignment.custom; }, /sameLastYearAlignment needs same_weekday or same_date/],
    [d => { d.calendar.periods.weekdayAlignedShiftDays = 365; }, /weekdayAlignedShiftDays must be whole weeks/],
    [d => { d.eventIntegrity.deviceClock.outOfBoundsOccurredAt = 'device_time'; }, /deviceClock outcomes are fixed/],
  ];
  for (const [mutate, message] of cases) {
    const copy = clone(base); mutate(copy);
    assert.match(validateFunnelDefinitions(copy).join('\n'), message);
  }
  assert.deepEqual(validateFunnelDefinitions(null), ['definitions must be an object']);
});

test('vocabularies and reason codes come from the one file', () => {
  assert.deepEqual([...funnelVocabulary('serviceLines')], ['garage_transformation', 'junk_removal', 'garage_guard_visit', 'commercial_b2b', 'unknown']);
  assert.deepEqual([...funnelVocabulary('funnelPaths')], ['walkthrough', 'remote_photo_video_quote', 'direct_phone_booking', 'b2b_request', 'rebook', 'member_visit', 'recurring']);
  assert.deepEqual([...funnelReasonCodes('walkthroughOutcome')], ['sold_on_site', 'quote_to_follow', 'not_interested', 'customer_no_show', 'rescheduled']);
  assert.deepEqual([...funnelReasonCodes('lost')].slice(0, 7), ['price', 'timing', 'chose_competitor', 'diy', 'no_response', 'not_a_fit', 'other']);
  for (const kind of ['cancel', 'reschedule', 'noShow', 'lost']) assert.equal(isFunnelReasonCode(kind, 'other_legacy'), true, `${kind} keeps the legacy bucket for FUN-04`);
  assert.equal(isFunnelReasonCode('cancel', 'no_response'), false);
  assert.throws(() => funnelVocabulary('nope'), error => error.code === 'funnel_definitions_unknown');
  assert.throws(() => funnelReasonCodes('nope'), error => error.code === 'funnel_definitions_unknown');
  const sources = funnelDefinitions().serviceLineSources;
  assert.equal(sources.ghlGarageHelpRequested.values['Item Removal Only'], 'junk_removal');
  assert.equal(sources.ghlGarageHelpRequested.values['Full Garage Transformation'], 'garage_transformation');
  assert.deepEqual({ ...sources.legacyJobType }, { cleanout: 'garage_transformation', reorg: 'garage_transformation' });
  // A1: every metric can be grouped by service line and funnel path, with an explicit unknown bucket.
  const dimensions = funnelDefinitions().metricDimensions;
  assert.deepEqual(Object.keys(dimensions), ['serviceLine', 'funnelPath']);
  for (const dimension of Object.values(dimensions)) assert.equal(dimension.missingBucket, 'unknown');
  // Every event type named by the design (§4.1) exists, and nothing else. FUN-02 added
  // walkthrough.restored so a restored walkthrough cancellation has its counterpart.
  const design = ['inquiry.received', 'walkthrough.booked', 'walkthrough.rescheduled', 'walkthrough.started', 'walkthrough.completed', 'walkthrough.no_show', 'walkthrough.cancelled', 'walkthrough.restored', 'notes.confirmed', 'scope.reviewed', 'quote.drafted', 'quote.revised', 'quote.sent', 'deal.sold', 'deal.approval_superseded', 'deal.lost', 'deal.reopened', 'change_order.approved', 'change_order.declined', 'payment.received', 'payment.refunded', 'payment.disputed', 'payment.dispute_closed', 'invoice.issued', 'invoice.voided', 'credit.issued', 'credit.redeemed', 'gift_card.sold', 'job.scheduled', 'job.rescheduled', 'job.assigned', 'job.dispatched', 'job.arrived', 'job.started', 'job.completed', 'job.cancelled', 'job.restored', 'job.no_show', 'job.paid_in_full', 'job.balance_reopened', 'project.closed', 'project.costs_finalized', 'project.costs_restated', 'review.requested', 'review.clicked', 'csat.received', 'rebook.requested', 'rebook.contacted', 'rebook.booked', 'membership.started', 'membership.renewed', 'membership.payment_failed', 'membership.cancelled', 'membership.visit_used'];
  assert.deepEqual(Object.keys(funnelDefinitions().eventTypes).sort(), design.sort());
});

test('service line pre-fill follows the shared precedence, and every metric groups by service line and path with an unknown bucket (A1)', () => {
  assert.deepEqual(funnelServiceLine({}), { serviceLine: 'unknown', source: null }, 'nothing decisive: the booking asks for one tap');
  assert.deepEqual(funnelServiceLine(null), { serviceLine: 'unknown', source: null });
  assert.deepEqual(funnelServiceLine({ legacyJobType: 'cleanout' }), { serviceLine: 'garage_transformation', source: 'legacyJobType' });
  assert.deepEqual(funnelServiceLine({ legacyJobType: 'job' }), { serviceLine: 'unknown', source: null }, 'a plain job type decides nothing');
  // salesExitService() output feeds the resolver directly.
  assert.deepEqual(funnelServiceLine({ salesExitService: salesExitService({ serviceType: 'Junk removal' }), legacyJobType: 'cleanout' }), { serviceLine: 'junk_removal', source: 'salesExitService' });
  assert.deepEqual(funnelServiceLine({ salesExitService: salesExitService({ serviceType: 'Garage and junk' }), legacyJobType: 'reorg' }), { serviceLine: 'garage_transformation', source: 'legacyJobType' }, 'an ambiguous service name falls through');
  // The GHL "Facebook - Garage Help Requested" field beats the Hub's service name.
  assert.deepEqual(funnelServiceLine({ ghlGarageHelpRequested: ' item removal only ', salesExitService: 'garage' }), { serviceLine: 'junk_removal', source: 'ghlGarageHelpRequested' });
  assert.deepEqual(funnelServiceLine({ ghlGarageHelpRequested: 'Full Garage Transformation' }).serviceLine, 'garage_transformation');
  assert.deepEqual(funnelServiceLine({ ghlGarageHelpRequested: 'Something else' }), { serviceLine: 'unknown', source: null });
  assert.deepEqual(funnelServiceLine({ businessAccountId: 'acct-1', ghlGarageHelpRequested: 'Item Removal Only' }), { serviceLine: 'commercial_b2b', source: 'businessAccount' });
  assert.equal(funnelServiceLine({ businessAccountId: '_egc_forged' }).source, null, 'a private id is not a business account');
  assert.deepEqual(funnelServiceLine({ visitPurpose: 'member_visit', businessAccountId: 'acct-1' }), { serviceLine: 'garage_guard_visit', source: 'visitPurpose' });
  assert.deepEqual(funnelServiceLine({ visitPurpose: 'service', legacyJobType: 'reorg' }).source, 'legacyJobType');
  assert.deepEqual(funnelServiceLine({ explicit: 'junk_removal', visitPurpose: 'member_visit' }), { serviceLine: 'junk_removal', source: 'explicit' }, 'a staff choice wins');
  assert.deepEqual(funnelServiceLine({ explicit: 'unknown', legacyJobType: 'cleanout' }).source, 'legacyJobType', 'an explicit unknown is no decision');
  assert.deepEqual(funnelServiceLine({ explicit: 'lawn_care', legacyJobType: 'constructor' }), { serviceLine: 'unknown', source: null }, 'unknown values and prototype keys decide nothing');
  for (const line of funnelVocabulary('serviceLines')) assert.equal(funnelDimensionValue('serviceLine', line), line);
  for (const path of funnelVocabulary('funnelPaths')) assert.equal(funnelDimensionValue('funnelPath', path), path);
  for (const value of [undefined, null, '', 'lawn_care', 'toString']) { assert.equal(funnelDimensionValue('serviceLine', value), 'unknown'); assert.equal(funnelDimensionValue('funnelPath', value), 'unknown'); }
  for (const name of ['channel', '__proto__', 'constructor']) assert.throws(() => funnelDimensionValue(name, 'x'), error => error.code === 'funnel_definitions_unknown', name);
});

test('the cutover date turns every earlier period partial with pre_cutover_history', () => {
  assert.equal(funnelDefinitions().eventIntegrity.cutoverDate, null, 'the cutover is an owner decision recorded when FUN-02/03/33 ship');
  assert.deepEqual(cutoverCoverageReasons('2026-09-01'), ['pre_cutover_history']);
  assert.throws(() => cutoverCoverageReasons('2026-9-1'), error => error.code === 'funnel_definitions_invalid_date');
});

test('Hub eligibility: private records first, then test flags, then internal with a reason', () => {
  const eligible = hubRecordEligibility({ id: 'job-1', type: 'job' });
  assert.deepEqual(eligible, { eligible: true, exclusion: null, isTest: false, isInternal: false, internalReason: null });
  for (const record of [{ id: 'x', recordType: 'employee_hub_v2' }, { id: '_egc_schedule_op_1', type: 'job' }, { id: 'secure_account', type: 'job' }, null, 'job-1']) {
    const result = hubRecordEligibility(record);
    assert.equal(result.eligible, false); assert.equal(result.exclusion, 'private_record');
  }
  assert.deepEqual(hubRecordEligibility({ id: 'job-2', isTest: true, isInternal: true }), { eligible: false, exclusion: 'test', isTest: true, isInternal: false, internalReason: null });
  assert.equal(hubRecordEligibility({ id: 'job-3', test: true }).exclusion, 'test');
  assert.equal(hubRecordEligibility({ id: 'job-4', isTest: 'true' }).eligible, true, 'only a boolean true marks a test record, as operations-financials always did');
  assert.deepEqual(hubRecordEligibility({ id: 'job-5', isInternal: true, internalReason: 'case_study' }), { eligible: false, exclusion: 'internal', isTest: false, isInternal: true, internalReason: 'case_study' });
  assert.equal(hubRecordEligibility({ id: 'job-6', isInternal: true, internalReason: 'because' }).internalReason, null, 'an unrecognised reason is kept for FUN-25 to list');
});

test('GHL eligibility: exclusion tags (any case), the synthetic routing source and hiring-calendar contacts', () => {
  assert.equal(ghlContactEligibility({ tags: ['egc-website-lead'], source: 'EGC Website' }).eligible, true);
  const cases = [
    [{ tags: [' EGC-Test '] }, 'test', true, false], [{ tags: ['routing-canary'] }, 'test', true, false], [{ tags: ['Internal'] }, 'internal', false, true],
    [{ tags: ['vendor'] }, 'vendor', false, true], [{ tags: ['DNC'] }, 'do_not_contact', false, false], [{ tags: ['do-not-contact'] }, 'do_not_contact', false, false],
    [{ source: 'egc synthetic routing validation' }, 'synthetic_source', true, false], [{ calendarIds: ['2yYX63nHYvUsL6KKhAc0'] }, 'hiring_calendar', false, true],
  ];
  for (const [contact, exclusion, isTest, isInternal] of cases) {
    const result = ghlContactEligibility(contact);
    assert.deepEqual({ eligible: result.eligible, exclusion: result.exclusion, isTest: result.isTest, isInternal: result.isInternal }, { eligible: false, exclusion, isTest, isInternal }, JSON.stringify(contact));
  }
  assert.equal(ghlContactEligibility({ tags: 'test' }).eligible, true, 'malformed tags are not guessed at');
});

// The platform exclusion lists in use before FUN-01, copied verbatim as the oracle
// (services/customer-state/src/core.ts exclusionReasons, services/meta-conversions/src/core.ts).
const PLATFORM_EXCLUSION_TAGS = ['egc-test', 'test', 'test-lead', 'internal', 'egc-internal', 'vendor', 'supplier', 'dnc', 'do-not-contact', 'do not contact', 'egc test', 'test lead', 'egc internal', 'egc vendor'];
const PLATFORM_EXCLUSION_FLAGS = ['isTest', 'is_test', 'isTestLead', 'is_test_lead', 'isInternal', 'isVendor', 'dnd', 'doNotContact'];

test('GHL eligibility folds tags and reads contact flags, so it excludes everything the platform excludes today', () => {
  for (const [raw, folded] of [[' EGC Test ', 'egc-test'], ['egc_test', 'egc-test'], ['EGC--TEST', 'egc-test'], ['do  not_contact', 'do-not-contact'], ['-vendor-', 'vendor'], ['Routing Canary', 'routing-canary'], [42, '']]) assert.equal(ghlTagKey(raw), folded, String(raw));
  for (const tag of PLATFORM_EXCLUSION_TAGS) {
    for (const variant of [tag, tag.toUpperCase(), ` ${tag.replaceAll('-', ' ')} `, tag.replaceAll(/[ -]/g, '_')]) assert.equal(ghlContactEligibility({ tags: ['egc-website-lead', variant] }).eligible, false, variant);
  }
  for (const flag of PLATFORM_EXCLUSION_FLAGS) {
    assert.equal(ghlContactEligibility({ tags: [], [flag]: true }).eligible, false, flag);
    assert.equal(ghlContactEligibility({ [flag]: 'true' }).eligible, true, `${flag}: only a boolean true excludes`);
    assert.equal(ghlContactEligibility({ [flag]: false }).eligible, true, flag);
  }
  const cases = [
    [{ tags: ['Test Lead'] }, 'test', true, false], [{ tags: ['EGC Internal'] }, 'internal', false, true], [{ tags: ['egc vendor'] }, 'vendor', false, true],
    [{ tags: ['Supplier'] }, 'vendor', false, true], [{ tags: ['Do Not Contact'] }, 'do_not_contact', false, false],
    [{ dnd: true }, 'do_not_contact', false, false], [{ doNotContact: true }, 'do_not_contact', false, false], [{ isVendor: true }, 'vendor', false, true],
    [{ isInternal: true }, 'internal', false, true], [{ is_test_lead: true }, 'test', true, false], [{ source: ' EGC_synthetic  routing-validation' }, 'synthetic_source', true, false],
    [{ tags: ['egc-test'], dnd: true }, 'test', true, false],
  ];
  for (const [contact, exclusion, isTest, isInternal] of cases) {
    const result = ghlContactEligibility(contact);
    assert.deepEqual({ eligible: result.eligible, exclusion: result.exclusion, isTest: result.isTest, isInternal: result.isInternal }, { eligible: false, exclusion, isTest, isInternal }, JSON.stringify(contact));
  }
  assert.equal(ghlContactEligibility(Object.create({ dnd: true })).eligible, true, 'inherited properties are not contact flags');
  assert.equal(ghlContactEligibility({ tags: ['testing', 'contest', 'internal-audit-lead'] }).eligible, true, 'only whole folded tags match');
  const { exclusionTags, exclusionFlags } = funnelDefinitions().eligibility.ghl;
  for (const tag of Object.keys(exclusionTags)) assert.equal(ghlTagKey(tag), tag, `${tag} is stored folded`);
  assert.deepEqual(Object.keys(exclusionFlags).sort(), [...PLATFORM_EXCLUSION_FLAGS].sort());
});

test('Stripe eligibility: livemode false and cs_test_ ids are test mode; unknown livemode is not', () => {
  assert.equal(stripeEligibility({ id: 'evt_1', livemode: true }).eligible, true);
  assert.equal(stripeEligibility({ sessionId: 'cs_live_abc' }).eligible, true);
  assert.deepEqual(stripeEligibility({ id: 'evt_2', livemode: false }), { eligible: false, exclusion: 'stripe_test_mode', isTest: true, isInternal: false });
  assert.equal(stripeEligibility({ sessionId: 'cs_test_abc' }).exclusion, 'stripe_test_mode');
  assert.equal(stripeEligibility({ checkoutSessionId: 'cs_test_abc', livemode: true }).exclusion, 'stripe_test_mode');
});

test('combined eligibility keeps every system\'s verdict', () => {
  const combined = funnelEligibility({ hub: { id: 'job-1', isInternal: true, internalReason: 'owner_own' }, ghl: { tags: ['egc-test'] }, stripe: { livemode: true } });
  assert.deepEqual(combined, { eligible: false, exclusion: 'internal', isTest: true, isInternal: true, internalReason: 'owner_own', exclusions: ['internal', 'test'] });
  assert.deepEqual(funnelEligibility({}), { eligible: true, exclusion: null, isTest: false, isInternal: false, internalReason: null, exclusions: [] });
});

// The pre-FUN-01 operations-financials rule, kept verbatim as the oracle.
const legacyJobEligible = job => ['job', 'cleanout', 'reorg'].includes(job.type) && !job.recordType && !/^(secure_|_egc_)/.test(job.id || '') && job.isTest !== true && job.test !== true;

test('operations-financials adopts the shared eligibility without changing any existing result', () => {
  const types = ['job', 'cleanout', 'reorg', 'walkthrough', 'blocked', undefined];
  const ids = ['job-1', '_egc_schedule_op_1', 'secure_x', '', undefined, 42];
  const flags = [{}, { isTest: true }, { test: true }, { isTest: 'true' }, { recordType: 'schedule_lock' }, { recordType: '' }, { isTest: false, test: false }];
  let compared = 0;
  for (const type of types) for (const id of ids) for (const flag of flags) {
    const job = { type, id, ...flag, customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', amount: 500 } };
    assert.equal(financialFacts(job).eligible, legacyJobEligible(job), JSON.stringify(job)); compared += 1;
  }
  assert.equal(compared, types.length * ids.length * flags.length);
  const approval = { customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', amount: 500 } };
  const internal = { id: 'job-internal', type: 'job', isInternal: true, internalReason: 'case_study', ...approval };
  const real = { id: 'job-real', type: 'job', ...approval };
  const summary = summarizeFinancialJobs([internal, real], '2026-09-01T06:00:00.000Z', '2026-10-01T06:00:00.000Z');
  assert.equal(summary.eligibleJobs, 1, 'internal jobs (new, optional field) never count as revenue');
  assert.equal(summary.revenueSoldCents, 50000);
  const sessions = [{ sessionId: 'cs_live_a', paymentIntentId: 'pi_a', amount: 100, verifiedAt: '2026-09-11T15:00:00.000Z' }, { sessionId: 'cs_live_b', paymentIntentId: 'pi_b', amount: 50, verifiedAt: '2026-09-12T15:00:00.000Z', livemode: false }, { sessionId: 'cs_test_c', amount: 25, verifiedAt: '2026-09-12T15:00:00.000Z' }];
  const facts = financialFacts({ id: 'job-paid', type: 'job', payment: { verified: true, amount: 100, stripeSessions: sessions } });
  assert.deepEqual(facts.payments.map(receipt => receipt.key), ['pi_a'], 'test-mode sessions (cs_test_ or livemode false) are never cash');
  assert.deepEqual(facts.exceptions, []);
});

test('the revenue scan fetches every field the shared eligibility reads, so internal jobs are excluded in production', async () => {
  assert.deepEqual(hubEligibilityFields(), ['recordType', 'isTest', 'test', 'isInternal', 'internalReason']);
  const approval = { customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', amount: 500 } };
  const stored = { real: { type: 'job', ...approval }, internal: { type: 'job', isInternal: true, internalReason: 'owner_own', ...approval }, tested: { type: 'job', test: true, ...approval } };
  const masks = [];
  // Firestore honours mask.fieldPaths: a field left out of the mask never reaches the eligibility check.
  const fetcher = async (_env, url) => {
    const mask = new URL(url).searchParams.getAll('mask.fieldPaths'); masks.push(mask);
    return Response.json({ documents: Object.entries(stored).map(([id, fields]) => ({ name: `projects/p/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(Object.fromEntries(Object.entries(fields).filter(([key]) => mask.includes(key)))) })) });
  };
  const result = await portalRevenue({}, { from: '2026-09-01T06:00:00.000Z', to: '2026-10-01T06:00:00.000Z' }, fetcher);
  for (const field of hubEligibilityFields()) assert.ok(masks[0].includes(field), field);
  assert.deepEqual([result.eligibleJobs, result.revenueSoldCents], [1, 50000], 'only the real job counts');
});

test('the bridge evidence scan fetches every eligibility field, so an internal job is never reported eligible', async () => {
  const approval = { customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', amount: 500 } };
  const stored = { real: { type: 'job', highlevelContactId: 'contact-a', ...approval }, internal: { type: 'job', highlevelContactId: 'contact-a', isInternal: true, internalReason: 'case_study', ...approval }, tested: { type: 'job', highlevelContactId: 'contact-a', isTest: true, ...approval } };
  const masks = [];
  const fetcher = async (_env, url) => {
    const mask = new URL(url).searchParams.getAll('mask.fieldPaths'); masks.push(mask);
    return Response.json({ documents: Object.entries(stored).map(([id, fields]) => ({ name: `projects/p/databases/(default)/documents/jobs/${id}`, updateTime: '2026-09-20T00:00:00.000000Z', fields: encodeFirestoreFields(Object.fromEntries(Object.entries(fields).filter(([key]) => mask.includes(key)))) })) });
  };
  const evidence = await portalEvidence({}, { contactProviderIds: ['contact-a'] }, fetcher);
  for (const field of hubEligibilityFields()) assert.ok(masks[0].includes(field), field);
  assert.deepEqual(evidence.records.map(record => [record.id, record.financials.eligible]), [['internal', false], ['real', true]], 'test jobs stay out of evidence; the internal job is reported but never eligible');
  const revenue = await portalRevenue({}, { from: '2026-09-01T06:00:00.000Z', to: '2026-10-01T06:00:00.000Z' }, fetcher);
  assert.equal(revenue.eligibleJobs, 1, 'the bridge and the Hub revenue scan agree');
});

// The pre-FUN-01 M3 rule, kept verbatim as the oracle.
const legacyMoneyJob = job => Boolean(job) && typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(job.id) && !/^(secure_|_egc_)/.test(job.id) && !job.recordType && !['walkthrough', 'blocked', 'availability'].includes(job.type);

test('the M3 moneyJob gate adopts the shared private-record rule without changing which jobs it manages', () => {
  const types = ['job', 'cleanout', 'walkthrough', 'blocked', 'availability', undefined];
  const ids = ['job-1', '_egc_money_op', 'secure_x', 'bad id', '', undefined, 7];
  const flags = [{}, { recordType: 'schedule_lock' }, { recordType: '' }, { isTest: true }, { test: true }, { isInternal: true, internalReason: 'case_study' }, { recordType: 'employee_hub_v2', isTest: true }];
  let compared = 0;
  for (const type of types) for (const id of ids) for (const flag of flags) { const job = { type, id, ...flag }; assert.equal(moneyJob(job), legacyMoneyJob(job), JSON.stringify(job)); compared += 1; }
  assert.equal(compared, types.length * ids.length * flags.length);
  for (const value of [null, undefined, 0, '']) assert.equal(moneyJob(value), false);
  assert.equal(moneyJob({ id: 'job-t', type: 'job', isTest: true }), true, 'test and internal jobs stay manageable in the money API');
});
