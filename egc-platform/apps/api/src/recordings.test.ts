import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {walkthroughExtractionSchema} from '@egc/schemas';
import {conversationExtractionSchema} from '@egc/ai';
import {servicePublicKeySet,signServiceRequest,verifyServiceRequest} from '@egc/operations';
import {fingerprint,MAX_MANUAL_REVIEW_BYTES,MAX_TRANSCRIPT_BYTES,signRecordingEnvelope,verifyRecordingEnvelope,stableUuid,type RecordingClaims} from './recording-contracts.js';
import {registerRecordingRoutes,RecordingService} from './recordings.js';
import {tokenVersion} from './service-bridge.js';
const key='isolated-recording-signing-test-only-0123456789';
const claims=():RecordingClaims=>({v:1,iss:'portal',aud:'egc-recordings',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:{id:'test-owner',role:'owner',kind:'human',workspace:'egc'},request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:randomUUID()}}});
const apps:ReturnType<typeof Fastify>[]=[];afterEach(async()=>{for(const a of apps.splice(0))await a.close();});
describe('recording authentication and request contracts',()=>{
it('binds the exact actor, payload, workspace and audience',()=>{const c=claims();expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toEqual(c);expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'other')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,aud:'egc-operations'},key),key,'egc')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key+'wrong','egc')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,iat:c.iat-120},key),key,'egc')).toThrow();});
it('sales can read but only human owners/managers can approve',()=>{const c=claims();c.actor.role='sales';expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc').actor.role).toBe('sales');c.request.body={command:'recording.approve',recordingId:randomUUID(),revision:new Date().toISOString(),extraction:walkthroughExtractionSchema.parse({}),actions:[]};expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow('human_manager_approval_required');c.actor={...c.actor,kind:'integration',role:'integration'};expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow();});
it('manual follow-up approval is signed and manager-only',()=>{
  const c=claims();c.actor.role='sales';c.request.body={command:'recording.review_manual_tasks',recordingId:randomUUID(),revision:new Date().toISOString(),confirm:true,actions:[{title:'Call back',description:'Call about access',kind:'manual',priority:'medium',assignedUserId:'test-owner',dueAt:'2026-09-30T15:00:00Z',timeZone:'America/Denver',waitingOn:'none',reviewAt:null,portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',contactId:null,jobId:null,completionCondition:'Record the outcome',sourceEvidence:[{source:'recording',id:randomUUID(),excerpt:'Call me about access'}],dependencies:[],draft:null}]};
  expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow('human_manager_approval_required');
  c.actor.role='manager';expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc').request.body.command).toBe('recording.review_manual_tasks');
  const action=c.request.body.command==='recording.review_manual_tasks'?c.request.body.actions[0]!:null;
  const oversized={...c,request:{...c.request,body:{...c.request.body,actions:Array.from({length:30},()=>({...action,description:'x'.repeat(5000),sourceEvidence:[{source:'recording',id:randomUUID(),excerpt:'q'.repeat(2000)}]}))}}};
  expect(Buffer.byteLength(JSON.stringify(oversized.request.body),'utf8')).toBeGreaterThan(MAX_MANUAL_REVIEW_BYTES);
  expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(oversized,key),key,'egc')).toThrow('invalid_recording_request');
  c.iss='mcp';c.actor={...c.actor,id:'mcp-service-grant',kind:'integration',role:'integration'};expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow();
});
it('stable logical IDs and canonical fingerprints resist key ordering',()=>{expect(stableUuid('one')).toBe(stableUuid('one'));expect(stableUuid('one')).not.toBe(stableUuid('two'));expect(fingerprint({a:1,b:2})).toBe(fingerprint({b:2,a:1}));expect(fingerprint({a:1})).not.toBe(fingerprint({a:2}));});
it('proposals require source evidence and do not invent deadlines or owners',()=>{const extraction=walkthroughExtractionSchema.parse({proposedActions:[{title:'Call back',kind:'callback',commitment:'Call about timing',sourceQuote:'I will call you about timing',ownerMention:null,dueMention:null,confidence:0.9}]});expect(extraction.proposedActions[0]?.ownerMention).toBeNull();expect(()=>walkthroughExtractionSchema.parse({proposedActions:[{title:'Guessed task'}]})).toThrow();expect(walkthroughExtractionSchema.parse({}).proposedActions).toEqual([]);});
it('allows a signed sales transcript, refuses integrations and unsafe source filenames, and keeps approval manager-only',()=>{
  const c=claims();c.actor.role='sales';c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:'Customer: Please call me back.',filename:'walkthrough.vtt'};
  expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc').request.body).toEqual(c.request.body);
  expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,actor:{...c.actor,kind:'integration',role:'integration'}},key),key,'egc')).toThrow();
  const integrationRead={...c,iss:'mcp' as const,actor:{...c.actor,id:'mcp-service-grant',kind:'integration' as const,role:'integration' as const},request:{...c.request,body:{command:'recording.get' as const,recordingId:randomUUID()}}};
  expect(verifyRecordingEnvelope(signRecordingEnvelope(integrationRead,key),key,'egc').request.body.command).toBe('recording.get');
  expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,request:{...c.request,body:{...c.request.body,filename:'../other.txt'}}},key),key,'egc')).toThrow('invalid_recording_request');
  expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,request:{...c.request,body:{command:'recording.approve',recordingId:randomUUID(),revision:new Date().toISOString(),extraction:walkthroughExtractionSchema.parse({}),actions:[]}}},key),key,'egc')).toThrow('human_manager_approval_required');
});
});
describe('recording HTTP boundary',()=>{
async function setup(enabled=true){const app=Fastify();apps.push(app);await app.register(multipart);const execute=vi.fn(async()=>({ok:true})),processNext=vi.fn(async()=>false),upload=vi.fn();await registerRecordingRoutes(app,{EGC_OPERATIONS_ENABLED:String(enabled),EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key},{execute,processNext,upload}as unknown as RecordingService);return{app,execute,upload};}
it('unsigned request never reaches recording service',async()=>{const{app,execute}=await setup();const r=await app.inject({method:'POST',url:'/recordings/rpc',payload:{envelope:'bad'}});expect(r.statusCode).toBe(401);expect(execute).not.toHaveBeenCalled();});
it('disabled service is a truthful503 and leaks no signing configuration',async()=>{const{app,execute}=await setup(false);const r=await app.inject({method:'POST',url:'/recordings/rpc',payload:{}});expect(r.statusCode).toBe(503);expect(r.json().error).toBe('operations_not_enabled');expect(r.body).not.toContain(key);expect(execute).not.toHaveBeenCalled();});
it('verified Hub identity is passed through; server failures redact PII and secrets',async()=>{const{app,execute}=await setup(),c=claims();const good=await app.inject({method:'POST',url:'/recordings/rpc',payload:{envelope:signRecordingEnvelope(c,key),actor:{id:'forged'}}});expect(good.statusCode).toBe(200);expect(execute).toHaveBeenCalledWith(c);execute.mockRejectedValue(new Error('private customer content access_token=secret'));const failure=await app.inject({method:'POST',url:'/recordings/rpc',payload:{envelope:signRecordingEnvelope(c,key)}});expect(failure.statusCode).toBe(503);expect(failure.body).not.toMatch(/private|access_token|secret/);});
it('dispatches a verified text transcript through the existing RPC boundary',async()=>{const{app,execute}=await setup(),c=claims();c.actor.role='sales';c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:'Customer: Keep the shelves.',filename:'visit.srt'};const r=await app.inject({method:'POST',url:'/recordings/rpc',payload:{envelope:signRecordingEnvelope(c,key)}});expect(r.statusCode).toBe(200);expect(execute).toHaveBeenCalledWith(c);});
it('accepts an 80 KB transcript containing JSON escape characters in its signed envelope',async()=>{const{app,execute}=await setup(),c=claims();c.actor.role='sales';c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:'\\'.repeat(MAX_TRANSCRIPT_BYTES)};const envelope=signRecordingEnvelope(c,key);expect(envelope.length).toBeLessThan(650_000);const r=await app.inject({method:'POST',url:'/recordings/rpc',payload:{envelope}});expect(r.statusCode).toBe(200);expect(execute).toHaveBeenCalledWith(c);});
it('accepts a maximally escaped transcript through the v2 signed service protocol',async()=>{
  const c=claims();c.actor.role='sales';c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:'\\'.repeat(MAX_TRANSCRIPT_BYTES)};
  const options={service:'hub' as const,rootSecret:key,workspace:'egc',path:'/recordings/rpc',actor:c.actor,request:c.request};
  const envelope=await signServiceRequest(options),keys=await servicePublicKeySet(options);
  expect(envelope.length).toBeGreaterThan(200_000);expect(envelope.length).toBeLessThan(650_000);
  expect(tokenVersion(envelope,650_000)).toBe(2);
  const verified=await verifyServiceRequest(envelope,{service:'api',workspace:'egc',path:'/recordings/rpc',resolveKey:async()=>keys.keys[0]!,consumeNonce:async()=>true});
  expect(verified.request.body).toEqual(c.request.body);
  await expect(signServiceRequest({...options,path:'/operations/rpc'})).rejects.toThrow('service_request_too_large');
});
});

