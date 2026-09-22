import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const suite=readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../employee.html',import.meta.url),'utf8');

function timeHelpers(){
 const context=vm.createContext({Date,Intl});
 const display=suite.slice(suite.indexOf('const day='),suite.indexOf('const icons='));
 const instant=suite.slice(suite.indexOf('function hubLocalInstant('),suite.indexOf('const overlaps='));
 const pay=suite.match(/^function payPeriod\([^\n]+/m)[0];
 const workDate=suite.match(/^function timecardDate\([^\n]+/m)[0];
 vm.runInContext(display+instant+pay+'\n'+workDate+'\nglobalThis.api={dateLabel,timeLabel,hubLocalInstant,payPeriod,timecardDate};',context);
 return context.api;
}

test('job wall dates and start times remain Mountain Time on a phone set to Tokyo',()=>{
 const previous=process.env.TZ;process.env.TZ='Asia/Tokyo';
 try{
  const api=timeHelpers();
  assert.equal(api.dateLabel('2026-09-22'),'Tue, Sep 22');
  assert.equal(api.dateLabel('2026-09-22T08:00:00'),'Tue, Sep 22');
  assert.equal(api.timeLabel('2026-09-22T08:00:00'),'8:00 AM');
  assert.equal(api.dateLabel('2026-09-22T05:45:00Z'),'Mon, Sep 21');
  assert.equal(api.timeLabel('2026-09-22T05:45:00Z'),'11:45 PM');
  assert.equal(api.dateLabel('2026-02-30'),'TBD');
  assert.equal(api.dateLabel(''),'TBD');
  assert.equal(api.timeLabel(null),'');
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('missing and repeated DST wall times cannot silently pick a different appointment hour',()=>{
 const api=timeHelpers();
 assert.equal(api.hubLocalInstant('2026-03-08','02:30'),null);
 assert.equal(api.hubLocalInstant('2026-11-01','01:30'),null);
 assert.equal(api.hubLocalInstant('2026-03-08','03:30'),'2026-03-08T09:30:00.000Z');
 assert.equal(api.hubLocalInstant('2026-11-01','02:30'),'2026-11-01T09:30:00.000Z');
});

test('timecard grouping and pay periods use Denver midnight, including both DST changes',()=>{
 const api=timeHelpers();
 assert.equal(api.timecardDate({clockInAt:'2026-09-22T05:45:00Z'}),'2026-09-21');
 assert.equal(api.timecardDate({clockInAt:'2026-09-22T06:00:00Z'}),'2026-09-22');
 assert.equal(api.timecardDate({clockInAt:'bad'}),'');
 const before=api.payPeriod(new Date('2026-09-14T05:59:59Z'));
 const after=api.payPeriod(new Date('2026-09-14T06:00:00Z'));
 assert.equal(before.endDate,'2026-09-13');assert.equal(after.startDate,'2026-09-14');
 assert.equal(after.start.toISOString(),'2026-09-14T06:00:00.000Z');
 const spring=api.payPeriod(new Date('2026-03-08T15:00:00Z'));
 const fall=api.payPeriod(new Date('2026-11-01T15:00:00Z'));
 assert.equal(spring.startDate,'2026-03-02');assert.equal(spring.endDate,'2026-03-15');
 assert.equal((spring.end-spring.start+1)/3600000,335);
 assert.equal(fall.startDate,'2026-10-26');assert.equal(fall.endDate,'2026-11-08');
 assert.equal((fall.end-fall.start+1)/3600000,337);
});

function crewLoader(){
 const calls=[];let refreshes=0;
 const context=vm.createContext({_dataGeneration:1,jobsCache:[],custsCache:[],leadsCache:[],blockedDays:new Set(),blockedSlots:new Set(),firebaseConn:{},window:{},canRunBusiness:()=>false,
  hubFetch:(url,options)=>new Promise(resolve=>calls.push({url,options,resolve})),updateFirebaseStatus:()=>{},refresh:()=>refreshes++});
 vm.runInContext(html.slice(html.indexOf('let crewScheduleState='),html.indexOf('function startListeners()')),context);
 return {context,calls,refreshes:()=>refreshes,state:()=>vm.runInContext('crewScheduleState',context)};
}
const reply=(ok,jobs,status=ok?200:503)=>({ok,status,json:async()=>ok?{ok,jobs}:{ok:false,error:'Schedule temporarily unavailable'}});

test('crew schedule refresh is repeatable and coalesces concurrent requests',async()=>{
 const h=crewLoader(),first=h.context.refreshCrewSchedule(),second=h.context.refreshCrewSchedule();
 assert.equal(first,second);assert.equal(h.calls.length,1);
 h.calls[0].resolve(reply(true,[{id:'job-1'}]));assert.equal(await first,true);
 assert.equal(h.context.jobsCache[0].id,'job-1');assert.equal(h.state().loaded,true);
 const later=h.context.refreshCrewSchedule();assert.equal(h.calls.length,2);
 h.calls[1].resolve(reply(true,[{id:'job-2'}]));await later;
 assert.equal(h.context.jobsCache[0].id,'job-2');assert.equal(h.refreshes(),2);
});

test('a failed schedule refresh is explicit and does not pretend cached work is current',async()=>{
 const h=crewLoader(),first=h.context.refreshCrewSchedule();h.calls[0].resolve(reply(true,[{id:'job-1'}]));await first;
 const next=h.context.refreshCrewSchedule();h.calls[1].resolve(reply(false));assert.equal(await next,false);
 assert.equal(h.state().error,'Schedule temporarily unavailable');assert.equal(h.state().loading,false);
 assert.equal(h.context.firebaseConn.jobs,'error');assert.equal(h.context.jobsCache[0].id,'job-1');
 assert.match(suite,/function myShiftBoard\(\).*crewScheduleState\.error\)\)return scheduleUnavailable\(\)/);
});

test('a response from a signed-out crew session cannot repopulate another employee schedule',async()=>{
 const h=crewLoader(),old=h.context.refreshCrewSchedule();h.context._dataGeneration++;
 h.calls[0].resolve(reply(true,[{id:'private-old-assignment'}]));assert.equal(await old,false);
 assert.equal(h.context.jobsCache.length,0);assert.equal(h.refreshes(),0);
});
