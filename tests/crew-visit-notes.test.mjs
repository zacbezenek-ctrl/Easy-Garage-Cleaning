import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';

// EGC_WALKTHROUGH_NOTES: the crew job page (crew/job.js) and the internal pre-job / closeout briefs (crew/prejob.html,
// crew/postjob.html) show the walkthrough notes the estimator confirmed, the goods sold and the bring list. Synthetic data.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const job = read('crew/job.js'), prejob = read('crew/prejob.html'), postjob = read('crew/postjob.html');
const lineOf = (source, prefix) => { const found = source.split(/\r?\n/).find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };
const NOTES = { jobNotes: ['Clear the left bay first.', 'Stage donations on the driveway.'], itemsNeeded: [{ name: 'Metal shelving unit', quantity: 2, reason: 'Back wall' }, { name: 'Ladder', quantity: null, reason: '' }],
  keepItems: ['Blue bicycle'], removeItems: ['Old couch'], access: ['Side door'], hazards: ['Mouse droppings by the freezer'], confirmedAt: '2026-10-19T16:00:00.000Z', confirmedBy: 'rep.one' };

function jobPage() {
  const context = vm.createContext({});
  vm.runInContext([lineOf(job, '  const esc = '), lineOf(job, '  const stamp = '), job.slice(job.indexOf('  function block('), job.indexOf('  function pendingCard()'))].join('\n') + '\nthis.api = { visitNotesBlocks };', context);
  return context.api;
}
const crewJob = (extra = {}) => ({ keepItems: '', removeItems: '', access: [], accessInstructions: '', hazards: [], visitNotes: NOTES, ...extra });

test('the crew job page shows the confirmed notes and items needed; keep, remove, access and hazards only where the signed brief has none', () => {
  const { visitNotesBlocks } = jobPage();
  const html = visitNotesBlocks(crewJob());
  assert.match(html, /<h3>Walkthrough notes \(confirmed by the estimator: rep\.one, Oct 19, 10:00 AM\)<\/h3><div class="text-block">Clear the left bay first\.\nStage donations on the driveway\.<\/div>/);
  assert.match(html, /<h3>Items needed<\/h3><div class="text-block">2 × Metal shelving unit – Back wall\nLadder<\/div>/);
  for (const label of ['Keep (walkthrough notes)', 'Remove (walkthrough notes)', 'Access (walkthrough notes)', 'Hazards (walkthrough notes)']) assert.ok(html.includes(label), label);
  const signed = visitNotesBlocks(crewJob({ keepItems: 'Workbench', removeItems: 'Boxes', access: ['Front door'], hazards: ['Nails'] }));
  for (const label of ['Keep (walkthrough notes)', 'Remove (walkthrough notes)', 'Access (walkthrough notes)', 'Hazards (walkthrough notes)']) assert.equal(signed.includes(label), false, label);
  assert.equal(visitNotesBlocks(crewJob({ visitNotes: null })), '', 'no confirmed notes, nothing new on the page');
  assert.match(visitNotesBlocks(crewJob({ visitNotes: { ...NOTES, jobNotes: ['<img src=x onerror=alert(1)>'] } })), /&lt;img src=x onerror=alert\(1\)&gt;/, 'escaped');
  assert.match(job, /\$\{visitNotesBlocks\(j\)\}<\/section><section class="card" id="checklist-card">/, 'rendered at the end of Scope & instructions');
});

// The page's own functions, as tests/operational-instructions.test.mjs runs them, on a Firestore job.
function brief(source, job) {
  const host = { innerHTML: '' };
  const functions = ['normalizedInstructions', 'renderJobBrief'].map(name => lineOf(source, `function ${name}(`)).join('\n');
  const context = { ACTIVE: job, document: { getElementById: () => host }, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), textList: value => Array.isArray(value) ? value.join(', ') : String(value ?? '') };
  vm.createContext(context);
  vm.runInContext(`${functions}\nrenderJobBrief();`, context);
  const first = host.innerHTML;
  // The page keeps the normalized copy and renders from it again: the same brief.
  context.ACTIVE = { instructions: vm.runInContext('normalizedInstructions(ACTIVE)', context), visitNotes: undefined };
  vm.runInContext('renderJobBrief()', context);
  return { first, again: host.innerHTML };
}
const cell = (html, label) => new RegExp(`<small>${label.replace(/[()]/g, '\\$&')}</small><strong>([^<]*)</strong>`).exec(html)?.[1] ?? null;

