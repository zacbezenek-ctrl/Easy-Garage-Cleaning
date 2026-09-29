// The signed-in Employee Hub for device specs: the real employee.html with the Firebase compat SDK stubbed and every Hub
// API answered from synthetic long-name data (the same shapes tests/browser/hub_shell_harness.py serves). Only
// 127.0.0.1 and the stubbed www.gstatic.com scripts are reached; the guard in test.mjs aborts everything else.
import {moneyProjection} from '../../../functions/_lib/money-service.js';
import {NOW} from './test.mjs';

export const DAY='2026-09-22';
export const LONG_NAME='Maximiliana Van Der Westhuizen-Oyelaran Family Trust Garage';
export const LONG_ADDRESS='12345 East County Road 38 Unit 1204B, Building Seventeen, Fort Collins, CO 80525-9921';
export const MANAGER={ok:true,user:'ZacB',displayName:'Synthetic Owner',role:'owner',businessAccess:true,payType:'owner',hourlyRate:0};
export const CREW={ok:true,user:'Synthetic.Crew',displayName:'Synthetic Crew',role:'crew',businessAccess:false,payType:'hourly',hourlyRate:20};
const DONE={onboardingCompletedAt:'2026-09-01T15:00:00Z',onboardingVersion:'2026-09-location-v2'};

export const JOBS=[
 {id:'job-today',type:'job',customer:LONG_NAME,phone:'9705550100',email:'synthetic@example.invalid',address:LONG_ADDRESS,date:DAY,time:'08:00',endDate:DAY,endTime:'11:00',status:'scheduled',pipelineStatus:'scheduled',
  assignedTo:'Synthetic.Crew',assignedCrew:['synthetic.crew'],crewNeeded:2,priceQuoted:2250,total:2250,notes:'Keep the workbench and the labelled holiday bins. '.repeat(6),serviceType:'Garage cleanout',syncStatus:'synced',shiftPickupEnabled:true,notify:false},
 {id:'walk-today',type:'walkthrough',customer:'Synthetic Walkthrough Lead',phone:'9705550101',address:'456 Synthetic Ave, Fort Collins, CO',date:DAY,time:'13:00',endDate:DAY,endTime:'14:00',status:'scheduled',syncStatus:'synced',notify:false},
 {id:'job-done',type:'job',customer:`${LONG_NAME} (second bay)`,phone:'9705550102',address:LONG_ADDRESS,date:'2026-09-15',time:'09:00',endDate:'2026-09-15',endTime:'12:00',status:'completed',completedAt:'2026-09-15T19:00:00Z',
  total:1800,priceQuoted:1800,assignedCrew:['synthetic.crew'],assignedTo:'Synthetic.Crew',notify:false,syncStatus:'synced',invoice:{number:'INV-1001',status:'issued',dueDate:'2026-09-30',amount:1800}},
];

const FIREBASE=`(function(){
const snap=name=>({docs:(name==='jobs'?(window.__egcJobs||[]):[]).map(row=>({id:row.id,data:()=>({...row})}))});
const ref=name=>({onSnapshot(next){setTimeout(()=>next(snap(name)),0);return()=>{};},add:async()=>({id:'synthetic'}),get:async()=>snap(name),where(){return this;},orderBy(){return this;},limit(){return this;},
  doc(){return{set:async()=>{},update:async()=>{},delete:async()=>{},get:async()=>({exists:false,data:()=>({})})};}});
const db={collection:ref,batch:()=>({set(){},update(){},delete(){},commit:async()=>{}}),runTransaction:async()=>{throw new Error('Synthetic transactions are unavailable');}};
window.firebase={initializeApp(){},firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=>({synthetic:'serverTimestamp'})}}),auth:()=>({signInWithCustomToken:async()=>({}),signOut:async()=>{}})};
})();`;

const collections=profile=>({
 profiles:[{id:'zacb',username:'ZacB',displayName:'Synthetic Owner',role:'owner',status:'active',hourlyRate:0,...DONE},{id:'synthetic.crew',username:'Synthetic.Crew',displayName:'Synthetic Crew',role:'crew',status:'active',hourlyRate:20,jobTitle:'Field crew',...DONE}],
 timeEntries:[{id:'time-1',employee:profile.user,status:'submitted',approvalStatus:'pending',clockInAt:DAY+'T14:00:00Z',clockOutAt:DAY+'T17:00:00Z',hourlyRate:20,jobLabel:LONG_NAME}],
 announcements:[{id:'announcement-1',title:'Synthetic crew update',body:'Meet at the shop at 7 with gloves and water.',priority:'normal',createdAt:'2026-09-21T15:00:00Z',createdBy:'ZacB',readBy:[],status:'active'}],
 requests:[{id:'request-1',employee:'Synthetic.Crew',type:'time_off',status:'pending',date:'2026-09-25',reason:'Synthetic appointment',createdAt:'2026-09-20T15:00:00Z'}],
 incidents:[],equipment:[],training:[],teamMessages:[{id:'message-1',body:'Synthetic hello team',sender:'ZacB',senderName:'Synthetic Owner',createdAt:DAY+'T15:00:00Z',updatedAt:DAY+'T15:00:00Z',status:'active'}],jobMessages:[],messageReads:[],
});

