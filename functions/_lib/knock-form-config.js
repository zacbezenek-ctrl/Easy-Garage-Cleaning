// A separate, server-only setting. No defaults, migration, settings writer or provider activation.
import { highLevelConfig } from './highlevel-tags.js';

export const FORM_CHANNELS = Object.freeze(['direct_sale', 'walkthrough_request']);
export const FORM_CHANNEL_VALUES = Object.freeze({ direct_sale: 'Direct D2D quote', walkthrough_request: 'Walkthrough request' });
export const FORM_HOSTS = Object.freeze(['api.leadconnectorhq.com', 'links.easygaragecleaning.com']);
const ID = /^[A-Za-z0-9_-]{8,120}$/;
const isId = value => typeof value === 'string' && ID.test(value);
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
const WEBSITE_FORM = 'DeiRNO6itxjLiTk3Nkj0';
const BINDING = ['formId', 'url', 'referenceFieldId', 'referenceQueryKey'];

export function formBaseUrl(value, formId) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && FORM_HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === `/widget/form/${formId}` ? url.href : null;
  } catch { return null; }
}

export function nativeFormConfig(doc, env, nowMs = Date.now()) {
  const integration = highLevelConfig(env);
  const blockers = [];
  if (doc?.enabled !== true) blockers.push('native_forms_disabled');
  if (!integration.token || !isId(integration.locationId) || doc?.locationId !== integration.locationId) blockers.push('existing_integration_location_unverified');
  const forms = {};
  for (const channel of FORM_CHANNELS) {
    const form = doc?.forms?.[channel], acceptance = form?.acceptance;
    if (!form || !isId(form.formId) || form.formId === WEBSITE_FORM || !isId(form.referenceFieldId) ||
        typeof form.referenceQueryKey !== 'string' || !KEY.test(form.referenceQueryKey) || ['__proto__', 'prototype', 'constructor'].includes(form.referenceQueryKey) || !formBaseUrl(form.url, form.formId)) {
      blockers.push(`${channel}_form_mapping_missing`);
      continue;
    }
    const channelBound = form.channelFieldId !== undefined || form.channelValue !== undefined;
    if (channelBound && (!isId(form.channelFieldId) || form.channelValue !== FORM_CHANNEL_VALUES[channel])) {
      blockers.push(`${channel}_channel_mapping_invalid`);
      continue;
    }
    const verifiedAt = Date.parse(acceptance?.verifiedAt);
    if (!acceptance || acceptance.locationId !== doc.locationId || !BINDING.every(key => acceptance[key] === form[key]) ||
        acceptance.prefillVerified !== true || acceptance.submissionReadVerified !== true || acceptance.formsReadonlyVerified !== true ||
        !Number.isFinite(verifiedAt) || verifiedAt > nowMs || typeof acceptance.verifiedBy !== 'string' || !acceptance.verifiedBy.trim() ||
        typeof acceptance.evidence !== 'string' || !acceptance.evidence.trim() ||
        channelBound && (acceptance.channelFieldId !== form.channelFieldId || acceptance.channelValue !== form.channelValue || acceptance.channelSubmissionVerified !== true)) blockers.push(`${channel}_acceptance_missing`);
    forms[channel] = form;
  }
  const direct = forms.direct_sale, walkthrough = forms.walkthrough_request;
  if (direct && walkthrough && direct.formId === walkthrough.formId &&
      (!direct.channelFieldId || direct.channelFieldId !== walkthrough.channelFieldId ||
       direct.referenceFieldId !== walkthrough.referenceFieldId || direct.referenceQueryKey !== walkthrough.referenceQueryKey ||
       direct.url !== walkthrough.url || direct.channelValue === walkthrough.channelValue)) blockers.push('shared_form_channel_mapping_required');
  return { enabled: blockers.length === 0, blockers, forms, locationId: integration.locationId, integration };
}

export const loadNativeFormConfig = async (store, env, nowMs) => nativeFormConfig(await store.get('knock_settings', 'native_forms'), env, nowMs);
export const nativeFormSetup = config => ({ enabled: config.enabled, blockers: config.blockers,
  message: config.enabled ? 'Native forms are available online.' : 'GHL forms are not ready. Verified form/channel mappings and prefill/receipt evidence are required. Nothing has been sent.' });
