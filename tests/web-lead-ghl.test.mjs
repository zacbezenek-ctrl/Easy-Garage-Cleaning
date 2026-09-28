import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost, syncHighLevelLead, normalizeService, valueFor, deriveLeadSource, deriveChannel, serviceArea, leadTags, staleStateTags, WORKFLOW_TRIGGER_TAGS } from '../functions/api/web-lead.js';

// All HighLevel and hook traffic is intercepted; nothing leaves the process.
const ENV = { HIGHLEVEL_API_KEY: 'test-key', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_PIPELINE_ID: 'pipe-1', HIGHLEVEL_NEW_LEAD_STAGE_ID: 'stage-new', HIGHLEVEL_USER_ID: 'user-1' };
const HOOK = 'https://hooks.example.test/lead';
const FIELD = { leadProduct: '4yHT0EBBt4nYxeZT6M6D', leadSource: 'IVtks5sLi8Xi79B81kze', campaign: 'IKhn620CwInVv30h04Gm', helpWith: 'zdiv0Kh93i1s8UiOyhS9', oppGclid: '6QIVCGxYtFx3lrEaj6CM', oppLeadSource: '9bLDZpTKoBch8Xk3OFPu', oppUtmSource: 'xOENZM7WDXoH8ViivIYL', oppUtmCampaign: '43RqKb4zAt1c4IUolFXS' };

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function withHighLevel({ contact = { id: 'c1' }, isNew, opportunities = [], fail = () => 0 } = {}, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
    calls.push(call);
    const status = fail(call);
    // HighLevel error bodies can echo the matching contact — it must never reach the logs.
    if (status) return reply({ statusCode: status, message: 'Rejected by test', meta: { contactName: 'Secret Person', phone: '+19705550111' } }, status);
    if (call.url.startsWith(HOOK)) return new Response('ok', { status: 200 });
    if (call.url.endsWith('/contacts/upsert')) return reply({ contact, ...(isNew === undefined ? {} : { new: isNew }) });
    if (call.url.includes('/opportunities/search?')) return reply({ opportunities, meta: { total: opportunities.length } });
    if (call.url.endsWith('/opportunities/upsert')) return reply({ opportunity: { id: 'opp-new' }, new: true });
    return reply({});
  };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

async function quietErrors(run) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
  try { return { value: await run(), logged }; } finally { console.error = original; }
}

function post(body, env = { ...ENV, WEBSITE_LEAD_HOOK_URL: HOOK }) {
  const request = new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return onRequestPost({ request, env });
}

const lpLead = (extra = {}) => ({ name: 'Pat Lead', phone: '9705550111', serviceZip: '80525', service_type: 'Hot tub', preferred_timing: 'Soonest available', items: 'Hot tub — Soonest available', source: 'google-junk-lp', page_service: 'hot-tub', page_variant: 'hot-tub', in_service_area: 'yes', request_id: 'rid-1', sms_consent: 'yes', gclid: 'gclid-123', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'junk-fort-collins', page_url: 'https://easygaragecleaning.com/junk-removal-quote?v=hot-tub&gclid=gclid-123', ...extra });
const tagCalls = (calls, contactId = 'c1') => calls.filter(call => call.url.endsWith(`/contacts/${contactId}/tags`));
const addedTags = calls => tagCalls(calls).filter(call => call.method === 'POST').flatMap(call => call.body.tags);
const contactFieldPut = (calls, contactId = 'c1') => calls.find(call => call.method === 'PUT' && call.url.endsWith(`/contacts/${contactId}`) && call.body.customFields);
const fieldValue = (fields, id) => (fields.find(field => field.id === id) || {}).field_value;

