import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

function files(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('all generated JSON-LD remains valid JSON', () => {
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(match[1]), `Invalid JSON-LD in ${relative(root, path)}`);
    }
  }
});

test('every indexable HTML document has one clear search and page identity', () => {
  const failures = [];
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)) continue;
    const rel = relative(root, path);
    const titles = [...html.matchAll(/<title>([^<]+)<\/title>/gi)];
    const headings = [...html.matchAll(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/gi)];
    const descriptions = [...html.matchAll(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/gi)];
    const canonicals = [...html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/gi)];
    if (titles.length !== 1 || !titles[0]?.[1]?.trim()) failures.push(`${rel}: title=${titles.length}`);
    if (headings.length !== 1 || !headings[0]?.[1]?.replace(/<[^>]+>/g, '').trim()) failures.push(`${rel}: h1=${headings.length}`);
    if (descriptions.length !== 1) failures.push(`${rel}: descriptions=${descriptions.length}`);
    if (canonicals.length !== 1 || !/^https:\/\/easygaragecleaning\.com\//.test(canonicals[0]?.[1] || '')) failures.push(`${rel}: canonicals=${canonicals.length}`);
    if (!/<html[^>]+lang=["']en["']/i.test(html)) failures.push(`${rel}: language`);
  }
  assert.deepEqual(failures, []);
});

test('structured data no longer advertises the retired photo-quote flow', () => {
  const failures = [];
  for (const file of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      if (/photo quotes?|5[- ]min(?:ute)? quote|flat[- ]rate from (?:your )?photos/i.test(json)) {
        failures.push(relative(root, file));
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('confidential artifacts are removed and source paths are denied at the edge', async () => {
  for (const path of ['sop.html', 'tyler-contract.html', 'contracts/tyler-lead-setter-agreement.html', 'EGC-Lead-System-SOP.pdf']) {
    assert.equal(existsSync(join(root, path)), false, `${path} must not ship`);
  }
  const { onRequest } = await import('../functions/_middleware.js');
  for (const path of ['/_generate_site.py', '/docs/EGC-OPERATIONS-AUDIT.md', '/tests/operations-suite.test.mjs', '/package.json', '/firestore.rules', '/contracts/old.html']) {
    let continued = false;
    const response = await onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), next: async () => { continued = true; return new Response('leak'); } });
    assert.equal(response.status, 404, path);
    assert.equal(continued, false, path);
  }
});

test('edge middleware adds browser security headers and a real explicit 404', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const response = await onRequest({ request: new Request('https://easygaragecleaning.com/'), next: async () => new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } }) });
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors/);
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const missing = await onRequest({ request: new Request('https://easygaragecleaning.com/404'), next: async () => new Response(read('404.html')) });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('x-robots-tag') || '', /noindex/);
});

test('sensitive APIs do not trust arbitrary subdomains as same-origin callers', () => {
  const apiSource=files(join(root,'functions','api')).filter(path=>path.endsWith('.js')).map(path=>readFileSync(path,'utf8')).join('\n');
  assert.doesNotMatch(apiSource,/\(\^\|\\\.\)easygaragecleaning\\\.com/);
  assert.doesNotMatch(apiSource,/\[a-z0-9-\]\+\\\.\)\*easygaragecleaning\\\.com/);
  assert.match(apiSource,/www\\\.easygaragecleaning\\\.com/);
  assert.match(apiSource,/easy-garage-cleaning\\\.pages\\\.dev/);
});

