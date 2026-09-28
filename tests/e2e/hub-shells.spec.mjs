// Signed-in and signed-out Hub shells with route() API fixtures (as in tests/browser/*.py).
// Crew job payloads come from the real fieldJobProjection so fixtures cannot drift.
import {fieldJobProjection} from '../../functions/_lib/field-execution.js';
import {test,expect,open,api,touch,NOW} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertCameraCapture,assertInputKeyboards,assertKnownMissingCamera,assertNoHorizontalScroll,assertTapTargets} from './helpers/mobile-invariants.mjs';

const DAY='2026-09-22';
const CUSTOMER={id:'customer-1',name:'Synthetic Johnson Garage',phone:'(970) 555-0100',email:'synthetic@example.invalid',address:'123 Synthetic Way, Fort Collins, CO'};
const ROSTER=[{id:'crew.one',name:'Crew One',role:'crew'},{id:'lead.one',name:'Lead One',role:'crew_lead'}];
const DISPATCH_JOB={id:'job-1',revision:'rev-1',type:'job',customerId:CUSTOMER.id,customer:CUSTOMER.name,phone:CUSTOMER.phone,address:CUSTOMER.address,date:DAY,time:'08:00',endDate:DAY,endTime:'10:00',startAt:DAY+'T08:00:00-06:00',endAt:DAY+'T10:00:00-06:00',status:'scheduled',assignedCrew:['crew.one','lead.one'],crewLead:'lead.one',crewId:'crew-main',vehicleId:'truck-1',crewNeeded:2,travelBufferMinutes:20,serviceType:'Garage cleanout',jobInstructions:'Clear the garage; preserve the workbench.',requiredEquipment:['Dolly'],materials:[{id:'shelves',name:'Shelving',quantity:2}],syncStatus:'not_needed'};
const DISPATCH={ok:true,viewer:{id:'manager.one'},timeZone:'America/Denver',jobs:[DISPATCH_JOB],roster:ROSTER,crews:[{id:'crew-main',revision:'crew-rev-1',name:'North Crew',memberIds:['crew.one','lead.one'],leadId:'lead.one',status:'active'}],vehicles:[{id:'truck-1',revision:'truck-rev-1',name:'Box Truck',status:'available',notes:'Check straps'}],availability:[],warnings:[],coverage:{complete:true,asOf:DAY+'T14:00:00Z'}};
const FIELD_DOC={id:'job-1',__updateTime:'2026-09-22T15:00:00.000000Z',type:'job',customer:CUSTOMER.name,phone:'9705550100',address:CUSTOMER.address,date:DAY,time:'08:00',endDate:DAY,endTime:'11:00',status:'scheduled',pipelineStatus:'scheduled',serviceType:'Garage cleanout',assignedCrew:['crew.one','lead.one'],crewLead:'lead.one',vehicleName:'Synthetic Box Truck',operationalScope:{text:'Clear the garage; preserve the workbench.'},requiredEquipment:['Dolly','Broom'],materials:[{id:'rack',name:'Wall rack',quantity:1}]};
const fieldJob=()=>fieldJobProjection(FIELD_DOC,[],{now:NOW,crewNames:{'crew.one':'Crew One','lead.one':'Lead One'}});
const CREW_SESSION={ok:true,user:'Crew.One',displayName:'Crew One',role:'crew',businessAccess:false};
const PORTAL={ok:true,customer:{name:'Synthetic Portal Customer',firstName:'Synthetic'},appointment:{date:'2026-09-24',time:'09:00',endTime:'12:30',arrivalWindow:'9:00 AM – 9:30 AM',address:'456 Synthetic Lane, Fort Collins',service:'Garage Turnaround',status:'scheduled'},
 estimate:{number:'EST-SYN-1',amount:1400,scope:'Synthetic garage cleanout, sorting and floor sweep.',status:'sent',validUntil:'2026-10-15',revision:1,depositRequired:700,lineItems:[{name:'Synthetic Garage Turnaround',description:'Bundled synthetic scope.',quantity:1,amount:1400}],terms:'Synthetic terms for layout tests only.'},
 payment:{total:1400,paid:0,balance:1400,dueNow:700,purpose:'deposit',creditApplied:0,invoiceNumber:'',dueDate:''},photos:{customerUploadCount:0},messaging:{highLevelLinked:false,refreshSeconds:20},
 conversation:[{id:'synthetic-1',direction:'to_customer',authorRole:'crew',authorName:'Synthetic Crew',body:'Synthetic arrival note for layout tests.',createdAt:'2026-09-22T15:07:00Z',delivery:{channel:'portal',status:'sent'}}],
 experience:{memory:{accessInstructions:'Synthetic side door.',parkingNotes:'',petNotes:'',importantItems:'',communicationPreference:'text',preferredCrew:''},jobDayRules:{awayMode:false,decisionMaker:'Synthetic Portal Customer',payer:'Synthetic Portal Customer',approvalLimit:100,noResponseAction:'call_backup',remoteCompletionAllowed:false},
  decisions:[{id:'decision-1',title:'Remove the synthetic cabinet?',details:'Synthetic decision for layout tests.',priceDelta:75,timeDeltaMinutes:20,status:'pending',promptedAt:NOW}],rebooking:[],giftWallet:{available:0,applied:0,cards:[]},garageGuard:{},collaborators:[]}};
