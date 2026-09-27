// The only list of staff usernames with Hub business access, and the owner
// account. Names are lowercase configured Hub usernames. Adding a manager here
// grants business access (and reserves the name from employee signup) everywhere.
export const OWNER_USERNAME = 'zacb';

const names = Object.freeze([OWNER_USERNAME, 'tylerg', 'alexk']);
const members = new Set(names);

// A frozen read-only view (has() and iteration) over a Set no other module can
// reach. It is not a Set, so Set.prototype.add.call(BUSINESS_USERS, ...) throws
// instead of granting access. has() is an exact match, like Set#has: callers
// pass an already trimmed, lowercase username.
export const BUSINESS_USERS = Object.freeze({
  has: Object.freeze(name => members.has(name)),
  [Symbol.iterator]: Object.freeze(() => names[Symbol.iterator]()),
});
