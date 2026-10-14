// Local manual browser harness. No real HighLevel URL is requested and no form
// submission is allowed. Start with node tests/browser/serve-booking-highlevel.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://127.0.0.1').pathname;
  const fixtures = { '/staff-capture-fixture': ['tests/browser/walkthrough-capture-fixture.html', 'text/html'], '/crew/quote-draft.js': ['crew/quote-draft.js', 'text/javascript'], '/crew/quote-draft.css': ['crew/quote-draft.css', 'text/css'] };
  if (fixtures[pathname]) { const [file,type]=fixtures[pathname];response.writeHead(200,{'Content-Type':type+'; charset=utf-8'});response.end(fs.readFileSync(path.join(root,file)));return; }
  if(pathname==='/fixture'||pathname==='/homepage-fixture'){
    let html=fs.readFileSync(path.join(root,pathname==='/fixture'?'book.html':'index.html'),'utf8');
    html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>pathname==='/homepage-fixture'?(/src="[^\"]*(?:analytics-loader|fb-capture|googletagmanager)/.test(tag)?'':tag):/src="\/(?:site-forms|booking-slots|booking-highlevel)\.js/.test(tag)?tag:'');
    html=html.replace(/<noscript>[\s\S]*?<\/noscript>/gi,'');
    html=html.replace('</body>',(pathname==='/fixture'?harness:'<style>.reveal{opacity:1!important;transform:none!important}</style><script>document.addEventListener("submit",event=>event.preventDefault(),true)</script>')+'</body>');
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;
  }
  if(!/^\/(?:[a-zA-Z0-9_-]+\.(?:html|css|js|png|ico|webmanifest)|images\/[a-zA-Z0-9_./-]+)$/.test(pathname)||pathname.includes('..')){response.writeHead(404);response.end();return;}
  const file=path.join(root,pathname);
  try {const data=fs.readFileSync(file);const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';response.writeHead(200,{'Content-Type':type});response.end(data);} catch {response.writeHead(404);response.end();}
}).listen(8768,'127.0.0.1',()=>console.log('Local browser fixture: http://127.0.0.1:8768/fixture'));
