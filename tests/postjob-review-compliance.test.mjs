import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Google's review policy prohibits incentives for reviews and steering what a
// customer writes; the FTC rule on consumer reviews bans conditioning a reward
// on a review. The post-job review ask must stay neutral, and the referral
// reward must never share a script (or a breath) with it.
const postjob = fs.readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8');
const INCENTIVE = /%\s*off|discount|gift card|\$\d|coupon|free\s+(?:service|pickup|haul)|thank-you for choosing/i;
const STEERING = /photos are gold|mention the garage|5[- ]star|five[- ]star|say (?:something|how)/i;

function block(marker) {
  const start = postjob.indexOf(marker);
  assert.ok(start > -1, `missing ${marker} block`);
  return postjob.slice(start, postjob.indexOf(']}', start));
}

test('review SMS is a neutral ask with no incentive and ends with the review link', () => {
  const fn = postjob.slice(postjob.indexOf('async function sendReview'), postjob.indexOf('// Canonical job execution'));
  const message = (fn.match(/message:`([^`]*)`/) || [])[1];
  assert.ok(message, 'review_request message template not found');
  assert.doesNotMatch(message, INCENTIVE);
  assert.doesNotMatch(message, STEERING);
  assert.match(message, /honest Google review/);
  assert.match(message, /\$\{REVIEW_LINK\|\|"\[REVIEW LINK\]"\}$/);
  assert.match(fn, /tool:"review_request"/);
});

test('spoken review script is neutral and separate from the referral reward', () => {
  const review = block('script:{h:"Review ask');
  assert.match(review, /Review ask/);
  assert.match(review, /good or bad/i);
  assert.doesNotMatch(review, INCENTIVE);
  assert.doesNotMatch(review, STEERING);

  const referral = block('referral:{h:');
  assert.match(referral, /separate moment/i);
  assert.match(referral, /\$50 EGC gift card/);
  assert.match(referral, /never tied to leaving a review/i);
  assert.match(postjob, /sec\.referral\?`<div class="script referral-script">/);
});

test('old incentive and steering copy is gone from the post-job playbook', () => {
  assert.doesNotMatch(postjob, /10% off your next service/);
  assert.doesNotMatch(postjob, /photos are gold/i);
  assert.doesNotMatch(postjob, /Review \+ referral — exact words/);
});