test('normalizeService maps landing-page, form and page-path values to fixed service slugs', () => {
  const cases = [
    [{ service_type: 'Garage Cleanout' }, 'garage-cleanout', 'garage', 'Garage Cleanout'],
    [{ items: 'Need a garage cleaning before we move' }, 'garage-cleaning', 'garage', 'Garage Cleanout'],
    [{ items: 'garage clean-out, then garage cleaning' }, 'garage-cleanout', 'garage', 'Garage Cleanout'],
    [{ what_to_remove: 'Our realtor wants the house cleared before listing' }, 'commercial', 'junk', 'Junk Pickup'],
    [{ items: 'Real estate listing prep' }, 'commercial', 'junk', 'Junk Pickup'],
    [{ what_to_remove: "Dad's estate — whole house" }, 'estate', 'junk', 'Junk Pickup'],
    [{ service_type: 'Hot tub' }, 'hot-tub', 'junk', 'Junk Pickup'],
    [{ service_type: 'Single item' }, 'single-item', 'junk', 'Junk Pickup'],
    [{ service_type: 'Single item', page_service: 'couch' }, 'furniture', 'junk', 'Junk Pickup'],
    [{ service_type: 'A few items' }, 'few-items', 'junk', 'Junk Pickup'],
    [{ service_type: 'Partial load' }, 'partial-load', 'junk', 'Junk Pickup'],
    [{ service_type: 'Garage or full cleanout' }, 'garage-cleanout', 'garage', 'Garage Cleanout'],
    // The Google Ads landing page is junk removal only: a garage haul there is a junk job.
    [{ service_type: 'Garage or full cleanout', source: 'google-junk-lp' }, 'garage-cleanout', 'junk', 'Junk Pickup'],
    [{ service_type: 'Not sure', page_service: 'garage-cleanout', page_url: 'https://easygaragecleaning.com/junk-removal-quote?v=garage' }, 'garage-cleanout', 'junk', 'Junk Pickup'],
    // The Meta /ads page names its service with a hidden page_service field.
    [{ source: 'Ads Landing Page', page_service: 'garage-cleanout', subject: '🔥 LEAD - Easy Garage Cleaning Ads Page', page_url: 'https://easygaragecleaning.com/ads' }, 'garage-cleanout', 'garage', 'Garage Cleanout'],
    [{ service_type: 'Not sure', page_service: 'hot-tub' }, 'hot-tub', 'junk', 'Junk Pickup'],
    [{ service_type: 'Not sure', page_service: 'junk' }, 'other', 'junk', 'Junk Pickup'],
    [{ service_type: 'Junk Removal', page_url: 'https://easygaragecleaning.com/couch-removal-fort-collins-co' }, 'furniture', 'junk', 'Junk Pickup'],
    [{ page_url: 'https://easygaragecleaning.com/refrigerator-removal-fort-collins-co' }, 'fridge-freon', 'junk', 'Junk Pickup'],
    [{ service_type: 'Junk Removal', job_size: 'Half a garage or room' }, 'partial-load', 'junk', 'Junk Pickup'],
    [{ service_type: 'Storage Unit Cleanout' }, 'storage', 'junk', 'Junk Pickup'],
    [{ service_type: 'Garage Organization' }, 'garage-org', 'garage', 'Garage Cleanout'],
    [{ subject: 'LEAD - Easy Garage Cleaning Ads Page' }, 'other', 'junk', 'Junk Pickup'],
    [{}, 'other', 'junk', 'Junk Pickup'],
  ];
  for (const [lead, slug, line, leadProduct] of cases) {
    const service = normalizeService(lead);
    assert.deepEqual([service.slug, service.line, service.leadProduct], [slug, line, leadProduct], JSON.stringify(lead));
    assert.ok(service.label);
  }
});

