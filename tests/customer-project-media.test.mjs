// The portal's photos and videos button (projectMedia, a Google Drive link the office saves from the Hub finance card)
// and the finished-job tidy-up: a completed or paid job hides the job-day plan, photo upload and paid closeout note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { customerProjectMedia, projectMediaUrl } from '../functions/_lib/customer-project-media.js';
import { fakeDom, portalCookie, portalHandlers, portalScript, portalStore, portalView } from './helpers/portal-fixture.mjs';

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const FOLDER = 'https://drive.google.com/drive/folders/1SyntheticFolderId_abc-123';
const FILE = 'https://drive.google.com/file/d/1SyntheticFileId_xyz-789/view';
const person = { id: 'person-1', name: 'Synthetic Family', email: 'family@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } };
const job = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800,
  status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-25', time: '09:00', customerCollaborators: [person], ...extra,
});

test('only a Google Drive folder or file link is served, rebuilt from its id', () => {
  for (const [input, expected] of [
    [FOLDER, FOLDER],
    [`${FOLDER}?usp=sharing`, FOLDER],
    ['https://drive.google.com/drive/u/0/folders/1SyntheticFolderId_abc-123?usp=drive_link', FOLDER],
    [`  ${FOLDER}/  `, FOLDER],
    [FILE, FILE],
    ['https://drive.google.com/file/d/1SyntheticFileId_xyz-789/view?usp=sharing#t=10', FILE],
  ]) assert.equal(projectMediaUrl(input), expected, input);
  for (const bad of [
    '', null, undefined, 42, {}, 'http://drive.google.com/drive/folders/1SyntheticFolderId_abc-123',
    'https://drive.google.com.example.invalid/drive/folders/1SyntheticFolderId_abc-123', 'https://example.invalid/drive/folders/1SyntheticFolderId_abc-123',
    'https://docs.google.com/document/d/1SyntheticFileId_xyz-789/edit', 'https://drive.google.com/drive/folders/short', 'javascript:alert(1)',
    'https://drive.google.com/drive/folders/1Synthetic"><script>', `${FOLDER}?x=${'a'.repeat(500)}`,
  ]) assert.equal(projectMediaUrl(bad), '', String(bad));
  assert.deepEqual(customerProjectMedia(job({ projectMedia: { url: `${FOLDER}?usp=sharing`, updatedBy: 'Synthetic.Manager', updatedAt: '2026-10-29T18:00:00.000Z' } })), { url: FOLDER }, 'who saved it stays internal');
  assert.equal(customerProjectMedia(job()), null);
  assert.equal(customerProjectMedia(job({ projectMedia: null })), null);
});

test('the portal serves the Drive link to the homeowner and family, and keeps its shape without one', async t => {
  const f = portalStore(t, { 'job-1': job({ projectMedia: { url: `${FOLDER}?usp=sharing`, updatedBy: 'Synthetic.Manager' } }), 'job-2': job(), 'job-3': job({ projectMedia: { url: 'https://example.invalid/videos' } }) });
  const handlers = portalHandlers();
  for (const cookie of [await portalCookie(), await portalCookie('job-1', { actorId: 'person-1', permissions: person.permissions })]) {
    const view = await portalView(handlers, cookie);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.projectMedia, { url: FOLDER });
  }
  for (const id of ['job-2', 'job-3']) {
    const view = await portalView(handlers, await portalCookie(id));
    assert.equal(view.status, 200);
    assert.equal('projectMedia' in view.body, false, `${id} has no projectMedia key`);
  }
  assert.deepEqual(f.writes, [], 'reading the portal saves nothing');
});

function portalRealm() {
  const { node } = fakeDom(), rule = { classList: fakeDom().node('rule').classList };
  const context = vm.createContext({ $: id => { const n = node(id); if (id === 'pay-button') n.closest = () => ({ querySelector: () => rule }); return n; }, setText: (id, value) => { node(id).textContent = value; }, render: () => {} });
  vm.runInContext(portalScript(html, ['function projectMediaUrl(', 'function renderProjectMedia(', 'function renderFinished(', 'const renderPortalProject=render;', 'render=data=>{renderPortalProject(data);']), context);
  return { context, node, rule };
}
const view = (status, extra = {}) => ({ appointment: { status }, estimate: { status: 'approved' }, payment: { balance: 0, needsReview: false }, ...extra });

