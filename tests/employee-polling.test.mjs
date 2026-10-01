import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const collectionNames = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const collections = () => Object.fromEntries(collectionNames.map(name => [name, []]));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function suite() {
  let now = 1700000000000, nextTimer = 0;
  const timers = new Map(), events = {}, documentEvents = {}, calls = [];
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_owner', 'true'], ['egc_role', 'owner']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error,
    Date: class extends Date { static now() { return now; } },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', jobsCache: [],
    location: { pathname: '/employee', search: '' },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay }); return id; },
    clearInterval(id) { timers.delete(id); }, setTimeout: () => 1, clearTimeout() {},
    addEventListener(name, callback) { events[name] = callback; },
    document: {
      readyState: 'loading', hidden: false, activeElement: null,
      addEventListener(name, callback) { documentEvents[name] = callback; },
      querySelector: () => null, querySelectorAll: () => [],
    },
  };
  const env = { context, timers, events, documentEvents, calls, pending: null };
  context.hubFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('employee-accounts')) return env.accountResponse || response({ ok: true, accounts: [] });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      return env.postResponse ? env.postResponse(body) : response({ ok: true, record: { ...body.data, id: body.id } });
    }
    if (env.pending) return env.pending;
    if (url.endsWith('?view=messages')) return response({ ok: true, collections: { teamMessages: [], jobMessages: [], messageReads: [] } });
    return response({ ok: true, collections: collections(), accounts: [] });
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,refreshPeople,startPeopleListeners,ensureOwnProfile,peopleSet,accountApprovalBoard}});})();');
  vm.runInNewContext(source, context);
  env.api = context.ui;
  env.reads = () => calls.filter(call => call.url.split('?')[0] === '/api/employee-hub' && call.method === 'GET').length;
  env.advance = async milliseconds => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.values()].filter(timer => timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      now = next.at;
      next.at += next.delay;
      await next.callback();
    }
    now = target;
  };
  env.elapse = milliseconds => { now += milliseconds; };
  return env;
}

test('first sign-in mirrors the canonical profile without a second whole-vault read', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [
    { id: 'zacb', username: 'ZacB', displayName: 'Before', accountStatus: 'approved', awaitingFirstSignIn: true },
    { id: 'crew.one', username: 'Crew.One', displayName: 'Crew One' },
  ] }, accounts: [{ username: 'ZacB', status: 'approved' }] });
  env.postResponse = body => response({ ok: true, record: {
    ...body.data, id: body.id, displayName: 'Canonical name', lastSeenAt: '2026-09-30T00:00:00.000Z',
  } });

  await env.api.startPeopleListeners();

  assert.equal(env.reads(), 1, 'the successful profile mirror must not scan the entire vault again');
  assert.equal(env.calls.filter(call => call.url === '/api/employee-hub' && call.method === 'POST').length, 1);
  assert.deepEqual(Array.from(env.api.S.people.profiles, row => row.id), ['zacb', 'crew.one'], 'the own row keeps its place');
  assert.equal(env.api.S.people.profiles[0].displayName, 'Canonical name', 'the server record wins over the earlier GET');
  assert.equal(env.api.S.people.profiles[0].lastSeenAt, '2026-09-30T00:00:00.000Z');
  assert.equal(env.api.S.people.profiles[0].accountStatus, 'approved', 'the GET-only account projection remains available');
  assert.equal(env.api.S.people.profiles[0].awaitingFirstSignIn, false, 'the saved first sign-in clears the readiness hold');
  assert.equal(env.api.S.people.accounts[0].status, 'approved');
});

test('profile mirror refreshes after a read that overlaps its save', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  let releaseStale;
  env.pending = new Promise(resolve => { releaseStale = resolve; });
  const read = env.api.refreshPeople();
  const mirror = env.api.ensureOwnProfile();
  for (let turn = 0; turn < 20 && !env.api.S.peopleReload; turn += 1) await Promise.resolve();
  assert.equal(env.api.S.peopleReload, true, 'the mirror save marks the in-flight read for replay');
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ id: 'zacb', username: 'ZacB', displayName: 'Latest', lastSeenAt: '2026-09-30T00:00:00.000Z' }] }, accounts: [] });
  releaseStale(response({ ok: true, collections: { ...collections(), profiles: [{ id: 'zacb', username: 'ZacB', displayName: 'Stale' }] }, accounts: [] }));
  await Promise.all([read, mirror]);
  assert.equal(env.reads(), initial + 2, 'one stale read is replayed once after the save');
  assert.equal(env.api.S.people.profiles[0].displayName, 'Latest');
});

