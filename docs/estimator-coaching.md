# Estimator coaching

In the Employee Hub, an owner or manager opens **Estimator coaching**, selects a recent walkthrough, and opens its existing audio/transcripts. **Coaching review** on the Walkthroughs screen opens the same review directly. The reviewer scores observed criteria, records evidence (including a timestamp or short quote when using a recording), and writes one next practice action. Not observed remains distinct from every score.

The screen links to the existing Job actuals estimator-accuracy view and Open quotes outcomes. It does not calculate a second performance ranking or generate automatic ratings. The assigned estimator is selected from the walkthrough; a recorded performer takes precedence over the current assignment. An unassigned walkthrough must be repaired before review.

Reviews are manager-only and saved by the server in `estimatorCoaching/<walkthroughId>`. One current review is kept per walkthrough; changes are also recorded in the existing business audit. A source-job revision check and review revision check prevent overwrites after either changes. `estimatorCoachingReceipts/<requestId>` makes retrying the exact save idempotent. These collections deny browser Firestore access.

No new environment variables, customer messages, pricing changes, compensation changes, or recording-processing workflow are introduced. Existing recording-service availability still applies. A missing recording can be reviewed by direct observation only when the reviewer actually observed the visit.
