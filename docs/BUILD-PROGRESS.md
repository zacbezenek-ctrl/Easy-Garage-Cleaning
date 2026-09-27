# EGC build progress (resume point)

This file is the single resume point for the "EGC runs on its own software, run from Claude" build.
A new session must read this first, then continue from **Next**.

Branch policy: all work lands on `claude/amazing-shannon-n614n7` (the only branch this build session may push).
Each unit of work is one commit (or small commit series) prefixed with its unit ID, e.g. `P0-1:`; the branch has one
draft PR. The owner merges in phase order. See **Decisions** D-001.

## Status summary

| Phase | Status |
| --- | --- |
| 0 Baseline | in progress |
| 1 Multi-crew scheduling / crew hub / time / money | not started |
| 2 Garage catalog + walkthrough quoting | not started |
| 3 Transcript → phone-person follow-ups | not started |
| 4 Account-level customer portal | not started |
| 5 B2B client hub | not started |
| 6 MCP full read/write | not started |

## Done

- **P0-1** `tests/crew-availability.test.mjs:118` posted a hardcoded date (2026-09-23) that is now in the past.
  `crewAvailabilityHandlers` now accepts an injected `now` (same convention as `dispatchOpeningsHandlers`) and the
  test injects the fixture clock. No production behavior change (default `now` is the real clock).
- **P0-2** `tests/gallery-device-preview.test.mjs:27` asserted `gallery-preview-assets/gallery.js` was a byte copy of the
  internal gallery script. That file intentionally diverged in `2d4f5d5` (public showcase). Replaced with behavioral
  tests that execute the script against a fake DOM: no-grid pages untouched; search filter/count; manifest fetched
  only from `/gallery-showcase.json` with `credentials:'omit'`; invalid/hotlinked/duplicate items rejected; cap of 24;
  malformed/offline manifest keeps the existing gallery; no analytics/backend/storage. Mutation-checked (5 deliberate
  regressions each fail at least one test).
- Root suite after P0-1/P0-2: 934 tests, 933 pass, 0 fail, 1 skipped (emulator-only suite, run separately in CI).

## In progress

- Phase 0 audit: subsystem mapping workflow (14 parallel readers + completeness critic), CI-equivalent local runs
  (platform build/typecheck/test, Firestore emulator, Python browser tests), mobile audit.

## Next

- Record the gap analysis and the ordered unit plan here.

## Decisions

- **D-001 Branch/PR policy.** The mission asks for one PR per unit merged in phase order; this session may push only
  to `claude/amazing-shannon-n614n7`. Units are therefore separate, clearly prefixed commits on that branch with one
  draft PR. Merging to `main` deploys production (Cloudflare Pages git integration), so merge stays with the owner.

## Blockers

(none yet)