const BUSINESS={account:{company:'Synthetic Property Group',billingEmail:'billing@example.invalid',reference:'PO-SYN'},viewer:{name:'Synthetic Admin',role:'admin',permissions:{request:true,team:true,approve:true,pay:true}},
 properties:[{id:'property-1',name:'Synthetic North Lot',address:'789 Synthetic Ave, Fort Collins, CO',contact:'Synthetic Site Lead',access:'Synthetic gate'}],
 requests:[{id:'request-1',propertyId:'property-1',service:'Garage cleanout and reset',status:'new',scope:'Synthetic scope for layout tests.',preferredDate:'2026-10-01',payer:'Synthetic Property Group',purchaseOrder:'PO-SYN',onsiteContact:'Synthetic Site Lead',createdAt:'2026-09-20T15:00:00Z'}],
 projects:[{jobId:'job-business-1',propertyId:'property-1',service:'Garage cleanout',status:'scheduled',date:'2026-10-02',time:'09:00',total:900,quoteStatus:'approved',invoiceNumber:'INV-SYN-1',invoiceStatus:'issued',balance:450,paid:450,dueDate:'2026-10-15',paymentNeedsReview:false}],
 members:[{id:'member-1',name:'Synthetic Admin',email:'admin@example.invalid',role:'admin',status:'active'}],messages:[],coverage:{unavailable:0,paymentReview:0},updatedAt:'2026-09-21T15:00:00Z'};

