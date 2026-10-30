/* GUARD-SELL: the Garage Guard sales tool, shared by the crew post-job playbook (crew/postjob.html), the estimator
   walkthrough after signing (crew/gameplan-handoff.js), the door-to-door app (crew/knock-guard.js) and the Hub
   (employee-guard-sales.js and the customer record in employee-suite.js).

   EGCGuardSell.open({channel, jobId, customerId, customer:{name,email,address}, fetch}) shows a sheet: the staff member
   picks Guard Black, Garage Guard or Guard Lite (name, yearly price and what is included, all from
   GET /api/garage-guard-sell, never from this file), optionally pre-fills the customer's email and garage address,
   and POST /api/garage-guard-sell opens the Stripe Checkout. The device then shows a big QR code of the short sign-up
   link, the link itself and Copy link; the customer scans it and pays on their own phone. While the sheet is open it
   asks the server every few seconds and shows "Member" once Stripe says the sign-up is paid. "Text it to the customer"
   appears only when the server says texting is on (EGC_GUARD_SALES_TEXT_ENABLED) and the sale was started from a job.

   It never shows or sends a job's prices. The QR code is drawn here (a small byte-mode QR encoder, below), never by an
   outside service. Loaded as a classic script or as a module import; either way it sets globalThis.EGCGuardSell. */
