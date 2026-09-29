# Owner go-live checklist

Every owner action for switching the EGC Hub on, in order, one line each. The how-to, the phone checks and the roll-back steps are in [GO-LIVE.md](GO-LIVE.md); each item links to its section.

The rule behind all of it: **HighLevel sends every customer message and owns every follow-up; the Hub only tracks.** Nothing below turns on Hub-written customer messages. Every path that writes to HighLevel or messages a customer, with its switch and default, is listed in [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md).

"Developer" means ask your developer (or Claude Code) to do it.

## Before anything

1. [ ] **Map `inquiry_id` to the Meta Lead event_id in the website-lead Zap, before merging.** Otherwise book-page leads are counted twice in Meta. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
2. [ ] **Developer: confirm CI is green (migration 0013) and migration 0014 is safe to apply.** A bad migration blocks the API and AI deploy. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
3. [ ] **Merge the integration pull request into `main`.** This deploys the Hub with every new switch off. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
    - [ ] **If you removed the customer message steps from the `egc-invoice-issued` / `egc-invoice-overdue` HighLevel workflows (earlier messaging checklist), restore them before deploying.** Those workflows send every invoice and overdue reminder; the Hub only adds the tags. [What changes](GO-LIVE.md#what-changes-on-deploy-no-switch), [messaging owner setup](messaging-owner-setup.md#invoicing-hub-invoicing-screen)
4. [ ] **Deploy the same commit to all four Railway services and confirm the commit on each.** The Hub and the platform refuse each other's older signed messages. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
5. [ ] **Hard-refresh office Hub pages and every crew iPad or phone.** Old cached pages send stale data. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
6. [ ] **Run the B1 phone checks (sign-in, API health, schedules, clock in and out, site menu).** Confirms the deploy landed. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
7. [ ] **Developer: run the post-deploy checks and make "EGC Root CI" required on `main`.** Catches private-page and pricing mistakes early. [B1](GO-LIVE.md#b1-merge-and-deploy-one-commit-everywhere)
8. [ ] **Upgrade Cloudflare to Workers Paid ($5 a month).** The free plan's time limit makes the Hub fail with Error 1102. [B2](GO-LIVE.md#b2-move-cloudflare-to-workers-paid-5-a-month)
9. [ ] **Confirm `HUB_SESSION_SECRET` is 32+ characters in Production and Preview (service-keys check).** Confirmations, the bridge and AI approvals fail closed otherwise. [B3](GO-LIVE.md#b3-secrets-to-set-first)
10. [ ] **Set `HUB_PURPOSE_KEY_SECRET` (32+ random) in Production and Preview.** Keeps sealed website leads and confirmations off the session secret. [B3](GO-LIVE.md#b3-secrets-to-set-first)
11. [ ] **Confirm `EMPLOYEE_HUB_DATA_SECRET` is set, and never change it or `HUB_SESSION_SECRET` on your own.** They unlock timecards, staff records and every sign-in. [B3](GO-LIVE.md#b3-secrets-to-set-first)
12. [ ] **Set the bridge secrets: `API_BEARER_TOKEN`, `EGC_OPERATIONS_MCP_SIGNING_SECRET`, `EGC_OPERATIONS_PORTAL_SIGNING_SECRET`.** They sign every Hub-to-platform message. [B3](GO-LIVE.md#b3-secrets-to-set-first)
13. [ ] **Check Hub → Integrations shows Firebase, HighLevel, Google Drive and Stripe as ready.** Most stages need them. [B3](GO-LIVE.md#b3-secrets-to-set-first)
14. [ ] **Developer: publish `firestore.rules` and `firestore.indexes.json` right after the deploy.** New private records stay closed to browsers; tracking reads need the indexes. [B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)
15. [ ] **Ask staff to reload open Hub pages after the rules publish.** Pages opened earlier cannot save their audit notes. [B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)
16. [ ] **Add the `fieldExpenses.incurredOn` single-field exemption in the Firebase console.** Field-cost date totals fail without it. [B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)
17. [ ] **Keep the automatic index on `business_sessions.expiresAt` (no exemption).** The business hub sign-in clean-up needs it. [B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)
18. [ ] **Set the Railway bridge variables on egc-api and egc-mcp.** Recordings, AI access and lead retries run over the bridge. [B5](GO-LIVE.md#b5-railway-platform-and-the-signed-bridge)
    - [ ] **Once the bridge is on, each verified field completion creates the HighLevel task "6-month garage check-in". Check that no HighLevel workflow triggered by Task Added reacts to it in a way you do not want.** HighLevel owns the check-in; the Hub only creates the task. [B5](GO-LIVE.md#b5-railway-platform-and-the-signed-bridge), [HighLevel boundary](HIGHLEVEL-BOUNDARY.md#owner-checklist)
19. [ ] **Set `EGC_OPERATIONS_INBOUND_REPLY_MINUTES=off` on Cloudflare.** Stops Hub tasks for unanswered texts, because HighLevel owns follow-ups. [B5](GO-LIVE.md#b5-railway-platform-and-the-signed-bridge)
20. [ ] **Run the B5 checks (API health, service keys, a test visit reaching the HighLevel calendar).** Proves the bridge works both ways. [B5](GO-LIVE.md#b5-railway-platform-and-the-signed-bridge)
21. [ ] **Complete the Stripe webhook event list (`checkout.session.async_payment_succeeded`, `invoice.paid` and the rest).** Card and membership payments are recorded from these events. [B6](GO-LIVE.md#b6-stripe-webhook-events-and-the-live-key)
22. [ ] **Make sure Production has the live `STRIPE_SECRET_KEY`.** The webhook reads every payment back from Stripe; refunds cannot be recorded without it. [B6](GO-LIVE.md#b6-stripe-webhook-events-and-the-live-key)
23. [ ] **Tell the team what changed on deploy (Dispatch reasons and no-show, crew app and photos, day-before crew texts with saved times and prices, pay visibility, Review queues).** Nobody is surprised on day one. [What changes](GO-LIVE.md#what-changes-on-deploy-no-switch)

## Stage 1: Safe security switches

24. [ ] **Set `EGC_STAFF_PAGE_GATE=on` in Preview, check it, and watch the Preview logs for 401s.** Staff pages stop being downloadable by anyone. [1.1](GO-LIVE.md#11-lock-the-staff-pages)
25. [ ] **Then set it in Production and do the crew-phone offline check.** Locks the live site without breaking the crew app. [1.1](GO-LIVE.md#11-lock-the-staff-pages)
26. [ ] **Leave `EGC_STAFF_PAY_OWNER_ONLY` unset and check a manager sees hours, not pay.** Pay stays owner-only. [1.2](GO-LIVE.md#12-keep-pay-owner-only)
27. [ ] **Turn on Cloudflare Access for preview deployments.** Preview links otherwise serve staff files with no sign-in. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
28. [ ] **Delete deployments older than the gate.** They still serve staff files with no check. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
29. [ ] **Give the Firebase service account the Firebase Authentication Admin role.** Removed staff are then signed out of the database too. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
30. [ ] **After removing anyone from the staff list, open the Hub on easygaragecleaning.com as a manager.** That is when their sign-out runs. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
31. [ ] **Change your Hub password if you have not since the old login page.** An old hash of it is in the code history. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
32. [ ] **Rotate the crew Zapier hook (`CREW_WEBHOOK_URL`).** The original URL once shipped in page source. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
33. [ ] **Check the private files show "not found" and `/crew/hub-auth.js` still loads.** Source code and prices must not be public. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)
34. [ ] **Confirm `MCP_BEARER_WRITE_ENABLED` and `EGC_MCP_DIRECT_SENDS_ENABLED` are not set on egc-mcp.** Keeps the AI connector read-safe and unable to text customers. [1.3](GO-LIVE.md#13-security-steps-with-no-switch)

## Stage 2: Leads into HighLevel

35. [ ] **Run the opportunity-search check on a test contact (closed deal must be listed).** A late sync must never reopen a closed deal. [Before Stage 2](GO-LIVE.md#before-stage-2)
36. [ ] **Set `WEB_LEAD_RECEIPTS_ENABLED=true` (Preview, then Production) and send a test lead from `/book`.** No lead is lost when HighLevel hiccups, and every lead is tracked. [2.1](GO-LIVE.md#21-durable-website-leads)
37. [ ] **Decide whether failed leads retry automatically (messaging worker in lead-retries-only mode).** Without it you recover failed leads by hand from the Web3Forms email. [O3](GO-LIVE.md#o3-messaging-worker-for-lead-retries-only)
38. [ ] **Never change `HUB_PURPOSE_KEY_SECRET` while a lead is waiting to sync.** That lead would become unreadable. [B3](GO-LIVE.md#b3-secrets-to-set-first)
39. [ ] **Decide ads leads should start your HighLevel workflows and text-back, then set `WEB_LEAD_ADS_RELAY_ENABLED=true` and test `/ads`.** Ads leads stop being email-only. [2.2](GO-LIVE.md#22-ads-landing-page-leads)
40. [ ] **Optional: `WEB_LEAD_DELAYED_SYNC_TAG=true` with the HighLevel workflow filters.** Only if late leads should skip an instant reply. [2.3](GO-LIVE.md#23-late-lead-tag-optional)

## Stage 3: Walkthroughs

41. [ ] **Developer: run the two staff migrations (dry run, then apply).** The staff directory needs them. [3.1](GO-LIVE.md#31-team-roles-staff-directory)
42. [ ] **Tell managers that pay changes now go through you.** The old profile form stops changing pay. [3.1](GO-LIVE.md#31-team-roles-staff-directory)
43. [ ] **Set `EGC_STAFF_DIRECTORY_ENABLED=true` and check nobody shows "pay needs review" or "unrecognized id".** Turns on roles, skills, pay history and availability. [3.1](GO-LIVE.md#31-team-roles-staff-directory)
44. [ ] **Record the Phone role for the phone person and the Sales role for the walkthrough rep.** Roles, not names, describe who does what. [3.1](GO-LIVE.md#31-team-roles-staff-directory)
45. [ ] **Book a test walkthrough in Dispatch and check the HighLevel calendar and tag.** HighLevel sends the confirmation, not the Hub. [3.2](GO-LIVE.md#32-booking-a-walkthrough-no-switch)
46. [ ] **Upload a short test recording and retry any stuck ones.** Confirms walkthrough AI notes work after the crash fix. [3.3](GO-LIVE.md#33-recording-the-walkthrough)
47. [ ] **When FUN-06 lands: assign reps in Dispatch, tell them to clock in first, then set `EGC_WALKTHROUGH_VISIT_ENABLED=true`.** Start and Finish then track the visit and the rep's time. [3.4](GO-LIVE.md#34-start-and-finish-after-fun-06)
    - [ ] **Update every walkthrough iPad to iPadOS 15.4 or later (Settings > General > Software Update).** Recording in the Hub needs it; an older iPad records in Voice Memos instead. [3.4](GO-LIVE.md#34-start-and-finish-after-fun-06)
48. [ ] **Rebook a no-show walkthrough by moving the same visit, never by creating a new one.** Keeps one history per walkthrough. [3.4](GO-LIVE.md#34-start-and-finish-after-fun-06)

## Stage 4: Crew scheduling and the field day

49. [ ] **Encourage full addresses with ZIP codes on customers and jobs.** Drive times need them. [4.1](GO-LIVE.md#41-drive-times)
50. [ ] **Review Drive times, then set `EGC_DISPATCH_TRAVEL_ESTIMATES=offline`.** Dispatch warns about tight gaps between jobs, at no cost. [4.1](GO-LIVE.md#41-drive-times)
51. [ ] **Optional: clear stale blocked days, then `EGC_DISPATCH_LEGACY_BLOCKED_DAYS=warn`.** Dispatch respects old calendar blocks. [4.2](GO-LIVE.md#42-old-blocked-day-toggles-optional)
52. [ ] **Check every saved crew under Crews & vehicles has the right members and a lead.** Dropping a job on a crew row assigns exactly those people. [4.3](GO-LIVE.md#43-split-and-multi-crew-jobs-optional)
53. [ ] **Optional: `EGC_DISPATCH_SEGMENTS=true` for split and multi-crew jobs.** Only when you need them. [4.3](GO-LIVE.md#43-split-and-multi-crew-jobs-optional)
54. [ ] **Optional: default arrival windows, plus the developer backfill for future jobs.** Customers see a window instead of an exact time. [4.4](GO-LIVE.md#44-default-arrival-windows-optional)
55. [ ] **Enter stocked-item costs in Hub → System → Stocked item costs.** Job costing then uses your cost, never the retail price. [4.5](GO-LIVE.md#45-field-costs)
56. [ ] **Tell crew about the Job costs card, then set `FIELD_EXPENSES_ENABLED=true` and test a fuel cost.** Materials and dump fees get recorded per job. [4.5](GO-LIVE.md#45-field-costs)
57. [ ] **Later: `FIELD_EXPENSE_CLOSEOUT_REQUIRED=true`.** Jobs cannot be completed until costs are recorded or marked None. [4.5](GO-LIVE.md#45-field-costs)
58. [ ] **Test the offline crew app on a phone, and tell crews how offline clock-ins work and to sign out before handing a phone over.** Nothing is lost or doubled on weak signal. [4.6](GO-LIVE.md#46-offline-crew-app-no-switch)
59. [ ] **Accountant: confirm the Colorado overtime order and the EGC readings (week, midnight shifts, bonus and tips).** Payroll is only as right as these rules. [4.7](GO-LIVE.md#47-timesheets-and-payroll)
60. [ ] **Approve timecards every week (by Monday noon) and export payroll from `/api/timesheets`.** The export refuses until every timecard is settled. [4.7](GO-LIVE.md#47-timesheets-and-payroll)
61. [ ] **Open job costing for last week.** Shows labor per job; final only when coverage is complete. [4.8](GO-LIVE.md#48-job-costing-no-switch)
62. [ ] **Keep `EGC_RECURRING_PLANS_ENABLED` off until RECUR-CRON lands.** Plans would otherwise stop adding visits. [Keep off](GO-LIVE.md#keep-off-for-now)
63. [ ] **Developer: run the three clean-up scripts in a quiet window (dry run, then apply).** Fixes stale times, links customers and lets the sales exit find other jobs. [Clean-ups](GO-LIVE.md#one-time-data-clean-ups-developer-in-a-quiet-window)

## Stage 5: Money

64. [ ] **Refunds: refund in Stripe first, then Record refund in Review queues (owner only).** The Hub never moves money out by itself. [Stage 5](GO-LIVE.md#stage-5-money)
65. [ ] **Open Review queues as owner and as a manager; settle held charges and unknown-delivery messages.** Held money never counts as paid until you settle it. [5.1](GO-LIVE.md#51-card-payments-and-review-queues-no-switch)
66. [ ] **Developer: run the payment-ledger backfill (dry run, then apply).** Server money records start from clean ledgers. [5.2](GO-LIVE.md#52-server-money-records)
67. [ ] **Verify every job the backfill lists as needing verification, in the Firebase console, then rerun it.** Those jobs refuse new money until verified. [5.2](GO-LIVE.md#52-server-money-records)
68. [ ] **Set `MONEY_API_ENABLED=true`. Finance saves and the Invoicing screen then add the same `egc-<event>` tag as today's finance tools, so your HighLevel workflows still send.** Press "Trigger in HighLevel" only for a job or Invoicing row flagged not triggered or needs attention; after a normal save it adds the tag a second time. [5.2](GO-LIVE.md#52-server-money-records)
    - [ ] **Decide whether issuing from the Invoicing screen should turn on the job's automatic reminders ("Enable auto"). Until you decide it does not: press Enable auto on each job that should get the overdue reminder.** A job invoiced there gets no automatic `egc-invoice-overdue` tag otherwise. [5.2](GO-LIVE.md#52-server-money-records), [messaging owner setup](messaging-owner-setup.md#invoicing-hub-invoicing-screen)
69. [ ] **Add the email-obfuscation rule for `/api/money-document`, then set `MONEY_DOCUMENT_ENABLED=true` and check a Pay amount.** Customers get proper estimate, invoice and receipt pages. [5.3](GO-LIVE.md#53-branded-estimates-invoices-and-receipts)
70. [ ] **Optional: `PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED=true`.** No new checkout while a charge on the job is held. [5.4](GO-LIVE.md#54-block-checkouts-while-a-charge-is-held-optional)
71. [ ] **Optional: `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED=true`, then work the member matches.** Memberships link to customers automatically. [5.5](GO-LIVE.md#55-garage-guard-memberships-optional)

## Stage 6: Customer portal and business client hub

72. [ ] **Upload the current insurance certificate with its expiry date, and download it from a test portal.** Customers can get it themselves. [6.1](GO-LIVE.md#61-portal-basics-no-switch)
73. [ ] **Read the guarantee and terms copy in the portal.** Customers approve estimates against it. [6.1](GO-LIVE.md#61-portal-basics-no-switch)
74. [ ] **Optional: set `GOOGLE_REVIEW_URL`.** Only if the review link should change. [6.1](GO-LIVE.md#61-portal-basics-no-switch)
75. [ ] **Add the Cloudflare rate-limit rule on `/api/customer-portal-photo`.** Protects photo streaming before it goes live. [6.2](GO-LIVE.md#62-before-and-after-photos-in-the-portal)
76. [ ] **Set `FIELD_CUSTOMER_PHOTOS_SINCE` to your launch date, then `FIELD_CUSTOMER_PHOTOS_ENABLED=true`.** Customers see new before and after photos; old jobs stay as they were. [6.2](GO-LIVE.md#62-before-and-after-photos-in-the-portal)
77. [ ] **Test a business member limited to one property.** Company staff see only their properties. [6.3](GO-LIVE.md#63-business-client-hub-no-switch)
78. [ ] **Before any code rollback past this build, export property-limited business members.** Older code would give them every property. [6.3](GO-LIVE.md#63-business-client-hub-no-switch)

## Stage 7: Claude and ChatGPT (MCP)

79. [ ] **Make sure no business user who approves AI connections has a crew or crew lead role.** The bridge refuses crew roles. [7.1](GO-LIVE.md#71-and-72-hub-approved-connections)
80. [ ] **Set `EGC_MCP_PUBLIC_ORIGIN` on Cloudflare and check the approval page.** The Hub can then approve AI connections. [7.1](GO-LIVE.md#71-and-72-hub-approved-connections)
81. [ ] **Set `MCP_OAUTH_HUB_IDENTITY_ENABLED=true` on egc-mcp.** Adds "Continue with Employee Hub". [7.2](GO-LIVE.md#71-and-72-hub-approved-connections)
82. [ ] **Connect Claude and ChatGPT through the Hub with read access; write only on your own connection, if ever.** Write access changes HighLevel records. [7.3](GO-LIVE.md#73-connect-and-which-access-to-grant)
83. [ ] **Update saved AI prompts and scripts to read `result.items` and follow `page.nextCursor`, and any report that filters on the old `chatgpt-mcp` actor.** Search results and audit names changed shape. [7.3](GO-LIVE.md#73-connect-and-which-access-to-grant)
84. [ ] **After both connect, set `MCP_OAUTH_SHARED_LOGIN_ENABLED=false`, then remove the shared username and password.** Ends the shared connector password. [7.4](GO-LIVE.md#74-retire-the-shared-password)

## Stay off

85. [ ] **Leave every Optional messaging switch off.** They make the Hub write customer messages; HighLevel does that. [Optional](GO-LIVE.md#optional-only-if-you-want-the-hub-to-send-through-highlevel)
86. [ ] **Leave the "Leave these off" switches off until their unit lands.** Each one waits on something not built yet. [Leave off](GO-LIVE.md#leave-these-off-for-now)

## Owner decisions

87. [ ] **Move the crew pre-job texts from Quo into HighLevel.** They reach customers without HighLevel today. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
88. [ ] **Move the booking confirmation email from EmailJS into HighLevel.** Same reason. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
89. [ ] **Replace the Zapier AI text-back with a fixed HighLevel instant reply.** Same reason, and the text is AI-written with no review. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
90. [ ] **Keep exactly one review-request sender, in HighLevel.** Customers must not get two review asks. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
91. [ ] **Move the "Zap 5" quote follow-up to HighLevel's quote sequence.** One follow-up system, in HighLevel. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
92. [ ] **Decide on Stripe payment receipts.** Keep them, or ask for the change to send receipts from HighLevel. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
93. [ ] **Check which HighLevel workflows and calendar notifications fire on Hub bookings and tags.** Avoids double messages. [D1](GO-LIVE.md#d1-customer-messages-that-skip-highlevel-today)
94. [ ] **Check Meta for anything optimizing on pixel `861741726934219`, then ask for the pixel unification.** Ads-page leads do not de-duplicate until then. [D2](GO-LIVE.md#d2-meta-pixel)
95. [ ] **Pick the Jobber freeze day and parallel run, following JOBBER-CUTOVER.md.** Jobber goes off only when every cutover condition is met. [D3](GO-LIVE.md#d3-jobber-cutover-date)
96. [ ] **On Jobber Day 0, turn off Jobber's automatic client messages and pause Dispatch changes during the import.** Customers must not hear from both systems. [D3](GO-LIVE.md#d3-jobber-cutover-date)
97. [ ] **Get the payroll burden rate from your accountant or Gusto.** Job labor stays "before burden" until it is set. [D4](GO-LIVE.md#d4-payroll-burden-rate)
98. [ ] **Review the placeholder pricing settings and the 113 unverified catalog prices before customers see catalog pricing.** Quotes must use real numbers. [D5](GO-LIVE.md#d5-other-decisions-with-defaults)
99. [ ] **Check the HighLevel test and internal tags list, and mark your own and case-study jobs internal.** Keeps the numbers clean. [D5](GO-LIVE.md#d5-other-decisions-with-defaults)
100. [ ] **Later: decide whether the Hub adopts walkthroughs customers book in HighLevel.** Starts as dry-run plans only. [D5](GO-LIVE.md#d5-other-decisions-with-defaults)

## Ongoing

101. [ ] **Renew the insurance certificate before it expires (the Hub warns 30 days ahead).** Customers stop getting it on the expiry date. [6.1](GO-LIVE.md#61-portal-basics-no-switch)
102. [ ] **Re-check catalog prices every 90 days (first round due 2026-12-27).** Prices go stale. [D5](GO-LIVE.md#d5-other-decisions-with-defaults)
103. [ ] **Look at Review queues and the Command Center alert every week.** Held charges and unknown sends wait for you. [5.1](GO-LIVE.md#51-card-payments-and-review-queues-no-switch)
104. [ ] **Reps open the walkthrough online once after every price change.** Their device caches the new prices for offline use. [What changes](GO-LIVE.md#what-changes-on-deploy-no-switch)
105. [ ] **Developer, every few months: consider the optional Firebase tidy-ups (time-to-live policies, audit index exemptions).** The audit log and receipts only grow. [B4](GO-LIVE.md#b4-publish-firestore-rules-and-indexes)

## Crew time and clock-in location (CREW-TIME)

106. [ ] **Tell crews: the clock-in reads their location once, and nothing tracks it during the shift.** Owner decision; the Hub and crew app say so. [4.9](GO-LIVE.md#49-clock-in-location-once-no-switch)
107. [ ] **After this deploy, have every crew member reload every open Hub tab (or sign out and in). Required.** A tab from before the deploy keeps reading the phone's location (the server refuses and stores none of it) until it is reloaded or the shift is clocked out, so "nothing tracks you" is true only after the reload. [4.9](GO-LIVE.md#49-clock-in-location-once-no-switch)
108. [ ] **Set `EGC_CLOCK_IN_WITHOUT_FIX=true`, then review "No location at clock-in" shifts on the timesheet each week.** Owner decision: weak GPS never stops a clock-in. [4.10](GO-LIVE.md#410-clock-in-with-no-gps-position-owner-decision-on)
109. [ ] **Optional: set `EGC_JOB_STATUS_MOVES_TIME=true` once every job has the right crew and lead.** Status taps then move crew time and the lead can move crew-mates. [4.11](GO-LIVE.md#411-job-status-moves-crew-time-optional)
110. [ ] **Before the first payroll after this deploy, set up the Gusto hours file (GUSTO-EXPORT).** TIME-CORRECT removed Download CSV and Download for Gusto. The payroll week card on Time approvals (owner only) now has **Download payroll CSV** (new last column, Job time; hours and pay columns unchanged) and **Download Gusto hours**: one row per employee for an approved, settled week, with regular, overtime, double-time and paid time off hours from the Hub's payroll engine. (a) Turn on the staff directory (item 43) and, on each paid employee, choose **Set Gusto ID** and paste their Gusto employee ID; only you see it, and the file stops and names anyone without one. Anyone with approved hours who is not paid through Gusto (your own field timecards if you are not a W-2 employee in Gusto, a 1099 worker) gets **Not paid through Gusto** ticked in the same editor instead of an ID, or they stop the file too. Former employees with hours still to pay are under **Former staff** at the end of the directory. (b) **Download Gusto's hours-import template once and confirm the headers.** The file's columns are Gusto employee ID, Employee name, Regular hours, Overtime hours, Double overtime hours, Paid time off hours: EGC's reading of the template, not confirmed against Gusto. If Gusto's headers differ, have the one constant `GUSTO_HOURS_COLUMNS` (functions/_lib/payroll-export.js) changed to match before importing. (c) Bonuses and tips are not in the Gusto file; the card names them after a download, so enter them in Gusto from the payroll CSV. (d) Leave `GUSTO_PRODUCTION_APPROVED` unset: Connect Gusto stays hidden, since Gusto does not offer its API to internal integrations. Re-map any spreadsheet that reads the payroll CSV's columns by name. [4.7](GO-LIVE.md#47-timesheets-and-payroll)
111. [ ] **Optional: set `EGC_TIMECARD_CORRECTIONS=true` (Preview first), then close every shift under Needs attention before each payroll export.** Owners and managers get Correct time and Close shift, each with a required reason kept in the timecard history; a corrected card goes back to pending. Confirm no `HUB_AUTH_USERS_JSON` / `HUB_AUTH_ADDITIONAL_USERS_JSON` username contains `'` `"` `\` `` ` `` `<` `>` `&` or a tab/line break; such accounts can no longer clock in from the crew app. [4.12](GO-LIVE.md#412-correct-timecards-and-close-forgotten-shifts-optional)
