/** Synthetic recording lifecycle against isolated PostgreSQL; all external I/O is mocked. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {walkthroughExtractionSchema} from '@egc/schemas';
import {extractConversation,loadCatalogIndex} from '@egc/ai';
import {RecordingService} from '../dist/recordings.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External HTTP is forbidden in synthetic recording tests');};
const db=getDb(),actor={id:'test-owner',kind:'human',role:'owner',workspace:'egc'},env={EGC_OPERATIONS_WORKSPACE:'egc',EGC_PORTAL_ORIGIN:'https://synthetic.invalid',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:'isolated-recording-test-signing-key-01234567890'};
const extraction=()=>walkthroughExtractionSchema.parse({itemsKeep:['Synthetic bicycle'],proposedActions:[{title:'Call about shelf placement',kind:'callback',commitment:'Call before work starts',sourceQuote:'I will call before work starts',ownerMention:null,dueMention:null,confidence:0.9}]});
const claims=(body,requestId=randomUUID())=>({v:1,iss:'portal',aud:'egc-recordings',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor,request:{requestId,body}});
let service,stored,receipts,sourceRevision,sourceCustomer,transcribeFails,appliedCount,unknownAfterApply,storageFails,commands,fetcher,io;
const row=async id=>(await db.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id,id)))[0];
beforeEach(async()=>{await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,contacts,walkthroughs,audit_logs cascade`);stored=new Map();receipts=new Set();sourceRevision='source-v1';sourceCustomer='customer-synthetic';transcribeFails=false;storageFails=false;appliedCount=0;unknownAfterApply=false;commands=[];
  fetcher=async(url,options)=>{const token=JSON.parse(options.body).envelope,body=JSON.parse(Buffer.from(token.split('.')[0],'base64url')).request.body;commands.push(body.command);
    if(body.command==='recording.resolve')return Response.json({identity:{authority:'employee_hub',portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',portalCustomerId:sourceCustomer,portalProjectId:null,portalRevision:sourceRevision,highlevelContactId:null}});
    if(body.command==='recording.apply'){if(receipts.has(body.recordingId))return Response.json({ok:true,alreadyApplied:true});if(body.expectedRevision!==sourceRevision)return Response.json({error:'recording_source_revision_conflict'},{status:409});receipts.add(body.recordingId);appliedCount++;sourceRevision='source-v2';if(unknownAfterApply){unknownAfterApply=false;throw new Error('Unknown transport failure after commit');}return Response.json({ok:true});}
    if(body.command==='portal.members')return Response.json({authority:'employee_hub',members:[{id:actor.id}]});
    if(body.command==='portal.job')return Response.json({authority:'employee_hub',job:{id:'visit-synthetic',revision:sourceRevision,type:'walkthrough',highlevelContactId:null,sourceWalkthroughId:null,customer:'Synthetic',status:'scheduled'}});
    throw new Error('Unexpected synthetic provider command');};
  io={put:async(key,bytes)=>{const records=await db.select().from(schema.walkthroughs);assert.equal(records.length,1,'durable recording must exist before storage/AI');if(storageFails)throw new Error('storage unavailable secret=value');stored.set(key,bytes);return key;},get:async key=>stored.get(key),transcribe:async()=>{if(transcribeFails)throw new Error('AI error with secret=value');return 'I will call before work starts. Keep the bicycle.';},extract:async()=>extraction()};
  service=new RecordingService(env,db,fetcher,io);
});
after(async()=>{globalThis.fetch=originalFetch;await db.$client.end({timeout:5});});
async function upload(id=randomUUID(),audio=Buffer.from('synthetic-audio')){return service.upload(claims({command:'recording.upload',portalJobId:'visit-synthetic',audioSha256:createHash('sha256').update(audio).digest('hex')},id),audio,'audio/webm');}
async function submitTranscript(text,id=randomUUID(),filename='visit.vtt'){return service.execute(claims({command:'recording.transcript',portalJobId:'visit-synthetic',transcript:text,filename},id));}
const get=id=>service.execute(claims({command:'recording.get',recordingId:id}));
async function draft(){const r=await upload();await service.processNext();return(await get(r.recording.id)).recording;}
const review=(r,extra={})=>({command:'recording.approve',recordingId:r.id,revision:r.revision,extraction:r.extraction,actions:[],...extra});
test('upload survives service reconstruction and suppresses duplicate logical recordings',async()=>{const requestId=randomUUID();const first=await upload(requestId);assert.equal(first.recording.status,'uploaded');assert.equal(first.recording.contactId,null);const again=await upload(requestId);assert.equal(again.recording.id,first.recording.id);assert.equal((await db.select().from(schema.walkthroughs)).length,1);await assert.rejects(upload(requestId,Buffer.from('different')),e=>e.code==='recording_upload_request_conflict');assert.equal(first.recording.audioObjectKey,undefined);});
test('failed upload retains durable record and retries original bytes without duplicate',async()=>{const requestId=randomUUID();storageFails=true;await assert.rejects(upload(requestId),e=>e.code==='recording_upload_failed');const [failed]=await db.select().from(schema.walkthroughs);assert.equal(failed.status,'failed');storageFails=false;assert.equal((await upload(requestId)).recording.id,failed.id);assert.equal((await row(failed.id)).status,'uploaded');});
test('transcription failure is safe, retryable and never applies scope or invents a job',async()=>{const r=await upload();transcribeFails=true;await service.processNext();assert.equal((await row(r.recording.id)).status,'failed');assert.equal((await row(r.recording.id)).lastErrorCode,'recording_processing_failed');await service.execute(claims({command:'recording.retry',recordingId:r.recording.id}));transcribeFails=false;await service.processNext();const d=await row(r.recording.id);assert.equal(d.status,'draft');assert.equal(d.attemptCount,2);assert.equal(appliedCount,0);assert.equal((await db.select().from(schema.jobs)).length,0);});
test('two processors claim one recording and stale recording revision cannot approve',async()=>{const r=await upload();const claimsResult=await Promise.all([service.processNext(),service.processNext()]);assert.equal(claimsResult.filter(Boolean).length,1);const d=(await get(r.recording.id)).recording;await assert.rejects(service.execute(claims(review(d,{revision:'2000-01-01T00:00:00.000Z'}))),e=>e.code==='recording_revision_conflict');assert.equal(appliedCount,0);});
test('unknown Hub approval outcome safely resumes identical review and creates one shared task',async()=>{const d=await draft();const action={title:'Call before work starts',kind:'callback',description:'Explicit synthetic promise',priority:'medium',assignedUserId:actor.id,dueAt:new Date(Date.now()+86400000).toISOString(),timeZone:'America/Denver',waitingOn:'none',reviewAt:null,portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',contactId:null,jobId:null,completionCondition:'Record call result',sourceEvidence:[],dependencies:[],draft:null};const c=claims(review(d,{actions:[action]}));unknownAfterApply=true;await assert.rejects(service.execute(c),e=>e.code==='recording_approval_outcome_unknown');assert.equal((await row(d.id)).status,'approval_pending');await assert.rejects(service.execute(claims(review(d,{extraction:{...d.extraction,itemsKeep:['Changed']}}))),e=>e.code==='recording_approval_request_conflict');const done=await service.execute(c);assert.equal(done.recording.status,'approved');await service.execute(c);assert.equal(appliedCount,1);assert.equal((await db.select().from(schema.tasks)).length,1);assert.equal((await db.select().from(schema.jobs)).length,0);assert.equal((await db.select().from(schema.auditLogs)).filter(e=>e.action==='recording.approve').length,1);});
test('source changes require explicit refreshed review; no automatic scope overwrite',async()=>{const d=await draft();sourceRevision='source-edited';await assert.rejects(service.execute(claims(review(d))),e=>e.code==='recording_source_revision_conflict');assert.equal(appliedCount,0);const refreshed=await service.execute(claims({command:'recording.refresh_source',recordingId:d.id}));assert.equal(refreshed.requiresNewReview,true);assert.equal(refreshed.recording.status,'draft');await service.execute(claims(review(refreshed.recording)));assert.equal(appliedCount,1);});

test('text transcript is durable, replay-stable, and retry processing never fetches or transcribes audio',async()=>{
  const text='00:00:01 --> 00:00:02\nCustomer: Keep the bicycle. I will call before work starts.',requestId=randomUUID();
  const v=v2Service({flag:'false',transcript:text,outputs:['not json',v2Output()]});service=v.service;
  const first=await submitTranscript(text,requestId,'walkthrough.vtt');
  assert.equal(first.recording.status,'uploaded');assert.equal(first.recording.sourceKind,'transcript');assert.equal(first.recording.sourceFilename,'walkthrough.vtt');
  const persisted=await row(first.recording.id);assert.equal(persisted.transcript,text);assert.equal(persisted.audioObjectKey,null);assert.equal(persisted.audioSha256,createHash('sha256').update(text).digest('hex'));
  const replay=await submitTranscript(text,requestId,'walkthrough.vtt');assert.equal(replay.alreadySaved,true);assert.equal(replay.recording.id,first.recording.id);
  await assert.rejects(submitTranscript(text+' changed',requestId,'walkthrough.vtt'),e=>e.code==='recording_upload_request_conflict');
  await assert.rejects(submitTranscript(text,requestId,'other.vtt'),e=>e.code==='recording_upload_request_conflict');
  await service.processNext();assert.equal((await row(first.recording.id)).status,'failed');
  await service.execute(claims({command:'recording.retry',recordingId:first.recording.id}));
  await service.processNext();assert.equal((await row(first.recording.id)).status,'draft');assert.equal((await row(first.recording.id)).attemptCount,2);
  assert.equal(v.transcribeCalls,0);assert.equal(v.model.length,2,'retry uses the saved text and v2 review proposals even while the audio v2 flag is off');
});

test('a changed authoritative visit blocks text replay and every recording read',async()=>{
  const first=await submitTranscript('Customer: Keep the bicycle.');sourceCustomer='different-customer';
  await assert.rejects(submitTranscript('Customer: Keep the bicycle.',first.recording.uploadRequestId),e=>e.code==='recording_identity_changed');
  for(const body of [{command:'recording.list',portalJobId:'visit-synthetic',offset:0},{command:'recording.get',recordingId:first.recording.id},{command:'recording.retry',recordingId:first.recording.id}])await assert.rejects(service.execute(claims(body)),e=>e.code==='recording_identity_changed');
});

// P3-02 conversation extraction v2 behind EGC_EXTRACTION_V2 (default off). The model is a synthetic client; the
// deterministic evidence validation, recording storage, review DTO and approval path are the real ones.
const visitTranscript=['Synthetic visit recording.','Customer: It is a two car garage. Please haul away the old couch but keep the bicycle.','Customer: Can you text me the quote? I prefer texts over calls.','Tyler: I will text you the quote by Friday.','Customer: Call me back after 5 about timing.','Customer: I like the Gladiator wall panels.'].join('\n');
const v2Action=over=>({kind:'callback',title:'Call back about timing',commitment:'Call the customer back after 5',sourceQuote:'Call me back after 5 about timing',ownerMention:null,dueMention:null,requestedChannel:'call',draftSuggestion:null,attachmentsNeeded:[],questionText:null,confidence:0.9,...over});
const v2Output=()=>({scope:{garageSize:'2_car',junkVolumeYards:null,itemsRemove:['old couch'],itemsKeep:['bicycle'],itemsRelocate:[],storageRequirements:[],bikeRacks:0,toolRacks:0,shelving:[],pressureWashing:false,pestObservations:[],activeInfestation:null,accessNotes:null,estimatedLaborHours:null,customerPreferences:[],customerObjections:[],salesNotes:[],crewNotes:[],pricingNotes:[],evidence:[{field:'garageSize',sourceQuote:'It is a two car garage',confidence:0.95}]},
  proposedActions:[v2Action({kind:'send_quote',title:'Text the quote',commitment:'Text the customer the quote',sourceQuote:'I will text you the quote by Friday',ownerMention:'Tyler',dueMention:'by Friday',requestedChannel:'sms',draftSuggestion:{channel:'sms',subject:null,body:'Hi, here is your Easy Garage Cleaning quote.'},attachmentsNeeded:['portal_quote']}),v2Action(),
    v2Action({kind:'send_quote',title:'Invented discount',commitment:'Offer a discount',sourceQuote:'I can give you twenty percent off',draftSuggestion:{channel:'sms',subject:null,body:'Here is your discount.'}})],
  catalogMentions:[{catalogItemId:'invented-garage-item',tier:'better',name:'Gladiator wall panels',category:'wall systems',zone:null,quantity:null,measurements:null,sourceQuote:'I like the Gladiator wall panels',confidence:0.8}],
  preferences:[{topic:'contact',statement:'Prefers texts over calls',polarity:'prefer',sourceQuote:'I prefer texts over calls',confidence:0.9}]});
function v2Service({flag='true',transcript=visitTranscript,outputs=[v2Output()]}={}){
  const calls=[],model=[];let transcribeCalls=0;const client={responses:{create:async request=>{model.push(request);const next=outputs.length>1?outputs.shift():outputs[0];return{output_text:typeof next==='string'?next:JSON.stringify(next)};}}};
  const conversation=async(text,options)=>{calls.push(options);return extractConversation(text,{...options,client});};
  return{calls,model,get transcribeCalls(){return transcribeCalls;},service:new RecordingService({...env,...(flag===null?{}:{EGC_EXTRACTION_V2:flag})},db,fetcher,{...io,transcribe:async()=>{transcribeCalls++;return transcript;},conversation})};
}
test('text visit proposals become office tasks only after the manager reviews the exact draft',async()=>{
  const v=v2Service({flag:'false',outputs:[{...v2Output(),proposedActions:[v2Action()]}]});service=v.service;
  const received=await submitTranscript(visitTranscript);await service.processNext();
  const d=(await get(received.recording.id)).recording;
  assert.equal(d.sourceKind,'transcript');assert.equal(d.conversation.sourceKind,'visit_transcript');assert.equal(d.status,'draft');
  assert.equal(d.proposedTasks.length,1);assert.equal(d.proposedTasks[0].task.kind,'callback');
  assert.equal((await db.select().from(schema.tasks)).length,0,'extraction cannot create a task');
  const action={...d.proposedTasks[0].task,assignedUserId:actor.id,dueAt:new Date(Date.now()+86400000).toISOString(),completionCondition:'Log call outcome'};
  const approved=await service.execute(claims(review(d,{actions:[action]})));
  assert.equal(approved.recording.status,'approved');assert.equal((await db.select().from(schema.tasks)).length,1);
  const [task]=await db.select().from(schema.tasks);assert.equal(task.kind,'callback');assert.ok(task.sourceEvidence.some(e=>e.source==='recording'&&e.id===d.id&&e.excerpt==='Call me back after 5 about timing'));
  assert.equal(v.transcribeCalls,0);assert.equal(appliedCount,1);assert.deepEqual([...new Set(commands)].sort(),['portal.job','portal.members','recording.apply','recording.resolve']);
});
test('EGC_EXTRACTION_V2 off (unset or not exactly "true") keeps the walkthrough extraction and never runs v2',async()=>{
  for(const flag of [null,'TRUE','1','false']){
    await db.execute(sql`truncate walkthroughs cascade`);const v=v2Service({flag});service=v.service;const d=await draft();
    assert.equal(v.calls.length,0);assert.equal(v.model.length,0);
    assert.deepEqual(d.extraction,walkthroughExtractionSchema.parse(extraction()));assert.equal(d.extractionVersion,1);
    assert.equal('conversation' in d,false);assert.equal('proposedTasks' in d,false);assert.equal(Object.hasOwn((await row(d.id)).extraction,'conversation'),false);
  }
});
test('EGC_EXTRACTION_V2 on: visit recordings store evidence-validated v2 proposals that map to Action Center tasks, never sent',async()=>{
  const v=v2Service();service=v.service;const d=await draft(),saved=await row(d.id);
  assert.equal(d.status,'draft');assert.equal(d.extractionVersion,2);assert.equal(v.model.length,1);
  const catalog=loadCatalogIndex();
  assert.equal(v.calls.length,1);assert.deepEqual(v.calls[0].context,{sourceKind:'visit_recording',occurredAt:saved.createdAt.toISOString()});assert.equal(v.calls[0].catalog.length,catalog.items.length);assert.equal(v.calls[0].catalogVersion,catalog.catalogVersion);
  assert.equal(saved.extraction.conversation.version,2);assert.equal(Object.hasOwn(d.extraction,'conversation'),false);
  assert.deepEqual(d.extraction.proposedActions.map(a=>a.kind),['followup_message','callback']);assert.equal(d.extraction.garageSize,'2_car');assert.deepEqual(d.extraction.evidence,{garageSize:{sourceQuote:'It is a two car garage',confidence:0.95}});
  assert.deepEqual(d.conversation.proposedActions.map(a=>a.kind),['send_quote','callback']);
  assert.equal(d.conversation.validation.droppedProposedActions,1);assert.equal(d.conversation.catalogMentions[0].catalogItemId,null);assert.equal(d.conversation.validation.clearedCatalogItemIds,1);
  assert.deepEqual(d.conversation.preferences.map(p=>p.statement),['Prefers texts over calls']);
  assert.deepEqual(d.proposedTasks.map(p=>[p.task.kind,p.task.draft?.body??null,p.task.assignedUserId,p.task.dueAt]),[['send_quote','Hi, here is your Easy Garage Cleaning quote.',null,null],['callback',null,null,null]]);
  const staff={assignedUserId:actor.id,dueAt:'2026-10-02T16:00:00.000Z',completionCondition:'Customer confirms receipt'};
  const actions=d.proposedTasks.map(p=>({...p.task,...staff,draft:p.task.draft&&{...p.task.draft,recipient:'+19705550142',sendWindowStart:'2026-10-01T15:00:00.000Z',sendWindowEnd:'2026-10-01T23:00:00.000Z'}}));
  const c=claims(review(d,{actions}));unknownAfterApply=true;
  await assert.rejects(service.execute(c),e=>e.code==='recording_approval_outcome_unknown');
  const pending=(await get(d.id)).recording;assert.equal(pending.status,'approval_pending');assert.equal(pending.pendingReview.actions.length,2);assert.deepEqual(pending.proposedTasks,[],'a pending review does not offer its tasks again');
  const done=await service.execute(c);
  assert.equal(done.recording.status,'approved');assert.equal(done.recording.conversation.version,2);assert.equal((await row(d.id)).extraction.conversation.version,2);
  assert.deepEqual(done.recording.proposedTasks,[],'approved proposals already became tasks');assert.deepEqual((await get(d.id)).recording.proposedTasks,[]);
  const tasks=await db.select().from(schema.tasks).orderBy(schema.tasks.dedupeKey);
  assert.deepEqual(tasks.map(t=>[t.kind,t.approvalStatus,t.status,t.draftPayload?.body??null]),[['send_quote','pending','open','Hi, here is your Easy Garage Cleaning quote.'],['callback','not_required','open',null]]);
  assert.ok(tasks.every(t=>t.sourceEvidence.some(e=>e.source==='recording'&&e.id===d.id)));
  assert.equal(tasks[0].sourceEvidence[0].excerpt,'I will text you the quote by Friday');
  assert.equal((await db.select().from(schema.operationApprovals)).length,0,'no draft is approved for sending by the recording review');
  assert.deepEqual([...new Set(commands)].sort(),['portal.job','portal.members','recording.apply','recording.resolve'],'only Hub identity/apply commands; no message is sent');
});
test('EGC_EXTRACTION_V2 on: an oversized transcript skips v2 without a model call and keeps the walkthrough extraction and its transcript',async()=>{
  const big='x'.repeat(120001),v=v2Service({transcript:big});service=v.service;const d=await draft(),saved=await row(d.id);
  assert.equal(v.calls.length,1);assert.equal(v.model.length,0);
  assert.equal(d.status,'draft');assert.equal(d.extractionVersion,1);assert.equal(saved.lastErrorCode,null);assert.equal(saved.transcript,big);
  assert.deepEqual(d.extraction,walkthroughExtractionSchema.parse(extraction()));assert.equal('conversation' in d,false);
});
test('EGC_EXTRACTION_V2 on: model text cut at a limit never splits an emoji, so the jsonb write succeeds',async()=>{
  await assert.rejects(db.execute(sql`select ${JSON.stringify({body:'y\ud83d'})}::jsonb`),'Postgres jsonb refuses half a surrogate pair');
  const output=v2Output();output.proposedActions[0].draftSuggestion.body=`${'y'.repeat(1999)}😀`;output.preferences[0].statement='Prefers texts \ud83d over calls';
  const v=v2Service({outputs:[output]});service=v.service;const d=await draft();
  assert.equal(d.status,'draft');assert.equal(d.extractionVersion,2);
  assert.equal(d.conversation.proposedActions[0].draftSuggestion.body,'y'.repeat(1999));assert.equal(d.conversation.preferences[0].statement,'Prefers texts \ufffd over calls');
  assert.equal((await row(d.id)).extraction.conversation.proposedActions[0].draftSuggestion.body,'y'.repeat(1999));
});
test('EGC_EXTRACTION_V2 on: unusable model output fails safely as recording_processing_failed and the retry succeeds',async()=>{
  const v=v2Service({outputs:['not json',v2Output()]});service=v.service;const r=await upload();await service.processNext();
  const failed=await row(r.recording.id);assert.equal(failed.status,'failed');assert.equal(failed.lastErrorCode,'recording_processing_failed');assert.equal(failed.extractionVersion,1);
  await service.execute(claims({command:'recording.retry',recordingId:r.recording.id}));await service.processNext();
  const d=(await get(r.recording.id)).recording;assert.equal(d.status,'draft');assert.equal(d.extractionVersion,2);assert.equal(v.model.length,2);assert.equal(appliedCount,0);
});
// FUN-08: scheduling constraints ride in the same v2 conversation. Each keeps its transcript quote; one without a
// supporting quote is dropped and counted. Rows stored before FUN-08 stay readable with schedulingConstraints null.
const scheduledTranscript=`${visitTranscript}\nCustomer: We cannot do anything until after next week, and Fridays never work.\nCustomer: There is no rush on the shelving part.`;
const scheduling=()=>({preferredWeekdays:null,timeOfDay:null,notBeforeMention:{mention:'until after next week',sourceQuote:'We cannot do anything until after next week'},notAfterMention:{mention:'by the end of October',sourceQuote:'It has to be finished by the end of October'},
  unavailableMentions:[{mention:'Fridays',sourceQuote:'Fridays never work'}],crewSizeMention:null,durationHoursMention:null,urgency:{level:'flexible',sourceQuote:'There is no rush on the shelving part'}});
test('EGC_EXTRACTION_V2 on: quoted scheduling constraints are stored and shown with the conversation; unquoted ones are dropped',async()=>{
  const v=v2Service({transcript:scheduledTranscript,outputs:[{...v2Output(),schedulingConstraints:scheduling()}]});service=v.service;const d=await draft(),saved=await row(d.id);
  assert.equal(d.extractionVersion,2);
  const expected={...scheduling(),notAfterMention:null};
  assert.deepEqual(d.conversation.schedulingConstraints,expected);assert.deepEqual(saved.extraction.conversation.schedulingConstraints,expected);
  assert.equal(d.conversation.validation.droppedSchedulingConstraints,1);assert.equal(d.conversation.validation.clearedSchedulingValues,0);
  assert.equal(Object.hasOwn(d.extraction,'schedulingConstraints'),false,'the reviewed walkthrough scope the Hub stores never carries them');
  assert.deepEqual(d.proposedTasks.map(p=>p.task.kind),['send_quote','callback']);
});
test('a v2 row stored before FUN-08 still shows its conversation and proposals, with schedulingConstraints null (never extracted)',async()=>{
  const v=v2Service();service=v.service;const d=await draft(),saved=await row(d.id);
  const {schedulingConstraints:_,...legacy}=saved.extraction.conversation,{droppedSchedulingConstraints:__,clearedSchedulingValues:___,...counts}=legacy.validation;
  await db.update(schema.walkthroughs).set({extraction:{...saved.extraction,conversation:{...legacy,validation:counts}}}).where(eq(schema.walkthroughs.id,d.id));
  assert.equal(Object.hasOwn((await row(d.id)).extraction.conversation,'schedulingConstraints'),false);
  const again=(await get(d.id)).recording;
  assert.equal(again.conversation.schedulingConstraints,null);assert.equal(again.conversation.validation.droppedSchedulingConstraints,0);
  assert.deepEqual(again.proposedTasks.map(p=>p.task.kind),['send_quote','callback']);
});
