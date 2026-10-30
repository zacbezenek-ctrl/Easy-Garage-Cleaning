// GUARD-SELL: the Garage Guard sales sheet (crew/guard-sell.js) on phones and an iPad: plans from the server, the big QR
// code with Copy link, and "Member" once the sign-up is paid. /api/garage-guard-sell is answered by route() fixtures;
// synthetic data only, the clock at NOW. The sheet is checked on its own (on the plain crew offline page), from the
// manager's post-job playbook ("Sign them up now", pre-filled) and from the Hub's Garage Guard sales screen.
import {test,expect,open,api,touch} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertInputKeyboards,assertNoHorizontalScroll,assertTapTargets} from './helpers/mobile-invariants.mjs';
import {MANAGER,hubFixtures} from './helpers/hub-fixture.mjs';

const TOOL='/crew/guard-sell.js?v=20261030guard1';
const PLANS=[
 {key:'black',name:'Guard Black',amountCents:250000,interval:'year',includes:['Monthly whole-property visits','Free monthly single-item pickup','Annual deep clean','Front-of-line scheduling']},
 {key:'guard',name:'Garage Guard',amountCents:80000,interval:'year',includes:['4 quarterly visits a year','Up to 5 cubic yards hauled each visit']},
 {key:'lite',name:'Guard Lite',amountCents:45000,interval:'year',includes:['2 maintenance visits a year','Sweep and re-tidy each visit','A small junk haul each visit']},
];
const SESSION='cs_test_syntheticguardsale0001';
const LINK=`https://easygaragecleaning.com/api/garage-guard-link?s=${SESSION}&k=AbCdEfGhIjKlMnOpQrStUv`;
const CUSTOMER={name:'Synthetic Dana Van Der Westhuizen-Oyelaran',email:'dana.synthetic@example.invalid',address:'12345 East County Road 38 Unit 1204B, Fort Collins, CO 80525'};

