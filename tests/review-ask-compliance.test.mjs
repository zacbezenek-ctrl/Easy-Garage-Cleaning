import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Google's review policy and the FTC's 2024 consumer-review rule (16 CFR 465): a review ask carries no reward and goes
// to every customer. The crew closeout copies the review ask and the referral ask as separate texts.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const REWARD = /gift|discount|% off|percent off|coupon|free|thank-you|reward|referr|neighbou?r|in it for you/i;

function postjob() {
  const html = read('crew/postjob.html'), lines = html.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('const SECTIONS = ['));
  const end = lines.findIndex((line, index) => index > start && line === '];');
  const helper = lines.find(line => line.startsWith('function scriptText('));
  assert.ok(start >= 0 && end > start && helper, 'crew/postjob.html keeps SECTIONS and scriptText');
  const context = vm.createContext({ guardYearOneFree: () => false });
  vm.runInContext(`${lines.slice(start, end + 1).join('\n').replace('const SECTIONS', 'var SECTIONS')}\n${helper}`, context);
  return { html, context };
}

test('the copied review ask has no reward and no referral, and the referral is its own copied text', () => {
  const { context } = postjob(), section = context.SECTIONS.find(item => item.referral);
  assert.ok(section, 'the review section carries a separate referral script');
  const review = context.scriptText(section.script.p, 'Pat', ''), referral = context.scriptText(section.referral.p, 'Pat', '');
  assert.match(review, /review/i);
  assert.doesNotMatch(review, REWARD, 'the review ask a crew lead copies never mentions a reward or the referral');
  assert.match(referral, /gift card/);
  assert.doesNotMatch(referral, /review/i, 'the referral ask never mentions a review');
});

test('copied text drops the stage directions meant for the crew', () => {
  const { context } = postjob();
  assert.equal(context.scriptText(['“Come take a look.” <i>(Open the door.)</i>', '<b>Say</b> “[THEIR PAIN] is over.”'], 'Pat', 'parking in the snow'), '“Come take a look.”\n\nSay “parking in the snow is over.”');
});

test('the review text the crew sends and the Co-Pilot review steps ask every customer, with no reward', () => {
  const { html } = postjob(), sent = html.match(/tool:"review_request"[\s\S]*?message:`([^`]*)`/)[1];
  assert.doesNotMatch(sent, REWARD);
  const sop = read('functions/api/copilot.js'), steps = sop.slice(sop.indexOf('SOP 5 — JOB COMPLETION'), sop.indexOf('SOP 1B'));
  assert.ok(steps.length > 0, 'the Co-Pilot job-completion SOP is present');
  assert.doesNotMatch(steps, /if we (earned it|did right by you)/i, 'the review ask is never conditioned on the customer being happy');
  assert.match(steps, /Every customer gets it/);
  assert.doesNotMatch(steps.slice(steps.indexOf('Review request text:')), REWARD);
});
