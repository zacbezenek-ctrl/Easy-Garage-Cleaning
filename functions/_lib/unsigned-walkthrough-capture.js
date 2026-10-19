import { stripCrewMoneyDeep } from './crew-money.js';

// An operational subset, never an accepted-sale payload. No prices, signatures,
// payment, employee IDs, schedule confirmation or arbitrary internal notes.
// parkingPlan: the walkthrough's "Parking after the job" (scope.parking_plan, at most 1,000 characters), sent only with vehicles.
const TEXT = new Set(['customerGoal', 'whyNow', 'sortMethod', 'keepItems', 'removeItems', 'exclusions', 'accessNotes', 'truckPlacement', 'crewBrief', 'parkingPlan']);
const TEXT_MAX = { crewBrief: 4900, parkingPlan: 1000 };
const LIST = new Set(['hazards', 'access', 'specialItems', 'finish']);
// The Finish step's shelving and tote counts (D-JUNK: quote-model.js junkOnlyGarageWork reads them with finish).
const COUNT = new Set(['shelfQty', 'toteQty']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('Walkthrough instructions contain unsupported or invalid fields.'), { code: 'quote_draft_invalid_capture', status: 400 });

export function normalizeUnsignedCapture(value) {
  if (value === undefined) return undefined; // old clients must not erase saved instructions
  if (!plain(value)) throw invalid();
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (TEXT.has(key)) {
      if (typeof item !== 'string' || item.length > (TEXT_MAX[key] || 4000)) throw invalid();
      output[key] = item.trim();
    } else if (LIST.has(key)) {
      if (!Array.isArray(item) || item.length > 50 || item.some(row => typeof row !== 'string' || !row.trim() || row.length > 300)) throw invalid();
      output[key] = [...new Set(item.map(row => row.trim()))];
    } else if (COUNT.has(key)) {
      if (!Number.isInteger(item) || item < 0 || item > 999) throw invalid();
      output[key] = item;
    } else throw invalid();
  }
  return stripCrewMoneyDeep(output);
}

export function unsignedCapturePatch(job, capture, actor, now) {
  if (!capture || !Object.keys(capture).length) return {};
  const { crewBrief, ...fields } = capture;
  const instructions = plain(job?.jobInstructions) ? job.jobInstructions :
    typeof job?.jobInstructions === 'string' ? { operationalScope: job.jobInstructions } : {};
  const patch = { jobInstructions: { ...instructions, ...fields } };
  if (crewBrief !== undefined) {
    patch.jobInstructions.operationalScope = crewBrief;
    patch.operationalScope = { text: crewBrief, updatedBy: actor.user, updatedAt: now, reason: 'Unsigned walkthrough capture', approvalKind: 'staff_operational_instructions' };
  }
  // These fields take precedence over structured instructions in crew views.
  if (fields.accessNotes !== undefined) patch.accessInstructions = fields.accessNotes;
  return patch;
}
