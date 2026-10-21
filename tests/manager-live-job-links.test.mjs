import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { storage, FixedDate } from './helpers/hub-dom.mjs';

// LIVE-JOB-LINKS: a manager's job tap in the Hub lands on the live job page (/crew/job.html, which saves through
// /api/field-jobs), so work done there counts on the Hub job. The old pre-job and post-job pages stay reachable as a
// secondary "Playbook (reference)" link: pre-job sends the arrival text, post-job takes payment, the review link and
// Garage Guard, and the live page does none of these.
const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

function suite() {
  const context = { Date: FixedDate, Intl, URLSearchParams, console, sessionStorage: storage({ egc_u: 'ZacB', egc_business_access: 'true', egc_owner: 'true', egc_role: 'owner' }), localStorage: storage(), navigator: {}, location: { search: '' }, jobsCache: [],
    managerScheduleState: { loaded: true, loading: false, error: '', fromCache: false, pending: false }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    document: { readyState: 'loading', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } };
  context.window = context; vm.createContext(context);
  vm.runInContext(source('employee-suite.js').replace(/\}\)\(\);\s*$/, 'globalThis.api={views};})();'), context);
  return context;
}

test('Job delivery sends Pre-job and Closeout to the live job page and keeps the playbook as a reference link', () => {
  const p = suite();
  p.jobsCache = [{ id: 'synthetic-job-1', type: 'job', date: '2026-09-22', time: '09:00', endTime: '12:00', customer: 'Synthetic Delivery', status: 'scheduled', notes: 'Synthetic brief', priceQuoted: 1000 }];
  const html = p.api.views.delivery();
  assert.match(html, /<a href="\/crew\/job\.html\?jobId=synthetic-job-1">Pre-job<\/a><a href="\/crew\/job\.html\?jobId=synthetic-job-1">Closeout<\/a><a class="ops-playbook-link" href="\/crew\/postjob\.html\?jobId=synthetic-job-1">Playbook \(reference\)<\/a>/);
  assert.doesNotMatch(html, /href="\/crew\/postjob\.html\?jobId=[^"]*">Closeout/);
  // The header's primary action opens the live jobs; both playbooks stay as secondary buttons.
  assert.match(html, /<a class="ops-button primary" href="\/crew\/">Open live jobs<\/a><a class="ops-button " href="\/crew\/prejob\.html">Pre-job playbook \(reference\)<\/a><a class="ops-button " href="\/crew\/postjob\.html">Post-job playbook \(reference\)<\/a>/);
});

test('the proof loop opens the live jobs first and keeps the post-job playbook', () => {
  const html = suite().api.views.proof();
  assert.match(html, /<a class="ops-button primary" href="\/crew\/">Open live jobs<\/a><a class="ops-button " href="\/crew\/postjob\.html">Post-job playbook \(reference\)<\/a>/);
  assert.doesNotMatch(html, /Open post-job capture/);
});

test('the payment, arrival-text and review pages are still served and linked', () => {
  // Nothing here removes either playbook: both pages exist and keep their customer-facing steps.
  const prejob = source('crew/prejob.html'), postjob = source('crew/postjob.html');
  assert.match(prejob, /\/api\/quo-send/);
  assert.match(source('crew/index.html'), /data-business-href="\/crew\/prejob"/);
  assert.match(source('crew/index.html'), /data-business-href="\/crew\/postjob"/);
  assert.ok(postjob.length > 0);
});