test('Garage Guard scrubs Stripe bearer tokens before analytics initializes', () => {
  const page=read('garage-guard.html');
  const scrub=page.indexOf("sessionStorage.setItem('egc_gg_checkout_session'");
  const loader=page.indexOf('/analytics-loader.js');
  assert.ok(scrub >= 0 && loader > scrub);
  assert.match(page,/<script src="\/analytics-loader\.js[^>]+defer>/);
  assert.match(page,/history\.replaceState\(null,''/);
});

test('Firestore requires a Hub-minted Firebase session and server calls use service authentication', () => {
  for (const path of ['employee.html', 'copilot.html', 'crew/index.html', 'crew/gameplan.html', 'crew/prejob.html', 'crew/postjob.html']) {
    const html = read(path);
    assert.match(html, /firebase-auth-compat\.js/, path);
  }
  assert.match(read('employee.html'), /\/api\/firebase-session/);
  assert.match(read('crew/hub-auth.js'), /signInWithCustomToken/);
  assert.match(read('functions/api/firebase-session.js'), /hasBusinessAccess\(session\)/);
  assert.doesNotMatch(read('functions/api/firebase-session.js'), /\['zacb', 'tylerg', 'alexk'\]/);
  assert.doesNotMatch(read('functions/_lib/firestore-job.js'), /\?key=/);
  assert.doesNotMatch(read('functions/_lib/employee-accounts.js'), /\?key=/);
  assert.doesNotMatch(read('functions/api/employee-hub.js'), /\?key=/);
  assert.match(read('firestore.rules'), /request\.auth != null/);
  assert.doesNotMatch(read('firestore.rules'), /match \/jobs\/\{documentId\}[\s\S]*?allow read, write: if signedIn\(\)/);
  assert.match(read('firestore.rules'), /assignedToUser\(resource\.data\)/);
  assert.match(read('crew/index.html'), /\/api\/crew-jobs/);
  assert.match(read('employee.html'), /if \(!canRunBusiness\(\)\)[\s\S]*?\/api\/crew-jobs/);
  assert.match(read('firestore.rules'), /match \/\{document=\*\*\}[\s\S]*allow read, write: if false/);
  assert.doesNotMatch(read('functions/_lib/hub-session.js'), /[a-f0-9]{64}/i);
  assert.doesNotMatch(read('functions/_lib/hub-session.js'), /HIGHLEVEL_API_KEY|GHL_API_KEY/);
});

test('model output is escaped before the field copilot renders its limited markup', () => {
  const copilot = read('copilot.html');
  assert.match(copilot, /const withPills = esc\(trimmed\)/);
  assert.match(copilot, /const safeScript = esc\(script\)/);
  assert.doesNotMatch(copilot, /const withPills = trimmed\s*\.replace/);
});

test('privileged actions honor signed session claims instead of a lookalike username', async () => {
  const env = { HUB_SESSION_SECRET: 'lookalike-test', FIREBASE_API_KEY: 'firebase-test-lookalike' };
  const cookie = (await createHubSessionCookie(env, 'ZacB', {
    user: 'ZacB', displayName: 'Not the owner', role: 'crew', businessAccess: false, source: 'employee-account',
  })).split(';')[0];
  const headers = { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' };

  const relay = await import('../functions/api/operations-event.js');
  const relayResponse = await relay.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/operations-event', { method: 'POST', headers, body: JSON.stringify({ event: 'booking', payload: {} }) }),
    env,
  });
  assert.equal(relayResponse.status, 403);

  const accounts = await import('../functions/api/employee-accounts.js');
  const reviewResponse = await accounts.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/employee-accounts', { method: 'POST', headers, body: JSON.stringify({ action: 'review', username: 'someone', decision: 'approved' }) }),
    env,
  });
  assert.equal(reviewResponse.status, 403);
});

