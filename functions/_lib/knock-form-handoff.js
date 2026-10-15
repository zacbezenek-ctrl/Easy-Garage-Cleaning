// Native GHL intake is an evidence ledger, not a sale, appointment, contract or money event.
import { knockFailure, safeDocId, write } from './knock-store.js';
import { requireActive } from './knock-access.js';
import { houseInScope, repTerritory } from './knock-territory.js';
import { effectiveKnocks } from '../../crew/knock-doors.js';
import { normalizePhone } from './knock-sales.js';
import { FORM_CHANNELS, nativeFormSetup } from './knock-form-config.js';
import { formDigest, nativeHouseClaimId, nativeClaimActive, nativeClaimGeneration } from './knock-form-claims.js';

const REFERENCE = /^kf_[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,180}$/;
const fail = (message, code = 'knock_form_invalid', status = 409) => knockFailure(message, status, code);
const mappingDigest = (config, form) => formDigest([config.locationId, form.formId, form.url, form.referenceFieldId, form.referenceQueryKey, form.acceptance,
  ...(form.channelFieldId ? [form.channelFieldId, form.channelValue] : [])]);

export function onlyFormFields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)))
    throw fail('Unrecognized native form fields. Attribution comes from your signed-in session.', 'knock_form_fields', 400);
}

async function houseFor(store, rep, settings, houseId) {
  requireActive(rep);
  safeDocId(houseId);
  const [house, territory] = await Promise.all([store.get('knock_houses', houseId), repTerritory(store, rep, settings)]);
  if (!house || house.excluded || house.noKnock || house.jurisdictionHold || !houseInScope(house, territory) ||
      territory.neighborhoods.find(n => n.id === house.neighborhoodId)?.locked !== false)
    throw fail('This house is not available in your assigned territory.', 'knock_form_house', 403);
  return house;
}

async function sourceFor(store, rep, house, source) {
  onlyFormFields(source, ['kind', 'id', 'revision']);
  if (!['quote', 'sale'].includes(source.kind) || typeof source.id !== 'string') throw fail('Choose a saved quote or sale.', 'knock_form_source');
  safeDocId(source.id);
  const collection = source.kind === 'sale' ? 'knock_sales' : 'knock_events';
  const raw = await store.get(collection, source.id);
  if (!raw || raw.repKey !== rep.repKey || raw.houseId !== house.id || !raw.__updateTime)
    throw fail('This saved source is not available to your rep.', 'knock_form_source', 403);
  let canonical = raw;
  const guards = [write.verify(collection, raw.id, raw.__updateTime), write.verify('knock_houses', house.id, house.__updateTime)];
  const fence = await store.get('knock_form_revisions', house.id);
  guards.push(fence ? write.verify('knock_form_revisions', house.id, fence.__updateTime) : write.verifyMissing('knock_form_revisions', house.id));
  let directSold = source.kind === 'sale';
  if (source.kind === 'quote') {
    // A voided/edited look is not the old quote. Include the whole effective history in its revision.
    const history = await store.query('knock_events', { where: [['houseId', '==', house.id]] });
    directSold = effectiveKnocks(history).some(event => event.outcome === 'sold');
    canonical = effectiveKnocks(history).find(event => event.id === raw.id);
    if (!canonical || canonical.outcome !== 'look') throw fail('Save a current Look before opening a request.', 'knock_form_source');
    for (const event of history.filter(e => e.target === raw.id)) guards.push(write.verify('knock_events', event.id, event.__updateTime));
    canonical = { ...canonical, history: history.filter(e => e.target === raw.id).map(e => [e.id, e.__updateTime]).sort() };
  } else if (raw.status === 'cancelled') throw fail('That sale is cancelled.', 'knock_form_source');
  const revision = await formDigest({ kind: source.kind, canonical, fence: fence?.revision || null, house: { id: house.id, number: house.number, street: house.street, unit: house.unit || '' } });
  if (source.revision !== undefined && source.revision !== revision) throw fail('The saved quote or sale changed. Reload it before continuing.', 'knock_form_revision');
  return { descriptor: { kind: source.kind, id: source.id, revision }, raw, canonical, guards, directSold };
}

export function formHandoffView(handoff, receipt = null, revoked = false) {
  return { reference: handoff.reference, houseId: handoff.houseId, channel: handoff.channel, source: handoff.source,
    createdAt: handoff.createdAt, expiresAt: handoff.expiresAt,
    status: revoked ? 'revoked' : receipt ? 'submission_verified' : 'awaiting_submission', revoked,
    states: { hubSaved: true, submissionVerified: Boolean(receipt), contactLinked: Boolean(receipt),
      jobLinked: false, walkthroughLinked: false, collected: 'not_evaluated', commissionEligible: 'not_evaluated', commissionPayable: 'not_evaluated' } };
}