test('an incomplete profile mutation response keeps the full refresh', async () => {
  const env = suite();
  env.postResponse = body => response({ ok: true, record: { ...body.data } });
  await env.api.startPeopleListeners();
  assert.equal(env.reads(), 2, 'a record without the canonical id cannot replace the GET projection');
});

test('a profile response for another identity is reread instead of being merged', async () => {
  const env = suite();
  env.postResponse = body => response({ ok: true, record: {
    ...body.data, id: body.id, username: 'Other.Person', lastSeenAt: '2026-09-30T00:00:00.000Z',
  } });
  await env.api.startPeopleListeners();
  assert.equal(env.reads(), 2, 'a mismatched username is never accepted as the signed-in profile');
  assert.equal(env.api.S.people.profiles.some(row => row.username === 'Other.Person'), false);
});

test('account switch while the profile save is pending discards its response', async () => {
  const env = suite();
  let finishSave;
  env.postResponse = body => new Promise(resolve => { finishSave = () => resolve(response({ ok: true, record: {
    ...body.data, id: body.id, lastSeenAt: '2026-09-30T00:00:00.000Z',
  } })); });
  const loading = env.api.startPeopleListeners();
  for (let turn = 0; turn < 20 && !finishSave; turn += 1) await Promise.resolve();
  assert.equal(typeof finishSave, 'function');
  env.events['egc:signout']();
  env.context.sessionStorage.setItem('egc_u', 'Other.Person');
  finishSave();
  await loading;
  assert.equal(env.reads(), 1, 'the old save does not start another collection read');
  assert.equal(env.api.S.people.profiles.length, 0, 'the old profile is not merged into the new account');
});

test('employee polling pauses hidden tabs, refreshes on return, and uses a minute outside chat', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  await env.advance(45000);
  assert.equal(env.reads(), initial);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 1);

  env.context.document.hidden = true;
  await env.documentEvents.visibilitychange();
  await env.advance(5 * 60000);
  assert.equal(env.reads(), initial + 1, 'a background tab must not reread employee records');
  env.context.document.hidden = false;
  await env.documentEvents.visibilitychange();
  assert.equal(env.reads(), initial + 2, 'returning to the tab refreshes immediately');
  await env.advance(45000);
  assert.equal(env.reads(), initial + 2);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 3);
});

test('active crew chat keeps 15-second updates and leaving chat restores minute polling', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  env.api.S.active = 'crew_chat';
  await env.advance(15000);
  assert.equal(env.reads(), initial + 1);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 2);
  env.api.S.active = 'my_day';
  await env.advance(15000);
  assert.equal(env.reads(), initial + 2);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 3, 'the full refresh remains due one minute after the last full read');
  assert.ok(env.calls.at(-1).url.includes('?include=accounts'));
});

test('manual and post-write employee refreshes run immediately between automatic polls', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  await env.api.refreshPeople();
  assert.equal(env.reads(), initial + 1);
  await env.api.peopleSet('profiles', 'zacb', { username: 'ZacB' });
  assert.equal(env.reads(), initial + 2);
  await env.advance(45000);
  assert.equal(env.reads(), initial + 2);
});

test('failed automatic vault reads back off to fifteen minutes and successful recovery restores the normal cadence', async () => {
  const env = suite();
  env.pending = response({ ok: false, error: 'Storage temporarily unavailable' }, 503);
  await env.api.startPeopleListeners();
  assert.equal(env.reads(), 1);
  assert.equal(env.api.S.peopleState.loaded, false, 'an unavailable vault is never an empty successful result');
  env.api.S.active = 'crew_chat';
  for (const delay of [120000, 240000, 480000, 900000, 900000]) {
    const before = env.reads();
    await env.advance(delay - 15000);
    assert.equal(env.reads(), before, 'chat does not bypass the failed-read delay');
    await env.advance(15000);
    assert.equal(env.reads(), before + 1);
  }
  env.pending = null;
  await env.api.refreshPeople();
  assert.equal(env.api.S.peoplePollFailures, 0);
  const recovered = env.reads();
  await env.advance(15000);
  assert.equal(env.reads(), recovered + 1, 'successful recovery restores chat updates');
});

test('manual, post-write and visibility refreshes bypass failed-read backoff and sign-out resets it', async () => {
  const env = suite();
  env.pending = response({ ok: false, error: 'Storage temporarily unavailable' }, 429);
  await env.api.startPeopleListeners();
  await env.api.refreshPeople();
  assert.equal(env.reads(), 2, 'explicit retry stays available');
  await env.api.peopleSet('profiles', 'zacb', { username: 'ZacB' });
  assert.equal(env.reads(), 3, 'read-after-write remains immediate');
  await env.documentEvents.visibilitychange();
  assert.equal(env.reads(), 4, 'foregrounding checks current shift state immediately');
  env.events['egc:signout']();
  assert.equal(env.api.S.peoplePollFailures, 0, 'a new account does not inherit old retry delays');
});