test('valueFor uses the range the lead saw, else the published service default', () => {
  assert.equal(valueFor({ estimated_range: '$400–$650' }), 525);
  assert.equal(valueFor({ job_size: 'A few items ($250-$400)' }), 325);
  assert.equal(valueFor({ items: 'Large garage / estate ($650+)' }), 800);
  assert.equal(valueFor({ job_size: 'Medium garage', estimated_range: '$99–$150' }), 125);
  assert.equal(valueFor({ service_type: 'Hot tub' }), 600);
  assert.equal(valueFor({ service_type: 'Single item', page_service: 'mattress' }), 125);
  assert.equal(valueFor({ service_type: 'Partial load' }), 325);
  assert.equal(valueFor({ service_type: 'Garage Cleanout' }), 525);
  assert.equal(valueFor({ service_type: 'Garage Organization' }), 650);
  assert.equal(valueFor({ what_to_remove: 'old shed' }), 400);
  assert.equal(valueFor({ service_type: 'Not sure' }), 250);
});

test('lead source and channel derivation follows click IDs, UTMs, then referrer', () => {
  const cases = [
    [{ gclid: 'g' }, 'google-ads', 'Google Paid'],
    [{ gbraid: 'b' }, 'google-ads', 'Google Paid'],
    [{ wbraid: 'w' }, 'google-ads', 'Google Paid'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'google-ads', 'Google Paid'],
    [{ utm_source: 'google', utm_medium: 'organic' }, 'google-organic', 'Google Organic'],
    [{ fbclid: 'f' }, 'meta-ads', 'Facebook Paid'],
    [{ utm_source: 'instagram', utm_medium: 'paid' }, 'meta-ads', 'Facebook Paid'],
    [{ utm_source: 'facebook', utm_medium: 'social' }, 'meta-organic', 'Facebook Organic'],
    [{ utm_source: 'nextdoor' }, 'nextdoor', 'Nextdoor'],
    [{ utm_source: 'gbp' }, 'gbp', 'Google Business Profile'],
    [{ utm_source: 'google', utm_medium: 'gbp' }, 'gbp', 'Google Business Profile'],
    [{ referrer: 'https://www.google.com/' }, 'google-organic', 'Google Organic'],
    [{ referrer: 'https://easygaragecleaning.com/pricing' }, 'direct', ''],
    [{}, 'direct', ''],
  ];
  for (const [lead, key, label] of cases) assert.deepEqual(deriveLeadSource(lead), { key, label }, JSON.stringify(lead));
  assert.equal(deriveChannel({ source: 'google-junk-lp' }), 'gads-lp');
  assert.equal(deriveChannel({ source: 'Ads Landing Page', page_url: 'https://easygaragecleaning.com/ads' }), 'meta-lp');
  assert.equal(deriveChannel({ source: 'Website', flow_type: 'walkthrough', page_url: 'https://easygaragecleaning.com/book' }), 'book');
  assert.equal(deriveChannel({ source: 'Website', page_url: 'https://easygaragecleaning.com/' }), 'web');
  assert.deepEqual(serviceArea({ serviceZip: '80546' }), { zip: '80546', status: 'yes', outOfArea: false });
  assert.deepEqual(serviceArea({ serviceZip: '80634', in_service_area: 'yes' }), { zip: '80634', status: 'no', outOfArea: true });
  assert.deepEqual(serviceArea({ in_service_area: 'no' }), { zip: '', status: 'no', outOfArea: true });
  assert.deepEqual(serviceArea({}), { zip: '', status: 'unknown', outOfArea: false });
});

