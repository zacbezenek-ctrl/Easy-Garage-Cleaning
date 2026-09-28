import {describe,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import * as z from "zod/v4";
import {authorize,commandSchema,OperationsError,WRITE_COMMANDS,type Actor,type Command} from "./contracts.js";
import {HUB_COMMANDS,HUB_COMMAND_POLICY,HUB_FUNNEL_CASE_CURSOR_PATTERN,HUB_FUNNEL_FEED_CURSOR_PATTERN,HUB_REQUEST_ID_PATTERN,HUB_WRITE_COMMANDS,PORTAL_PASSTHROUGH,assertHubContract,hubCommandDenial,hubReadCommand,hubRequestId,hubWriteCommand,isHubRequestId,type HubCommandPolicy} from "./hub-commands.js";
import {OperationsService} from "./service.js";

const owner:Actor={id:"zacb",role:"owner",kind:"human",workspace:"egc"};
const manager:Actor={...owner,id:"tylerg",role:"manager"};
const sales:Actor={...owner,id:"alexk",role:"sales"};
const integration:Actor={id:"mcp-oauth-grant:synthetic",role:"integration",kind:"integration",workspace:"egc"};
const read:HubCommandPolicy={write:false,integrationAllowed:true,roles:["owner","manager"],ownerOnly:false,confirmRequired:false,revisioned:false};
const denied=(fn:()=>unknown,code:string)=>{try{fn();throw new Error("Expected denial");}catch(e){expect(e).toBeInstanceOf(OperationsError);expect((e as OperationsError).code).toBe(code);expect((e as OperationsError).status).toBe(403);}};
const synthetic=(name:string)=>({command:name} as unknown as Command);
const ownerOnly:Record<string,HubCommandPolicy>={"hub.synthetic.owner_read":{...read,roles:["owner"],ownerOnly:true},"hub.synthetic.owner_write":{write:true,integrationAllowed:false,roles:["owner"],ownerOnly:true,confirmRequired:false,revisioned:false}};
// The Hub runner (functions/_lib/operations-hub-commands.js) imports HUB_REQUEST_ID_PATTERN; these ids pin one rule on both sides.
const REQUEST_IDS:[string,boolean][]=[[randomUUID(),true],["0190f3a2-7c1e-7d4b-9a2f-3c5e8b1d2f40",true],["6BA7B810-9DAD-11D1-80B4-00C04FD430C8",true],["00000000-0000-0000-0000-000000000000",false],["ffffffff-ffff-ffff-ffff-ffffffffffff",false],["6ba7b810-9dad-01d1-80b4-00c04fd430c8",false],["6ba7b810-9dad-91d1-80b4-00c04fd430c8",false],["6ba7b810-9dad-11d1-c0b4-00c04fd430c8",false],["6ba7b8109dad11d180b400c04fd430c8",false],[" 6ba7b810-9dad-11d1-80b4-00c04fd430c8",false]];

describe("hub command registry contract",()=>{
 it("gives every hub command exactly one policy, a matching literal and a strict schema",()=>{
  expect(Object.keys(HUB_COMMANDS).sort()).toEqual(Object.keys(HUB_COMMAND_POLICY).sort());
  for(const [name,schema] of Object.entries(HUB_COMMANDS)){
   const policy=HUB_COMMAND_POLICY[name as keyof typeof HUB_COMMAND_POLICY];
   expect(Object.keys(policy).sort()).toEqual(["confirmRequired","integrationAllowed","ownerOnly","revisioned","roles","write"]);
   expect(policy.roles.every(role=>["owner","manager","sales"].includes(role))).toBe(true);
   expect(schema.shape.command.safeParse(name).success).toBe(true);
   expect(commandSchema.safeParse({command:name,unexpected:true}).success).toBe(false);
  }
 });
 it("requires a uuid requestId on every write command",()=>{
  for(const name of HUB_WRITE_COMMANDS){const shape=HUB_COMMANDS[name as keyof typeof HUB_COMMANDS].shape as Record<string,z.ZodType>;expect(shape.requestId?.safeParse(undefined).success).toBe(false);expect(shape.requestId?.safeParse("not-a-uuid").success).toBe(false);expect(shape.requestId?.safeParse(randomUUID()).success).toBe(true);}
  const write=hubWriteCommand("hub.synthetic.save",{note:z.string()},{revisioned:true,confirm:true});
  const valid={command:"hub.synthetic.save",requestId:randomUUID(),expectedRevision:"2026-09-22T12:00:00.000000Z",confirmed:true,note:"Synthetic"};
  expect(write.safeParse(valid).success).toBe(true);
  for(const change of [{requestId:undefined},{requestId:"123"},{expectedRevision:undefined},{expectedRevision:""},{confirmed:false},{confirmed:undefined},{actor:"forged"}])expect(write.safeParse({...valid,...change}).success).toBe(false);
  expect(()=>assertHubContract({"hub.synthetic.save":write},{"hub.synthetic.save":{write:true,integrationAllowed:false,roles:["owner","manager"],ownerOnly:false,confirmRequired:true,revisioned:true}})).not.toThrow();
 });
 it("fails at load for write commands without requestId and other unsafe policies",()=>{
  const readSchema=hubReadCommand("hub.synthetic.read",{}),writeSchema=hubWriteCommand("hub.synthetic.read",{});
  const cases:[Record<string,z.ZodObject>,Record<string,HubCommandPolicy>,string][]=[
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,write:true,integrationAllowed:false}},"write_request_id"],
   [{"hub.synthetic.read":readSchema},{},"policy_missing"],
   [{},{"hub.synthetic.read":read},"schema_missing"],
   [{"hub.synthetic.read":writeSchema},{"hub.synthetic.read":{...read,write:true}},"integration_write"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,roles:["owner","crew" as "owner"]}},"roles"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,roles:[]}},"roles"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,roles:["manager"],ownerOnly:true}},"owner_only_roles"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,confirmRequired:true}},"confirmation_field"],
   [{"hub.synthetic.read":writeSchema},{"hub.synthetic.read":read},"read_request_id"],
   [{"hub.synthetic.read":z.object({command:z.literal("hub.synthetic.read")}).strict()},{"hub.synthetic.read":read},"delegate_field"],
   [{"hub.other.read":readSchema},{"hub.other.read":read},"command_literal"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,revisioned:undefined as unknown as boolean}},"revisioned_flag"],
   [{"hub.synthetic.read":writeSchema},{"hub.synthetic.read":{...read,write:true,integrationAllowed:false,revisioned:true}},"revision_field"],
   [{"hub.synthetic.read":hubWriteCommand("hub.synthetic.read",{},{revisioned:true})},{"hub.synthetic.read":{...read,write:true,integrationAllowed:false}},"unexpected_revision"],
   [{"hub.synthetic.read":readSchema},{"hub.synthetic.read":{...read,revisioned:true}},"revision_field"],
   [{"hub.synthetic.read":z.object({command:z.literal("hub.synthetic.read"),delegate:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).optional(),requestId:z.string().uuid()}).strict()},{"hub.synthetic.read":{...read,write:true,integrationAllowed:false}},"write_request_id"]
  ];
  for(const [commands,policies,reason] of cases)expect(()=>assertHubContract(commands,policies)).toThrow(reason);
 });
 it("reads the revisioned flag from the ONE shared policy: the schema requires expectedRevision exactly when the policy says so",()=>{
  for(const [name,schema] of Object.entries(HUB_COMMANDS)){
   const rule=HUB_COMMAND_POLICY[name as keyof typeof HUB_COMMAND_POLICY],shape=schema.shape as Record<string,z.ZodType|undefined>;
   expect(typeof rule.revisioned).toBe("boolean");
   expect(Boolean(shape.expectedRevision)).toBe(rule.revisioned);
   if(rule.revisioned)expect(shape.expectedRevision!.safeParse(undefined).success).toBe(false);
  }
  const policy:HubCommandPolicy={write:true,integrationAllowed:false,roles:["owner","manager"],ownerOnly:false,confirmRequired:true,revisioned:true};
  const derived=hubWriteCommand("hub.synthetic.save",{note:z.string()},policy),shape=derived.shape as Record<string,z.ZodType|undefined>;
  expect(shape.expectedRevision?.safeParse("2026-09-22T12:00:00.000000Z").success).toBe(true);expect(shape.confirmed?.safeParse(true).success).toBe(true);
  expect(()=>assertHubContract({"hub.synthetic.save":derived},{"hub.synthetic.save":policy})).not.toThrow();
  const plain=hubWriteCommand("hub.synthetic.save",{note:z.string()},{...policy,revisioned:false,confirmRequired:false});
  expect(Object.hasOwn(plain.shape,"expectedRevision")||Object.hasOwn(plain.shape,"confirmed")).toBe(false);
  expect(()=>assertHubContract({"hub.synthetic.save":plain},{"hub.synthetic.save":{...policy,confirmRequired:false}})).toThrow("revision_field");
 });
 it("uses one requestId rule for the API schema and the Hub runner, refusing the nil and max UUIDs",()=>{
  const write=hubWriteCommand("hub.synthetic.save",{});
  for(const [id,valid] of REQUEST_IDS){
   expect(HUB_REQUEST_ID_PATTERN.test(id)).toBe(valid);expect(isHubRequestId(id)).toBe(valid);
   expect(hubRequestId.safeParse(id).success).toBe(valid);
   expect(write.safeParse({command:"hub.synthetic.save",requestId:id}).success).toBe(valid);
  }
  for(const value of [undefined,null,42,{}])expect(isHubRequestId(value)).toBe(false);
 });
 it("derives write commands and the portal passthrough from the registry without losing legacy entries",()=>{
  for(const name of Object.keys(HUB_COMMANDS)){expect(PORTAL_PASSTHROUGH.has(name)).toBe(true);expect(WRITE_COMMANDS.has(name)).toBe(HUB_COMMAND_POLICY[name as keyof typeof HUB_COMMAND_POLICY].write);}
  for(const name of ["portal.note.add","portal.job.edit","portal.project.ensure","calendar","portal.job","portal.evidence","portal.members","portal.revenue","portal.rules","schedule.resolve","schedule.mutate","schedule.bind_provider","schedule.link_customer"])expect(PORTAL_PASSTHROUGH.has(name)).toBe(true);
  for(const name of ["task.create","status","queue","schedule.adopt","schedule.sync_provider","provider.note.ensure","history"])expect(PORTAL_PASSTHROUGH.has(name)).toBe(false);
  for(const name of ["task.create","schedule.adopt","portal.note.add"])expect(WRITE_COMMANDS.has(name)).toBe(true);
 });
 it("parses the dispatch overview and roster reads and rejects identity, pay and private-record fields",()=>{
  expect(commandSchema.parse({command:"hub.dispatch.overview",startDate:"2026-09-22",endDate:"2026-09-29"})).toEqual({command:"hub.dispatch.overview",view:"schedule",startDate:"2026-09-22",endDate:"2026-09-29"});
  expect(commandSchema.safeParse({command:"hub.dispatch.overview",view:"job",jobId:"job-a",delegate:"zacb"}).success).toBe(true);
  for(const body of [{command:"hub.dispatch.overview",view:"job"},{command:"hub.dispatch.overview",view:"job",jobId:"secure_vault"},{command:"hub.dispatch.overview",view:"job",jobId:"_egc_lock"},{command:"hub.dispatch.overview",jobId:"job-a"},{command:"hub.dispatch.overview",view:"customers"},{command:"hub.dispatch.overview",startDate:"09/22/2026"},{command:"hub.dispatch.overview",actor:{id:"zacb"}},{command:"hub.staff.roster",includePay:true},{command:"hub.staff.roster",delegate:"Not Valid"},{command:"hub.unknown"}])expect(commandSchema.safeParse(body).success).toBe(false);
 });
});

