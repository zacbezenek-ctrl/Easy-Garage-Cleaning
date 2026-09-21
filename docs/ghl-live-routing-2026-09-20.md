# GHL service routing: live inspection and repair

Inspected and saved September 20, 2026 (America/Denver), using the authenticated
HighLevel UI for location `KlgLwRaQSPz5G1YXsmc6`.

## Verified customer choice

The contact field **Facebook - Garage Help Requested** is a single-line field,
key `contact.facebook__garage_help_requested`. Its UI description identifies it
as the exact answer to “What do you want help with in your garage?” and says it
is used for organization and junk-removal follow-ups. It has no enumerated
allowed-value list. Existing normalized-contact evidence identifies field ID
`eeVNj4ay4uwJGgP6pzrq` and the exact values `Item Removal Only` and
`Full Garage Transformation`.

## Saved workflow changes

### Junk Lead Nurture

- Workflow: `2ac2aba5-1521-4e76-82af-074c039d84a2`.
- Published before and after the change; inventory showed 18 total enrollments,
  13 active at inspection.
- Original trigger: Facebook lead form submitted; page **Easy Garage Cleaning &
  Junk Removal**; form **Curb Side Pickup**. No customer-service condition.
- Original entry chain: owner fallback, entry tag, working-hours hold,
  **SMS 1 - photo ask**, then pricing email. No branch before the initial SMS.
- Initial SMS explicitly assumes junk removal and requests a photo, access
  details, and timing, then promises a quote.
- Added only one trigger condition: **Facebook - Garage Help Requested → Exact
  match phrase → Item Removal Only**.
- Saved, reloaded, reopened the trigger, and verified the exact value persisted.
  Published state remained enabled; action chain unchanged.

### Garage instant text + nurture

- Workflow: `edae095b-6ccb-4620-b66e-e16d172251b2`.
- Published before and after the change; inventory showed 38 total enrollments,
  18 active at inspection.
- Existing trigger retained its page and four form selections:
  `Easy Garage Cleaning - Free Walkthrough offer`,
  `Untitled form 5/21/26, 8:38 AM-copy`,
  `Untitled form 5/21/26, 8:38 AM`, and
  `Untitled form 5/21/26, 8:30 AM`.
- Existing initial SMS was inspected: it offers a free garage walkthrough and
  asks which day works. No wording changed.
- Added an additional trigger named **Full Garage Transformation - Curb Side
  Pickup form** with all three conditions:
  1. Page: **Easy Garage Cleaning & Junk Removal**.
  2. Form: **Curb Side Pickup**.
  3. **Facebook - Garage Help Requested → Exact match phrase → Full Garage
     Transformation**.
- Saved, reloaded, reopened the new trigger, and verified all three conditions
  persisted. Published state remained enabled.

### EGC - Sept 10 Facebook service routing

- Workflow: `ae9f0826-8ec1-467d-8059-59c024a9de5e`.
- The reported transformation contact's workflow history identifies this router
  as a past workflow and Junk Lead Nurture as its active destination. Junk
  enrollment history confirms entry from another workflow, bypassing form-trigger
  guards on the destination workflow.
- Root cause: the garage branch checked `org`, or both `full` and `clean`, or
  exact removal aliases. The current answer `Full Garage Transformation` matched
  none. The default branch enrolled the contact in Junk Lead Nurture.
- Replaced erroneous garage exact aliases `removal,removal only` with
  `full garage transformation`. Existing organization and full-cleaning rules
  remain. The preceding trim/fallback/lowercase sequence remains unchanged.
- Changed the manual-review condition from equality to the missing-answer
  sentinel to **Is not `item removal only`**, after the garage branch. Renamed
  it **Missing or unknown service - manual review**. Thus only the explicit
  normalized junk answer reaches the default junk action chain.
- Garage branch stops junk nurture then adds **Garage instant text + nurture**;
  this destination was opened and verified. Review branch creates the existing
  review task then ends. Downstream actions were retained.
- Saved the action and workflow, reloaded, reopened the condition, and verified
  both exact predicates persisted. Published state remains enabled.

## Existing enrollment correction

The final audit found 19 enrollment rows: 14 waiting and five already finished.
Fresh contact reads confirmed 11 waiting contacts with the exact answer
`Full Garage Transformation`; three had `Item Removal Only`.

Stopped only the 11 transformation enrollments in Junk Lead Nurture. Each row
was read back as **Finished**, with **Not available** for the next execution.
All historical rows remain. The three legitimate junk enrollments remain
waiting, and no existing contact was re-enrolled in a different workflow.