test('a Google Ads junk lead lands as Google Paid with its GCLID, value and identity tags', async () => {
  await withHighLevel({ isNew: true }, async calls => {
    const response = await post(lpLead());
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.highlevel.synced, true);
    assert.equal(result.highlevel.tagsSynced, true);
    assert.equal(result.relay.sent, true);

    const upsert = calls.find(call => call.url.endsWith('/contacts/upsert')).body;
    assert.equal(upsert.postalCode, '80525');
    assert.equal('source' in upsert || 'assignedTo' in upsert, false);

    const identity = calls.find(call => call.method === 'PUT' && call.url.endsWith('/contacts/c1') && !call.body.customFields);
    assert.deepEqual(identity.body, { source: 'google-junk-lp', assignedTo: 'user-1' }, 'a new contact gets its first-touch source and owner');

    const tags = addedTags(calls);
    for (const tag of ['egc-website-lead', 'egc-sms-consent', 'egc-svc-junk', 'egc-src-google-ads', 'egc-ch-gads-lp', 'egc-item-hot-tub']) assert.ok(tags.includes(tag), `${tag} missing`);
    assert.equal(tags.includes('egc-out-of-area'), false);
    assert.equal(tags.some(tag => WORKFLOW_TRIGGER_TAGS.has(tag)), false, 'no workflow trigger tag is ever added');

    const fields = contactFieldPut(calls).body.customFields;
    assert.equal(fieldValue(fields, FIELD.leadProduct), 'Junk Pickup');
    assert.equal(fieldValue(fields, FIELD.leadSource), 'Google Paid');
    assert.equal(fieldValue(fields, FIELD.campaign), 'junk-fort-collins');
    assert.equal(fieldValue(fields, FIELD.helpWith), 'Hot tub — Soonest available');
    assert.ok(fields.every(field => Object.keys(field).join() === 'id,field_value'));

    const note = calls.find(call => call.url.endsWith('/contacts/c1/notes')).body.body;
    for (const line of ['Service (normalized): Hot tub removal (hot-tub · junk)', 'Estimated value: $600', 'In service area: yes', 'gclid gclid-123', 'Lead source: Google Paid · channel gads-lp', 'variant hot-tub']) assert.ok(note.includes(line), `${line} missing from note`);

    const opportunity = calls.find(call => call.url.endsWith('/opportunities/upsert')).body;
    assert.equal(opportunity.monetaryValue, 600);
    assert.equal(opportunity.source, 'Google Paid');
    assert.equal(opportunity.pipelineStageId, 'stage-new');
    const oppFields = calls.find(call => call.method === 'PUT' && call.url.endsWith('/opportunities/opp-new')).body.customFields;
    assert.equal(fieldValue(oppFields, FIELD.oppGclid), 'gclid-123');
    assert.equal(fieldValue(oppFields, FIELD.oppLeadSource), 'Google Paid');
    assert.equal(fieldValue(oppFields, FIELD.oppUtmSource), 'google');
    assert.equal(fieldValue(oppFields, FIELD.oppUtmCampaign), 'junk-fort-collins');

    const hook = calls.find(call => call.url.startsWith(HOOK));
    assert.equal(hook.body.page_service, 'hot-tub');
    assert.equal(hook.body.in_service_area, 'yes');
  });
});

test('gbraid / wbraid clicks fill the opportunity GCLID field with a labelled ID', async () => {
  await withHighLevel({ isNew: true }, async calls => {
    await syncHighLevelLead(ENV, lpLead({ gclid: '', gbraid: 'gb-9', utm_source: '', utm_medium: '', utm_campaign: '' }));
    const oppFields = calls.find(call => call.method === 'PUT' && call.url.endsWith('/opportunities/opp-new')).body.customFields;
    assert.equal(fieldValue(oppFields, FIELD.oppGclid), 'gbraid:gb-9');
    assert.equal(fieldValue(oppFields, FIELD.oppUtmSource), undefined);
  });
});

