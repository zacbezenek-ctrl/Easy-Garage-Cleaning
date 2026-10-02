import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Express} from 'express';
import {blockedToolCall,directSendsBlocked,operationsPrincipal,DIRECT_SEND_TOOLS,LEGACY_MUTATIONS_DISABLED} from '../src/operations.js';
import {accessStatement,authenticatedMcpPrincipal,registerOauthRoutes,READ_SCOPE,WRITE_SCOPE,type AccessMode} from '../src/oauth.js';
import {buildServer} from '../src/server.js';
import {memoryOAuthStore} from './oauth-memory-store.js';

const env={...process.env};
beforeEach(()=>{for(const key of ['EGC_OPERATIONS_ENABLED','EGC_MCP_DIRECT_SENDS_ENABLED','MCP_BEARER_WRITE_ENABLED','MCP_PUBLIC_ORIGIN','DATABASE_URL'])delete process.env[key];});
afterEach(()=>{process.env={...env};});
const SEND_TOOLS=['conversations.send_message','send_sms','egc.send_followup'];
const actor={id:'mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',role:'integration' as const,kind:'integration' as const,workspace:'egc'};
const CONTACT='ac178de9-8156-42b8-818c-83e21c12c099',REQUEST='3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70';
const html=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const sendArgs={requestId:REQUEST,contactId:CONTACT,channel:'SMS',body:'Synthetic authorized message',contextReviewed:true,duplicateWindowMinutes:10};

describe('one-step customer sends in operations mode',()=>{
  it('are allowed in legacy mode, blocked in operations mode by default, and re-enabled only by the explicit flag',()=>{
    expect([...DIRECT_SEND_TOOLS].sort()).toEqual([...SEND_TOOLS].sort());
    for(const name of SEND_TOOLS)expect(blockedToolCall(name)).toBeNull();
    process.env.EGC_OPERATIONS_ENABLED='true';
    // Approval alone never sends; direct-send guidance points to the separately enabled reviewed Hub action without claiming a live capability.
    for(const name of SEND_TOOLS)expect(blockedToolCall(name)).toMatchObject({error:'direct_send_disabled_in_operations_mode',sent:false,instruction:expect.stringMatching(/^Nothing was sent\. .*actions\.propose \(kind followup_message\).*approval does not send\..*server reports actionSend enabled.*do not bypass this gate.*has not been sent\.$/s)});
    expect(blockedToolCall('send_sms')!.instruction).not.toMatch(/sends? (?:it|them) from the Employee Hub/);
    expect(directSendsBlocked()).toBe(true);
    for(const name of ['actions.propose','communications.reconcile','contacts.search'])expect(blockedToolCall(name)).toBeNull();
    for(const name of LEGACY_MUTATIONS_DISABLED)expect(blockedToolCall(name)?.error).toBe('legacy_mutation_disabled_in_operations_mode');
    process.env.EGC_MCP_DIRECT_SENDS_ENABLED='yes';expect(blockedToolCall('send_sms')).not.toBeNull();
    process.env.EGC_MCP_DIRECT_SENDS_ENABLED='true';for(const name of SEND_TOOLS)expect(blockedToolCall(name)).toBeNull();
    expect(blockedToolCall('appointments.delete')?.error).toBe('legacy_mutation_disabled_in_operations_mode');
  });
  it('the registered send handlers refuse before any database or provider access even if the HTTP guard is bypassed',async()=>{
    process.env.EGC_OPERATIONS_ENABLED='true';
    const tools=(buildServer() as unknown as {_registeredTools:Record<string,{handler:(args:unknown)=>Promise<any>}>})._registeredTools;
    for(const name of SEND_TOOLS){
      const r=await operationsPrincipal.run(actor,()=>tools[name]!.handler(sendArgs));
      expect(r.structuredContent.result,name).toMatchObject({ok:false,error:'direct_send_disabled_in_operations_mode',sent:false});
    }
    // With the flag on the same handler proceeds to its next step, which here is the (absent) database.
    process.env.EGC_MCP_DIRECT_SENDS_ENABLED='true';
    await expect(operationsPrincipal.run(actor,()=>tools.send_sms!.handler(sendArgs))).rejects.toThrow('DATABASE_URL is required');
  });
});

