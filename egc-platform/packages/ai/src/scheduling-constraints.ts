import type { SchedulingConstraints, SchedulingDateMention, SchedulingDayPart, SchedulingUrgency, SchedulingWeekday } from "@egc/schemas";

/** Scheduling constraints (FUN-08). The model copies what the customer said; this module decides which spoken values
 * a quote supports and resolves date words into America/Denver calendar dates against ONE anchor: the visit's
 * walkthroughVisit.startedAt as the FUN-37 hub.walkthrough.outcomes feed reports it. A visit that was never Started
 * falls back to its scheduled date, flagged. Upload, processing and wall-clock time are never read: nothing here
 * takes a clock. Words it cannot read with certainty stay unresolved or ambiguous with their quote, never guessed.
 * No runtime imports, so the Hub's root tests load this file directly beside the feed.
 */
export const SCHEDULING_TIME_ZONE = "America/Denver";
const WEEKDAYS: readonly SchedulingWeekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_PARTS: readonly SchedulingDayPart[] = ["morning", "midday", "afternoon", "evening"];

/** Lowercase words and digits with single spaces (NFKC); "/" stays for numeric dates, apostrophes go ("o'clock"). */
const words = (value: string) => value.normalize("NFKC").toLowerCase().replace(/['‘’]/g, "").replace(/[^\p{L}\p{N}/]+/gu, " ").trim();
const alternatives = (keys: Iterable<string>) => [...keys].sort((a, b) => b.length - a.length).join("|");

const MONTHS = new Map<string, number>([["january", 1], ["jan", 1], ["february", 2], ["feb", 2], ["march", 3], ["mar", 3], ["april", 4], ["apr", 4], ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8], ["september", 9], ["sept", 9], ["sep", 9], ["october", 10], ["oct", 10], ["november", 11], ["nov", 11], ["december", 12], ["dec", 12]]);
const ORDINAL_UNITS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
const ORDINALS = new Map<string, number>([...ORDINAL_UNITS.map((word, i) => [word, i + 1] as [string, number]),
  ...["tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"].map((word, i) => [word, i + 10] as [string, number]),
  ...ORDINAL_UNITS.map((word, i) => [`twenty ${word}`, i + 21] as [string, number]), ["thirtieth", 30], ["thirty first", 31]]);
const SHORT: Readonly<Record<SchedulingWeekday, readonly string[]>> = { monday: ["mon"], tuesday: ["tue", "tues"], wednesday: ["wed", "weds"], thursday: ["thu", "thur", "thurs"], friday: ["fri"], saturday: ["sat"], sunday: ["sun"] };
const WEEKDAY_WORDS = new Map<string, number>(WEEKDAYS.flatMap((day, index) => [day, ...SHORT[day]].map(word => [word, index] as [string, number])));
const PLURAL_WEEKDAYS = new Map<string, readonly SchedulingWeekday[]>([...WEEKDAYS.map(day => [`${day}s`, [day]] as [string, readonly SchedulingWeekday[]]),
  ["weekend", ["saturday", "sunday"]], ["weekends", ["saturday", "sunday"]], ["weekday", WEEKDAYS.slice(0, 5)], ["weekdays", WEEKDAYS.slice(0, 5)]]);

// "sat", "sun" and "wed" are ordinary words too ("we sat down", "we'd"), so they count only before a date or a part of
// the day ("Sat the 10th", "Wed 10/14", "Sun morning") or beside another weekday ("Sat or Sun").
const AMBIGUOUS_SHORT = new Set(["sat", "sun", "wed"]);
const DATE_AFTER = new RegExp(String.raw`^(?:the )?(?:\d|(?:${alternatives(ORDINALS.keys())}|${alternatives(MONTHS.keys())}|mornings?|afternoons?|evenings?|nights?)\b)`);
const JOINERS = new Set(["or", "and", "to", "through", "thru"]);
/** The weekdays a quote names: a weekday or its short form, plural or not; weekends and weekdays count as their days. */
export function spokenWeekdays(text: string): Set<SchedulingWeekday> {
  const said = new Set<SchedulingWeekday>(), tokens = words(text).split(/[ /]+/);
  const beside = (i: number, step: number) => { const j = JOINERS.has(tokens[i + step] ?? "") ? i + 2 * step : i + step, word = tokens[j] ?? ""; return WEEKDAY_WORDS.has(word) || PLURAL_WEEKDAYS.has(word); };
  tokens.forEach((word, i) => {
    const index = WEEKDAY_WORDS.get(word);
    if (index !== undefined && (!AMBIGUOUS_SHORT.has(word) || DATE_AFTER.test(tokens.slice(i + 1).join(" ")) || beside(i, -1) || beside(i, 1))) said.add(WEEKDAYS[index]!);
    for (const day of PLURAL_WEEKDAYS.get(word) ?? []) said.add(day);
  });
  return said;
}

// A word is negated when one of these is among the four words before it in its clause ("not in the morning", "no need
// to rush", "not in a big rush"). Clauses end at punctuation, so "No, it's urgent" is not negated.
const NEGATORS = new Set(["no", "not", "nothing", "never", "without", "except", "dont", "doesnt", "isnt", "arent", "wont", "cant", "cannot"]);
const clauses = (text: string) => text.split(/[,;!?()\n]|[.:](?=\s|$)|\s[-–—]\s|[–—]/).map(words).filter(Boolean);
const negated = (clause: string, index: number) => clause.slice(0, index).trim().split(" ").slice(-4).some(word => NEGATORS.has(word));
const spokenIn = (text: string, pattern: RegExp) => clauses(text).some(clause => [...clause.matchAll(pattern)].some(match => !negated(clause, match.index)));

const CLOCK = String.raw`\d{1,2}(?: \d{2})? ?`;
const LATER_PARTS = "afternoons?|evenings?|nights?|midday|mid day|noon|lunch|lunchtime";
// "Early" is the morning unless a later part of the day or a date follows it ("early afternoon", "early next week").
const EARLY = String.raw`early(?! (?:(?:in|on) )?(?:the )?(?:next |this |coming )?(?:${LATER_PARTS}|week|weekend|month|year|${alternatives(MONTHS.keys())}|${alternatives(WEEKDAY_WORDS.keys())})\b)`;
const DAY_PART_WORDS: Readonly<Record<SchedulingDayPart, RegExp>> = {
  morning: new RegExp(String.raw`\b(?:mornings?|${EARLY}|first thing|before (?:noon|lunch|midday)|${CLOCK}(?:am|a m))\b`, "g"),
  midday: /\b(?:midday|mid day|noon|lunch|lunchtime|middle of the day)\b/g,
  afternoon: new RegExp(String.raw`\b(?:afternoons?|after (?:noon|lunch)|${CLOCK}(?:pm|p m))\b`, "g"),
  evening: new RegExp(String.raw`\b(?:evenings?|nights?|tonight|after (?:work|dinner)|${CLOCK}(?:pm|p m))\b`, "g")
};
/** The parts of the day a quote names ("mornings", "after lunch", "9 am", "after work"), except negated ones. */
export function spokenDayParts(text: string): Set<SchedulingDayPart> {
  return new Set(DAY_PARTS.filter(part => spokenIn(text, DAY_PART_WORDS[part])));
}

const FLEXIBLE = /\b(?:no (?:big |real )?(?:rush|hurry)|no need to (?:rush|hurry)|not in (?:a|any) (?:big |real )?(?:rush|hurry)|not urgent|not an emergency|whenever|flexible|any ?time|no deadline|take your time|no time frame|no timeline)\b/;
const ASAP = /\b(?:asap|a s a p|as soon as (?:possible|you can)|right away|urgent|urgently|immediately|emergency|right now)\b/g;
const SOON = /\b(?:soon|sooner|soonest|quickly|quick|hurry|hurrying|rush|rushed|rushing|shortly)\b/g;
/** The urgency a quote states. "No rush" and its kin, or any urgency word said with a negation ("not super urgent",
 * "don't rush it"), mean flexible and nothing else, so "not urgent" is never urgent. */
export function spokenUrgencies(text: string): Set<SchedulingUrgency> {
  const found = (pattern: RegExp) => clauses(text).flatMap(clause => [...clause.matchAll(pattern)].map(match => negated(clause, match.index)));
  const asap = found(ASAP), soon = found(SOON);
  if (FLEXIBLE.test(words(text)) || [...asap, ...soon].some(Boolean)) return new Set(["flexible"]);
  const said = new Set<SchedulingUrgency>();
  if (asap.length) said.add("asap").add("soon");
  if (soon.length) said.add("soon");
  return said;
}

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const CARDINALS = new Map<string, number>([...UNITS.map((word, n) => [word, n] as [string, number]),
  ...[["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50]].flatMap(([tens, n]) => [[tens, n], ...UNITS.slice(1, 10).map((unit, i) => [`${tens} ${unit}`, (n as number) + i + 1])] as [string, number][])]);
const NUMBER_WORDS = new RegExp(String.raw`\b(${alternatives(CARDINALS.keys())})( and a half)?\b`, "g");
/** Every number a mention says: digits (with decimals), number words to fifty-nine, "X and a half", "an hour" (1),
 * "half an hour" (0.5), "an hour and a half" (1.5), and "a couple" or "a pair" (2). "A few" or "half a day" say none. */
export function spokenNumbers(text: string): Set<number> {
  const said = new Set<number>();
  // Like words(), but a point between digits stays a decimal point.
  let rest = ` ${text.normalize("NFKC").toLowerCase().replace(/['‘’]/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ")} `;
  const take = (pattern: RegExp, value: (groups: (string | undefined)[]) => number) => {
    rest = rest.replace(pattern, (_match: string, ...groups: unknown[]) => { said.add(value(groups.map(group => typeof group === "string" ? group : undefined))); return " | "; });
  };
  take(/\b(?:(?:an?|one) )?(?:hour|hr) and a half\b/g, () => 1.5);
  take(/\bhalf (?:an? )?(?:hour|hr)\b/g, () => 0.5);
  take(/\ban? (?:hour|hr)\b/g, () => 1);
  take(/(\d+(?:\.\d+)?)( and a half)?/g, ([digits, half]) => Number(digits) + (half ? 0.5 : 0));
  take(NUMBER_WORDS, ([word, half]) => CARDINALS.get(word!)! + (half ? 0.5 : 0));
  take(/\b(?:couple|pair)\b/g, () => 2);
  return said;
}

// ---------------------------------------------------------------------------------------------------------------------
// The anchor.

export type SchedulingAnchor = {
  source: "walkthrough_started" | "scheduled_date" | "none";
  /** walkthroughVisit.startedAt of the occurrence, as an ISO instant; null when the visit was never Started. */
  startedAt: string | null;
  /** The Denver calendar date every relative mention counts from. */
  date: string | null;
  timeZone: typeof SCHEDULING_TIME_ZONE;
  flagged: boolean;
  reason: "walkthrough_not_started" | "anchor_unknown" | null;
};
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DENVER = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
function denverDate(ms: number) {
  const parts = Object.fromEntries(DENVER.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function calendarDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const { year, month, day } = parts(value);
  return ymd(year, month, day) === value ? value : null;
}

/** The anchor for one visit: its Start (the Denver date of startedAt, so a Start at 23:30 Denver is that day, not the
 * UTC one), else its scheduled Denver date (flagged), else none (flagged; only dates with a spoken year resolve). */
export function schedulingAnchor(input: { startedAt?: unknown; scheduledDate?: unknown }): SchedulingAnchor {
  const ms = typeof input.startedAt === "string" && INSTANT.test(input.startedAt) ? Date.parse(input.startedAt) : Number.NaN;
  if (Number.isFinite(ms)) return { source: "walkthrough_started", startedAt: new Date(ms).toISOString(), date: denverDate(ms), timeZone: SCHEDULING_TIME_ZONE, flagged: false, reason: null };
  const scheduled = calendarDate(input.scheduledDate);
  if (scheduled) return { source: "scheduled_date", startedAt: null, date: scheduled, timeZone: SCHEDULING_TIME_ZONE, flagged: true, reason: "walkthrough_not_started" };
  return { source: "none", startedAt: null, date: null, timeZone: SCHEDULING_TIME_ZONE, flagged: true, reason: "anchor_unknown" };
}
/** The anchor from one FUN-37 hub.walkthrough.outcomes item: its startedAt (the same occurrence as the outcome), else
 * that occurrence's scheduled date. An event_only item carries neither, so its anchor is unknown. */
export function schedulingAnchorFromOutcome(outcome: unknown): SchedulingAnchor {
  const item: Record<string, unknown> = plain(outcome) ? outcome : {}, occurrence: Record<string, unknown> = plain(item.occurrence) ? item.occurrence : {};
  return schedulingAnchor({ startedAt: item.startedAt, scheduledDate: occurrence.date });
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendar arithmetic on Denver dates (UTC noon, so no daylight-saving change can move a day).

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
function parts(date: string) { return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) }; }
const noon = (date: string) => { const { year, month, day } = parts(date); return Date.UTC(year, month - 1, day, 12); };
const addDays = (date: string, days: number) => new Date(noon(date) + days * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday. */
const weekdayOf = (date: string) => (new Date(noon(date)).getUTCDay() + 6) % 7;
const weekStart = (date: string) => addDays(date, -weekdayOf(date));
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
function ymd(year: number, month: number, day: number) {
  return Number.isInteger(year) && year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= daysIn(year, month) ? `${year}-${pad(month)}-${pad(day)}` : null;
}
function addMonths(date: string, months: number) {
  const { year, month, day } = parts(date), index = year * 12 + month - 1 + months, y = Math.floor(index / 12), m = index % 12 + 1;
  return ymd(y, m, Math.min(day, daysIn(y, m)))!;
}
const later = (a: string, b: string) => a > b ? a : b;

// ---------------------------------------------------------------------------------------------------------------------
// Date words.

export type SchedulingUnresolvedReason = "anchor_unknown" | "unsupported_expression" | "direction_conflict" | "date_in_past" | "invalid_date" | "weekday_mismatch" | "recurring_not_a_date";
// `end` marks words that name the end of a month ("the end of October"): its last day is certain, where that end starts
// is not. So "by" or "before" it means the last day, while "not until" it may mean its first or its last day. "By" any
// other period ("by next week", "by November") may mean its start or its end.
type Span = { from: string; to: string; end?: boolean };
type Reading = { spans: Span[] } | { weekdays: SchedulingWeekday[] } | { reason: SchedulingUnresolvedReason };
type Modifier = "after" | "from" | "before" | "by" | "within" | null;

const COUNTS = new Map<string, number>([["a", 1], ["an", 1], ...UNITS.slice(1).map((word, i) => [word, i + 1] as [string, number]), ["a couple of", 2], ["a couple", 2], ["couple of", 2], ["couple", 2]]);
const MONTH = `(${alternatives(MONTHS.keys())})`;
const WD = `(${alternatives(WEEKDAY_WORDS.keys())})`;
const DAY = String.raw`(\d{1,2}(?:st|nd|rd|th)?|${alternatives(ORDINALS.keys())})`;
const ORDINAL = String.raw`(\d{1,2}(?:st|nd|rd|th)|${alternatives(ORDINALS.keys())})`;
const COUNT = String.raw`(\d{1,3}|${alternatives(COUNTS.keys())})`;
const MONTH_REF = `(month|this month|next month|next ${MONTH}|${MONTH})`;
const YEAR = String.raw`(?: (\d{4}))?`;
const re = (source: string) => new RegExp(`^${source}$`);
const PATTERNS = {
  monthDay: re(`(?:${WD} )?${MONTH} (?:the )?${DAY}${YEAR}`),
  dayMonth: re(`(?:${WD} )?(?:the )?${DAY} (?:of )?${MONTH}${YEAR}`),
  numeric: re(String.raw`(?:${WD} )?(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?`),
  dayOfMonthRef: re(`(?:${WD} )?(?:the )?${DAY} of (?:the |this )?(month|next month)`),
  lastDay: re(`(?:the )?last day of (?:the |this )?${MONTH_REF}${YEAR}`),
  dayOnly: re(`(?:${WD} )?(?:the ${DAY}|${ORDINAL})`),
  today: /^(?:today|tonight|this (?:morning|afternoon|evening))$/,
  tomorrow: /^tomorrow(?: (?:morning|afternoon|evening|night))?$/,
  dayAfterTomorrow: /^(?:the )?day after tomorrow$/,
  thisWeekend: /^(?:this|the|this coming|coming) weekend$/,
  nextWeekend: /^next weekend$/,
  thisWeek: /^(?:this|the|this coming|current) week$/,
  nextWeek: /^(?:the )?next week$/,
  weekAfterNext: /^(?:the )?week after next$/,
  weekOf: /^(?:the )?week of (.+)$/,
  offset: re(String.raw`(?:${COUNT} )?(days?|weeks?|months?)(?: (?:from (?:now|today)|out|away|time))?`),
  plural: re(`(${alternatives(PLURAL_WEEKDAYS.keys())})`),
  thisWeekday: re(`(this coming|coming|this) ${WD}`),
  weekday: re(WD),
  nextWeekday: re(`next ${WD}`),
  weekdayNextWeek: re(`${WD} (?:of )?next week`),
  weekdayThisWeek: re(`${WD} (?:of )?this week`),
  weekOfMonth: re(`(?:the )?(first|1st|second|2nd|third|3rd|fourth|4th|last) week (?:of|in) (?:the |this )?${MONTH_REF}${YEAR}`),
  monthPart: re(`(?:(early|mid|middle of|late|end of|beginning of|start of|first half of|second half of|the end of|the beginning of|the start of|the middle of|the first half of|the second half of) )?(?:the )?${MONTH_REF}${YEAR}`)
};
const dayValue = (token: string) => /^\d/.test(token) ? Number.parseInt(token, 10) : ORDINALS.get(token) ?? 0;
const point = (date: string): Reading => ({ spans: [{ from: date, to: date }] });
const unresolved = (reason: SchedulingUnresolvedReason): Reading => ({ reason });
const needAnchor = unresolved("anchor_unknown");

function onWeekday(reading: Reading, token: string | undefined): Reading {
  if (!token || !("spans" in reading)) return reading;
  return reading.spans.every(span => weekdayOf(span.from) === WEEKDAY_WORDS.get(token)) ? reading : unresolved("weekday_mismatch");
}
// A month, or a date in it, said without a year: one whose month ended up to 60 days before the anchor (or has not
// ended) was most likely said about the past and is not a scheduling date; otherwise the next one ahead.
const recent = (year: number, month: number, anchor: string) => (noon(anchor) - noon(ymd(year, month, daysIn(year, month))!)) / DAY_MS <= 60;
function monthDay(month: number, day: number, yearText: string | undefined, anchor: string | null): Reading {
  if (yearText) { const year = Number(yearText.length === 2 ? `20${yearText}` : yearText), date = ymd(year, month, day); return date ? point(date) : unresolved("invalid_date"); }
  if (!anchor) return needAnchor;
  const { year } = parts(anchor), last = [year, year - 1].map(y => ymd(y, month, day)).find(date => date !== null && date < anchor);
  if (last && recent(parts(last).year, month, anchor)) return unresolved("date_in_past");
  const next = [year, year + 1].map(y => ymd(y, month, day)).find(date => date !== null && date >= anchor);
  return next ? point(next) : unresolved("invalid_date");
}
// A day of the month alone: this month's when still ahead (or today); one up to a week back was most likely said about
// the past; else next month's.
function dayOfMonth(day: number, anchor: string | null): Reading {
  if (!anchor) return needAnchor;
  const { year, month, day: today } = parts(anchor);
  if (day >= 1 && day < today && today - day <= 7) return unresolved("date_in_past");
  const date = day >= today ? ymd(year, month, day) : null, next = addMonths(`${year}-${pad(month)}-01`, 1);
  const following = date ?? ymd(parts(next).year, parts(next).month, day);
  return following ? point(following) : unresolved("invalid_date");
}
function monthOf(ref: string, name: string | undefined, yearText: string | undefined, anchor: string | null): { year: number; month: number } | SchedulingUnresolvedReason {
  if (yearText && name && !ref.startsWith("next ")) return { year: Number(yearText), month: MONTHS.get(name)! };
  if (!anchor) return "anchor_unknown";
  const now = parts(anchor);
  if (ref === "month" || ref === "this month") return { year: now.year, month: now.month };
  if (ref === "next month") { const next = parts(addMonths(anchor, 1)); return { year: next.year, month: next.month }; }
  const month = MONTHS.get(name!)!;
  if (month === now.month) return { year: ref.startsWith("next ") ? now.year + 1 : now.year, month };
  if (!ref.startsWith("next ") && recent(month < now.month ? now.year : now.year - 1, month, anchor)) return "date_in_past";
  return { year: month > now.month ? now.year : now.year + 1, month };
}
// A span inside the anchor's past is cut to start at the anchor; one wholly past is not a scheduling date.
function ahead(spans: Span[], anchor: string | null): Reading {
  if (!anchor) return { spans };
  const kept = spans.filter(span => span.to >= anchor).map(span => ({ ...span, from: later(span.from, anchor) }));
  return kept.length ? { spans: kept } : unresolved("date_in_past");
}
const byDates = (a: { from: string; to: string | null }, b: { from: string; to: string | null }) => a.from < b.from ? -1 : a.from > b.from ? 1 : (a.to ?? "") < (b.to ?? "") ? -1 : (a.to ?? "") > (b.to ?? "") ? 1 : 0;
const unique = (spans: Span[]) => spans.filter((span, index) => spans.findIndex(other => other.from === span.from && other.to === span.to) === index).sort(byDates);

function reading(text: string, anchor: string | null): Reading {
  const P = PATTERNS;
  let m: RegExpMatchArray | null;
  if ((m = text.match(P.monthDay))) return onWeekday(monthDay(MONTHS.get(m[2]!)!, dayValue(m[3]!), m[4], anchor), m[1]);
  if ((m = text.match(P.dayMonth))) return onWeekday(monthDay(MONTHS.get(m[3]!)!, dayValue(m[2]!), m[4], anchor), m[1]);
  if ((m = text.match(P.numeric))) return onWeekday(monthDay(Number(m[2]), Number(m[3]), m[4], anchor), m[1]);
  if ((m = text.match(P.lastDay))) {
    const month = monthOf(m[1]!, m[2] ?? m[3], m[4], anchor);
    if (typeof month === "string") return unresolved(month);
    const date = ymd(month.year, month.month, daysIn(month.year, month.month))!;
    return ahead([{ from: date, to: date }], anchor);
  }
  if ((m = text.match(P.dayOfMonthRef))) {
    const month = monthOf(m[3]!, undefined, undefined, anchor);
    if (typeof month === "string") return unresolved(month);
    const date = ymd(month.year, month.month, dayValue(m[2]!));
    return date ? onWeekday(ahead([{ from: date, to: date }], anchor), m[1]) : unresolved("invalid_date");
  }
  if ((m = text.match(P.dayOnly))) return onWeekday(dayOfMonth(dayValue(m[2] ?? m[3]!), anchor), m[1]);
  if ((m = text.match(P.weekOfMonth))) {
    const month = monthOf(m[2]!, m[3] ?? m[4], m[5], anchor);
    if (typeof month === "string") return unresolved(month);
    const last = daysIn(month.year, month.month), which = m[1]!.replace(/\d(?:st|nd|rd|th)/, n => ORDINAL_UNITS[Number(n[0]) - 1]!);
    const start = which === "last" ? last - 6 : (ORDINAL_UNITS.indexOf(which) * 7) + 1;
    return ahead([{ from: ymd(month.year, month.month, start)!, to: ymd(month.year, month.month, Math.min(start + 6, last))! }], anchor);
  }
  if ((m = text.match(P.monthPart))) {
    const month = monthOf(m[2]!, m[3] ?? m[4], m[5], anchor);
    if (typeof month === "string") return unresolved(month);
    const last = daysIn(month.year, month.month), part = (m[1] ?? "").replace(/^the /, "");
    const [from, to] = /^(?:early|beginning of|start of)$/.test(part) ? [1, 10] : part === "first half of" ? [1, 15] : /^(?:mid|middle of)$/.test(part) ? [11, 20]
      : part === "second half of" ? [16, last] : /^(?:late|end of)$/.test(part) ? [21, last] : [1, last];
    return ahead([{ from: ymd(month.year, month.month, from)!, to: ymd(month.year, month.month, to)!, ...(part === "end of" ? { end: true } : {}) }], anchor);
  }
  if ((m = text.match(P.plural))) return { weekdays: [...PLURAL_WEEKDAYS.get(m[1]!)!] };
  if ((m = text.match(P.weekOf))) {
    const inner = reading(m[1]!, anchor);
    return "spans" in inner ? ahead(unique(inner.spans.map(span => ({ from: weekStart(span.from), to: addDays(weekStart(span.from), 6) }))), anchor) : "weekdays" in inner ? unresolved("unsupported_expression") : inner;
  }
  // Everything below counts from the anchor.
  if (!anchor) return needAnchor;
  const today = weekdayOf(anchor), monday = weekStart(anchor);
  const coming = (index: number) => addDays(anchor, (index - today + 7) % 7 || 7);
  if (P.today.test(text)) return point(anchor);
  if (P.tomorrow.test(text)) return point(addDays(anchor, 1));
  if (P.dayAfterTomorrow.test(text)) return point(addDays(anchor, 2));
  // "This weekend" said on a Sunday may be today or the coming one; "this coming weekend" then is the coming one.
  if (P.thisWeekend.test(text)) {
    const current = { from: later(addDays(monday, 5), anchor), to: addDays(monday, 6) }, following = { from: addDays(monday, 12), to: addDays(monday, 13) };
    return { spans: today < 6 ? [current] : text.includes("coming") ? [following] : [current, following] };
  }
  // "Next weekend" said Monday to Friday is the coming one or the one after it; said on a weekend, the one after.
  if (P.nextWeekend.test(text)) return { spans: unique([today < 5 ? { from: addDays(monday, 5), to: addDays(monday, 6) } : { from: addDays(monday, 12), to: addDays(monday, 13) }, { from: addDays(monday, 12), to: addDays(monday, 13) }]) };
  if (P.thisWeek.test(text)) return { spans: [{ from: anchor, to: addDays(monday, 6) }] };
  if (P.nextWeek.test(text)) return { spans: [{ from: addDays(monday, 7), to: addDays(monday, 13) }] };
  if (P.weekAfterNext.test(text)) return { spans: [{ from: addDays(monday, 14), to: addDays(monday, 20) }] };
  if ((m = text.match(P.offset))) {
    const n = m[1] === undefined ? 1 : /^\d/.test(m[1]) ? Number(m[1]) : COUNTS.get(m[1])!, unit = m[2]!;
    return point(unit.startsWith("day") ? addDays(anchor, n) : unit.startsWith("week") ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  }
  // A weekday said on that same weekday may mean today or a week today: both readings stay, for a person to pick.
  if ((m = text.match(P.thisWeekday))) { const index = WEEKDAY_WORDS.get(m[2]!)!; return m[1] === "this" && index === today ? { spans: [{ from: anchor, to: anchor }, { from: addDays(anchor, 7), to: addDays(anchor, 7) }] } : point(coming(index)); }
  if ((m = text.match(P.weekday))) { const index = WEEKDAY_WORDS.get(m[1]!)!; return index === today ? { spans: [{ from: anchor, to: anchor }, { from: addDays(anchor, 7), to: addDays(anchor, 7) }] } : point(coming(index)); }
  // "Next Tuesday" is the coming Tuesday to some people and next week's to others; when those differ, both stay. Said a
  // day or two before that weekday ("next Monday" on a Sunday), it may also mean the one a week later.
  if ((m = text.match(P.nextWeekday))) {
    const index = WEEKDAY_WORDS.get(m[1]!)!, first = coming(index), dates = [first, addDays(monday, 7 + index), ...(noon(first) - noon(anchor) <= 2 * DAY_MS ? [addDays(first, 7)] : [])];
    return { spans: unique(dates.map(date => ({ from: date, to: date }))) };
  }
  if ((m = text.match(P.weekdayNextWeek))) return point(addDays(monday, 7 + WEEKDAY_WORDS.get(m[1]!)!));
  if ((m = text.match(P.weekdayThisWeek))) { const date = addDays(monday, WEEKDAY_WORDS.get(m[1]!)!); return date >= anchor ? point(date) : unresolved("date_in_past"); }
  return unresolved("unsupported_expression");
}

const LEADS: readonly [RegExp, Exclude<Modifier, null>][] = [
  [/^(?:not until after|not till after|not til after|until after|till after|after|past|later than|following) /, "after"],
  [/^(?:not before|no earlier than|no sooner than|not until|not till|not til|starting (?:on|in|from|with)|starting|start (?:on|in)|beginning (?:on|in)|beginning|from|as of|on or after) /, "from"],
  [/^(?:within the next|within|in the next|in the coming) /, "within"],
  [/^(?:no later than|not later than|not after|on or before|by|until|till|til|through|thru|up to|up until|up till) /, "by"],
  [/^(?:before|prior to|ahead of|sooner than|earlier than) /, "before"]
];
const TRAILS: readonly [RegExp, Exclude<Modifier, null>][] = [
  [/ (?:or later|or after|onward|onwards|and later|and after|at the earliest)$/, "from"],
  [/ (?:at the latest|or earlier|or before|or sooner)$/, "by"]
];
const APPROXIMATE = /\b(?:around|about|roughly|approximately|ish|or so|give or take)\b/g;
const PREPOSITIONS = /^(?:(?:on|in|during|for|at|of) )+/;
// A dash after a date is a range ("Oct 19-23", "19th-23rd", "10/19-10/23"); "10-19" alone is not read.
const DASH = new RegExp(String.raw`(\b(?:${alternatives(MONTHS.keys())}) \d{1,2}(?:st|nd|rd|th)?|\b\d{1,2}(?:st|nd|rd|th)|\b\d{1,2}/\d{1,2})\s*[-–—]\s*(?=\d|(?:${alternatives(MONTHS.keys())}|the)\b)`, "gi");
const RANGES = [/^between (.+?) and (.+)$/, /^(?:from )?(.+?) (?:to|through|thru|till|til|until) (.+)$/];
const single = (value: Reading) => "spans" in value && value.spans.length === 1 ? value.spans[0]! : null;
/** "The 19th to the 23rd", "October 19 through 23", "between Monday and Friday": the first date through the second.
 * The second counts from the anchor, or else from the first date ("the 28th to the 3rd" ends next month). Null when
 * the words before the joiner are not a date, so "not until the 20th" and "up to the 23rd" keep their direction. */
function rangeReading(text: string, anchor: string | null): Reading | null {
  const m = RANGES.map(pattern => text.match(pattern)).find(Boolean);
  if (!m) return null;
  const first = reading(m[1]!.replace(PREPOSITIONS, ""), anchor);
  if ("weekdays" in first || "reason" in first && first.reason === "unsupported_expression") return null;
  if ("reason" in first) return first;
  const last = m[2]!.replace(PREPOSITIONS, "").replace(/^(\d{1,2})$/, "the $1"), spans: Span[] = [];
  for (const span of first.spans) {
    const ends = [reading(last, anchor), reading(last, span.from)], end = ends.map(single).find(value => value !== null && value.to >= span.from);
    if (end) { spans.push({ from: span.from, to: end.to }); continue; }
    const why = ends[1]!;
    return unresolved("reason" in why ? why.reason === "date_in_past" ? "invalid_date" : why.reason : single(why) ? "invalid_date" : "unsupported_expression");
  }
  return ahead(unique(spans), anchor);
}
/** One mention read as calendar spans (or recurring weekdays), with its direction word ("after", "by", ...). */
function parseMention(mention: string, anchor: string | null): { reading: Reading; modifier: Modifier; approximate: boolean } {
  let text = words(mention.replace(DASH, "$1 to ")), approximate = false, modifier: Modifier = null;
  text = text.replace(APPROXIMATE, () => { approximate = true; return " "; }).replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:(?:sometime|some time|any ?time|maybe|probably|hopefully|ideally|preferably|only|just) )+/, "");
  const range = rangeReading(text, anchor);
  if (range) return { reading: range, modifier: null, approximate };
  for (const [pattern, direction] of LEADS) if (pattern.test(`${text} `)) { modifier = direction; text = `${text} `.replace(pattern, "").trim(); break; }
  for (const [pattern, direction] of TRAILS) if (pattern.test(text)) {
    if (modifier && modifier !== direction) return { reading: unresolved("direction_conflict"), modifier, approximate };
    modifier = direction; text = text.replace(pattern, "").trim(); break;
  }
  text = text.replace(PREPOSITIONS, "").trim();
  return { reading: text ? reading(text, anchor) : unresolved("unsupported_expression"), modifier, approximate };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution.

export type SchedulingResolution = "resolved" | "ambiguous" | "unresolved";
/** A notBefore or notAfter mention. resolved: `date` is the first (notBefore) or last (notAfter) acceptable Denver
 * date. ambiguous: the words have several readings, listed in `candidates`, and a person picks. unresolved: `reason`. */
export type ResolvedSchedulingBound = SchedulingDateMention & {
  resolution: SchedulingResolution; date: string | null; candidates: string[]; approximate: boolean; reason: SchedulingUnresolvedReason | null;
};
/** An unavailable mention: Denver dates from..to (inclusive; to is null when open-ended), or recurring weekdays. */
export type ResolvedSchedulingUnavailable = SchedulingDateMention & {
  resolution: SchedulingResolution; from: string | null; to: string | null; weekdays: SchedulingWeekday[];
  candidates: { from: string; to: string | null }[]; approximate: boolean; reason: SchedulingUnresolvedReason | null;
};
export type SchedulingFlag = "anchor_scheduled_date" | "anchor_unknown" | "mention_ambiguous" | "mention_unresolved" | "window_conflict";
export type ResolvedSchedulingConstraints = {
  anchor: SchedulingAnchor;
  preferredWeekdays: SchedulingConstraints["preferredWeekdays"];
  timeOfDay: SchedulingConstraints["timeOfDay"];
  notBefore: ResolvedSchedulingBound | null;
  notAfter: ResolvedSchedulingBound | null;
  unavailable: ResolvedSchedulingUnavailable[];
  /** Hints for staff (§5.1): shown flagged, never used to size a crew or a booking. */
  crewSizeMention: SchedulingConstraints["crewSizeMention"];
  durationHoursMention: SchedulingConstraints["durationHoursMention"];
  urgency: SchedulingConstraints["urgency"];
  flags: SchedulingFlag[];
};

function bound(kind: "notBefore" | "notAfter", item: SchedulingDateMention, anchor: string | null): ResolvedSchedulingBound {
  const { reading: read, modifier, approximate } = parseMention(item.mention, anchor);
  const base = { mention: item.mention, sourceQuote: item.sourceQuote, approximate };
  const fail = (reason: SchedulingUnresolvedReason): ResolvedSchedulingBound => ({ ...base, resolution: "unresolved", date: null, candidates: [], reason });
  if ("reason" in read) return fail(read.reason);
  if ("weekdays" in read) return fail("recurring_not_a_date");
  const allowed: readonly Modifier[] = kind === "notBefore" ? [null, "after", "from"] : [null, "before", "by", "within"];
  if (!allowed.includes(modifier)) return fail("direction_conflict");
  // The earliest date is the day after the words ("after next week") or their first day, and either end of "the end of
  // October". The latest is the last day of "the end of October" (by or before it), the day before other words
  // ("before the 15th"), a single day, or else either end of them.
  const dates = [...new Set(read.spans.flatMap(span => kind === "notBefore" ? modifier === "after" ? [addDays(span.to, 1)] : span.end ? [span.from, span.to] : [span.from]
    : span.end ? [span.to] : modifier === "before" ? [addDays(span.from, -1)] : span.from === span.to ? [span.to] : [span.from, span.to]))].sort();
  if (anchor && dates.some(date => date < anchor)) return fail("date_in_past");
  return dates.length === 1 ? { ...base, resolution: "resolved", date: dates[0]!, candidates: [], reason: null } : { ...base, resolution: "ambiguous", date: null, candidates: dates, reason: null };
}

function unavailable(item: SchedulingDateMention, anchor: string | null): ResolvedSchedulingUnavailable {
  const { reading: read, modifier, approximate } = parseMention(item.mention, anchor);
  const base = { mention: item.mention, sourceQuote: item.sourceQuote, approximate };
  const fail = (reason: SchedulingUnresolvedReason): ResolvedSchedulingUnavailable => ({ ...base, resolution: "unresolved", from: null, to: null, weekdays: [], candidates: [], reason });
  if ("reason" in read) return fail(read.reason);
  if ("weekdays" in read) return modifier ? fail("direction_conflict") : { ...base, resolution: "resolved", from: null, to: null, weekdays: read.weekdays, candidates: [], reason: null };
  if (modifier === "within") return fail("direction_conflict");
  if ((modifier === "before" || modifier === "by") && !anchor) return fail("anchor_unknown");
  // Away "before the end of the month" is through its last day; away "from the end of the month" may start on either end.
  const ranges = read.spans.flatMap((span): { from: string; to: string | null }[] => modifier === "after" ? [{ from: addDays(span.to, 1), to: null }]
    : modifier === "from" ? (span.end ? [span.from, span.to] : [span.from]).map(from => ({ from, to: null }))
    : modifier === "before" ? [{ from: anchor!, to: span.end ? span.to : addDays(span.from, -1) }] : modifier === "by" ? [{ from: anchor!, to: span.to }] : [{ from: span.from, to: span.to }]);
  if (anchor && ranges.some(range => range.to !== null && range.to < anchor)) return fail("date_in_past");
  const kept = ranges.map(range => ({ from: anchor ? later(range.from, anchor) : range.from, to: range.to }))
    .filter((range, index, all) => all.findIndex(other => other.from === range.from && other.to === range.to) === index);
  return kept.length === 1 ? { ...base, resolution: "resolved", from: kept[0]!.from, to: kept[0]!.to, weekdays: [], candidates: [], reason: null }
    : { ...base, resolution: "ambiguous", from: null, to: null, weekdays: [], candidates: kept, reason: null };
}

const dateMention = (value: unknown): SchedulingDateMention | null => plain(value) && typeof value.mention === "string" && typeof value.sourceQuote === "string" ? { mention: value.mention, sourceQuote: value.sourceQuote } : null;
/**
 * Resolves one extraction's scheduling constraints (parse stored rows with conversationExtractionSchema first) against
 * one anchor (schedulingAnchorFromOutcome). Null for an extraction made before FUN-08 (never extracted). An unparsed
 * shape does not throw: a missing constraint reads as not stated and a malformed date mention is skipped. Flags:
 * anchor_scheduled_date or anchor_unknown when a date
 * mention was counted from the fallback or could not be counted; mention_ambiguous and mention_unresolved when a
 * mention needs a person; window_conflict when the earliest resolved date is after the latest.
 */
export function resolveSchedulingConstraints(constraints: SchedulingConstraints | null | undefined, anchor: SchedulingAnchor): ResolvedSchedulingConstraints | null {
  if (!plain(constraints)) return null;
  const date = anchor.date, copy = <T>(value: T | undefined): T | null => value === null || value === undefined ? null : structuredClone(value);
  const before = dateMention(constraints.notBeforeMention), after = dateMention(constraints.notAfterMention);
  const notBefore = before ? bound("notBefore", before, date) : null;
  const notAfter = after ? bound("notAfter", after, date) : null;
  const away = (Array.isArray(constraints.unavailableMentions) ? constraints.unavailableMentions : []).map(dateMention).filter(item => item !== null).map(item => unavailable(item, date));
  const mentions = [notBefore, notAfter, ...away].filter(value => value !== null);
  const flags = new Set<SchedulingFlag>();
  if (mentions.length && anchor.source === "scheduled_date") flags.add("anchor_scheduled_date");
  if (mentions.length && anchor.source === "none") flags.add("anchor_unknown");
  if (mentions.some(item => item.resolution === "ambiguous")) flags.add("mention_ambiguous");
  if (mentions.some(item => item.resolution === "unresolved")) flags.add("mention_unresolved");
  if (notBefore?.date && notAfter?.date && notBefore.date > notAfter.date) flags.add("window_conflict");
  return {
    anchor: { ...anchor }, preferredWeekdays: copy(constraints.preferredWeekdays), timeOfDay: copy(constraints.timeOfDay), notBefore, notAfter, unavailable: away,
    crewSizeMention: copy(constraints.crewSizeMention), durationHoursMention: copy(constraints.durationHoursMention), urgency: copy(constraints.urgency), flags: [...flags].sort()
  };
}

/** FUN-09's join: a visit recording's v2 extraction with its FUN-37 hub.walkthrough.outcomes item, called as
 * walkthroughSchedulingConstraints(conversationExtractionSchema.parse(row.extraction.conversation), outcomeItem). Only
 * the outcome's start (or scheduled date) anchors the dates; the extraction's occurredAt (the upload time) is never read. */
export function walkthroughSchedulingConstraints(conversation: { schedulingConstraints?: SchedulingConstraints | null } | null | undefined, outcome: unknown) {
  return resolveSchedulingConstraints(conversation?.schedulingConstraints ?? null, schedulingAnchorFromOutcome(outcome));
}