test('an open opportunity already past New Lead is not pulled back by a repeat inquiry', async () => {
  const opportunities = [{ id: 'opp-scheduled', contactId: 'c1', pipelineId: 'pipe-1', pipelineStageId: 'stage-job-scheduled', status: 'open' }];
  await withHighLevel({ opportunities }, async calls => {
    const result = await syncHighLevelLead(ENV, lpLead());
    assert.equal(result.repeatInquiry, true);
    assert.equal(result.opportunityId, 'opp-scheduled');
    assert.equal(calls.some(call => call.url.endsWith('/opportunities/upsert')), false);
    assert.equal(calls.some(call => call.url.includes('/opportunities/opp-scheduled')), false);
    assert.ok(addedTags(calls).includes('egc-repeat-inquiry'));
  });
  // Still in New Lead: the normal upsert refreshes it.
  await withHighLevel({ opportunities: [{ ...opportunities[0], id: 'opp-fresh', pipelineStageId: 'stage-new' }] }, async calls => {
    const result = await syncHighLevelLead(ENV, lpLead());
    assert.equal(result.repeatInquiry, undefined);
    assert.equal(calls.filter(call => call.url.endsWith('/opportunities/upsert')).length, 1);
  });
  // A completed (won) job is never reopened; a lost one is revived as a new lead.
  await withHighLevel({ opportunities: [{ ...opportunities[0], id: 'opp-won', pipelineStageId: 'stage-complete', status: 'won' }] }, async calls => {
    const result = await syncHighLevelLead(ENV, lpLead());
    assert.equal(result.repeatInquiry, true);
    assert.equal(calls.some(call => call.url.endsWith('/opportunities/upsert')), false);
  });
  await withHighLevel({ opportunities: [{ ...opportunities[0], id: 'opp-lost', pipelineStageId: 'stage-quoted', status: 'lost' }] }, async calls => {
    const result = await syncHighLevelLead(ENV, lpLead());
    assert.equal(result.repeatInquiry, undefined);
    assert.equal(calls.filter(call => call.url.endsWith('/opportunities/upsert')).length, 1);
  });
  // A search that ignored the contact filter proves nothing either way: both
  // spellings are tried, then a person decides instead of an upsert.
  await withHighLevel({ opportunities: [{ ...opportunities[0], contactId: 'someone-else' }] }, async calls => {
    const { value: result } = await quietErrors(() => syncHighLevelLead(ENV, lpLead()));
    assert.equal(calls.filter(call => call.url.includes('/opportunities/search?')).length, 2);
    assert.equal(calls.some(call => call.url.endsWith('/opportunities/upsert')), false);
    assert.equal(result.needsTriage, true);
    assert.ok(addedTags(calls).includes('egc-needs-triage'));
    assert.equal(addedTags(calls).includes('egc-repeat-inquiry'), false);
  });
});

test('the repeat-inquiry tag rides in the same request as the workflow tags, and stale state tags go first', async () => {
  const opportunities = [{ id: 'opp-quoted', contactId: 'c1', pipelineId: 'pipe-1', pipelineStageId: 'stage-quoted', status: 'open' }];
  await withHighLevel({ contact: { id: 'c1', tags: [] }, opportunities }, async calls => {
    await syncHighLevelLead(ENV, lpLead());
    const posts = tagCalls(calls).filter(call => call.method === 'POST');
    assert.equal(posts.length, 1, 'one tag write carries every tag');
    for (const tag of ['egc-website-lead', 'egc-ch-gads-lp', 'egc-repeat-inquiry']) assert.ok(posts[0].body.tags.includes(tag), tag);
    const search = calls.findIndex(call => call.url.includes('/opportunities/search?'));
    assert.ok(search >= 0 && search < calls.indexOf(posts[0]), 'the pipeline is read before any tag lands');
    const params = new URL(calls[search].url).searchParams;
    assert.deepEqual([params.get('location_id'), params.get('contact_id'), params.get('pipeline_id'), params.get('status')], ['location-1', 'c1', 'pipe-1', 'all']);
    assert.equal(tagCalls(calls).some(call => call.method === 'DELETE'), false, 'nothing stale to remove');
  });
  // In area, no conflicting opportunity, not an applicant: old state tags are removed before the add.
  const stale = { id: 'c1', tags: ['egc-out-of-area', 'egc-repeat-inquiry', 'egc-needs-triage', 'egc-sms-consent'] };
  await withHighLevel({ contact: stale, isNew: false }, async calls => {
    await syncHighLevelLead(ENV, lpLead());
    const [removed, added] = [tagCalls(calls).find(call => call.method === 'DELETE'), tagCalls(calls).find(call => call.method === 'POST')];
    assert.deepEqual(removed.body.tags, ['egc-out-of-area', 'egc-repeat-inquiry', 'egc-needs-triage']);
    assert.ok(calls.indexOf(removed) < calls.indexOf(added));
    for (const tag of removed.body.tags) assert.equal(added.body.tags.includes(tag), false, tag);
  });
  // Unknown ZIP or no pipeline check: the state tags stay.
  assert.deepEqual(staleStateTags({ contactTags: stale.tags, area: { status: 'unknown' }, searched: false }), []);
  assert.deepEqual(staleStateTags({ contactTags: null, area: { status: 'yes' }, searched: true }), ['egc-out-of-area', 'egc-repeat-inquiry']);
});

