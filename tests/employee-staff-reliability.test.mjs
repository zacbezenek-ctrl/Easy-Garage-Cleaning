import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument, storage, FixedDate } from './helpers/hub-dom.mjs';

const source = name => readFileSync(new URL('../'+name, import.meta.url), 'utf8');
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
function page(name, expose='') {
  const document=createDocument(), events={}, requests=[];
  const context={document,Node:document.Node,Date:FixedDate,Intl,URLSearchParams,AbortController,crypto,console,
    sessionStorage:storage(),localStorage:storage(),navigator:{onLine:true},location:{search:''},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    addEventListener(name,cb){(events[name]||=[]).push(cb);},
    fetch:(url,init)=>new Promise(resolve=>requests.push({url,init,resolve}))};
  context.window=context;vm.createContext(context);
  vm.runInContext(source(name).replace(/\}\)\(\);\s*$/,expose+'})();'),context);
  const host=document.createElement('main');document.body.append(host);
  return {context,host,requests,events,run:name=>vm.runInContext(source(name),context),fire:name=>(events[name]||[]).forEach(cb=>cb())};
}
const dispatchData = (jobs=[], complete=true) => ({ok:true,viewer:{id:'zacb'},jobs,roster:[],crews:[],vehicles:[],availability:[],warnings:[],coverage:{complete}});
const job={id:'synthetic-job',type:'job',date:'2026-09-22',endDate:'2026-09-22',time:'09:00',endTime:'10:00',customer:'Synthetic assignment',status:'scheduled',assignedCrew:[]};

test('dispatch never reports an empty day or zero counts during pending, failed or incomplete reads', async()=>{
 const p=page('employee-dispatch.js');p.run('employee-dispatch-calendar.js');
 const api=p.context.EGCDispatch;api.mount(p.host);
 assert.match(p.host.textContent,/Loading the Hub schedule/);
 assert.doesNotMatch(p.host.textContent,/No jobs match|No work scheduled|Nothing is waiting/);
 p.requests[0].resolve(reply(dispatchData()));await flush();
 assert.match(p.host.textContent,/No jobs match/,'a verified empty response is allowed');
 const pending=api.refresh({quiet:true});
 assert.match(p.host.textContent,/Loading the Hub schedule/);
 assert.doesNotMatch(p.host.textContent,/No jobs match|No work scheduled|Nothing is waiting/);
 assert.equal(p.host.querySelector('.dp-stats'),null);
 const create=p.host.querySelectorAll('button').find(b=>b.textContent==='Create job');
 assert.ok(create.hasAttribute('disabled')||create.disabled);
 p.requests[1].resolve(reply({ok:false,error:'Synthetic schedule unavailable'},503));await pending;
 assert.match(p.host.textContent,/Synthetic schedule unavailable/);
 assert.doesNotMatch(p.host.textContent,/No jobs match|No work scheduled|Nothing is waiting/);
 assert.equal(p.host.querySelector('.dp-stats'),null);
 for(const view of ['day','week','crew','jobs','queue','month','lanes']){
   api.internals.state().view=view;
   const read=api.refresh();p.requests.at(-1).resolve(reply(dispatchData([],false)));await read;
   assert.match(p.host.textContent,/schedule is incomplete/,view);
   assert.doesNotMatch(p.host.textContent,/No jobs match|No work scheduled|Nothing is waiting/,view);
   assert.equal(p.host.querySelector('.dp-stats'),null,view);
 }
 api.internals.state().view='day';const recovered=api.refresh();p.requests.at(-1).resolve(reply(dispatchData([job])));await recovered;
 assert.equal(api.internals.state().error,'');
});

test('dispatch hides stale assignments during date navigation and ignores superseded and signed-out responses',async()=>{
 const p=page('employee-dispatch.js'),api=p.context.EGCDispatch;api.mount(p.host);
 p.requests[0].resolve(reply(dispatchData([job])));await flush();
 assert.match(p.host.textContent,/Synthetic assignment/);
 api.internals.show('day','2026-09-23');
 assert.doesNotMatch(p.host.textContent,/Synthetic assignment|No jobs match/);
 const latest=api.refresh();p.requests[2].resolve(reply(dispatchData()));await latest;
 p.requests[1].resolve(reply(dispatchData([job])));await flush();
 assert.doesNotMatch(p.host.textContent,/Synthetic assignment/);
 const old=api.refresh();p.fire('egc:signout');p.requests[3].resolve(reply(dispatchData([job])));await old;
 assert.equal(api.internals.state().data,null);
 assert.equal(p.host.textContent,'');
});

const certificate=()=>({ok:true,revision:'synthetic-r1',insurance:{state:'current',available:true,expiresOn:'2027-03-01'},history:[],driveConfigured:true});
function portal(){const p=page('employee-portal-documents.js','globalThis.state=S;globalThis.submit=submit;');p.context.EGCPortalDocuments.mount(p.host);return p;}

