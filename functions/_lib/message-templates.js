/* Pure message template rules. Only whitelisted variables render, missing
   values fail closed, SMS is capped and email HTML is always escaped. */
export const TEMPLATE_VARIABLES = Object.freeze(['firstName','crewLeadName','etaMinutes','arrivalWindow','serviceDate','removedDates','portalLink','payLink','invoiceNumber','balance','dueDate','companyPhone','inviteLink','loginLink']);
export const LINK_VARIABLES = Object.freeze(['portalLink','payLink','inviteLink','loginLink']);
export const TEMPLATE_CHANNELS = Object.freeze(['SMS','Email']);
export const SMS_LIMIT = 320;
export const LINK_PLACEHOLDER = '[secure link]';
const LIMITS = { SMS: 1000, Email: 4000 };
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
export const messageDigest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : canonical(value))))].map(byte => byte.toString(16).padStart(2,'0')).join('');
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);

export function cleanTemplateText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max + 1);
}

// Parse a template into text and variable segments. Any brace that is not a
// complete, whitelisted {{variable}} is rejected so typos never reach customers.
function segments(text, allowed = TEMPLATE_VARIABLES) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1];
    if (!TEMPLATE_VARIABLES.includes(name)) throw fail('messaging_template_variable_unknown', `{{${name.slice(0, 40)}}} is not an approved message variable.`, 400, { variable: name.slice(0, 40) });
    if (!allowed.includes(name)) throw fail('messaging_template_variable_not_allowed', `{{${name}}} cannot be used in this message type.`, 400, { variable: name });
    parts.push({ text: text.slice(last, match.index) }, { variable: name });
    last = match.index + match[0].length;
  }
  parts.push({ text: text.slice(last) });
  if (parts.some(part => part.text !== undefined && /\{\{|\}\}/.test(part.text))) throw fail('messaging_template_syntax_invalid', 'A message variable is missing a brace. Use the {{variable}} form.');
  return parts;
}

export function templateVariables(text, allowed) {
  return [...new Set(segments(String(text || ''), allowed).filter(part => part.variable).map(part => part.variable))];
}

export function validateTemplateVersion(input = {}, allowed = TEMPLATE_VARIABLES) {
  if (!object(input)) throw fail('messaging_template_invalid', 'Choose a message channel and enter the message text.');
  const channel = input.channel;
  if (!TEMPLATE_CHANNELS.includes(channel)) throw fail('messaging_template_channel_invalid', 'Choose SMS or Email for this message.');
  const body = cleanTemplateText(input.body, LIMITS[channel]);
  const subject = channel === 'Email' ? cleanTemplateText(input.subject, 120) : '';
  if (!body) throw fail('messaging_template_body_required', 'Enter the message text.');
  if (body.length > LIMITS[channel]) throw fail('messaging_template_too_long', `Message templates can be at most ${LIMITS[channel]} characters.`);
  if (channel === 'Email' && (!subject || subject.length > 120 || subject.includes('\n'))) throw fail('messaging_template_subject_invalid', 'Email messages need a one-line subject of at most 120 characters.');
  if (channel === 'SMS' && typeof input.subject === 'string' && input.subject.trim()) throw fail('messaging_template_subject_invalid', 'Text messages do not have a subject.');
  const variables = [...new Set([...templateVariables(subject, allowed), ...templateVariables(body, allowed)])];
  if (channel === 'Email' && templateVariables(subject, allowed).some(name => LINK_VARIABLES.includes(name))) throw fail('messaging_template_subject_invalid', 'Links cannot be placed in an email subject.');
  return { channel, subject, body, variables };
}

export async function templateHash(kind, version) {
  return messageDigest({ kind, channel: version.channel, subject: version.subject || '', body: version.body });
}

function value(name, vars) {
  const raw = vars?.[name];
  if (raw === undefined || raw === null || raw === '' || (typeof raw === 'number' && !Number.isFinite(raw))) throw fail('messaging_template_variable_missing', `This message needs {{${name}}}, which is not available for this record.`, 409, { variable: name });
  if (LINK_VARIABLES.includes(name)) {
    const link = String(raw);
    if (link.length > 2048 || !/^https:\/\/[^\s"'<>`\\]+$/.test(link)) throw fail('messaging_template_link_invalid', `The {{${name}}} link could not be verified.`, 409, { variable: name });
    return link;
  }
  const text = String(raw).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) throw fail('messaging_template_variable_missing', `This message needs {{${name}}}, which is not available for this record.`, 409, { variable: name });
  return text;
}

function html(parts, vars) {
  const body = parts.map(part => part.variable === undefined ? escapeHtml(part.text)
    : LINK_VARIABLES.includes(part.variable) ? `<a href="${escapeHtml(value(part.variable, vars))}">${escapeHtml(value(part.variable, vars))}</a>`
    : escapeHtml(value(part.variable, vars))).join('');
  return body.split(/\n{2,}/).map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
}

/** How much of an SMS body is taken before the `open` variables: the
 * characters of its text and of every other variable's value (as rendered),
 * and how many times each open variable appears, so a caller can size those
 * variables to what is left under SMS_LIMIT. */
export function templateRoom(template, vars = {}, open = []) {
  const counts = Object.fromEntries(open.map(name => [name, 0]));
  let used = 0;
  for (const part of segments(String(template?.body || ''))) {
    if (part.variable === undefined) used += [...part.text].length;
    else if (open.includes(part.variable)) counts[part.variable] += 1;
    else used += [...value(part.variable, vars)].length;
  }
  return { room: SMS_LIMIT - used, counts };
}

// Deterministic: the same template and values always produce the same output.
// `display` replaces private links with a placeholder so the approved text can
// be shown, hashed and logged without storing bearer URLs.
export function renderTemplate(template, vars = {}) {
  if (!object(template) || !TEMPLATE_CHANNELS.includes(template.channel) || typeof template.body !== 'string') throw fail('messaging_template_invalid', 'The message template is incomplete.', 409);
  const bodyParts = segments(template.body), subjectParts = segments(template.channel === 'Email' ? String(template.subject || '') : '');
  const plain = (parts, redact) => parts.map(part => part.variable === undefined ? part.text : redact && LINK_VARIABLES.includes(part.variable) ? (value(part.variable, vars), LINK_PLACEHOLDER) : value(part.variable, vars)).join('');
  const body = plain(bodyParts, false), subject = plain(subjectParts, false);
  if (template.channel === 'SMS' && [...body].length > SMS_LIMIT) throw fail('messaging_sms_too_long', `This text would be ${[...body].length} characters. Text messages are limited to ${SMS_LIMIT}.`, 409, { length: [...body].length, limit: SMS_LIMIT });
  if (template.channel === 'Email' && !subject.trim()) throw fail('messaging_template_subject_invalid', 'Email messages need a subject.', 409);
  const variables = [...new Set([...bodyParts, ...subjectParts].filter(part => part.variable).map(part => part.variable))];
  return {
    channel: template.channel, subject, body,
    ...(template.channel === 'Email' ? { html: html(bodyParts, vars) } : {}),
    display: { subject: plain(subjectParts, true), body: plain(bodyParts, true) },
    variables,
  };
}
