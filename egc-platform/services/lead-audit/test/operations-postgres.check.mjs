/** Destructive fixtures are restricted to an explicitly named loopback test DB. */
import test, {beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {getDb, schema} from '@egc/database';
import {eq, sql} from 'drizzle-orm';
import {readExistingTaskQueue} from '../dist/operations-read.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (process.env.EGC_OPERATIONS_TEST !== 'isolated' ||
    !['localhost','127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/egc_operations_test' || !['postgres:','postgresql:'].includes(url.protocol)) {
  throw new Error('Integration tests require EGC_OPERATIONS_TEST=isolated and the loopback egc_operations_test database');
}
// This suite must never call communications providers or production HTTP APIs.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External HTTP is disabled in operations integration tests'); };
const db = getDb();
const options = () => ({dueBefore:new Date(Date.now()+86400000).toISOString(),timeZone:'America/Denver'});
const id = n => `${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const fixture = (n, extra={}) => ({id:id(n),title:`Synthetic task ${n}`,status:'open',priority:'medium',assignedUserId:'test-owner',dueAt:new Date(Date.now()-86400000),...extra});

beforeEach(async()=>{
  await db.delete(schema.operationEvents);
  await db.delete(schema.operationApprovals);
  await db.delete(schema.operationRequests);
  await db.delete(schema.operationBriefs);
  await db.delete(schema.tasks);
  await db.delete(schema.contacts);
});
after(async()=>{
  globalThis.fetch=originalFetch;
  await db.$client.end({timeout:5});
});

test('empty migrated database returns observed zero, not a false complete operational total',async()=>{
  const result=await readExistingTaskQueue(options());
  assert.equal(result.persisted,false);
  assert.equal(result.portalParityVerified,false);
  assert.equal(result.snapshot.counts.observedDue,0);
  assert.equal(result.snapshot.counts.totalDue,null);
  assert.ok(result.snapshot.issues.some(i=>i.code==='source_incomplete:portal_project_mapping'));
});

test('adapter actually opens a PostgreSQL repeatable-read, read-only transaction',async()=>{
  const original=db.transaction;
  let checked=false;
  db.transaction=(callback,config)=>original.call(db,async tx=>{
    const [s]=await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`);
    assert.equal(s.isolation,'repeatable read'); assert.equal(s.read_only,'on'); checked=true;
    return callback(tx);
  },config);
  try { await readExistingTaskQueue(options()); assert.equal(checked,true); }
  finally { db.transaction=original; }
});

test('501 old booked-customer commitments are retrieved across every source page',async()=>{
  const [contact]=await db.insert(schema.contacts).values({provider:'test',providerId:'synthetic-old-booked',name:'Synthetic customer'}).returning();
  await db.insert(schema.leads).values({contactId:contact.id,currentState:'BOOKED',createdAt:new Date(Date.now()-120*86400000)});
  const rows=Array.from({length:501},(_,i)=>fixture(i+1,{contactId:contact.id,createdAt:new Date(Date.now()-120*86400000)}));
  await db.insert(schema.tasks).values(rows);
  const result=await readExistingTaskQueue(options());
  assert.equal(result.snapshot.items.length,501);
  assert.equal(new Set(result.snapshot.items.map(t=>t.id)).size,501);
  assert.equal(result.snapshot.items.at(-1).id,id(501));
  assert.ok(result.snapshot.items.every(t=>t.revision===null));
});

test('closed and future tasks are excluded; blocked, undated and ownerless work is not hidden',async()=>{
  await db.insert(schema.tasks).values([
    fixture(1,{status:'completed'}),fixture(2,{status:'cancelled'}),fixture(3,{status:'superseded'}),
    fixture(4,{status:'blocked'}),fixture(5,{dueAt:null,assignedUserId:null}),
    fixture(6,{dueAt:new Date(Date.now()+7*86400000)})
  ]);
  const s=(await readExistingTaskQueue(options())).snapshot;
  assert.deepEqual(s.items.map(t=>t.id),[id(4)]);
  assert.ok(s.issues.some(i=>i.taskId===id(5)&&i.code==='due_time_missing'));
  assert.ok(s.issues.some(i=>i.taskId===id(5)&&i.code==='owner_missing'));
});

test('two jobs belonging to one customer preserve exact task-to-job identities',async()=>{
  const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'synthetic-two-jobs'}).returning();
  const jobs=await db.insert(schema.jobs).values([{contactId:c.id,serviceAddress:'Synthetic A'},{contactId:c.id,serviceAddress:'Synthetic B'}]).returning();
  await db.insert(schema.tasks).values([fixture(1,{contactId:c.id,jobId:jobs[0].id}),fixture(2,{contactId:c.id,jobId:jobs[1].id})]);
  const s=(await readExistingTaskQueue(options())).snapshot;
  assert.equal(s.items.find(t=>t.id===id(1)).jobId,jobs[0].id);
  assert.equal(s.items.find(t=>t.id===id(2)).jobId,jobs[1].id);
});

test('completion removes the same task ID from a new snapshot without rewriting the old snapshot',async()=>{
  await db.insert(schema.tasks).values(fixture(1));
  const before=(await readExistingTaskQueue(options())).snapshot;
  await db.update(schema.tasks).set({status:'completed',completedAt:new Date()}).where(eq(schema.tasks.id,id(1)));
  const after=(await readExistingTaskQueue(options())).snapshot;
  assert.equal(before.items[0].id,id(1)); assert.equal(after.items.length,0);
  assert.notEqual(before.id,after.id);
});

test('concurrent database changes between pages do not tear the reader snapshot',async()=>{
  await db.insert(schema.tasks).values(Array.from({length:501},(_,i)=>fixture(i+1)));
  const original=db.transaction;
  let changed=false;
  db.transaction=(callback,config)=>original.call(db,async tx=>{
    const select=tx.select.bind(tx);
    tx.select=(...args)=>{
      const builder=select(...args); const from=builder.from.bind(builder);
      builder.from=(...fromArgs)=>{
        const query=from(...fromArgs); const limit=query.limit.bind(query);
        query.limit=async (...limitArgs)=>{
          const page=await limit(...limitArgs);
          if(!changed){
            changed=true;
            await db.update(schema.tasks).set({title:'Changed in concurrent transaction'}).where(eq(schema.tasks.id,id(501)));
          }
          return page;
        };
        return query;
      };
      return builder;
    };
    return callback(tx);
  },config);
  try {
    const s=(await readExistingTaskQueue(options())).snapshot;
    assert.equal(changed,true); assert.equal(s.items.length,501);
    assert.equal(s.items.find(t=>t.id===id(501)).title,'Synthetic task 501');
  } finally { db.transaction=original; }
  const next=(await readExistingTaskQueue(options())).snapshot;
  assert.equal(next.items.find(t=>t.id===id(501)).title,'Changed in concurrent transaction');
});

test('database failure propagates instead of becoming a successful empty queue',async()=>{
  await db.execute(sql`ALTER TABLE public.tasks RENAME TO tasks_temporarily_unavailable`);
  try { await assert.rejects(readExistingTaskQueue(options())); }
  finally { await db.execute(sql`ALTER TABLE public.tasks_temporarily_unavailable RENAME TO tasks`); }
  assert.equal((await readExistingTaskQueue(options())).snapshot.counts.observedDue,0);
});