describe("FUN-37 funnel feed commands",()=>{
 const cursor=`f1~2026-09-22T12:00:00.000Z~fe_${"a".repeat(40)}`,caseCursor=`c1~2026-09-22T12:00:00.123456Z~projectId~project_w1~2026-09-22T11:00:00.000Z~fe_${"b".repeat(40)}~0123456789abcdef`;
 it("parses the feed, outcome and case reads with their cursors, and nothing else",()=>{
  expect(commandSchema.parse({command:"hub.funnel.events",sinceCursor:cursor,types:["deal.sold","walkthrough.completed"],limit:200,delegate:"zacb"})).toEqual({command:"hub.funnel.events",sinceCursor:cursor,types:["deal.sold","walkthrough.completed"],limit:200,delegate:"zacb"});
  expect(commandSchema.parse({command:"hub.funnel.events",sinceCursor:null})).toEqual({command:"hub.funnel.events",sinceCursor:null});
  expect(commandSchema.parse({command:"hub.walkthrough.outcomes"})).toEqual({command:"hub.walkthrough.outcomes"});
  for(const key of [{projectId:"project_w1"},{jobId:"job-a"},{highlevelContactId:"contactA"}])expect(commandSchema.safeParse({command:"hub.funnel.case",...key,cursor:caseCursor,limit:10}).success).toBe(true);
  expect(HUB_FUNNEL_FEED_CURSOR_PATTERN.test(cursor)).toBe(true);expect(HUB_FUNNEL_CASE_CURSOR_PATTERN.test(caseCursor)).toBe(true);
  for(const body of [
   {command:"hub.funnel.events",sinceCursor:"f1~2026-09-22T12:00:00Z~fe_x"},{command:"hub.funnel.events",sinceCursor:caseCursor},{command:"hub.funnel.events",types:[]},{command:"hub.funnel.events",types:["deal.sold","deal.sold"]},
   {command:"hub.funnel.events",types:Array.from({length:31},(_,i)=>`job.t${"a".repeat(i)}`)},{command:"hub.funnel.events",types:["DROP TABLE"]},{command:"hub.funnel.events",limit:0},{command:"hub.funnel.events",limit:201},{command:"hub.funnel.events",offset:100},
   {command:"hub.funnel.events",requestId:randomUUID()},{command:"hub.funnel.events",includeCosts:true},{command:"hub.walkthrough.outcomes",types:["deal.sold"]},{command:"hub.walkthrough.outcomes",sinceCursor:caseCursor},
   {command:"hub.funnel.case"},{command:"hub.funnel.case",projectId:"project_w1",jobId:"job-a"},{command:"hub.funnel.case",jobId:"secure_vault"},{command:"hub.funnel.case",projectId:"_egc_lock"},{command:"hub.funnel.case",highlevelContactId:"has space"},
   {command:"hub.funnel.case",customerId:"c1"},{command:"hub.funnel.case",projectId:"project_w1",cursor}
  ])expect(commandSchema.safeParse(body).success,JSON.stringify(body)).toBe(false);
 });
 it("admits owners, managers and delegated integrations, and refuses sales, crew and undelegated workers",()=>{
  const worker:Actor={id:"walkthrough-followup-worker",role:"integration",kind:"integration",workspace:"egc"};
  for(const [name,body] of [["hub.funnel.events",{}],["hub.walkthrough.outcomes",{}],["hub.funnel.case",{projectId:"project_w1"}]] as const){
   expect(HUB_COMMAND_POLICY[name]).toEqual({write:false,integrationAllowed:true,roles:["owner","manager"],ownerOnly:false,confirmRequired:false,revisioned:false});
   expect(PORTAL_PASSTHROUGH.has(name)).toBe(true);expect(WRITE_COMMANDS.has(name)).toBe(false);
   for(const actor of [owner,manager])expect(()=>authorize(actor,commandSchema.parse({command:name,...body}),"egc")).not.toThrow();
   denied(()=>authorize(sales,commandSchema.parse({command:name,...body}),"egc"),"hub_role_forbidden");
   denied(()=>authorize(worker,commandSchema.parse({command:name,...body}),"egc"),"hub_delegate_required");
   expect(()=>authorize(worker,commandSchema.parse({command:name,...body,delegate:"zacb"}),"egc")).not.toThrow();
   for(const role of ["crew","crew_lead"] as const)denied(()=>authorize({...owner,role},commandSchema.parse({command:name,...body}),"egc"),"role_forbidden");
  }
 });
 it("forwards a feed read unchanged to the Hub without touching PostgreSQL",async()=>{
  const portalRead=vi.fn(async()=>({ok:true,authority:"employee_hub",events:[],nextCursor:cursor}));
  const service=new OperationsService(new Proxy({},{get(){throw new Error("database must not be used");}}) as never,{workspace:"egc",portalRead});
  await expect(service.execute(manager,{command:"hub.funnel.events",sinceCursor:cursor,types:["deal.sold"]},randomUUID())).resolves.toMatchObject({nextCursor:cursor});
  expect(portalRead).toHaveBeenCalledWith(manager,{command:"hub.funnel.events",sinceCursor:cursor,types:["deal.sold"]});
 });
});

