import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const {getDb,schema}=await import('@egc/database');
const {eq}=await import('drizzle-orm');
const {consumeServiceNonce}=await import('../dist/service-bridge.js');
const db=getDb(),issuer=`https://synthetic-${randomUUID()}.invalid`;
after(async()=>{await db.delete(schema.operationsServiceNonces).where(eq(schema.operationsServiceNonces.issuer,issuer));await db.$client.end({timeout:5});});
test('concurrent envelopes claim one durable nonce and new nonce permits logical retry',async()=>{
 const nonce=randomUUID(),expiry=Math.floor(Date.now()/1000)+60;
 const results=await Promise.all(Array.from({length:32},()=>consumeServiceNonce(issuer,nonce,expiry)));
 assert.equal(results.filter(Boolean).length,1);assert.equal(await consumeServiceNonce(issuer,nonce,expiry),false);
 assert.equal(await consumeServiceNonce(issuer,randomUUID(),expiry),true);
 const rows=await db.select().from(schema.operationsServiceNonces).where(eq(schema.operationsServiceNonces.issuer,issuer));assert.equal(rows.length,2);
});