test('the internal pre-job and closeout briefs show the confirmed notes, the items needed, the goods sold and the bring list', () => {
  const job = { visitNotes: NOTES, jobInstructions: { customerGoal: 'Park two cars', bringList: ['Hand truck / dolly', 'Ladder'], materials: [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4 }, { id: 'quote-hooks', name: 'Bike hooks <b>', quantity: 1 }] } };
  const notesText = 'Clear the left bay first. · Stage donations on the driveway. · Keep: Blue bicycle · Remove: Old couch · Access: Side door · Hazards: Mouse droppings by the freezer';
  const items = '2 × Metal shelving unit – Back wall · Ladder';
  const pre = brief(prejob, job), post = brief(postjob, job);
  for (const html of [pre.first, pre.again]) {
    assert.equal(cell(html, 'Materials'), '4 × Metal shelving unit · Bike hooks &lt;b&gt;', 'the Materials row names the goods sold');
    assert.equal(cell(html, 'Bring'), 'Hand truck / dolly, Ladder');
    assert.equal(cell(html, 'Walkthrough notes (confirmed by the estimator)'), notesText);
    assert.equal(cell(html, 'Items needed'), items);
  }
  for (const html of [post.first, post.again]) {
    assert.equal(cell(html, 'Materials sold'), '4 × Metal shelving unit · Bike hooks &lt;b&gt;');
    assert.equal(cell(html, 'Walkthrough notes (confirmed by the estimator)'), notesText);
    assert.equal(cell(html, 'Items needed'), items);
  }
  // Without a builder quote's goods the Materials row keeps the Finish step's counts; without notes nothing new shows.
  const plain = brief(prejob, { scope: { finish_details: { shelf_type: 'metal', shelf_qty: 2, tote_qty: 3 } }, jobInstructions: { customerGoal: 'Park two cars' } }).first;
  assert.equal(cell(plain, 'Materials'), '2 metal shelf unit(s) · 3 tote(s)');
  for (const label of ['Bring', 'Walkthrough notes (confirmed by the estimator)', 'Items needed']) assert.equal(cell(plain, label), null, label);
  // A job with only confirmed notes has a brief.
  assert.match(brief(prejob, { visitNotes: NOTES }).first, /Walkthrough notes \(confirmed by the estimator\)/);
  assert.match(brief(postjob, { visitNotes: NOTES }).first, /Walkthrough notes \(confirmed by the estimator\)/);
  // The signed brief's own keep, remove, access and hazards rows are not repeated inside the notes row (as crew/job.js).
  const signed = { visitNotes: NOTES, jobInstructions: { customerGoal: 'Park two cars', keepItems: 'Workbench', removeItems: 'Boxes', access: ['Front door'], hazards: ['Nails'] } };
  for (const html of [brief(prejob, signed).first, brief(postjob, signed).first]) assert.equal(cell(html, 'Walkthrough notes (confirmed by the estimator)'), 'Clear the left bay first. · Stage donations on the driveway.');
  const partly = { visitNotes: NOTES, jobInstructions: { customerGoal: 'Park two cars', keepItems: 'Workbench', accessNotes: 'Code at the side gate' } };
  assert.equal(cell(brief(prejob, partly).first, 'Walkthrough notes (confirmed by the estimator)'), 'Clear the left bay first. · Stage donations on the driveway. · Remove: Old couch · Hazards: Mouse droppings by the freezer');
});