test('portal documents remove Current, download and mutation controls after a 503 or malformed refresh',async()=>{
 const p=portal();p.requests[0].resolve(reply(certificate()));await flush();
 assert.match(p.host.textContent,/Current/);assert.equal(p.host.querySelectorAll('.pd-link').length,1);
 p.context.state.file={name:'Selected.pdf',size:100,dataUrl:'synthetic'};p.context.state.expiresOn='2027-04-01';
 for(const result of [reply({ok:false,error:'Synthetic outage'},503),reply({ok:true})]){
   const refresh=p.context.EGCPortalDocuments.refresh();
   assert.doesNotMatch(p.host.textContent,/Current|Customers can download/,'pending reads do not advertise old verification');
   p.requests.at(-1).resolve(result);await refresh;
   assert.doesNotMatch(p.host.textContent,/Current|Customers can download|Open the saved PDF/);
   assert.equal(p.host.querySelectorAll('form').length,0);
   assert.equal(p.context.state.file.name,'Selected.pdf');assert.equal(p.context.state.expiresOn,'2027-04-01');
   const retry=p.context.EGCPortalDocuments.refresh();p.requests.at(-1).resolve(reply(certificate()));await retry;
   assert.match(p.host.textContent,/Current/);
 }
});

test('an unverified certificate save keeps the same retry request without claiming the old certificate is Current',async()=>{
 const p=portal();p.requests[0].resolve(reply(certificate()));await flush();
 const body={action:'withdraw',requestId:'synthetic-request',expectedRevision:'synthetic-r1'};
 const pending=p.context.submit(body);p.requests[1].resolve(reply({ok:false,error:'Save outcome unknown'},503));await pending;
 assert.equal(p.context.state.uncertain,true);assert.equal(p.context.state.request,body);
 assert.doesNotMatch(p.host.textContent,/Current|Open the saved PDF/);
 assert.match(p.host.textContent,/Retry original withdrawal/);
 assert.match(p.host.textContent,/save outcome are unverified/);assert.doesNotMatch(p.host.textContent,/Nothing was changed/);
 const retry=p.context.submit(p.context.state.request);
 assert.equal(p.requests[2].init.body,p.requests[1].init.body);
 p.requests[2].resolve(reply({...certificate(),insurance:{state:'missing',available:false,expiresOn:''}}));await retry;
 assert.equal(p.context.state.request,null);assert.equal(p.context.state.uncertain,false);
});

test('a lost certificate upload retains only a locked upload form beside the exact original retry',async()=>{
 const p=portal();p.requests[0].resolve(reply(certificate()));await flush();
 p.context.state.file={name:'Selected.pdf',size:100,dataUrl:'synthetic'};p.context.state.expiresOn='2027-04-01';
 const body={action:'upload',requestId:'synthetic-upload',expectedRevision:'synthetic-r1',filename:'Selected.pdf',dataUrl:'synthetic',expiresOn:'2027-04-01'};
 const pending=p.context.submit(body);p.requests[1].resolve(reply({ok:false,error:'Save outcome unknown'},503));await pending;
 assert.equal(p.context.state.request,body);assert.match(p.host.textContent,/Retry original upload/);
 const upload=p.host.querySelectorAll('button').find(b=>b.textContent==='Upload certificate');assert.ok(upload);assert.equal(upload.hasAttribute('disabled'),true);
 assert.doesNotMatch(p.host.textContent,/Current|Open the saved PDF/);
});

test('portal authorization failures and logout cannot leave a downloadable stale certificate',async()=>{
 const p=portal();p.requests[0].resolve(reply(certificate()));await flush();
 for(const status of [401,403]){
   const read=p.context.EGCPortalDocuments.refresh();p.requests.at(-1).resolve(reply({ok:false,error:'Denied'},status));await read;
   assert.equal(p.context.state.data,null);assert.equal(p.host.querySelectorAll('.pd-link').length,0);
 }
 const stale=p.context.EGCPortalDocuments.refresh();p.fire('egc:signout');p.requests.at(-1).resolve(reply(certificate()));await stale;
 assert.equal(p.context.state.data,null);assert.equal(p.host.textContent,'');
});

function agenda(){
 const context={Date:FixedDate,Intl,URLSearchParams,console,sessionStorage:storage({egc_u:'ZacB',egc_business_access:'true',egc_owner:'true',egc_role:'owner'}),localStorage:storage(),navigator:{},location:{search:''},jobsCache:[],
  managerScheduleState:{loaded:true,loading:false,error:'',fromCache:false,pending:false},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},addEventListener(){},
  document:{readyState:'loading',querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}}};
 context.window=context;vm.createContext(context);vm.runInContext(source('employee-suite.js').replace(/\}\)\(\);\s*$/,'globalThis.api={agenda,metrics,S,todayJobs};})();'),context);return context;
}