(function(){
'use strict';
const API='/api/garage-guard-sell';
const STYLESHEET='/crew/guard-sell.css?v=20261030guard1';
const POLL_MS=4000,POLL_LIMIT_MS=45*60*1000;

/* ---------- QR code (ISO/IEC 18004): byte mode, versions 1-20, error correction M by default ---------- */
// Error-correction codewords per block and number of blocks, by level and version (index 0 unused).
const ECC_PER_BLOCK={L:[0,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28],M:[0,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26],
  Q:[0,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30],H:[0,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28]};
const ECC_BLOCKS={L:[0,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8],M:[0,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16],
  Q:[0,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20],H:[0,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25]};
const FORMAT_LEVEL={L:1,M:0,Q:3,H:2},MAX_VERSION=20;
const rawModules=version=>{let result=(16*version+128)*version+64;if(version>=2){const align=Math.floor(version/7)+2;result-=(25*align-10)*align-55;if(version>=7)result-=36;}return result;};
const dataCodewords=(version,level)=>Math.floor(rawModules(version)/8)-ECC_PER_BLOCK[level][version]*ECC_BLOCKS[level][version];
function gfMultiply(x,y){let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;}
function rsDivisor(degree){
  const result=new Array(degree).fill(0);result[degree-1]=1;let root=1;
  for(let i=0;i<degree;i++){for(let j=0;j<degree;j++){result[j]=gfMultiply(result[j],root);if(j+1<degree)result[j]^=result[j+1];}root=gfMultiply(root,2);}
  return result;
}
function rsRemainder(data,divisor){
  const result=divisor.map(()=>0);
  for(const byte of data){const factor=byte^result.shift();result.push(0);divisor.forEach((coefficient,i)=>{result[i]^=gfMultiply(coefficient,factor);});}
  return result;
}
function alignmentPositions(version){
  if(version===1)return[];
  const count=Math.floor(version/7)+2,step=Math.ceil((version*4+4)/(count*2-2))*2,result=[6];
  for(let position=version*4+10;result.length<count;position-=step)result.splice(1,0,position);
  return result;
}
const MASKS=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,x=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
  (x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
const bit=(value,index)=>((value>>>index)&1)!==0;

function encodeCodewords(bytes,version,level){
  const bits=[],push=(value,length)=>{for(let i=length-1;i>=0;i--)bits.push((value>>>i)&1);};
  push(4,4);push(bytes.length,version<10?8:16);for(const byte of bytes)push(byte,8);
  const capacity=dataCodewords(version,level)*8;
  push(0,Math.min(4,capacity-bits.length));push(0,(8-bits.length%8)%8);
  const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((acc,b)=>acc<<1|b,0));
  for(let pad=0xec;data.length<capacity/8;pad^=0xec^0x11)data.push(pad);
  // Split into blocks, add each block's error correction, then interleave.
  const blocks=ECC_BLOCKS[level][version],eccLength=ECC_PER_BLOCK[level][version],raw=Math.floor(rawModules(version)/8);
  const shortBlocks=blocks-raw%blocks,shortLength=Math.floor(raw/blocks),divisor=rsDivisor(eccLength),split=[];
  for(let i=0,k=0;i<blocks;i++){
    const length=shortLength-eccLength+(i<shortBlocks?0:1),block=data.slice(k,k+length);k+=length;
    split.push({data:block,ecc:rsRemainder(block,divisor)});
  }
  const out=[];
  for(let i=0;i<=shortLength-eccLength;i++)for(const block of split)if(i<block.data.length)out.push(block.data[i]);
  for(let i=0;i<eccLength;i++)for(const block of split)out.push(block.ecc[i]);
  return out;
}

function penalty(modules){
  const size=modules.length;let score=0,dark=0;
  const lines=[];for(let y=0;y<size;y++){lines.push(modules[y]);lines.push(modules.map(row=>row[y]));}
  for(const line of lines){
    let run=1;for(let i=1;i<=size;i++){if(i<size&&line[i]===line[i-1])run++;else{if(run>=5)score+=run-2;run=1;}}
    const text=line.map(Number).join('');
    for(const pattern of ['10111010000','00001011101'])for(let at=text.indexOf(pattern);at>=0;at=text.indexOf(pattern,at+1))score+=40;
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    if(modules[y][x])dark++;
    if(x<size-1&&y<size-1&&modules[y][x]===modules[y][x+1]&&modules[y][x]===modules[y+1][x]&&modules[y][x]===modules[y+1][x+1])score+=3;
  }
  return score+Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;
}

/** The QR matrix for text (UTF-8, byte mode): {version, level, mask, size, modules: boolean[row][column]}. mask
    (0-7) forces one mask pattern; by default the one with the lowest penalty is used. */
function qrMatrix(text,{level='M',mask:forced=null}={}){
  if(!Object.hasOwn(FORMAT_LEVEL,level))throw new Error('Unknown QR error correction level');
  const bytes=[...new TextEncoder().encode(String(text))];
  let version=1;while(version<=MAX_VERSION&&4+(version<10?8:16)+bytes.length*8>dataCodewords(version,level)*8)version++;
  if(version>MAX_VERSION)throw new Error('This link is too long for a QR code');
  const size=version*4+17,modules=Array.from({length:size},()=>new Array(size).fill(false)),fixed=Array.from({length:size},()=>new Array(size).fill(false));
  const set=(x,y,dark)=>{modules[y][x]=dark;fixed[y][x]=true;};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
  const finder=(cx,cy)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy)),x=cx+dx,y=cy+dy;if(x>=0&&x<size&&y>=0&&y<size)set(x,y,d!==2&&d!==4);}};
  finder(3,3);finder(size-4,3);finder(3,size-4);
  const align=alignmentPositions(version),last=align.length-1;
  for(let i=0;i<align.length;i++)for(let j=0;j<align.length;j++){
    if(i===0&&j===0||i===0&&j===last||i===last&&j===0)continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(align[i]+dx,align[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }
  const drawFormat=mask=>{
    const data=FORMAT_LEVEL[level]<<3|mask;let rem=data;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
    const bits=(data<<10|rem)^0x5412;
    for(let i=0;i<=5;i++)set(8,i,bit(bits,i));
    set(8,7,bit(bits,6));set(8,8,bit(bits,7));set(7,8,bit(bits,8));
    for(let i=9;i<15;i++)set(14-i,8,bit(bits,i));
    for(let i=0;i<8;i++)set(size-1-i,8,bit(bits,i));
    for(let i=8;i<15;i++)set(8,size-15+i,bit(bits,i));
    set(8,size-8,true);
  };
  drawFormat(0);
  if(version>=7){
    let rem=version;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1f25);
    const bits=version<<12|rem;
    for(let i=0;i<18;i++){const a=size-11+i%3,b=Math.floor(i/3);set(a,b,bit(bits,i));set(b,a,bit(bits,i));}
  }
  const codewords=encodeCodewords(bytes,version,level);
  for(let right=size-1,i=0;right>=1;right-=2){
    if(right===6)right=5;
    for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){
      const x=right-j,upward=((right+1)&2)===0,y=upward?size-1-vert:vert;
      if(!fixed[y][x]&&i<codewords.length*8){modules[y][x]=bit(codewords[i>>>3],7-(i&7));i++;}
    }
  }
  const masked=mask=>{
    const copy=modules.map(row=>row.slice());
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(!fixed[y][x]&&MASKS[mask](x,y))copy[y][x]=!copy[y][x];
    return copy;
  };
  let best=null;
  for(let mask=0;mask<8;mask++){
    if(forced!==null&&mask!==forced)continue;
    drawFormat(mask);
    const candidate=masked(mask);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(fixed[y][x])candidate[y][x]=modules[y][x];
    const score=penalty(candidate);
    if(!best||score<best.score)best={mask,score,modules:candidate};
  }
  return{version,level,mask:best.mask,size,modules:best.modules};
}