test('crew schedule API excludes unassigned customer jobs and redacts open shifts', async () => {
  const route = await import('../functions/api/crew-jobs.js');
  const env = { HUB_SESSION_SECRET: 'crew-jobs-test', FIREBASE_API_KEY: 'firebase-test-crew-jobs', HUB_AUTH_USERS_JSON: JSON.stringify({ Crewtest: { passwordHash: 'test', displayName: 'Crew Test', role: 'crew' } }) };
  const cookie = (await createHubSessionCookie(env, 'Crewtest', { displayName: 'Crew Test' })).split(';')[0];
  const document = (id, data) => ({ document: {
    name: `projects/x/databases/(default)/documents/jobs/${id}`,
    fields: encodeFirestoreFields(data),
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    document('mine', { type: 'job', assignedCrew: ['Crewtest'], customer: 'Assigned Customer', address: '1 Assigned Way' }),
    document('private', { type: 'job', assignedCrew: ['SomeoneElse'], customer: 'Private Customer', address: '2 Private Way' }),
    document('open', { type: 'job', openShift: true, shiftPickupEnabled: true, customer: 'Open Customer', address: '3 Private Way', serviceType: 'Garage cleanout', crewNeeded: 'not-a-number' }),
  ]), { status: 200 });
  try {
    const response = await route.onRequestGet({ request: new Request('https://easygaragecleaning.com/api/crew-jobs', { headers: { Cookie: cookie } }), env });
    assert.equal(response.status, 200);
    const jobs = (await response.json()).jobs;
    assert.equal(jobs.find(job => job.id === 'mine').customer, 'Assigned Customer');
    assert.equal(jobs.some(job => job.id === 'private'), false);
    assert.equal(jobs.find(job => job.id === 'open').customer, 'Open shift');
    assert.equal(jobs.find(job => job.id === 'open').address, '');
    assert.deepEqual(jobs.find(job => job.id === 'open').assignedCrew, []);
    assert.equal(jobs.find(job => job.id === 'open').assignedTo, '');
    assert.equal(jobs.find(job => job.id === 'open').crewNeeded, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('open shifts cannot be read directly and are claimed with an authenticated atomic server write', async () => {
  const rules = read('firestore.rules');
  assert.doesNotMatch(rules, /allow read:[^;]*openShift/);
  assert.doesNotMatch(rules, /openShiftAssignmentOnly/);

  const route = await import('../functions/api/crew-jobs.js');
  const env = { HUB_SESSION_SECRET: 'crew-claim-test', FIREBASE_API_KEY: 'firebase-test-crew-claim', HUB_AUTH_USERS_JSON: JSON.stringify({ Crewtest: { passwordHash: 'test', displayName: 'Crew Test', role: 'crew' } }) };
  const cookie = (await createHubSessionCookie(env, 'Crewtest', { displayName: 'Crew Test' })).split(';')[0];
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes(':runQuery')) return new Response('[]', { status: 200 });
    if ((options.method || 'GET') === 'GET') return new Response(JSON.stringify({
      name: 'projects/x/databases/(default)/documents/jobs/open-job',
      updateTime: '2026-09-04T18:00:00.000000Z',
      fields: encodeFirestoreFields({ type: 'job', status: 'scheduled', openShift: true, shiftPickupEnabled: true, assignedCrew: [], crewNeeded: 2 }),
    }), { status: 200 });
    return new Response(JSON.stringify({
      name: 'projects/x/databases/(default)/documents/jobs/open-job',
      fields: encodeFirestoreFields({ type: 'job', status: 'scheduled', openShift: true, shiftPickupEnabled: true, assignedCrew: ['Crew Test'], assignedTo: 'Crew Test', crewNeeded: 2 }),
    }), { status: 200 });
  };
  try {
    const request = new Request('https://easygaragecleaning.com/api/crew-jobs', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', jobId: 'open-job' }),
    });
    const response = await route.onRequestPost({ request, env });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.job.assignedCrew, ['Crew Test']);
    const write = calls.find(call => call.options.method === 'PATCH');
    assert.ok(write);
    assert.match(write.url, /currentDocument\.updateTime=/);
    assert.match(read('employee-suite.js'), /window\.opsClaimShift=id=>changeShift\(id,'claim'\)/);
  } finally { globalThis.fetch = originalFetch; }
});

