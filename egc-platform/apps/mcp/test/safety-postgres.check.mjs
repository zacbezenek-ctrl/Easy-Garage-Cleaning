/** Real MCP HTTP boundary against isolated loopback PostgreSQL with synthetic fixtures only; never point this at production. */
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const db=getDb(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const staticToken='isolated-safety-check-static-credential-0123456789';
const oauthToken='egc_at_isolated-safety-check-oauth-credential-0123456789';
const hash=value=>createHash('sha256').update(value).digest('hex');
const servers=[];
async function start(extraEnv) {
  const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',NODE_ENV:'test',PORT:String(port),
    MCP_PUBLIC_ORIGIN:origin,MCP_ALLOWED_HOSTS:'127.0.0.1',MCP_BEARER_TOKEN:staticToken,GHL_WRITEBACK_ENABLED:'false',DATABASE_URL:process.env.DATABASE_URL,...extraEnv}});
  let output='';child.stdout.on('data',b=>{output=(output+b).slice(-16000);});child.stderr.on('data',b=>{output=(output+b).slice(-16000);});
  const stop=async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');for(let i=0;i<40&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);if(child.exitCode===null)child.kill('SIGKILL');};
  servers.push(stop);
  for(let i=0;i<300&&!output.includes('EGC MCP listening');i++){if(child.exitCode!==null)break;await sleep(30);}
  if(!output.includes('EGC MCP listening')){await stop();throw new Error(`MCP startup failed: ${output}`);}
  let id=0;
  async function call(name,args,token=staticToken){
    const response=await fetch(`${origin}/mcp`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json,text/event-stream',Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})});
    const text=await response.text();
    const data=response.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(line=>line.startsWith('data: '))?.slice(6)||'null'):JSON.parse(text);
    return {isError:data.result?.isError===true,value:data.result?.structuredContent?.result??JSON.parse(data.result?.content?.[0]?.text??'null')};
  }
  return {call,origin};
}
let legacy,operations,grantId,contact,job;
before(async()=>{
  legacy=await start({EGC_OPERATIONS_ENABLED:'false',MCP_BEARER_WRITE_ENABLED:'true'});
  operations=await start({EGC_OPERATIONS_ENABLED:'true',MCP_BEARER_WRITE_ENABLED:'true'});
});
after(async()=>{for(const stop of servers)await stop();await db.$client.end({timeout:5});});
beforeEach(async()=>{
  await db.execute(sql`set client_min_messages to warning`);
  await db.execute(sql`truncate audit_logs,oauth_tokens,communication_executions,customer_state_snapshots,tasks,job_notes,jobs,leads,contacts cascade`);
  [contact]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-safety-contact',name:'Isolated fixture'}).returning();
  [job]=await db.insert(schema.jobs).values({contactId:contact.id,status:'scheduled'}).returning();
  const [grant]=await db.insert(schema.oauthTokens).values({accessTokenHash:hash(oauthToken),refreshTokenHash:hash('unused-refresh'),clientId:'https://chatgpt.com/oauth/client.json',resource:legacy.origin,scopes:['egc:read','egc:write'],accessExpiresAt:new Date('2099-01-01T00:00:00Z'),refreshExpiresAt:new Date('2099-01-01T00:00:00Z')}).returning();
  grantId=grant.id;
});
test('audit rows and job notes carry the verified principal, never a fixed client label',async()=>{
  const created=await legacy.call('tasks.create',{title:'Synthetic safety task'});
  assert.equal(created.isError,false);assert.equal(created.value.ok,true);
  const viaOauth=await legacy.call('tasks.create',{title:'Synthetic OAuth task'},oauthToken);
  assert.equal(viaOauth.value.ok,true);
  const note=await legacy.call('jobs.add_note',{jobId:job.id,body:'Synthetic crew note'},oauthToken);
  assert.equal(note.value.ok,true);
  const actorFor=async id=>(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId,id))).map(row=>row.actor);
  assert.deepEqual(await actorFor(created.value.task.id),['mcp-service-grant']);
  assert.deepEqual(await actorFor(viaOauth.value.task.id),[`mcp-oauth-grant:${grantId}`]);
  assert.deepEqual(await actorFor(job.id),[`mcp-oauth-grant:${grantId}`]);
  assert.equal((await db.select().from(schema.jobNotes))[0].createdBy,`mcp-oauth-grant:${grantId}`);
  assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actor,'chatgpt-mcp'))).length,0);
});
test('tasks.search filters in SQL and finds a task older than the 500 most recent',async()=>{
  const [old]=await db.insert(schema.tasks).values({title:'Old job task',status:'blocked',priority:'urgent',jobId:job.id,contactId:contact.id,dueAt:new Date('2020-02-01T00:00:00Z'),updatedAt:new Date('2020-01-01T00:00:00Z')}).returning();
  await db.insert(schema.tasks).values(Array.from({length:505},(_,i)=>({title:`Recent ${i}`,updatedAt:new Date(Date.UTC(2026,8,1,0,i))})));
  const byJob=await legacy.call('tasks.search',{jobId:job.id,limit:10});
  assert.deepEqual(byJob.value.items.map(t=>t.id),[old.id]);assert.equal(byJob.value.page.nextCursor,null);assert.equal(byJob.value.coverage.complete,true);
  for(const filter of [{status:'blocked'},{priority:'urgent'},{contactId:contact.id},{dueBefore:'2020-03-01T00:00:00Z'},{dueAfter:'2020-01-15T00:00:00Z'},{dueAfter:'2020-02-01T00:00:00Z',dueBefore:'2020-02-01T00:00:00Z'}])
    assert.deepEqual((await legacy.call('tasks.search',filter)).value.items.map(t=>t.id),[old.id],JSON.stringify(filter));
  assert.deepEqual((await legacy.call('tasks.search',{dueBefore:'2020-01-31T23:59:59Z'})).value.items,[]);
  const recent=await legacy.call('tasks.search',{status:'open',limit:3});
  assert.deepEqual(recent.value.items.map(t=>t.title),['Recent 504','Recent 503','Recent 502']);assert.ok(recent.value.page.nextCursor);
});
test('leads.search filters canonical state in SQL beyond the 500 most recent leads',async()=>{
  const contacts=await db.insert(schema.contacts).values(Array.from({length:504},(_,i)=>({provider:'ghl',providerId:`synthetic-lead-${i}`,name:`Synthetic lead ${i}`}))).returning();
  const at=minutes=>new Date(Date.UTC(2099,0,1,0,minutes));
  // Fixed future creation times stay inside any lookback window without reading the clock.
  const leads=await db.insert(schema.leads).values(contacts.map((c,i)=>({contactId:c.id,currentState:i===1||i===2?'BOOKED':'NEVER_CONTACTED',createdAt:i<3?at(i):at(100+i)}))).returning();
  await db.insert(schema.customerStateSnapshots).values([
    {contactId:contacts[0].id,leadId:leads[0].id,state:'JOB_SOLD',intentStage:'sold',pipeline:'direct_job',reconciliationStatus:'reconciled',snapshot:{state:'JOB_SOLD'},coverage:{complete:true},lastReconciledAt:at(0)},
    {contactId:contacts[1].id,leadId:leads[1].id,state:'NEW_LEAD',intentStage:'new',pipeline:'walkthrough',reconciliationStatus:'reconciled',snapshot:{state:'NEW_LEAD'},coverage:{complete:true},lastReconciledAt:at(1)}
  ]);
  const booked=await legacy.call('leads.search',{state:'BOOKED',limit:10});
  assert.deepEqual(booked.value.items.map(row=>row.contact.id),[contacts[2].id,contacts[0].id]);
  const sold=booked.value.items[1];
  assert.equal(sold.lead.currentState,'JOB_SOLD');assert.equal(sold.lead.providerState,'NEVER_CONTACTED');assert.equal(sold.operational.state,'JOB_SOLD');
  assert.equal(booked.value.items[0].operational.coverage.error,'customer_not_reconciled');
  // A legacy limit of 500 is still accepted; it is served 200 per page and the cursor reaches every match (501 provider NEVER_CONTACTED plus the NEW_LEAD snapshot), never truncating silently.
  const seen=[];let cursor,pages=0;
  do{const r=await legacy.call('leads.search',{state:'NEVER_CONTACTED',limit:500,...(cursor?{cursor}:{})});assert.equal(r.isError,false);assert.ok(r.value.items.length<=200);seen.push(...r.value.items.map(row=>row.contact.id));cursor=r.value.page.nextCursor;pages++;}while(cursor&&pages<10);
  assert.equal(pages,3);assert.equal(seen.length,502);assert.equal(new Set(seen).size,502);assert.ok(!seen.includes(contacts[0].id));assert.ok(seen.includes(contacts[1].id));
  assert.equal((await legacy.call('leads.search',{limit:5})).value.items.length,5);
});
test('operations mode refuses one-step sends before any execution record, even with write scope',async()=>{
  for(const name of ['conversations.send_message','send_sms','egc.send_followup']){
    const r=await operations.call(name,{requestId:'3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70',contactId:contact.id,channel:'SMS',body:'Synthetic',contextReviewed:true});
    assert.equal(r.isError,true);assert.equal(r.value.error,'direct_send_disabled_in_operations_mode');
  }
  assert.equal((await db.select().from(schema.communicationExecutions)).length,0);
  assert.equal((await db.select().from(schema.auditLogs)).length,0);
});