describe('static MCP_BEARER_TOKEN grant',()=>{
  const token='isolated-static-bearer-credential-never-production-0123456789';
  it('is read-only unless MCP_BEARER_WRITE_ENABLED=true',async()=>{
    process.env.MCP_BEARER_TOKEN=token;
    expect(await authenticatedMcpPrincipal(`Bearer ${token}`,READ_SCOPE)).toBe('mcp-service-grant');
    expect(await authenticatedMcpPrincipal(`Bearer ${token}`,WRITE_SCOPE)).toBeNull();
    process.env.MCP_BEARER_WRITE_ENABLED='1';expect(await authenticatedMcpPrincipal(`Bearer ${token}`,WRITE_SCOPE)).toBeNull();
    process.env.MCP_BEARER_WRITE_ENABLED='true';expect(await authenticatedMcpPrincipal(`Bearer ${token}`,WRITE_SCOPE)).toBe('mcp-service-grant');
  });
});

describe('consent text, /mcp-info and audit identity are truthful',()=>{
  const modes:Record<string,AccessMode>={legacy:{operations:false,directSends:false,moneyTools:false},actionCenter:{operations:true,directSends:false,moneyTools:false},actionCenterSends:{operations:true,directSends:true,moneyTools:false}};
  it('describes sends, writes, approvals and payments from the live mode',()=>{
    expect(accessStatement(modes.legacy!).sends).toMatch(/can send SMS and email to customers/);
    expect(accessStatement(modes.actionCenter!).sends).toMatch(/One-step MCP customer sends are paused.*approval does not send.*server reports actionSend enabled/s);
    for(const mode of Object.values(modes))expect(Object.values(accessStatement(mode)).join(' ')).not.toMatch(/sends? (?:it|them) from the Employee Hub/);
    expect(accessStatement(modes.actionCenterSends!).sends).toMatch(/can send SMS and email to customers/);
    for(const mode of Object.values(modes))expect(accessStatement(mode).sends).toMatch(/notifications only when runAutomations is explicitly set to true/);
    expect(accessStatement(modes.legacy!).write).toMatch(/delete provider appointments/);
    expect(accessStatement(modes.actionCenter!).write).toMatch(/Legacy job, task and walkthrough-draft writes and appointment deletion are disabled/);
    expect(accessStatement(modes.legacy!).write).toMatch(/action writes need Action Center mode and are not active/);
    expect(accessStatement(modes.actionCenter!).approvals).toMatch(/cannot approve/);
    expect(accessStatement(modes.legacy!).approvals).toMatch(/legacy walkthrough drafts can be approved here/);
    expect(accessStatement(modes.legacy!).payments).toBe('No payment, charge or refund tool is provided.');
    expect(accessStatement({...modes.legacy!,moneyTools:true}).payments).toMatch(/explicit confirmation/);
  });
  function routes(mode:AccessMode){
    const handlers=new Map<string,(req:any,res:any)=>unknown>();
    const app={get:(path:string,...fns:any[])=>handlers.set(`GET ${path}`,fns.at(-1)),post:(path:string,...fns:any[])=>handlers.set(`POST ${path}`,fns.at(-1))} as unknown as Express;
    // The password POST records a lockout attempt first; without a database the Postgres store fails closed (503), so inject the in-memory store.
    registerOauthRoutes(app,()=>mode,{store:memoryOAuthStore().store});
    const call=async(key:string,req:Record<string,unknown>={})=>{const res:any={statusCode:200,headers:{},body:''};Object.assign(res,{status:(c:number)=>(res.statusCode=c,res),set:(k:string,v:string)=>(res.headers[k]=v,res),type:(t:string)=>(res.headers['content-type']=t,res),send:(b:string)=>(res.body=b,res),json:(b:unknown)=>(res.body=JSON.stringify(b),res)});await handlers.get(key)!({query:{},body:{},...req},res);return res;};
    return call;
  }
  const authorize={client_id:'https://chatgpt.com/oauth/client.json',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',response_type:'code',code_challenge:'synthetic-challenge',code_challenge_method:'S256',resource:'http://localhost:4200',scope:'egc:read egc:write'};
  it('/mcp-info no longer claims read-only and states the current send policy',async()=>{
    const info=await routes(modes.actionCenter!)('GET /mcp-info');
    expect(info.body).toMatch(/egc:read.*egc:write/);expect(info.body).not.toMatch(/read-only MCP/);
    expect(info.body).toContain(accessStatement(modes.actionCenter!).sends);expect(info.headers['Cache-Control']).toBe('no-store');
    expect((await routes(modes.legacy!)('GET /mcp-info')).body).toContain(accessStatement(modes.legacy!).sends);
  });
  it('the consent page shows the statement for the live mode on every render',async()=>{
    for(const mode of Object.values(modes)){
      const page=await routes(mode)('GET /oauth/authorize',{query:authorize});
      expect(page.statusCode).toBe(200);for(const line of Object.values(accessStatement(mode)))expect(page.body).toContain(html(line));
      expect(page.body).not.toMatch(/legacy sends and destructive booking deletion are blocked/);
    }
    const denied=await routes(modes.actionCenter!)('POST /oauth/authorize',{body:{...authorize,username:'x',password:'y'}});
    expect(denied.statusCode).toBe(401);expect(denied.body).toContain(html(accessStatement(modes.actionCenter!).sends));
  });
  // Every registered write tool must be described by the consent text for the mode it is live in. A new write tool fails here until it is.
  const ACTIONS=/can change internal actions/,HUB_ONLY=null;
  const WRITE_COVERAGE:Record<string,[actionCenter:RegExp,legacy:RegExp|null]>={
    'actions.propose':[ACTIONS,HUB_ONLY],'actions.edit':[ACTIONS,HUB_ONLY],'actions.snooze':[ACTIONS,HUB_ONLY],'actions.complete':[ACTIONS,HUB_ONLY],'actions.cancel':[ACTIONS,HUB_ONLY],'actions.reconcile_inbound':[ACTIONS,HUB_ONLY],'actions.complete_from_message':[ACTIONS,HUB_ONLY],
    'egc.generate_brief':[/save daily-brief snapshots/,HUB_ONLY],'egc.add_job_note':[/exact Employee Hub notes/,HUB_ONLY],'egc.schedule_visit':[/visit schedules/,HUB_ONLY],
    'egc.update_job_operations':[/job operational scope and dispatched, in-progress or completed status/,HUB_ONLY],'egc.link_project':[/project links/,HUB_ONLY],'recordings.retry':[/retry recording processing/,HUB_ONLY],
    'contacts.create':[/contacts, tags/,/contacts, tags/],'contacts.update':[/contacts, tags/,/contacts, tags/],'contacts.add_tags':[/contacts, tags/,/contacts, tags/],'contacts.remove_tags':[/contacts, tags/,/contacts, tags/],
    'opportunities.create':[/opportunities/,/opportunities/],'opportunities.update':[/opportunities/,/opportunities/],
    'egc.reconcile_customer_state':[/reconcile customer state/,/reconcile customer state/],'egc.record_user_confirmed_outcome':[/record user-confirmed outcomes/,/record user-confirmed outcomes/],
    'communications.reconcile':[/reconcile message delivery status/,/reconcile message delivery status/],
    'appointments.create':[/create, update, cancel and reconcile provider appointments/,/create, reschedule, cancel, reconcile or delete provider appointments/],
    'appointments.update':[/create, update, cancel and reconcile provider appointments/,/create, reschedule, cancel, reconcile or delete provider appointments/],
    'appointments.cancel':[/create, update, cancel and reconcile provider appointments/,/create, reschedule, cancel, reconcile or delete provider appointments/],
    'appointments.reconcile':[/create, update, cancel and reconcile provider appointments/,/create, reschedule, cancel, reconcile or delete provider appointments/],
    'egc.ensure_booking':[/create, update, cancel and reconcile provider appointments/,/create, reschedule, cancel, reconcile or delete provider appointments/],
    'appointments.delete':[/appointment deletion are disabled/,/or delete provider appointments/],
    'meta.conversions.sync':[/sync conversion events to Meta/,/sync conversion events to Meta/],'meta.conversions.retry':[/sync conversion events to Meta/,/sync conversion events to Meta/],'meta.conversions.test':[/sync conversion events to Meta/,/sync conversion events to Meta/],
    'jobs.create':[/Legacy job, task/,/jobs, notes/],'jobs.update':[/Legacy job, task/,/jobs, notes/],'jobs.add_note':[/Legacy job, task/,/jobs, notes/],
    'tasks.create':[/Legacy job, task/,/internal tasks/],'tasks.update':[/Legacy job, task/,/internal tasks/],'tasks.complete':[/Legacy job, task/,/internal tasks/],
    'walkthroughs.create_draft':[/walkthrough-draft writes/,/walkthrough drafts;/],'walkthroughs.update_draft':[/walkthrough-draft writes/,/walkthrough drafts;/],'walkthroughs.approve':[/walkthrough-draft writes/,/legacy walkthrough drafts can be approved here/],
    'conversations.send_message':[/One-step MCP customer sends are paused/,/can send SMS and email to customers/],'send_sms':[/One-step MCP customer sends are paused/,/can send SMS and email to customers/],'egc.send_followup':[/One-step MCP customer sends are paused/,/can send SMS and email to customers/]
  };
  it.each([true,false])('covers every registered write tool in the live statement (operations=%s)',async operations=>{
    if(operations)process.env.EGC_OPERATIONS_ENABLED='true';
    const tools=(buildServer() as unknown as {_registeredTools:Record<string,{annotations:{readOnlyHint:boolean};handler:(args:unknown)=>Promise<any>}>})._registeredTools;
    const writes=Object.entries(tools).filter(([,tool])=>tool.annotations.readOnlyHint===false).map(([name])=>name);
    expect(writes.length).toBeGreaterThan(30);
    const access=accessStatement(operations?modes.actionCenter!:modes.legacy!),text=[access.write,access.sends,access.approvals].join(' ');
    for(const name of writes){
      expect(WRITE_COVERAGE[name],`${name} has no access-statement category`).toBeDefined();
      const [actionCenter,legacy]=WRITE_COVERAGE[name]!,expected=operations?actionCenter:legacy??/Employee Hub record, schedule, project, recording and action writes need Action Center mode and are not active/;
      expect(text,name).toMatch(expected);
      // Hub-only writes really are inert in legacy mode (complete_from_message reads the ledger before its Hub call).
      if(!operations&&legacy===HUB_ONLY&&name!=='actions.complete_from_message')
        expect((await operationsPrincipal.run(actor,()=>tools[name]!.handler({requestId:REQUEST}))).structuredContent.result.error,name).toBe('operations_not_enabled');
    }
  });
  it('audit rows are attributed to the verified principal, never a fixed client label',()=>{
    // Pinned security invariant; test/safety-postgres.check.mjs verifies the persisted rows.
    const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
    expect(source).not.toMatch(/chatgpt-mcp/);
    expect(source).toMatch(/const auditActor=\(\)=>operationsPrincipal\.getStore\(\)\?\.id\?\?"unverified";/);
    expect(source.match(/actor:\s*"[^"]*"/g)??[]).toEqual([]);
  });
});
