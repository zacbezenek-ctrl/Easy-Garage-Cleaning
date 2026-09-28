// Guarded Playwright test: only the local audit server is reachable, every
// uncaught page error fails the test, and pages open at a fixed instant.
import {test as base,expect} from '@playwright/test';

export const NOW='2026-09-22T18:00:00Z';
export const touch=testInfo=>testInfo.project.use.hasTouch===true;

export const test=base.extend({
 page:async({page},use,testInfo)=>{
  const refused=new Set(),errors=[];
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1')return route.continue();refused.add(url.host);return route.abort('blockedbyclient');});
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(8000);
  await use(page);
  // Built-in screenshot:'only-on-failure' costs ~2s per passing test at 3x DPR.
  if(testInfo.status!==testInfo.expectedStatus&&!page.isClosed())await testInfo.attach('failure',{body:await page.screenshot({fullPage:true}).catch(()=>Buffer.alloc(0)),contentType:'image/png'});
  if(refused.size)await testInfo.attach('refused-external-hosts',{body:[...refused].sort().join('\n'),contentType:'text/plain'});
  expect(errors,'uncaught page errors').toEqual([]);
 },
});
export {expect};

export async function open(page,path,{clock=true}={}){
 if(clock)await page.clock.install({time:new Date(NOW)});
 const response=await page.goto(path,{waitUntil:'load'});
 expect(response?.status(),`${path} should load`).toBe(200);
 await page.evaluate(async()=>{await document.fonts?.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
 return response;
}

// route() fixture that answers JSON for one API path and records the calls.
export async function api(page,path,handler){
 const calls=[];
 await page.route(url=>url.pathname===path,async route=>{
  const request=route.request(),url=new URL(request.url());let payload=null;try{payload=request.postDataJSON();}catch{payload=request.postData();}
  calls.push({method:request.method(),query:Object.fromEntries(url.searchParams),body:payload});
  const [status,body]=await handler({method:request.method(),url,body:payload});
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 return calls;
}
