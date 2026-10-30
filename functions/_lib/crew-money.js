// FIX-CREW-PRICE-LEAK: crew never see a customer's quoted prices. The signed
// walkthrough brief once carried add-on fees ("Pest waste (+$200)") into the
// crew-visible scope; these helpers remove amounts from crew text: currency
// forms, and plain numbers beside a money word ("balance 937.50", "Venmo me 50").
// Full-width digits ("$１２５０") are digits too.
const D = '[0-9\uff10-\uff19]';
const TAIL = String.raw`(?:\.${D}+)?(?:[km]\b)?`, NUMBER = String.raw`${D}+(?:,${D}+)*${TAIL}|\.${D}+`;
// Words that count, measure or time what a number before them is ("$5 100 boxes", "total 5 boxes", "36 in wide").
const COUNT = String.raw`(?:box(?:es)?|bins?|totes?|bags?|truck(?:[ -]?loads?)?s?|loads?|trips?|trailers?|dumpsters?|crews?|people|persons?|guys|men|workers?|helpers?|movers?|hours?|hrs?|h|minutes?|mins?|days?|weeks?|months?|years?|yrs?|visits?|items?|pieces?|pcs|units?|shel(?:f|ves)|shelving|racks?|hooks?|cabinets?|drawers?|bikes?|bicycles?|cars?|vehicles?|tires?|pallets?|cans?|gal(?:lons?)?|lbs?|pounds?|kg|tons?|ft|feet|foot|inch(?:es)?|cm|mm|yards?|yds?|sq|cubic|cu|mattress(?:es)?|couches?|chairs?|tables?|fridges?|freezers?|appliances?|doors?|bays?|stalls?|spots?|packs?|sets?|pairs?|rolls?|sheets?|steps?|stairs?|rooms?|garages?|spaces?|things?|cartons?|bundles?|in\b(?=[ \t]{0,3}(?:$|[^a-z \t]|(?:wide|deep|tall|high|long|longer|shorter|off|over|under|above|below|clearance|wheelbase|from|by|x)\b)))`;
const STREET = String.raw`(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|way|ct|court|blvd|boulevard|cir|circle|pl|place|trl|trail|pkwy|parkway|hwy|highway|ter|terrace|loop)`;
// "$250/hr", "$1000/truck", "$53 per man-hour": the rate goes with its amount.
const RATE = String.raw`(?:\/|[ \t]{1,3}per[ \t]{1,3})(?!(?:the|a|an)\b)[a-z][a-z-]{0,20}\b`;
const SIGN = String.raw`(?:US)?[$\uff04£€]|\bUSD`;
// "(+ $200)" is one fee (a list dash before an amount stays). A space groups thousands after a spaced sign ("$ 1 500"),
// and after a plain one unless a count follows ("$1 250" is one amount, "$5 100 boxes" keeps its count). "#$1234" is a code.
const GROUPED = String.raw`${D}{1,3}(?:[ \u00a0\u202f]${D}{3})+(?!${D})${TAIL}`;
const PREFIXED = String.raw`(?<!#)(?:\+[ \t]?|[\-−])?(?:${SIGN})(?:[ \t\u00a0]${GROUPED}|${GROUPED}(?![ \t]{0,3}${COUNT}\b)|[ \t\u00a0]?(?:${NUMBER}))(?:[-–—](?:US)?[$\uff04£€]?(?:${NUMBER}))?(?:[ \t]?(?:USD\b|dollars?\b))?(?:${RATE})?`;
// "200 Bucks Rd" is an address, "1.250,00 €" a European amount.
const UNIT = String.raw`USD\b|dollars?\b|bucks?\b(?![ \t]{1,3}${STREET}\b)|grand\b(?![ \t]{1,3}(?:pianos?|${STREET})\b)|¢|€|£`;
const EURO = String.raw`${D}{1,3}(?:\.${D}{3})+(?:,${D}{2})?(?![\d,.])|${D}+,${D}{2}(?![\d,])`;
// "1234$" after "code", "PIN" or "password" is an access code, not a price.
const SUFFIXED = String.raw`(?<![\w.,:$#])[+\-−]?(?:${EURO}|${NUMBER})[ \t]?(?:${UNIT})|(?=[+.\d\uff10-\uff19])(?<![\w.,:$#])(?<!\b(?:codes?|pin|passcode|password|lockbox|keypad)[ \t]{0,3}[:#=]?[ \t]{0,3})\+?(?:${NUMBER})[$\uff04](?:${RATE})?`;
// A bare number ("312.50", "1,250", "1k", "25%") or a spelled-out one ("twelve fifty") is an amount only beside a money
// word (amount() below). "#200", "x3", "8:00" and the parts of a phone number or date never start one.
const WORDS = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)`;
const BARE = String.raw`(?<![\w.,$#/\-−+\uff04£€])(?<!${D}:)\+?${D}+(?:,${D}{3})*(?:\.${D}+)?(?:k(?!\w))?%?(?![\w\uff10-\uff19$\uff04€£¢])|\b${WORDS}(?:(?:[ \t]{1,3}(?:and[ \t]{1,3})?|-)${WORDS})*\b`;
const FIND = new RegExp(String.raw`(?<sum>${PREFIXED}|${SUFFIXED})|${BARE}`, 'gi');
// The money words. Strong ones make any number beside them an amount; weak ones ("total 5", "due 930") only one that
// reads as money: cents, thousands, "k" or three digits or more. Gap words ("Venmo me 50", "balance of 937.50") are skipped.
const STRONG = String.raw`deposit(?:s|ed)?|balance|paid|pay(?:s|ing|ments?)?|price[ds]?|pricing|quote[ds]?|costs?|fees?|charge[ds]?|owe[ds]?|owing|refund(?:s|ed)?|tip(?:s|ped)?|cash(?:[ \t]?app)?|venmo(?:ed)?|zelle(?:d)?|paypal|discount(?:s|ed)?|subtotal`;
const WEAK = String.raw`totals?|ttl|due|check|cheque|collect(?:s|ed)?`;
const GAP = String.raw`[ \t]{0,3}(?:[:=~\-–—][ \t]{0,3})?(?:(?:me|us|him|her|them|you|is|was|of|at|for|about|around|approx\.?|approximately|roughly|only|just|another|extra|the|full|remaining|left|still|an?)[ \t]{1,3}){0,2}\(?[ \t]{0,3}$`;
const STRONG_BEFORE = new RegExp(String.raw`\b(?:${STRONG})${GAP}`, 'i'), WEAK_BEFORE = new RegExp(String.raw`\b(?:${WEAK})${GAP}`, 'i');
// After a number: "312.50 deposit", "50 in cash", "300 by check". "20 tip" and "75 fee" are amounts, "1 charge" and
// "3 quotes" are counts; "total", "due" are weak; "down" goes with a percentage ("25% down").
const AFTER = words => new RegExp(String.raw`^[ \t]{0,3}\)?(?:-[ \t]{0,3})?(?:(?:in|via|as|on|by)[ \t]{1,3})?(?:${words})(?![\w-])(?![ \t]{1,3}${COUNT}\b)`, 'i');
const STRONG_AFTER = AFTER(String.raw`deposit|balance|paid|owed|owing|cash(?:[ \t]?app)?|venmo|zelle|paypal|(?<=by[ \t]{1,3})(?:check|cheque)|refunded|charged|quoted|priced`);
const EACH_AFTER = AFTER('tip|fee|charge|refund|price|quote|cost|payment|discount'), WEAK_AFTER = AFTER('total|subtotal|due'), DOWN = AFTER('down');
// What follows a number that is a time, date, phone number, measure, count or code, never an amount.
const KEEP = new RegExp(String.raw`^(?:[\-–/.:]${D}|[ \t]?(?:[ap]\.?m\b\.?|o'?clock\b)|[ \t]?[x×*][ \t]?${D}|["'″′](?=[ \t]{0,3}(?:[x×*]|${D}|(?:wide|deep|tall|high|long|by|off)\b))|#|[ \t]{0,3}${COUNT}\b)`, 'i');
const ADDRESS = new RegExp(String.raw`^[ \t]{1,3}(?:[NSEW]\.?[ \t]{1,3})?(?:[A-Z0-9][\w'.-]*[ \t]{1,3}){1,3}(?:${STREET.replace(/\b[a-z]/g, c => c.toUpperCase())}|${STREET.toUpperCase()})\b`);
// A range of bare amounts ("quoted 1200 - 1500", "1200-1500") goes whole; "970-555-0100" and "2026-11-01" are not ranges.
const RANGE = new RegExp(String.raw`^[ \t]{0,3}[-–—][ \t]{0,3}[1-9]${D}{2,}(?:,${D}{3})*(?:\.${D}+)?(?![\w.\-/]|${D})`);
const UNIT_AFTER = new RegExp(String.raw`^[ \t]?(?:${UNIT})`, 'i');
const RATE_AFTER = /^(?:[ \t]?\/[ \t]?(?:man[- ]?)?(?:hr|hour|h)\b|[ \t]{1,3}(?:per|an?)[ \t]{1,3}(?:man[- ]?)?hour\b)/i;
const priced = number => /,\d{3}|\.\d{2}(?!\d)|k%?$/i.test(number) || /^\+?\d{3,}/.test(number);
const TENS = /(?:ten|eleven|twelve|teen|ty|hundred|thousand)$/i;

// The end of the amount a bare number starts, or -1 when it is not one.
function amount(value, index, number) {
  let end = index + number.length, rest = value.slice(end, end + 64);
  const before = value.slice(Math.max(0, index - 64), index), word = /^[a-z]/i.test(number);
  const beside = () => STRONG_BEFORE.test(before) || STRONG_AFTER.test(rest) || EACH_AFTER.test(rest) && !/^\+?1$/.test(number);
  if (!word) {
    // "1200-1500" is a range of two amounts; the parts of a phone number or date are kept whole.
    const range = /^\+?\d{3,}/.test(number) ? rest.match(RANGE) : null;
    if (range) rest = value.slice(end += range[0].length, end + 64);
    else if (/^[\-–/.:]\d/.test(rest)) return -1;
  }
  // "250 bucks", "two hundred fifty dollars", "53/hr" go with their unit or rate.
  const unit = rest.match(UNIT_AFTER) || !word && rest.match(RATE_AFTER);
  if (unit && !ADDRESS.test(rest)) return end + unit[0].length;
  if (KEEP.test(rest)) return -1;
  // A spelled-out amount needs a tens word ("quoted twelve fifty", never a lone "one").
  if (word) return number.split(/[ \t-]+/).some(part => TENS.test(part)) && (beside() || WEAK_BEFORE.test(before)) ? end : -1;
  if (ADDRESS.test(rest)) return -1;
  const percent = number.endsWith('%');
  return beside() || !percent && priced(number) && (WEAK_BEFORE.test(before) || WEAK_AFTER.test(rest)) || percent && DOWN.test(rest) ? end : -1;
}

// Every amount in the text as [start, end], in order.
function* amounts(value) {
  let last = 0;
  for (const match of value.matchAll(FIND)) {
    if (match.index < last) continue;
    const end = match.groups.sum !== undefined ? match.index + match[0].length : amount(value, match.index, match[0]);
    if (end < 0) continue;
    last = end;
    yield [match.index, end];
  }
}
const OPENS = /[\n([{]/, CLOSES = /[\n)\]},.;:!?]/, PAIRS = { '(': ')', '[': ']' }, blank = char => char === ' ' || char === '\t';
// The brief the walkthrough writes (INTERNAL: the priced one saved before this fix; CREW: the one it writes now).
const BRIEF = /^\s*EGC (?:INTERNAL|CREW) JOB BRIEF\b/;

export const hasCrewMoney = value => typeof value === 'string' && !amounts(value).next().done;

/** Removes every amount: currency forms ("(+$1,234.50)", "[$200]", "$1501.00", "+$200", "USD 200", "€1,250", "£900",
 * "200 dollars", "250 bucks", "50¢", "$250/hr"), a number beside a money word ("balance 937.50", "Venmo me 50",
 * "25% deposit", "1k total", "quoted twelve fifty") or a rate ("53/hr"), and the spacing it leaves. Times ("8:00"),
 * dates, phone numbers, counts ("2 shelf unit(s)", "total 5 boxes"), measures, codes and addresses are untouched,
 * and text without an amount is returned as is. */
export function stripCrewMoney(value) {
  if (!hasCrewMoney(value)) return value;
  // The spacing and brackets around an amount are scanned here, not matched by the pattern, so long blank runs stay linear.
  const parts = []; let last = 0, space = false, previous = '\n';
  const back = at => { while (at > last && blank(value[at - 1])) at--; return at; }, ahead = at => { while (at < value.length && blank(value[at])) at++; return at; };
  for (const [index, stop] of amounts(value)) {
    let open = back(index), close = ahead(stop);
    // "(+$200)" and "[$200]" go with their brackets.
    if (open > last && PAIRS[value[open - 1]] && value[close] === PAIRS[value[open - 1]]) { open--; close++; } else { open = index; close = stop; }
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
