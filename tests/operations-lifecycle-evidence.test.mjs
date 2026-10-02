import test from 'node:test';
import assert from 'node:assert/strict';
import {portalCalendar,portalJob,portalEvidence} from '../functions/_lib/operations-portal-records.js';
const value=v=>typeof v==='string'?{stringValue:v}:{nullValue:null};
const row={type:'job',date:'2026-10-02',time:'10:00',endTime:'11:00',status:'cancelled',highlevelContactId:'contact-a',cancelledAt:'2026-10-01T12:00:00Z',noShowAt:'2026-09-30T12:00:00Z',updatedAt:'2026-10-02T12:00:00Z'};
const doc={name:'projects/test/databases/(default)/documents/jobs/job-a',updateTime:row.updatedAt,fields:Object.fromEntries(Object.entries(row).map(([k,v])=>[k,value(v)]))};
const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
test('calendar, exact job and exact contact evidence retain original lifecycle timestamps',async()=>{
 const read=async(_env,url)=>{const u=new URL(url);if(u.pathname.endsWith('/job-a'))return response(doc);const mask=u.searchParams.getAll('mask.fieldPaths');assert.ok(mask.includes('cancelledAt'));assert.ok(mask.includes('noShowAt'));return response({documents:[doc]});};
 const calendar=await portalCalendar({},{startDate:'2026-10-01',endDate:'2026-10-04',timeZone:'America/Denver',offset:0,limit:50},read);
 const job=await portalJob({},'job-a',read);
 const evidence=await portalEvidence({},{contactProviderIds:['contact-a']},read);
 for(const record of [calendar.items[0],job.job,evidence.records[0]]){assert.equal(record.cancelledAt,row.cancelledAt);assert.equal(record.noShowAt,row.noShowAt);assert.equal(record.updatedAt,row.updatedAt);}
});
