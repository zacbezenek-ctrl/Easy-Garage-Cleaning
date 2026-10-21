// Portal link texts stay in the GSM-7 basic character set. One character outside it (an em dash, a curly quote, an
// ellipsis, a bullet) makes the whole SMS a UCS-2 message: 70 characters a segment instead of 160 (67 instead of 153
// once split), so a portal text with its 30-day link would take about twice as many segments. Every variant is checked
// with the longest first name the sender keeps (50 characters, portal-invitation.js), a short one and none, and a portal
// link minted like a real one (customer-portal.js with a synthetic secret, for a dispatch visit id). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_MESSAGES, portalLinkPreviews } from '../functions/_lib/portal-invitation.js';
import { createCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import { AUTOMATION_REGISTRY } from '../functions/_lib/automation-registry-data.js';

// 3GPP TS 23.038 default alphabet, basic set only (the extension set ^ { } \ [ ~ ] | € costs two septets, so it is
// left out too). LF and CR are allowed; ESC (0x1B) is not a character a text should contain.
const GSM7_BASIC = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const outsideGsm7 = text => [...new Set([...text].filter(character => !GSM7_BASIC.has(character)))];
// Segments as a carrier counts them: GSM-7 160 in one message, 153 a part once split; UCS-2 70, 67 a part.
function segments(text) {
  const gsm = outsideGsm7(text).length === 0, units = gsm ? text.length : [...text].reduce((sum, character) => sum + (character.codePointAt(0) > 0xffff ? 2 : 1), 0);
  const single = gsm ? 160 : 70, part = gsm ? 153 : 67;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', length: units, segments: units <= single ? 1 : Math.ceil(units / part) };
}

const SMS = Object.entries(PORTAL_MESSAGES).map(([variant, message]) => [variant, message.sms]);
// portal-invitation.js keeps the first word of the customer's name, without < or >, at most 50 characters.
const LONG_FIRST = 'Maximiliano-Bartholomew-Christopherson-Wellingtonn';
async function realisticUrl() {
  // dispatch-service.js names a booked visit visit_<40 hex>; the link's account root is such a job too.
  const id = `visit_${'3f2c9a4e8b1d4c6f9e2a7d5b1c0e4f8a12345678'}`;
  const token = await createCustomerPortalAccessToken({ CUSTOMER_PORTAL_SECRET: 'synthetic-gsm7-portal-secret-0123456789abcdef' }, id, Date.parse('2026-10-21T18:00:00.000Z'), 12, id);
  return `https://easygaragecleaning.com/api/customer-portal-session?access=${encodeURIComponent(token)}`;
}

test('every portal SMS variant is GSM-7 basic-set text, with a long first name, without a name, and with a real-shaped link', async t => {
  assert.equal(LONG_FIRST.length, 50);
  assert.deepEqual(SMS.map(([variant]) => variant), ['approved', 'quote_ready', 'quote_ready_no_deposit', 'job_done_balance', 'job_done_paid'], 'a new variant is checked here too');
  const url = await realisticUrl();
  assert.deepEqual(outsideGsm7(url), [], 'the link itself is GSM-7');
  for (const [variant, sms] of SMS) {
    for (const [who, first] of [['long name', LONG_FIRST], ['short name', 'Pat'], ['no name', '']]) {
      const body = sms(first, url), count = segments(body);
      assert.deepEqual(outsideGsm7(body), [], `${variant} (${who}) has a character outside GSM-7`);
      assert.equal(count.encoding, 'GSM-7');
      // The link is most of the text: with it every variant is three plain segments for an ordinary name, and at most
      // four for the longest name kept (with the em dash the job-done texts were UCS-2: seven segments, eight with the longest name).
      assert.ok(count.segments <= (who === 'long name' ? 4 : 3), `${variant} (${who}): ${count.segments} segments`);
      t.diagnostic(`${variant} (${who}): ${count.length} characters, ${count.segments} GSM-7 segment${count.segments === 1 ? '' : 's'}`);
    }
    // The wording alone (no name, no link) is a single segment.
    assert.equal(segments(sms('', '')).segments, 1, variant);
  }
});

test('the job-done texts end their first sentence with a full stop, not an em dash; their emails keep the typography', () => {
  for (const variant of ['job_done_balance', 'job_done_paid']) {
    assert.match(PORTAL_MESSAGES[variant].sms('Pat', 'https://x.invalid/l'), /^Hi Pat, your Easy Garage Cleaning job is done\. Thank you! /);
    assert.match(PORTAL_MESSAGES[variant].html('https://x.invalid/l'), /job is done — thank you!/);
  }
  // The Hub's switch screen shows the same words ({first} and {portal link} stand in for the name and link).
  const previews = portalLinkPreviews();
  for (const text of [previews.quote_ready.deposit, previews.quote_ready.no_deposit, previews.job_done.balance, previews.job_done.paid]) assert.deepEqual(outsideGsm7(text.replace(/\{first\}|\{portal link\}/g, '')), [], text);
});

test('the registry\'s portal SMS templates (docs/automation-registry.md) are the GSM-7 texts that are sent', () => {
  const ids = { 'hub.portal_invitation': 'approved', 'hub.portal_quote_ready': 'quote_ready', 'hub.portal_quote_ready_no_deposit': 'quote_ready_no_deposit', 'hub.portal_job_done': 'job_done_balance', 'hub.portal_job_done_paid': 'job_done_paid' };
  for (const [id, variant] of Object.entries(ids)) {
    const entry = AUTOMATION_REGISTRY.automations.find(item => item.id === id);
    assert.equal(entry.channel, 'SMS', id);
    assert.deepEqual(outsideGsm7(entry.templateText.replace(/\{\{(opening|portalLink)\}\}/g, '')), [], id);
    assert.equal(entry.templateText.replace('{{opening}}', 'Hi Pat, your').replace('{{portalLink}}', 'https://x.invalid/l'), PORTAL_MESSAGES[variant].sms('Pat', 'https://x.invalid/l'), id);
    assert.doesNotMatch(entry.notes || '', /Unicode SMS/, id);
  }
});

test('the segment counter counts like a carrier', () => {
  assert.deepEqual(segments('a'.repeat(160)), { encoding: 'GSM-7', length: 160, segments: 1 });
  assert.deepEqual(segments('a'.repeat(161)), { encoding: 'GSM-7', length: 161, segments: 2 });
  assert.deepEqual(segments(`${'a'.repeat(69)}—`), { encoding: 'UCS-2', length: 70, segments: 1 });
  assert.deepEqual(segments(`${'a'.repeat(70)}—`), { encoding: 'UCS-2', length: 71, segments: 2 });
  for (const character of ['—', '–', '’', '‘', '“', '”', '…', '•', '€', '{', '[', '~', '^', '|', '\\']) assert.deepEqual(outsideGsm7(`a${character}b`), [character], character);
  assert.deepEqual(outsideGsm7('Hi Zoë-Ångström, café ñ ü @ £ $ _'), ['ë'], 'é, Å, ö, ñ, ü are in the basic set; ë is not');
});
