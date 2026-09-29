import test from 'node:test';
import assert from 'node:assert/strict';
import { hubPage } from './helpers/hub-dom.mjs';

// MOBILE-HUB shell behaviour in the vm DOM (the layout itself is checked in tests/browser/test_hub_shell_mobile_ui.py):
// business users get RUN THE BUSINESS first, the view title carries its full name as a title attribute for the phone
// topbar's two-line clamp, and My day puts the time clock above Today's jobs for anyone who is not clocked in.
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const collections = (timeEntries = []) => ({ ...Object.fromEntries(['profiles', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []])), timeEntries });
const fetcher = entries => url => {
  if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: collections(entries), accounts: [] });
  if (url.startsWith('/api/highlevel')) return json({ ok: true, pipelines: [], opportunities: [], events: [] });
  if (url.startsWith('/api/integration-status')) return json({ ok: true, status: { highlevel: true } });
  return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
};
// Values built inside the vm realm carry its own Array prototype; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const railGroups = page => page.document.querySelectorAll('.ops-nav-label').map(label => label.textContent);
const railViews = page => page.document.querySelectorAll('.ops-nav [data-ops-tab]').map(button => button.getAttribute('data-ops-tab'));

test('business users see RUN THE BUSINESS first; the rest of the rail keeps its order and nothing is dropped', () => {
  const manager = hubPage({ user: 'ZacB', business: true, role: 'owner' });
  const items = plain(manager.api.visibleNav());
  const business = items.filter(item => item[0] === 'RUN THE BUSINESS'), rest = items.filter(item => item[0] !== 'RUN THE BUSINESS');
  assert.ok(business.length >= 7, 'the owner sees the business views');
  assert.deepEqual(items, [...business, ...rest], 'every RUN THE BUSINESS item comes before the first other item');
  assert.equal(rest[0][0], 'MY EGC', 'My day and the rest of MY EGC follow, in their usual order');
  assert.deepEqual(rest.filter(item => item[0] === 'MY EGC').map(item => item[1]).slice(0, 3), ['my_day', 'my_shifts', 'open_shifts']);
  manager.api.install();
  assert.equal(railGroups(manager)[0], 'RUN THE BUSINESS');
  assert.equal(railViews(manager)[0], 'today', 'Command center is the first item in the rail and the phone drawer');
  assert.deepEqual([...railViews(manager)].sort(), items.map(item => item[1]).sort(), 'the rail lists exactly the visible views');

  const crew = hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew' });
  crew.api.install();
  assert.equal(railGroups(crew)[0], 'MY EGC', 'crew keep MY EGC first');
  assert.equal(railViews(crew).includes('today'), false);
  assert.deepEqual(railViews(crew).slice(0, 2), ['my_day', 'my_shifts']);
});

test('the topbar title carries the full view name as its title attribute on every view change', () => {
  const page = hubPage({ fetcher: fetcher() });
  page.api.install();
  const title = page.document.querySelector('#ops-title');
  assert.equal(title.getAttribute('title'), title.textContent, 'the first paint names the view in full');
  for (const [view, name] of [['finance', 'Estimates & payments'], ['pipeline', 'New HighLevel leads'], ['people', 'Team']]) {
    page.api.go(view);
    assert.equal(title.textContent, name);
    assert.equal(title.getAttribute('title'), name, `${view}: a title clamped to two lines is still readable in full`);
  }
});

test('My day shows the time clock above Today’s jobs until the viewer clocks in, then the jobs lead', async () => {
  const order = page => page.main().querySelectorAll('.ops-clock-card, #ops-field-today').map(node => node.id || 'clock');
  const out = hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew', fetcher: fetcher() });
  out.api.S.peopleState.loaded = true;
  out.api.install();
  out.api.go('my_day');
  assert.deepEqual(order(out), ['clock', 'ops-field-today'], 'a crew member who is not clocked in reaches the clock card first');

  const shift = { id: 'time-live', employee: 'Synthetic.Crew', status: 'active', clockInAt: '2026-09-22T15:00:00.000Z', hourlyRate: 20 };
  const working = hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew', fetcher: fetcher([shift]) });
  working.api.install();
  await working.flush();
  working.api.S.people.timeEntries = [shift];
  working.api.S.peopleState.loaded = true;
  working.api.go('my_day');
  assert.match(working.main().querySelector('.ops-clock-card').textContent, /Clock out/, 'the fixture is clocked in');
  assert.deepEqual(order(working), ['ops-field-today', 'clock'], 'once clocked in, Today’s jobs come first again');
});