Provider contact IDs for the stopped transformation enrollments:

```
8LQ0WGhGDcvNDiDLsS5W
Iqr6V8oJ5OA6JmwdNwZs
54wsyOynYbXa9n2eJOVj
684sBKyOL2A7bGEpqewY
eEydxWp1t9jqg8lSktGS
RZ9FnOOrSvbvmFGmHLhh
V1peuS6mJ5kRLnLXHmDB
quJy7C0h5rUNl7DdSn9g
jGbcuJfMlXCamcdUJBRr
sdeGV0JW1A33YIqaoIVg
BFGNBGRg9jnJ8Qagljgg
```

The exact contact link was used to resolve the older record outside the recent
100-contact search; its ID and service choice were checked directly in GHL.
Customer names, addresses, phones, emails and conversation text are omitted.

## Isolated live routing validation

Used one synthetic contact, **EGC ROUTING CANARY 20260920**, provider ID
`BcWpUU3IKIRPVk9hq24H`, normalized ID
`3e010d8f-bc20-4452-b193-e1947a739027`. DND for all channels was enabled before
creation, and the fixture has no phone or email. Source is
`EGC synthetic routing validation`; retained tags are `egc-test`,
`routing-canary`, and `do-not-contact`.

Ran the published router's **Test workflow** against that fixture with the
actual service-choice field. Execution logs and condition traces verified:

| Field value | Result | Finished (America/Denver, September 20) |
| --- | --- | --- |
| `Needs manual service review` | Normalized unknown value matched manual review; review task created; workflow ended | 18:32:06 |
| `Full Garage Transformation` | Exact normalized transformation predicate matched; junk removed; garage walkthrough follow-up started | 18:34:43 |
| `Item Removal Only` | Garage predicates false; manual-review predicate false; garage follow-up removed; junk follow-up started | 18:36:30 |

After testing, stopped the fixture's remaining junk enrollment. Reloaded the
contact and verified **Active workflows** is empty; router, garage and junk
appear only as past workflows. Completed the synthetic review task and restored
only the three test tags above. Fresh API readback confirms `dnd: true`, absent
phone/email, test source and exact test tag set. Conversation view remains empty.
No fixture was deleted; execution history is retained for audit.

This validates actual router execution and downstream enrollment. It does not
simulate a fresh Facebook form webhook, so form-entry delivery itself is not
claimed as tested.

## Scope and remaining validation

- No actual customer messages were sent, no actual customer tags changed, and no
  actual customer was re-enrolled.
  The targeted enrollment stops above suppress incorrect future communications.
- For Curb Side Pickup submissions, missing, unknown, or conflicting answers
  match neither of these new service-choice routes. They need a manual-review
  item rather than a guessed customer message.
- The newer Sept 10 router was traced through actual contact workflow history
  and repaired as described above; unrelated workflow behavior was retained.
- The isolated live test above verified all three router branches without any
  deliverable contact identity. Future real form submissions should be monitored
  for entry and service-choice mapping, without re-enrolling existing customers.

## Integration administration access

- Location Private Integrations inventory included `EGC Hub`
  (`6a99e30699399d3d2a56cb7b`), `Claude MCP`
  (`6a5ef030bcb170de4977211c`), and `adsas`
  (`6aad7da6614ba1bf332b85d8`). No credentials were opened or copied.
- Location Installed Apps listed exactly four active entries: LC GPT Connector,
  Quo, Official Jobber Integration, and lc-mcp - Anthropic. No custom EGC
  Marketplace app appeared in that list.
- HighLevel's [webhook integration guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/)
  configures signed event subscriptions on a Marketplace OAuth app, under
  Advanced Settings → Webhooks. This differs from a private integration token
  and from an ordinary workflow webhook action.
- The separate developer portal at
  `https://marketplace.gohighlevel.com/login` required sign-in, so its apps and
  subscription configuration could not yet be inspected. The normal location
  session remained authenticated.
- `https://dash.cloudflare.com/` also required sign-in. Source documentation
  identifies Pages project `easy-garage-cleaning` and Firebase project
  `egcw-1ec83`, but the deployed Pages revision and server environment-variable
  names were not verified in the dashboard.
- A later fresh check still showed the Cloudflare and developer Marketplace
  sign-in pages. The live Employee Portal at
  `https://easygaragecleaning.com/employee` also required sign-in. Its two
  reported appointment cases therefore could not be inspected in the Hub UI;
  no Hub records were changed or cancelled.

No login was automated. No webhook subscriptions were created or changed.