/** An <svg> element of the QR code with a 4-module quiet zone. */
function qrSvg(text,{label='QR code'}={}){
  const qr=qrMatrix(text),border=4,full=qr.size+border*2,ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox',`0 0 ${full} ${full}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',label);svg.setAttribute('shape-rendering','crispEdges');
  const back=document.createElementNS(ns,'rect');back.setAttribute('width',String(full));back.setAttribute('height',String(full));back.setAttribute('fill','#fff');
  const path=document.createElementNS(ns,'path');let d='';
  for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.modules[y][x])d+=`M${x+border} ${y+border}h1v1h-1z`;
  path.setAttribute('d',d);path.setAttribute('fill','#000');
  svg.append(back,path);
  return svg;
}

/* ---------- the sales sheet ---------- */
const CHANNELS=['postjob','walkthrough','knock','hub'];
let current=null;
const text=(value,max=300)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,max):'';
function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props||{})){
    if(value===null||value===undefined||value===false)continue;
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);
    else node.setAttribute(key,value===true?'':String(value));
  }
  for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const price=cents=>Number.isSafeInteger(cents)&&cents>0?'$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:cents%100?2:0,maximumFractionDigits:2}):'';
const requestId=()=>{try{if(globalThis.crypto?.randomUUID)return crypto.randomUUID();}catch{}const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');};
function ensureStyles(){
  if(document.querySelector('link[data-egc-guard-sell]'))return;
  document.head.append(el('link',{rel:'stylesheet',href:STYLESHEET,'data-egc-guard-sell':'1'}));
}
async function call(state,path,{method='GET',body}={}){
  const send=state.fetch||((url,init)=>fetch(url,{credentials:'same-origin',...init}));
  let response;
  try{response=await send(path,{method,cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});}
  catch(error){throw Object.assign(new Error(error?.code==='HUB_AUTH_REQUIRED'?error.message:'No connection. Garage Guard sign-up needs signal.'),{status:0});}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.ok===false)throw Object.assign(new Error(data?.error||`Garage Guard sign-up failed (${response.status}).`),{status:response.status,code:data?.code||''});
  return data;
}
async function copyText(value){
  try{await navigator.clipboard.writeText(value);return true;}
  catch{
    const field=el('textarea',{readonly:true,'aria-hidden':'true',style:'position:fixed;left:-9999px;top:0'});field.value=value;document.body.append(field);field.select();
    let copied=false;try{copied=document.execCommand('copy');}catch{}field.remove();return copied;
  }
}

function stopPolling(state){clearTimeout(state.timer);state.timer=null;}
function close(){
  const state=current;if(!state)return;
  current=null;stopPolling(state);state.closed=true;
  document.removeEventListener('keydown',state.onKey,true);
  state.root.remove();document.documentElement.classList.remove('egs-open');
  try{state.opener?.focus?.();}catch{}
  if(typeof state.onClose==='function')try{state.onClose({member:state.member===true,sessionId:state.sale?.sessionId||'',plan:state.sale?.plan?.name||''});}catch{}
}

function render(state){
  const body=state.body;body.replaceChildren();
  // A new step starts at the top of the sheet (the code, not the buttons the staff member just tapped).
  if(state.renderedStep!==state.step){state.renderedStep=state.step;if(body.parentElement)body.parentElement.scrollTop=0;}
  state.title.textContent=state.step==='code'?'Scan to join':'Garage Guard';
  if(state.step==='loading'){body.append(el('p',{class:'egs-muted',role:'status',text:'Loading the plans…'}));return;}
  if(state.step==='error'){
    body.append(el('p',{class:'egs-error',role:'alert',text:state.error}),el('div',{class:'egs-actions'},el('button',{type:'button',class:'egs-btn egs-primary',onclick:()=>load(state)},'Try again'),el('button',{type:'button',class:'egs-btn',onclick:close},'Close')));
    return;
  }
  if(state.step==='pick')return renderPick(state,body);
  return renderCode(state,body);
}

