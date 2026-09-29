# Owner decisions preserved verbatim

The following is the owner's wrap-up instruction in this task. Keep its wording when updating the handoff; record any later change with a date and source.

> Everything for the wrap-up is in motion:
>
> - **Merge queue** (one at a time, tests still run on each): the credits fix → the handoff commit → FIELD-PAY → refunds → HighLevel milestone tags → then the seven builds still running as each finishes. Refunds and milestone tags go in with their flags off and their review state written into the commit and the handoff file, so nobody turns them on blind.
> - **Batch 8 merges to main** once FIELD-PAY is in and CI is green; the rest lands through a batch 9 PR.
> - **Handoff:** docs/HANDOFF.md (what this is, the rules, how to run tests, what's built, what's parked and why, owner actions, how to continue) plus `docs/handoff/` with the machine-readable unit status, the launch order, your decisions verbatim, the follow-ups list, and all 41 specs for unbuilt or in-flight units. It commits to the branch in the next few minutes and I'll refresh it once more at the end.
> - **No new units start.**

The coordinator also relayed the owner's instruction **“Use the existing key and just GET IT DONE”** for the Hub recording/transcript work. The exact surrounding message is not present in this checkout or task context, so this line should be replaced with the full original text if it is later recovered.

The standing HighLevel boundary is recorded separately in [HIGHLEVEL-BOUNDARY.md](../HIGHLEVEL-BOUNDARY.md), including the owner's original words and the paths that can write or send.