test('owner refresh reuses the account list from the hub instead of reading it twice', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  await env.advance(60000);
  assert.ok(env.reads() > 0);
  assert.equal(env.calls.filter(call => call.url.includes('employee-accounts')).length, 0);
  assert.ok(env.calls.some(call => call.url === '/api/employee-hub?include=accounts'));
  assert.equal(env.api.S.accountState.loaded, true);
  assert.equal(env.api.S.accountState.error, '');
});

test('an older hub response falls back to one account lookup and preserves both results', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'SyntheticCrew' }] } });
  env.accountResponse = response({ ok: true, accounts: [{ username: 'SyntheticCrew', displayName: 'Synthetic crew', status: 'pending' }] });
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.reads(), 1);
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 1);
  assert.equal(env.api.S.people.profiles[0].username, 'SyntheticCrew');
  assert.equal(env.api.S.people.accounts[0].status, 'pending');
  assert.equal(env.api.S.accountState.loaded, true);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, '');
  assert.match(env.api.accountApprovalBoard(), /1 waiting for you/);
});

test('a malformed combined account list blocks stale approvals while employee data stays usable', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: collections(), accounts: [{ username: 'SyntheticCrew', displayName: 'Synthetic crew', status: 'pending' }] });
  await env.api.refreshPeople();
  assert.match(env.api.accountApprovalBoard(), /1 waiting for you/);
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'UpdatedCrew' }] }, accounts: null });
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.equal(env.api.S.peopleState.error, '');
  assert.equal(env.api.S.people.profiles[0].username, 'UpdatedCrew');
  assert.equal(env.api.S.accountState.loading, false);
  assert.match(env.api.S.accountState.error, /incomplete/);
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
  assert.doesNotMatch(env.api.accountApprovalBoard(), /No accounts waiting|Synthetic crew|>Approve</);
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 0, 'an invalid supplied list must not be treated as an older server response');
  const count = env.calls.length;
  await env.context.opsReviewEmployeeAccount('SyntheticCrew', 'approved');
  assert.equal(env.calls.length, count, 'an unverified account list must not authorize an approval write');

  env.pending = response({ ok: true, collections: collections(), accounts: [] });
  await env.api.refreshPeople();
  assert.equal(env.api.S.accountState.error, '');
  assert.match(env.api.accountApprovalBoard(), /No accounts waiting/);
});

test('a failed legacy account fallback does not claim that the approval queue is empty', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: collections() });
  env.accountResponse = response({ ok: false, error: 'Account storage unavailable' }, 503);
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.equal(env.api.S.peopleState.error, '');
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, 'Account storage unavailable');
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
  assert.doesNotMatch(env.api.accountApprovalBoard(), /No accounts waiting|>Approve</);
});

test('a failed combined request invalidates account approvals and clears both loading states', async () => {
  const env = suite();
  await env.api.refreshPeople();
  env.pending = response({ ok: false, error: 'Employee storage unavailable' }, 503);
  assert.equal(await env.api.refreshPeople(), false);
  assert.equal(env.api.S.peopleState.error, 'Employee storage unavailable');
  assert.equal(env.api.S.accountState.error, 'Employee storage unavailable');
  assert.equal(env.api.S.peopleState.loading, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.peopleRequest, null);
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
});

test('logout during a legacy account fallback discards both delayed account and employee data', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] } });
  let resolve;
  env.accountResponse = new Promise(done => { resolve = done; });
  const pending = env.api.refreshPeople();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 1);
  assert.equal(env.api.S.accountState.loading, true);
  env.events['egc:signout']();
  resolve(response({ ok: true, accounts: [{ username: 'PreviousPerson', status: 'pending' }] }));
  assert.equal(await pending, false);
  assert.equal(env.api.S.people.accounts.length, 0);
  assert.equal(env.api.S.people.profiles.length, 0);
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, '');
  assert.equal(env.api.S.peopleState.loaded, false);
});

test('polling and visibility changes share one request and logout discards its response', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  let resolve;
  env.pending = new Promise(done => { resolve = done; });
  const timer = [...env.timers.values()][0];
  env.elapse(60000);
  const first = timer.callback();
  env.elapse(60000);
  const next = timer.callback();
  const visible = env.documentEvents.visibilitychange();
  assert.equal(env.reads(), initial + 1, 'there must be only one in-flight collection read');

  env.events['egc:signout']();
  resolve(response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] }, accounts: [{ username: 'PreviousPerson', status: 'pending' }] }));
  await Promise.all([first, next, visible]);
  assert.equal(env.timers.size, 0);
  assert.equal(env.api.S.peopleState.loaded, false);
  assert.equal(env.api.S.people.profiles.length, 0);
  assert.equal(env.api.S.people.accounts.length, 0);
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  await env.documentEvents.visibilitychange();
  await env.advance(60000);
  assert.equal(env.reads(), initial + 1, 'logout must stop visibility-triggered reads too');
});


