const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer((req,res)=>{let p=new URL(req.url,'http://localhost').pathname;if(p==='/before-after')p='/before-after.html';const f=path.resolve(root,'.'+decodeURIComponent(p));if(!f.startsWith(root+'/')){res.writeHead(403);return res.end();}try{let b=fs.readFileSync(f);res.writeHead(200,{'Content-Type':types[path.extname(f)]||'text/plain'});res.end(b);}catch{res.writeHead(404);res.end();}});
let browser;
(async()=>{
  assert(fs.readFileSync(path.join(root,'index.html'),'utf8').includes('data-gallery-discovery="static"'));
  assert(fs.readFileSync(path.join(root,'sitemap.xml'),'utf8').includes('<loc>https://easygaragecleaning.com/before-after</loc>'));
  await new Promise(r=>server.listen(8766,'127.0.0.1',r));browser=await chromium.launch();
  const p=await browser.newPage({viewport:{width:390,height:844}});
  await p.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await p.route('**/analytics-loader.js*',r=>r.fulfill({contentType:'text/javascript',body:''}));
  let errors=[];p.on('pageerror',e=>errors.push(String(e)));
  await p.goto('http://127.0.0.1:8766/before-after',{waitUntil:'networkidle'});
  const total=JSON.parse(fs.readFileSync(path.join(root,'before-after-concepts.json'))).concepts.length;
  if(total){
    await p.waitForFunction(n=>document.querySelectorAll('.concept-open').length===n,total);
    for(const width of [390,1440]){
      await p.setViewportSize({width,height:1000});
      const sizes=await p.locator('.concept-pair img').evaluateAll(images=>images.map(image=>{const box=image.getBoundingClientRect();return {width:box.width,height:box.height};}));
      assert(sizes.every(s=>s.width>0&&Math.abs(s.height/s.width-0.75)<0.02),'Concept thumbnails must retain a compact 4:3 ratio, not their intrinsic pixel height');
    }
    await p.setViewportSize({width:390,height:844});
    const button=p.locator('.concept-open').first();await button.click();
    assert(await p.locator('#concept-dialog').isVisible());
    assert((await p.locator('.concept-modal-note').textContent()).includes('not photographs of a completed EGC job'));
    await p.locator('#concept-range').focus();await p.keyboard.press('Home');assert.equal(await p.locator('#concept-range').inputValue(),'0');
    await p.keyboard.press('End');assert.equal(await p.locator('#concept-range').inputValue(),'100');
    await p.keyboard.press('Escape');assert.equal(await p.locator('#concept-dialog').isVisible(),false);
    assert(await button.evaluate(e=>document.activeElement===e));
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'gallery-review/dialog-results.json'),JSON.stringify({passed:true,approvedConcepts:total,checks:['static discovery links','sitemap entry','compact 4:3 thumbnails on mobile and desktop','concept open buttons','mobile full-size dialog','AI disclosure','keyboard comparison','Escape and focus return','no runtime errors']},null,2));
  console.log('PASS thumbnail geometry, full-size concept comparison and static site integration');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