test('a completed or paid job hides the job-day plan, photo upload and paid closeout note; a scheduled one keeps them', () => {
  const { context, node, rule } = portalRealm();
  for (const status of ['completed', 'paid']) {
    context.render(view(status));
    assert.deepEqual([node('jobday-card').classList.contains('hidden'), node('upload-card').classList.contains('hidden'), rule.classList.contains('hidden')], [true, true, true], status);
    assert.deepEqual([node('appointment-title').textContent, node('estimate-title').textContent], ['Your completed service', 'Your approved estimate']);
  }
  rule.classList.remove('hidden');
  context.render(view('scheduled', { estimate: { status: 'sent' }, payment: { balance: 400 } }));
  assert.deepEqual([node('jobday-card').classList.contains('hidden'), node('upload-card').classList.contains('hidden'), rule.classList.contains('hidden')], [false, false, false]);
  assert.deepEqual([node('appointment-title').textContent, node('estimate-title').textContent], ['Your scheduled service', 'Review and approve']);
  for (const payment of [{ balance: 250 }, { balance: 0, needsReview: true }, { balance: 0, withheld: true }]) {
    context.render(view('completed', { payment }));
    assert.equal(rule.classList.contains('hidden'), false, `the closeout note stays for ${JSON.stringify(payment)}`);
  }
});

test('the photos and videos card shows only a plain Drive link and hides again when it is removed', () => {
  const { context, node } = portalRealm();
  context.render(view('paid', { projectMedia: { url: FOLDER } }));
  assert.equal(node('media-card').classList.contains('hidden'), false);
  assert.equal(node('media-link').href, FOLDER);
  for (const url of ['https://example.invalid/videos', `${FOLDER}?usp=sharing`, 'javascript:alert(1)', undefined]) {
    context.render(view('paid', { projectMedia: url === undefined ? undefined : { url } }));
    assert.equal(node('media-card').classList.contains('hidden'), true, String(url));
    assert.equal(node('media-link').hasAttribute('href'), false, String(url));
  }
  assert.match(html, /id="media-link" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(portalScript(html, ['function renderProjectMedia(', 'function renderFinished(']), /innerHTML|insertAdjacentHTML|outerHTML/);
});

function hubRealm(answer) {
  const saved = [], toasts = [], rows = [{ id: 'job-1', customer: 'Synthetic Customer' }];
  const context = vm.createContext({
    window: {}, jobs: () => rows, askAction: async () => answer, patchJob: async (id, update) => { saved.push([id, update]); }, render: () => {},
    showToast: message => toasts.push(message), employeeIdentity: () => 'Synthetic.Manager',
  });
  const line = prefix => suite.split(/\r?\n/).find(item => item.startsWith(prefix));
  vm.runInContext([line('function projectMediaLink('), line('window.opsProjectMedia=')].join('\n'), context);
  return { context, saved, toasts };
}

test('the Hub saves the Drive link rebuilt from its id, refuses other links and removes it when blank', async () => {
  const kept = hubRealm({ url: `${FOLDER}?usp=sharing` });
  await kept.context.window.opsProjectMedia('job-1');
  assert.equal(kept.saved.length, 1);
  const [id, update] = kept.saved[0];
  assert.equal(id, 'job-1');
  assert.deepEqual({ ...update.projectMedia, updatedAt: 'x' }, { url: FOLDER, updatedAt: 'x', updatedBy: 'Synthetic.Manager' });
  assert.deepEqual(kept.toasts, ['Portal photos and videos link saved']);
  const refused = hubRealm({ url: 'https://example.invalid/videos' });
  await refused.context.window.opsProjectMedia('job-1');
  assert.deepEqual([refused.saved, refused.toasts], [[], ['Use a Google Drive folder or file link']]);
  const removed = hubRealm({ url: '' });
  await removed.context.window.opsProjectMedia('job-1');
  assert.equal(removed.saved[0][1].projectMedia, null);
  assert.deepEqual(removed.toasts, ['Portal photos and videos link removed']);
  const cancelled = hubRealm(null);
  await cancelled.context.window.opsProjectMedia('job-1');
  assert.deepEqual(cancelled.saved, []);
  for (const url of [FOLDER, FILE, `${FILE}?usp=sharing`, 'https://drive.google.com/drive/u/1/folders/1SyntheticFolderId_abc-123']) {
    const hub = hubRealm({ url }), server = projectMediaUrl(url);
    await hub.context.window.opsProjectMedia('job-1');
    assert.equal(hub.saved[0][1].projectMedia.url, server, 'the Hub and the portal read a link the same way');
  }
});
