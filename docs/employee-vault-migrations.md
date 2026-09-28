# Employee vault migrations

Encrypted employee records (employee accounts, the `employee_hub_v2` families such as
`profiles` and `timeEntries`, and `employee_time_locks`) cannot be changed by hand in
Firestore: every document is sealed with AES-GCM under a key derived from
`EMPLOYEE_HUB_DATA_SECRET`, bound (AAD) to its opaque document id. Shape changes to
these records go through the migration framework in
`functions/_lib/employee-vault-migrate.js`.

## Rules the framework enforces

- **Dry run by default.** A dry run decrypts every record of the family and reports
  what would change. It writes nothing, not even a receipt.
- **All-or-nothing reads.** Every record is read and decrypted before the first write.
  One unreadable or malformed record aborts the run with no writes
  (`employee_vault_migration_unreadable`).
- **Read-only recovery.** When the vault is in legacy-key recovery
  (`EMPLOYEE_HUB_LEGACY_KEY_SOURCE` set without `EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED=true`)
  every run is refused with 503 before anything is read.
- **Pure, idempotent transforms.** A transform receives a copy of one record and returns
  only the fields to add or `null`. The migration id is appended to `payload.migrations[]`;
  records that already list it are skipped, so a second run is a no-op.
- **Protected fields.** A transform may not change identity, credential, pay-snapshot or
  approval fields (see `PROTECTED_FIELDS`). For timecards these include every field the
  Gusto content hash and review fingerprint are computed from (`approvedAt`, `approvedBy`,
  `breaks`, `status`, `clockInAt`, `clockOutAt`, ...), so a migration can never make an
  approved, synced timecard look changed. `migrations` and `history` are managed by the
  framework. A violation aborts the whole run before any write.
- **Per-record compare-and-set.** Each changed record is re-sealed with a fresh IV under the
  same document id and committed with `currentDocument.updateTime`. Firestore answers a
  record edited while the migration runs with `400 FAILED_PRECONDITION`; that record is
  counted in `conflicts` and left untouched. Run the migration again to pick it up.
- **Unknown outcomes stop the run.** If a write's reply is lost or unrecognized, the run
  stops (`failed: 1`, `stoppedEarly: true`) without writing anything further. Run it again:
  a record whose write did land already lists the migration id and is skipped.
- **Audit.** Each migrated record gets a sealed `history` entry
  `{action:'migration:<id>', actor, at, reason, changes:{before, after}}`, and the same
  commit creates an owner-only SEC-02 entry in `hub_audit` (`action:'employee_vault.migrate'`,
  entity `vault_<family>/<opaque document id>`). That entry lists the changed keys only;
  their values stay sealed in the record, so pay never appears in the plaintext audit log.

## Registered migrations