// Integration review (2026-10-21): a walkthrough-signed job always carries scope.keep_remove (the sorting method, keep
// and remove notes run together for HighLevel). With the Remove box left empty it was shown as the job's removal list
// ("Remove: customer") and hid the Remove / donate notes the estimator confirmed.
test('a signed walkthrough with an empty Remove box shows the confirmed Remove notes, never its sorting method as Remove', () => {
  const signed = { id: 'job-notes', type: 'job', status: 'scheduled', customer: 'Synthetic Customer', visitNotes: NOTES,
    scope: { sort_method: 'customer', keep_items: '', remove_items: '', keep_remove: 'customer' },
    jobInstructions: { customerGoal: 'Park two cars', sortMethod: 'customer', keepItems: '', removeItems: '' } };
  const projected = fieldJobProjection(signed);
  assert.equal(projected.removeItems, '', 'no removal list of its own');
  const html = jobPage().visitNotesBlocks(projected);
  assert.match(html, /<h3>Remove \(walkthrough notes\)<\/h3><div class="text-block">Old couch<\/div>/);
  for (const source of [prejob, postjob]) assert.match(cell(brief(source, signed).first, 'Walkthrough notes (confirmed by the estimator)') || '', /Remove: Old couch/);
  assert.equal(cell(brief(prejob, signed).first, 'Remove'), null, 'no "Remove: customer" row');
  // Its own Remove box filled in: that is the list, and the notes' Remove is not repeated.
  const own = { ...signed, scope: { ...signed.scope, remove_items: 'Boxes', keep_remove: 'customer · Boxes' }, jobInstructions: { ...signed.jobInstructions, removeItems: 'Boxes' } };
  assert.equal(fieldJobProjection(own).removeItems, 'Boxes');
  assert.equal(jobPage().visitNotesBlocks(fieldJobProjection(own)).includes('Remove (walkthrough notes)'), false);
  // A job from before the walkthrough recorded remove lists keeps keep_remove as its list, as before.
  const legacy = { id: 'job-legacy', type: 'job', status: 'scheduled', scope: { keep_remove: 'Old boxes' } };
  assert.equal(fieldJobProjection(legacy).removeItems, 'Old boxes');
  assert.equal(cell(brief(prejob, legacy).first, 'Remove'), 'Old boxes');
});

