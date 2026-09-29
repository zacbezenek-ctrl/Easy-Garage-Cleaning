/**
 * SEC-04: who may run each legacy operations-bridge command, i.e. everything the Hub
 * endpoints /api/operations-portal and /api/operations-recording-approval dispatch
 * besides the hub.* registry (hub-command-policy.ts). Dependency-free and erasable
 * TypeScript on purpose, like hub-command-policy.ts: the Hub imports this exact file
 * (functions/_lib/operations-command-policy.js), so the API authorize() and the Hub
 * endpoints enforce ONE table.
 *
 * kind     read | write | send | money | destructive. A mode may refine it
 *          (schedule.mutate with mode "cancel" is destructive).
 * actors   who may run it, as {kind, role, idPattern?}: a signed human with that
 *          role, or an integration (role "integration"), optionally only the exact
 *          principal ids idPattern matches. Crew roles are never listed. Every
 *          integration write names the principals that really send it.
 * confirm  the body must carry `confirmation`, a SEC-03 token bound to the actor,
 *          the action (command or command:mode), the target record and the exact
 *          change. The Hub verifies it and consumes it in the change's own commit.
 */
export type BridgeCommandKind = "read" | "write" | "send" | "money" | "destructive";
export type BridgeActorRule = Readonly<{kind:"human"|"integration";role:string;idPattern?:RegExp}>;
export type BridgeModePolicy = Readonly<{kind:BridgeCommandKind;confirm:boolean}>;
export type BridgeCommandPolicy = Readonly<{kind:BridgeCommandKind;actors:readonly BridgeActorRule[];confirm:boolean;modes?:Readonly<Record<string,BridgeModePolicy>>}>;
export type BridgeCommandRule = Readonly<{command:string;action:string;kind:BridgeCommandKind;actors:readonly BridgeActorRule[];confirm:boolean}>;
type BridgeActor = {id?:unknown;kind?:unknown;role?:unknown};
type BridgeCommand = {readonly command?:unknown;readonly mode?:unknown};
export const BRIDGE_COMMAND_KINDS:readonly BridgeCommandKind[] = Object.freeze(["read","write","send","money","destructive"]);
/** The MCP's verified principals (apps/mcp/src/oauth.ts): one per OAuth grant (a uuid) and the static service bearer. */
export const MCP_PRINCIPAL_PATTERN = /^(?:mcp-oauth-grant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mcp-service-grant)$/;
const human = (...roles:string[]):BridgeActorRule[] => roles.map(role => ({kind:"human",role}));
const integration = (idPattern?:RegExp):BridgeActorRule => ({kind:"integration",role:"integration",...(idPattern ? {idPattern} : {})});
// Reads serve every business role and the API's own workers.
const READERS = [...human("owner","manager","sales"),integration()];
// Writes need a manager; the MCP is the only integration that writes visits and job records.
const WRITERS = [...human("owner","manager"),integration(MCP_PRINCIPAL_PATTERN)];
const policy = ({modes,...value}:BridgeCommandPolicy):BridgeCommandPolicy => Object.freeze({...value,actors:Object.freeze(value.actors.map(actor => Object.freeze({...actor}))),
  ...(modes ? {modes:Object.freeze(Object.fromEntries(Object.entries(modes).map(([mode,rule]) => [mode,Object.freeze({...rule})])))} : {})});