test('crew job rules limit assigned staff to operational fields', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /affectedKeys\(\)\.hasOnly\(\[/);
  assert.match(rules, /'preJobProgress'/);
  assert.match(rules, /'postJobChecklist'/);
  const assignedRule = rules.match(/function assignedUpdateIsSafe\(\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.doesNotMatch(assignedRule, /'customer'|'address'|'priceQuoted'|'total'/);
  assert.match(rules, /ownAvailabilityCreateIsSafe/);
  assert.match(rules, /assignedCustomerCloseoutIsSafe/);
  assert.match(rules, /assignedCustomerPaymentSummaryIsSafe/);
  assert.match(rules, /assignedPaymentUpdateIsSafe/);
  assert.match(rules, /assignedInvoiceUpdateIsSafe/);
  assert.match(rules, /assignedStageUpdateIsSafe/);
  assert.match(rules, /request\.resource\.data\.payment == resource\.data\.payment/);
  assert.match(rules, /preservesVerifiedPaid/);
  assert.match(rules, /resource\.data\.payment\.verified == true/);
  assert.match(rules, /lastPaymentStatus == 'paid'[\s\S]*?job\.payment\.verified == true/);
  assert.match(read('functions/api/job-payment.js'), /recordStripePayment/);
  assert.match(read('functions/api/job-payment.js'), /Payment exceeds the current job balance/);
  assert.match(read('crew/postjob.html'), /verificationSource:'crew_attestation'/);
  assert.match(read('crew/postjob.html'), /pending_verification/);
  assert.match(read('crew/postjob.html'), /verifiedPaidInFull/);
  assert.match(read('functions/api/quo-send.js'), /readJob\(env, jobId\)/);
  assert.match(read('functions/api/quo-send.js'), /assignedToJob\(job, session\)/);
  assert.match(read('crew/prejob.html'), /job_id:ACTIVE\.jobId/);
});

test('public conversion and machine-readable content match the walkthrough flow', () => {
  const publicText = files().filter(path => path.endsWith('.html')).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(publicText, /normalized to E\.164 for Zapier\/Firestore|Google reviews widget goes here|Review slot \d|Add team \/ truck photo|owner to add VIDEO_ID/i);
  assert.doesNotMatch(publicText, /746 Star Grass/i);
  assert.match(read('book.html'), /Please choose a preferred walkthrough window/);
  assert.doesNotMatch(read('book.html'), /name="Preferred timing"/);
  assert.match(read('reviews.html'), /Verified feedback, <em>at the source<\/em>/);
  assert.match(read('404.html'), /name="robots" content="noindex, nofollow"/);
  const llms = read('llms.txt');
  assert.doesNotMatch(llms, /\/(?:employee|crew|copilot|customer-portal|contracts|sop|tyler-contract)(?:\/|\b)/i);
  assert.doesNotMatch(read('ai.txt'), /flat_rate_photo_quote/i);
});

test('site-wide generation remains idempotent and lightweight', () => {
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    const copies = html.match(/\.mobile-quote-sheet\{/g)?.length || 0;
    assert.ok(copies <= 1, `${relative(root, path)} contains ${copies} copies of the mobile-sheet CSS`);
  }
  assert.equal(existsSync(join(root, 'llms-full.txt')), false, 'stale llms-full.txt should remain retired');
  assert.match(read('_redirects'), /\/llms-full\.txt\s+\/llms\.txt\s+301/);
});

test('standalone lead forms expose programmatic field names', () => {
  for (const path of ['estate-cleanout-fort-collins.html', 'fort-collins-junk-removal.html']) {
    const html = read(path);
    for (const name of ['name', 'phone']) {
      const input = html.match(new RegExp(`<input[^>]+name="${name}"[^>]*>`, 'i'))?.[0] || '';
      assert.ok(input, `${path} is missing ${name}`);
      const inputIndex = html.indexOf(input);
      const prefix = html.slice(Math.max(0, inputIndex - 120), inputIndex);
      assert.match(prefix, /<label(?:\s|>)[\s\S]*$/i, `${path} ${name} is not associated with a label`);
    }
  }
});

test('public copy excludes retired seeded stories, placeholders, and unsupported response-time claims', () => {
  const publicText = files()
    .filter(path => path.endsWith('.html') || path.endsWith('.xml') || path.endsWith('.txt'))
    .filter(path => !relative(root, path).split(/[\\/]/).some(part => ['crew', 'contracts', 'functions', 'tests'].includes(part)))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicText, /response within 5 minutes|respond in 5 minutes|reply within 5 minutes|5[- ]min(?:ute)? response|locked flat-rate quote in about 5 minutes/i);
  assert.doesNotMatch(publicText, /YOUR_CODE|TODO\(GADS\)|Before\/after placeholder|placeholder until owner uploads/i);
  assert.doesNotMatch(publicText, /projects\/(?:fort-collins-garage-cleanout-old-town|loveland-storage-unit-cleanout|windsor-garage-junk-removal)/i);
  for (const path of [
    'projects/fort-collins-garage-cleanout-old-town.html',
    'projects/loveland-storage-unit-cleanout.html',
    'projects/windsor-garage-junk-removal.html',
  ]) assert.equal(existsSync(join(root, path)), false, path);
});

test('internal links on public pages resolve to a page, asset, API route, or redirect', () => {
  const redirectSources = new Set(read('_redirects').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/\s+/)[0]));
  const failures = [];
  const excluded = new Set(['employee.html', 'employee-signup.html', 'copilot.html', 'customer-portal.html']);
  const publicFiles = files().filter(path => {
    if (!path.endsWith('.html')) return false;
    const rel = relative(root, path);
    return !excluded.has(rel) && !rel.split(/[\\/]/).some(part => ['crew', 'contracts'].includes(part));
  });
  for (const path of publicFiles) {
    const html = readFileSync(path, 'utf8');
    for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      const raw = match[1];
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/api/')) continue;
      const pathname = raw.split(/[?#]/)[0] || '/';
      if (redirectSources.has(pathname)) continue;
      let local;
      try { local = decodeURIComponent(pathname).replace(/^\//, ''); }
      catch { failures.push(`${relative(root, path)} -> ${pathname}`); continue; }
      const candidates = local ? [local, `${local}.html`, join(local, 'index.html')] : ['index.html'];
      if (!candidates.some(candidate => existsSync(join(root, candidate)))) failures.push(`${relative(root, path)} -> ${pathname}`);
    }
  }
  assert.deepEqual([...new Set(failures)].sort(), []);
});

test('sitemap includes every live indexable standalone service page', () => {
  const sitemap = read('sitemap.xml');
  for (const slug of ['estate-cleanout-fort-collins', 'flat-rate-junk-removal-fort-collins-co', 'garage-cleanouts-laporte-co', 'garage-cleanouts-severance-co', 'garage-guard', 'garage-turnaround-fort-collins-co']) {
    assert.match(sitemap, new RegExp(`https://easygaragecleaning\\.com/${slug}<`), slug);
  }
  assert.doesNotMatch(sitemap, /projects\/(?:fort-collins-garage-cleanout-old-town|loveland-storage-unit-cleanout|windsor-garage-junk-removal)/);
});
