// FIX-CREW-PRICE-LEAK: crew never see a customer's quoted prices. The signed
// walkthrough brief once carried add-on fees ("Pest waste (+$200)") into the
// crew-visible scope; these helpers remove currency amounts from crew text.
const TAIL = String.raw`(?:\.\d+)?(?:[km]\b)?`, NUMBER = String.raw`\d+(?:,\d+)*${TAIL}|\.\d+`;
// "(+ $200)" is one fee (a list dash before an amount stays). A space groups thousands only after a spaced sign
// ("$ 1 500"), so "$5 100 boxes" keeps its count. "#$1234" is a code, not a price.
const PREFIXED = String.raw`(?<!#)(?:\+[ \t]?|[\-−])?(?:(?:US)?\$|\bUSD)(?:[ \t\u00a0]\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)${TAIL}|[ \t\u00a0]?(?:${NUMBER}))(?:[-–—](?:US)?\$?(?:${NUMBER}))?(?:[ \t]?(?:USD\b|dollars?\b))?`;
// "1234$" after "code", "PIN" or "password" is an access code, not a price.
const SUFFIXED = String.raw`(?<![\w.,:$#])[+\-−]?(?:${NUMBER})[ \t]?(?:USD\b|dollars?\b|¢)|(?<![\w.,:$#])(?<!\b(?:codes?|pin|passcode|password|lockbox|keypad)[ \t]{0,3}[:#=]?[ \t]{0,3})(?:${NUMBER})\$`;
const AMOUNT = `(?:${PREFIXED}|${SUFFIXED})`, FIND = new RegExp(AMOUNT, 'gi'), TEST = new RegExp(AMOUNT, 'i');
const OPENS = /[\n([{]/, CLOSES = /[\n)\]},.;:!?]/, PAIRS = { '(': ')', '[': ']' }, blank = char => char === ' ' || char === '\t';
// The brief the walkthrough writes (INTERNAL: the priced one saved before this fix; CREW: the one it writes now).
const BRIEF = /^\s*EGC (?:INTERNAL|CREW) JOB BRIEF\b/;

export const hasCrewMoney = value => typeof value === 'string' && TEST.test(value);

/** Removes every currency amount ("(+$1,234.50)", "[$200]", "$1501.00", "+$200", "USD 200",
 * "200 dollars", "50¢") and the spacing it leaves. Times ("8:00") and quantities
 * ("2 shelf unit(s)") are untouched, and text without an amount is returned as is. */
export function stripCrewMoney(value) {
  if (!hasCrewMoney(value)) return value;
  // The spacing and brackets around an amount are scanned here, not matched by the pattern, so long blank runs stay linear.
  const parts = []; let last = 0, space = false, previous = '\n';
  const back = at => { while (at > last && blank(value[at - 1])) at--; return at; }, ahead = at => { while (at < value.length && blank(value[at])) at++; return at; };
  for (const { 0: amount, index } of value.matchAll(FIND)) {
    let open = back(index), close = ahead(index + amount.length);
    // "(+$200)" and "[$200]" go with their brackets.
    if (open > last && PAIRS[value[open - 1]] && value[close] === PAIRS[value[open - 1]]) { open--; close++; } else { open = index; close = index + amount.length; }
    const start = back(open), end = ahead(close);
    if (start > last) { parts.push(space ? ' ' : '', value.slice(last, start)); previous = value[start - 1]; space = false; }
    last = end;
    // At a line, bracket or sentence edge the amount goes with its spacing; between words one space stays.
    space = OPENS.test(previous) || CLOSES.test(value[end] ?? '\n') ? false : space || start < open || end > close;
  }
  return parts.join('') + (space ? ' ' : '') + value.slice(last);
}

/** stripCrewMoney over every string in a plain JSON value (instructions, checklists). */
export function stripCrewMoneyDeep(value) {
  if (typeof value === 'string') return stripCrewMoney(value);
  if (Array.isArray(value)) return value.map(stripCrewMoneyDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripCrewMoneyDeep(item)]));
  return value;
}

/** The text crew read as the job's scope, in field-execution's order of precedence. */
export const crewScopeSource = job => typeof job?.operationalScope?.text === 'string' ? job.operationalScope.text : typeof job?.jobInstructions === 'string' ? job.jobInstructions : typeof job?.jobInstructions?.operationalScope === 'string' ? job.jobInstructions.operationalScope : '';

/** A job whose crew brief came from a signed walkthrough: saved by the handoff
 * (handoffVersion) or copied from one (a recurring visit keeps the brief text). */
export const signedBriefJob = job => job?.handoffVersion !== undefined && job?.handoffVersion !== null || BRIEF.test(crewScopeSource(job));
