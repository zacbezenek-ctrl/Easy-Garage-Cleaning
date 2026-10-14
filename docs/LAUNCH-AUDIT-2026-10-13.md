# Customer and internal launch audit — October 13, 2026

Source baseline: `18fcf2d0037ddbd37285edc59041801e0f0fb9b9`. Publishing these changes does not establish a completed production deployment; verify the exact deployed release using the checklist below.

## Scope

This audit covers the public website and booking forms, customer sign-in and portal, staff/crew pages, authorization and lead-intake boundaries, and the separate operations platform. Browser work uses synthetic local fixtures. No customer messages, bookings, payment operations, access grants or production data changes were performed.

Other ChatGPT conversations are not visible from this workspace. Repository history and existing launch documents supplied the shared context.

## Confirmed issues fixed

| Area | Issue and effect | Correction |
| --- | --- | --- |
| Portal help / lead intake | A portal URL containing a bearer token could be copied into CRM notes and the lead relay when a customer requested help. | Strip the portal query/fragment in the client; allow only campaign-attribution query fields in intake URLs before receipts and integrations. Re-sanitize old receipts during delayed CRM processing. |
| Private portal photos | Open photo dialogs could remain visible after access was revoked; a storage photo withdrawn during refresh could remain open. | Close and clear photo viewers when access disappears or the available photos change; ignore stale close events after another viewer opens. |
| Walkthrough request | A one-digit phone or whitespace-only name could pass the final form submission path. | Validate the last step before submission, matching the server's phone formats; keep invalid input editable and prevent the relay request. |
| Walkthrough navigation | Returning through the browser's back/forward cache could leave the request button disabled as “Sending…”. | Reset the submission state on a restored page. |
| Paid-ad lead capture | One landing page bypassed native validation, skipped the normal CRM mirror, and could show success after a rejected or failed provider request. | Validate before sending, explicitly relay once using the stable request ID, show success only after provider acceptance, and preserve entered answers for a safe retry. |
| Crew job, expenses and payments | Direct use of `AbortSignal.timeout` prevented requests in older Safari versions supported by the field recorder. | Use an `AbortController` deadline with cleanup through response parsing; test without the newer static timeout method. |
| Private deployment artifacts | The route denylist did not cover all local configuration and QA-output paths if they were included in a deployment. No deployed exposure was observed. | Deny hidden configuration/artifact paths and QA output directories, preserve `/.well-known`, and keep the local audit server's policy aligned. |
| Public navigation | Public footers exposed a broken “Schema @id #business” anchor and an implementation-oriented `llms.txt` link. | Remove those footer links while preserving structured data and the machine-readable files. |
| Customer mobile forms | Editable portal text fields inherited font sizes below 16px, causing iOS focus zoom. | Give text inputs/selects/textareas readable 16px text with the portal font. |
| Touch targets | The dispatch dialog's close button could shrink to 41px wide; the ad landing page's phone link measured 43px high on Android. | Reserve the 44px minimum touch area and prevent dialog-button flex shrinking. |
| Accessibility | Public and portal text labels had insufficient contrast; home/book headings skipped a level and business tables omitted an action-column header. | Correct the specific colors and semantic labels, propagate stylesheet version `20261013b`, and verify unchanged layout geometry. |
| Client Login network cleanup | The readiness probe read only the status, leaving Chromium's response body unfinished and delaying network-idle detection. | Consume the response body within the existing deadline and version the updated script on login/confirmation pages. |
| Operations dependencies | The pinned production dependency graph had ten reported advisories, including affected Next and Drizzle versions. No exploit was confirmed in the current routes. | Update to Next 16.3.8 and Drizzle 0.45.2; use patched sharp/source-map-js resolutions. The refreshed production dependency audit reports zero advisories. |

The credential fix prevents new disclosures after deployment. Existing provider history was not inspected or altered; review prior portal-help URLs and revoke affected access links if credentials were retained there.

## Verification

The consolidated root run executed 4,523 tests: 4,508 passed, 14 emulator-only tests skipped, and one VM-fixture failure. The fixture lacked standard browser globals needed by the new request deadline. Adding those globals left the assertions unchanged; all 29 closeout/deadline checks then passed. No unexplained root-suite failure remains.

Completed focused checks:

