# EGC → Gusto timecard sync

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
