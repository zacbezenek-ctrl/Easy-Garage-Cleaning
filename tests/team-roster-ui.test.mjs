import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const collections = profiles => Object.fromEntries(
  ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads']
    .map(name => [name, name === 'profiles' ? profiles : []]),
);
const member = overrides => ({ id: 'john.smith', username: 'John.Smith', displayName: 'John Smith', role: 'crew', status: 'active', ...overrides });
const application = { username: 'John.Smith', displayName: 'John Smith', status: 'pending' };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function suite(fetcher = async () => { throw new Error('Unexpected request'); }) {
  const values = new Map(Object.entries({ egc_u: 'ZacB', egc_business_access: 'true', egc_role: 'owner' }));
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const toasts = [];
  const context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error,
    me: 'ZacB', jobsCache: [], sessionStorage: storage, localStorage: storage,
    navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { readyState: 'loading', activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    FormData: class { forEach() {} },
    hubFetch: fetcher, showToast: message => toasts.push(message),
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,teamBoard,refreshPeople,trainingModules,trainingVersion};})();');
  vm.runInNewContext(source, context);
  const api = context.ui;
  api.S.accountState.loaded = true;
  return {
    context, api, toasts,
    approve() {
      api.S.people.accounts = [{ ...application }];
      const reviewed = context.opsReviewEmployeeAccount(application.username, 'approved');
      assert.ok(api.S.actionDialog, 'the account review presents its confirmation');
      context.opsActionSubmit({ preventDefault() {}, currentTarget: {} });
      return reviewed;
    },
  };
}

test('the team lists approved members before sign-in and separates onboarding from readiness', () => {
  const env = suite();
  env.api.S.people.profiles = [member({ awaitingFirstSignIn: true })];
  const awaiting = env.api.teamBoard();
  assert.match(awaiting, /Active employees<\/span><strong>1<\/strong>/);
  assert.match(awaiting, /Approved members appear before their first sign-in/);
  assert.match(awaiting, /John Smith/);
  assert.match(awaiting, /Awaiting first sign-in/);
  assert.match(awaiting, /Onboarding due/);
  assert.match(awaiting, /Edit profile & pay/);
  assert.doesNotMatch(awaiting, /Sign off shadow shift|Clear for solo jobs/);

  env.api.S.people.profiles = [member({ awaitingFirstSignIn: false, lastSeenAt: '2026-09-09T10:00:00Z', onboardingCompletedAt: '2026-09-09T10:10:00Z', onboardingVersion: '2026-09-location-v2' })];
  const onboarded = env.api.teamBoard();
  assert.match(onboarded, /Onboarding complete/);
  assert.match(onboarded, /Sign off shadow shift/);
  assert.doesNotMatch(onboarded, /Awaiting first sign-in|Onboarding due|Solo ready/);
});

test('readiness actions cannot create a profile for a member awaiting their first sign-in', async () => {
  let requests = 0;
  const env = suite(async () => { requests++; throw new Error('No readiness write is allowed'); });
  env.api.S.people.profiles = [member({ awaitingFirstSignIn: true })];
  await env.context.opsManagerReadiness('john.smith', 'shadow');
  await env.context.opsManagerReadiness('john.smith', 'solo');
  assert.equal(requests, 0);
  assert.equal(env.toasts.length, 2);
});

test('both readiness mutations retain the exact username of a legacy profile', async () => {
  const writes = [];
  const profile = member({ id: 'johnsmith', awaitingFirstSignIn: false, lastSeenAt: '2026-09-09T10:00:00Z', onboardingCompletedAt: '2026-09-09T10:10:00Z', onboardingVersion: '2026-09-location-v2' });
  const env = suite(async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      writes.push(body);
      Object.assign(profile, body.data);
      return response({ ok: true, record: profile });
    }
    return response(url.includes('employee-accounts') ? { ok: true, accounts: [] } : { ok: true, collections: { ...collections([profile]), training: env.api.S.people.training } });
  });
  env.api.S.people.profiles = [profile];
  env.api.S.people.training = [{ employee: profile.username, version: env.api.trainingVersion, completed: Array.from(env.api.trainingModules, module => module.id) }];
  await env.context.opsManagerReadiness(profile.id, 'shadow');
  await env.context.opsManagerReadiness(profile.id, 'solo');
  assert.equal(writes.length, 2);
  for (const write of writes) {
    assert.equal(write.collection, 'profiles');
    assert.equal(write.id, 'johnsmith');
    assert.equal(write.data.username, 'John.Smith');
  }
  assert.ok(writes[0].data.shadowShiftCompletedAt);
  assert.ok(writes[1].data.readyForSoloAt);
});

test('approval waits for an older roster request, then fetches the newly approved member', async () => {
  let releaseOldRoster, rosterReads = 0, approved = false;
  const oldRoster = new Promise(resolve => { releaseOldRoster = resolve; });
  const env = suite(async (url, options = {}) => {
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).decision, 'approved');
      approved = true;
      return response({ ok: true, account: { ...application, status: 'approved' } });
    }
    if (url.includes('employee-accounts')) return response({ ok: true, accounts: [{ ...application, status: approved ? 'approved' : 'pending' }] });
    rosterReads++;
    return rosterReads === 1 ? oldRoster : response({ ok: true, collections: collections([member({ awaitingFirstSignIn: true })]) });
  });
  const beforeApproval = env.api.refreshPeople();
  await flush();
  const reviewing = env.approve();
  await flush();
  assert.equal(approved, true);
  assert.equal(rosterReads, 1, 'the earlier request is still pending');
  releaseOldRoster(response({ ok: true, collections: collections([]) }));
  await beforeApproval;
  await reviewing;
  assert.equal(rosterReads, 2, 'approval triggers a fresh request after the stale response');
  assert.equal(env.api.S.people.profiles[0].username, 'John.Smith');
  assert.equal(env.api.S.people.accounts[0].status, 'approved');
  assert.match(env.toasts.at(-1), /is on the team and can now sign in/);
});

for (const failedSource of ['employee-hub', 'employee-accounts']) {
  test(`a saved approval reports a failed ${failedSource} refresh without claiming roster success`, async () => {
    let reviews = 0;
    const env = suite(async (url, options = {}) => {
      if (options.method === 'POST') { reviews++; return response({ ok: true, account: { ...application, status: 'approved' } }); }
      if (url.includes(failedSource)) return response({ ok: false, error: 'Storage temporarily unavailable' }, 502);
      return response(url.includes('employee-accounts') ? { ok: true, accounts: [] } : { ok: true, collections: collections([]) });
    });
    await env.approve();
    assert.equal(reviews, 1);
    assert.equal(env.toasts.at(-1), 'Review saved, but team records could not refresh. Retry employee records.');
    assert.doesNotMatch(env.toasts.join(' '), /is on the team and can now sign in/);
  });
}