test('chat polls only message families between full-minute refreshes and preserves employee/account state', async () => {
  const env = suite();await env.api.startPeopleListeners();const {S}=env.api;
  S.active='crew_chat';S.people.timeEntries=[{id:'shift',employee:'ZacB',status:'active'}];S.people.accounts=[{username:'crew.one'}];S.people.payVisibility='all';S.clockInWithoutFix=true;S.timecardCorrections=true;
  const fullAt=S.peopleLastFullRefreshAt;
  await env.advance(45000);
  assert.deepEqual(env.calls.filter(call=>call.method==='GET').slice(-3).map(call=>call.url),Array(3).fill('/api/employee-hub?view=messages'));
  assert.equal(S.people.timeEntries[0].id,'shift');assert.equal(S.people.accounts[0].username,'crew.one');
  assert.equal(S.people.payVisibility,'all');assert.equal(S.clockInWithoutFix,true);assert.equal(S.timecardCorrections,true);assert.equal(S.peopleLastFullRefreshAt,fullAt);
  await env.advance(15000);assert.equal(env.calls.at(-1).url,'/api/employee-hub?include=accounts');
  assert.equal(S.peopleLastFullRefreshAt,fullAt+60000);
});

test('a messages-only refresh preserves queued clock-outs and rebases pending chat messages',async()=>{
 const env=suite();await env.api.startPeopleListeners();const {S}=env.api;
 const clockOut={collection:'timeEntries',id:'shift',requestId:'clock-out',data:{status:'submitted'}},message={collection:'teamMessages',id:'message',requestId:'message-save',data:{body:'Unsent message'}};
 env.context.EGCHubOffline={showing:()=>true,revision:()=>1,records:async()=>[clockOut,message]};
 const shown={collection:'timeEntries',id:'shift',base:{id:'shift',status:'active'},requests:[clockOut]};
 S.queuedShown.set('timeEntries/shift',shown);S.people.timeEntries=[{id:'shift',status:'submitted',pendingSync:true}];
 const sequence=S.readSeq;
 await env.api.refreshPeople({messagesOnly:true});
 assert.equal(S.queuedShown.get('timeEntries/shift'),shown);assert.equal(S.people.timeEntries[0].status,'submitted');assert.equal(S.people.timeEntries[0].pendingSync,true);
 assert.equal(S.people.teamMessages[0].body,'Unsent message');assert.equal(S.people.teamMessages[0].pendingSync,true);
 assert.equal(S.readSeq,sequence,'chat cannot resolve a timecard pause without reading timecards');
});

test('manual refresh overlapping chat schedules a full read instead of silently accepting a partial read',async()=>{
 const env=suite();await env.api.startPeopleListeners();let release;
 env.pending=new Promise(resolve=>{release=resolve;});
 const messages=env.api.refreshPeople({messagesOnly:true});const manual=env.api.refreshPeople();
 env.pending=null;release(response({ok:true,collections:{teamMessages:[],jobMessages:[],messageReads:[]}}));
 await Promise.all([messages,manual]);for(let turn=0;turn<30;turn++)await Promise.resolve();
 assert.deepEqual(env.calls.filter(call=>call.method==='GET').slice(-2).map(call=>call.url),['/api/employee-hub?view=messages','/api/employee-hub?include=accounts']);
});

test('a malformed chat response cannot wipe messages or qualify stale employee data, and logout fences late chat',async()=>{
 const env=suite();await env.api.startPeopleListeners();env.api.S.people.teamMessages=[{id:'kept',body:'Kept message'}];
 env.pending=response({ok:true,collections:{teamMessages:[]}});
 assert.equal(await env.api.refreshPeople({messagesOnly:true}),false);assert.equal(env.api.S.people.teamMessages[0].id,'kept');assert.match(env.api.S.peopleState.error,/incomplete/);
 env.pending=null;await env.api.refreshPeople();
 let release;env.pending=new Promise(resolve=>{release=resolve;});const read=env.api.refreshPeople({messagesOnly:true});env.events['egc:signout']();
 release(response({ok:true,collections:{teamMessages:[{id:'private-old'}],jobMessages:[],messageReads:[]}}));assert.equal(await read,false);assert.equal(env.api.S.people.teamMessages.length,0);
});