test('the gameplan notes panel: the form round-trips the notes, and each server answer picks what the panel shows', () => {
  const context = vm.createContext({ Date });
  vm.runInContext(read('crew/gameplan-notes.js'), context);
  const { notesToForm, formToNotes, panelMode } = context.EGCWalkthroughNotes;
  const form = notesToForm(NOTES);
  assert.equal(form.jobNotes, 'Clear the left bay first.\nStage donations on the driveway.');
  assert.deepEqual(JSON.parse(JSON.stringify(form.itemsNeeded)), [{ name: 'Metal shelving unit', quantity: '2', reason: 'Back wall' }, { name: 'Ladder', quantity: '', reason: '' }]);
  form.jobNotes += '\n\n  Bring the long ladder.  '; form.itemsNeeded.push({ name: ' ', quantity: '3', reason: 'blank names are dropped' }, { name: 'Anchors', quantity: 'ten', reason: '' });
  const notes = JSON.parse(JSON.stringify(formToNotes(form)));
  assert.deepEqual(notes.jobNotes, ['Clear the left bay first.', 'Stage donations on the driveway.', 'Bring the long ladder.']);
  assert.deepEqual(notes.itemsNeeded, [{ name: 'Metal shelving unit', quantity: 2, reason: 'Back wall' }, { name: 'Ladder', quantity: null, reason: '' }, { name: 'Anchors', quantity: null, reason: '' }]);
  const view = extra => ({ enabled: true, outcome: { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, parts: [], complete: false, draft: null, confirmed: null, status: 'empty', ...extra });
  assert.equal(panelMode(null), 'hidden'); assert.equal(panelMode({ enabled: false }), 'hidden');
  assert.equal(panelMode(view({ outcome: null })), 'hidden', 'before Finish the recorder card is enough');
  assert.equal(panelMode(view({ outcome: { outcome: 'customer_no_show', recordingStatus: null } })), 'hidden');
  assert.equal(panelMode(view()), 'waiting');
  assert.equal(panelMode(view({ outcome: { outcome: 'quote_to_follow', recordingStatus: 'declined' } })), 'none');
  assert.equal(panelMode(view({ parts: [{ status: 'done' }], expectedParts: 2 })), 'transcribing');
  assert.equal(panelMode(view({ parts: [{ status: 'done' }], complete: true })), 'ready');
  assert.equal(panelMode(view({ draft: NOTES, draftedAt: '2026-10-19T16:00:00.000Z' })), 'editor');
  assert.equal(panelMode(view({ draft: NOTES, draftedAt: '2026-10-19T16:00:00.000Z', confirmed: { ...NOTES, confirmedAt: '2026-10-19T16:05:00.000Z' } })), 'confirmed');
  assert.equal(panelMode(view({ draft: NOTES, draftedAt: '2026-10-19T16:10:00.000Z', confirmed: { ...NOTES, confirmedAt: '2026-10-19T16:05:00.000Z' } })), 'editor', 'notes written from newer audio wait for a confirm');
  assert.equal(panelMode(view({ status: 'withdrawn' })), 'withdrawn');
  assert.equal(panelMode(view(), { manual: true }), 'editor');
  // Every part refused for good (unreadable, too long): the estimator types the notes.
  assert.equal(panelMode(view({ parts: [{ status: 'failed', errorCode: 'recording_audio_unreadable' }], complete: true })), 'failed');
  assert.equal(panelMode(view({ parts: [{ status: 'failed', errorCode: 'recording_unavailable' }], expectedParts: 1 })), 'transcribing');
});

test('the gameplan notes panel: one status line says where the notes stand while it is closed', () => {
  const context = vm.createContext({ Date });
  vm.runInContext(read('crew/gameplan-notes.js'), context);
  const { statusLine, failedLines } = context.EGCWalkthroughNotes;
  const view = extra => ({ enabled: true, canConfirm: true, parts: [], expectedParts: null, confirmed: null, ...extra });
  assert.equal(statusLine(view({ parts: [{ status: 'done' }, { status: 'failed', errorCode: 'recording_unavailable' }], expectedParts: 2 }), 'transcribing'), 'Transcribing: 1 of 2 parts done');
  assert.equal(statusLine(view(), 'ready'), 'The transcript is ready');
  assert.equal(statusLine(view(), 'ready', { busy: true }), 'Writing up the notes from the transcript…');
  assert.equal(statusLine(view(), 'editor'), 'Notes ready to check and confirm');
  assert.equal(statusLine(view({ canConfirm: false }), 'editor'), 'Draft notes: the estimator confirms them');
  assert.equal(statusLine(view({ confirmed: NOTES, confirmedJobs: 1 }), 'confirmed'), 'Sent to the crew lead and crew');
  assert.equal(statusLine(view({ confirmed: NOTES, confirmedJobs: 0 }), 'confirmed'), 'Confirmed: they go to the crew with the job');
  assert.equal(statusLine(view({ confirmed: NOTES, confirmedJobs: 1, confirmedStale: true }), 'confirmed'), 'New audio arrived after these notes were confirmed');
  assert.equal(statusLine(view(), 'failed'), 'The audio could not be transcribed: type the notes');
  assert.deepEqual([...failedLines(view({ parts: [{ status: 'done', partIndex: 1 }, { status: 'failed', partIndex: 2, errorCode: 'recording_too_long' }, { status: 'failed', source: 'import', errorCode: 'recording_unavailable' }] }))],
    ['Part 2 could not be transcribed: it is too long to transcribe (split it in Voice Memos and add each part).', 'Voice Memos file: transcription is unavailable right now. The audio stays on the iPad and is sent again.']);
});

