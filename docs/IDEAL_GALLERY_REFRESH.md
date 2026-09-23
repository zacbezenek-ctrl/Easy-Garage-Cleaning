# Public gallery visual refresh — September 23, 2026

User direction: messier before images, more black metal storage in the ideal EGC outcome, strongest transformations at the top. Follow-up: leave backend investigation and work to Claude.

Scope is the public gallery's images, presentation data, HTML renderer/static fallback, and gallery-only content/browser verification. No operations, auth, CRM, appointments, payments, database, reconciliation, or other backend changes are part of this release. Existing repository CI remains unchanged; no checks are weakened or bypassed.

## Selection

Eight scenes were regenerated as reference-based fictional before/after concepts: complete organization, family garage, winter parking, workbench, seasonal storage, moving boxes, bikes, single-car garage. Public order is deliberately curated in that order. The other 16 original distinct scenes remain below the refreshed set. The collection remains 24 pairs / 48 displayed images, not 32 pairs or duplicated scenes.

The after concepts emphasize substantial matte black steel open shelving, coordinated black/yellow storage bins, sensible wall storage and cleared central floor space. The prompts preserve the original garage instead of depicting an epoxy-flooring or paint renovation. These are design concepts; neither exact photographic fidelity nor a guaranteed customer outcome is claimed.

All eight new pairs were visually inspected using the generated contact sheets and the corrected bike image. The four-high horizontal bike stack in job `1606723b-355e-48a2-9d15-a58df8261e0b` was rejected and its file removed. The published bike selection is `951c8c03-2641-487f-9359-23bcf3c2e800`, with accessible floor-level parking for four bicycles.

The public selection records its own reviewed-concept status. Original staff fixtures and their prior provenance/review states are not rewritten. Full generation IDs and output hashes are in `gallery-ideal-generation.json` and `gallery-ideal-assets.json`; their initial pending-review label records the pre-curation submission stage. The one-off download workflow is removed before release; this change does not install a new recurring process or expose a model key.

Use the final release PR for actual merge and public deployment evidence. A saved change is not evidence that the live website has updated.
