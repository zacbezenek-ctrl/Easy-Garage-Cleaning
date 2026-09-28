# Testing

## Root suite

```sh
node --test tests/*.test.mjs        # same as npm test
```

Tests use `node:test` and `node:assert/strict`, synthetic data only, and an injected clock
(`now`, `page.clock.install`, `mock.timers`). They never assert against today's date.

Repo-wide scans go through `sourceFiles(root)` in `tests/source-files.mjs`. It skips agent
worktrees (`.claude/`, `worktrees/`), dependencies, build output and local QA captures
(`test-results/`, `field-qa/`, `.lighthouseci/`). Add to its ignore set instead of writing a new
directory walker. The public-copy scan in `tests/seo-walkthrough.test.mjs` and the legacy-quote
scan in `tests/legacy-quote-removal.test.mjs` are built on it.

## Clock-shift guard

The root suite also runs with the process clock moved 400 days ahead (the `shifted-clock` job
proposed for `.github/workflows/egc-root-ci.yml`; until the repository owner adds it, run it
locally). A test that reads the real clock instead of an injected one then fails today, not on
the day its hard-coded date passes:

```sh
NODE_OPTIONS="--import=$(node -p 'require("node:url").pathToFileURL("tests/helpers/shift-clock.mjs").href')" \
EGC_CLOCK_SHIFT_DAYS=400 node --test tests/*.test.mjs
```

Pass the preload as an absolute `file:` URL. `NODE_OPTIONS` reaches every child `node`, and
`tests/site-generator.test.mjs` starts one in a temporary working directory, where a relative
`--import=./tests/...` fails with `ERR_MODULE_NOT_FOUND`. `--import` also needs a URL rather
than a bare `C:\...` path on Windows.

`tests/helpers/shift-clock.mjs` loads `tests/helpers/clock-shift-core.mjs`, which moves
`Date.now()`, `new Date()`, `Date()`, `new (date.constructor)()`, the `Date.now` property
descriptor and `Intl.DateTimeFormat#format()`/`#formatToParts()` called without a date. Explicit
dates, `Date.parse`, `Date.UTC` and `node:test` mock timers stay exact.
`tests/shift-clock.test.mjs` pins all of this.

### Browser code in vm realms

Every `node:vm` context has its own native `Date`, which the preload never touches. A test that
runs front-end code in a realm must import the drop-in helper instead of `node:vm`:

```js
import vm from './helpers/vm-realm.mjs';
```

`createContext`, `runInNewContext` and `Script#runInNewContext` from the helper give each new
realm the same shift as the test process. Without the preload they are plain `node:vm` realms. A
sandbox that passes its own `Date` (the host `Date` or a fixed clock) keeps it. Every root test
that runs code in a realm without its own `Date` uses the helper; the rest pass the host `Date`
(shifted) or a fixed clock in the sandbox.

### Known blind spots

A green shifted run does not prove these read an injected clock:

| Blind spot | Why | Where it matters |
| --- | --- | --- |
| Realms made with `node:vm` directly | The realm has its own native `Date` | Any new test that imports `node:vm` instead of `tests/helpers/vm-realm.mjs` and gives the sandbox no `Date`. No current root test does |
| `Intl.DateTimeFormat#format()` without a date, in a realm whose sandbox passes its own `Date` but not `Intl` | Only the realm's `Date` is replaced | No current front-end code calls `format()` without a date |
| `performance.timeOrigin`, `performance.now()`, `process.hrtime()` | Left real on purpose; `tests/shift-clock.test.mjs` measures the shift against them | Timing, not calendar logic |
| Worker threads | `--import` preloads do not run in workers | No root test starts a worker |
| Child processes started without this process's `NODE_OPTIONS` | They run on the real clock | `tests/shift-clock.test.mjs` (deliberate); Python runs in `tests/site-generator.test.mjs`, which pin `EGC_SITE_BUILD_DATE` |
| Browser tests (`tests/browser/*.py`, `tests/*.browser.mjs`) | The browser has its own clock | They install a fixed clock with `page.clock.install` |
| Postgres `now()`, the Firestore emulator, the egc-platform Vitest suite | Separate processes or runners | `*.check.mjs`, `tests/firestore-emulator.test.mjs`, `egc-platform` (Vitest uses `vi.setSystemTime`) |
| Backward shifts | Only forward shifts run in CI | Session cookies minted on the real clock and verified under a mocked earlier date (see `tests/field-execution.test.mjs`) fail at negative shifts |
