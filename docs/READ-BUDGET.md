# Firestore read budget

Tracks STAFF-DATA-READ ([handoff/follow-ups.json](handoff/follow-ups.json)) and gate 1 of
[LAUNCH-ACCEPTANCE.md](LAUNCH-ACCEPTANCE.md). The numbers below are worked out from the code's own poll
intervals and an assumed database size. They are not production measurements. Replace the assumed counts with the
real ones from the Firebase console (see [For the owner](#for-the-owner)).

## What failed, and why

- **Cause: the Spark plan's hard daily quota.** Spark allows 50,000 document reads per day. Once a project passes
  that, Firestore answers **every** read with HTTP 429 `RESOURCE_EXHAUSTED` until the daily reset (midnight Pacific).
  The September 30 console notice ("daily 50K read limit exceeded") and the Hub's masked HTTP 429 ("Read Limited" in
  the Integrations read probe, `firebase-read-status.js`) both match this.
- **Not a rate limit, budget alert or in-code limiter.** `firestoreFetch` (`functions/_lib/firebase-service-account.js`)
  caches only the OAuth token and has no limiter. The Hub's client backoff (2, 4, 8, then 15 minutes after a failed
  read) only slows retries. A billing budget alert sends email and never stops reads.
- **Why the customer portal said "temporarily unavailable".** The portal itself reads about 5 documents per load.
  It failed because the shared daily quota was already spent by staff screens. Any 5xx from
  `/api/customer-portal-session` becomes `?error=unavailable`, which shows that message.
