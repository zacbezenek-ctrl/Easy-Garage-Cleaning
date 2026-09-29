# EGC → Gusto timecard sync

## Hours import file (GUSTO-EXPORT, the path in use)

Gusto does not offer this API to internal integrations (see Access and configuration below), so the owner imports each approved week into Gusto as a file. On **Time approvals**, the payroll week card has **Download Gusto hours** (owner only; `/api/timesheets?view=week&start=YYYY-MM-DD&format=gusto`). It exports only a settled week, like the payroll CSV: one row per employee with regular, overtime, double overtime and paid time off hours to two decimals, from the Hub's payroll engine (Colorado or federal overtime per `EGC_OVERTIME_POLICY`, approved paid time off). Rows are keyed by the Gusto employee ID the owner sets in the staff directory (**Set Gusto ID**), with the employee's name to check (the profile's display name when the week knows only a username, as for paid time off with no timecard). An employee without an ID, or two employees with one ID, stop the download and are named. Someone not paid through Gusto (the owner's own field time, a 1099 worker) is marked **Not paid through Gusto** in the same editor instead of given an ID: their hours are left out of the file, the Hub names them after the download (the `X-EGC-Gusto-Not-Included` response header), and the payroll CSV still has them. Former staff (a stored profile or a rejected employee account, such as someone let go with a final week still to pay) are listed for the owner under **Former staff** at the end of the directory, with only this editor; setting their ID gives them no Hub access. Bonuses and tips are not in the file.

The Gusto ID lives on the sealed employee profile. The profile's own history (owner only) keeps the IDs before and after each change; the plaintext audit log records only whether an ID is set and the not-paid-through-Gusto mark. Saving an ID already held by anyone else with a stored profile, active or former, is refused. That check is not transactional: two owner tabs saving the same new ID on two people at the same moment can both succeed, and the Gusto download then refuses the week (shared ID) for any week both have hours in.

The headers are `GUSTO_HOURS_COLUMNS` in `functions/_lib/payroll-export.js`, the only place the layout is defined. Nothing in this repository documents Gusto's hours-import template, so they are EGC's reading of it: download Gusto's hours-import template once, compare its headers, and change that constant if they differ.

**Connect Gusto** below is hidden in the Hub unless `GUSTO_PRODUCTION_APPROVED=true`.

## API sync (needs Gusto's approval)

The owner can send approved EGC shifts to Gusto Time Tracking from **Time approvals**. Employee matching and regular/overtime classification must be reviewed first. This integration does not create employees, change pay rates, submit payroll, or move money. Review and apply the hours to payroll in Gusto.

## Access and configuration

Gusto requires approved production App Integration access, security review, and QA. Its public documentation says the App Integrations API is not offered for building internal integrations for one's own company. Confirm eligibility with Gusto before enabling this implementation in production; a Gusto payroll subscription alone does not enable API access. Until the required access and credentials are provisioned, the Hub displays **Needs setup** and cannot transfer hours.

Sources: [Gusto integration introduction](https://docs.gusto.com/app-integrations/docs/introduction), [Time Tracking integration guide](https://docs.gusto.com/app-integrations/docs/syncing-time-tracking-data), [OAuth](https://docs.gusto.com/app-integrations/docs/oauth2).

Configure these server environment variables in Cloudflare Pages:

| Variable | Value |
| --- | --- |
| `GUSTO_ENVIRONMENT` | Explicitly `demo` or `production` |
| `GUSTO_CLIENT_ID` | Approved application's client ID |
| `GUSTO_CLIENT_SECRET` | Secret for the selected environment |
| `GUSTO_COMPANY_UUID` | EGC's company UUID in that environment |
| `GUSTO_REDIRECT_URI` | `https://easygaragecleaning.com/api/gusto-auth` |
| `GUSTO_PRODUCTION_APPROVED` | `true` only after actual production approval; unnecessary for demo |

The integration needs `employees:read`, `jobs:read`, `time_sheet:read`, and `time_sheet:write` access. Gusto manages the approved application's permissions. Requests pin API version `2026-06-15` and use only Gusto's fixed demo/production hosts.

Use the existing Firebase server service account and existing employee vault key. Do not rotate or replace that key as part of setup. Tokens, employee mappings, reviewed classifications, and transfer records are encrypted with a Gusto-specific key derivation in the **`gusto_integrations`** Firestore collection. Existing catch-all Firestore rules deny browser access to that collection. Do not add client-side rules to expose it. The server service account must be able to read and write it.

## Owner workflow

1. Sign in to the Hub as the EGC owner (`ZacB`). Open **Time approvals**.
2. Choose **Connect Gusto** and authorize the configured company. The callback verifies the original owner session and one-use state before saving credentials. Return to Time approvals.
3. Match each EGC employee to the correct Gusto employee and job. Verify their name and email. The server rejects mismatched jobs and duplicate employee assignments.
4. Review regular, overtime, and double overtime hours for each approved shift. The three amounts must equal the shift's net hours to three decimals. EGC does not determine the employee's overtime rules automatically.
5. Choose **Send to Gusto** and confirm the reviewed timecards. A batch contains up to 25 shifts. The result reports each transfer separately.
6. Review the timecards in Gusto Time Tracking and apply them to payroll there.

Only completed, approved timecards are eligible. Breaks must be completed, within the shift, and non-overlapping. Approval and hours are re-read from the server before transfer. Changing a shift invalidates its previous hour classification. Changing an employee match after a shift was sent requires reconciliation rather than creating a second copy under a different employee.

## Retry and recovery

Each shift is stored with its Gusto UUID, content hash, and durable transfer lease. Identical repeat requests are no-ops. Updates use Gusto's current version. Concurrent calls cannot claim the same transfer record.

If a create request times out or its outcome cannot be verified, the transfer is marked uncertain. **Check transfer** searches Gusto metadata for the existing shift; it does not blindly recreate a shift when no result is found. Investigate an unresolved transfer in Gusto before attempting any manual repair. Never delete transfer records to clear a warning: doing so can duplicate hours. A revoked approval or source change after transfer does not automatically delete a Gusto timecard; review both systems before payroll.

OAuth refresh tokens rotate once. Refresh uses a durable lease; uncertain rotation requires reconnecting, instead of retrying a possibly consumed refresh token. Storage failures and unreadable records stop transfer. Restore the original vault key if encrypted records become unreadable.

## Validation

Run `node --test tests/*.test.mjs`. The Gusto tests use synthetic timecards, a mocked Gusto transport, and a simulated server store; they do not connect to live payroll. Test in a Gusto demo company with demo credentials before production QA. For local demo OAuth only, the callback may use `/api/gusto-auth` on localhost or loopback with the exact configured origin. Production always uses the HTTPS callback above.
