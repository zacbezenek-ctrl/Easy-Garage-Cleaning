import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { hubPage } from './helpers/hub-dom.mjs';
const source = readFileSync(new URL('../employee-team-lead-summary.js', import.meta.url), 'utf8');
function fixture(request) {
  let signout;
  const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat().filter(value => value != null) });
  const window = { addEventListener: (_name, fn) => { signout = fn; }, EGCHubKit: { h, requestJSON: request, button: (label, click) => ({ label, click }) } };
  vm.runInNewContext(source, { window, AbortController });
  const host = { hidden: false, children: [], replaceChildren(...nodes) { this.children = nodes; } };
  return { host, module: window.EGCTeamLeadSummary, signout: () => signout(), text: () => JSON.stringify(host.children) };
}
const response = () => ({ ok: true, asOf: '2026-10-24T12:00:00Z', sources: { timecards: 'ok' }, last30: [
  { name: 'Synthetic Crew', hours: 12, jobsLed: 2, jobsWorked: 3, followUps: 1, costCents: 999, phone: 'CANARY-CONTACT' },
] });
test('Team Lead card renders only operational counts and ordinary crew makes no request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response(); });
  await f.module.mount(f.host, { role: 'crew' }); assert.equal(calls, 0); assert.equal(f.host.hidden, true);
  await f.module.mount(f.host, { role: 'team_lead' });
  assert.match(f.text(), /12.0 hours on jobs/); assert.match(f.text(), /2 led/);
  assert.doesNotMatch(f.text(), /999|CANARY|costCents|phone/);
});
test('unmount/signout discards an in-flight response and clears operational data', async () => {
  let done; const f = fixture(() => new Promise(resolve => { done = resolve; }));
  const pending = f.module.mount(f.host, { role: 'team_lead' }); f.signout(); done(response()); await pending;
  assert.deepEqual(f.host.children, []);
});
test('auth refusal hides the card; timeout shows unavailable and a retry without stale values', async () => {
  let error = { status: 403 }; const f = fixture(async () => { throw error; });
  await f.module.mount(f.host, { role: 'team_lead' }); assert.equal(f.host.hidden, true);
  error = { status: 503 }; await f.module.refresh();
  assert.match(f.text(), /No current totals/); assert.doesNotMatch(f.text(), /Synthetic Crew/);
});
test('only Team Lead My day advertises the summary; no financial capability is added', () => {
  for (const role of ['team_lead','crew','crew_lead','sales']) {
    const page = hubPage({ user: 'synthetic', role, business: false });
    const caps = page.api.hubCapabilities();
    assert.equal(caps.includes('team_lead_summary'), role === 'team_lead');
    assert.equal(caps.includes('business'), false); assert.equal(caps.includes('owner'), false);
  }
});