function renderPick(state,body){
  const who=text(state.customer.name,120);
  if(who)body.append(el('p',{class:'egs-for'},'For ',el('strong',{},who)));
  if(!state.config.configured)body.append(el('p',{class:'egs-error',role:'alert',text:'Stripe is not set up for Garage Guard yet. Ask the office.'}));
  const list=el('div',{class:'egs-plans',role:'group','aria-label':'Garage Guard plan'});
  for(const plan of state.config.plans){
    const chosen=state.plan===plan.key;
    list.append(el('button',{type:'button',class:'egs-plan'+(chosen?' is-on':''),'aria-pressed':String(chosen),'data-plan':plan.key,onclick:()=>{state.plan=plan.key;state.error='';render(state);}},
      el('span',{class:'egs-plan-head'},el('strong',{},plan.name),el('span',{class:'egs-price'},price(plan.amountCents),el('small',{},' a year'))),
      el('span',{class:'egs-includes'},...plan.includes.map(item=>el('span',{class:'egs-inc'},item)))));
  }
  body.append(list);
  const email=el('input',{id:'egs-email',type:'email',inputmode:'email',autocomplete:'off',autocapitalize:'none',spellcheck:'false',maxlength:'254',placeholder:'name@example.com'});
  email.value=state.customer.email||'';email.addEventListener('input',()=>{state.customer.email=email.value;});
  const address=el('input',{id:'egs-address',type:'text',autocomplete:'off',maxlength:'255',placeholder:'Street and city'});
  address.value=state.customer.address||'';address.addEventListener('input',()=>{state.customer.address=address.value;});
  body.append(el('fieldset',{class:'egs-fields'},el('legend',{},'Fill in for the customer (optional)'),
    el('label',{for:'egs-email'},'Email for the receipt'),email,
    el('label',{for:'egs-address'},'Garage address'),address,
    el('p',{class:'egs-muted',text:'The customer can change the address on the Stripe page. Leave a field empty for them to type it.'})));
  if(state.error)body.append(el('p',{class:'egs-error',role:'alert',text:state.error}));
  const plan=state.config.plans.find(item=>item.key===state.plan);
  body.append(el('div',{class:'egs-actions'},el('button',{type:'button',class:'egs-btn egs-primary',disabled:!plan||state.busy||!state.config.configured,onclick:()=>startSale(state)},state.busy?'Opening Stripe…':plan?`Show sign-up code · ${plan.name}`:'Pick a plan')),
    el('p',{class:'egs-muted egs-small',text:'Billed once a year by Stripe. The customer pays on their own phone; card details never touch this device.'}));
}

function statusLine(state){
  if(state.member)return el('p',{class:'egs-status is-member',role:'status'},el('strong',{},'Member'),' — payment received. Welcome them to Garage Guard!');
  if(state.saleStatus==='expired')return el('p',{class:'egs-status is-expired',role:'status',text:'This sign-up expired. Pick a plan to make a new code.'});
  if(state.saleStatus==='complete')return el('p',{class:'egs-status',role:'status',text:'Checkout finished; Stripe is still confirming the payment.'});
  return el('p',{class:'egs-status',role:'status',text:state.pollStopped?'Still waiting? Tap Check again after they pay.':'Waiting for the customer to pay on their phone…'});
}