describe("hub authorization through authorize()",()=>{
 it("denies owner-only commands to non-owners and to undelegated integration actors",()=>{
  for(const name of Object.keys(ownerOnly)){
   for(const actor of [manager,sales])denied(()=>authorize(actor,synthetic(name),"egc",ownerOnly),"hub_role_forbidden");
   expect(()=>authorize(owner,synthetic(name),"egc",ownerOnly)).not.toThrow();
  }
  denied(()=>authorize(integration,synthetic("hub.synthetic.owner_read"),"egc",ownerOnly),"hub_delegate_required");
  denied(()=>authorize(integration,synthetic("hub.synthetic.owner_write"),"egc",ownerOnly),"hub_integration_forbidden");
  // A delegated owner-only read passes the API pre-check; the Hub verifies the delegate is really an owner.
  expect(()=>authorize(integration,{command:"hub.synthetic.owner_read",delegate:"zacb"} as unknown as Command,"egc",ownerOnly)).not.toThrow();
  const managerRoles:Record<string,HubCommandPolicy>={"hub.synthetic.owner":{...read,roles:["owner","manager"],ownerOnly:true}};
  denied(()=>authorize(manager,synthetic("hub.synthetic.owner"),"egc",managerRoles),"hub_owner_required");
 });
 it("fails closed for any hub.* command without a policy entry, even when the schema and policy map diverge",()=>{
  for(const actor of [owner,manager,sales])for(const name of ["hub.synthetic.unlisted","hub.dispatch.overview_extra","hub.__proto__","hub.constructor"]){
   denied(()=>authorize(actor,synthetic(name),"egc"),"hub_command_unknown");
   denied(()=>authorize(actor,synthetic(name),"egc",ownerOnly),"hub_command_unknown");
  }
  denied(()=>authorize(owner,synthetic("hub.dispatch.overview"),"egc",{}),"hub_command_unknown");
  denied(()=>authorize(integration,{command:"hub.staff.roster",delegate:"zacb"} as unknown as Command,"egc",{}),"hub_command_unknown");
  expect(()=>authorize(owner,commandSchema.parse({command:"status"}),"egc",{})).not.toThrow();
 });
 it("applies the real policy map: roles, delegate requests and crew refusal",()=>{
  const overview=commandSchema.parse({command:"hub.dispatch.overview"}),roster=commandSchema.parse({command:"hub.staff.roster"});
  for(const actor of [owner,manager])expect(()=>authorize(actor,overview,"egc")).not.toThrow();
  denied(()=>authorize(sales,overview,"egc"),"hub_role_forbidden");
  expect(()=>authorize(sales,roster,"egc")).not.toThrow();
  denied(()=>authorize(integration,roster,"egc"),"hub_delegate_required");
  expect(()=>authorize(integration,commandSchema.parse({command:"hub.staff.roster",delegate:"tylerg"}),"egc")).not.toThrow();
  denied(()=>authorize(owner,commandSchema.parse({command:"hub.staff.roster",delegate:"tylerg"}),"egc"),"hub_delegate_not_allowed");
  for(const role of ["crew","crew_lead"] as const)denied(()=>authorize({...owner,role},roster,"egc"),"role_forbidden");
 });
 it("refuses every integration write and requires explicit confirmation where the policy says so",()=>{
  const write:HubCommandPolicy={write:true,integrationAllowed:false,roles:["owner","manager"],ownerOnly:false,confirmRequired:true,revisioned:false};
  expect(hubCommandDenial(integration,{delegate:"zacb",confirmed:true},{...write,integrationAllowed:true})).toBe("hub_integration_write_forbidden");
  expect(hubCommandDenial(integration,{delegate:"zacb",confirmed:true},write)).toBe("hub_integration_forbidden");
  expect(hubCommandDenial(manager,{},write)).toBe("hub_confirmation_required");
  expect(hubCommandDenial(manager,{confirmed:true},write)).toBeNull();
  expect(hubCommandDenial({...manager,kind:"integration"},{confirmed:true},write)).toBe("hub_integration_forbidden");
 });
});