describe('durable text transcript intake',()=>{
  function setupService(){
    let row:Record<string,unknown>|null=null,sourceCustomer='customer-synthetic',sourceProject:string|null=null,sourceRevision='source-v1';
    const select=()=>{const chain={from:()=>chain,where:()=>chain,orderBy:()=>chain,limit:()=>chain,offset:async()=>row?[row]:[],for:async()=>row?[row]:[],then:(resolve:(value:unknown[])=>unknown)=>Promise.resolve(row?[row]:[]).then(resolve)};return chain;};
    const db={select,insert:()=>({values:(values:Record<string,unknown>)=>({onConflictDoNothing:async()=>{if(!row)row={attemptCount:0,extraction:null,createdAt:new Date('2026-09-29T12:00:00.000Z'),updatedAt:new Date('2026-09-29T12:00:00.000Z'),...values};}})}),update:()=>({set:(values:Record<string,unknown>)=>{const result={where:()=>result,returning:async()=>{row={...row,...values};return[row];},then:(resolve:(value:unknown)=>unknown)=>{row={...row,...values};return Promise.resolve(undefined).then(resolve);}};return result;}}),transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn(db)};
    const io={put:vi.fn(),get:vi.fn(),transcribe:vi.fn(),extract:vi.fn(),createManualTask:vi.fn(async(_actor:unknown,_task:unknown,_requestId:string)=>({ok:true})),createReviewedTask:vi.fn(async(_actor:unknown,_task:unknown,_requestId:string)=>({ok:true})),catalog:vi.fn(()=>({items:[],catalogVersion:'synthetic'})),conversation:vi.fn(async(_text:string,options:{context:{sourceKind:'visit_recording'|'visit_transcript';occurredAt:string}})=>({ok:true,extraction:conversationExtractionSchema.parse({version:2,sourceKind:options.context.sourceKind,occurredAt:options.context.occurredAt,model:'synthetic',catalogVersion:'synthetic',scope:null,proposedActions:[],catalogMentions:[],preferences:[],validation:{droppedProposedActions:0,droppedCatalogMentions:0,droppedPreferences:0,droppedEvidence:0,clearedCatalogItemIds:0,clearedMentions:0,clearedDraftSuggestions:0}})}))};
    const portalCommands:string[]=[];let onMembersRead:(()=>void)|null=null,onJobRead:(()=>void)|null=null,onApply:(()=>void)|null=null;
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      const envelope=JSON.parse(String(init?.body)).envelope as string,command=JSON.parse(Buffer.from(envelope.split('.')[0]!,'base64url').toString()).request.body.command as string;
      portalCommands.push(command);
      if(String(url).includes('/api/operations-portal')){
        if(command==='portal.members'){onMembersRead?.();return Response.json({authority:'employee_hub',members:[{id:'test-owner'}]});}
        if(command==='portal.job'){onJobRead?.();return Response.json({authority:'employee_hub',job:{id:'visit-synthetic',revision:sourceRevision,type:'walkthrough',highlevelContactId:null,sourceWalkthroughId:null,customer:'Synthetic customer',status:'active'}});}
      }
      if(command==='recording.apply'){onApply?.();return Response.json({ok:true});}
      return Response.json({identity:{authority:'employee_hub',portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',portalCustomerId:sourceCustomer,portalProjectId:sourceProject,portalRevision:sourceRevision,highlevelContactId:null}});
    });
    const service=new RecordingService({EGC_OPERATIONS_WORKSPACE:'egc',EGC_PORTAL_ORIGIN:'https://synthetic.invalid',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key,EGC_EXTRACTION_V2:'false'},db as never,fetcher,io as never);
    return{service,io,fetcher,portalCommands,get row(){return row;},changeRow:(values:Record<string,unknown>)=>{row={...row,...values};},changeCustomer:(value:string)=>{sourceCustomer=value;sourceRevision='source-v3';},linkProject:(value:string)=>{sourceProject=value;sourceRevision='source-v2';},onMembersRead:(fn:()=>void)=>{onMembersRead=fn;},onJobRead:(fn:()=>void)=>{onJobRead=fn;},onApply:(fn:()=>void)=>{onApply=fn;}};
  }
  const transcript=(text='Customer: Keep the shelves.',requestId:string=randomUUID())=>{const c=claims();c.actor.role='sales';c.request.requestId=requestId;c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:text,filename:'visit.srt'};return c;};
  const manualTask=(recordingId:string)=>({title:'Call the customer',description:'Confirm access with the customer.',kind:'manual' as const,priority:'medium' as const,assignedUserId:'test-owner',dueAt:'2026-09-30T15:00:00Z',timeZone:'America/Denver',waitingOn:'none' as const,reviewAt:null,portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',contactId:null,jobId:null,completionCondition:'Record the outcome in the job notes.',sourceEvidence:[{source:'recording' as const,id:recordingId,excerpt:'Please call me about access.'}],dependencies:[],draft:null});
  const reviewedApproval=(c:RecordingClaims,recordingId:string,revision:string,actions:ReturnType<typeof manualTask>[]):RecordingClaims=>({...c,actor:{...c.actor,role:'owner'},request:{requestId:randomUUID(),body:{command:'recording.approve',recordingId,revision,extraction:walkthroughExtractionSchema.parse({}),actions}}});
  it('stores exact text once, rejects changed replays, and processes without touching audio',async()=>{
    const {service,io}=setupService(),c=transcript('00:00:01 --> 00:00:02\nCustomer: Keep the shelves.');
    const first=await service.saveTranscript(c);expect(first.recording).toMatchObject({status:'uploaded',sourceKind:'transcript',sourceFilename:'visit.srt',transcript:c.request.body.command==='recording.transcript'?c.request.body.transcript:null});
    expect(first.recording).not.toHaveProperty('audioObjectKey');
    const again=await service.saveTranscript(c);expect(again).toMatchObject({ok:true,alreadySaved:true,recording:{id:first.recording.id}});
    await expect(service.saveTranscript(transcript('Customer: Remove the shelves.',c.request.requestId))).rejects.toThrow('recording_upload_request_conflict');
    expect(await service.processNext()).toBe(true);
    expect(io.get).not.toHaveBeenCalled();expect(io.transcribe).not.toHaveBeenCalled();expect(io.put).not.toHaveBeenCalled();
    expect(io.conversation).toHaveBeenCalledWith(c.request.body.command==='recording.transcript'?c.request.body.transcript:null,expect.objectContaining({context:{sourceKind:'visit_transcript',occurredAt:'2026-09-29T12:00:00.000Z'}}));
    const draft=await service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}});expect(draft).toMatchObject({recording:{status:'draft',sourceKind:'transcript',extractionVersion:2,conversation:{sourceKind:'visit_transcript'}}});
  });
  it('checks UTF-8 bytes and current visit identity before every replay or read',async()=>{
    const fixture=setupService(),c=transcript();
    await expect(fixture.service.execute(transcript('é'.repeat(MAX_TRANSCRIPT_BYTES/2+1)))).rejects.toThrow('recording_transcript_size_invalid');
    await expect(fixture.service.execute(transcript(' \n\t '))).rejects.toThrow('recording_transcript_invalid');
    const first=await fixture.service.saveTranscript(c);fixture.changeCustomer('different-customer');
    await expect(fixture.service.execute(c)).rejects.toThrow('recording_identity_changed');
    await expect(fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}})).rejects.toThrow('recording_identity_changed');
    await expect(fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.retry',recordingId:first.recording.id}}})).rejects.toThrow('recording_identity_changed');
    await expect(fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.list',portalJobId:'visit-synthetic',offset:0}}})).rejects.toThrow('recording_identity_changed');
  });
  it('lets a manager refresh a newly linked project without losing the visit or accepting a different customer',async()=>{
    const fixture=setupService(),c=transcript('Customer: Keep the bicycle.');
    const first=await fixture.service.saveTranscript(c);
    expect(await fixture.service.processNext()).toBe(true);
    fixture.linkProject('project-synthetic');
    const getClaims={...c,request:{requestId:randomUUID(),body:{command:'recording.get' as const,recordingId:first.recording.id}}};
    const before=await fixture.service.execute(getClaims);
    expect(before.recording).toMatchObject({status:'draft',portalProjectId:null,portalRevision:'source-v1'});
    const listed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.list',portalJobId:'visit-synthetic',offset:0}}});
    expect(listed).toMatchObject({recordings:[{id:first.recording.id}]});
    const manager={...c,actor:{...c.actor,role:'manager' as const},request:{requestId:randomUUID(),body:{command:'recording.refresh_source' as const,recordingId:first.recording.id}}};
    const refreshed=await fixture.service.execute(manager);
    expect(refreshed).toMatchObject({requiresNewReview:true,recording:{status:'draft',portalProjectId:'project-synthetic',portalRevision:'source-v2'}});
    fixture.changeCustomer('different-customer');
    await expect(fixture.service.execute(getClaims)).rejects.toThrow('recording_identity_changed');
    await expect(fixture.service.execute(manager)).rejects.toThrow('recording_identity_changed');
  });
  it('retries failed transcript extraction from the same saved text without audio I/O',async()=>{
    const fixture=setupService(),c=transcript('Customer: Keep the bicycle.');
    fixture.io.conversation.mockRejectedValueOnce(Object.assign(new Error('private transcript access_token=secret'),{status:400,code:'invalid_json_schema'}));
    const first=await fixture.service.saveTranscript(c);
    const diagnostic=vi.fn();
    expect(await fixture.service.processNext(diagnostic)).toBe(true);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({event:'recording_processing_failed',stage:'extraction',attempt:1,sourceKind:'transcript',code:'invalid_json_schema',status:400});
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}});
    expect(failed.recording).toMatchObject({status:'failed',lastErrorCode:'recording_processing_failed',transcript:'Customer: Keep the bicycle.'});
    fixture.linkProject('project-synthetic');
    await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.retry',recordingId:first.recording.id}}});
    expect(await fixture.service.processNext()).toBe(true);
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}});
    expect(draft.recording).toMatchObject({status:'draft',attemptCount:2,sourceKind:'transcript'});
    expect(fixture.io.conversation).toHaveBeenCalledTimes(2);
    expect(fixture.io.get).not.toHaveBeenCalled();expect(fixture.io.transcribe).not.toHaveBeenCalled();expect(fixture.io.put).not.toHaveBeenCalled();
  });
  it('persists a safe credit-exhaustion code, keeps the transcript, and retries that same record after recovery',async()=>{
    const fixture=setupService(),c=transcript('Customer: Keep the bicycle.');
    fixture.io.conversation.mockRejectedValueOnce(Object.assign(new Error('private transcript and API credential'),{status:429,code:'credit_balance_exhausted'}));
    const first=await fixture.service.saveTranscript(c),diagnostic=vi.fn();
    expect(await fixture.service.processNext(diagnostic)).toBe(true);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({event:'recording_processing_failed',stage:'extraction',attempt:1,sourceKind:'transcript',code:'credit_balance_exhausted',status:429});
    const get={...c,request:{requestId:randomUUID(),body:{command:'recording.get' as const,recordingId:first.recording.id}}};
    expect(await fixture.service.execute(get)).toMatchObject({recording:{id:first.recording.id,status:'failed',lastErrorCode:'recording_ai_credits_exhausted',transcript:'Customer: Keep the bicycle.'}});
    expect(JSON.stringify(fixture.row)).not.toContain('private transcript and API credential');
    const retry={...c,request:{requestId:randomUUID(),body:{command:'recording.retry' as const,recordingId:first.recording.id}}};
    expect(await fixture.service.execute(retry)).toMatchObject({recording:{id:first.recording.id,status:'uploaded',lastErrorCode:null,transcript:'Customer: Keep the bicycle.'}});
    expect(await fixture.service.execute(retry)).toMatchObject({alreadyQueuedOrProcessed:true,recording:{id:first.recording.id,status:'uploaded'}});
    expect(await fixture.service.processNext()).toBe(true);
    expect(await fixture.service.execute(get)).toMatchObject({recording:{id:first.recording.id,status:'draft',attemptCount:2,transcript:'Customer: Keep the bicycle.'}});
    expect(fixture.io.conversation).toHaveBeenCalledTimes(2);
    expect(fixture.io.get).not.toHaveBeenCalled();expect(fixture.io.transcribe).not.toHaveBeenCalled();expect(fixture.io.put).not.toHaveBeenCalled();
  });
  it.each([{status:429,code:'rate_limit_exceeded'},{status:429,code:'insufficient_quota'},{status:503,code:'credit_balance_exhausted'}])('does not call another provider failure credit exhaustion: %o',async provider=>{
    const fixture=setupService(),c=transcript();
    fixture.io.conversation.mockRejectedValueOnce(Object.assign(new Error('private provider response'),provider));
    const first=await fixture.service.saveTranscript(c);
    expect(await fixture.service.processNext()).toBe(true);
    expect(await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}})).toMatchObject({recording:{status:'failed',lastErrorCode:'recording_processing_failed',transcript:'Customer: Keep the shelves.'}});
  });
  it('refuses AI follow-ups if the Hub customer is relinked after scope apply',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[manualTask(first.recording.id)]);
    fixture.onApply(()=>fixture.changeCustomer('different-customer'));
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_identity_changed');
    expect(fixture.portalCommands).toContain('recording.apply');
    expect(fixture.io.createReviewedTask).not.toHaveBeenCalled();
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:approval.request.requestId,approvalPayload:{command:approval.request.body}});
  });
  it('refuses an AI task when the Hub job changes between exact-source and canonical reads',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[manualTask(first.recording.id)]);
    fixture.onJobRead(()=>fixture.changeCustomer('different-customer'));
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_source_revision_conflict');
    expect(fixture.io.createReviewedTask).not.toHaveBeenCalled();
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:approval.request.requestId});
  });
  it('keeps the exact AI review and task IDs after a partial write, but stops on customer relink',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const task=manualTask(first.recording.id),approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[task,{...task,title:'Confirm the next visit'}]);
    fixture.io.createReviewedTask.mockImplementationOnce(async()=>{fixture.changeCustomer('different-customer');return{ok:true};});
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_identity_changed');
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(1);
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:approval.request.requestId,approvalPayload:{command:approval.request.body}});
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_identity_changed');
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(1);
    fixture.changeCustomer('customer-synthetic');
    expect(await fixture.service.execute(approval)).toMatchObject({recording:{status:'approved'}});
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(3);
    expect(fixture.io.createReviewedTask.mock.calls[0]?.[2]).toBe(fixture.io.createReviewedTask.mock.calls[1]?.[2]);
    expect(fixture.io.createReviewedTask.mock.calls[2]?.[2]).toBe(stableUuid(`recording:${first.recording.id}:action:1`));
    expect(fixture.io.createReviewedTask.mock.calls[0]?.[1]).toEqual(fixture.io.createReviewedTask.mock.calls[1]?.[1]);
  });
  it('does not erase a frozen AI approval after one task and a source-revision conflict',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const task=manualTask(first.recording.id),approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[task,{...task,title:'Confirm the next visit'}]);
    fixture.io.createReviewedTask.mockImplementationOnce(async()=>{fixture.onJobRead(()=>fixture.linkProject('project-synthetic'));return{ok:true};});
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_source_revision_conflict');
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(1);
    const frozen=fixture.row as {approvalRequestId:string;approvalFingerprint:string;approvalPayload:unknown};
    expect(frozen).toMatchObject({status:'approval_pending',lastErrorCode:'recording_source_revision_conflict',approvalRequestId:approval.request.requestId,approvalPayload:{command:approval.request.body}});
    const refresh={...approval,request:{requestId:randomUUID(),body:{command:'recording.refresh_source' as const,recordingId:first.recording.id}}};
    await expect(fixture.service.execute(refresh)).rejects.toThrow('recording_review_refresh_not_safe');
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:frozen.approvalRequestId,approvalFingerprint:frozen.approvalFingerprint,approvalPayload:frozen.approvalPayload});
    fixture.onJobRead(()=>{});
    expect(await fixture.service.execute(approval)).toMatchObject({recording:{status:'approved'}});
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(3);
    expect(fixture.io.createReviewedTask.mock.calls[0]?.[2]).toBe(fixture.io.createReviewedTask.mock.calls[1]?.[2]);
    expect(fixture.io.createReviewedTask.mock.calls[2]?.[2]).toBe(stableUuid(`recording:${first.recording.id}:action:1`));
  });
  it('does not finalize an AI review if the customer changes after its last task write',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[manualTask(first.recording.id)]);
    fixture.io.createReviewedTask.mockImplementationOnce(async()=>{fixture.changeCustomer('different-customer');return{ok:true};});
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_identity_changed');
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(1);
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalPayload:{command:approval.request.body}});
  });
  it('does not overwrite a manager refresh that reset an AI review during its task write',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const draft=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const approval=reviewedApproval(c,first.recording.id,draft.recording.revision,[manualTask(first.recording.id)]);
    fixture.io.createReviewedTask.mockImplementationOnce(async()=>{fixture.changeRow({status:'draft',approvalPayload:null,approvalFingerprint:null,approvalRequestId:null});return{ok:true};});
    await expect(fixture.service.execute(approval)).rejects.toThrow('recording_approval_request_conflict');
    expect(fixture.row).toMatchObject({status:'draft',approvalPayload:null,approvalFingerprint:null});
    expect(fixture.io.createReviewedTask).toHaveBeenCalledTimes(1);
  });
  it('reviews exact-source manual office tasks without applying or inventing a walkthrough scope',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(Object.assign(new Error('provider billing detail'),{status:429,code:'credit_balance_exhausted'}));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const task=manualTask(first.recording.id),manual:RecordingClaims={...c,actor:{...c.actor,role:'manager'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[task]}}};
    const reviewed=await fixture.service.execute(manual);
    expect(reviewed).toMatchObject({ok:true,recording:{id:first.recording.id,status:'approved',reviewMode:'manual_tasks',extractionVersion:0,extraction:null,transcript:'Customer: Please call me about access.',approvedBy:'test-owner'}});
    expect(fixture.io.createManualTask).toHaveBeenCalledExactlyOnceWith(manual.actor,expect.objectContaining({kind:'manual',sourceEvidence:task.sourceEvidence,dedupeKey:`recording:${first.recording.id}:manual:0`}),stableUuid(`recording:${first.recording.id}:manual:0`));
    expect(fixture.portalCommands).not.toContain('recording.apply');
    expect(await fixture.service.execute(manual)).toMatchObject({alreadyApplied:true,recording:{status:'approved',reviewMode:'manual_tasks'}});
    expect(fixture.io.createManualTask).toHaveBeenCalledTimes(1);
    const changed={...manual,request:{requestId:randomUUID(),body:{...manual.request.body,actions:[{...task,title:'Different task'}]}}} as RecordingClaims;
    await expect(fixture.service.execute(changed)).rejects.toThrow('recording_approval_request_conflict');
  });
  it('refreshes a failed transcript for an explicit current-visit review, without losing source or diagnostic',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const get={...c,request:{requestId:randomUUID(),body:{command:'recording.get' as const,recordingId:first.recording.id}}};
    const failed=await fixture.service.execute(get) as {recording:{revision:string}};
    const manual:RecordingClaims={...c,actor:{...c.actor,role:'manager'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[manualTask(first.recording.id)]}}};
    fixture.linkProject('project-synthetic');
    await expect(fixture.service.execute(manual)).rejects.toThrow('recording_source_revision_conflict');
    expect(fixture.io.createManualTask).not.toHaveBeenCalled();
    const refresh={...manual,request:{requestId:randomUUID(),body:{command:'recording.refresh_source' as const,recordingId:first.recording.id}}};
    const refreshed=await fixture.service.execute(refresh) as {recording:{revision:string;portalRevision:string}};
    expect(refreshed).toMatchObject({requiresNewReview:true,recording:{status:'failed',sourceKind:'transcript',portalProjectId:'project-synthetic',portalRevision:'source-v2',lastErrorCode:'recording_processing_failed',transcript:'Customer: Please call me about access.'}});
    expect(refreshed.recording.revision).not.toBe(failed.recording.revision);
    const current={...manual,request:{...manual.request,body:{...manual.request.body,revision:refreshed.recording.revision}}} as RecordingClaims;
    expect(await fixture.service.execute(current)).toMatchObject({recording:{status:'approved',reviewMode:'manual_tasks'}});
    expect(fixture.portalCommands).not.toContain('recording.apply');
  });
  it('keeps a pending manual claim frozen and blocks identity races before writing any task',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const manual:RecordingClaims={...c,actor:{...c.actor,role:'manager'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[manualTask(first.recording.id)]}}};
    fixture.onMembersRead(()=>fixture.changeCustomer('other-customer'));
    await expect(fixture.service.execute(manual)).rejects.toThrow('recording_identity_changed');
    expect(fixture.io.createManualTask).not.toHaveBeenCalled();
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:manual.request.requestId,approvalPayload:{command:manual.request.body}});
    const refresh={...manual,request:{requestId:randomUUID(),body:{command:'recording.refresh_source' as const,recordingId:first.recording.id}}};
    await expect(fixture.service.execute(refresh)).rejects.toThrow('recording_identity_changed');
    fixture.changeCustomer('customer-synthetic');
    await expect(fixture.service.execute(refresh)).rejects.toThrow('recording_manual_review_refresh_not_safe');
    fixture.onMembersRead(()=>{});
    expect(await fixture.service.execute(manual)).toMatchObject({recording:{status:'approved',reviewMode:'manual_tasks'}});
    expect(fixture.io.createManualTask).toHaveBeenCalledTimes(1);
  });
  it('refuses a customer relink between exact source lookup and canonical Hub job read',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const manual:RecordingClaims={...c,actor:{...c.actor,role:'manager'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[manualTask(first.recording.id)]}}};
    fixture.onJobRead(()=>fixture.changeCustomer('other-customer'));
    await expect(fixture.service.execute(manual)).rejects.toThrow('recording_source_revision_conflict');
    expect(fixture.io.createManualTask).not.toHaveBeenCalled();
    expect(fixture.row).toMatchObject({status:'approval_pending',approvalRequestId:manual.request.requestId});
  });
  it('rejects invented source quotes, changed visit identity and wrong customer before manual task creation',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const task=manualTask(first.recording.id),manual:RecordingClaims={...c,actor:{...c.actor,role:'manager'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[task]}}};
    await expect(fixture.service.execute({...manual,request:{...manual.request,body:{...manual.request.body,actions:[{...task,sourceEvidence:[{source:'recording',id:first.recording.id,excerpt:'Invented customer promise'}]}]}}} as RecordingClaims)).rejects.toThrow('recording_manual_task_invalid');
    await expect(fixture.service.execute({...manual,request:{...manual.request,body:{...manual.request.body,actions:[{...task,portalVisitId:'other-visit'}]}}} as RecordingClaims)).rejects.toThrow('recording_manual_task_invalid');
    expect(fixture.row).toMatchObject({status:'failed'});expect(fixture.io.createManualTask).not.toHaveBeenCalled();
    fixture.changeCustomer('different-customer');await expect(fixture.service.execute(manual)).rejects.toThrow('recording_identity_changed');
    expect(fixture.io.createManualTask).not.toHaveBeenCalled();
  });
  it('retries an uncertain manual task write with the same durable task identity and no scope mutation',async()=>{
    const fixture=setupService(),c=transcript('Customer: Please call me about access.');
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first=await fixture.service.saveTranscript(c);await fixture.service.processNext();
    const failed=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}}) as {recording:{revision:string}};
    const manual:RecordingClaims={...c,actor:{...c.actor,role:'owner'},request:{requestId:randomUUID(),body:{command:'recording.review_manual_tasks',recordingId:first.recording.id,revision:failed.recording.revision,confirm:true,actions:[manualTask(first.recording.id)]}}};
    fixture.io.createManualTask.mockRejectedValueOnce(new Error('unknown response after task commit'));
    await expect(fixture.service.execute(manual)).rejects.toThrow('unknown response after task commit');
    expect(fixture.row).toMatchObject({status:'approval_pending',lastErrorCode:'recording_manual_task_create_failed',transcript:'Customer: Please call me about access.'});
    const pending=await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:first.recording.id}}});
    expect(pending.recording).toMatchObject({status:'approval_pending',reviewMode:'manual_tasks',pendingReview:manual.request.body});
    expect(await fixture.service.execute(manual)).toMatchObject({recording:{status:'approved',reviewMode:'manual_tasks'}});
    expect(fixture.io.createManualTask).toHaveBeenCalledTimes(2);
    expect(fixture.io.createManualTask.mock.calls[0]?.[2]).toBe(fixture.io.createManualTask.mock.calls[1]?.[2]);
    expect(fixture.portalCommands).not.toContain('recording.apply');
  });
  it('keeps a processing failure retryable even when its diagnostic logger throws',async()=>{
    const fixture=setupService(),c=transcript();
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic failure'));
    const first=await fixture.service.saveTranscript(c);
    expect(await fixture.service.processNext(()=>{throw new Error('logger unavailable');})).toBe(true);
    expect(fixture.row).toMatchObject({status:'failed',processingLeaseUntil:null,lastErrorCode:'recording_processing_failed'});
    await fixture.service.execute({...c,request:{requestId:randomUUID(),body:{command:'recording.retry',recordingId:first.recording.id}}});
    await fixture.service.processNext();
    expect(fixture.row).toMatchObject({status:'draft',attemptCount:2});
  });
});
