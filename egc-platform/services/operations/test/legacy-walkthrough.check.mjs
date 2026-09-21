import test, {beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb, schema} from '@egc/database';
import {eq, sql} from 'drizzle-orm';
import {approveLegacyWalkthrough} from '../dist/index.js';
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (process.env.EGC_OPERATIONS_TEST !== 'isolated' || !['localhost','127.0.0.1'].includes(url.hostname) || url.pathname !== '/egc_operations_test' || !['postgres:','postgresql:'].includes(url.protocol)) throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch = async () => {throw new Error('External HTTP forbidden in legacy compatibility tests');};
const db = getDb(), env = {EGC_OPERATIONS_ENABLED: 'false', GHL_WRITEBACK_ENABLED: 'true'};
let contact, draft;
const approve = (source = 'mcp', customEnv = env, extraction) => approveLegacyWalkthrough({walkthroughId: draft.id, actor: `isolated-${source}`, source, extraction}, customEnv, db);
beforeEach(async () => {
  await db.execute(sql`truncate contacts,walkthroughs,jobs,outbox_events,audit_logs cascade`);
  [contact] = await db.insert(schema.contacts).values({provider: 'ghl', providerId: 'synthetic-legacy-contact'}).returning();
  [draft] = await db.insert(schema.walkthroughs).values({contactId: contact.id, status: 'draft', audioObjectKey: 'legacy/audio.webm', extraction: {garageSize:'2_car',bikeRacks:2,itemsRemove:['synthetic item'],evidence:{garageSize:{sourceQuote:'two car garage',confidence:1}}}}).returning();
});
after(async () => {await db.$client.end({timeout:5});});
test('flag-off legacy approval persists reviewed scope, audit and one durable provider note', async () => {
  const result = await approve(); assert.equal(result.ok,true); assert.equal(result.job.status,'scope_approved'); assert.deepEqual(result.job.addOns,['2 bike rack(s)']); assert.equal(result.extraction.evidence.garageSize.sourceQuote,'two car garage');
  const [stored] = await db.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id,draft.id)); assert.equal(stored.approvedBy,'isolated-mcp'); assert.equal(stored.jobId,result.jobId);
  const notes = await db.select().from(schema.outboxEvents); assert.equal(notes.length,1); assert.equal(notes[0].type,'ghl.contact_note.sync'); assert.equal(notes[0].payload.ghlContactId,contact.providerId);
  await assert.rejects(approve(), e=>e.code==='walkthrough_already_approved'); assert.equal((await db.select().from(schema.jobs)).length,1);
});
test('concurrent API and MCP approval cannot create competing jobs or provider notes', async () => {
  const results = await Promise.allSettled([approve('portal'),approve('mcp')]); assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.select().from(schema.jobs)).length,1); assert.equal((await db.select().from(schema.outboxEvents)).length,1);
});
test('activation blocks unlinked legacy records without changes', async () => {
  await assert.rejects(approve('mcp',{...env,EGC_OPERATIONS_ENABLED:'true'}), e=>e.code==='use_employee_hub_recording_review');
  assert.equal((await db.select().from(schema.jobs)).length,0); assert.equal((await db.select().from(schema.auditLogs)).length,0);
});
test('every managed linkage remains protected when the flag is disabled', async () => {
  const fields = ['portalVisitId','portalJobId','portalCustomerId','portalProjectId','portalRevision','uploadRequestId','uploadedBy','approvalRequestId','approvedRevision','approvalFingerprint'];
  for (const field of fields) {
    await db.update(schema.walkthroughs).set({[field]:'managed'}).where(eq(schema.walkthroughs.id,draft.id));
    await assert.rejects(approve(), e=>e.code==='use_employee_hub_recording_review');
    await db.update(schema.walkthroughs).set({[field]:null}).where(eq(schema.walkthroughs.id,draft.id));
  }
  await db.update(schema.walkthroughs).set({approvalPayload:{}}).where(eq(schema.walkthroughs.id,draft.id)); await assert.rejects(approve(), e=>e.code==='use_employee_hub_recording_review');
  assert.equal((await db.select().from(schema.jobs)).length,0); assert.equal((await db.select().from(schema.outboxEvents)).length,0);
});
test('wrong-contact job and non-draft records cannot receive scope', async () => {
  const [other] = await db.insert(schema.contacts).values({provider:'ghl',providerId:randomUUID()}).returning();
  const [job] = await db.insert(schema.jobs).values({contactId:other.id,status:'draft'}).returning();
  await db.update(schema.walkthroughs).set({jobId:job.id}).where(eq(schema.walkthroughs.id,draft.id)); await assert.rejects(approve(), e=>e.code==='job_not_found_for_contact');
  await db.update(schema.walkthroughs).set({jobId:null,status:'failed'}).where(eq(schema.walkthroughs.id,draft.id)); await assert.rejects(approve(), e=>e.code==='walkthrough_not_editable');
  assert.equal((await db.select().from(schema.jobs))[0].status,'draft');
});
test('portal approval preserves existing value and requires no outbound write when writeback is disabled', async () => {
  const [job] = await db.insert(schema.jobs).values({contactId:contact.id,priceCents:190000,depositCents:50000}).returning();
  await db.update(schema.walkthroughs).set({jobId:job.id}).where(eq(schema.walkthroughs.id,draft.id));
  const result = await approve('portal',{EGC_OPERATIONS_ENABLED:'false',GHL_WRITEBACK_ENABLED:'false'},{garageSize:'3_car',junkVolumeYards:0});
  assert.equal(result.job.priceCents,190000); assert.equal(result.job.depositCents,50000); assert.equal(result.job.junkVolumeYards,'0.00'); assert.equal(result.ghlWritebackQueued,false); assert.equal((await db.select().from(schema.outboxEvents)).length,0);
});