test('manager agenda has truthful today and tomorrow lists, continuous spans and discrete segments',()=>{
 const p=agenda();p.jobsCache=[job,{...job,id:'tomorrow',customer:'Tomorrow only',date:'2026-09-23',endDate:'2026-09-23'},
  {...job,id:'continuous',customer:'Continuous Mon-Wed',date:'2026-09-21',endDate:'2026-09-23'},
  {...job,id:'split',customer:'Mon and Wed only',date:'2026-09-21',endDate:'2026-09-23',assignmentSegments:[{date:'2026-09-21',time:'08:00',endTime:'09:00'},{date:'2026-09-23',time:'08:00',endTime:'09:00'}]},
  {...job,id:'midnight',customer:'Released Tuesday midnight',date:'2026-09-21',endDate:'2026-09-22',endTime:'00:00'}];
 assert.match(p.api.agenda(),/Synthetic assignment|Continuous Mon-Wed/);
 assert.doesNotMatch(p.api.agenda(),/Tomorrow only|Mon and Wed only|Released Tuesday midnight/);
 assert.deepEqual(Array.from(p.api.todayJobs(),row=>row.id),['synthetic-job','continuous']);
 p.opsAgendaDay(1);const next=p.api.agenda();
 assert.match(next,/Tomorrow only/);assert.match(next,/Mon and Wed only/);assert.match(next,/Continuous Mon-Wed/);
 assert.doesNotMatch(next,/Synthetic assignment/);assert.match(next,/Field agenda for 2026-09-23/);
 p.jobsCache=[];assert.match(p.api.agenda(),/Nothing scheduled tomorrow/);
 p.opsAgendaDay(0);assert.match(p.api.agenda(),/Nothing scheduled today/);
 for(const state of [{loaded:false,loading:true},{loaded:true,error:'Read denied'},{loaded:true,fromCache:true},{loaded:true,pending:true}]){
   p.managerScheduleState=state;
   const metrics=p.api.metrics();assert.match(metrics,/<span>Walkthroughs today<\/span><strong>—<\/strong>/);assert.match(metrics,/<span>Jobs today<\/span><strong>—<\/strong>/);assert.match(metrics,/Schedule not verified/);
   assert.doesNotMatch(p.api.agenda(),/Nothing scheduled/);assert.match(p.api.agenda(),/Checking the Hub schedule|Schedule could not be verified/);
 }
});

test('manager schedule listener tracks cache and pending writes and invalidates failures immediately',()=>{
 const html=source('employee-suite.js'),listeners={},options={},state={};
 const context={_listenersStarted:false,_dataGeneration:1,_dataUnsubscribers:[],db:{collection:name=>({onSnapshot(...args){options[name]=args[0];listeners[name]=args.filter(arg=>typeof arg==='function');return()=>{};}})},
  canRunBusiness:()=>true,managerScheduleState:{},firebaseConn:{},jobsCache:[],custsCache:[],leadsCache:[],blockedDays:new Set(),blockedSlots:new Set(),window:{},Date:FixedDate,console:{error(){}},document:{getElementById:()=>null},
  updateFirebaseStatus(){},refresh(){state.refreshed=(state.refreshed||0)+1;},renderCustomersTab(){},updateLeadsBadge(){},_leadsTimer:null,setInterval:()=>1,clearInterval(){}};
 vm.createContext(context);const start=html.indexOf('function startListeners()'),end=html.indexOf('/* EGC Operating System',start);
 vm.runInContext(html.slice(start,end),context);context.startListeners();
 assert.equal(options.jobs.includeMetadataChanges,true);
 for(const metadata of [{fromCache:true},{hasPendingWrites:true},{}]){
   listeners.jobs[0]({docs:[],metadata});
   assert.equal(context.managerScheduleState.loaded,!metadata.fromCache&&!metadata.hasPendingWrites);
 }
 const before=state.refreshed;listeners.jobs[1](new Error('Synthetic failure'));
 assert.match(context.managerScheduleState.error,/could not be verified/);assert.equal(state.refreshed,before+1);
 context._dataGeneration++;listeners.jobs[0]({docs:[{id:'stale',data:()=>job}],metadata:{}});
 assert.equal(context.jobsCache.length,0,'a signed-out listener cannot restore old work');
});


test('malformed raw assignment segments cannot crash the manager agenda or masquerade as an empty day',()=>{
 const p=agenda();
 for(const assignmentSegments of [[null],['bad'],[{date:'2026-02-30'}],{date:'2026-09-22'}]){
   p.jobsCache=[{...job,assignmentSegments}];
   assert.doesNotThrow(()=>p.api.todayJobs());
   assert.match(p.api.agenda(),/Schedule could not be verified/);assert.doesNotMatch(p.api.agenda(),/Nothing scheduled/);
   assert.match(p.api.metrics(),/<span>Jobs today<\/span><strong>—<\/strong>/);
 }
 p.jobsCache=[{...job,date:'',endDate:'',assignmentSegments:[]}];assert.match(p.api.agenda(),/Nothing scheduled today/,'legitimate unscheduled work does not invent an assignment');
});
