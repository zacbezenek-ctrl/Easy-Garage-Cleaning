# Voice walkthrough system

## Mobile flow

1. Open customer/job.
2. Tap **Start walkthrough**.
3. Browser records audio.
4. Upload audio to `POST /walkthroughs/:contactId/audio`.
5. API stores the original audio in object storage.
6. OpenAI transcription produces the raw transcript.
7. Structured extraction produces a strict walkthrough scope.
8. API stores the walkthrough as `draft`.
9. UI displays every extracted field for review.
10. Human edits if needed.
11. Human approves with `POST /walkthroughs/:id/approve`.
12. Approval commits scope to the EGC job record.

The database stores the original transcript and the structured extraction separately. Approval is required before the job scope is changed.

## Extraction fields

- garage size
- estimated junk volume
- remove / keep / relocate lists
- shelving / bike racks / tool racks
- pressure washing
- pest observations
- active infestation known/unknown
- access notes
- estimated labor hours
- customer preferences and objections
- sales / crew / pricing notes

## GHL write-back

The first production release should write only approved human-reviewed scope back to selected GHL notes/custom fields. MCP remains read-only. The provider write-back adapter is intentionally separated from extraction so a transcription/model failure cannot mutate CRM data.
