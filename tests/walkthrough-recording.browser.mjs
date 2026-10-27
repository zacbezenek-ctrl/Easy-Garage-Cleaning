import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.FIELD_PLAYWRIGHT_MODULE?pathToFileURL(process.env.FIELD_PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
const context=await browser.newContext(),page=await context.newPage({viewport:{width:1100,height:900}});
const posts=[],errors=[];let loseResponse=false,delayPreview=null,owner=true;
const board=()=>({ok:true,viewer:{id:'ZacB',...(owner?{canRecordWalkthrough:true}:{})},jobs:[],roster:[{id:'crew1',name:'Synthetic Estimator',role:'crew'}],crews:[],vehicles:[],availability:[],warnings:[],coverage:{complete:true}});
page.on('pageerror',e=>errors.push(e.message));
await page.route('https://egc.test/**',async route=>{
  const u=new URL(route.request().url()),body=route.request().postDataJSON();
  const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-dispatch.css"><main id="app"></main><script src="/employee-dispatch.js"></script><script src="/employee-walkthrough-recording.js"></script><script>EGCDispatch.mount(document.querySelector("main"));</script>'});
  if(u.pathname.endsWith('.css'))return route.fulfill({contentType:'text/css; charset=utf-8',body:await readFile(new URL('..'+u.pathname,import.meta.url),'utf8')});
  if(u.pathname.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+u.pathname,import.meta.url),'utf8')});
  if(u.pathname==='/api/dispatch')return json(u.searchParams.get('view')==='customers'?{ok:true,customers:[{id:'c1',name:'Synthetic Customer',address:'1 Synthetic Street',phone:'9705550101'}]}:board());
  if(u.pathname==='/api/walkthrough-recording'){
    posts.push(body);
    if(body.action==='preview'){
      if(delayPreview)await delayPreview;
      const provider=body.input.mode==='import'?{calendarName:'Personal Calendar',calendarId:'cal-1',appointmentId:'appt-1',assignedUserId:'user-1',status:'confirmed',providerAddress:'1 Synthetic Street'}:null;
      return json({ok:true,providerWrites:false,fingerprint:'a'.repeat(64),snapshot:{...body.input,date:'2026-10-30',time:'15:30',endTime:'16:15',employeeName:'Synthetic Estimator',durationMinutes:45,provider}});
    }
    if(loseResponse){loseResponse=false;return route.abort('failed');}
    return json({ok:true,providerWrites:false,requestId:body.requestId,job:{id:'visit-1',revision:'v1'}});
  }
  return route.abort();
});
const open=async()=>{await page.getByRole('button',{name:'Record walkthrough',exact:true}).click();};
const fill=async(mode='hub_only')=>{
  await page.locator('[name=mode]').selectOption(mode);
  await page.locator('[name=customerSearch]').fill('Synthetic');await page.getByRole('button',{name:'Find customer',exact:true}).click();await page.getByRole('button',{name:/Synthetic Customer ·/}).click();
  await page.locator('[name=employeeId]').selectOption('crew1');
  if(mode==='hub_only'){await page.locator('[name=date]').fill('2026-10-30');await page.locator('[name=time]').fill('15:30');await page.locator('[name=endTime]').fill('16:15');}
  else{await page.locator('[name=appointmentId]').fill('appt-1');await page.locator('[name=calendarId]').fill('cal-1');}
  await page.locator('[name=scope]').fill('Review tools');await page.locator('[name=reason]').fill('Owner verified walkthrough');
};
try{
  await page.goto('https://egc.test/');await open();await fill();
  await page.getByRole('button',{name:'Review recording',exact:true}).click();
  await page.getByRole('button',{name:'Confirm and save',exact:true}).waitFor();
  assert.match(await page.getByRole('dialog').innerText(),/Hub-only: no provider appointment/);
  assert.equal(posts.filter(p=>p.action==='save').length,0);
  await page.locator('[name=scope]').fill('Updated tools');assert.equal(await page.getByRole('button',{name:'Review recording',exact:true}).count(),1);
  await page.getByRole('button',{name:'Review recording',exact:true}).click();await page.getByRole('button',{name:'Confirm and save',exact:true}).waitFor();
  loseResponse=true;await page.getByRole('button',{name:'Confirm and save',exact:true}).click();
  await page.getByRole('button',{name:'Verify saved recording',exact:true}).waitFor();
  assert.equal(await page.locator('[name=scope]').isDisabled(),true);
  await page.getByRole('button',{name:'Close and verify later',exact:true}).click();await page.reload();await open();
  await page.getByRole('button',{name:'Verify saved recording',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const saves=posts.filter(p=>p.action==='save');assert.equal(saves.length,2);assert.deepEqual(saves[0],saves[1]);
  await open();await fill('import');await page.getByRole('button',{name:'Review recording',exact:true}).click();await page.getByRole('button',{name:'Confirm and save',exact:true}).waitFor();
  assert.match(await page.getByRole('dialog').innerText(),/Personal Calendar.*calendar cal-1.*appointment appt-1/);
  assert.match(await page.getByRole('dialog').innerText(),/Hub assignment is recorded separately/);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  let release;delayPreview=new Promise(r=>release=r);await open();await fill();await page.getByRole('button',{name:'Review recording',exact:true}).click();
  await page.getByRole('button',{name:'Back',exact:true}).click();release();delayPreview=null;await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog').count(),0);
  owner=false;await page.reload();await page.getByRole('button',{name:'Create job',exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'Record walkthrough',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS: review, stale preview, interrupted retry, exact replay, import disclosure, mobile, canceled preview and nonowner UI');
}catch(error){console.error(await page.locator('body').innerText());console.error(errors);throw error;}finally{await browser.close();}
