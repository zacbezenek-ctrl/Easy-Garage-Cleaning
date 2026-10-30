import test from 'node:test';
import assert from 'node:assert/strict';
import { hubPage } from './helpers/hub-dom.mjs';

// D10 Team directory deep link: the screen is allowed only once /api/integration-status reports the staff directory on
// (flags.teamDirectory), which answers after the Hub has already picked its first screen. A reload of the Team
// directory, or a link to /employee?view=team_directory, used to land on My day (or the Command center) and rewrite the
// address. Now the Hub shows the usual first screen while it waits, keeps the address, and opens the Team directory
// once access is confirmed; when the answer is no, it stays on that first screen and the address says so.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
// Crew One finished onboarding, so the Hub does not send them to Getting started first.
const collections = () => ({ ...Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []])),
  profiles: [{ id: 'crew.one', username: 'Crew.One', displayName: 'Synthetic Crew One', role: 'crew', status: 'active', onboardingCompletedAt: '2026-09-01T15:00:00Z', onboardingVersion: '2026-09-location-v2' }] });
const CREW = { user: 'Crew.One', business: false, role: 'crew' }, OWNER = {};

// A Hub page opened at `search`, whose integration-status answer waits until answer(on) is called.
function deepLink(who, search = '?view=team_directory') {
  let release;
  const status = new Promise(resolve => { release = resolve; });
  const page = hubPage({ ...who, search, fetcher: async url => {
    if (url.startsWith('/api/integration-status')) { const on = await status; return on === 'error' ? json({ ok: false, error: 'Synthetic outage' }, 503) : json({ ok: true, status: {}, flags: { moneyApi: false, lifecycleApi: false, ...(on ? { teamDirectory: true } : {}) } }); }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: collections(), accounts: [] });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  } });
  const view = () => new URL(page.location.href).searchParams.get('view');
  return { page, view, answer: async on => { release(on); await page.flush(); await settle(); await page.flush(); } };
}

test('a reload or link to the Team directory opens it once the server confirms access, without a history entry for the wait', async () => {
  for (const [who, first] of [[CREW, 'my_day'], [OWNER, 'today']]) {
    const { page, view, answer } = deepLink(who);
    page.api.install();
    await page.flush();
    assert.equal(page.api.S.active, first, 'the usual first screen while access is checked');
    assert.equal(view(), 'team_directory', 'the address keeps the Team directory while it waits');
    await answer(true);
    assert.equal(page.api.S.active, 'team_directory', JSON.stringify(who));
    assert.equal(view(), 'team_directory');
    assert.ok(page.document.querySelector('[data-ops-tab="team_directory"].active'), 'the menu shows it as the open screen');
    assert.deepEqual(page.history.map(entry => entry.method), page.history.map(() => 'replace'), 'Back does not stop on the waiting screen');
  }
});

test('without directory access the deep link stays on the first screen and the address says so', async () => {
  for (const [who, first] of [[CREW, 'my_day'], [OWNER, 'today']]) {
    const { page, view, answer } = deepLink(who);
    page.api.install();
    await page.flush();
    await answer(false);
    assert.equal(page.api.S.active, first, JSON.stringify(who));
    assert.equal(view(), first);
    assert.equal(page.document.querySelector('[data-ops-tab="team_directory"]'), null);
  }
});

test('when access cannot be checked, the deep link stays on the first screen and the address says so', async () => {
  const { page, view, answer } = deepLink(CREW);
  page.api.install();
  await page.flush();
  await answer('error');
  assert.equal(page.api.S.active, 'my_day');
  assert.equal(view(), 'my_day');
  assert.equal(page.api.S.directoryWait, '', 'a later answer does not pull the viewer away');
});

test('a viewer who moves on while access is checked is not pulled back to the Team directory', async () => {
  const { page, view, answer } = deepLink(CREW);
  page.api.install();
  await page.flush();
  page.api.go('onboarding');
  await answer(true);
  assert.equal(page.api.S.active, 'onboarding');
  assert.equal(view(), 'onboarding');
  assert.ok(page.document.querySelector('[data-ops-tab="team_directory"]'), 'the Team directory is listed for later');
});

test('other deep links and plain opens are unchanged', async () => {
  const plain = deepLink(CREW, '');
  plain.page.api.install();
  await plain.answer(true);
  assert.equal(plain.page.api.S.active, 'my_day');
  const onboarding = deepLink(CREW, '?view=onboarding');
  onboarding.page.api.install();
  await onboarding.answer(true);
  assert.equal(onboarding.page.api.S.active, 'onboarding');
  assert.equal(onboarding.view(), 'onboarding');
});
