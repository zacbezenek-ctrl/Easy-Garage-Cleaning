import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { funnelDefinitions, funnelPathFor, funnelServiceLine, validateFunnelDefinitions, dimensionRulesVersion } from '../functions/_lib/funnel-definitions.js';
import { CATALOG_CATEGORIES } from '../functions/_lib/catalog.js';
import { DIMENSION_FIELDS, bookingDimensionPrefill, bookingDimensions, dimensionPicks, eventDimensions, firstPlacementDimensions, ghlGarageHelpRequested, ghlServiceLineSuggestion, legacyDimensionFacts, lineItemCatalogCategories, pendingProjectDimensions, projectDimensionBuckets, projectDimensionPatch, resolveDimensions, seedCatalogCategory, visitDimensionFacts } from '../functions/_lib/funnel-dimensions.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { dispatchFunnelOptions } from '../functions/_lib/dispatch-funnel.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { mutatePortalRecord } from '../functions/_lib/operations-job-records.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { createBusinessHandler } from '../functions/_lib/business-hub-service.js';
import { funnelDimensionsHandlers } from '../functions/api/funnel-dimensions.js';
import { JOB_FIELDS, parseArgs, planProjectDimensionBackfill, runProjectDimensionBackfill } from '../scripts/backfill-project-dimensions.mjs';

// FUN-29: service line and funnel path on every project. Fixed clocks and
// in-memory stores only; synthetic records.
const NOW = '2026-09-22T12:00:00.000Z'; // 06:00 Denver
const owner = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const ROSTER = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }];
const conflict = () => Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
const fail = (reason, message, status = 400) => Object.assign(new Error(message), { code: reason, status });

