// Local manual browser harness. /fixture uses a stub and blocks submission.
// /native-preview explicitly loads the real form for appearance checks only;
// do not submit that cross-origin form. Start with node tests/browser/serve-booking-highlevel.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../../functions/_middleware.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const harness = `<style>.reveal{opacity:1!important;transform:none!important}.fixture-controls{padding:16px;background:#fff;border:3px solid #ff5318;position:relative;z-index:999}.fixture-controls button{padding:12px;margin:6px}</style>
<aside class="fixture-controls"><strong>LOCAL WRAPPER TEST ONLY — no HighLevel form or submission</strong><br>
<button id="fixture-enable">Preview local iframe wrapper</button><button id="fixture-error">Simulate iframe failure</button></aside>
<script>
document.addEventListener('submit',event=>event.preventDefault(),true);
const originalCreate=document.createElement.bind(document);
document.createElement=function(tag,...args){const element=originalCreate(tag,...args);if(tag==='iframe')Object.defineProperty(element,'src',{set(){this.srcdoc='<p>Local iframe fixture only. No HighLevel form loaded.</p>';},configurable:true});return element;};
document.getElementById('fixture-enable').onclick=()=>{const card=document.querySelector('.quote-form');card.dataset.highlevelFormUrl='https://api.leadconnectorhq.com/widget/form/localFixtureOnly';EGCBookingHighLevel.mount(card);card.scrollIntoView();};
document.getElementById('fixture-error').onclick=()=>{document.querySelector('.ghl-booking iframe')?.dispatchEvent(new Event('error'));document.querySelector('.quote-form').scrollIntoView();};
</script>`;
http.createServer(async (request,response)=>{
  const pathname=new URL(request.url,'http://127.0.0.1').pathname;
  const fixtures = { '/staff-capture-fixture': ['tests/browser/walkthrough-capture-fixture.html', 'text/html'], '/crew/quote-draft.js': ['crew/quote-draft.js', 'text/javascript'], '/crew/quote-draft.css': ['crew/quote-draft.css', 'text/css'] };
  if (fixtures[pathname]) { const [file,type]=fixtures[pathname];response.writeHead(200,{'Content-Type':type+'; charset=utf-8'});response.end(fs.readFileSync(path.join(root,file)));return; }
  if(pathname==='/fixture'||pathname==='/homepage-fixture'||pathname==='/native-preview'){
    const native=pathname==='/native-preview';
    let html=fs.readFileSync(path.join(root,pathname==='/homepage-fixture'?'index.html':'book.html'),'utf8');
    html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>pathname==='/homepage-fixture'?(/src="[^\"]*(?:analytics-loader|fb-capture|googletagmanager)/.test(tag)?'':tag):/src="\/(?:site-forms|booking-slots|booking-highlevel)\.js/.test(tag)?tag:'');
    html=html.replace(/<noscript>[\s\S]*?<\/noscript>/gi,'');
    const preview=`<style>.reveal{opacity:1!important;transform:none!important}</style><aside class="fixture-controls"><strong>LOCAL NATIVE FORM PREVIEW — appearance only; do not submit.</strong><p>Loads the real branded form inside the local wrapper. The public website is unchanged.</p></aside><script>document.addEventListener('submit',event=>event.preventDefault(),true);const card=document.querySelector('.quote-form');card.dataset.highlevelFormUrl='https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0';EGCBookingHighLevel.mount(card);card.scrollIntoView();</script>`;
    html=html.replace('</body>',(native?preview:pathname==='/fixture'?harness:'<style>.reveal{opacity:1!important;transform:none!important}</style><script>document.addEventListener("submit",event=>event.preventDefault(),true)</script>')+'</body>');
    if(native){const secured=await onRequest({request:new Request('http://127.0.0.1:8768/book'),env:{},next:async()=>new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}})});response.writeHead(secured.status,Object.fromEntries(secured.headers));response.end(await secured.text());return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;
  }
  if(!/^\/(?:[a-zA-Z0-9_-]+\.(?:html|css|js|png|ico|webmanifest)|images\/[a-zA-Z0-9_./-]+)$/.test(pathname)||pathname.includes('..')){response.writeHead(404);response.end();return;}
  const file=path.join(root,pathname);
  try {const data=fs.readFileSync(file);const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';response.writeHead(200,{'Content-Type':type});response.end(data);} catch {response.writeHead(404);response.end();}
}).listen(8768,'127.0.0.1',()=>console.log('Local browser fixture: http://127.0.0.1:8768/fixture'));