export const BRIDGE_COMMAND_POLICY:Readonly<Record<string,BridgeCommandPolicy>> = Object.freeze({
  "calendar": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.job": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.evidence": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.members": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.revenue": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.rules": policy({kind:"read",actors:READERS,confirm:false}),
  "schedule.resolve": policy({kind:"read",actors:READERS,confirm:false}),
  "portal.note.add": policy({kind:"write",actors:WRITERS,confirm:false}),
  "portal.job.edit": policy({kind:"write",actors:WRITERS,confirm:false}),
  "portal.project.ensure": policy({kind:"write",actors:WRITERS,confirm:false}),
  "schedule.mutate": policy({kind:"write",actors:WRITERS,confirm:false,modes:{cancel:{kind:"destructive",confirm:true}}}),
  // Provider evidence and customer links come only from the API's verified sync
  // (apps/api scheduling.ts, provider-notes.ts) and the MCP's provider binding.
  "schedule.link_customer": policy({kind:"write",actors:[integration(/^(?:schedule-sync|note-link):.+$/)],confirm:false}),
  "schedule.bind_provider": policy({kind:"write",actors:[integration(/^schedule-sync:.+$/),integration(MCP_PRINCIPAL_PATTERN)],confirm:false}),
  "schedule.adopt": policy({kind:"write",actors:[integration(/^booking-adoption-worker$/)],confirm:false}),
  // The API's schedule-sync loop (apps/api schedule-sync-worker.ts) is the only caller. sync_due
  // is a read of the queue whose only write is the loop's own check-in document.
  "schedule.sync_due": policy({kind:"read",actors:[integration(/^schedule-sync-worker$/)],confirm:false}),
  "schedule.sync_failed": policy({kind:"write",actors:[integration(/^schedule-sync-worker$/)],confirm:false}),
  // The hourly recurring-plan horizon run comes only from egc-api's own timer
  // (apps/api recurring-horizon-worker.ts); RECURRING_HORIZON_ACTOR in hub-command-policy.ts.
  "recurring.extend_horizon": policy({kind:"write",actors:[integration(/^recurring-horizon-worker$/)],confirm:false}),
  "recording.resolve": policy({kind:"read",actors:READERS,confirm:false}),
  // The API applies a recording only after a human manager approved its exact preview.
  "recording.apply": policy({kind:"write",actors:human("owner","manager"),confirm:false})
});
/** The rule for this exact command (a mode refines kind and confirm), or null. */
export function bridgeCommandPolicy(command:BridgeCommand|null|undefined, policies:Readonly<Record<string,BridgeCommandPolicy>> = BRIDGE_COMMAND_POLICY):BridgeCommandRule|null {
  const name = command?.command;
  if (typeof name !== "string" || !Object.hasOwn(policies,name)) return null;
  const base = policies[name]!, mode = typeof command?.mode === "string" && base.modes && Object.hasOwn(base.modes,command.mode) ? command.mode : null;
  const refined = mode ? base.modes![mode]! : base;
  return Object.freeze({command:name,action:mode ? `${name}:${mode}` : name,kind:refined.kind,actors:base.actors,confirm:refined.confirm});
}
/** Returns the denial code or null. Confirmation tokens are verified by the Hub.
 * principals:false checks kind and role only, for a lib the signed bridge reaches
 * after it matched the exact principal. */
export function bridgeCommandDenial(actor:BridgeActor|null|undefined, rule:BridgeCommandRule, {principals = true}:{principals?:boolean} = {}):string|null {
  if (!actor || typeof actor.id !== "string" || !actor.id || !["human","integration"].includes(String(actor.kind)) || (actor.kind === "integration") !== (actor.role === "integration")) return "bridge_actor_invalid";
  const id = actor.id;
  if (rule.actors.some(allowed => allowed.kind === actor.kind && allowed.role === actor.role && (!principals || !allowed.idPattern || allowed.idPattern.test(id)))) return null;
  return actor.kind === "integration" ? "bridge_integration_forbidden" : "bridge_role_forbidden";
}
/**
 * BRIDGE-ADOPT-AUTHZ: an integration actor id is only a claim inside a signed envelope,
 * so each one is bound to the service that mints it, and every verifier checks that
 * binding against the key it verified before any policy, storage or lib work:
 *   mcp     egc-mcp: one principal per OAuth grant plus its service bearer, and per Hub-approved
 *           grant mcp:<hub user>:<grant id> (apps/mcp/src/oauth.ts verifiedMcpPrincipal). Signs the
 *           API's /operations/rpc and /recordings/* with EGC_OPERATIONS_MCP_SIGNING_SECRET.
 *   hub     the Employee Hub's per-user sync identities (functions/_lib/operations-schedule-sync.js,
 *           operations-note-sync.js). Signs the API with its v2 key or the legacy portal key.
 *   api     egc-api's own workers and the sync identities it derives for a verified caller
 *           (apps/api operations.ts, inbound-actions.ts, booking-worker.ts, booking-adoption.ts,
 *           scheduling.ts, provider-notes.ts, schedule-sync-worker.ts) and the delegated funnel feed
 *           reader (FUN-37).
 *           Signs the Hub with its v2 key or the legacy key, and also presents the mcp and hub
 *           principals whose requests it verified and relays.
 *   worker  egc-worker's messaging cron. It signs with the API's key, so the Hub admits it
 *           only at /api/messaging-cron (messaging-cron.js): no bridge endpoint accepts it.
 * Humans are not bound here. A new integration principal is ONE bind() line below. An id
 * that no line (or more than one line) matches is refused as bridge_integration_issuer_unknown,
 * and an id its verified signer neither mints nor relays as bridge_integration_issuer_mismatch.
 */