- Customer portal: 236 Node checks and 100 browser cases (login, quote, refresh/recovery, documents, tips, change orders and private photos).
- Internal workflows: 1,011 Node tests, 85 selected API/service-worker/gate checks, seven deadline regressions, 41 cost/payment browser cases, and three targeted dispatch phone checks.
- Security/integrations: 82 authorization/integration tests, 54 lead/relay tests, 18 Lighthouse routing tests and five focused route checks.
- Public site: 11 focused browser cases, 29 final static/relay checks, navigation inventory and reproducible generator checks.
- The changed Pages Functions bundle compiles successfully.
- Real requests through the local Pages runtime verify the homepage/gallery and 404 refusals for `/.dev.vars`, `/.env.local`, and `/test-results/portal.png`.
- All 15 platform production builds and all 15 typechecks passed with the patched dependency lockfile. Platform validation passed 1,343 unit/HTTP checks, 290 PostgreSQL integration checks across 23 files, and 19 startup/authentication/page checks. The migrations ran twice against isolated PostgreSQL 17; the final offline frozen install passed.
- The full device matrix executed 1,464 cases: 1,113 passed, 349 were intentional device-specific skips, and two touch-target checks initially failed. Both defects were fixed; the exact failed checks then passed on a fresh `--last-failed` run (2/2). Initial results are retained in `test-results/e2e-initial-report.json`.
- All four browser checks proving the Lighthouse customer/business/crew/login fixtures render the intended screens passed. The login fixture now supplies the real readiness contract, and Chromium confirms its probe request finishes.
- Final public contrast/heading changes passed 24 focused Node checks, three browser checks, five generator checks, and contrast/heading audits on nine pages at phone and desktop widths. All 18 before/after layout comparisons matched.
- Private-page accessibility changes passed 76 focused Node checks, four browser checks and 26 contrast checks, with all 468 measured element rectangles unchanged.
- The login probe cleanup and script-version update passed 62 Node checks and four browser checks.

These counts overlap where focused suites revisit the same behavior; they should not be summed into a unique test total.

The public link inventory covers 78 served HTML pages and more than 9,000 links. The final browser matrix includes public pages, signed-in synthetic customer/staff/crew shells, narrow phones, tablet orientations and desktop. Targeted regressions exercise the specific issues above.

Known test allowances remain explicit: the free-form legacy quote range needs a text keyboard, and the business onsite-contact field is a person's name, not a phone number. The booking/pricing photo forms do not have a separate rear-camera shortcut; photo-library upload remains available. These are not counted as camera-hardware acceptance.

The production dependency graph is clear of reported advisories after the platform update. A separate full dependency audit still reports development-tool advisories in Vitest/mocker, tinypool and the older esbuild used by Drizzle Kit. Fixing those requires reviewing a test-tool major upgrade; they are not resolved by the production dependency update. Advisory references: `GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr`, `GHSA-82fw-gwwq-j7x9`, and `GHSA-67mh-4wv8-2f99`.

The four platform Dockerfiles now install the reviewed lockfile with `--frozen-lockfile --prod=false`. This makes dependency selection reproducible and makes build-tool installation explicit. They are currently single-stage images, so build/test dependencies remain in the image even when the running application does not import them; the full-audit development-tool findings are not a claim of a vulnerability-free container. The representative container build could not finish because registry access failed inside Docker, including the supported host-network retry. Native production builds and the frozen install succeeded.

## Final performance and accessibility sample

Lighthouse 12.6.1 measured all 13 configured pages after the fixes, one run per page, on the local fixture server with a 375×812 mobile profile. Every run completed without warnings; all passed the repository’s 90-point threshold. This is a single-run audit sample, not the three-run median CI gate or production field data.

| Page | Performance | Accessibility |
| --- | ---: | ---: |
| `/` | 99 | 100 |
| `/before-after` | 96 | 100 |
| `/blog/how-much-does-garage-cleanout-cost-fort-collins` | 100 | 100 |
| `/book` | 100 | 100 |
| `/business-hub` | 100 | 100 |
| `/client-login` | 100 | 100 |
| `/couch-removal-fort-collins-co` | 100 | 100 |
| `/customer-portal` | 100 | 100 |
| `/field-today` | 100 | 100 |
| `/garage-cleanouts-fort-collins-co` | 99 | 100 |
| `/garage-turnaround-fort-collins-co` | 99 | 100 |
| `/junk-removal-loveland-co` | 99 | 100 |
| `/pricing` | 100 | 100 |

Reports are saved in `test-results/lighthouse/`. The earlier run with CPU contention and the earlier login-harness result were superseded by this quiet, complete sample. Automated accessibility scores do not replace manual screen-reader or physical-device acceptance.

## Live launch acceptance still required

This environment's network proxy refused requests to `easygaragecleaning.com` with HTTP 403. That is an environment access restriction, not an observed website failure. Production release identity, credentials, enabled flags and data health were not established by the local checks.

Before calling the live launch accepted, complete the current [launch acceptance gates](LAUNCH-ACCEPTANCE.md):

1. Verify deployed Pages/API/MCP/worker/portal versions and authenticated integrations/data health.
2. Exercise an owner-approved synthetic booking through Hub and HighLevel, including reschedule/cancel and removal from pre-booking follow-ups.
3. Verify applicant/customer classification against the intended live records.
4. Confirm approved rates and one exact quote save/reopen.
5. Complete one assigned synthetic field job, including real Drive upload, photos and sign-off.
6. Verify transcript-to-reviewed-task handoff using a fresh synthetic transcript.
7. Verify authorized balances/receipts and keep unaccepted field-payment/refund features disabled.
8. Perform real owner/manager/sales/phone/crew access checks and physical iPhone/iPad camera, microphone, gesture and signature acceptance.

Browser emulation does not certify a physical device. Unit and fixture tests do not certify external integration delivery, live security-rule publication or production money movement. Use owner-controlled synthetic destinations for approved communication tests.
