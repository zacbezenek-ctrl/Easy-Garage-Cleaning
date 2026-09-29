import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {walkthroughExtractionSchema} from '@egc/schemas';
import {conversationExtractionSchema} from '@egc/ai';
import {servicePublicKeySet,signServiceRequest,verifyServiceRequest} from '@egc/operations';
import {fingerprint,MAX_TRANSCRIPT_BYTES,signRecordingEnvelope,verifyRecordingEnvelope,stableUuid,type RecordingClaims} from './recording-contracts.js';
import {registerRecordingRoutes,RecordingService} from './recordings.js';
import {tokenVersion} from './service-bridge.js';
const key='isolated-recording-signing-test-only-0123456789';
const claims=():RecordingClaims=>({v:1,iss:'portal',aud:'egc-recordings',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:{id:'test-owner',role:'owner',kind:'human',workspace:'egc'},request:{requestId:randomUUID(),body:{command:'recording.get',recordingId:randomUUID()}}});
const apps:ReturnType<typeof Fastify>[]=[];afterEach(async()=>{for(const a of apps.splice(0))await a.close();});
describe('recording authentication and request contracts',()=>{
it('binds the exact actor, payload, workspace and audience',()=>{const c=claims();expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toEqual(c);expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'other')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,aud:'egc-operations'},key),key,'egc')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key+'wrong','egc')).toThrow();expect(()=>verifyRecordingEnvelope(signRecordingEnvelope({...c,iat:c.iat-120},key),key,'egc')).toThrow();});
it('sales can read but only human owners/managers can approve',()=>{const c=claims();c.actor.role='sales';expect(verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc').actor.role).toBe('sales');c.request.body={command:'recording.approve',recordingId:randomUUID(),revision:new Date().toISOString(),extraction:walkthroughExtractionSchema.parse({}),actions:[]};expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow('human_manager_approval_required');c.actor={...c.actor,kind:'integration',role:'integration'};expect(()=>verifyRecordingEnvelope(signRecordingEnvelope(c,key),key,'egc')).toThrow();});
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
    const select=()=>{const chain={from:()=>chain,where:()=>chain,orderBy:()=>chain,limit:()=>chain,offset:async()=>row?[row]:[],for:async()=>row&&['uploaded','processing'].includes(String(row.status))?[row]:[],then:(resolve:(value:unknown[])=>unknown)=>Promise.resolve(row?[row]:[]).then(resolve)};return chain;};
    const db={select,insert:()=>({values:(values:Record<string,unknown>)=>({onConflictDoNothing:async()=>{if(!row)row={attemptCount:0,createdAt:new Date('2026-09-29T12:00:00.000Z'),updatedAt:new Date('2026-09-29T12:00:00.000Z'),...values};}})}),update:()=>({set:(values:Record<string,unknown>)=>{const result={where:()=>result,returning:async()=>{row={...row,...values};return[row];},then:(resolve:(value:unknown)=>unknown)=>{row={...row,...values};return Promise.resolve(undefined).then(resolve);}};return result;}}),transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn(db)};
    const io={put:vi.fn(),get:vi.fn(),transcribe:vi.fn(),extract:vi.fn(),catalog:vi.fn(()=>({items:[],catalogVersion:'synthetic'})),conversation:vi.fn(async(_text:string,options:{context:{sourceKind:'visit_recording'|'visit_transcript';occurredAt:string}})=>({ok:true,extraction:conversationExtractionSchema.parse({version:2,sourceKind:options.context.sourceKind,occurredAt:options.context.occurredAt,model:'synthetic',catalogVersion:'synthetic',scope:null,proposedActions:[],catalogMentions:[],preferences:[],validation:{droppedProposedActions:0,droppedCatalogMentions:0,droppedPreferences:0,droppedEvidence:0,clearedCatalogItemIds:0,clearedMentions:0,clearedDraftSuggestions:0}})}))};
    const fetcher=vi.fn(async()=>Response.json({identity:{authority:'employee_hub',portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',portalCustomerId:sourceCustomer,portalProjectId:sourceProject,portalRevision:sourceRevision,highlevelContactId:null}}));
    const service=new RecordingService({EGC_OPERATIONS_WORKSPACE:'egc',EGC_PORTAL_ORIGIN:'https://synthetic.invalid',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key,EGC_EXTRACTION_V2:'false'},db as never,fetcher,io as never);
    return{service,io,fetcher,get row(){return row;},changeCustomer:(value:string)=>{sourceCustomer=value;},linkProject:(value:string)=>{sourceProject=value;sourceRevision='source-v2';}};
  }
  const transcript=(text='Customer: Keep the shelves.',requestId:string=randomUUID())=>{const c=claims();c.actor.role='sales';c.request.requestId=requestId;c.request.body={command:'recording.transcript',portalJobId:'visit-synthetic',transcript:text,filename:'visit.srt'};return c;};
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
    fixture.io.conversation.mockRejectedValueOnce(new Error('synthetic model failure'));
    const first=await fixture.service.saveTranscript(c);
    expect(await fixture.service.processNext()).toBe(true);
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
});