async function view(store, handoff) {
  const [receipt, claim, revoked] = await Promise.all([store.get('knock_receipts', `native_ref_${handoff.reference}`), store.get('knock_receipts', await nativeHouseClaimId(handoff.houseId)), store.get('knock_receipts', `native_revoked_${handoff.reference}`)]);
  return formHandoffView(handoff, receipt, Boolean(revoked) || !nativeClaimActive(claim) || nativeClaimGeneration(claim) !== (handoff.claimGeneration || 0));
}

export async function nativeFormContext(store, rep, settings, houseId, config) {
  const house = await houseFor(store, rep, settings, houseId);
  const [events, sales, handoffs] = await Promise.all([
    store.query('knock_events', { where: [['houseId', '==', house.id]] }),
    store.query('knock_sales', { where: [['houseId', '==', house.id]] }),
    store.query('knock_form_handoffs', { where: [['houseId', '==', house.id]] }),
  ]);
  const candidates = [...effectiveKnocks(events).filter(e => e.outcome === 'look').map(e => ({ kind: 'quote', ...e })),
    ...sales.filter(s => s.status !== 'cancelled').map(s => ({ kind: 'sale', ...s }))].filter(s => s.repKey === rep.repKey);
  const sources = [];
  for (const item of candidates) {
    try { sources.push((await sourceFor(store, rep, house, { kind: item.kind, id: item.id })).descriptor); }
    catch (error) { if (error.code !== 'knock_form_source') throw error; }
  }
  return { setup: nativeFormSetup(config), sources, handoffs: await Promise.all(handoffs.filter(h => h.repKey === rep.repKey).map(h => view(store, h))) };
}

async function ownedHandoff(store, rep, reference) {
  requireActive(rep);
  if (!REFERENCE.test(reference)) throw fail('Choose a valid form reference.', 'knock_form_invalid', 400);
  const handoff = await store.get('knock_form_handoffs', reference);
  if (!handoff || handoff.repKey !== rep.repKey) throw fail('That form reference is not available to your rep.', 'knock_form_owner', 403);
  return handoff;
}

export async function createNativeFormHandoff(store, rep, settings, body, config, nowIso) {
  requireActive(rep);
  onlyFormFields(body, ['action', 'houseId', 'channel', 'source']);
  if (!config.enabled) throw fail(nativeFormSetup(config).message, 'knock_form_setup');
  if (!FORM_CHANNELS.includes(body.channel)) throw fail('Choose quote/direct sale or walkthrough request.', 'knock_form_channel', 400);
  if (!HASH.test(body.source?.revision || '')) throw fail('Reload the saved quote or sale revision first.', 'knock_form_revision');
  const house = await houseFor(store, rep, settings, body.houseId);
  const source = await sourceFor(store, rep, house, body.source);
  if (body.channel === 'walkthrough_request' && source.descriptor.kind !== 'quote') throw fail('A walkthrough request needs a Look, not a direct sale.', 'knock_form_channel');
  const sales = await store.query('knock_sales', { where: [['houseId', '==', house.id]] });
  if (body.channel === 'walkthrough_request' && (source.directSold || sales.some(s => s.status !== 'cancelled'))) throw fail('A direct sale already exists. Review attribution before requesting a walkthrough.', 'knock_form_channel_conflict');
  const claimId = await nativeHouseClaimId(house.id);
  const claim = await store.get('knock_receipts', claimId);
  if (nativeClaimActive(claim) && (claim.repKey !== rep.repKey || claim.channel !== body.channel)) throw fail('This house already has a different form channel or rep. Attribution needs review.', 'knock_form_channel_conflict');
  const generation = nativeClaimGeneration(claim);
  const requestId = `native_request_${await formDigest(generation ? [rep.repKey, body.channel, source.descriptor, generation] : [rep.repKey, body.channel, source.descriptor])}`;
  const prior = await store.get('knock_receipts', requestId);
  if (prior) {
    const handoff = await ownedHandoff(store, rep, prior.reference);
    if (Date.parse(handoff.expiresAt) <= Date.parse(nowIso)) throw fail('This reference expired. Reconcile it before issuing another request.', 'knock_form_expired');
    return { handoff: await view(store, handoff), duplicate: true };
  }
  const form = config.forms[body.channel];
  const reference = `kf_${crypto.randomUUID().replaceAll('-', '')}`;
  const handoff = { reference, repKey: rep.repKey, houseId: house.id, channel: body.channel, source: source.descriptor,
    claimGeneration: generation,
    locationId: config.locationId, formId: form.formId, referenceFieldId: form.referenceFieldId,
    ...(form.channelFieldId ? { channelFieldId: form.channelFieldId, channelValue: form.channelValue } : {}),
    mappingDigest: await mappingDigest(config, form),
    status: 'awaiting_submission', createdAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + 86400000).toISOString() };
  try {
    await store.commit([...source.guards,
      ...(!claim ? [write.create('knock_receipts', claimId, { repKey: rep.repKey, channel: body.channel, houseId: house.id, generation, state: 'active' })]
        : nativeClaimActive(claim) ? [write.patch('knock_receipts', claimId, { lastRequestReference: reference }, claim.__updateTime)]
          : [write.patch('knock_receipts', claimId, { repKey: rep.repKey, channel: body.channel, state: 'active', lastRequestReference: reference }, claim.__updateTime)]),
      write.create('knock_receipts', requestId, { reference }), write.create('knock_form_handoffs', reference, handoff)]);
  } catch (error) {
    // Recover a lost response or concurrent equivalent request, never a different rep/channel.
    const retry = await store.get('knock_receipts', requestId);
    if (!retry) throw error;
    return { handoff: await view(store, await ownedHandoff(store, rep, retry.reference)), duplicate: true };
  }
  return { handoff: formHandoffView(handoff), duplicate: false };
}