function renderCode(state,body){
  const sale=state.sale,plan=sale.plan;
  body.append(el('p',{class:'egs-plan-line'},el('strong',{},plan.name),` · ${price(plan.amountCents)} a year`));
  let code;
  try{code=el('div',{class:'egs-qr'},qrSvg(sale.link,{label:`QR code: ${plan.name} sign-up link`}));}
  catch{code=el('p',{class:'egs-error',role:'alert',text:'The code could not be drawn. Copy the link instead.'});}
  body.append(code,el('p',{class:'egs-hint',text:'Have the customer point their phone camera at the code and tap the link.'}));
  body.append(el('a',{class:'egs-link',href:sale.link,target:'_blank',rel:'noopener noreferrer','aria-label':'Open the sign-up link on this device'},sale.link));
  const actions=el('div',{class:'egs-actions'});
  actions.append(el('button',{type:'button',class:'egs-btn egs-primary',onclick:async event=>{const ok=await copyText(sale.link);state.notice=ok?'Link copied. Paste it into a text or email to the customer.':'Copy did not work here. Press and hold the link to copy it.';state.noticeError=!ok;render(state);event?.target?.focus?.();}},'Copy link'));
  if(state.config.textEnabled&&state.jobId&&!state.member&&state.saleStatus==='open')actions.append(el('button',{type:'button',class:'egs-btn',disabled:state.texting||state.texted,onclick:()=>textLink(state)},state.texted?'Texted':state.texting?'Sending…':'Text it to the customer'));
  body.append(actions);
  if(state.notice)body.append(el('p',{class:state.noticeError?'egs-error':'egs-muted',role:state.noticeError?'alert':'status',text:state.notice}));
  body.append(statusLine(state));
  const more=el('div',{class:'egs-actions egs-actions-quiet'});
  if(!state.member&&state.saleStatus!=='complete'&&state.pollStopped)more.append(el('button',{type:'button',class:'egs-btn',onclick:()=>{state.pollStopped=false;state.pollStarted=Date.now();poll(state);render(state);}},'Check again'));
  if(!state.member)more.append(el('button',{type:'button',class:'egs-btn',onclick:()=>{stopPolling(state);state.step='pick';state.sale=null;state.notice='';state.texted=false;render(state);}},'Choose another plan'));
  more.append(el('button',{type:'button',class:'egs-btn',onclick:close},state.member?'Done':'Close'));
  body.append(more);
}

async function load(state){
  state.step='loading';render(state);
  try{
    const config=await call(state,API);
    if(state.closed)return;
    state.config={configured:config.configured===true,textEnabled:config.textEnabled===true,plans:(Array.isArray(config.plans)?config.plans:[]).filter(plan=>plan&&typeof plan.key==='string'&&typeof plan.name==='string'&&Number.isSafeInteger(plan.amountCents)&&Array.isArray(plan.includes))};
    if(!state.config.plans.length)throw new Error('No Garage Guard plans are available right now.');
    state.step='pick';
  }catch(error){if(state.closed)return;state.step='error';state.error=error.message||'Garage Guard plans could not be loaded.';}
  render(state);
}