// The sales API: plans, a started sign-up, and its status (member once state.paid).
async function salesApi(page,state={paid:false}){
 return api(page,'/api/garage-guard-sell',({method,url,body})=>{
  if(method==='GET'&&url.searchParams.get('session'))return [200,{ok:true,status:state.paid?'complete':'open',member:state.paid,plan:'guard'}];
  if(method==='GET')return [200,{ok:true,configured:true,textEnabled:false,plans:PLANS}];
  return [200,{ok:true,sessionId:SESSION,link:LINK,plan:PLANS.find(plan=>plan.key===body.plan),status:'open'}];
 });
}
async function standalone(page,state){
 const calls=await salesApi(page,state);
 await open(page,'/crew/offline.html');
 await page.addScriptTag({url:TOOL});
 await page.evaluate(customer=>window.EGCGuardSell.open({channel:'postjob',jobId:'job-1',customerId:'cust-1',customer}),CUSTOMER);
 await page.getByRole('button',{name:/Guard Black/}).waitFor();
 return calls;
}
async function checkLayout(page,info,name){
 await assertNoHorizontalScroll(page);
 if(touch(info))await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} hub:garage guard sales sheet ${name}`});
 await assertInputKeyboards(page,{key:`hub:garage guard sales sheet ${name}`});
}

test('the sheet lists the plans from the server, pre-fills the customer, and fits the phone',async({page},info)=>{
 await standalone(page);
 const plans=page.locator('.egs-plan');
 await expect(plans).toHaveCount(3);
 await expect(plans.nth(0)).toContainText('Guard Black');await expect(plans.nth(0)).toContainText('$2,500');await expect(plans.nth(0)).toContainText('Annual deep clean');
 await expect(plans.nth(1)).toContainText('$800');await expect(plans.nth(2)).toContainText('$450');
 await expect(page.locator('.egs-for')).toContainText(CUSTOMER.name);
 await expect(page.locator('#egs-email')).toHaveValue(CUSTOMER.email);
 await expect(page.locator('#egs-address')).toHaveValue(CUSTOMER.address);
 await expect(page.getByRole('button',{name:'Pick a plan'})).toBeDisabled();
 await expect(page.locator('.egs-sheet')).not.toContainText(/gift card|Only 5|Limited/i);
 await checkLayout(page,info,'plans');
});

test('a picked plan becomes a big QR code with Copy link, and the sheet says Member once Stripe confirms',async({page},info)=>{
 const state={paid:false},calls=await standalone(page,state);
 await page.getByRole('button',{name:/Garage Guard\s*\$800/}).click();
 await expect(page.getByRole('button',{name:/Garage Guard\s*\$800/})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Show sign-up code · Garage Guard'}).click();
 const qr=page.getByRole('img',{name:/QR code: Garage Guard sign-up link/});
 await expect(qr).toBeVisible();
 const box=await qr.boundingBox();
 expect(box.width,'the code is big enough to scan from a phone held up to the screen').toBeGreaterThanOrEqual(Math.min(300,page.viewportSize().width-64));
 await expect(page.locator('.egs-link')).toHaveText(LINK);
 await expect(page.getByRole('button',{name:'Copy link'})).toBeVisible();
 await expect(page.getByRole('button',{name:/Text it/})).toHaveCount(0);
 await expect(page.locator('.egs-status')).toContainText('Waiting for the customer to pay');
 const start=calls.find(call=>call.method==='POST');
 expect(start.body).toMatchObject({action:'start',plan:'guard',channel:'postjob',jobId:'job-1',customerId:'cust-1',email:CUSTOMER.email,address:CUSTOMER.address});
 expect(start.body.requestId).toMatch(/^[A-Za-z0-9-]{16,64}$/);
 expect(Object.keys(start.body).sort()).toEqual(['action','address','channel','customerId','email','jobId','plan','requestId']);
 await checkLayout(page,info,'code');
 state.paid=true;
 await page.clock.fastForward(5000);
 await expect(page.locator('.egs-status')).toContainText('Member');
 await page.getByRole('button',{name:'Done'}).click();
 await expect(page.locator('.egs-backdrop')).toHaveCount(0);
});

test('on an iPad the sheet is a centered card with the same controls',async({page})=>{
 for(const viewport of [{width:768,height:1024},{width:1180,height:820}]){
  await page.setViewportSize(viewport);
  await standalone(page);
  const sheet=await page.locator('.egs-sheet').boundingBox();
  expect(sheet.width).toBeLessThanOrEqual(560);
  expect(Math.abs(sheet.x+sheet.width/2-viewport.width/2)).toBeLessThan(2);
  await assertNoHorizontalScroll(page);
  await page.getByRole('button',{name:/Guard Lite/}).click();
  await page.getByRole('button',{name:'Show sign-up code · Guard Lite'}).click();
  await expect(page.getByRole('img',{name:/QR code/})).toBeVisible();
  await assertNoHorizontalScroll(page);
 }
});

test('the manager post-job playbook opens the sheet from "Sign them up now", pre-filled from the job card',async({page},info)=>{
 await hubFixtures(page,{profile:MANAGER});
 await salesApi(page);
 await open(page,'/crew/postjob.html');
 // Without a job id the manager gets the standalone checklist at once.
 const signUp=page.getByRole('button',{name:'Sign them up now'});
 await signUp.waitFor();
 await page.locator('#j_name').fill(CUSTOMER.name);
 await signUp.click();
 await page.locator('.egs-plan[data-plan="black"]').waitFor();
 await expect(page.locator('.egs-for')).toContainText(CUSTOMER.name);
 // The sheet's own controls (the playbook page underneath has its own, older fields).
 await assertNoHorizontalScroll(page);
 if(touch(info))await assertTapTargets(page,PRIMARY_CONTROLS.split(',').map(selector=>`.egs-sheet ${selector}`).join(','),{key:`${info.project.name} hub:garage guard sales sheet from post-job`});
 await page.keyboard.press('Escape');
 await expect(page.locator('.egs-backdrop')).toHaveCount(0);
 await expect(signUp).toBeFocused();
});

test('the Hub Garage Guard sales screen opens the sheet and lists who sold each membership',async({page},info)=>{
 await salesApi(page);
 const members=await api(page,'/api/garage-guard-members',()=>[200,{ok:true,memberships:[
  {subscriptionId:'sub_staff_1',plan:'guard',status:'active',customerName:'Synthetic Dana',startedAt:'2026-10-20T16:00:00Z',soldBy:{staffKey:'crew.one',channel:'postjob',jobId:'job-1',customerId:'cust-1',at:'2026-10-20T16:00:00Z'}},
  {subscriptionId:'sub_staff_2',plan:'black',status:'active',customerName:'Synthetic Eli',startedAt:'2026-10-25T16:00:00Z',soldBy:{staffKey:'rep.one',channel:'knock',jobId:null,customerId:null,at:'2026-10-25T16:00:00Z'}},
  {subscriptionId:'sub_public_1',plan:'lite',status:'active',customerName:'Synthetic Public',startedAt:'2026-10-01T16:00:00Z'}]}]);
 await open(page,'/crew/offline.html');
 for(const css of ['/employee-ui-kit.css','/employee-guard-sales.css'])await page.addStyleTag({url:css});
 for(const js of ['/employee-ui-kit.js','/employee-guard-sales.js'])await page.addScriptTag({url:js});
 await page.evaluate(()=>{const host=document.createElement('main');host.id='hub-host';document.body.replaceChildren(host);return window.EGCGuardSales.mount(host,{capabilities:['business']});});
 await expect(page.getByRole('heading',{name:'Sold by staff (2)'})).toBeVisible();
 const rows=page.locator('tr[data-membership]');
 await expect(rows).toHaveCount(2);
 await expect(rows.nth(0)).toContainText('Synthetic Eli');await expect(rows.nth(0)).toContainText('rep.one');await expect(rows.nth(0)).toContainText('Door to door');
 await expect(rows.nth(1)).toContainText('crew.one');await expect(rows.nth(1)).toContainText('Post-job playbook');
 await expect(page.getByText('1 other membership came from the public Garage Guard page.')).toBeVisible();
 await expect(page.locator('#hub-host')).not.toContainText('$');
 expect(members[0].query).toEqual({period:'ytd'});
 await assertNoHorizontalScroll(page);
 if(touch(info))await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} hub:garage guard sales screen`});
 await page.getByRole('button',{name:'Sell Garage Guard'}).click();
 await page.locator('.egs-plan[data-plan="black"]').waitFor();
 await expect(page.locator('#egs-email')).toHaveValue('');
});
