// Synthetic browser acceptance only: all API traffic is intercepted in memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const moduleName=process.env.FIELD_PLAYWRIGHT_MODULE||'playwright';
const {webkit}=await import(/^(?:[A-Za-z]:|\/)/.test(moduleName)?pathToFileURL(moduleName).href:moduleName);
const server=createServer(async(req,res)=>{try{
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(!extname(name))name+='.html';
  const path=resolve(root,'.'+name);if(!path.startsWith(root+sep)||!['.html','.js','.css','.ico'].includes(extname(path)))throw Error();
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon'})[extname(path)]);res.end(await readFile(path));
}catch{res.statusCode=404;res.end('Not found');}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,out=resolve(root,'test-results/portal-recovery');await mkdir(out,{recursive:true});
const browser=await webkit.launch({headless:true});
const accountId='a'.repeat(32),propertyId='b'.repeat(32),requestId='c'.repeat(32),reviewId='d'.repeat(32);
const recipient={memberId:'e'.repeat(32),version:1,name:'Synthetic Billing',email:'billing@example.invalid'};
const job={jobId:'synthetic_job',propertyId,service:'Synthetic garage cleanup',status:'completed',date:'2026-10-20',time:'09:00',quoteStatus:'accepted',quoteNumber:'Q-SYN',total:120,invoiceNumber:'INV-SYN',invoiceStatus:'issued',balance:120,paid:0,paymentNeedsReview:false};
try{
 for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});const page=await context.newPage();const errors=[],calls=[];let converted=false,changes=[];
  page.on('pageerror',error=>errors.push(error.message));
  const business=()=>({account:{id:accountId,company:'Synthetic Property Company',status:'active',billingEmail:recipient.email},viewer:{role:'staff',permissions:{view:true,request:true,team:true,staff:true,link:true,pay:true}},
    properties:[{id:propertyId,name:'Synthetic North',address:'100 Example Way',access:'Office-approved entrance',contact:'Synthetic contact'}],
    requests:[{id:requestId,propertyId,service:'Garage cleanup',scope:'Remove only the marked empty boxes.',payer:'Synthetic Property Company',purchaseOrder:'SYN-PO',preferredDate:'2026-11-03',status:converted?'project_linked':'submitted',...(converted?{jobId:'synthetic_converted'}:{}),createdAt:'2026-10-24T12:00:00Z'}],
    projects:[job],members:[],messages:[],rates:{cards:[],terms:[]},manager:{name:'Synthetic Coordinator',phone:'',email:'coordinator@example.invalid'},coverage:{unavailable:0,paymentReview:0},
    businessRequestRevision:'rev1',billing:{canManage:true,accountContactMemberId:recipient.memberId,candidates:[{id:recipient.memberId,name:recipient.name,email:recipient.email,propertyIds:null}],routes:[{propertyId,contactMemberId:'',recipient}]}});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){await route.abort();return;}
   if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   const payload=route.request().method()==='POST'?route.request().postDataJSON():null;if(payload)calls.push(payload);
   let data;
   if(url.pathname==='/api/business-hub'){
    if(url.searchParams.get('export')){await route.fulfill({status:200,headers:{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="review.csv"'},body:'Invoice,Amount\r\nINV-SYN,120.00\r\n'});return;}
    if(!payload)data=business();
    else if(payload.action==='preview_business_request_conversion')data={ok:true,previewToken:'f'.repeat(64),customer:{id:'customer_one',name:'Synthetic Customer',email:'customer@example.invalid',phone:''},property:{name:'Synthetic North',address:'100 Example Way'},request:{scope:'Remove only marked boxes',payer:'Synthetic Company',purchaseOrder:'SYN-PO',preferredDate:'2026-11-03'}};
    else if(payload.action==='convert_business_request'){converted=true;data={ok:true,jobId:'synthetic_converted',projectId:'synthetic_project',status:'unscheduled'};}
    else if(payload.action==='prepare_business_payment')data={ok:true,preparation:{id:reviewId,totalCents:12000,recipient,invoices:[{jobId:job.jobId,propertyId,invoiceNumber:job.invoiceNumber,totalCents:12000,amountCents:12000}]}};
    else data={ok:true};
   }else if(url.pathname==='/api/dispatch')data={ok:true,customers:[{id:'customer_one',name:'Synthetic Customer',email:'customer@example.invalid',phone:''}]};
   else if(url.pathname==='/api/customer-account'){
    if(url.searchParams.get('format')==='ics'){await route.fulfill({headers:{'Content-Type':'text/calendar','Content-Disposition':'attachment; filename="visit.ics"'},body:'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'});return;}
    if(payload?.action==='request_change'){changes.push({...payload,id:'synthetic_request',status:'submitted'});data={ok:true,request:changes.at(-1)};}
    else if(payload)data={ok:true,url:'/customer-portal'};
    else data={ok:true,customer:{name:'Synthetic Customer',firstName:'Synthetic'},jobs:[{jobId:'visit_one',type:'job',service:'Synthetic garage cleanup',status:'scheduled',date:'2026-11-03',endDate:'2026-11-03',time:'09:00',endTime:'12:00',address:'100 Synthetic Way'}],quotes:[],invoices:[],receipts:[],requests:changes,coverage:{complete:true,needsReview:0},requestsComplete:true,today:'2026-10-24'};
   }else {await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({ok:false,error:'Unexpected synthetic route'})});return;}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  console.log('checking My visits '+width);await page.goto(origin+'/my-visits');await page.getByRole('heading',{name:'Synthetic garage cleanup'}).waitFor();
  await page.getByText('Request a date change or cancellation',{exact:true}).click();
  await page.locator('[name="preferredDate"]').fill('2026-11-04');await page.locator('[name="note"]').fill('Synthetic request to review another date.');
  await page.getByRole('button',{name:'Send request for review'}).evaluate(button=>{button.click();button.click();});
  await page.getByText(/Reschedule request: submitted/).waitFor();assert.equal(calls.filter(x=>x.action==='request_change').length,1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`My visits overflow at ${width}`);
  await page.screenshot({path:resolve(out,`my-visits-${width}.png`),fullPage:true});
  await page.goto(origin+`/business-hub?staff=1&account=${accountId}`);await page.locator('[data-tab="requests"]').first().click();
  await page.locator('[data-business-convert]').click();await page.locator('[name="customerQuery"]').fill('Synthetic');await page.locator('[data-customer-search]').click();
  await page.locator('[name="customerId"] option[value="customer_one"]').waitFor({state:'attached'});await page.locator('[name="customerId"]').selectOption('customer_one');
  await page.getByRole('button',{name:'Review conversion',exact:true}).click();await page.locator('[data-conversion-confirm]').check();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Business dialog overflow at ${width}`);
  await page.screenshot({path:resolve(out,`business-conversion-${width}.png`),fullPage:true});
  await page.locator('[data-conversion-save]').evaluate(button=>{button.click();button.click();});await page.locator('dialog[aria-label="Review service request"]').waitFor({state:'hidden'}).catch(()=>{});
  assert.equal(calls.filter(x=>x.action==='convert_business_request').length,1);
  await page.locator('[data-tab="billing"]').click();await page.locator('[data-billing-job]').check();await page.locator('[data-billing-prepare]').click();
  await page.getByRole('heading',{name:'Saved payment review'}).waitFor();const downloadPromise=page.waitForEvent('download');await page.getByText('Download reviewed invoices CSV',{exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'EGC-invoice-review.csv');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Billing overflow at ${width}`);
  assert.deepEqual(errors,[]);await context.close();console.log(`portal recovery browser passed ${width}px`);
 }
}finally{await browser.close();await new Promise(done=>server.close(done));}