- **On Blaze** there is no daily cap, so that failure stops. The risk becomes cost. Blaze still includes 50,000 free
  reads per day; after that each 100,000 reads costs roughly $0.03–$0.06, depending on the database location (check
  the console's pricing for `egcw-1ec83`).

## Who reads what

Symbols:

| Symbol | Meaning | Assumed |
| --- | --- | --- |
| V | sealed Employee Hub records, all 10 families, all history. They are stored **in the `jobs` collection** | 2,500 (800 timecards, 900 team and 600 job messages, 60 read markers, about 140 other) |
| M | message families: teamMessages, jobMessages, messageReads | 1,560 |
| N_J | every `jobs` document: jobs, walkthroughs, locks, receipts, accounts **and V** | 4,300 |
| J | job chat rooms a crew member's poll checks for current assignment | 30 |

Hub users: 3 crew, 2 estimators and 1 office user, each with the Hub visible 8 hours (480 one-minute polls). Polls
stop while the tab is hidden.

| Screen (client) | Endpoint, interval | Reads per call (before) |
| --- | --- | --- |
| Every Hub user (`employee-suite.js` people refresh) | `GET /api/employee-hub`, 60 s | **V** (whole-vault query) + 1 accounts query (office) + **J** job GETs (crew) |
| Crew chat (`employee-suite.js`) | `GET /api/employee-hub?view=messages`, 15 s | **M** + J |
| Crew and estimator Hub (`employee.html` `refreshCrewSchedule`), Copilot, crew home | `GET /api/crew-jobs`, 60 s | **N_J** (full `jobs` list scan) |
| Office Schedule board (`employee-dispatch.js`) | `GET /api/dispatch`, 60 s | N_J + resources + accounts + small batch reads |
| Time off (`employee-availability.js`) | `GET /api/crew-availability`, 60 s while open | **N_J** + resources + accounts |
| My day (`employee-field-today.js`) | `GET /api/field-jobs`, 60 s | about 30 (dated queries) |
| Crew job page (`crew/job.js`) | `field-jobs?view=timer` + `employee-hub?view=own-job-time`, 30 s | about 3 |
| Customer portal (`customer-portal.html`) | `GET /api/customer-portal`, 20 s while visible | about 5 |
| Knock app (`crew/knock-app.js`) | `knock-sync` after each door, `knock-territory` deltas | about 10–15k per rep per 100 doors |

## A realistic day: before and after this change

The office user also has the chat open: each of the 3 crews keeps chat open 1 hour, and each user opens Time off for
10 minutes. Twenty customers open the portal about 15 polls each. Two reps knock doors.

| Reader | Before (reads/day) | After (reads/day) | Arithmetic (after) |
| --- | ---: | ---: | --- |
| `/api/crew-jobs` (5 non-office users) | 10,320,000 | 10,320,000 | 5 × 480 × 4,300. Unchanged; see [next steps](#what-is-still-expensive) |
| `/api/employee-hub` full view (6 users) | 7,272,480 | about 235,000 (shared cache) to 975,000 (worst case) | see below |
| `/api/dispatch` (office, 8 h) | 2,092,800 | 2,092,800 | 480 × (4,300 + about 60). Unchanged |
| Crew chat, extra 15 s polls (3 crews × 1 h) | 858,600 | about 16,700 | 540 polls × (1 + 30 room checks); changed families counted in the Hub row |
| Time off (6 users × 10 min) | 258,000 | about 6,000 | 60 refreshes × about 100 availability rows |
| My day, crew job page, office listener on load | about 110,000 | about 110,000 | Unchanged |
| Knock (2 reps) | about 30,000 | about 30,000 | Unchanged |
| Customer portal (20 customers) | about 1,500 | about 1,500 | 20 × 15 × 5 |
| **Total** | **about 20.9 million** | **about 12.8 million** (13.5 million worst case) | |

Arithmetic for each row:

- **Before, Hub full view:** 6 × 480 × 2,500 = 7,200,000. Add 480 for the office user's accounts query and
  5 × 480 × 30 = 72,000 for the crew job-room checks.
- **After, Hub full view.** The total is three parts:
  - **Polls:** 480 office polls × (1 revision + 4 empty, never-written families + 1 accounts query) = 2,880, plus
    2,400 other polls × (1 + 4) = 12,000. Add the unchanged 72,000 room checks. That comes to about 86,900.
  - **Snapshot expiry:** each cached copy refreshes every family every 15 minutes: 32 × 2,500 = 80,000.
  - **Write invalidations:** about 150 vault writes a day. Each re-reads only its own family:
    - 60 messages × about 750 = 45,000
    - 60 read markers × 60 = 3,600
    - 24 timecard saves × 800 = 19,200
    - about 300 other

    That is about 68,100 per cached copy.

  With one copy per data center (the Cache API), the total is about 235,000. If every user lands on a separate
  isolate and the Cache API is unavailable, it is 86,900 + 6 × 148,100 ≈ 975,000.
- **Spark comparison:** before, one office user with the Hub, Schedule board and Copilot open passes 50,000 reads in
  about **5 minutes**. Spark could never hold this workload. That is why the daily quota ran out.

## What changed

1. **Employee Hub vault snapshot** (`functions/_lib/employee-vault.js` `vaultSnapshot`, used by
   `functions/api/employee-hub.js` GET). The Hub poll used to read every sealed record ever saved. Now:
   - Every vault write sets its family's field in `employee_vault_revisions/current` to a fresh random value.
     `writeOne`, `commitVaultDocuments` and timecard commits all write the record and the mark in **one atomic
     commit**. A saved record is never left unmarked: not after a lost reply, not when the client disconnects, and not
     when the commit is refused, which saves and marks nothing. A replayed chat message that writes nothing still
     marks its family, so a save an older deployment left unmarked during the rollout shows on the next poll.
   - A poll reads that one document first. A family unchanged since this isolate (or this data center's Cache API
     copy) last read it, within 15 minutes, is answered from the sealed documents that read returned, decrypted again.
   - Answers are byte-for-byte the whole-vault read's answers (tested), and fail closed the same way.
   - Only ciphertext is cached, never decrypted payroll or personal data.
   - Every isolate, and every data center, sees the new revision on its next poll, because the mark is in Firestore.
     Tests cover two separate isolates sharing one data-center cache.
   - If the replay mark itself fails, this isolate forgets its copy.
   - Writes made outside these paths (console edits, or an older deployment still serving during the rollout) show
     within 15 minutes.
   - Until the first write creates the revision document, and with `EGC_EMPLOYEE_VAULT_QUERY=legacy`, the Hub reads
     exactly as before.
   - No new index is needed. Firestore rules deny the new collection to browsers (catch-all deny).
2. **Time off screen** (`functions/_lib/crew-availability.js`). Two single-field equality queries
   (`type == 'availability'`, `recordType == 'crew_availability'`) replace the full `jobs` scan. That is exactly the
   set the screen filters for. The answer is tested identical, and reads drop from N_J to the availability rows.

Tests: `tests/employee-vault-snapshot.test.mjs` and the Time off case in `tests/read-budget.test.mjs`. Both count
billed reads with the repo's read meter, before against after.

## What is still expensive

1. **`/api/crew-jobs`, about 10 million reads a day: the largest remaining reader.** Every crew and estimator Hub
   scans the whole `jobs` collection each minute.
   - **Why a filtered query was not used:** crew assignment matching is deliberately fuzzy (display names,
     punctuation variants, legacy `assignedTo`). A narrowed query could drop a job a crew member sees today.
   - **Why a revision marker was not used:** the office Hub writes `jobs` directly from the browser, so no
     writer-maintained marker can cover every change.
   - **Biggest structural lever:** move the sealed Employee Hub records (V, about 58% of N_J in this example) out of
     `jobs` into their own collection. That cuts every `jobs` scan by V: crew-jobs, dispatch, the remaining
     availability path, and the office Hub's live `jobs` listener, which today pays one read per chat message or
     clock-in. It is a storage migration with its own plan and review.
2. **`/api/dispatch`, about 2 million.** `EGC_DISPATCH_WINDOWED_READS=windowed` already bounds these reads to a date
   window. Turn it on after the `jobs(endDate, date)` index is deployed (see
   [SCHEDULING-D2D-GO-LIVE.md](SCHEDULING-D2D-GO-LIVE.md)).
3. **Crew job-room checks:** 1 job GET per room on each crew poll (about 72,000 a day here). They stay uncached, so a
   removed crew member loses a room on the next poll.

## For the owner

**In the Firebase console** (project `egcw-1ec83`):

1. **Usage and billing → Details & settings:** confirm the plan says **Blaze**.
2. **Firestore Database → Usage:** watch **Reads** per day for a week before and after this release. Expect the drop
   to show on a normal Hub day. If daily reads stay above about 15 million, the database is larger than assumed here.
   Send the numbers to the developer.
3. **Optional, Firestore Database → Query insights (if shown):** the most-read queries. Expect the `jobs` list scan
   (crew-jobs, dispatch) at the top.

**Budget alert** (Google Cloud console → Billing → **Budgets & alerts** → Create budget, scoped to project
`egcw-1ec83`):

1. Set the amount to **$150 per month** to start. About 12.8 million reads a day is roughly 380 million a month,
   which is $115–$230 a month depending on location, before the free 50,000 a day.
2. Add alert thresholds at **50%, 90% and 100%** of actual spend, plus **100% of forecasted** spend. Email the owner.
3. After the first full month, set the amount to about 1.5 × that month's real Firestore cost.

A budget alert only emails; it does not stop the Hub. For an early warning on a runaway screen, also add a Cloud
Monitoring alert on `firestore.googleapis.com/document/read_count`: more than 20 million in 24 hours.

**After this deploys,** re-run gate 1: Hub → Integrations shows **Readable**. The roster, Walkthroughs, crew schedule
and a portal document load.
