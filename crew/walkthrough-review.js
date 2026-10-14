(function(root){
'use strict';
const groups=[
 ['Customer and scope', [['customerName','Customer name'],['phone','Phone'],['address','Service address'],['customerConfirmed','Customer identity checked','check'],['addressConfirmed','Address checked','check'],['serviceType','Service','select',['garage_cleanout','junk_removal','organization','cleaning','other']],['scopeSummary','Work to include','area'],['boundariesReviewed','Scope boundaries reviewed','check']]],
 ['Keep, remove and donate', [['sortMethod','Sorting plan'],['keepItems','Keep / protect','area'],['removeItems','Remove','area'],['donateItems','Donate / destination preferences','area'],['exclusions','Exclusions — enter None if none','area'],['decisionsReviewed','Keep/remove/donate decisions reviewed','check']]],
 ['Access, hazards and damage', [['accessNotes','Access, pets, codes and constraints','area'],['parkingNotes','Parking / truck placement'],['accessReviewed','Access reviewed; note any restrictions','check'],['hazards','Hazards — one per line; No visible hazards if none','list'],['hazardPlan','Hazard handling / stop-work plan','area'],['hazardsReviewed','Hazards reviewed','check'],['damageNotes','Existing damage observations; note none if none','area'],['damageReviewed','Existing damage reviewed','check']]],
 ['Measurements, equipment and labor', [['garageSize','Garage size'],['fullness','Fullness'],['loadEstimate','Estimated truckloads'],['specialItems','Special items and quantities — one per line','list'],['measurementsReviewed','Measurement needs reviewed','check'],['measurementsNeeded','Job requires measurements','check'],['measurements','Relevant measurements, units and locations','area'],['finish','Finish selections — one per line','list'],['shelfType','Shelf type if shelving selected'],['shelfQty','Shelf quantity if shelving selected','number'],['toteQty','Bin / tote quantity if selected','number'],['equipment','Equipment / shelf / bin needs or None','area'],['equipmentReviewed','Equipment needs reviewed','check'],['crewSize','Estimated crew size','number'],['estimatedDurationMin','Estimated on-site minutes','number']]],
 ['Photos and customer questions', [['photoUnavailableReason','If no server-saved reference photos: explain why, including device-only photos awaiting upload','area'],['customerQuestions','Questions / unresolved customer decisions','area'],['questionsReviewed','Customer questions reviewed','check']]],
 ['Pricing reference and handoff', [['pricingStatus','Pricing status','select',['quote_saved','needs_quote']],['quoteJobId','Linked saved quote job ID (normally prefilled)'],['pricingReviewed','Pricing status / quote revision checked against this scope','check'],['pricingReviewNote','Pricing revision / work still needed — internal only','area'],['handoffNotes','Crew handoff notes','area']]],
];
function h(tag,props,...children){const el=document.createElement(tag);for(const [key,value]of Object.entries(props||{})){if(key.startsWith('on'))el.addEventListener(key.slice(2),value);else if(key in el)el[key]=value;else el.setAttribute(key,value);}for(const c of children.flat())if(c!=null)el.append(c instanceof Node?c:document.createTextNode(String(c)));return el;}
const clone=v=>JSON.parse(JSON.stringify(v));
const reviewsFor={customerName:['customerConfirmed'],phone:['customerConfirmed'],address:['addressConfirmed'],accessNotes:['accessReviewed'],parkingNotes:['accessReviewed'],serviceType:['boundariesReviewed','pricingReviewed'],scopeSummary:['boundariesReviewed','pricingReviewed'],sortMethod:['decisionsReviewed'],specialItems:['decisionsReviewed','pricingReviewed'],keepItems:['decisionsReviewed','pricingReviewed'],removeItems:['decisionsReviewed','pricingReviewed'],donateItems:['decisionsReviewed'],exclusions:['boundariesReviewed','decisionsReviewed','pricingReviewed'],hazards:['hazardsReviewed','pricingReviewed'],hazardPlan:['hazardsReviewed'],damageNotes:['damageReviewed'],measurementsNeeded:['measurementsReviewed'],measurements:['measurementsReviewed'],equipment:['equipmentReviewed'],finish:['equipmentReviewed','pricingReviewed'],shelfType:['equipmentReviewed','pricingReviewed'],shelfQty:['equipmentReviewed','pricingReviewed'],toteQty:['equipmentReviewed','pricingReviewed'],customerQuestions:['questionsReviewed'],pricingStatus:['pricingReviewed'],quoteJobId:['pricingReviewed'],crewSize:['pricingReviewed'],estimatedDurationMin:['pricingReviewed']};
function updateData(data,key,value){data[key]=value;for(const flag of reviewsFor[key]||[])data[flag]=false;return reviewsFor[key]||[];}
function resumeData(base,review,local){if(local.pending)return clone(local.pending.data);if(review.stage==='finalized')return clone(review.draft);return{...base,...review.draft,...(local.baseRevision===review.revision?local.data||{}:{})};}
function requestClient({fetcher,storage,actor,jobId}){
 const key=`egc-walkthrough-review-v1:${actor}:${jobId||'manual'}`;
 const read=()=>{try{const value=JSON.parse(storage.getItem(key)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{storageError:true};}catch{return{storageError:true};}};
 const write=value=>storage.setItem(key,JSON.stringify(value));
 async function call(body){const response=await fetcher('/api/walkthrough-capture'+(body?'':'?jobId='+encodeURIComponent(jobId)),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});let data;try{data=await response.json();}catch{throw new Error('The server response was unreadable. Retry the saved request.');}if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||'Capture unavailable.'),{status:response.status,details:data.details});return data;}
 return{read,write,load:()=>call(),async send(action,data,expectedRevision,reason=''){
   let local=read();if(local.storageError)throw new Error('The saved recovery record is unreadable. Review the server capture before clearing device storage or resubmitting.');let body=local.pending;
   if(!body){body={action,data:clone(data),expectedRevision,reason,actorId:actor,jobId,requestId:crypto.randomUUID()};write({...local,pending:body});}
   try{const result=await call(body);write({data:result.review.draft,baseRevision:result.review.revision});return result;}
   catch(error){if(error.status>=400&&error.status<500&&![401,403,408,429].includes(error.status)){local=read();delete local.pending;write(local);}throw error;}
 }};
}
async function open(options){
 if(document.querySelector('.wr-dialog'))return;
 const actor=await options.actor();if(!actor)return;
 const jobId=options.jobId(),client=requestClient({fetcher:options.fetcher,storage:options.storage,actor,jobId});
 let data={...options.base()},review={revision:0,stage:'draft'},busy=false,gaps=[],message='',savedLocal=client.read(),conflictDraft=null,quoteSummary=null;
 const dialog=h('dialog',{className:'wr-dialog','aria-labelledby':'wr-title'}),body=h('div'),status=h('p',{role:'status'}),errors=h('ul',{role:'alert'}),buttons=h('div',{className:'wr-buttons'});
 const close=()=>{dialog.close();dialog.remove();root.removeEventListener('egc:signout',signout);};
 const signout=()=>{options.storage.removeItem(`egc-walkthrough-review-v1:${actor}:${jobId||'manual'}`);close();};
 root.addEventListener('egc:signout',signout);
 dialog.append(h('h2',{id:'wr-title'},'Staff walkthrough review'),h('p',{},'Save partial work at any point. Finalization records an internal reviewed revision — it never signs, charges or confirms a customer booking.'),status,errors,body,buttons);
 document.body.append(dialog);dialog.showModal();
 function persist(){const prior=client.read();if(!prior.storageError)client.write({...prior,data:clone(data),baseRevision:review.revision});}
 function conditional(){for(const [key,visible]of [['measurements',data.measurementsNeeded===true],['shelfType',(data.finish||[]).includes('shelving')],['shelfQty',(data.finish||[]).includes('shelving')],['toteQty',(data.finish||[]).includes('totes')]]){const label=body.querySelector(`[data-review-field="${key}"]`);if(label)label.hidden=!visible;}}
 function render(){
  const recovery=client.read(),pending=recovery.pending,locked=busy||!!pending||review.stage==='finalized'||recovery.storageError;
  status.textContent=recovery.storageError?'Device recovery data is unreadable. Review the server capture before clearing device storage or resubmitting.':message||(jobId?`Revision ${review.revision}: ${review.stage}.`:'No linked Hub record: changes save on this device only. Select a walkthrough to save on the server.');
  errors.replaceChildren(...gaps.map(g=>h('li',{},h('button',{type:'button',onclick:()=>{const input=dialog.querySelector(`[name="${g.field}"]`);if(input){input.closest('details').open=true;input.focus();}}},g.message))));
  body.replaceChildren(...groups.map(([name,fields],i)=>h('details',{open:i===0},h('summary',{},name),...fields.map(([key,label,type='text',values])=>{
   let input;
   const change=()=>{const value=type==='check'?input.checked:type==='number'?(input.value===''?null:Number(input.value)):type==='list'?input.value.split('\n').map(x=>x.trim()).filter(Boolean):input.value;for(const flag of updateData(data,key,value)){const check=body.querySelector(`[name="${flag}"]`);if(check)check.checked=false;}persist();conditional();};
   if(type==='select'){input=h('select',{name:key,disabled:locked,onchange:change},h('option',{value:''},'Choose…'),...values.map(v=>h('option',{value:v},v.replaceAll('_',' '))));input.value=data[key]||'';}
   else if(type==='area'||type==='list')input=h('textarea',{name:key,disabled:locked,value:type==='list'?(data[key]||[]).join('\n'):data[key]||'',oninput:change});
   else input=h('input',{name:key,type:type==='check'?'checkbox':type,disabled:locked,...(type==='check'?{checked:data[key]===true}:{value:data[key]??''}),oninput:change});
   return h('label',{className:type==='check'?'wr-check':'','data-review-field':key},label,input);
  }))));
  conditional();
  if(quoteSummary)body.append(h('p',{},`Saved quote ${quoteSummary.number}, revision ${quoteSummary.revision}, total ${Number.isSafeInteger(quoteSummary.amountCents)?'$'+(quoteSummary.amountCents/100).toFixed(2):'needs review'}. Customer acceptance is separate.`));
  const actions=[h('button',{type:'button',disabled:busy,onclick:close},'Close')];
  if(conflictDraft)actions.push(h('button',{type:'button',disabled:busy,onclick:()=>{data={...data,...conflictDraft};conflictDraft=null;persist();message='Local changes restored for review against the current revision.';render();}},'Restore my unsaved changes'));
  if(recovery.storageError){}else if(pending)actions.push(h('button',{type:'button',disabled:busy,onclick:()=>send(pending.action,pending.reason)},'Retry original save'));
  else if(review.stage==='finalized')actions.push(h('button',{type:'button',onclick:()=>{const reasonInput=h('input',{placeholder:'Reason for amendment','aria-label':'Reason for amendment'});buttons.append(reasonInput,h('button',{type:'button',onclick:()=>send('amend',reasonInput.value)},'Start amendment'));reasonInput.focus();}},'Amend finalized revision'));
  else actions.push(h('button',{type:'button',disabled:busy,onclick:()=>send('save')},'Save partial draft'),h('button',{type:'button',disabled:busy||!jobId,onclick:()=>send('finalize')},'Finalize staff review'));
  buttons.replaceChildren(...actions);
 }
 async function send(action,reason=''){
  if(busy)return;if(!jobId){persist();message='Partial draft saved on this device; link a Hub walkthrough for server save.';render();return;}
  busy=true;gaps=[];render();
  try{const result=await client.send(action,data,review.revision,reason);review=result.review;quoteSummary=result.quoteSummary;data=clone(review.draft);message=result.replayed&&result.savedRevision!==review.revision?`Original revision ${result.savedRevision} save recovered. Showing current revision ${review.revision}; it was not overwritten.`:`Revision ${review.revision} ${review.stage==='finalized'?'finalized internally':'saved on the server'}.`;options.onSaved?.(data);}
  catch(error){message=error.message;gaps=error.details?.gaps||[];}
  finally{busy=false;render();}
 }
 render();
 if(jobId){busy=true;render();try{const result=await client.load();review=result.review;quoteSummary=result.quoteSummary;data=resumeData(data,review,savedLocal);
   if(savedLocal.pending)message='An earlier save has an unknown result. Retry it unchanged before editing.';
   else if(review.stage!=='finalized'&&savedLocal.data&&savedLocal.baseRevision!==review.revision){conflictDraft=savedLocal.data;message='The server revision differs. Your local changes are preserved separately.';}
   if(result.pricingChanged)message+=' Pricing changed since finalization; start an amendment to review it.';
  }catch(error){message=error.message;}finally{busy=false;render();}}
 else if(savedLocal.data){data={...data,...savedLocal.data};render();}
}
root.EGCWalkthroughReview={open,requestClient,resumeData,updateData};
})(window);