test('a contact who declines texts loses the old consent tag before any new tag lands', async () => {
  await withHighLevel({ contact: { id: 'c1', tags: ['egc-sms-consent', 'egc-website-lead'] }, isNew: false }, async calls => {
    await syncHighLevelLead(ENV, lpLead({ sms_consent: '' }));
    const tags = tagCalls(calls);
    assert.equal(tags[0].method, 'DELETE');
    assert.deepEqual(tags[0].body.tags, ['egc-sms-consent']);
    assert.equal(tags[1].method, 'POST');
    assert.ok(tags[1].body.tags.includes('egc-no-sms-consent'));
    assert.equal(tags[1].body.tags.includes('egc-sms-consent'), false);
  });
});

test('Client Hub help never denies or strips SMS consent, and a failed sync is reported as a failure', async () => {
  const hubLead = { name: 'Dana Customer', phone: '9705550142', items: 'Need a new link', what_to_remove: 'Need a new link', source: 'Client Hub Help', flow_type: 'client_hub_help', sms_consent: 'no', request_id: 'hub-1' };
  await withHighLevel({ contact: { id: 'c1', tags: ['egc-sms-consent'] } }, async calls => {
    const response = await post(hubLead);
    assert.equal(response.status, 200);
    assert.deepEqual(addedTags(calls), ['egc-client-hub-help']);
    assert.equal(tagCalls(calls).some(call => call.method === 'DELETE'), false, 'an unchecked per-request box is not a consent opt-out');
  });
  const down = call => call.url.startsWith('https://services.leadconnectorhq.com') ? 503 : 0;
  await withHighLevel({ fail: down }, async calls => {
    const { value: response } = await quietErrors(() => post({ ...hubLead, sms_consent: 'yes' }));
    assert.equal(response.status, 502, 'the hub must not claim the team can see it in HighLevel');
    assert.equal(calls.some(call => call.url.startsWith(HOOK)), false, 'nothing is texted, so a retry cannot double-text');
  });
});

test('job applicants who submit a quote form get triage instead of an opportunity', async () => {
  await withHighLevel({ contact: { id: 'c1', tags: ['applicant-crew', 'egc-website-lead'] }, isNew: false }, async calls => {
    const result = await syncHighLevelLead(ENV, lpLead());
    assert.equal(result.needsTriage, true);
    assert.ok(addedTags(calls).includes('egc-needs-triage'));
    assert.equal(calls.some(call => call.url.includes('/opportunities/')), false);
  });
});

