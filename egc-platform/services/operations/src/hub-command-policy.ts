/**
 * Employee Hub bridge command policy. Dependency-free and erasable TypeScript on
 * purpose: the Hub (Cloudflare Pages Functions) imports this exact file, so the
 * API authorize() and the Hub registry enforce ONE policy map.
 *
 * write            mutates Hub state: body requestId (UUID), human actor only,
 *                  expectedRevision where the target is revisioned, and the
 *                  Hub commits a server-only hub_command_operations/{requestId}
 *                  receipt (fingerprint, actor, before/after) in the SAME atomic
 *                  commit, so a retry replays the saved outcome.
 * integrationAllowed an integration actor may call it only with a delegate the
 *                  Hub verifies against its own owner-configured delegation map.
 * roles            human roles (or the verified delegate's CURRENT Hub role).
 * ownerOnly        only an owner, whether signed in or delegated.
 * confirmRequired  the body must carry an explicit confirmed:true from a human
 *                  confirmation step. Only meaningful for writes.
 * revisioned       the write targets a revisioned Hub record, so the body must
 *                  carry expectedRevision. The API schema (hubWriteCommand) and the
 *                  Hub registry both read THIS flag; never declare it elsewhere.
 */
export type HubRole = "owner" | "manager" | "sales";
export type HubCommandPolicy = Readonly<{write:boolean;integrationAllowed:boolean;roles:readonly HubRole[];ownerOnly:boolean;confirmRequired:boolean;revisioned:boolean}>;
/** The ONE write requestId rule for the API schema and the Hub runner: an RFC 9562
 * UUID with version 1-8 and the RFC variant, so the nil and max UUIDs are refused. */
export const HUB_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isHubRequestId = (value:unknown):value is string => typeof value === "string" && HUB_REQUEST_ID_PATTERN.test(value);
type BridgeActor = {id:string;kind:string;role:string;workspace?:string};
type BridgeCommand = {readonly command?:unknown;readonly delegate?:unknown;readonly confirmed?:unknown};
export const HUB_ROLES:readonly HubRole[] = Object.freeze(["owner","manager","sales"]);
const policy = (value:HubCommandPolicy):HubCommandPolicy => Object.freeze({...value,roles:Object.freeze([...value.roles])});
export const HUB_COMMAND_POLICY = Object.freeze({
  "hub.dispatch.overview": policy({write:false,integrationAllowed:true,roles:["owner","manager"],ownerOnly:false,confirmRequired:false,revisioned:false}),
  "hub.staff.roster": policy({write:false,integrationAllowed:true,roles:["owner","manager","sales"],ownerOnly:false,confirmRequired:false,revisioned:false})
});
export type HubCommandName = keyof typeof HUB_COMMAND_POLICY;
export const isHubCommandName = (name:unknown):name is string => typeof name === "string" && name.startsWith("hub.");
export function hubCommandPolicy(name:unknown, policies:Readonly<Record<string,HubCommandPolicy>> = HUB_COMMAND_POLICY):HubCommandPolicy|null {
  return typeof name === "string" && Object.hasOwn(policies,name) ? policies[name]! : null;
}
/** Returns the denial code or null. The Hub still verifies delegates and current roles. */
export function hubCommandDenial(actor:BridgeActor, command:BridgeCommand, rule:HubCommandPolicy):string|null {
  if (actor.kind === "integration") {
    if (!rule.integrationAllowed) return "hub_integration_forbidden";
    if (rule.write) return "hub_integration_write_forbidden";
    if (typeof command.delegate !== "string" || !command.delegate) return "hub_delegate_required";
  } else {
    if (actor.kind !== "human" || !(HUB_ROLES as readonly string[]).includes(actor.role) || !(rule.roles as readonly string[]).includes(actor.role)) return "hub_role_forbidden";
    if (command.delegate !== undefined) return "hub_delegate_not_allowed";
  }
  if (rule.ownerOnly && actor.kind === "human" && actor.role !== "owner") return "hub_owner_required";
  if (rule.confirmRequired && command.confirmed !== true) return "hub_confirmation_required";
  return null;
}