async function currentHandoff(store, rep, settings, config, reference, nowIso, { allowExpired = false } = {}) {
  const handoff = await ownedHandoff(store, rep, reference);
  if (await store.get('knock_receipts', `native_revoked_${reference}`)) throw fail('This form reference was released by a manager. It cannot be reused.', 'knock_form_revoked');
  if (!config.enabled) throw fail(nativeFormSetup(config).message, 'knock_form_setup');
  const form = config.forms[handoff.channel];
  if (handoff.mappingDigest !== await mappingDigest(config, form))
    throw fail('The form setup changed. Reconcile the old reference before continuing.', 'knock_form_setup');
  const claimId = await nativeHouseClaimId(handoff.houseId), claim = await store.get('knock_receipts', claimId);
  if (!nativeClaimActive(claim) || nativeClaimGeneration(claim) !== (handoff.claimGeneration || 0))
    throw fail('This form reference was released by a manager. It cannot be reused.', 'knock_form_revoked');
  if (claim.repKey !== rep.repKey || claim.channel !== handoff.channel)
    throw fail('This house has conflicting form attribution. Reconcile it before continuing.', 'knock_form_channel_conflict');
  const house = await houseFor(store, rep, settings, handoff.houseId);
  const source = await sourceFor(store, rep, house, handoff.source);
  source.guards.push(write.verify('knock_receipts', claimId, claim.__updateTime));
  source.guards.push(write.verifyMissing('knock_receipts', `native_revoked_${reference}`));
  if (handoff.channel === 'walkthrough_request') {
    const sales = await store.query('knock_sales', { where: [['houseId', '==', house.id]] });
    if (source.directSold || sales.some(sale => sale.status !== 'cancelled'))
      throw fail('A direct sale conflicts with this walkthrough request. Attribution needs review.', 'knock_form_channel_conflict');
  }
  if (Date.parse(nowIso) < Date.parse(handoff.createdAt) || !allowExpired && Date.parse(nowIso) > Date.parse(handoff.expiresAt)) throw fail('This reference expired. Nothing was marked submitted.', 'knock_form_expired');
  return { handoff, source, form };
}

export async function openNativeFormHandoff(store, rep, settings, body, config, nowIso) {
  onlyFormFields(body, ['action', 'reference']);
  const { handoff, form } = await currentHandoff(store, rep, settings, config, body.reference, nowIso);
  const url = new URL(form.url);
  // No names, phones, emails, address, price, rep key, source id or revision in a provider URL.
  url.searchParams.set(form.referenceQueryKey, handoff.reference);
  return { handoff: await view(store, handoff), launch: { url: url.href, formId: form.formId, referenceQueryKey: form.referenceQueryKey } };
}