test('Lead Source, contact source and owner are first-touch only', async () => {
  const existing = { id: 'c1', source: 'Facebook Lead Form', assignedTo: 'user-9', tags: ['egc-sms-consent'], customFields: [{ id: FIELD.leadSource, value: 'Facebook Paid' }] };
  await withHighLevel({ contact: existing, isNew: false }, async calls => {
    await syncHighLevelLead(ENV, lpLead());
    const upsert = calls.find(call => call.url.endsWith('/contacts/upsert')).body;
    assert.equal('source' in upsert || 'assignedTo' in upsert, false);
    assert.equal(calls.some(call => call.method === 'PUT' && call.url.endsWith('/contacts/c1') && ('source' in call.body || 'assignedTo' in call.body)), false);
    const fields = contactFieldPut(calls).body.customFields;
    assert.equal(fieldValue(fields, FIELD.leadSource), undefined, 'an existing contact keeps its first-touch Lead Source');
    assert.equal(fieldValue(fields, FIELD.leadProduct), 'Junk Pickup');
    // The contact never had the opposite consent tag, so no removal call.
    assert.equal(tagCalls(calls).some(call => call.method === 'DELETE'), false);
  });
  // Newness unknown: an existing source / Lead Source value is kept as well.
  await withHighLevel({ contact: existing }, async calls => {
    await syncHighLevelLead(ENV, lpLead());
    assert.equal(calls.some(call => call.method === 'PUT' && call.url.endsWith('/contacts/c1') && 'source' in call.body), false);
    assert.equal(fieldValue(contactFieldPut(calls).body.customFields, FIELD.leadSource), undefined);
  });
  // An existing contact without an owner is assigned, but its source stays.
  await withHighLevel({ contact: { id: 'c1', source: 'Phone' }, isNew: false }, async calls => {
    await syncHighLevelLead(ENV, lpLead());
    const identity = calls.find(call => call.method === 'PUT' && call.url.endsWith('/contacts/c1') && !call.body.customFields);
    assert.deepEqual(identity.body, { assignedTo: 'user-1' });
  });
});

test('a HighLevel outage still relays a consented lead, and never relays an unconsented one', async () => {
  const down = call => call.url.startsWith('https://services.leadconnectorhq.com') ? 503 : 0;
  await withHighLevel({ fail: down }, async calls => {
    const { value: response, logged } = await quietErrors(() => post(lpLead()));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.highlevel.synced, false);
    assert.equal(result.relay.sent, true);
    assert.equal(calls.filter(call => call.url.startsWith(HOOK)).length, 1);
    assert.ok(logged.length > 0);
    assert.equal(logged.some(line => /Secret Person|5550111/.test(line)), false, 'logs carry no contact details');
  });
  await withHighLevel({ fail: down }, async calls => {
    const { value: response } = await quietErrors(() => post(lpLead({ sms_consent: '' })));
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.equal(result.ok, false);
    assert.equal(result.relay.skipped, 'no-sms-consent');
    assert.equal(calls.some(call => call.url.startsWith(HOOK)), false, 'no SMS consent → never sent to the text relay');
  });
});

test('a rejected tag write is logged without PII and reported, and the lead still syncs', async () => {
  await withHighLevel({ isNew: true, fail: call => call.url.endsWith('/contacts/c1/tags') ? 422 : 0 }, async calls => {
    const { value: response, logged } = await quietErrors(() => post(lpLead()));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.highlevel.synced, true);
    assert.equal(result.highlevel.tagsSynced, false);
    assert.equal(result.highlevel.consentTagSynced, false);
    const [removal, add] = [tagCalls(calls).find(call => call.method === 'DELETE'), tagCalls(calls).find(call => call.method === 'POST')];
    assert.ok(removal && add && calls.indexOf(removal) < calls.indexOf(add), 'a failed removal still lets the add run, removal first');
    assert.equal(calls.filter(call => call.url.endsWith('/opportunities/upsert')).length, 1);
    assert.ok(logged.some(line => /tag add failed/.test(line) && /422/.test(line) && /Rejected by test/.test(line)));
    assert.equal(logged.some(line => /Secret Person|5550111/.test(line)), false);
  });
});