/** A Hub-approved MCP grant: the approving Hub user (hub-identity.ts DELEGATE_USER) and the grant uuid. */
export const MCP_DELEGATED_PRINCIPAL_PATTERN = /^mcp:[a-z0-9][a-z0-9_.@-]{0,119}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type BridgeIssuer = "api" | "hub" | "mcp" | "worker";
export type BridgeActorBinding = Readonly<{idPattern:RegExp;issuer:BridgeIssuer}>;
const bind = (idPattern:RegExp, issuer:BridgeIssuer):BridgeActorBinding => Object.freeze({idPattern,issuer});
export const BRIDGE_ACTOR_BINDINGS:readonly BridgeActorBinding[] = Object.freeze([
  bind(MCP_PRINCIPAL_PATTERN,"mcp"),
  bind(MCP_DELEGATED_PRINCIPAL_PATTERN,"mcp"),
  bind(/^hub-(?:schedule|note):.+$/,"hub"),
  bind(/^(?:schedule-sync|note-link):.+$/,"api"),
  bind(/^operations-api$/,"api"),
  bind(/^inbound-response-reconciler$/,"api"),
  bind(/^booking-reconciler$/,"api"),
  bind(/^booking-adoption-worker$/,"api"),
  bind(/^post-job-followup$/,"api"),
  bind(/^schedule-sync-worker$/,"api"),
  bind(/^walkthrough-followup-worker$/,"api"),
  bind(/^recurring-horizon-worker$/,"api"),
  bind(/^messaging-cron-worker$/,"worker")
]);
/** The principals each verified signer may present: its own and, for the API, the ones it relays. */
export const BRIDGE_SIGNER_PRESENTS:Readonly<Partial<Record<BridgeIssuer,readonly BridgeIssuer[]>>> = Object.freeze({api:Object.freeze(["api","mcp","hub"] as BridgeIssuer[]),hub:Object.freeze(["hub"] as BridgeIssuer[]),mcp:Object.freeze(["mcp"] as BridgeIssuer[])});
/** The service that mints this integration id, or null when no single binding matches. */
export function bridgeActorIssuer(id:unknown, bindings:readonly BridgeActorBinding[] = BRIDGE_ACTOR_BINDINGS):BridgeIssuer|null {
  if (typeof id !== "string") return null;
  const matched = bindings.filter(binding => binding.idPattern.test(id));
  return matched.length === 1 ? matched[0]!.issuer : null;
}
/** Returns the denial code or null. signer is the service whose key signed the envelope
 * (null when the verifier could not name one); humans pass to the role policy. */
export function bridgeIssuerDenial(actor:BridgeActor|null|undefined, signer:BridgeIssuer|null, bindings:readonly BridgeActorBinding[] = BRIDGE_ACTOR_BINDINGS):string|null {
  if (actor?.kind !== "integration") return null;
  const issuer = bridgeActorIssuer(actor.id,bindings);
  if (!issuer) return "bridge_integration_issuer_unknown";
  return signer && BRIDGE_SIGNER_PRESENTS[signer]?.includes(issuer) ? null : "bridge_integration_issuer_mismatch";
}
