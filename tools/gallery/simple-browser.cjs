const {chromium}=require('playwright');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=process.cwd();
const out=path.join(root,'simple-page-review');fs.mkdirSync(out,{recursive:true});
const report=[];
const server=http.createServer((req,res)=>{
 let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(name==='/before-after')name='/before-after.html';
 const file=path.resolve(root,'.'+name);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
 const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.webp':'image/webp','.ico':'image/x-icon','.json':'application/json'};
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
async function paint(page,selector){
 await page.locator(selector).evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/before-after';
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1440,390,320]){
   const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   const response=await page.goto(url,{waitUntil:'networkidle'});assert.equal(response.status(),200);
   assert.equal(await page.locator('#gallery .ba-card').count(),1);
   await page.locator('#gallery img').evaluateAll(images=>images.forEach(image=>image.loading='eager'));
   await paint(page,'#gallery img');
   assert.equal(await page.locator('#gallery img').count(),2);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow at '+width);
   assert.equal(await page.locator('.showcase-card').count(),0);
   assert.equal(await page.locator('script[src*="gallery-preview-assets/gallery.js"]').count(),0); assert.equal(await page.locator('link[href*="styles.css"]').count(),1); assert.equal(await page.locator('.site-footer').count(),1); assert.equal(await page.locator('.nav').count(),1);
   assert(!/\bAI\b|AI-generated|Higgsfield/i.test(await page.content()));
   const card=page.locator('#gallery .ba-card').first();
   const input=card.locator('input[type="range"]');
   await card.locator('[data-position="100"]').click();assert.equal(await input.inputValue(),'100');
   assert(await card.locator('.label-after').isHidden());
   await paint(page,'#gallery img');
   await card.screenshot({path:path.join(out,'first-before-'+width+'.png')});
   await card.locator('[data-position="0"]').click();assert.equal(await input.inputValue(),'0');
   assert(await card.locator('.label-before').isHidden());
   await paint(page,'#gallery img');
   await card.screenshot({path:path.join(out,'first-after-'+width+'.png')});
   await card.locator('[data-position="50"]').click();assert.equal(await input.inputValue(),'50');
   const stage=card.locator('.image-stage');await stage.scrollIntoViewIfNeeded();
   const box=await stage.boundingBox();
   await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
   await page.mouse.move(box.x+box.width*.25,box.y+box.height*.5);await page.mouse.up();
   assert(Math.abs(Number(await input.inputValue())-25)<=1);
   await input.focus();await page.keyboard.press('ArrowRight');assert(Number(await input.inputValue())>=25);
   await card.locator('[data-expand]').click();assert(await page.locator('#viewer').isVisible());
   await page.locator('#viewer [data-position="0"]').click();
   assert.equal(await page.locator('#viewer input[type="range"]').inputValue(),'0');
   await paint(page,'#viewer img');
   await page.screenshot({path:path.join(out,'viewer-'+width+'.png')});
   await page.keyboard.press('Escape');assert(await page.locator('#viewer').isHidden());
   assert(await card.locator('[data-expand]').evaluate(el=>el===document.activeElement));
   await page.locator('#gallery [data-position="50"]').evaluateAll(buttons=>buttons.forEach(button=>button.click()));
   for(let i=0;i<1;i++){
    const current=page.locator('#gallery .ba-card').nth(i);
    await current.scrollIntoViewIfNeeded();
    await paint(page,'#gallery img');
    await current.screenshot({path:path.join(out,'card-'+(i+1)+'-'+width+'.png')});
   }
   await page.evaluate(()=>scrollTo(0,0));await paint(page,'#gallery img');
   await page.screenshot({path:path.join(out,'page-'+width+'.png'),fullPage:true});
   const states=await page.locator('#gallery .comparison').evaluateAll(items=>items.map(item=>({position:item.style.getPropertyValue('--position'),clip:getComputedStyle(item.querySelector('.before-image')).clipPath,images:Array.from(item.querySelectorAll('img')).map(image=>({src:image.currentSrc,complete:image.complete,width:image.naturalWidth}))})));
   assert(states.every(item=>item.position==='50%'&&item.images.every(image=>image.complete&&image.width>0)));
   assert(await page.locator('a[href="/book"]').count()>=3);assert(await page.locator('a[href="/garage-turnaround-fort-collins-co"]').count()>=2);assert.deepEqual(errors,[]);
   report.push({width,cards:1,imagesDecoded:2,noOverflow:true,siteShell:true,buttons:true,pointer:true,keyboard:true,modal:true,focusRestored:true,noProductionMethodWording:true,states,errors});
   await page.close();
  }
  const nojs=await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:900}});
  await nojs.goto(url);assert.equal(await nojs.locator('noscript a').count(),2);
  assert.equal(await nojs.locator('#gallery .ba-card').count(),1);await nojs.close();
  fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({passed:true,viewports:report,noJavaScript:true},null,2));
  console.log(JSON.stringify({passed:true,viewports:report,noJavaScript:true},null,2));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