async function startSale(state){
  if(state.busy||!state.plan)return;
  state.busy=true;state.error='';render(state);
  try{
    const fields={plan:state.plan,channel:state.channel,
      ...(state.jobId?{jobId:state.jobId}:{}),...(state.customerId?{customerId:state.customerId}:{}),
      ...(text(state.customer.email,254)?{email:text(state.customer.email,254)}:{}),...(text(state.customer.address,255)?{address:text(state.customer.address,255)}:{})};
    // A retry of the same sign-up keeps its request id (Stripe answers the same session); any change gets a new one.
    const signature=JSON.stringify(fields);
    if(!state.requestId||state.requestSignature!==signature){state.requestId=requestId();state.requestSignature=signature;}
    const sale=await call(state,API,{method:'POST',body:{action:'start',requestId:state.requestId,...fields}});
    if(state.closed)return;
    if(typeof sale.link!=='string'||!/^https?:\/\//.test(sale.link)||typeof sale.sessionId!=='string')throw new Error('The sign-up link came back incomplete. Try again.');
    state.sale=sale;state.requestId='';state.saleStatus='open';state.member=false;state.step='code';state.notice='';state.texted=false;state.pollStopped=false;state.pollStarted=Date.now();
    poll(state);
  }catch(error){if(state.closed)return;state.error=error.message||'Stripe could not start the sign-up. Try again.';if(error.status&&error.status<500)state.requestId='';}
  finally{state.busy=false;if(!state.closed)render(state);}
}

function poll(state){
  stopPolling(state);
  state.timer=setTimeout(async()=>{
    if(state.closed||!state.sale)return;
    if(Date.now()-state.pollStarted>POLL_LIMIT_MS){state.pollStopped=true;render(state);return;}
    if(document.visibilityState==='visible'){
      try{
        const result=await call(state,`${API}?session=${encodeURIComponent(state.sale.sessionId)}`);
        if(state.closed||!state.sale)return;
        const changed=result.status!==state.saleStatus||(result.member===true)!==state.member;
        state.saleStatus=['open','complete','expired'].includes(result.status)?result.status:state.saleStatus;state.member=result.member===true;
        if(changed)render(state);
        if(state.member||state.saleStatus==='expired')return;
      }catch{/* A missed check is tried again on the next tick. */}
    }
    poll(state);
  },POLL_MS);
}

async function textLink(state){
  if(state.texting||state.texted||!state.sale)return;
  state.texting=true;state.notice='';render(state);
  try{
    const result=await call(state,API,{method:'POST',body:{action:'text',requestId:requestId(),sessionId:state.sale.sessionId}});
    const status=result.delivery?.status;
    state.texted=['sent','queued','uncertain'].includes(status);
    state.notice={sent:'Texted to the customer’s phone on file.',queued:'Text queued to the customer’s phone on file.',uncertain:'HighLevel did not confirm the text. Show the code instead of sending it again.',
      suppressed:'This customer does not take texts. Show the code or copy the link.',needs_contact:'This job has no customer contact to text. Show the code instead.',not_configured:'Texting is not set up. Show the code instead.',failed:'The text was not sent. Show the code instead.'}[status]||'The text was not sent. Show the code instead.';
    state.noticeError=!['sent','queued'].includes(status);
  }catch(error){state.notice=error.message||'The text was not sent. Show the code instead.';state.noticeError=true;state.texted=error.code==='guard_sales_text_already_sent';}
  finally{state.texting=false;if(!state.closed)render(state);}
}

/** Open the sales sheet. opts: {channel:'postjob'|'walkthrough'|'knock'|'hub', jobId, customerId, customer:{name,email,address}, fetch, onClose}.
    onClose({member, sessionId, plan}) runs when the sheet closes; plan is the plan's name. */
function open(opts={}){
  if(current)close();
  if(!CHANNELS.includes(opts.channel))throw new Error('EGCGuardSell.open needs a channel');
  ensureStyles();
  const customer=opts.customer||{};
  const state={channel:opts.channel,jobId:text(opts.jobId,128),customerId:text(opts.customerId,128),customer:{name:text(customer.name,120),email:text(customer.email,254),address:text(customer.address,255)},
    fetch:typeof opts.fetch==='function'?opts.fetch:(typeof window.EGCHubAuth?.fetch==='function'?window.EGCHubAuth.fetch:null),onClose:opts.onClose,opener:document.activeElement,
    step:'loading',plan:'',config:null,sale:null,busy:false,error:'',notice:'',timer:null,closed:false,member:false,saleStatus:'',requestId:''};
  state.title=el('h2',{id:'egs-title'},'Garage Guard');
  state.body=el('div',{class:'egs-body'});
  const closeButton=el('button',{type:'button',class:'egs-x','aria-label':'Close Garage Guard sign-up',onclick:close},'×');
  const sheet=el('section',{class:'egs-sheet',role:'dialog','aria-modal':'true','aria-labelledby':'egs-title',tabindex:'-1'},
    el('header',{class:'egs-head'},el('div',{},el('span',{class:'egs-eyebrow'},'Sell a membership'),state.title),closeButton),state.body);
  state.root=el('div',{class:'egs-backdrop','data-egc-guard-sell':'open',onclick:event=>{if(event.target===state.root)close();}},sheet);
  state.onKey=event=>{if(event.key==='Escape'){event.preventDefault();close();}};
  document.addEventListener('keydown',state.onKey,true);
  document.body.append(state.root);document.documentElement.classList.add('egs-open');
  current=state;
  sheet.focus();
  load(state);
  return state;
}

/** A ready-made button that opens the sheet; opts as open() (a function is called at tap time for fresh job details). */
function button(opts,{label='Sell Garage Guard',className='egs-launch'}={}){
  ensureStyles();
  return el('button',{type:'button',class:className,onclick:()=>open(typeof opts==='function'?opts():opts)},label);
}

globalThis.EGCGuardSell=Object.freeze({open,close,button,qrMatrix,qrSvg,_test:Object.freeze({rsDivisor,rsRemainder,dataCodewords,alignmentPositions,encodeCodewords})});
})();
