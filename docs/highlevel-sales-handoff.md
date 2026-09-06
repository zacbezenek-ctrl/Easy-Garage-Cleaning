# HighLevel sales handoff

Configured September 6, 2026 for Easy Garage Cleaning, location `KlgLwRaQSPz5G1YXsmc6`.

## Customer calendars

| Use | Calendar | ID |
| --- | --- | --- |
| Customer jobs | EGC Customer Jobs (staff scheduled) | `KuLHTd1509oEl3KntLmF` |
| Customer walkthroughs | EGC Customer Walkthroughs (staff scheduled) | `qsibYaxFPm16uyovdIc5` |

These Event calendars have no public weekly or date-specific availability. Denver timezone, Google invitation emails off, public cancellation/reschedule links off. Staff set actual appointment duration in the Hub. The website uses these defaults only for this location; explicit environment overrides remain supported. Customer scheduling rejects the Employee hiring calendar.

Only the two verified internal calendars use `ignoreFreeSlotValidation` because they intentionally have no public booking hours. This does not establish crew capacity: the manager must still review the Hub schedule and its conflict warnings. Other calendar overrides retain native slot validation. See the official [create](https://marketplace.gohighlevel.com/docs/ghl/calendars/create-appointment/) and [update appointment](https://marketplace.gohighlevel.com/docs/ghl/calendars/edit-appointment/) request definitions.

## Published no-message exit helpers

| Workflow | ID | Trigger |
| --- | --- | --- |
| EGC - Garage sales exit | `a1d9628c-6291-494e-b805-9e57af8b9ec9` | `egc-garage-sales-exit` added |
| EGC - Junk sales exit | `0c3d818a-7958-4a35-80b6-9ce1fe3135fb` | `egc-junk-sales-exit` added |

Garage removes only Garage instant text + nurture and Garage Quote Follow-Up Sequence, then the garage acquisition/quote tracking tags and its trigger tag. Junk removes only Junk Lead Nurture and its trigger tag. Neither sends a message, creates a task, changes consent, or touches hiring.

The server reads the saved job, current estimate or verified appointment/closeout, service type, linked contact and linked opportunity. It checks the matching location, phone/email, pipeline, and complete bounded inventories for another active customer job or open opportunity. Ambiguous or unavailable evidence produces a staff review status. It never guesses which existing opportunity to move.

Only `sales-followup-exit.js` can emit the reserved trigger tags; generic lifecycle requests reject their names. A manager can recheck eligible jobs from the Finance board. Assigned crew may sync their own jobs but cannot recheck another job or change its CRM links through this endpoint.

The `sales_handoffs` Firestore collection is a server-only dispatch ledger; default client rules deny access. Conditional writes prevent duplicate dispatch for the same estimate revision/amount. Unknown external results are held for verification rather than blindly retried. A queued result proves the tag request succeeded, not that GHL has finished executing. GHL and Firestore cannot share one transaction, so changes in another system between verification and execution remain a runtime limitation.

## Other published workflow repairs

- Future Garage/Junk contact owner fallback: Zachary Bezenek, only if unassigned. Explicitly approved by the owner; historical opportunities unchanged.
- Missed-call cooldown helper `b30b7cca-51e0-4b53-a9be-c325b14fd1aa`, 24 elapsed hours, with main workflow entry and pre-SMS guards. Existing working hours, callback task owner Pedro, and messages preserved. This does not deduplicate an unresolved callback task after the cooldown expires.
- Garage acquisition reply cleanup `d82f78cd-573d-440d-9f42-63b541ecc131`, matching replies to Garage instant text + nurture, removes only `fb-garage-quote-active`.
- Garage quote reply cleanup `e90cf853-34f6-4e33-a32b-750a829026b7`, matching replies to Garage Quote Follow-Up Sequence, removes only `gc-quote-open` and `gc-quote-cold`.

Each modified/published workflow was saved and reloaded with zero validation errors. No real contact was enrolled or messaged for testing. The 121 historical unassigned New Lead opportunities were not edited.

## Activation and verification

The mocked regression suite passes 204 tests. Production handoffs additionally require working HighLevel credentials, secure Hub login and Firebase server access. See [Employee Hub recovery](employee-hub-recovery.md) for exact settings and historical encryption-key preservation. Publishing code alone does not activate missing credentials.

After secure setup, verify using an explicitly approved internal test contact: acquisition reply cleanup; repeated missed calls within and after 24 hours; accepted Garage and Junk jobs; booked customer job; closeout; ambiguous multi-job hold; hiring unaffected. Avoid adding milestone tags to historical contacts to test. Confirm the existing paused/draft workflows separately before any reactivation.
