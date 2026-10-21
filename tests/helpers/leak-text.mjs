// Leak checks search a reply's JSON for a canary: an amount, a rate or a phone number ('4200', '8765', '23.17'). Values
// the code makes at random, or reads from the real clock, can hold such a run of digits by chance: '4200' is in about one
// random UUID in 2,100, '8765' in one 40-digit hex id in 1,800, and '23.17' in any time read at 23.17x seconds. Those
// values are blanked out before the search, so a check fails only when the reply itself carries the canary.
const RANDOM_VALUES = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/gi;
export const withoutRandomValues = text => String(text).replace(RANDOM_VALUES, '<random>');
