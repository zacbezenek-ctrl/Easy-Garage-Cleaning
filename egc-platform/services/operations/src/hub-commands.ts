import * as z from "zod/v4";
import {HUB_COMMAND_POLICY,HUB_REQUEST_ID_PATTERN,HUB_ROLES,hubCommandPolicy,type HubCommandName,type HubCommandPolicy} from "./hub-command-policy.js";
export * from "./hub-command-policy.js";

/** Employee Hub commands reached through the ONE signed bridge. Every schema is
 * strict; identity never comes from the body (only a delegate REQUEST, which the
 * Hub verifies). Add a command here, its policy, and a Hub registry handler. */
const SAMPLE_UUID = "00000000-0000-4000-8000-000000000000", NIL_UUID = "00000000-0000-0000-0000-000000000000", MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hubId = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/).refine(value=>!/^(_egc_|secure_)/.test(value),"Private Hub records are not addressable");
export const hubDelegate = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
export function hubReadCommand<N extends string,S extends z.ZodRawShape>(command:N,shape:S) {
  return z.object({command:z.literal(command),delegate:hubDelegate.optional(),...shape}).strict();
}
/** The same requestId rule the Hub runner enforces (hub-command-policy.ts). */
export const hubRequestId = z.string().regex(HUB_REQUEST_ID_PATTERN);
/** A registered command takes expectedRevision/confirmed from its shared policy, so
 * the API schema and the Hub registry read one flag. A policy (or explicit options)
 * may be passed for unregistered fixtures; assertHubContract still checks the result. */
export function hubWriteCommand<N extends string,S extends z.ZodRawShape>(command:N,shape:S,options?:{revisioned?:boolean;confirm?:boolean;confirmRequired?:boolean}) {
  const rule=hubCommandPolicy(command),revisioned=options?.revisioned??rule?.revisioned??false,confirm=options?.confirm??options?.confirmRequired??rule?.confirmRequired??false;
  return z.object({command:z.literal(command),delegate:hubDelegate.optional(),requestId:hubRequestId,
    ...(revisioned?{expectedRevision:z.string().min(1).max(200)}:{}),...(confirm?{confirmed:z.literal(true)}:{}),...shape}).strict();
}
export const HUB_COMMANDS = {
  "hub.dispatch.overview": hubReadCommand("hub.dispatch.overview",{view:z.enum(["schedule","job"]).default("schedule"),startDate:date.optional(),endDate:date.optional(),includeUnscheduled:z.boolean().optional(),jobId:hubId.optional()})
    .superRefine((c,ctx)=>{if(c.view==="job"?!c.jobId||c.startDate!==undefined||c.endDate!==undefined||c.includeUnscheduled!==undefined:c.jobId!==undefined)ctx.addIssue({code:"custom",message:"A job view takes exactly one jobId; a schedule view takes an optional date range"});}),
  "hub.staff.roster": hubReadCommand("hub.staff.roster",{})
} as const satisfies Record<HubCommandName,z.ZodObject>;
export const HUB_WRITE_COMMANDS:readonly string[] = Object.freeze(Object.entries(HUB_COMMAND_POLICY).filter(([,rule])=>rule.write).map(([name])=>name));
/** Commands the API forwards unchanged to the Hub authority (service.ts). */
export const PORTAL_PASSTHROUGH:ReadonlySet<string> = new Set(["portal.note.add","portal.job.edit","portal.project.ensure","calendar","portal.job","portal.evidence","portal.members","portal.revenue","portal.rules","schedule.resolve","schedule.mutate","schedule.bind_provider","schedule.link_customer",...Object.keys(HUB_COMMANDS)]);

const accepts=(schema:z.ZodType|undefined,value:unknown)=>Boolean(schema?.safeParse(value).success);
/** Static contract checks; run at module load so a malformed addition fails every build and test. */
export function assertHubContract(commands:Readonly<Record<string,z.ZodObject>>,policies:Readonly<Record<string,HubCommandPolicy>>) {
  const names=Object.keys(commands),fail=(name:string,reason:string):never=>{throw new Error(`hub_contract_invalid:${name}:${reason}`);};
  for(const name of Object.keys(policies))if(!Object.hasOwn(commands,name))fail(name,"schema_missing");
  for(const name of names) {
    const schema=commands[name]!,rule=policies[name]??fail(name,"policy_missing"),shape=schema.shape as Record<string,z.ZodType>;
    if(!/^hub\.[a-z]+(?:\.[a-z_]+)+$/.test(name)||!accepts(shape.command,name))fail(name,"command_literal");
    if(!accepts(shape.delegate,undefined)||accepts(shape.delegate,"Not A Username"))fail(name,"delegate_field");
    if(!rule.roles.length||new Set(rule.roles).size!==rule.roles.length||rule.roles.some(role=>!HUB_ROLES.includes(role)))fail(name,"roles");
    if(rule.ownerOnly&&!rule.roles.includes("owner"))fail(name,"owner_only_roles");
    if(typeof rule.revisioned!=="boolean")fail(name,"revisioned_flag");
    if(rule.write&&(!accepts(shape.requestId,SAMPLE_UUID)||[undefined,"not-a-uuid",NIL_UUID,MAX_UUID].some(value=>accepts(shape.requestId,value))))fail(name,"write_request_id");
    if(!rule.write&&shape.requestId)fail(name,"read_request_id");
    if(rule.write&&rule.integrationAllowed)fail(name,"integration_write");
    if(rule.confirmRequired&&(!rule.write||!accepts(shape.confirmed,true)||accepts(shape.confirmed,false)||accepts(shape.confirmed,undefined)))fail(name,"confirmation_field");
    if(!rule.confirmRequired&&shape.confirmed)fail(name,"unexpected_confirmation");
    if(rule.revisioned&&(!rule.write||!accepts(shape.expectedRevision,"2026-09-22T12:00:00.000000Z")||accepts(shape.expectedRevision,undefined)||accepts(shape.expectedRevision,"")))fail(name,"revision_field");
    if(!rule.revisioned&&shape.expectedRevision)fail(name,"unexpected_revision");
  }
}
assertHubContract(HUB_COMMANDS,HUB_COMMAND_POLICY);