| id | family | what it does |
| --- | --- | --- |
| `staff-profile-pay-roles-v1` | `profiles` | Adds `payRates[]` (one entry effective `2000-01-01` carrying the current `hourlyRate` and the `payType` string as it was), `payRateMirror`, and `staffRoles[]` from the profile `role`. `hourlyRate` is unchanged, so the rate snapshotted at clock-in is unchanged. Profiles of configured Hub users (`HUB_AUTH_USERS_JSON`) are left unchanged: their pay and roles stay in the Hub configuration, which the staff directory cannot edit. |
| `employee-account-staff-roles-v1` | `accounts` | Records the current account role (`namedStaffRole`: `sales` only with the owner's named invitation, otherwise `crew`) as `staffRoles[]`. `sessionVersion` is not changed, so nobody is signed out. |

Both are additive. With `EGC_STAFF_ROLE_PERMISSIONS` off (the default) stored `staffRoles`
do not change anyone's access. Once it is turned on, an account with stored `staffRoles` gets
exactly the capabilities of those roles (`staff-roles.js`): after the account backfill an
invited `sales` account gains `customer.send`, `followups.own` and `quotes.author`, and a
`crew` account keeps none. Owner capabilities are never granted to anyone but the owner.

## Running a migration (owner only)

`/api/employee-vault-migrate` accepts only the owner's signed-in Hub session from the Hub
origin. From the browser console on the Employee Hub, signed in as the owner:

```js
// 1. List registered migrations.
await (await fetch('/api/employee-vault-migrate')).json();

// 2. Dry run (the default). Review scanned / eligible / unchanged / alreadyApplied.
await (await fetch('/api/employee-vault-migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: crypto.randomUUID(), migrationId: 'staff-profile-pay-roles-v1' }) })).json();

// 3. Apply. Keep the requestId: retrying the same body returns the saved report.
const request = { requestId: crypto.randomUUID(), migrationId: 'staff-profile-pay-roles-v1', dryRun: false };
await (await fetch('/api/employee-vault-migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).json();
```

Applied runs record a server-only receipt in `employeeVaultMigrations/{requestId}` with a
keyed digest of the request and the report. The same `requestId` with a different body is
refused (409). A run that failed (for example an unreadable record) is recorded as
`failed` and may be retried with the same request after the cause is fixed. If a report
shows `conflicts`, run the migration again with a new `requestId`; migrated records are
skipped.

## Adding a migration

1. Add an entry to `VAULT_MIGRATIONS` with a new, never-reused id (`<area>-<change>-v<n>`),
   a family, a description, a `scope` (`pay` hides the history entry from managers without
   `pay.manage`) and a pure `transform(record, {now, actor, id})`.
2. Readers must tolerate records both with and without the new fields forever: the
   migration is owner-run and can be partial.
3. Add tests with the vault fixture (`tests/helpers/vault-fixture.mjs`): dry run writes
   nothing, second run is a no-op, concurrent edits conflict, protected fields are unchanged.

There is no automatic rollback. Because migrations only add fields and never change
protected ones, the previous code keeps working with migrated records.

## Staff directory fields on `profiles`

`/api/staff-directory` (behind `EGC_STAFF_DIRECTORY_ENABLED`) writes these additive fields on
the sealed `profiles` payload: `staffRoles[]`, `skills[]` (`{id, level, verifiedBy, verifiedAt}`,
catalog in `functions/_lib/staff-skills.js`), `skillCatalogVersion`, `payRates[]`
(`{effectiveFrom, hourlyRate, payType, overtimeMultiplier, setBy, setAt}`), `payRateMirror`,
`weeklyAvailability` (`{mon..sun:[{start,end}]}`, Denver wall time), `history[]`, and
`directoryRequestId/UpdatedAt/UpdatedBy`. `hourlyRate` is kept and mirrored to the rate in
effect on the Denver date of the last write; clock-in resolves the rate for the current
Denver date. Readers tolerate every field being absent.

The legacy `/api/employee-hub` keeps working unchanged for everything else, with these
guards:

- Its reads omit `history`, `payRates` and `payRateMirror` (the directory serves them with
  owner-only pay) and show `hourlyRate` as the rate in effect today, so a scheduled raise
  appears on the team board and profile form on its effective date.
- Every profile it saves (the crew self-save and manager saves) re-mirrors a scheduled
  `hourlyRate` to the rate in effect today and moves `payRateMirror` to that schedule entry.
  Drift is measured from the last mirror: a later legacy edit to any other rate (even an
  older scheduled one) wins, and the directory reports it as pay drift (`pay.needsReview`)
  and records it in the schedule at the next pay change.
- Its manager profile saves cannot set any directory field. With
  `EGC_STAFF_DIRECTORY_ENABLED=true`, they also cannot set `hourlyRate` or `payType` unless
  the saver has `pay.manage` (the owner): pay changes go through `set_pay`. A manager's own
  profile keeps mirroring the Hub configuration (what the Hub's own-profile sync sends).
  With the flag off, managers edit pay in the profile form exactly as before.

Configured Hub users keep their pay in the Hub configuration, so the directory never flags
their pay for review. Skill and availability changes write an audit entry with skill ids and
levels, and per-day window counts plus the changed days; verifications and exact windows stay
in the sealed `history`.
Employee-account roles are authoritative on the sealed account (`staffRoles`); a role change
there also rotates `sessionVersion`, which signs the employee out.
