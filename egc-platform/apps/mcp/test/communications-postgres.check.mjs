import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {executeCommunication,reconcileCommunication} from '../dist/communication-execution.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test')throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb();let contact,writes,provider,saved;
const input=(extra={})=>({requestId:randomUUID(),actorId:'fixture-grant',contactId:contact.id,payload:{type:'SMS',contactId:'synthetic-provider-id',message:'Synthetic authorized message'},...extra});
beforeEach(async()=>{
  await db.execute(sql`set client_min_messages to warning`);
  await db.execute(sql`truncate communication_executions,audit_logs,contacts cascade`);
  [contact]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-provider-id',name:'Isolated fixture'}).returning();
  writes=0;saved={id:'provider-message',contactId:contact.providerId,body:'Synthetic authorized message',direction:'outbound',status:'sent',messageType:'TYPE_SMS',conversationId:'synthetic-conversation'};
  provider={sendMessage:async()=>{writes++;return {messageId:saved.id};},getMessage:async()=>saved};
});
after(async()=>{await db.$client.end({timeout:5});});
test('ten concurrent requests with different IDs suppress identical message duplicates',async()=>{
  const results=await Promise.all(Array.from({length:10},()=>executeCommunication(input(),provider,db)));
  assert.equal(writes,1);assert.equal(new Set(results.map(r=>r.executionId)).size,1);
  const rows=await db.select().from(schema.communicationExecutions);assert.equal(rows.length,1);assert.equal(rows[0].status,'accepted');
});
test('same request replay reads provider evidence and never re-sends',async()=>{
  const i=input(),first=await executeCommunication(i,provider,db),again=await executeCommunication(i,provider,db);
  assert.equal(first.ok,true);assert.equal(first.delivered,false);assert.equal(again.duplicatePrevented,true);assert.equal(writes,1);
});
test('different content under one request key conflicts before provider write',async()=>{
  const i=input();await executeCommunication(i,provider,db);
  await assert.rejects(executeCommunication({...i,payload:{...i.payload,message:'Changed'}},provider,db),/message_request_conflict/);assert.equal(writes,1);
});
test('error after commit stays unknown and retry never sends again or leaks provider exception',async()=>{
  provider.sendMessage=async()=>{writes++;throw new Error('token=private-secret');};const i=input();
  const a=await executeCommunication(i,provider,db),b=await executeCommunication(i,provider,db);
  assert.equal(writes,1);assert.equal(a.error,'message_outcome_unknown');assert.equal(b.retryMode,'reconcile_only');
  assert.ok(!JSON.stringify(await db.select().from(schema.communicationExecutions)).includes('private-secret'));
});
test('read timeout after ack recovers by exact message ID',async()=>{
  const i=input();provider.getMessage=async()=>{throw new Error('timeout');};
  assert.equal((await executeCommunication(i,provider,db)).error,'message_verification_pending');
  provider.getMessage=async()=>({...saved,status:'delivered'});const recovered=await executeCommunication(i,provider,db);
  assert.equal(recovered.ok,true);assert.equal(recovered.delivered,true);assert.equal(writes,1);
});
test('malformed ack, wrong contact/body/direction cannot claim success',async()=>{
  for(const field of ['contactId','body','direction','messageType']) {
    await db.execute(sql`truncate communication_executions`);const original=saved;saved={...saved,[field]:'wrong'};
    assert.equal((await executeCommunication(input(),provider,db)).error,'message_verification_pending');saved=original;
  }
  await db.execute(sql`truncate communication_executions`);provider.sendMessage=async()=>({});
  assert.equal((await executeCommunication(input(),provider,db)).error,'message_outcome_unknown');
});
test('accepted receipt survives a read outage and is explicitly marked stale',async()=>{
  const i=input();await executeCommunication(i,provider,db);provider.getMessage=async()=>{throw new Error('token=secret');};
  const replay=await executeCommunication(i,provider,db);assert.equal(replay.ok,true);assert.equal(replay.verificationFresh,false);assert.equal(writes,1);
  assert.equal((await db.select().from(schema.communicationExecutions))[0].status,'accepted');
});
test('unknown write can be reconciled with exact matching ID and bounded occurrence evidence',async()=>{
  provider.sendMessage=async()=>{writes++;throw new Error('after commit');};const i=input();const unknown=await executeCommunication(i,provider,db);
  saved.dateAdded=new Date().toISOString();const reconciled=await reconcileCommunication(unknown.executionId,saved.id,'reviewer',provider,db);
  assert.equal(reconciled.ok,true);assert.equal(writes,1);assert.equal(reconciled.messageId,saved.id);
  const audits=await db.select().from(schema.auditLogs);assert.ok(audits.some(a=>a.action==='communication.reconciled_by_provider_id'&&a.actor==='reviewer'));
});
test('manual reconciliation rejects wrong channel, old/new occurrence and unavailable evidence before binding an ID',async()=>{
  provider.sendMessage=async()=>{throw new Error('unknown');};const unknown=await executeCommunication(input(),provider,db);const original={...saved};
  for(const changes of [{messageType:'TYPE_EMAIL',dateAdded:new Date().toISOString()},{dateAdded:'2000-01-01T00:00:00Z'},{dateAdded:new Date(Date.now()+3600000).toISOString()}]) {
    saved={...original,...changes};assert.equal((await reconcileCommunication(unknown.executionId,saved.id,'reviewer',provider,db)).error,'message_reconciliation_evidence_mismatch');
    assert.equal((await db.select().from(schema.communicationExecutions))[0].providerMessageId,null);
  }
  provider.getMessage=async()=>{throw new Error('token=private');};assert.equal((await reconcileCommunication(unknown.executionId,original.id,'reviewer',provider,db)).error,'provider_readback_unavailable');
});
test('failed provider delivery remains failed without automatic resend',async()=>{
  const i=input();saved.status='undelivered';const r=await executeCommunication(i,provider,db);assert.equal(r.ok,false);
  await executeCommunication(i,provider,db);assert.equal(writes,1);assert.equal((await db.select().from(schema.communicationExecutions))[0].status,'failed');
});
test('unknown identical message remains deduplicated beyond the ordinary window',async()=>{
 provider.sendMessage=async()=>{writes++;throw new Error('uncertain');};const first=await executeCommunication(input(),provider,db);await db.update(schema.communicationExecutions).set({createdAt:new Date(Date.now()-86400000)}).where(eq(schema.communicationExecutions.id,first.executionId));const again=await executeCommunication(input(),provider,db);assert.equal(again.executionId,first.executionId);assert.equal(writes,1);
});
test('slow stale read failure cannot downgrade concurrent accepted delivery evidence',async()=>{
 const i=input();provider.getMessage=async()=>{throw new Error('initial outage');};await executeCommunication(i,provider,db);
 let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);let reads=0;provider.getMessage=async()=>{if(++reads===1){enter();await wait;throw new Error('late stale timeout');}return{...saved,status:'delivered'};};
 const slow=executeCommunication(i,provider,db);await entered;const fresh=await executeCommunication(i,provider,db);assert.equal(fresh.delivered,true);release();const late=await slow;assert.equal(late.delivered,true);assert.equal(late.verificationFresh,false);assert.equal((await db.select().from(schema.communicationExecutions))[0].status,'accepted');
});
test('late send failure cannot overwrite manual reconciliation that already succeeded',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);provider.sendMessage=async()=>{writes++;enter();await wait;throw new Error('late timeout');};const pending=executeCommunication(input(),provider,db);await entered;const [row]=await db.select().from(schema.communicationExecutions);saved.dateAdded=new Date().toISOString();saved.status='delivered';const reconciled=await reconcileCommunication(row.id,saved.id,'reviewer',provider,db);assert.equal(reconciled.ok,true);release();assert.equal((await pending).delivered,true);assert.equal((await db.select().from(schema.communicationExecutions))[0].status,'accepted');assert.equal(writes,1);
});
test('stale sent receipt cannot downgrade delivered state',async()=>{
 const i=input();saved.status='delivered';await executeCommunication(i,provider,db);saved.status='sent';const result=await executeCommunication(i,provider,db);assert.equal(result.delivered,true);assert.equal((await db.select().from(schema.communicationExecutions))[0].response.status,'delivered');
});
test('explicit email subject and recipients require matching provider evidence',async()=>{
 const i=input({payload:{type:'Email',contactId:'synthetic-provider-id',message:'Synthetic authorized message',subject:'Correct subject',emailTo:'synthetic@example.invalid'}});saved.messageType='TYPE_EMAIL';saved.subject='Wrong subject';saved.emailTo='synthetic@example.invalid';const first=await executeCommunication(i,provider,db);assert.equal(first.error,'message_verification_pending');saved.subject='Correct subject';assert.equal((await executeCommunication(i,provider,db)).ok,true);assert.equal(writes,1);
});
test('unknown provider status cannot be reported as accepted',async()=>{
 saved.status='unknown';assert.equal((await executeCommunication(input(),provider,db)).error,'message_verification_pending');assert.equal((await db.select().from(schema.communicationExecutions))[0].status,'unknown');
});
test('documented SMS from/to fields provide exact recipient proof',async()=>{
 const i=input();i.payload.toNumber='+12025550100';saved.to=i.payload.toNumber;saved.dateAdded=new Date().toISOString();saved.status='delivered';const r=await executeCommunication(i,provider,db);assert.equal(r.ok,true);assert.equal(r.matchEvidence.recipient,saved.to);assert.equal(r.matchEvidence.channel,'sms');
});
test('documented email child read supplies exact subject and single recipient proof',async()=>{
 const i=input({payload:{type:'Email',contactId:'synthetic-provider-id',message:'Synthetic authorized message',subject:'Exact subject',emailTo:'synthetic@example.invalid'}});saved.messageType='TYPE_EMAIL';saved.meta={email:{email:{messageIds:['email-child']}}};saved.dateAdded=new Date().toISOString();provider.getEmailMessage=async id=>({id,threadId:saved.id,contactId:saved.contactId,conversationId:saved.conversationId,direction:'outbound',body:saved.body,subject:'Exact subject',to:['synthetic@example.invalid'],from:'sender@example.invalid',status:'delivered',dateAdded:saved.dateAdded});const r=await executeCommunication(i,provider,db);assert.equal(r.ok,true);assert.equal(r.matchEvidence.recipient,'synthetic@example.invalid');assert.equal(r.matchEvidence.subject,'Exact subject');assert.equal(r.delivered,true);
});
test('ambiguous email children do not guess which exact email was sent',async()=>{
 const i=input({payload:{type:'Email',contactId:'synthetic-provider-id',message:'Synthetic authorized message',subject:'Exact subject',emailTo:'synthetic@example.invalid'}});saved.messageType='TYPE_EMAIL';saved.meta={email:{email:{messageIds:['first','second']}}};provider.getEmailMessage=async()=>{throw new Error('must not guess');};assert.equal((await executeCommunication(i,provider,db)).error,'message_verification_pending');
});
