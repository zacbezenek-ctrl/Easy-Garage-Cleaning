// Preload for `node --import`: moves this process's wall clock EGC_CLOCK_SHIFT_DAYS days ahead.
// CI runs the root suite under it so a test that reads the real clock instead of an injected
// `now` fails today rather than on the day its hard-coded date passes. Only argument-less
// `new Date()`, `Date()`, `Date.now()` and Intl.DateTimeFormat#format() move; explicit dates and
// node:test mock timers do not (see clock-shift-core.mjs for the full list).
//
// A green shifted run is NOT full coverage. It cannot see:
// - vm realms made with node:vm directly. Each has its own native Date, so tests that run
//   browser code in a realm import tests/helpers/vm-realm.mjs instead, which passes the shift on.
// - performance.timeOrigin, performance.now() and process.hrtime(), which stay real on purpose
//   (tests/shift-clock.test.mjs measures the shift against them).
// - worker threads, and child processes started without this process's NODE_OPTIONS.
// - Python/Playwright browser tests, Postgres now(), the Firestore emulator and other processes.
// docs/testing.md lists these blind spots and the files that still have them.
import { installClockShift } from './clock-shift-core.mjs';

const raw = process.env.EGC_CLOCK_SHIFT_DAYS ?? '', days = Number(raw);
if (raw.trim() && !Number.isFinite(days)) throw new Error(`EGC_CLOCK_SHIFT_DAYS must be a number of days, got ${JSON.stringify(raw)}`);
if (days) installClockShift(globalThis, Math.round(days * 86400000));
