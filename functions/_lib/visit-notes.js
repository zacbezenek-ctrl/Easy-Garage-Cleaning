import { stripCrewMoney } from './crew-money.js';

/* EGC_WALKTHROUGH_NOTES: the job notes an estimator confirms from the walkthrough transcript (jobs/{id}.visitNotes, on the
   walkthrough visit and its job). The model's draft, the estimator's confirmed edit and every crew projection pass the same
   caps, currency stripping (crew-money.js) and contact scrubbing, so a price said out loud, a phone number or an email never
   reaches a crew screen. The stripper is a backstop: the drafting prompt itself keeps money out. Pure.
     {jobNotes:[string], itemsNeeded:[{name, quantity|null, reason}], keepItems:[string], removeItems:[string],
      access:[string], hazards:[string]}  (+ openQuestions:[string] on a draft only, never on the crew's copy) */
export const VISIT_NOTES_VERSION = 1;
// [most lines, most characters per line]
export const VISIT_NOTE_LISTS = Object.freeze({ jobNotes: [12, 300], keepItems: [20, 200], removeItems: [20, 200], access: [8, 300], hazards: [8, 300], openQuestions: [8, 300] });
export const ITEMS_NEEDED = Object.freeze({ items: 25, name: 120, reason: 200, quantity: 999 });
const CREW_LISTS = ['jobNotes', 'keepItems', 'removeItems', 'access', 'hazards'];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// A ten-digit North American number, with or without +1, brackets, dots, dashes or spaces.
const PHONE = /(?<![\w$])(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g;

/** One line of crew text: control characters and repeated spacing collapse, amounts are removed and a phone number or
 * email becomes "the number on file" / "the email on file". */
export function cleanNoteText(value, max = 300) {
  if (typeof value !== 'string') return '';
  const text = stripCrewMoney(value.replace(/[\u0000-\u001f\u007f]+/g, ' ')).replace(EMAIL, 'the email on file').replace(PHONE, 'the number on file');
  return text.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function lines(value, [count, max]) {
  const out = [];
  for (const item of Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []) {
    const text = cleanNoteText(item, max);
    if (text && !out.includes(text)) out.push(text);
    if (out.length === count) break;
  }
  return out;
}

function quantityOf(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 1 && number <= ITEMS_NEEDED.quantity ? number : null;
}

function itemsNeeded(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!plain(item)) continue;
    const name = cleanNoteText(item.name, ITEMS_NEEDED.name);
    if (!name) continue;
    out.push({ name, quantity: quantityOf(item.quantity), reason: cleanNoteText(item.reason, ITEMS_NEEDED.reason) });
    if (out.length === ITEMS_NEEDED.items) break;
  }
  return out;
}

/** The notes as the crew may read them (and openQuestions too with questions:true, for the estimator's draft). A list
 * may arrive as an array or as text with one entry per line; empty, repeated and over-cap entries are dropped. */
export function cleanVisitNotes(value, { questions = false } = {}) {
  const input = plain(value) ? value : {};
  const notes = { jobNotes: lines(input.jobNotes, VISIT_NOTE_LISTS.jobNotes), itemsNeeded: itemsNeeded(input.itemsNeeded) };
  for (const key of CREW_LISTS.slice(1)) notes[key] = lines(input[key], VISIT_NOTE_LISTS[key]);
  if (questions) notes.openQuestions = lines(input.openQuestions, VISIT_NOTE_LISTS.openQuestions);
  return notes;
}

export const visitNotesEmpty = notes => !Object.values(notes || {}).some(list => Array.isArray(list) && list.length);

/** A job's confirmed notes as the assigned crew (crew lead included) read them: the lists only, cleaned again, with
 * who confirmed them and when; never the transcript or the open questions. null when there are none. */
export function crewVisitNotes(value) {
  if (!plain(value)) return null;
  const notes = cleanVisitNotes(value);
  if (visitNotesEmpty(notes)) return null;
  const stamp = (text, max) => typeof text === 'string' ? text.slice(0, max) : null;
  return { ...notes, confirmedAt: stamp(value.confirmedAt, 40), confirmedBy: stamp(value.confirmedBy, 120) };
}

/** "2 × Shelving unit – for the back wall" lines for a brief. */
export const itemsNeededText = items => (Array.isArray(items) ? items : []).map(item => `${item.quantity ? `${item.quantity} × ` : ''}${item.name}${item.reason ? ` – ${item.reason}` : ''}`);
