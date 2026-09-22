# Customer work occurrences

The acquisition lead, the work itself, and the Meta delivery have different identities. A customer can buy multiple jobs without becoming multiple acquired leads. Period jobs and revenue are counted per work occurrence; cohort conversion remains distinct acquisition customers. Meta continues its existing first-acquisition stage policy and immutable delivery IDs.

Migration `0012_loving_lizard.sql` adds durable work occurrences, exact aliases, typed predecessor links, and the nullable event occurrence reference. It does not rewrite history or send conversions.

`CUSTOMER_OCCURRENCE_LEDGER_MODE` controls rollout:

- Unset or `off`: existing live milestone projection; exact source identity metadata is retained for later migration.
- `shadow`: persist occurrence identities under the customer reconciliation lock and expose comparison metrics in `coverage.occurrences.preview`. Existing canonical event IDs, counts, and delivery state stay unchanged.
- `enabled`: publish occurrence event projections and work counts. Reserve previously persisted event IDs for the exact source occurrence they represent. Additional jobs get separate business event IDs. Accepted Meta payloads and lead-stage delivery IDs never change.

Use the same mode for the API, worker and MCP processes. Switching only one process would alternate the projections on each refresh. First deploy the migration and code with the default mode, run shadow reconciliation, compare the actual cohort and review identity issues, then enable consistently. A feature rollback does not delete occurrence identities or old events, but it returns reporting to the less detailed milestone projection.

Exact Portal-to-provider appointment bindings and `normalizedLocalJobId` / `normalizedLocalAppointmentId` join mirrors. An authoritative Portal kind may correct a mislabeled provider appointment. A generic service description alone cannot do this. Different authoritative Portal work IDs with a shared mirror are retained separately and flagged; they are never silently merged. Shared customer, opportunity, date, amount, or address is not an alias. `sourceWalkthroughId` is a predecessor link from a visit to paid work.

Dialogue without an exact work binding remains an unassigned commitment. Repeated statements stay in one unresolved acquisition bucket; independently evidenced work items in the same source can have distinct exact commitment anchors. Unassigned commitments remain visible but do not add fabricated jobs on top of known jobs. Verified amounts without an exact work assignment are disclosed separately and make a total partial. No model-proposed monetary amount is accepted.

Customer timelines expose all durable occurrences and typed links. Enabled customer projections include `activeWork`; a completed paid job cannot hide a second accepted unscheduled job. Period metrics expose occurrence units and unique customer counts; cohort numerator/denominator remains customer acquisition based. Each verified receipt retains its own original timestamp and identity.

Validation includes independent source-order reconciliation, exact mirror joins, distinct jobs sharing a deal, broken identity links, late exact linkage, separate same-call commitments, period versus cohort counts, verified revenue totals, shadow/live separation, legacy accepted event ID preservation, database replay, and first-acquisition Meta replay with a second job left unsent.
