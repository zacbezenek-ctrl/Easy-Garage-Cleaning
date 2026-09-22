import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchStorage, dispatchRoster } from '../functions/_lib/dispatch-storage.js';

const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const document = (id,fields={}) => ({name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,updateTime:'2026-09-22T12:00:00.000001Z',fields});

test('storage fully paginates with field masks and authoritative updateTime revisions',async () => {
  const calls=[];
  const store=dispatchStorage({},async (env,url)=>{
    calls.push(new URL(url));
    return calls.length===1 ? response({documents:[document('one',{type:{stringValue:'job'},customer:{stringValue:'Name'}})],nextPageToken:'page-two'}) : response({documents:[document('two',{type:{stringValue:'walkthrough'}})]});
  });
  const jobs=await store.jobs();
  assert.equal(jobs.length,2);assert.equal(jobs[0].revision,'2026-09-22T12:00:00.000001Z');
  assert.equal(calls[1].searchParams.get('pageToken'),'page-two');
  const mask=calls[0].searchParams.getAll('mask.fieldPaths');
  assert.ok(mask.includes('assignedCrew'));assert.ok(mask.includes('endDate'));assert.ok(!mask.includes('sealedPayload'));assert.ok(!mask.includes('payment'));
});

test('partial, duplicate and stalled result sets fail closed instead of omitting conflict records',async () => {
  for (const bodies of [[{documents:{bad:true}}],[{documents:[document('one')],nextPageToken:'again'},{documents:[document('one')]}],[{nextPageToken:'again'},{nextPageToken:'again'}]]) {
    let index=0;
    const store=dispatchStorage({},async()=>response(bodies[Math.min(index++,bodies.length-1)]));
    await assert.rejects(store.jobs(),error=>error.code==='dispatch_storage_incomplete');
  }
  await assert.rejects(dispatchStorage({},async()=>response({error:'unavailable'},503)).jobs(),error=>error.code==='dispatch_storage_unavailable');
});

test('corrupt pagination, document identity and missing revisions cannot masquerade as complete schedule data',async()=>{
  for(const body of [null,[],{nextPageToken:0},{nextPageToken:{opaque:true}},{documents:[{...document('job'),updateTime:''}]},{documents:[{...document('job'),fields:[]}]},{documents:[{...document('job'),name:'projects/egcw-1ec83/databases/(default)/documents/customers/job'}]}]) {
    await assert.rejects(dispatchStorage({},async()=>response(body)).jobs(),error=>error.code==='dispatch_storage_incomplete');
  }
  await assert.rejects(dispatchStorage({},async()=>response(document('other'))).read('jobs','requested'),error=>error.code==='dispatch_storage_incomplete');
  const valid=await dispatchStorage({},async()=>response(document('requested',{id:{stringValue:'fake-stored-id'}}))).read('jobs','requested');
  assert.equal(valid.id,'requested');assert.ok(valid.revision);
});

test('all writes use create-only or exact revision and a single atomic commit',async () => {
  let sent;
  const store=dispatchStorage({},async (env,url,options)=>{sent={url,body:JSON.parse(options.body)};return response({writeResults:[]});});
  await store.commit([{collection:'jobs',id:'job',revision:'r1',patch:{date:'2026-09-23',assignedCrew:['crew1']}},{collection:'dispatchOperations',id:'receipt',patch:{actorId:'manager'}}]);
  assert.ok(String(sent.url).endsWith(':commit'));
  assert.deepEqual(sent.body.writes[0].currentDocument,{updateTime:'r1'});
  assert.deepEqual(sent.body.writes[1].currentDocument,{exists:false});
  assert.deepEqual(sent.body.writes[0].updateMask.fieldPaths,['date','assignedCrew']);
  assert.deepEqual(sent.body.writes[0].update.fields.assignedCrew,{arrayValue:{values:[{stringValue:'crew1'}]}});
});

test('revision failures differ from uncertain commit outcomes for safe UI retry behavior',async () => {
  for (const status of [409,412]) await assert.rejects(dispatchStorage({},async()=>response({},status)).commit([]),error=>error.code==='dispatch_revision_conflict'&&error.status===409);
  for (const fetcher of [async()=>response({},503),async()=>{throw new Error('network');}]) await assert.rejects(dispatchStorage({},fetcher).commit([]),error=>error.code==='dispatch_outcome_unknown'&&error.status===503);
});

test('server roster exposes configured identities without password hashes, rates, or invented employees',async () => {
  const roster=await dispatchRoster({HUB_AUTH_USERS_JSON:JSON.stringify({zacb:{passwordHash:'a'.repeat(64),displayName:'Owner',role:'owner',hourlyRate:500},'New.User':{passwordHash:'b'.repeat(64),displayName:'New Employee',role:'crew'}})});
  assert.deepEqual(roster.map(person=>person.id).sort(),['new.user','zacb']);
  for (const person of roster) assert.deepEqual(Object.keys(person).sort(),['id','name','role']);
});