// Create-only writes without a revision, compare-and-set with one, all or
// nothing, a new revision per write and one entry per commit.
function memory(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, { revision: `${key}-r0`, ...structuredClone(value), id: key.split('/')[1] }]));
  let n = 0;
  const list = prefix => [...rows].filter(([key]) => key.startsWith(`${prefix}/`)).map(([, value]) => structuredClone(value));
  const store = {
    rows, commits: [], before: null, reads: [],
    jobs: async () => list('jobs'), resources: async () => list('dispatchResources'), roster: async () => structuredClone(ROSTER),
    customers: async provider => provider === undefined ? list('customers') : list('customers').filter(row => row.highlevelContactId === provider),
    day: async date => list('jobs').filter(row => row.date === date), projects: async () => list('projects'),
    jobRecords: async fields => { assert.ok(Array.isArray(fields) && fields.length); return list('jobs'); },
    read: async (collection, id) => { store.reads.push(`${collection}/${id}`); return structuredClone(rows.get(`${collection}/${id}`) || null); },
    async commit(writes) {
      store.before?.(writes);
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
      store.commits.push(keys);
    },
  };
  store.events = type => list('funnelEvents').filter(event => !type || event.type === type);
  return store;
}
const customers = { 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', address: '100 Synthetic Lane', highlevelContactId: 'contactA' } };
const create = (extra = {}, changes = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', jobInstructions: 'Synthetic scope', ...changes }, ...extra });
const job = (store, id) => store.rows.get(`jobs/${id}`);
const project = (store, id) => store.rows.get(`projects/${job(store, id).projectId}`);
const dims = row => [row.serviceLine, row.serviceLineSource, row.funnelPath, row.funnelPathSource];

test('the derivation rules are versioned definitions, and every catalog category maps to a service line', () => {
  const definitions = funnelDefinitions();
  assert.equal(dimensionRulesVersion(), 1);
  assert.deepEqual([...definitions.serviceLineSources.precedence], ['explicit', 'visitPurpose', 'businessAccount', 'catalogCategory', 'relatedProject', 'ghlGarageHelpRequested', 'salesExitService', 'legacyJobType']);
  assert.deepEqual([...definitions.funnelPathSources.precedence], ['explicit', 'visitPurpose', 'bookingChannel', 'recurringSeries', 'businessAccount', 'walkthrough', 'repeat']);
  // A new catalog category must get a service line in the definitions before it can be sold.
  assert.deepEqual(Object.keys(definitions.serviceLineSources.catalogCategory).sort(), [...CATALOG_CATEGORIES].sort());
  const broken = [
    [d => { d.funnelPathSources.precedence.push('horoscope'); }, /funnelPathSources.precedence must list known sources once/],
    [d => { d.funnelPathSources.bookingChannel.fax = 'rebook'; }, /funnelPathSources.bookingChannel maps an unknown value/],
    [d => { d.funnelPathSources.visitPurpose.member_visit = 'unknown'; }, /funnelPathSources.visitPurpose maps an unknown value or to an unknown path/],
    [d => { d.funnelPathSources.walkthrough = 'door_to_door'; }, /funnelPathSources.walkthrough must be a funnel path/],
    [d => { delete d.funnelPathSources.recurringSeries; }, /funnelPathSources.recurringSeries must be a funnel path/],
    [d => { d.serviceLineSources.catalogCategory.shelving = 'unknown'; }, /catalogCategory maps to an unknown service line/, 'a source can never decide the unknown bucket'],
    [d => { d.serviceLineSources.relatedProject = 'copy'; }, /relatedProject must be inherit/],
    [d => { d.dimensionRulesVersion = 0; }, /dimensionRulesVersion must be a positive integer/],
    [d => { delete d.dimensionRulesVersion; }, /dimensionRulesVersion must be a positive integer/],
  ];
  for (const [mutate, message] of broken) { const copy = structuredClone(definitions); mutate(copy); assert.match(validateFunnelDefinitions(copy).join('\n'), message); }
});

test('the path resolver follows its precedence, lists decide only when they agree, and undecided is null', () => {
  assert.deepEqual(funnelPathFor({}), { funnelPath: null, source: null });
  assert.deepEqual(funnelPathFor(null), { funnelPath: null, source: null });
  assert.deepEqual(funnelPathFor({ walkthrough: true, repeat: true }), { funnelPath: 'walkthrough', source: 'walkthrough' });
  assert.deepEqual(funnelPathFor({ repeat: true }), { funnelPath: 'rebook', source: 'repeat' });
  assert.deepEqual(funnelPathFor({ bookingChannel: 'recurring_plan', repeat: true, walkthrough: true }), { funnelPath: 'recurring', source: 'bookingChannel' });
  assert.deepEqual(funnelPathFor({ recurringSeries: true, businessAccountId: 'acct1' }), { funnelPath: 'recurring', source: 'recurringSeries' });
  assert.deepEqual(funnelPathFor({ businessAccountId: 'acct1', walkthrough: true }), { funnelPath: 'b2b_request', source: 'businessAccount' });
  assert.deepEqual(funnelPathFor({ visitPurpose: 'member_visit', bookingChannel: 'recurring_plan' }), { funnelPath: 'member_visit', source: 'visitPurpose' });
  assert.deepEqual(funnelPathFor({ explicit: 'remote_photo_video_quote', walkthrough: true }), { funnelPath: 'remote_photo_video_quote', source: 'explicit' }, 'a staff pick wins');
  assert.deepEqual(funnelPathFor({ explicit: 'unknown', bookingChannel: 'hub_phone' }), { funnelPath: null, source: null }, 'there is no unknown path, and a phone booking alone decides nothing');
  assert.equal(funnelPathFor({ walkthrough: 'yes', repeat: 1, businessAccountId: '_egc_forged' }).funnelPath, null, 'only true booleans and real Hub ids count');
  assert.deepEqual(funnelPathFor({ bookingChannel: ['hub_phone', 'recurring_plan'] }), { funnelPath: 'recurring', source: 'bookingChannel' }, 'a channel the rules do not know is neutral');
  assert.equal(funnelPathFor({ bookingChannel: ['recurring_plan', 'b2b_hub'] }).source, null, 'channels that disagree decide nothing');
  // Service-line lists: catalog categories, service names and legacy types decide only when they agree.
  assert.deepEqual(funnelServiceLine({ catalogCategories: ['shelving', 'services'], ghlGarageHelpRequested: 'Item Removal Only' }), { serviceLine: 'garage_transformation', source: 'catalogCategory' }, 'sold catalog lines beat the lead form');
  assert.deepEqual(funnelServiceLine({ catalogCategories: ['shelving', 'mystery'] }).source, 'catalogCategory');
  assert.deepEqual(funnelServiceLine({ salesExitService: ['garage', 'junk'], legacyJobType: ['job', 'cleanout'] }), { serviceLine: 'garage_transformation', source: 'legacyJobType' });
  assert.deepEqual(funnelServiceLine({ relatedProjectServiceLine: 'junk_removal', salesExitService: 'garage' }), { serviceLine: 'junk_removal', source: 'relatedProject' });
  assert.equal(funnelServiceLine({ relatedProjectServiceLine: 'unknown' }).source, null, 'an earlier "not sure" is not evidence');
});

test('picks are validated, a pick wins, undecided stays null and "Not sure yet" is the explicit unknown bucket', () => {
  assert.deepEqual(dimensionPicks(undefined, fail), { serviceLine: null, funnelPath: null });
  assert.deepEqual(dimensionPicks({ serviceLine: 'junk_removal', funnelPath: '' }, fail), { serviceLine: 'junk_removal', funnelPath: null });
  for (const bad of [{ serviceLine: 'lawn_care' }, { funnelPath: 'unknown' }, { serviceLine: ['junk_removal'] }, { funnelPath: 'toString' }]) assert.throws(() => dimensionPicks(bad, fail), error => error.code === 'booking_invalid');
  // An untouched lead-form suggestion is not a staff pick: it is the ghlGarageHelpRequested fact.
  assert.deepEqual(dimensionPicks({ serviceLine: 'junk_removal', serviceLineSuggested: true, funnelPath: 'walkthrough' }, fail), { serviceLine: null, funnelPath: 'walkthrough', serviceLineSuggestion: 'junk_removal' });
  assert.deepEqual(dimensionPicks({ serviceLine: 'junk_removal', serviceLineSuggested: false }, fail), { serviceLine: 'junk_removal', funnelPath: null });
  for (const bad of [{ serviceLine: 'commercial_b2b', serviceLineSuggested: true }, { serviceLine: 'unknown', serviceLineSuggested: true }, { serviceLineSuggested: true }, { serviceLine: 'junk_removal', serviceLineSuggested: 'true' }]) assert.throws(() => dimensionPicks(bad, fail), error => error.code === 'booking_invalid', 'only a value the lead form can give is a suggestion');
  assert.deepEqual(resolveDimensions({ salesExitService: 'garage' }, { serviceLineSuggestion: 'junk_removal' }).serviceLineSource, 'ghlGarageHelpRequested');
  assert.deepEqual(resolveDimensions({ catalogCategories: ['shelving'] }, { serviceLineSuggestion: 'junk_removal' }).serviceLineSource, 'catalogCategory', 'sold catalog lines outrank a suggestion');
  assert.deepEqual(resolveDimensions({}, { serviceLineSuggestion: 'commercial_b2b' }).serviceLine, null, 'a value the lead form never gives is no suggestion');
  assert.deepEqual(resolveDimensions({}), { serviceLine: null, serviceLineSource: null, funnelPath: null, funnelPathSource: null });
  assert.deepEqual(resolveDimensions({}, { serviceLine: 'unknown' }), { serviceLine: 'unknown', serviceLineSource: 'explicit', funnelPath: null, funnelPathSource: null });
  assert.deepEqual(resolveDimensions({ legacyJobType: 'cleanout' }, { serviceLine: 'unknown' }).serviceLineSource, 'legacyJobType', 'records decide before a "not sure" pick');
  assert.deepEqual(resolveDimensions({ walkthrough: true, salesExitService: 'junk' }, { serviceLine: 'commercial_b2b', funnelPath: 'rebook' }), { serviceLine: 'commercial_b2b', serviceLineSource: 'explicit', funnelPath: 'rebook', funnelPathSource: 'explicit' });
  assert.deepEqual(projectDimensionBuckets({}), { serviceLine: 'unknown', funnelPath: 'unknown' });
  assert.deepEqual(projectDimensionBuckets({ serviceLine: 'unknown', funnelPath: 'lawn' }), { serviceLine: 'unknown', funnelPath: 'unknown' });
  assert.deepEqual(projectDimensionBuckets({ serviceLine: 'junk_removal', funnelPath: 'rebook' }), { serviceLine: 'junk_removal', funnelPath: 'rebook' });
  assert.deepEqual(eventDimensions({ serviceLine: 'unknown', funnelPath: null }), { serviceLine: 'unknown' });
  assert.deepEqual(eventDimensions({ serviceLine: 'lawn_care', funnelPath: 'walkthrough' }), { funnelPath: 'walkthrough' });
  assert.deepEqual(DIMENSION_FIELDS, ['serviceLine', 'serviceLineSource', 'funnelPath', 'funnelPathSource', 'dimensionRulesVersion', 'dimensionsUpdatedAt', 'dimensionsUpdatedBy']);
});

test('an existing project changes only on better evidence', () => {
  const stamp = { actor: 'zacb', now: NOW }, r = (serviceLine, serviceLineSource, funnelPath = null, funnelPathSource = null) => ({ serviceLine, serviceLineSource, funnelPath, funnelPathSource });
  const full = projectDimensionPatch(null, r('junk_removal', 'explicit', 'walkthrough', 'walkthrough'), stamp);
  assert.deepEqual(full, { serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough', dimensionRulesVersion: 1, dimensionsUpdatedAt: NOW, dimensionsUpdatedBy: 'zacb' });
  assert.deepEqual(projectDimensionPatch(null, r(null, null), stamp), { serviceLine: null, serviceLineSource: null, funnelPath: null, funnelPathSource: null, dimensionRulesVersion: 1, dimensionsUpdatedAt: NOW, dimensionsUpdatedBy: 'zacb' }, 'undecided is recorded as null, never guessed');
  const cases = [
    [{}, r('garage_transformation', 'legacyJobType'), { serviceLine: 'garage_transformation', serviceLineSource: 'legacyJobType' }, 'a legacy project without values takes any decided one'],
    [{ serviceLine: 'unknown', serviceLineSource: 'explicit' }, r('junk_removal', 'salesExitService'), { serviceLine: 'junk_removal', serviceLineSource: 'salesExitService' }, '"not sure" takes a decided value'],
    [{ serviceLine: null }, r('unknown', 'explicit'), { serviceLine: 'unknown', serviceLineSource: 'explicit' }, 'a "not sure" pick is recorded on an undecided project'],
    [{ serviceLine: 'junk_removal', serviceLineSource: 'salesExitService' }, r('unknown', 'explicit'), null, '"not sure" never replaces a decided value'],
    [{ serviceLine: 'junk_removal', serviceLineSource: 'explicit' }, r('garage_transformation', 'catalogCategory'), null, 'nothing but a pick replaces a pick'],
    [{ serviceLine: 'junk_removal', serviceLineSource: 'explicit' }, r('garage_transformation', 'explicit'), { serviceLine: 'garage_transformation', serviceLineSource: 'explicit' }, 'a newer pick replaces a pick'],
    [{ serviceLine: 'garage_transformation', serviceLineSource: 'legacyJobType' }, r('junk_removal', 'salesExitService'), { serviceLine: 'junk_removal', serviceLineSource: 'salesExitService' }, 'a higher source replaces a lower one'],
    [{ serviceLine: 'junk_removal', serviceLineSource: 'salesExitService' }, r('garage_transformation', 'legacyJobType'), null, 'a lower source never replaces a higher one'],
    [{ serviceLine: 'junk_removal', serviceLineSource: 'salesExitService' }, r('junk_removal', 'catalogCategory'), null, 'the same value is not rewritten'],
    [{ serviceLine: 'garage_transformation', serviceLineSource: 'hand_edit' }, r('junk_removal', 'legacyJobType'), { serviceLine: 'junk_removal', serviceLineSource: 'legacyJobType' }, 'a source the rules do not know ranks below every rule'],
    [{ serviceLine: 'garage_transformation', serviceLineSource: 'hand_edit' }, r('unknown', 'explicit'), null, 'but it is still a decided value that "not sure" never replaces'],
    [{ serviceLine: 'lawn_care', serviceLineSource: 'explicit' }, r('junk_removal', 'legacyJobType'), { serviceLine: 'junk_removal', serviceLineSource: 'legacyJobType' }, 'a value the rules no longer know is undecided'],
    [{ funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' }, r(null, null, 'b2b_request', 'businessAccount'), { funnelPath: 'b2b_request', funnelPathSource: 'businessAccount' }, 'the path follows the same rule'],
    [{ funnelPath: 'rebook', funnelPathSource: 'explicit' }, r(null, null, 'walkthrough', 'walkthrough'), null, 'a picked path stays'],
  ];
  for (const [stored, resolved, expected, message] of cases) {
    const patch = projectDimensionPatch(stored, resolved, stamp);
    assert.deepEqual(patch && Object.fromEntries(Object.entries(patch).filter(([key]) => !['dimensionRulesVersion', 'dimensionsUpdatedAt', 'dimensionsUpdatedBy'].includes(key))), expected, message);
    if (patch) assert.deepEqual([patch.dimensionRulesVersion, patch.dimensionsUpdatedAt, patch.dimensionsUpdatedBy], [1, NOW, 'zacb']);
  }
});

test('visit facts read only real evidence: a walkthrough name is not a service, catalog lines count only when sold', () => {
  const walk = visitDimensionFacts({ type: 'walkthrough', serviceType: 'Free garage walkthrough', bookingChannel: 'ghl_self_booking' });
  assert.deepEqual([walk.salesExitService, walk.walkthrough, walk.repeat, walk.recurringSeries], ['', true, false, false]);
  assert.deepEqual(resolveDimensions(walk), { serviceLine: null, serviceLineSource: null, funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' });
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job', serviceType: 'Junk removal and haul away' })).serviceLine, 'junk_removal');
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job', recurrence: 'monthly' })).funnelPath, 'recurring', 'a legacy cadence is a recurring series');
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job', recurrence: 'none' })).funnelPath, null);
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job', sourceTemplateJobId: 'template-1' })).funnelPath, 'rebook');
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job', sourceTemplateJobId: 'template-1', bookingChannel: 'recurring_plan' })).funnelPath, 'recurring');
  assert.equal(resolveDimensions(visitDimensionFacts({ type: 'job' }, { walkthroughSale: true })).funnelPath, 'walkthrough');
  assert.equal(seedCatalogCategory('shelving-muscle-rack-48x24x72-5tier-black'), 'shelving');
  assert.equal(seedCatalogCategory('svc-deep-clean-2car'), 'services');
  assert.equal(seedCatalogCategory('not-in-the-seed'), null);
  const lines = [
    { id: 'rack', kind: 'product', name: 'Rack', quantity: 1, unitCents: 10000, totalCents: 10000, catalog: { itemId: 'shelving-muscle-rack-48x24x72-5tier-black', version: 1 } },
    { id: 'clean', kind: 'service', name: 'Deep clean', quantity: 1, unitCents: 22000, totalCents: 22000, catalog: { itemId: 'svc-deep-clean-2car', version: 1 } },
    { id: 'bike', kind: 'product', name: 'Bike hook', quantity: 1, unitCents: 500, totalCents: 500, optional: true, selected: false, catalog: { itemId: 'bike-hook-everbilt-screw-in-25lb', version: 1 } },
    { id: 'haul', kind: 'disposal', name: 'Haul away', quantity: 1, unitCents: 9000, totalCents: 9000 },
  ];
  assert.deepEqual(lineItemCatalogCategories(lines), ['services', 'shelving'], 'an unchosen option is not sold evidence; uncatalogued lines add nothing');
  assert.deepEqual(lineItemCatalogCategories('nope'), []);
  assert.deepEqual(lineItemCatalogCategories(lines, id => id === 'svc-deep-clean-2car' ? 'services' : null), ['services'], 'the category lookup is injectable');
  assert.deepEqual(resolveDimensions(visitDimensionFacts({ type: 'job', serviceType: 'Junk removal', estimate: { lineItems: lines } })).serviceLineSource, 'catalogCategory');
});

test('the legacy mapping (FUN-04, backfill) combines a project\'s visits under the same rules', () => {
  const walkthrough = { id: 'w1', type: 'walkthrough', serviceType: 'Free garage walkthrough' }, job = { id: 'j1', type: 'job', serviceType: 'Garage organization', sourceWalkthroughId: 'w1' };
  assert.deepEqual(resolveDimensions(legacyDimensionFacts({ sourceWalkthroughId: 'w1' }, [walkthrough, job])), { serviceLine: 'garage_transformation', serviceLineSource: 'salesExitService', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' });
  assert.deepEqual(resolveDimensions(legacyDimensionFacts({}, [{ id: 'j2', type: 'job', serviceType: 'Junk pickup' }, { id: 'j3', type: 'job', serviceType: 'Garage reset' }])).serviceLine, null, 'visits that disagree decide nothing');
  assert.equal(resolveDimensions(legacyDimensionFacts({}, [{ id: 'j2', type: 'cleanout' }, { id: 'j3', type: 'job' }])).serviceLineSource, 'legacyJobType');
  assert.deepEqual(resolveDimensions(legacyDimensionFacts({}, [{ id: 'j4', type: 'job', businessAccountId: 'acct1' }, { id: 'j5', type: 'job', businessAccountId: 'acct2' }])).serviceLine, null, 'two business accounts decide nothing');
  assert.deepEqual(resolveDimensions(legacyDimensionFacts({ previousProjectId: 'p0' }, [{ id: 'j6', type: 'job' }], { related: { id: 'p0', serviceLine: 'junk_removal' } })), { serviceLine: 'junk_removal', serviceLineSource: 'relatedProject', funnelPath: 'rebook', funnelPathSource: 'repeat' });
  assert.equal(resolveDimensions(legacyDimensionFacts({}, [{ id: 'j7', type: 'job', recurringPlanId: 'plan1', bookingChannel: 'hub_phone' }])).funnelPath, 'recurring');
  assert.equal(resolveDimensions(legacyDimensionFacts({}, [{ id: 'j8', type: 'job', visitPurpose: 'member_visit' }, { id: 'j9', type: 'job' }])).serviceLine, 'garage_guard_visit');
  assert.deepEqual(resolveDimensions(legacyDimensionFacts(null, 'nope')), { serviceLine: null, serviceLineSource: null, funnelPath: null, funnelPathSource: null });
});

test('a dispatch walkthrough booking records the staff pick and the walkthrough path on its new project and booking event', async () => {
  const store = memory(customers), input = create({ kind: 'walkthrough', booking: { channel: 'hub_phone', serviceLine: 'junk_removal' } }, { serviceType: 'Free garage walkthrough' });
  const { job: saved } = await mutateDispatch(store, owner, input, NOW), row = project(store, saved.id);
  assert.deepEqual(dims(row), ['junk_removal', 'explicit', 'walkthrough', 'walkthrough']);
  assert.deepEqual([row.dimensionRulesVersion, row.dimensionsUpdatedAt, row.dimensionsUpdatedBy], [1, NOW, 'zacb']);
  const [booked] = store.events('walkthrough.booked');
  assert.deepEqual(booked.data, { channel: 'hub_phone', occurrence: 1, visitPurpose: 'walkthrough', serviceLine: 'junk_removal', funnelPath: 'walkthrough' });
  assert.ok(store.commits.at(-1).includes(`projects/${row.id}`) && store.commits.at(-1).includes(`funnelEvents/${booked.id}`), 'the project and its booking event commit with the visit');
  assert.equal(job(store, saved.id).serviceLine, undefined, 'the dimensions live on the project, not a copy on the visit');
  // A replay is the same booking and writes nothing more.
  const commits = store.commits.length;
  assert.equal((await mutateDispatch(store, owner, input, NOW)).replayed, true);
  assert.equal(store.commits.length, commits);
  await assert.rejects(mutateDispatch(store, owner, create({ booking: { serviceLine: 'lawn_care' } }), NOW), error => error.code === 'dispatch_booking_invalid' && error.status === 400);
  await assert.rejects(mutateDispatch(store, owner, create({ booking: { funnelPath: 'unknown' } }), NOW), error => error.code === 'dispatch_booking_invalid');
});

test('a direct job with nothing on file stays undecided, and its service name or the picks decide it', async () => {
  const store = memory(customers);
  const plain = await mutateDispatch(store, owner, create({ booking: { channel: 'hub_phone' } }, { serviceType: 'Customer job' }), NOW);
  assert.deepEqual(dims(project(store, plain.job.id)), [null, null, null, null], 'unknown stays null');
  assert.deepEqual(store.events('job.scheduled')[0].data, { channel: 'hub_phone', occurrence: 1, visitPurpose: 'service' });
  const named = await mutateDispatch(store, owner, create({ booking: { channel: 'hub_phone', funnelPath: 'remote_photo_video_quote' } }, { date: '2026-09-24', serviceType: 'Junk removal' }), NOW);
  assert.deepEqual(dims(project(store, named.job.id)), ['junk_removal', 'salesExitService', 'remote_photo_video_quote', 'explicit']);
  const scheduled = store.events('job.scheduled').find(event => event.jobId === named.job.id);
  assert.deepEqual([scheduled.data.serviceLine, scheduled.data.funnelPath], ['junk_removal', 'remote_photo_video_quote']);
  const unsure = await mutateDispatch(store, owner, create({ booking: { channel: 'hub_phone', serviceLine: 'unknown', funnelPath: 'direct_phone_booking' } }, { date: '2026-09-25' }), NOW);
  assert.deepEqual(dims(project(store, unsure.job.id)), ['unknown', 'explicit', 'direct_phone_booking', 'explicit']);
});

test('a job from a walkthrough refines the walkthrough\'s project in the same commit under its revision, and never replaces a pick', async () => {
  const seed = { ...customers,
    'jobs/w1': { type: 'walkthrough', customerId: 'c1', date: '2026-09-20', time: '09:00', endTime: '10:00', status: 'completed', pipelineStatus: 'completed', projectId: 'p1' }, 'projects/p1': { customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' },
    'jobs/w2': { type: 'walkthrough', customerId: 'c1', date: '2026-09-20', time: '11:00', endTime: '12:00', status: 'completed', pipelineStatus: 'completed', projectId: 'p2' }, 'projects/p2': { customerId: 'c1', sourceRecordId: 'w2', sourceWalkthroughId: 'w2', serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' } };
  const store = memory(seed);
  const first = await mutateDispatch(store, owner, create({ sourceWalkthroughId: 'w1', booking: { channel: 'hub_phone' } }, { serviceType: 'Garage organization' }), NOW);
  assert.equal(job(store, first.job.id).projectId, 'p1');
  assert.deepEqual(dims(store.rows.get('projects/p1')), ['garage_transformation', 'salesExitService', 'walkthrough', 'walkthrough']);
  assert.ok(store.commits.at(-1).includes('projects/p1'));
  assert.deepEqual([store.events('job.scheduled')[0].data.serviceLine, store.events('job.scheduled')[0].data.funnelPath], ['garage_transformation', 'walkthrough']);
  const before = store.rows.get('projects/p2').revision;
  await mutateDispatch(store, owner, create({ sourceWalkthroughId: 'w2', booking: { channel: 'hub_phone' } }, { date: '2026-09-24', serviceType: 'Garage organization' }), NOW);
  assert.equal(store.rows.get('projects/p2').revision, before, 'a derived value never replaces the pick made at the walkthrough booking');
  assert.equal(store.rows.get('projects/p2').serviceLine, 'junk_removal');
  // A project saved between the read and the commit aborts the whole booking.
  const racing = memory(seed); racing.before = writes => { if (writes.some(write => write.collection === 'projects')) racing.rows.get('projects/p1').revision = 'concurrent'; };
  await assert.rejects(mutateDispatch(racing, owner, create({ sourceWalkthroughId: 'w1', booking: { channel: 'hub_phone' } }, { serviceType: 'Garage organization' }), NOW), error => error.code === 'dispatch_revision_conflict');
  assert.equal(racing.events().length, 0); assert.equal([...racing.rows.keys()].filter(key => key.startsWith('jobs/visit_') || key.startsWith('jobs/dispatch_')).length, 0, 'nothing was saved');
});

test('a recurring occurrence is on the recurring path and inherits the service line of the project it repeats', async () => {
  const store = memory({ ...customers, 'jobs/t1': { type: 'job', customerId: 'c1', date: '2026-09-15', time: '08:00', endTime: '10:00', status: 'completed', pipelineStatus: 'completed', projectId: 'p0', serviceType: 'Monthly tidy' }, 'projects/p0': { customerId: 'c1', serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'direct_phone_booking', funnelPathSource: 'explicit' } });
  const result = await mutateDispatch(store, owner, create({ sourceTemplateJobId: 't1', booking: { channel: 'recurring_plan' } }), NOW), row = project(store, result.job.id);
  assert.notEqual(row.id, 'p0'); assert.equal(row.previousProjectId, 'p0');
  assert.deepEqual(dims(row), ['junk_removal', 'relatedProject', 'recurring', 'bookingChannel']);
  const repeat = await mutateDispatch(store, owner, create({ sourceTemplateJobId: 't1', booking: { channel: 'hub_phone' } }, { date: '2026-09-24' }), NOW);
  assert.deepEqual(dims(project(store, repeat.job.id)).slice(2), ['rebook', 'repeat']);
});

test('an unscheduled visit placed later books with its project\'s values', async () => {
  const store = memory(customers);
  const created = await mutateDispatch(store, owner, create({ kind: 'walkthrough', booking: { channel: 'hub_phone', serviceLine: 'garage_transformation' } }, { date: '', time: '', endTime: '' }), NOW);
  assert.equal(store.events('walkthrough.booked').length, 0);
  const saved = job(store, created.job.id);
  await mutateDispatch(store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: saved.id, expectedRevision: saved.revision, changes: { date: '2026-09-24', time: '09:00', endDate: '2026-09-24', endTime: '10:00' } }, NOW);
  assert.deepEqual(store.events('walkthrough.booked')[0].data, { channel: 'hub_phone', occurrence: 1, visitPurpose: 'walkthrough', serviceLine: 'garage_transformation', funnelPath: 'walkthrough' });
  // Later moves read no project and carry no dimensions.
  const placed = job(store, saved.id), reads = store.reads.length;
  await mutateDispatch(store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: placed.id, expectedRevision: placed.revision, reasonCode: 'weather', initiatedBy: 'company', changes: { time: '11:00', endTime: '12:00' } }, NOW);
  assert.equal(store.reads.slice(reads).filter(key => key.startsWith('projects/')).length, 0);
  assert.equal(await firstPlacementDimensions(store, null, placed), null);
  assert.equal(await firstPlacementDimensions(store, { type: 'job', date: '', time: '', endTime: '' }, { type: 'job', date: '2026-09-24', time: '09:00', endTime: '10:00', projectId: '_egc_private' }), null);
});

test('the bridge scheduler, project ensure and adoption paths set values on the projects they create', async () => {
  const actor = { id: 'mcp-oauth-grant:synthetic-1', kind: 'integration', role: 'integration', workspace: 'egc' };
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', highlevelContactId: 'contactA' } });
  const input = extra => ({ command: 'schedule.mutate', requestId: randomUUID(), mode: 'create', portalCustomerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-23', time: '10:00', endTime: '11:00' }, ...extra });
  const walk = await mutateScheduledVisit(store, actor, input(), NOW), walkProject = store.rows.get(`projects/${walk.visit.portalProjectId}`);
  assert.deepEqual(dims(walkProject), [null, null, 'walkthrough', 'walkthrough']);
  assert.equal(walkProject.dimensionsUpdatedBy, actor.id);
  assert.equal(store.events('walkthrough.booked')[0].data.funnelPath, 'walkthrough');
  const jobVisit = await mutateScheduledVisit(store, actor, input({ kind: 'job', changes: { date: '2026-09-24', time: '10:00', endTime: '11:00' } }), NOW);
  assert.deepEqual(dims(store.rows.get(`projects/${jobVisit.visit.portalProjectId}`)), [null, null, null, null], 'an MCP job booking decides nothing by itself');
  // A bridge update that first places a visit saved unscheduled books it with its project's values, as dispatch does.
  const draft = await mutateDispatch(store, owner, create({ kind: 'walkthrough', booking: { channel: 'hub_phone', serviceLine: 'garage_transformation' } }, { date: '', time: '', endTime: '' }), NOW), unplaced = job(store, draft.job.id);
  const place = (visit, changes) => mutateScheduledVisit(store, actor, { command: 'schedule.mutate', requestId: randomUUID(), mode: 'update', portalCustomerId: 'c1', portalVisitId: visit.id, expectedRevision: visit.revision, changes }, NOW);
  await place(unplaced, { date: '2026-09-25', time: '09:00', endTime: '10:00' });
  const firstBooked = store.events('walkthrough.booked').find(event => event.walkthroughId === unplaced.id);
  assert.deepEqual([firstBooked.data.serviceLine, firstBooked.data.funnelPath, firstBooked.data.occurrence], ['garage_transformation', 'walkthrough', 1]);
  const reads = store.reads.length;
  await place(job(store, unplaced.id), { time: '11:00', endTime: '12:00' });
  assert.equal(store.reads.slice(reads).filter(key => key.startsWith('projects/')).length, 0, 'a later move reads no project');
  // portal.project.ensure on existing records uses the legacy mapping.
  const rows = memory({ 'customers/customer-a': {}, 'jobs/visit-a': { type: 'walkthrough', customerId: 'customer-a' }, 'jobs/job-a': { type: 'job', customerId: 'customer-a', sourceWalkthroughId: 'visit-a', serviceType: 'Junk haul', status: 'scheduled' } });
  await mutatePortalRecord(rows, { id: 'owner', role: 'owner', kind: 'human' }, { command: 'portal.project.ensure', requestId: randomUUID(), portalJobId: 'job-a', expectedRevision: rows.rows.get('jobs/job-a').revision });
  assert.deepEqual(dims(rows.rows.get('projects/project_visit-a')), ['junk_removal', 'salesExitService', 'walkthrough', 'walkthrough']);
});

// Walkthrough handoff: the plan mirrors tests/funnel-booking-events.test.mjs.
const HANDOFF_NOW = '2026-09-22T18:00:00.000Z';
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle' }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'Keep blue bicycle.', notes: 'Call before arrival', client_checklists: { preJob: [], postJob: [] } });
const handoffSeed = projectFields => ({ 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }, 'jobs/w1': { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' }, 'projects/p1': { customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1', ...projectFields } });

test('a signed handoff keeps the pick made at the walkthrough booking and records it on deal.sold; without a walkthrough it is still the walkthrough path', async () => {
  const store = memory(handoffSeed({ serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' })), before = store.rows.get('projects/p1').revision;
  await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: store.rows.get('jobs/w1').revision, plan: plan() }, HANDOFF_NOW);
  assert.equal(store.rows.get('projects/p1').revision, before, 'the fenced project is not rewritten');
  const [sold] = store.events('deal.sold');
  assert.deepEqual([sold.data.serviceLine, sold.data.funnelPath], ['junk_removal', 'walkthrough']);
  // No Hub walkthrough: the new project is still a walkthrough sale, and the gameplan's service name decides the line.
  const bare = memory(handoffSeed({}));
  const result = await saveWalkthroughHandoff(bare, owner, { requestId: randomUUID(), customerId: 'c1', plan: plan() }, HANDOFF_NOW);
  const created = bare.rows.get(`projects/${bare.rows.get(`jobs/${result.job.id}`).projectId}`);
  assert.deepEqual(dims(created), ['garage_transformation', 'salesExitService', 'walkthrough', 'walkthrough']);
  const [bareSold] = bare.events('deal.sold'), [scheduled] = bare.events('job.scheduled');
  assert.deepEqual([bareSold.data.serviceLine, bareSold.data.funnelPath, scheduled.data.funnelPath], ['garage_transformation', 'walkthrough', 'walkthrough']);
});

// $700 + $499 + $200 + $1 = $1,400; the declined totes option is not sold evidence.
const itemized = () => {
  const signed = plan(); signed.quote.catalog_version = '2026-09-pest200-traps250';
  signed.quote.line_items = [
    { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: '', quantity: 1, unitCents: 70000, totalCents: 70000 },
    { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 49900, totalCents: 49900, catalog: { itemId: 'shelving-muscle-rack-48x24x72-5tier-black', version: 1 } },
    { id: 'pest-waste', kind: 'service', name: 'Pest-waste cleanup', description: '', quantity: 1, unitCents: 20000, totalCents: 20000 },
    { id: 'totes', kind: 'product', name: 'Storage tote', description: '', quantity: 4, unitCents: 2150, totalCents: 8600, optional: true, selected: false, catalog: { itemId: 'small-items-tote-hdx-27gal-tough', version: 1 } },
    { id: 'adjustment', kind: 'fee', name: 'Price adjustment', description: 'Longer carry agreed on site', quantity: 1, unitCents: 100, totalCents: 100 },
  ];
  return signed;
};

test('an itemized handoff whose signed lines name catalog items records the line from the sold items', async () => {
  const store = memory(handoffSeed({}));
  await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: store.rows.get('jobs/w1').revision, plan: itemized() }, HANDOFF_NOW);
  assert.deepEqual(dims(store.rows.get('projects/p1')), ['garage_transformation', 'catalogCategory', 'walkthrough', 'walkthrough']);
  assert.deepEqual([store.events('deal.sold')[0].data.serviceLine, store.events('deal.sold')[0].data.funnelPath], ['garage_transformation', 'walkthrough']);
});

test('a lead-form suggestion booked untouched is refined by the sold catalog lines; a staff pick is not', async () => {
  const seed = { 'customers/c1': handoffSeed({})['customers/c1'] };
  for (const [booking, booked, sold] of [
    [{ channel: 'hub_phone', serviceLine: 'junk_removal', serviceLineSuggested: true }, ['junk_removal', 'ghlGarageHelpRequested'], ['garage_transformation', 'catalogCategory']],
    [{ channel: 'hub_phone', serviceLine: 'junk_removal' }, ['junk_removal', 'explicit'], ['junk_removal', 'explicit']],
  ]) {
    const store = memory(seed);
    const { job: walk } = await mutateDispatch(store, owner, create({ kind: 'walkthrough', booking }, { date: '2026-09-22', time: '11:00', endTime: '12:00', serviceType: 'Free garage walkthrough' }), NOW);
    assert.deepEqual(dims(project(store, walk.id)), [...booked, 'walkthrough', 'walkthrough']);
    assert.equal(store.events('walkthrough.booked')[0].data.serviceLine, 'junk_removal');
    await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walk.id, sourceRevision: job(store, walk.id).revision, plan: itemized() }, HANDOFF_NOW);
    assert.deepEqual(dims(project(store, walk.id)), [...sold, 'walkthrough', 'walkthrough'], booking.serviceLineSuggested ? 'sold evidence outranks the lead form' : 'nothing but a pick replaces a pick');
    assert.equal(store.events('deal.sold')[0].data.serviceLine, sold[0]);
  }
});

test('signed catalog lines are sold evidence for a project created or refined at booking', async () => {
  const store = memory({ 'projects/p9': { customerId: 'c1' } }), writes = [];
  const lines = [{ id: 'rack', kind: 'product', name: 'Rack', quantity: 1, unitCents: 10000, totalCents: 10000, catalog: { itemId: 'shelving-muscle-rack-48x24x72-5tier-black', version: 1 } }];
  const joined = await bookingDimensions(store, { visit: { id: 'j1', type: 'job', serviceType: 'Junk removal', projectId: 'p9' }, project: store.rows.get('projects/p9'), facts: { walkthroughSale: true, lineItems: lines }, actor: 'zacb', now: NOW, writes });
  assert.deepEqual(joined, { serviceLine: 'garage_transformation', funnelPath: 'walkthrough' });
  assert.deepEqual([writes[0].collection, writes[0].id, writes[0].revision, writes[0].patch.serviceLineSource, writes[0].patch.updatedAt], ['projects', 'p9', 'projects/p9-r0', 'catalogCategory', NOW]);
  assert.deepEqual(pendingProjectDimensions({ serviceLine: 'junk_removal' }, writes, 'p9'), { serviceLine: 'garage_transformation', funnelPath: 'walkthrough' });
  assert.deepEqual(pendingProjectDimensions({ serviceLine: 'junk_removal' }, writes, 'other'), { serviceLine: 'junk_removal' });
  const projectWrite = { collection: 'projects', id: 'p10', patch: { id: 'p10' } };
  assert.deepEqual(await bookingDimensions(store, { visit: { id: 'j2', type: 'job', projectId: 'p10' }, projectWrite, picks: { funnelPath: 'rebook' }, actor: 'zacb', now: NOW, writes }), { funnelPath: 'rebook' });
  assert.equal(projectWrite.patch.funnelPathSource, 'explicit'); assert.equal(writes.length, 1);
  assert.deepEqual(await bookingDimensions(store, { visit: { id: 'j3', type: 'job' }, actor: 'zacb', now: NOW, writes }), {}, 'no project, nothing to record');
});

// A minimal business hub harness (tests/business-hub.test.mjs has the full one).
class BusinessMemory {
  constructor() { this.records = new Map(); this.clock = 0; }
  async read(c, id) { return structuredClone(this.records.get(c + '/' + id) || null); }
  async commit(changes) {
    for (const w of changes) { const old = this.records.get(w.collection + '/' + w.id); if (w.version ? old?._version !== w.version : Boolean(old)) throw Object.assign(new Error('Conflict'), { status: 409, publicMessage: 'Conflict' }); }
    for (const w of changes) { const key = w.collection + '/' + w.id, old = this.records.get(key); this.records.set(key, { ...(w.patch ? old : {}), ...structuredClone(w.data), id: w.id, _version: String(++this.clock) }); }
  }
  async list() { return { accounts: [], next: '' }; }
  async jobs(ids) { return new Map((await Promise.all(ids.map(i => this.read('jobs', i)))).filter(Boolean).map(j => [j.id, j])); }
}
test('linking work to a business account makes its project commercial B2B on the B2B path unless a pick says otherwise', async () => {
  const origin = 'https://easygaragecleaning.com', store = new BusinessMemory(), clock = Date.UTC(2026, 8, 23, 18);
  const handler = createBusinessHandler({ store, getStaff: async () => ({ user: 'zacb', displayName: 'Zac', businessAccess: true, role: 'owner' }), finance: j => ({ total: j.total || 0, paid: 0, balance: j.total || 0 }), needsReview: () => false, projectCookie: async () => 'project=x', clearProjectCookie: () => 'project=; Max-Age=0', now: () => clock });
  const call = async (payload, url = '') => { const res = await handler(new Request(origin + '/api/business-hub' + url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-EGC-Business': '1' }, body: JSON.stringify(payload) })); return { status: res.status, data: await res.json() }; };
  const created = await call({ action: 'create_account', company: 'Synthetic Co', name: 'Admin', email: 'admin@example.invalid' }, '?staff=1'), staff = '?staff=1&account=' + created.data.accountId;
  const property = (await call({ action: 'save_property', name: 'Unit 1', address: '1 Synthetic Road' }, staff)).data.propertyId;
  await store.commit([{ collection: 'jobs', id: 'job_one', data: { type: 'job', total: 1000, projectId: 'p_one' } }, { collection: 'projects', id: 'p_one', data: { customerId: 'c1', serviceLine: 'garage_transformation', serviceLineSource: 'salesExitService', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' } },
    { collection: 'jobs', id: 'job_two', data: { type: 'job', total: 500, projectId: 'p_two' } }, { collection: 'projects', id: 'p_two', data: { customerId: 'c2', serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'rebook', funnelPathSource: 'explicit' } }]);
  assert.equal((await call({ action: 'link_project', propertyId: property, jobId: 'job_one', sharingAuthorized: true }, staff)).status, 200);
  const one = await store.read('projects', 'p_one');
  assert.deepEqual(dims(one), ['commercial_b2b', 'businessAccount', 'b2b_request', 'businessAccount']);
  assert.deepEqual([one.dimensionsUpdatedBy, one.dimensionRulesVersion], ['zacb', 1]);
  const two = await store.read('projects', 'p_two');
  assert.equal((await call({ action: 'link_project', propertyId: property, jobId: 'job_two', sharingAuthorized: true }, staff)).status, 200);
  assert.equal((await store.read('projects', 'p_two'))._version, two._version, 'staff picks stay');
});

const session = async () => owner;
const request = query => new Request(`https://easygaragecleaning.com/api/funnel-dimensions?${query}`);
const prefillStore = () => memory({ ...customers, 'customers/c2': { name: 'Synthetic Unlinked' },
  'jobs/j1': { type: 'job', customerId: 'c1', projectId: 'p1', date: '2026-09-10', time: '08:00', endTime: '10:00', status: 'completed' }, 'projects/p1': { customerId: 'c1', serviceLine: 'garage_transformation', serviceLineSource: 'explicit', funnelPath: 'direct_phone_booking', funnelPathSource: 'explicit' },
  'jobs/j2': { type: 'job', customerId: 'c1', projectId: 'p2', status: 'completed' }, 'projects/p2': { customerId: 'c1', serviceLine: 'unknown', serviceLineSource: 'explicit' } });

test('the booking pre-fill shows what the create would record and asks for the tap only when nothing decides', async () => {
  const store = prefillStore(), ghlCalls = [], handlers = funnelDimensionsHandlers({ session, storage: () => store, ghl: async (env, id) => { ghlCalls.push(id); return { status: 'ok', value: 'junk_removal' }; }, now: () => new Date(NOW) });
  const get = async query => { const response = await handlers.get({ request: request(query), env: {} }); return { status: response.status, body: await response.json(), headers: response.headers }; };
  const walk = await get('customerId=c1&kind=walkthrough&channel=hub_phone');
  assert.equal(walk.status, 200); assert.equal(walk.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([walk.body.serviceLine, walk.body.funnelPath, walk.body.projectId, walk.body.rulesVersion], [{ value: null, source: null, required: true, suggestion: 'junk_removal' }, { value: 'walkthrough', source: 'walkthrough', required: false }, null, 1]);
  assert.deepEqual(ghlCalls, ['contactA'], 'the GHL suggestion is asked only when nothing on file decides the line');
  const named = await get('customerId=c1&kind=job&channel=hub_phone&serviceType=' + encodeURIComponent('Junk removal'));
  assert.deepEqual([named.body.serviceLine, named.body.funnelPath], [{ value: 'junk_removal', source: 'salesExitService', required: false, suggestion: null }, { value: null, source: null, required: true }]);
  assert.equal(ghlCalls.length, 1);
  const rework = await get('customerId=c1&kind=job&visitPurpose=rework&reworkOfJobId=j1');
  assert.deepEqual([rework.body.projectId, rework.body.serviceLine.value, rework.body.serviceLine.source, rework.body.funnelPath.value, rework.body.funnelPath.required], ['p1', 'garage_transformation', 'explicit', 'direct_phone_booking', false], 'a rework shows the project it joins');
  const unsure = await get('customerId=c1&kind=job&visitPurpose=rework&reworkOfJobId=j2');
  assert.deepEqual([unsure.body.serviceLine.value, unsure.body.serviceLine.required], ['unknown', true], '"Not sure yet" is asked again');
  // A form that already holds this customer's answer skips the GHL read.
  const asked = ghlCalls.length, skipped = await get('customerId=c1&kind=walkthrough&channel=hub_phone&suggest=false');
  assert.deepEqual([skipped.body.serviceLine, skipped.body.ghl, ghlCalls.length], [{ value: null, source: null, required: true, suggestion: null }, 'skipped', asked]);
  assert.equal((await get('customerId=c1&kind=job&serviceType=Junk&suggest=false')).body.ghl, 'not_needed', 'a decided line needs no suggestion either way');
  const other = await get('customerId=c2&kind=job&visitPurpose=rework&reworkOfJobId=j1');
  assert.equal(other.body.projectId, null, 'another customer\'s job is never joined');
  assert.equal(other.body.ghl, 'not_needed', 'a customer without a CRM contact is never looked up');
  for (const [query, status, code] of [['customerId=c1&kind=job&extra=1', 400, 'funnel_dimensions_query_invalid'], ['customerId=c1&kind=job&suggest=true', 400, 'funnel_dimensions_query_invalid'], ['customerId=c1&customerId=c2&kind=job', 400, 'funnel_dimensions_query_invalid'], ['customerId=c1&kind=blocked', 400, 'funnel_dimensions_query_invalid'], ['customerId=_egc_x&kind=job', 400, 'funnel_dimensions_query_invalid'], ['customerId=missing&kind=job', 404, 'funnel_dimensions_customer_not_found']]) {
    const response = await get(query); assert.deepEqual([response.status, response.body.ok, response.body.code], [status, false, code], query);
  }
  const signedOut = funnelDimensionsHandlers({ session: async () => null, storage: () => store, now: () => new Date(NOW) });
  assert.equal((await signedOut.get({ request: request('customerId=c1&kind=job'), env: {} })).status, 401);
  const crew = funnelDimensionsHandlers({ session: async () => ({ user: 'crew1', role: 'crew', businessAccess: false }), storage: () => store, now: () => new Date(NOW) });
  assert.equal((await crew.get({ request: request('customerId=c1&kind=job'), env: {} })).status, 403);
  const broken = funnelDimensionsHandlers({ session, storage: () => ({ read: async () => { throw new Error('boom'); } }), now: () => new Date(NOW) });
  const failed = await broken.get({ request: request('customerId=c1&kind=job'), env: {} });
  assert.deepEqual([failed.status, (await failed.json()).code], [503, 'funnel_dimensions_unavailable']);
  // The pre-fill agrees with what the create records for the same facts.
  const fresh = memory(customers), created = await mutateDispatch(fresh, owner, create({ booking: { channel: 'hub_phone', funnelPath: 'direct_phone_booking' } }, { date: '2026-09-26', serviceType: 'Junk removal' }), NOW);
  assert.deepEqual(dims(project(fresh, created.job.id)).slice(0, 2), [named.body.serviceLine.value, named.body.serviceLine.source]);
  assert.deepEqual(dispatchFunnelOptions().serviceLines, ['garage_transformation', 'junk_removal', 'garage_guard_visit', 'commercial_b2b', 'unknown']);
  assert.deepEqual(dispatchFunnelOptions().funnelPaths, ['walkthrough', 'remote_photo_video_quote', 'direct_phone_booking', 'b2b_request', 'rebook', 'member_visit', 'recurring']);
  assert.equal((await bookingDimensionPrefill(store, { customerId: 'c1', kind: 'job' }, { now: NOW })).ghl, 'not_needed', 'no lookup is wired by default in the lib');
});

test('the GHL field suggestion is off unless the flag is exactly true, verified against the location, and never an error', async () => {
  const contact = value => ({ contact: { id: 'contactA', locationId: 'loc1', customFields: [{ id: 'other', value: 'Full Garage Transformation' }, { id: 'eeVNj4ay4uwJGgP6pzrq', value } ] } });
  const calls = [], fetcher = body => async (url, init) => { calls.push([url, init.headers.Authorization, init.headers.Version]); return new Response(JSON.stringify(body), { status: 200 }); };
  const env = { FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED: 'true', HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'loc1' };
  for (const flag of [undefined, '', 'TRUE', '1', 'yes']) assert.deepEqual(await ghlServiceLineSuggestion({ ...env, FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED: flag }, 'contactA', fetcher(contact('Item Removal Only'))), { status: 'disabled', value: null });
  assert.equal(calls.length, 0);
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', fetcher(contact('Item Removal Only'))), { status: 'ok', value: 'junk_removal' });
  assert.deepEqual(calls[0], ['https://services.leadconnectorhq.com/contacts/contactA', 'Bearer synthetic-ghl-key', 'v3']);
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', fetcher(contact(' full garage transformation '))), { status: 'ok', value: 'garage_transformation' });
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', fetcher(contact('Something else'))), { status: 'ok', value: null });
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', fetcher({ contact: { ...contact('Item Removal Only').contact, locationId: 'elsewhere' } })), { status: 'unavailable', value: null }, 'another location is never trusted');
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', async () => { throw new Error('timeout'); }), { status: 'unavailable', value: null });
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'contactA', async () => new Response('{}', { status: 500 })), { status: 'unavailable', value: null });
  assert.deepEqual(await ghlServiceLineSuggestion({ ...env, HIGHLEVEL_API_KEY: '' }, 'contactA', fetcher(contact('Item Removal Only'))), { status: 'unavailable', value: null });
  assert.deepEqual(await ghlServiceLineSuggestion(env, 'bad id/../x', fetcher(contact('Item Removal Only'))), { status: 'unavailable', value: null });
  assert.equal(ghlGarageHelpRequested({ customFields: [{ id: 'eeVNj4ay4uwJGgP6pzrq', field_value: 'Item Removal Only' }] }), 'Item Removal Only');
  assert.equal(ghlGarageHelpRequested({ customFields: 'nope' }), null);
  assert.equal(ghlGarageHelpRequested(null), null);
});

const backfillSeed = () => ({
  'projects/p_walk': { customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' },
  'projects/p_repeat': { customerId: 'c1', sourceRecordId: 'j3', previousProjectId: 'p_walk' },
  'projects/p_unsure': { customerId: 'c1', sourceRecordId: 'j4', serviceLine: 'unknown', serviceLineSource: 'explicit' },
  'projects/p_done': { customerId: 'c1', serviceLine: 'junk_removal', serviceLineSource: 'explicit', funnelPath: 'rebook', funnelPathSource: 'explicit' },
  'projects/p_empty': { customerId: 'c1', sourceRecordId: 'gone' },
  'projects/_egc_private': { customerId: 'c1' },
  'jobs/w1': { type: 'walkthrough', customerId: 'c1', serviceType: 'Free garage walkthrough' },
  'jobs/j1': { type: 'cleanout', customerId: 'c1', projectId: 'p_walk', sourceWalkthroughId: 'w1' },
  'jobs/j3': { type: 'job', customerId: 'c1', projectId: 'p_repeat', serviceType: 'Customer job' },
  'jobs/j4': { type: 'job', customerId: 'c1', projectId: 'p_unsure', recurrence: 'monthly' },
  'jobs/_egc_schedule_lock_2026-09-22': { recordType: 'schedule_lock', projectId: 'p_walk', type: 'job' },
});

test('the backfill is a dry run by default and fills only missing values, with preconditions and receipts', async () => {
  assert.ok(JOB_FIELDS.includes('projectId') && JOB_FIELDS.includes('estimate.lineItems') && !JOB_FIELDS.includes('estimate'), 'a masked scan');
  const store = memory(backfillSeed()), snapshot = JSON.stringify([...store.rows]);
  const dry = await runProjectDimensionBackfill(store, { now: NOW, runId: 'run-1' });
  assert.equal(JSON.stringify([...store.rows]), snapshot, 'a dry run writes nothing'); assert.equal(store.commits.length, 0);
  assert.equal(dry.mode, 'dry_run');
  assert.deepEqual(dry.preview, [
    { id: 'p_repeat', serviceLine: 'garage_transformation', serviceLineSource: 'relatedProject', funnelPath: 'rebook', funnelPathSource: 'repeat' },
    { id: 'p_unsure', funnelPath: 'recurring', funnelPathSource: 'recurringSeries' },
    { id: 'p_walk', serviceLine: 'garage_transformation', serviceLineSource: 'legacyJobType', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' },
  ], 'a repeat inherits the line its previous project gets in the same run; "Not sure yet" is kept');
  assert.deepEqual([dry.projects.scanned, dry.projects.skippedRecords, dry.projects.complete, dry.projects.noVisits, dry.projects.undecided.serviceLine, dry.projects.undecided.funnelPath], [6, 1, 1, { count: 1, ids: ['p_empty'] }, { count: 1, ids: ['p_empty'] }, { count: 1, ids: ['p_empty'] }]);
  assert.deepEqual(dry.projects.decided, { serviceLine: { relatedProject: 1, legacyJobType: 1 }, funnelPath: { repeat: 1, recurringSeries: 1, walkthrough: 1 } });
  // Apply: one project is saved meanwhile and is skipped, never overwritten.
  store.before = writes => { if (writes.length > 2 && writes.some(write => write.id === 'p_repeat')) store.rows.get('projects/p_repeat').revision = 'saved-meanwhile'; };
  const applied = await runProjectDimensionBackfill(store, { apply: true, now: NOW, runId: 'run-2' });
  assert.deepEqual([applied.writes.planned, applied.writes.committed, applied.writes.changedDuringRun], [3, 2, ['p_repeat']]);
  assert.deepEqual(dims(store.rows.get('projects/p_walk')), ['garage_transformation', 'legacyJobType', 'walkthrough', 'walkthrough']);
  assert.deepEqual([store.rows.get('projects/p_walk').dimensionsUpdatedBy, store.rows.get('projects/p_walk').dimensionRulesVersion], ['project-dimensions-backfill', 1]);
  assert.deepEqual(dims(store.rows.get('projects/p_unsure')), ['unknown', 'explicit', 'recurring', 'recurringSeries']);
  assert.equal(store.rows.get('projects/p_repeat').serviceLine, undefined);
  const receipts = applied.writes.receipts.map(id => store.rows.get(`dispatchOperations/${id}`));
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.flatMap(receipt => receipt.targets.map(target => target.id)).sort(), ['p_unsure', 'p_walk']);
  const walkTarget = receipts.flatMap(receipt => receipt.targets).find(target => target.id === 'p_walk');
  assert.deepEqual(walkTarget.before, { serviceLine: null, serviceLineSource: null, funnelPath: null, funnelPathSource: null });
  assert.deepEqual(walkTarget.after, { serviceLine: 'garage_transformation', serviceLineSource: 'legacyJobType', funnelPath: 'walkthrough', funnelPathSource: 'walkthrough' });
  assert.deepEqual([receipts[0].scope, receipts[0].actorId, receipts[0].runId], ['project_dimensions_backfill', 'project-dimensions-backfill', 'run-2']);
  // A rerun fills the skipped project and is otherwise a no-op.
  store.before = null;
  const rerun = await runProjectDimensionBackfill(store, { apply: true, now: NOW, runId: 'run-3' });
  assert.deepEqual([rerun.writes.planned, rerun.writes.committed], [1, 1]);
  assert.deepEqual(dims(store.rows.get('projects/p_repeat')), ['garage_transformation', 'relatedProject', 'rebook', 'repeat']);
  assert.equal((await runProjectDimensionBackfill(store, { apply: true, now: NOW, runId: 'run-4' })).writes.planned, 0);
  assert.deepEqual(store.rows.get('projects/p_done').serviceLine, 'junk_removal');
});

test('the backfill aborts cleanly on storage failure and refuses bad input and arguments', async () => {
  const store = memory(backfillSeed());
  store.commit = async () => { throw Object.assign(new Error('lost'), { code: 'dispatch_outcome_unknown' }); };
  const aborted = await runProjectDimensionBackfill(store, { apply: true, now: NOW, runId: 'run-x' });
  assert.equal(aborted.aborted.code, 'dispatch_outcome_unknown'); assert.equal(aborted.writes.committed, 0);
  assert.throws(() => planProjectDimensionBackfill(null, [], { now: NOW }), error => error.code === 'project_dimensions_backfill_input_invalid');
  assert.throws(() => planProjectDimensionBackfill([], [], { now: 'yesterday' }), error => error.code === 'project_dimensions_backfill_input_invalid');
  await assert.rejects(runProjectDimensionBackfill({ read: async () => null }, { now: NOW }), error => error.code === 'project_dimensions_backfill_store_invalid');
  assert.deepEqual(parseArgs([]), { apply: false, report: '', help: false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply: true, report: 'out.json', help: false });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--force']), /Unknown/);
});