const denied=(code,error)=>()=>[401,{ok:false,code,error}];
const SHELLS=[
 {name:'dispatch day board',path:'/dispatch.html',routes:{'/api/dispatch':({url})=>[200,url.searchParams.get('view')==='customers'?{ok:true,customers:[CUSTOMER],total:1}:{...DISPATCH,startDate:url.searchParams.get('startDate')||DAY,endDate:url.searchParams.get('endDate')||'2026-09-29'}]},
  ready:async page=>{await page.getByRole('heading',{name:CUSTOMER.name,exact:true}).first().waitFor();}},
 {name:'dispatch create job dialog',path:'/dispatch.html',routes:{'/api/dispatch':({url})=>[200,url.searchParams.get('view')==='customers'?{ok:true,customers:[CUSTOMER],total:1}:{...DISPATCH,startDate:DAY,endDate:'2026-09-29'}]},
  ready:async page=>{await page.getByRole('heading',{name:CUSTOMER.name,exact:true}).first().waitFor();await page.getByRole('button',{name:'Create job',exact:true}).first().click();await page.getByRole('dialog').waitFor();}},
 {name:'crew sign in',path:'/crew/job.html',routes:{'/api/hub-auth':denied('','Sign in required')},
  ready:async page=>{await page.getByLabel('Username',{exact:true}).waitFor();}},
 {name:'crew day list',path:'/crew/job.html',routes:{'/api/hub-auth':()=>[200,CREW_SESSION],'/api/field-jobs':()=>[200,{ok:true,jobs:[fieldJob()],date:DAY,endDate:DAY,timezone:'America/Denver',photosAvailable:true,generatedAt:NOW}]},
  ready:async page=>{await page.getByText('Signed in as Crew One',{exact:true}).waitFor();}},
 {name:'crew job with photos',path:'/crew/job.html?jobId=job-1',camera:true,routes:{'/api/hub-auth':()=>[200,CREW_SESSION],'/api/field-jobs':()=>[200,{ok:true,job:fieldJob(),historyCursor:null,photosAvailable:true,timezone:'America/Denver'}],'/api/employee-hub':()=>[200,{ok:true,user:'Crew.One',entry:null}]},
  ready:async page=>{await page.getByRole('heading',{name:CUSTOMER.name,exact:true}).waitFor();await page.getByText('You are not clocked in',{exact:false}).waitFor();}},
 {name:'employee hub sign in',path:'/employee.html',routes:{'/api/hub-auth':denied('','Sign in required')},
  ready:async page=>{await page.locator('#l-user').waitFor();}},
 {name:'customer portal access help',path:'/customer-portal.html',routes:{'/api/customer-portal':denied('CUSTOMER_PORTAL_AUTH_REQUIRED','Open the private link sent by Easy Garage Cleaning.')},
  ready:async page=>{await page.locator('#error').waitFor();await page.locator('#hub-help-form').waitFor({state:'attached'});}},
 {name:'customer portal project',path:'/customer-portal.html',camera:true,routes:{'/api/customer-portal':()=>[200,PORTAL]},
  ready:async page=>{await page.locator('#portal').waitFor();await page.getByText('Synthetic Garage Turnaround',{exact:true}).waitFor();}},
 {name:'business hub gate',path:'/business-hub.html',routes:{'/api/business-hub':()=>[401,{error:'Sign in with your private business invitation.'}]},
  ready:async page=>{await page.locator('#invite-form').waitFor();await expect(page.locator('#gate-status')).not.toBeEmpty();}},
 {name:'business hub overview',path:'/business-hub.html',routes:{'/api/business-hub':()=>[200,BUSINESS]},
  ready:async page=>{await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();}},
 {name:'business hub service request form',path:'/business-hub.html',routes:{'/api/business-hub':()=>[200,BUSINESS]},
  ready:async page=>{await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();await page.locator('#tabs').getByRole('button',{name:'Service requests',exact:true}).click();await page.getByRole('button',{name:'Submit service request',exact:true}).waitFor();}},
];
// TODO(mobile): known camera gaps. The shell must still render its image upload
// and library picker; only the missing capture="environment" option is
// tolerated, and adding it fails the test until the entry is deleted here and
// in docs/testing.md.
const KNOWN_NO_CAMERA={
};

async function show(page,shell){
 for(const [path,handler] of Object.entries(shell.routes))await api(page,path,handler);
 await open(page,shell.path);await shell.ready(page);
}

for(const shell of SHELLS){
 test.describe(shell.name,()=>{
  test('fits the viewport with no horizontal scroll',async({page})=>{
   await show(page,shell);await assertNoHorizontalScroll(page);
  });
  test('primary controls are at least 44x44',async({page},info)=>{
   test.skip(!touch(info),'Touch target size applies to touch devices.');
   await show(page,shell);await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} hub:${shell.name}`});
  });
  test('fields raise the right keyboard',async({page})=>{
   await show(page,shell);await assertInputKeyboards(page,{key:`hub:${shell.name}`});
  });
  if(shell.camera)test('photo upload offers the rear camera and the photo library',async({page},info)=>{
   await show(page,shell);
   const gap=KNOWN_NO_CAMERA[shell.name];
   if(gap){info.annotations.push({type:'known camera gap',description:gap});await assertKnownMissingCamera(page,gap);}
   else await assertCameraCapture(page);
  });
 });
}