test('out-of-area ZIPs, the optional intake tag and search/upsert fallbacks', async () => {
  await withHighLevel({ isNew: true }, async calls => {
    await syncHighLevelLead({ ...ENV, HIGHLEVEL_INTAKE_TAG: 'egc-intake' }, lpLead({ serviceZip: '80634', in_service_area: 'no' }));
    const tags = addedTags(calls);
    assert.ok(tags.includes('egc-out-of-area'));
    assert.ok(tags.includes('egc-intake'));
    assert.match(calls.find(call => call.url.endsWith('/contacts/c1/notes')).body.body, /In service area: no/);
  });
  await withHighLevel({ isNew: true }, async calls => {
    await syncHighLevelLead({ ...ENV, HIGHLEVEL_INTAKE_TAG: 'egc-intake' }, lpLead({ sms_consent: '' }));
    assert.equal(addedTags(calls).includes('egc-intake'), false, 'the intake tag may start texting, so it needs consent');
  });
  // Opportunity search down → no upsert (it could drag a scheduled job back to
  // New Lead); the lead is tagged for a person instead. A 500 is not retried
  // with the other parameter spelling; a 422 is.
  await withHighLevel({ isNew: true, fail: call => call.url.includes('/opportunities/search?') ? 500 : 0 }, async calls => {
    const { value: result } = await quietErrors(() => syncHighLevelLead(ENV, lpLead()));
    assert.equal(result.opportunityId, '');
    assert.equal(result.needsTriage, true);
    assert.equal(result.opportunitySearch, 'failed');
    assert.equal(calls.filter(call => call.url.includes('/opportunities/search?')).length, 1);
    assert.equal(calls.some(call => call.url.endsWith('/opportunities/upsert')), false);
    assert.ok(addedTags(calls).includes('egc-needs-triage'));
    assert.match(calls.find(call => call.url.endsWith('/contacts/c1/notes')).body.body, /Pipeline check: opportunity search failed/);
  });
  await withHighLevel({ isNew: true, fail: call => call.url.includes('/opportunities/search?location_id=') ? 422 : 0 }, async calls => {
    const { value: result } = await quietErrors(() => syncHighLevelLead(ENV, lpLead()));
    const searches = calls.filter(call => call.url.includes('/opportunities/search?'));
    assert.equal(searches.length, 2);
    assert.equal(new URL(searches[1].url).searchParams.get('contactId'), 'c1', 'falls back to the camelCase spelling');
    assert.equal(result.opportunityId, 'opp-new');
    assert.equal(result.opportunitySearch, 'ok');
    assert.equal(addedTags(calls).includes('egc-needs-triage'), false);
  });
  // An upsert that rejects the optional source field is retried without it.
  let first = true;
  await withHighLevel({ isNew: true, fail: call => call.url.endsWith('/opportunities/upsert') && first ? (first = false, 422) : 0 }, async calls => {
    const { value: result } = await quietErrors(() => syncHighLevelLead(ENV, lpLead()));
    const upserts = calls.filter(call => call.url.endsWith('/opportunities/upsert'));
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].body.source, 'Google Paid');
    assert.equal('source' in upserts[1].body, false);
    assert.notEqual(upserts[0].headers['Idempotency-Key'], upserts[1].headers['Idempotency-Key']);
    assert.equal(result.opportunityId, 'opp-new');
  });
});

test('identity tags never include a workflow trigger tag', () => {
  const leads = [lpLead(), lpLead({ gclid: '', utm_source: 'facebook', utm_medium: 'paid', source: 'Ads Landing Page' }), { service_type: 'Garage Cleanout', flow_type: 'walkthrough', page_url: 'https://easygaragecleaning.com/book' }, {}];
  for (const lead of leads) {
    const tags = leadTags(lead, { intakeTag: 'jr', repeat: true, triage: true });
    assert.equal(tags.some(tag => WORKFLOW_TRIGGER_TAGS.has(tag)), false, 'even a configured intake tag cannot be a workflow trigger');
    assert.ok(tags.every(tag => /^egc-/.test(tag)));
  }
  assert.ok(leadTags(lpLead(), { intakeTag: 'egc-web-intake' }).includes('egc-web-intake'));
  assert.equal(leadTags({}, {}).some(tag => WORKFLOW_TRIGGER_TAGS.has(tag)), false);
});
