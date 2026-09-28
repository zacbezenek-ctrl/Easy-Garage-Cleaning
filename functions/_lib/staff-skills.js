// Versioned skill catalog for the staff directory. Retiring a skill means removing
// it here and bumping the version; stored skills outside the catalog stay readable
// (marked retired) and are dropped the next time a manager saves that person's skills.
export const SKILL_CATALOG_VERSION = '2026-09-staff-skills-v1';
export const SKILL_LEVELS = Object.freeze(['trainee', 'proficient', 'lead']);
export const SKILL_CATALOG = Object.freeze([
  ['cleanout', 'Garage cleanout'], ['deep_clean', 'Deep clean'], ['pressure_wash', 'Pressure washing'],
  ['mouse_trapping', 'Mouse trapping'], ['shelving', 'Shelving install'], ['overhead_storage', 'Overhead storage install'],
  ['heavy_lifting', 'Heavy lifting'], ['truck_driving', 'Truck driving'], ['trailer_towing', 'Trailer towing'],
  ['dump_runs', 'Dump and donation runs'], ['walkthrough_estimating', 'Walkthrough estimating'],
  ['customer_phone', 'Customer phone follow-up'], ['crew_leadership', 'Crew leadership'], ['first_aid', 'First aid'],
].map(([id, label]) => Object.freeze({ id, label })));
const catalog = new Set(SKILL_CATALOG.map(skill => skill.id));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new Error(message), { code: 'staff_directory_invalid_skills', status: 400 });
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));

// Stored skills as readers see them; malformed rows are omitted, never repaired.
export function storedSkills(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(skill => record(skill) && typeof skill.id === 'string' && /^[a-z0-9_]{1,40}$/.test(skill.id) && SKILL_LEVELS.includes(skill.level) && !seen.has(skill.id) && seen.add(skill.id))
    .map(skill => ({ id: skill.id, level: skill.level, verifiedBy: typeof skill.verifiedBy === 'string' ? skill.verifiedBy.slice(0, 80) : '', verifiedAt: instant(skill.verifiedAt) ? skill.verifiedAt : '', ...(catalog.has(skill.id) ? {} : { retired: true }) }));
}

// A manager's replacement list: every id must be in the current catalog. Unchanged
// skills keep their original verification; new or re-leveled skills are verified now.
export function validateSkills(input, existing, actor, now) {
  if (!Array.isArray(input) || input.length > SKILL_CATALOG.length) throw fail('Choose skills from the current skill catalog.');
  const previous = new Map(storedSkills(existing).map(skill => [skill.id, skill])), seen = new Set();
  return input.map(skill => {
    if (!record(skill) || Object.keys(skill).some(key => !['id', 'level'].includes(key))) throw fail('Each skill needs only an id and a level.');
    if (!catalog.has(skill.id) || seen.has(skill.id)) throw fail('Choose each skill once from the current skill catalog.');
    if (!SKILL_LEVELS.includes(skill.level)) throw fail('Choose trainee, proficient or lead for each skill.');
    seen.add(skill.id);
    const before = previous.get(skill.id);
    return before && before.level === skill.level && !before.retired ? before : { id: skill.id, level: skill.level, verifiedBy: actor, verifiedAt: now };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