// The finance board's Record payment opens the server money dialog (moneyApi on); its job is the real projection.
const MONEY=moneyProjection({id:'job-done',revision:'r1',type:'job',customerId:'c1',customer:LONG_NAME,serviceType:'Garage cleanout',date:'2026-09-15',status:'completed',pipelineStatus:'completed',phone:'9705550100',total:1800,
 estimate:{number:'EST-SYN1',status:'accepted',revision:1,amount:1800,depositRequired:0,scope:'Synthetic cleanout.',validUntil:'2026-10-06',lineItems:[{id:'line-1',kind:'service',name:'Garage cleanout',description:'',quantity:1,unitCents:180000,totalCents:180000,amount:1800}]},
 customerApproval:{status:'approved',amount:1800},invoice:{number:'INV-1001',status:'issued',amount:1800,dueDate:'2026-09-30',issuedAt:'2026-09-15T19:00:00.000Z'}},'2026-09-22T18:00:00.000Z');

function answer(profile,{method,url}){
 const path=url.pathname,view=url.searchParams.get('view')||'';
 if(path==='/api/hub-auth')return profile?[200,profile]:[401,{ok:false,error:'Sign in required'}];
 if(path==='/api/firebase-session')return [200,{ok:true,token:'synthetic-token'}];
 if(path==='/api/integration-status')return [200,{ok:true,status:{highlevel:true,firebase:true,employeeAccounts:true,customerPortal:true},flags:{moneyApi:true}}];
 if(path==='/api/highlevel'&&view==='command')return [200,{ok:true,pipelines:[{id:'pipeline-1',stages:[{id:'stage-1',name:'New lead'}]}],leadResetAt:'2026-09-03T00:00:00Z',opportunities:[{id:'opportunity-1',name:LONG_NAME,pipelineStageId:'stage-1',monetaryValue:2250,status:'open',source:'Website',contact:{name:LONG_NAME,phone:'9705550111'}}]}];
 if(path==='/api/highlevel'&&method==='GET')return [200,{ok:true,events:[],contacts:[]}];
 if(path==='/api/employee-hub'&&method==='GET')return [200,{ok:true,collections:collections(profile),accounts:[]}];
 if(path==='/api/employee-accounts')return [200,{ok:true,accounts:[]}];
 if(path==='/api/crew-jobs')return [200,{ok:true,jobs:JOBS}];
 if(path==='/api/field-jobs')return [200,{ok:true,jobs:[{...JOBS[0],crewMembers:[{id:'synthetic.crew',name:'Synthetic Crew'}],crewLead:'synthetic.crew',vehicleName:'Synthetic truck'}],generatedAt:NOW}];
 if(path==='/api/dispatch'&&method==='GET')return [200,{ok:true,viewer:{id:'zacb'},timeZone:'America/Denver',jobs:[{...JOBS[0],revision:'rev-1',startAt:DAY+'T08:00:00-06:00',endAt:DAY+'T11:00:00-06:00'}],
  roster:[{id:'synthetic.crew',name:'Synthetic Crew',role:'crew'},{id:'zacb',name:'Synthetic Owner',role:'owner'}],crews:[],vehicles:[],availability:[],warnings:[],coverage:{complete:true,asOf:NOW},startDate:url.searchParams.get('startDate')||DAY,endDate:url.searchParams.get('endDate')||'2026-09-29'}];
 if(path==='/api/crew-availability'&&method==='GET')return [200,{ok:true,timeZone:'America/Denver',employee:{id:'synthetic.crew',name:'Synthetic Crew'},startDate:DAY,endDate:'2026-10-22',availability:[],exceptions:[],coverage:{complete:true}}];
 if(path==='/api/recurring-plans'&&method==='GET')return [200,{ok:true,enabled:true,plans:[],roster:[{id:'synthetic.crew',name:'Synthetic Crew',role:'crew'}],viewer:{id:'zacb'},coverage:{complete:true}}];
 if(path==='/api/money'&&method==='GET')return [200,{ok:true,authority:'employee_hub',enabled:true,viewer:{id:'zacb'},job:{...MONEY,id:url.searchParams.get('jobId')},asOf:NOW}];
 if(path==='/api/operations'&&method==='GET')return [200,{ok:true,enabled:false,actor:{id:'zacb',role:'owner',kind:'human'},owners:[{id:'zacb',name:'Synthetic Owner',role:'owner'}]}];
 return [503,{ok:false,error:'Synthetic service unavailable'}];
}

// Wires the stubs and API fixtures before the page loads. profile null is the signed-out Hub.
export async function hubFixtures(page,{profile=MANAGER}={}){
 await page.route(url=>url.hostname==='www.gstatic.com',route=>route.fulfill({status:200,contentType:'application/javascript',body:route.request().url().endsWith('/firebase-app-compat.js')?FIREBASE:''}));
 await page.addInitScript(jobs=>{window.__egcJobs=jobs;},JOBS);
 await page.route(url=>url.hostname==='127.0.0.1'&&url.pathname.startsWith('/api/'),async route=>{
  const request=route.request(),[status,body]=answer(profile,{method:request.method(),url:new URL(request.url())});
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
}

// Screens are ready when #ops-main has content and no screen shows a loading skeleton (a DOM condition, not a delay).
export async function hubReady(page){
 await page.waitForFunction(()=>document.querySelector('#ops-main')?.children.length>0&&window.EGCHubScreens&&!document.querySelector('#ops-main :is(.hub-screen-loading,.hub-skeleton,.ac-loading,.dp-loading,.st-loading,.rv-loading,.fh-loading,[class*="-skeleton"])'));
}
