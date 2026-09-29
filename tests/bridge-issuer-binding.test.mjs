import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BRIDGE_ACTOR_BINDINGS,BRIDGE_COMMAND_POLICY,BRIDGE_SIGNER_PRESENTS,MCP_DELEGATED_PRINCIPAL_PATTERN,bridgeActorIssuer,bridgeIssuerDenial} from '../egc-platform/services/operations/src/bridge-command-policy.ts';
import {SERVICE_ORIGINS,SERVICE_AUTH_KEY_PATHS,servicePublicKeySet,signServiceRequest} from '../egc-platform/services/operations/src/service-auth.ts';
import {bridgeSigner,prepareBridgeCommand} from '../functions/_lib/operations-command-policy.js';
import {HUB_AUDIT_COLLECTION} from '../functions/_lib/hub-audit.js';
import {signOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
import {localInstant} from '../functions/_lib/operations-portal-records.js';
import {PORTAL_COMMANDS,onRequestPost as portal} from '../functions/api/operations-portal.js';
import {onRequestPost as recordings} from '../functions/api/operations-recording-approval.js';
import {firestoreMemory} from './helpers/firestore-memory.mjs';
import {sourceFiles} from './source-files.mjs';

/* BRIDGE-ADOPT-AUTHZ: an integration actor id inside a signed bridge envelope is bound to
 * the service that mints it, checked against the key that signed the envelope. */
const NOW='2026-09-22T07:00:00.000Z';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const apiRoot='synthetic-bridge-adopt-api-root-0123456789abcdef',legacyKey='synthetic-bridge-adopt-legacy-key-0123456789abcdef';
const keys=servicePublicKeySet({service:'api',rootSecret:apiRoot,workspace:'egc'});
const GRANT='mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8',DELEGATED='mcp:zacb:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b';
const actor=id=>({id,kind:'integration',role:'integration',workspace:'egc'});
const v2env={HUB_SESSION_SECRET:'synthetic-bridge-adopt-hub-session-0123456789abc',FIREBASE_API_KEY:'firebase-test-bridge-adopt'};
const legacyEnv={EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_SERVICE_AUTH:'legacy',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:legacyKey,FIREBASE_API_KEY:'firebase-test-bridge-adopt'};
// Integration-only commands: every principal the policy admits is an integration (the list grows with SYNC-QUEUE and RECUR-CRON).
const INTEGRATION_ONLY=Object.entries(BRIDGE_COMMAND_POLICY).filter(([,rule])=>rule.actors.every(a=>a.kind==='integration'&&a.idPattern)).map(([name])=>name);

function hub(t,{failAudit=false}={}){
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const memory=firestoreMemory({fallback:async input=>{assert.equal(String(input),SERVICE_ORIGINS.api+SERVICE_AUTH_KEY_PATHS.api,'Only the API key set is fetched.');return Response.json(await keys);}});
  t.mock.method(globalThis,'fetch',async(input,options={})=>{
    if(failAudit&&new URL(String(input)).pathname.endsWith(':commit')&&String(options.body).includes(`/${HUB_AUDIT_COLLECTION}/`))return Response.json({error:{status:'UNAVAILABLE'}},{status:503});
    return memory.fetch(input,options);
  });
  const docs=prefix=>[...memory.documents.keys()].filter(key=>key.startsWith(prefix+'/'));
  return {memory,audits:(action='bridge.issuer_refused')=>docs(HUB_AUDIT_COLLECTION).map(key=>({key,...memory.get(key)})).filter(row=>!action||row.action===action),writes:()=>memory.commits.flat().map(write=>write.update.name.split('/documents/')[1].split('/')[0])};
}
function envelopeFor(path,principal,body,{legacy=false,requestId=randomUUID()}={}){
  const request={requestId,body};
  return legacy?signOperationsEnvelope({v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:principal,request},legacyKey)
    :signServiceRequest({service:'api',rootSecret:apiRoot,workspace:'egc',path,actor:principal,request});
}
async function post(endpoint,path,envelope,{legacy=false}={}){
  const response=await endpoint({request:new Request(`https://easygaragecleaning.com${path}`,{method:'POST',body:JSON.stringify({envelope})}),env:legacy?legacyEnv:v2env});
  return {status:response.status,body:await response.json()};
}
const signed=async(endpoint,path,principal,body,options={})=>post(endpoint,path,await envelopeFor(path,principal,body,options),options);
const toPortal=(principal,body,options)=>signed(portal,'/api/operations-portal',principal,body,options);

const contactProof=()=>({source:'ghl_appointment',sourceId:'provider-appointment',sourceRevision:'verified-r1',contactProviderId:'provider-contact',providerContact:{id:'provider-contact',name:'Synthetic Customer',phone:'+19705550199',email:'synthetic@example.invalid'},kind:'walkthrough',startAt:'2026-09-22T20:15:00.000Z',endAt:'2026-09-22T20:45:00.000Z',address:'100 Synthetic Lane',title:'Synthetic walkthrough',originalBookingAt:'2026-09-20T16:05:00.000Z',sourceCreatedAt:'2026-09-20T16:05:00.000Z',verifiedAt:NOW,providerAppointmentId:'provider-appointment',providerCalendarId:'walkthrough-calendar',providerStatus:'confirmed',localJobId:null,normalizedLocalAppointmentId:null,evidenceIds:['appointment:provider-appointment']});

// Every object literal in service code that names an integration actor, with the service that runs that code.
// Objects are matched by balanced braces, so a literal with nested objects (the MCP's principalActor spreads
// its delegate) is still found; its own `id:` is read at the object's top level.
function enclosingObject(text,at){
  let depth=0,start=-1;
  for(let i=at;i>=0;i--){const c=text[i];if(c==='}')depth++;else if(c==='{'){if(!depth){start=i;break;}depth--;}}
  if(start<0)return null;
  depth=0;
  for(let i=start;i<text.length;i++){const c=text[i];if(c==='{')depth++;else if(c==='}'&&!--depth)return text.slice(start,i+1);}
  return null;
}
function topLevelId(object){
  let depth=0;
  for(let i=1;i<object.length-1;i++){
    const c=object[i];
    if('{[('.includes(c))depth++;else if('}])'.includes(c))depth--;
    else if(!depth&&/[{,\s]/.test(object[i-1])&&object.startsWith('id:',i)){
      let end=i+3,nested=0;
      for(;end<object.length-1;end++){const d=object[end];if('{[('.includes(d))nested++;else if('}])'.includes(d))nested--;else if(!nested&&d===',')break;}
      return object.slice(i+3,end).trim();
    }
  }
  return null;
}
function mintedIntegrationIds(){
  const service=path=>path.startsWith('functions/')?'hub':path.startsWith('egc-platform/apps/mcp/')?'mcp':path.startsWith('egc-platform/apps/worker/')?'worker':'api';
  const files=[];
  for(const dir of ['functions','egc-platform/apps','egc-platform/services','egc-platform/packages'])for(const entry of sourceFiles(join(ROOT,dir))){
    const path=relative(ROOT,join(entry.parentPath,entry.name)).split(sep).join('/');
    if(/\.(?:[cm]?js|ts)$/.test(path)&&!/\.(?:test|spec|check|browser)\.[cm]?[jt]s$/.test(path)&&!/(?:^|\/)tests?\//.test(path))files.push({path,text:readFileSync(join(ROOT,path),'utf8').replace(/\$\{[^{}]*\}/g,'§')});
  }
  const constants=new Map();
  for(const {text} of files)for(const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;\n]+)?=\s*((["'`])[^"'`\n]*\3|[A-Z][A-Z0-9_]*)\s*[;,\n]/g))constants.set(m[1],m[2]);
  const sample=(expression,depth=0)=>{
    let m;
    if((m=/^(["'`])([^"'`]*)\1$/.exec(expression)))return m[2].replaceAll('§','synthetic-user');
    if((m=/^(["'])([^"']+)\1\s*\+/.exec(expression)))return m[2]+'synthetic-user';
    return /^[A-Z][A-Z0-9_]*$/.test(expression)&&constants.has(expression)&&depth<4?sample(constants.get(expression),depth+1):null;
  };
  const sites=[];
  for(const {path,text} of files)for(const m of text.matchAll(/\bkind:\s*["']integration["']/g)){
    const object=enclosingObject(text,m.index),expression=object&&topLevelId(object);
    if(expression)sites.push({path,service:service(path),expression,id:sample(expression)});
  }
  return sites;
}
// The ids egc-mcp's verifiedMcpPrincipal returns, sampled with a grant uuid and a Hub user.
function mcpPrincipalIds(user){
  const oauth=readFileSync(join(ROOT,'egc-platform/apps/mcp/src/oauth.ts'),'utf8');
  const body=oauth.slice(oauth.indexOf('export async function verifiedMcpPrincipal('),oauth.indexOf('export async function authenticatedMcpPrincipal('));
  const templates=[...body.matchAll(/\{\s*id:\s*(["`])([^"`]*)\1/g)].map(m=>m[2]);
  return {templates,ids:templates.map(template=>template.replaceAll('${record.id}',GRANT.split(':')[1]).replaceAll('${record.principalId}',user))};
}

test('every integration principal the services mint is bound to exactly the service that mints it',()=>{
  const sites=mintedIntegrationIds();
  assert.ok(sites.length>=14,`The scan found the minted actors (${sites.length}).`);
  const dynamic=sites.filter(site=>site.id===null);
  // Two sites name no literal id. The MCP's principalActor takes its id from OAuth (checked below), and the
  // Hub's issuer-refusal audit entry records a refused claim under a placeholder; that actor is never signed.
  assert.deepEqual(dynamic.map(({path,expression})=>`${path}:${expression}`),['functions/_lib/operations-command-policy.js:auditable?claimed:\'unbound-integration\'','egc-platform/apps/mcp/src/server.ts:principal.id']);
  const {templates}=mcpPrincipalIds('zacb');
  assert.deepEqual(templates,['mcp-service-grant','mcp-oauth-grant:${record.id}','mcp:${record.principalId}:${record.id}'],'A new MCP principal shape needs its own bind() line.');
  // A Hub-approved grant's user is exactly what hub-identity.ts admits, so the binding and the MCP agree on it.
  const delegateUser=/export const DELEGATE_USER = \/\^(.+?)\$\/;/.exec(readFileSync(join(ROOT,'egc-platform/apps/mcp/src/oauth/hub-identity.ts'),'utf8'))[1];
  assert.equal(MCP_DELEGATED_PRINCIPAL_PATTERN.source,`^mcp:${delegateUser}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
  for(const user of ['zacb','t','first.last@example.invalid','crew_lead-2','9'+'x'.repeat(119)])
    for(const id of mcpPrincipalIds(user).ids)assert.equal(bridgeActorIssuer(id),'mcp',id);
  // FUN-20: the Garage Guard ledger's hub_audit actor for Stripe webhook writes. It carries role null, so no
  // bridge verifier accepts it (actorSchema and bridgeCommandDenial need role 'integration'), and it is never signed.
  // FUN-33: the same role-less actor on the payment funnel events a Stripe webhook records (customer-payments.js).
  const auditOnly=[['functions/_lib/garage-guard-ledger.js','stripe_webhook'],['functions/_lib/customer-payments.js','stripe_webhook']];
  for(const [path,id] of auditOnly){
    assert.match(readFileSync(join(ROOT,path),'utf8'),new RegExp(`\\{\\s*id:\\s*'${id}',\\s*kind:\\s*'integration',\\s*role:\\s*null\\s*\\}`),`${path} ${id} stays a role-less audit actor`);
    assert.equal(bridgeActorIssuer(id),null,`${id} is not a bridge principal`);
  }
  for(const site of sites.filter(site=>site.id!==null&&!auditOnly.some(([path,id])=>site.path===path&&site.id===id)))assert.equal(bridgeActorIssuer(site.id),site.service,`${site.path} mints ${site.expression}: register it with one bind() line in bridge-command-policy.ts.`);
  // Every integration-only command names a principal some service really mints and the API may present.
  const minted=[...sites.map(site=>site.id).filter(Boolean),...mcpPrincipalIds('zacb').ids];
  for(const name of INTEGRATION_ONLY)for(const rule of BRIDGE_COMMAND_POLICY[name].actors){
    const ids=minted.filter(id=>rule.idPattern.test(id));
    assert.ok(ids.length,`${name} admits ${rule.idPattern}, which no service mints.`);
    for(const id of ids)assert.ok(BRIDGE_SIGNER_PRESENTS.api.includes(bridgeActorIssuer(id)),`${name}: ${id}`);
  }
});

test('the binding table is frozen, anchored and names one service per id; signers present only what they mint or relay',()=>{
  assert.ok(Object.isFrozen(BRIDGE_ACTOR_BINDINGS)&&BRIDGE_ACTOR_BINDINGS.every(Object.isFrozen));
  for(const {idPattern,issuer} of BRIDGE_ACTOR_BINDINGS){
    assert.ok(idPattern.source.startsWith('^')&&idPattern.source.endsWith('$')&&!idPattern.global&&!idPattern.sticky,String(idPattern));
    assert.ok(['api','hub','mcp','worker'].includes(issuer));
  }
  assert.deepEqual(Object.fromEntries(Object.entries(BRIDGE_SIGNER_PRESENTS).map(([k,v])=>[k,[...v]])),{api:['api','mcp','hub'],hub:['hub'],mcp:['mcp']});
  const cases={[GRANT]:'mcp','mcp-service-grant':'mcp','hub-schedule:zacb':'hub','hub-note:tylerg':'hub','schedule-sync:hub-schedule:zacb':'api','schedule-sync:booking-reconciler':'api','note-link:hub-note:tylerg':'api',
    'operations-api':'api','inbound-response-reconciler':'api','booking-reconciler':'api','booking-adoption-worker':'api','post-job-followup':'api','schedule-sync-worker':'api','walkthrough-followup-worker':'api','recurring-horizon-worker':'api','messaging-cron-worker':'worker','ghl-tag-worker':'worker','ghl-tag-worker-2':null,
    [DELEGATED]:'mcp','mcp:first.last@example.invalid:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b':'mcp','mcp:Zacb:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b':null,'mcp:zacb:3B1F7E0A-8D2C-4E5F-9A6B-7C8D9E0F1A2B':null,
    'mcp:zacb:synthetic':null,'mcp::3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b':null,'mcp:a:b:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b':null,[`mcp:${'x'.repeat(121)}:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b`]:null,'walkthrough-followup-worker-2':null,'recurring-horizon-worker-2':null,
    'mcp-oauth-grant:synthetic':null,'mcp-oauth-grant:6BA7B810-9DAD-41D1-80B4-00C04FD430C8':null,'mcp-service-grant:x':null,'booking-adoption-worker-2':null,'schedule-sync-worker-2':null,'stripe_webhook':null,'x-booking-adoption-worker':null,'hub-schedule:':null,'schedule-sync':null,'verified-grant':null,'':null};
  for(const [id,issuer] of Object.entries(cases))assert.equal(bridgeActorIssuer(id),issuer,id);
  for(const id of [undefined,null,42,{}])assert.equal(bridgeActorIssuer(id),null);
  // An id two lines match is as unknown as one no line matches.
  assert.equal(bridgeActorIssuer('booking-reconciler',[...BRIDGE_ACTOR_BINDINGS,{idPattern:/^booking-reconciler$/,issuer:'mcp'}]),null);
  for(const [id,signer,code] of [[GRANT,'mcp',null],[GRANT,'api',null],[GRANT,'hub','bridge_integration_issuer_mismatch'],[DELEGATED,'mcp',null],[DELEGATED,'api',null],[DELEGATED,'hub','bridge_integration_issuer_mismatch'],['walkthrough-followup-worker','api',null],['walkthrough-followup-worker','mcp','bridge_integration_issuer_mismatch'],['hub-note:tylerg','hub',null],['hub-note:tylerg','mcp','bridge_integration_issuer_mismatch'],
    ['booking-adoption-worker','api',null],['booking-adoption-worker','mcp','bridge_integration_issuer_mismatch'],['booking-adoption-worker','hub','bridge_integration_issuer_mismatch'],['booking-adoption-worker',null,'bridge_integration_issuer_mismatch'],
    ['messaging-cron-worker','api','bridge_integration_issuer_mismatch'],['messaging-cron-worker','worker','bridge_integration_issuer_mismatch'],['ghl-tag-worker','api','bridge_integration_issuer_mismatch'],['forged-worker','api','bridge_integration_issuer_unknown']])
    assert.equal(bridgeIssuerDenial(actor(id),signer),code,`${id} via ${signer}`);
  for(const principal of [{id:'zacb',kind:'human',role:'owner'},null,undefined])assert.equal(bridgeIssuerDenial(principal,'mcp'),null,'Humans answer to the role policy.');
});

test('the Hub names the signer only from what it verified: the API v2 key or the legacy egc-portal envelope',async()=>{
  const v2=JSON.parse(Buffer.from((await signServiceRequest({service:'api',rootSecret:apiRoot,workspace:'egc',path:'/api/operations-portal',actor:actor('operations-api'),request:{requestId:randomUUID(),body:{command:'calendar'}},now:Date.parse(NOW)})).split('.')[0],'base64url'));
  assert.equal(bridgeSigner(v2),'api');
  assert.equal(bridgeSigner({v:1,iss:'portal',aud:'egc-portal'}),'api');
  for(const claims of [{...v2,iss:SERVICE_ORIGINS.hub},{...v2,kid:'hub-v2-'+'a'.repeat(32)},{...v2,kid:undefined},{...v2,v:1},{v:1,iss:'portal',aud:'egc-operations'},{v:1,iss:'mcp',aud:'egc-portal'},{},null,undefined])assert.equal(bridgeSigner(claims),null,JSON.stringify(claims));
});

test('integration-only commands run for the service that mints their actor and are refused, with a hub_audit entry, for any other id',async t=>{
  const h=hub(t);
  assert.deepEqual([...INTEGRATION_ONLY].sort().filter(name=>['schedule.adopt','schedule.bind_provider','schedule.link_customer'].includes(name)),['schedule.adopt','schedule.bind_provider','schedule.link_customer']);
  // Refusals first: the egc-worker's own id (signed with the API key it shares) and an id no service mints.
  let refused=0;
  for(const name of INTEGRATION_ONLY){
    assert.ok(PORTAL_COMMANDS.includes(name),name);
    for(const [id,code] of [['messaging-cron-worker','bridge_integration_issuer_mismatch'],['forged-adoption-worker','bridge_integration_issuer_unknown']])for(const legacy of [false,true]){
      // The entry carries the verified envelope's request id (the one the API audits), not the body's.
      const requestId=randomUUID();
      assert.deepEqual(await toPortal(actor(id),{command:name,requestId:randomUUID()},{legacy,requestId}),{status:403,body:{error:code}},`${id} ${name} ${legacy?'legacy':'v2'}`);
      refused++;
      const entry=h.audits().find(row=>row.requestId===requestId);
      assert.ok(entry,`${name}: the refusal is audited under the envelope's request id`);
      assert.deepEqual([entry.action,entry.via,entry.entityKey,entry.actor.id,entry.actor.kind,entry.at,entry.visibility],['bridge.issuer_refused','bridge',`operations_bridge/${name}`,id,'integration',NOW,'business']);
      assert.deepEqual(JSON.parse(entry.after),{code,signer:'api',claimedActor:id,boundTo:id==='messaging-cron-worker'?'worker':null,target:null});
    }
  }
  assert.equal(h.audits().length,refused,'One hub_audit entry per refusal.');
  assert.deepEqual([...new Set(h.writes())].sort(),['hub_audit','operations_service_nonces'],'A refusal writes its audit entry and nothing else.');

  // The right principals pass the binding and reach their libs.
  const adopt={command:'schedule.adopt',requestId:randomUUID(),proof:contactProof()};
  const adopted=await toPortal(actor('booking-adoption-worker'),adopt);
  assert.deepEqual([adopted.status,adopted.body.ok,adopted.body.adopted,adopted.body.contactProviderId],[200,true,true,'provider-contact'],JSON.stringify(adopted.body));
  assert.equal(h.memory.get(`jobs/${adopted.body.jobId}`).highlevelAppointmentId,'provider-appointment');
  h.memory.put('jobs/visit-b',{type:'walkthrough',date:'2026-09-24',time:'09:00',endTime:'10:00',status:'scheduled',phone:'970-555-0102',address:'200 Synthetic Way'});
  const linked=await toPortal(actor('schedule-sync:hub-schedule:zacb'),{command:'schedule.link_customer',portalVisitId:'visit-b',expectedRevision:h.memory.documents.get('jobs/visit-b').updateTime,providerContact:{id:'contact-b',phone:'+19705550102'}});
  assert.deepEqual([linked.status,linked.body.visit?.highlevelContactId],[200,'contact-b'],JSON.stringify(linked.body));
  h.memory.put('customers/customer-c',{name:'Synthetic Customer C',highlevelContactId:'contact-c'});
  h.memory.put('jobs/visit-c',{type:'walkthrough',customerId:'customer-c',highlevelContactId:'contact-c',date:'2026-09-25',time:'10:00',endTime:'11:00',status:'scheduled',address:'300 Synthetic Road'});
  const event={id:'appointment-c',contactId:'contact-c',calendarId:'calendar-c',startTime:localInstant('2026-09-25','10:00'),endTime:localInstant('2026-09-25','11:00'),appointmentStatus:'confirmed'};
  const bound=await toPortal(actor('schedule-sync:booking-reconciler'),{command:'schedule.bind_provider',operationId:randomUUID(),portalVisitId:'visit-c',expectedRevision:h.memory.documents.get('jobs/visit-c').updateTime,event},{legacy:true});
  assert.deepEqual([bound.status,bound.body.providerSync,bound.body.visit?.highlevelAppointmentId],[200,'verified','appointment-c'],JSON.stringify(bound.body));
  // A relayed MCP principal is presentable, so the policy (not the binding) refuses it here.
  assert.deepEqual(await toPortal(actor(GRANT),{...adopt,requestId:randomUUID()}),{status:403,body:{error:'bridge_integration_forbidden'}});
  assert.equal(h.audits().length,refused,'Allowed requests and policy refusals add no issuer refusal entries.');
  assert.deepEqual(h.audits(null).filter(row=>row.action!=='bridge.issuer_refused').map(row=>row.action).sort(),['schedule.adopt','schedule.bind_provider','schedule.link_customer'],'Each allowed write keeps its own SEC-02 audit entry.');
});

test('hub.* reads and the recording bridge bind their integration actors the same way',async t=>{
  const h=hub(t);
  assert.deepEqual(await toPortal(actor('messaging-cron-worker'),{command:'hub.staff.roster',delegate:'zacb'}),{status:403,body:{error:'bridge_integration_issuer_mismatch'}});
  assert.deepEqual(await toPortal(actor('funnel-feed-reader'),{command:'hub.dispatch.overview',delegate:'zacb'},{legacy:true}),{status:403,body:{error:'bridge_integration_issuer_unknown'}});
  // A bound principal reaches the Hub's own delegate check, which still refuses an unconfigured delegate:
  // the MCP's grants (shared-login and Hub-approved) that the API relays, and FUN-37's funnel feed reader.
  for(const [id,command] of [[GRANT,'hub.staff.roster'],[DELEGATED,'hub.staff.roster'],[DELEGATED,'hub.funnel.events'],['walkthrough-followup-worker','hub.walkthrough.outcomes']])
    assert.deepEqual(await toPortal(actor(id),{command,delegate:'zacb'}),{status:403,body:{error:'hub_delegate_unverified'}},`${id} ${command}`);
  const recording=await signed(recordings,'/api/operations-recording-approval',actor('messaging-cron-worker'),{command:'recording.resolve',portalJobId:'visit-a'});
  assert.deepEqual(recording,{status:403,body:{error:'bridge_integration_issuer_mismatch'}});
  assert.deepEqual(h.audits().map(entry=>entry.entityKey).sort(),['operations_bridge/hub.dispatch.overview','operations_bridge/hub.staff.roster','operations_bridge/recording.resolve']);
  // Humans pass to the role policy untouched.
  assert.deepEqual(await toPortal({id:'crew1',kind:'human',role:'crew',workspace:'egc'},{command:'calendar'}),{status:403,body:{error:'bridge_role_forbidden'}});
  assert.equal(h.audits().length,3);
});

test('a lost audit write never admits the request, and an unauditable claim is recorded under a placeholder',async t=>{
  const failed=hub(t,{failAudit:true});
  assert.deepEqual(await toPortal(actor('messaging-cron-worker'),{command:'schedule.adopt',requestId:randomUUID(),proof:contactProof()}),{status:403,body:{error:'bridge_integration_issuer_mismatch'}});
  assert.deepEqual([failed.audits().length,[...new Set(failed.writes())]],[0,['operations_service_nonces']],'Nothing but the nonce receipt was written.');
  t.mock.restoreAll();t.mock.timers.reset();
  const h=hub(t),requestId=randomUUID();
  // A read with no body requestId is still filed under the envelope's.
  assert.deepEqual(await toPortal(actor('-Forged.Worker'),{command:'calendar',startDate:'2026-09-22',endDate:'2026-09-23'},{requestId}),{status:403,body:{error:'bridge_integration_issuer_unknown'}});
  const [entry]=h.audits();
  assert.deepEqual([entry.actor.id,entry.requestId,JSON.parse(entry.after).claimedActor,JSON.parse(entry.after).code],['unbound-integration',requestId,null,'bridge_integration_issuer_unknown']);
});

test('a replayed legacy envelope is refused every time but leaves one audit entry', async t=>{
  const h=hub(t),requestId=randomUUID();
  const envelope=await envelopeFor('/api/operations-portal',actor('forged-adoption-worker'),{command:'hub.staff.roster',delegate:'zacb'},{legacy:true,requestId});
  // The legacy key has no nonce store, so the 60-second window is the only replay bound.
  for(const seconds of [0,1,59]){
    t.mock.timers.setTime(Date.parse(NOW)+seconds*1000);
    assert.deepEqual(await post(portal,'/api/operations-portal',envelope,{legacy:true}),{status:403,body:{error:'bridge_integration_issuer_unknown'}},`replay after ${seconds}s`);
  }
  assert.deepEqual(h.audits().map(entry=>[entry.requestId,entry.at]),[[requestId,NOW]],'One create-only entry, stamped with the envelope\'s signed time.');
});

test('only the signed endpoints bind: direct lib callers pass no claims and keep the policy they always had',async()=>{
  const bridge=await prepareBridgeCommand({},actor('forged-worker'),{command:'portal.job',jobId:'job-a'},{hub:true,now:NOW});
  assert.deepEqual([bridge.rule.kind,bridge.via],['read','bridge']);
  const records=[];
  const refuse=claims=>assert.rejects(prepareBridgeCommand({},actor('forged-worker'),{command:'portal.job',jobId:'job-a',requestId:randomUUID()},{hub:true,now:NOW,claims,recordRefusal:async entry=>{records.push(entry);}}),
    error=>error.code==='bridge_integration_issuer_unknown'&&error.status===403&&error.message==='bridge_integration_issuer_unknown');
  // Claims without a request id or signed time fall back to no request id and the injected clock.
  await refuse({v:1,iss:'portal',aud:'egc-portal'});
  assert.deepEqual([records.length,records[0].collection,records[0].patch.action,records[0].patch.requestId,records[0].patch.at],[1,HUB_AUDIT_COLLECTION,'bridge.issuer_refused',null,NOW]);
  // Verified claims name the entry: the envelope's request id and signed time, never the body's id, so the same envelope gives the same entry id.
  const requestId=randomUUID(),iat=Date.parse(NOW)/1000-30,claims={v:1,iss:'portal',aud:'egc-portal',iat,request:{requestId,body:{}}};
  for(let i=0;i<2;i++)await refuse(claims);
  await refuse({...claims,request:{requestId:'not-a-uuid',body:{}}});
  assert.deepEqual(records.slice(1).map(entry=>[entry.patch.requestId,entry.patch.at]),[[requestId,'2026-09-22T06:59:30.000Z'],[requestId,'2026-09-22T06:59:30.000Z'],[null,'2026-09-22T06:59:30.000Z']]);
  assert.equal(records[1].id,records[2].id);assert.notEqual(records[1].id,records[3].id);
  // The endpoints hand prepareBridgeCommand their verified claims (security invariant).
  for(const file of ['../functions/api/operations-portal.js','../functions/api/operations-recording-approval.js'])
    assert.match(readFileSync(new URL(file,import.meta.url),'utf8'),/await prepareBridgeCommand\(env,c\.actor,c\.request\.body,\{[^}]*\bclaims:c\}\)/,file);
});