describe("operations service routes hub commands only to the Hub authority",()=>{
 it("parses, authorizes and forwards a hub read without touching PostgreSQL",async()=>{
  const portalRead=vi.fn(async()=>({ok:true,authority:"employee_hub"}));
  const service=new OperationsService(new Proxy({},{get(){throw new Error("database must not be used");}}) as never,{workspace:"egc",portalRead});
  await expect(service.execute(manager,{command:"hub.dispatch.overview",startDate:"2026-09-22"},randomUUID())).resolves.toEqual({ok:true,authority:"employee_hub"});
  expect(portalRead).toHaveBeenCalledWith(manager,{command:"hub.dispatch.overview",view:"schedule",startDate:"2026-09-22"});
  await expect(service.execute(integration,{command:"hub.staff.roster"},randomUUID())).rejects.toMatchObject({code:"hub_delegate_required",status:403});
  await expect(service.execute(manager,{command:"hub.staff.roster",payRate:1},randomUUID())).rejects.toMatchObject({code:"invalid_command",status:400});
  await expect(service.execute(manager,{command:"hub.staff.roster"},"not-a-uuid")).rejects.toMatchObject({code:"request_id_required"});
  expect(portalRead).toHaveBeenCalledTimes(1);
  await expect(new OperationsService({} as never,{workspace:"egc"}).execute(manager,{command:"hub.staff.roster"},randomUUID())).rejects.toMatchObject({code:"portal_authority_unavailable",status:503});
 });
});