export async function verifyNativeFormReceipt(store, rep, settings, body, config, nowIso, readSubmission) {
  onlyFormFields(body, ['action', 'reference', 'contactId', 'submissionId']);
  if (![body.contactId, body.submissionId].every(id => typeof id === 'string' && PROVIDER_ID.test(id))) throw fail('Enter the exact GHL contact and submission IDs.', 'knock_form_invalid', 400);
  const { handoff, source } = await currentHandoff(store, rep, settings, config, body.reference, nowIso, { allowExpired: true });
  const receiptId = `native_submission_${await formDigest([handoff.locationId, body.submissionId])}`;
  const refReceiptId = `native_ref_${handoff.reference}`;
  const same = receipt => receipt?.reference === handoff.reference && receipt.repKey === rep.repKey && receipt.formId === handoff.formId &&
    receipt.contactId === body.contactId && receipt.submissionId === body.submissionId && receipt.sourceRevision === handoff.source.revision;
  const [prior, priorRef] = await Promise.all([store.get('knock_receipts', receiptId), store.get('knock_receipts', refReceiptId)]);
  if (prior || priorRef) {
    if (!same(prior) || !same(priorRef)) throw fail('This submission or reference already belongs to a different receipt.', 'knock_form_replay');
    return { handoff: formHandoffView(handoff, prior), duplicate: true };
  }
  const { row, contact } = await readSubmission({ formId: handoff.formId, contactId: body.contactId, submissionId: body.submissionId,
    createdAt: handoff.createdAt, expiresAt: handoff.expiresAt });
  const time = Date.parse(row?.createdAt);
  const customer = source.descriptor.kind === 'sale' ? source.raw.customer : null;
  if (row?.id !== body.submissionId || row.formId !== handoff.formId || row.contactId !== body.contactId || contact?.id !== body.contactId ||
      contact.locationId !== handoff.locationId || row.locationId != null && row.locationId !== handoff.locationId ||
      !Number.isFinite(time) || time < Date.parse(handoff.createdAt) || time > Date.parse(handoff.expiresAt) || time > Date.parse(nowIso) ||
      !Object.hasOwn(row.others || {}, handoff.referenceFieldId) || row.others[handoff.referenceFieldId] !== handoff.reference ||
      handoff.channelFieldId && row.others[handoff.channelFieldId] !== handoff.channelValue ||
      customer && (!normalizePhone(customer.phone) || normalizePhone(contact.phone) !== normalizePhone(customer.phone) || !customer.email || String(contact.email || '').trim().toLowerCase() !== customer.email.toLowerCase()))
    throw fail('GHL evidence does not match this form, contact, reference, time and saved revision.', 'knock_form_mismatch');
  const receipt = { kind: 'native_form_submission', reference: handoff.reference, repKey: rep.repKey, channel: handoff.channel,
    sourceRevision: handoff.source.revision, locationId: handoff.locationId, formId: handoff.formId,
    ...(handoff.channelFieldId ? { channelFieldId: handoff.channelFieldId, channelValue: handoff.channelValue } : {}),
    contactId: body.contactId, submissionId: body.submissionId, submittedAt: row.createdAt, verifiedAt: nowIso };
  try {
    await store.commit([...source.guards, write.verify('knock_form_handoffs', handoff.reference, handoff.__updateTime),
      write.create('knock_receipts', receiptId, receipt), write.create('knock_receipts', refReceiptId, receipt)]);
  } catch (error) {
    const [saved, savedRef] = await Promise.all([store.get('knock_receipts', receiptId), store.get('knock_receipts', refReceiptId)]);
    if (!saved && !savedRef) throw error;
    if (!same(saved) || !same(savedRef)) throw fail('This submission or reference already belongs to a different receipt.', 'knock_form_replay');
    return { handoff: formHandoffView(handoff, saved), duplicate: true };
  }
  return { handoff: formHandoffView(handoff, receipt), duplicate: false };
}

export async function discoverNativeFormReceipt(store, rep, settings, body, config, nowIso, discover) {
  onlyFormFields(body, ['action', 'reference']);
  const { handoff } = await currentHandoff(store, rep, settings, config, body.reference, nowIso, { allowExpired: true });
  const saved = await store.get('knock_receipts', `native_ref_${handoff.reference}`);
  if (saved) return verifyNativeFormReceipt(store, rep, settings, { action: 'verify', reference: handoff.reference, contactId: saved.contactId, submissionId: saved.submissionId }, config, nowIso, () => { throw fail('Saved receipt is incomplete.'); });
  if (typeof discover !== 'function') throw fail('GHL receipt discovery is unavailable.', 'knock_form_provider_unavailable', 424);
  const evidence = await discover(handoff);
  if (!evidence) return { handoff: formHandoffView(handoff), discovery: 'not_visible_yet' };
  return { ...await verifyNativeFormReceipt(store, rep, settings, { action: 'verify', reference: handoff.reference,
    contactId: evidence.row?.contactId, submissionId: evidence.row?.id }, config, nowIso, async () => evidence), discovery: 'verified' };
}
