/* Schedule alerts: the signed-in employee's own crew notices from dispatch
   (new job, moved, removed, cancelled, back on), acknowledgement, and the
   opt-in for schedule texts. Dispatchers also see who can be texted, link each
   crew member's HighLevel staff contact and retry notices that were not
   texted. Registered Hub screen; runs standalone too. */
(function(){
'use strict';
const PATH='/api/crew-notifications',SCREEN='crew_alerts';
const INTENTS={assigned:'New job',time_changed:'Job moved',restored:'Job back on',unassigned:'Removed from job',cancelled:'Job cancelled'};
const REMOVALS=new Set(['unassigned','cancelled']);
const DELIVERY={texted:'Texted',queued:'Text queued',unconfirmed:'Text not confirmed',grouped:'In one text with your other new visits',covered:'In a later text',read_in_hub:'Read in the Hub',not_texted:'Not texted'};
const TEAM_STATUS={needs_contact:'Needs contact',not_opted_in:'Texts off',failed:'Failed',suppressed:'Blocked',uncertain:'Not confirmed'};
const REASONS={staff_contact_not_linked:'No HighLevel staff contact is linked for them.',staff_tag_missing:'Their HighLevel contact is not tagged egc-staff.',no_phone:'No mobile number is on their employee account.',
  sms_not_opted_in:'They have not turned on schedule texts.',contact_identity_mismatch:'The linked contact\'s number or location does not match their employee account.',contact_not_found:'The linked HighLevel contact was not found.',
  contact_id_invalid:'The linked HighLevel contact ID is not valid.',contact_dnd_sms:'Their HighLevel contact is set to Do Not Disturb for texts.',no_sms_consent:'Their HighLevel contact has no SMS consent.',
  crew_contact_unavailable:'Their employee account is not approved.',attempts_exhausted:'HighLevel refused this text three times.',
  messaging_sms_too_long:'The approved wording leaves too little room to name every changed day in one text. Shorten it at Message templates, then send again.'};
const CONTACT=/^[A-Za-z0-9_-]{1,120}$/;
const ERRORS={crew_notifications_not_enabled:'Schedule alerts are not turned on for this Hub yet.',crew_notifications_revision_conflict:'Your text setting changed on another device. The latest setting is shown; review it and save again.',crew_notifications_not_found:'A notice was already cleared. Your list was refreshed.'};
// smsDraft and contactDraft hold what was changed and not saved yet (the text setting, the contact ID being edited), so a
// refresh draws them back; refresh() from the Hub waits while either differs from what is saved.
const S={root:null,ctx:null,gen:0,data:null,busy:false,message:'',error:'',loadError:null,team:null,teamError:null,teamGen:0,editing:'',smsDraft:null,contactDraft:null};
const kit=()=>window.EGCHubKit;
const DATE=/^\d{4}-\d{2}-\d{2}$/,TIME=/^([01]\d|2[0-3]):([0-5]\d)$/;
// Denver wall-clock values are shown as saved, never converted through the device time zone.
function day(date){return DATE.test(String(date||''))?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z')):'';}
function clock(time){const match=TIME.exec(String(time||''));if(!match)return'';const hour=Number(match[1]);return`${hour%12||12}:${match[2]} ${hour<12?'AM':'PM'}`;}
function slotText(slot){
  if(!slot)return'';
  const start=clock(slot.time),end=clock(slot.endTime),span=slot.endDate&&slot.endDate!==slot.date?` to ${day(slot.endDate)}`:'';
  return`${day(slot.date)}${start?' · '+start+(end?'–'+end:''):''}${span}`;
}
function slotsText(slots){const list=(slots||[]).map(slotText).filter(Boolean);return list.length>3?[...list.slice(0,3),`+${list.length-3} more`].join('; '):list.join('; ');}
function validSlot(slot){return slot&&typeof slot==='object'&&DATE.test(String(slot.date||''))&&typeof slot.time==='string';}
const noticeValid=row=>row&&typeof row.id==='string'&&Object.hasOwn(INTENTS,row.intent)&&validSlot(row.slot)&&Array.isArray(row.slots)&&Array.isArray(row.previousSlots)&&(row.lostSlots===undefined||Array.isArray(row.lostSlots))
  &&(row.heardSlots===undefined||row.heardSlots===null||Array.isArray(row.heardSlots));
function validate(data){
  return Array.isArray(data.notices)&&data.notices.every(noticeValid)
    &&data.preferences&&typeof data.preferences.sms==='boolean'&&typeof data.preferences.revision==='string'&&data.coverage&&typeof data.coverage.complete==='boolean';
}
const prefsValid=data=>Boolean(data.preferences&&typeof data.preferences.sms==='boolean'&&typeof data.preferences.revision==='string');
const viewerId=()=>String(S.ctx?.identity||'').trim().toLowerCase()||undefined;
const pending=()=>kit().pending(SCREEN,viewerId());
const teamPending=()=>kit().pending(SCREEN+'_team',viewerId());
const dispatcher=()=>[...(S.ctx?.capabilities||[])].includes('business');
const memberValid=row=>row&&typeof row.id==='string'&&typeof row.name==='string'&&typeof row.sms==='boolean'&&typeof row.staffContactId==='string'&&typeof row.revision==='string';
const teamValid=data=>Array.isArray(data.team)&&data.team.every(memberValid)&&Array.isArray(data.attention)&&data.attention.every(row=>noticeValid(row)&&typeof row.employeeId==='string'&&typeof row.status==='string'&&typeof row.canRetry==='boolean')&&data.coverage&&typeof data.coverage.complete==='boolean';
function say(text,error=false){S.message=error?'':text;S.error=error?text:'';}
function dirty(){
  const member=S.editing&&S.team?.team.find(row=>row.id===S.editing);
  return S.smsDraft!==null&&S.smsDraft!==S.data?.preferences?.sms||Boolean(member)&&S.contactDraft!==null&&S.contactDraft!==member.staffContactId;
}
function errorText(error){return kit().errorText(error,ERRORS);}

async function load(){
  const gen=++S.gen;S.loadError=null;
  if(!S.data)render();
  try{
    const data=await kit().requestJSON(PATH,{prefix:'crew_notifications',validate});
    if(gen!==S.gen)return;
    S.data=data;
  }catch(error){if(gen!==S.gen)return;S.loadError=error;}
  render();
  if(dispatcher()&&S.data)await loadTeam();
}
async function loadTeam(){
  const gen=++S.teamGen,screen=S.gen;S.teamError=null;
  try{const data=await kit().requestJSON(PATH+'?view=team',{prefix:'crew_notifications',validate:teamValid});if(gen!==S.teamGen||screen!==S.gen)return;S.team=data;}
  catch(error){if(gen!==S.teamGen||screen!==S.gen)return;S.teamError=error;}
  render();
}
// Dispatcher changes go through a saved request so a lost response is retried unchanged.
async function teamChange(body,done){
  if(S.busy)return;
  S.busy=true;say('Saving…');render();const gen=S.gen;
  try{const data=await teamPending().submit(PATH,body,{prefix:'crew_notifications',validate:data=>data.ok===true});if(gen!==S.gen)return;S.editing='';S.contactDraft=null;say(done(data));S.busy=false;await loadTeam();return;}
  catch(error){if(gen!==S.gen)return;say(errorText(error),true);if(/_revision_conflict$|_not_retryable$|_not_found$/.test(String(error?.code||''))){teamPending().discard();S.busy=false;await loadTeam();say(errorText(error),true);}}
  finally{if(gen===S.gen)S.busy=false;}
  render();
}
async function replayTeam(){
  if(S.busy)return;S.busy=true;say('Retrying your saved change…');render();const gen=S.gen;
  try{await teamPending().replay({prefix:'crew_notifications',validate:data=>data.ok===true});if(gen!==S.gen)return;say('Your saved change was confirmed.');S.busy=false;await loadTeam();return;}
  catch(error){if(gen!==S.gen)return;say(errorText(error),true);}
  finally{if(gen===S.gen)S.busy=false;}
  render();
}

async function savePreference(sms){
  if(S.busy||!S.data)return;
  S.busy=true;say('Saving your text setting…');render();const gen=S.gen;
  try{
    const data=await pending().submit(PATH,{action:'set_preferences',sms,expectedRevision:S.data.preferences.revision},{prefix:'crew_notifications',validate:prefsValid});
    if(gen!==S.gen)return;
    S.data.preferences=data.preferences;S.smsDraft=null;say(data.preferences.sms?'Schedule texts are on.':'Schedule texts are off.');
  }catch(error){
    if(gen!==S.gen)return;
    say(errorText(error),true);
    if(/_revision_conflict$/.test(String(error?.code||''))){S.busy=false;S.smsDraft=null;pending().discard();await load();say(errorText(error),true);render();return;}
  }finally{if(gen===S.gen)S.busy=false;}
  render();
}
async function replaySaved(){
  if(S.busy)return;S.busy=true;say('Retrying your saved change…');render();const gen=S.gen;
  try{const data=await pending().replay({prefix:'crew_notifications',validate:prefsValid});if(gen!==S.gen)return;if(S.data&&data.preferences)S.data.preferences=data.preferences;S.smsDraft=null;say('Your saved change was confirmed.');}
  catch(error){if(gen!==S.gen)return;say(errorText(error),true);}
  finally{if(gen===S.gen)S.busy=false;}
  render();
}
async function acknowledge(ids){
  if(S.busy||!ids.length)return;
  S.busy=true;say(ids.length>1?'Clearing your notices…':'Clearing this notice…');render();const gen=S.gen;
  try{
    await kit().requestJSON(PATH,{method:'POST',prefix:'crew_notifications',body:{action:'acknowledge',requestId:kit().requestId(),ids},validate:data=>Array.isArray(data.acknowledged)});
    if(gen!==S.gen)return;
    S.data.notices=S.data.notices.filter(row=>!ids.includes(row.id));say(ids.length>1?'All notices cleared.':'Notice cleared.');
  }catch(error){
    if(gen!==S.gen)return;
    say(errorText(error),true);
    if(error?.code==='crew_notifications_not_found'){S.busy=false;await load();say(errorText(error),true);render();return;}
  }finally{if(gen===S.gen)S.busy=false;}
  render();
}

// A removal shows only the days taken away; the days still worked are listed apart.
const lostOf=row=>row.lostSlots?.length?row.lostSlots:row.previousSlots.length?row.previousSlots:[row.slot];
// A notice whose text also stood for older changes nobody had texted yet
// (heardSlots: what they last heard) shows everything that text said: every
// day taken away since then, and what they had before.
const wasOf=row=>Array.isArray(row.heardSlots)?row.heardSlots:row.previousSlots;
function noticeCard(row){
  const {h,button}=kit(),removal=REMOVALS.has(row.intent),partial=row.intent==='unassigned'&&row.slots.length>0,was=wasOf(row);
  const when=removal?slotsText(lostOf(row)):slotsText(row.slots.length?row.slots:[row.slot]);
  const before=row.intent==='time_changed'&&was.length?h('p',{class:'ca-was'},'Was: '+slotsText(was)):null;
  // New or moved work that also took days or hours away says so, as its text did.
  const dropped=!removal&&row.lostSlots?.length?h('p',{class:'ca-lost'},'No longer: '+slotsText(row.lostSlots)):null;
  return h('li',{class:'hub-card ca-notice ca-'+row.intent,'data-notice':row.id},
    h('div',{class:'ca-notice-head'},h('strong',{class:'ca-intent'},partial?'Removed from a day':INTENTS[row.intent]),h('span',{class:'ca-chip ca-'+(row.delivery||'not_texted')},DELIVERY[row.delivery]||DELIVERY.not_texted)),
    h('p',{class:'ca-when'},(row.intent==='time_changed'?'Now: ':partial?'No longer: ':'')+when),dropped,before,
    partial?h('p',{class:'ca-muted ca-still'},'Still scheduled: '+slotsText(row.slots)):null,
    row.serviceType?h('p',{class:'ca-muted'},row.serviceType):null,
    h('div',{class:'hub-actions'},button('Got it',()=>acknowledge([row.id]),'',{disabled:S.busy,'aria-label':'Clear notice: '+INTENTS[row.intent]+' '+when})));
}
function preferencesCard(){
  const {h,button,field}=kit(),prefs=S.data.preferences,saved=pending().get(),sms=S.smsDraft??prefs.sms;
  const toggle=field({label:'Text me when my schedule changes',name:'sms',type:'checkbox',value:sms,
    help:prefs.phoneStatus==='on_file'?`Texts go to ${prefs.phone} from your employee account.`:prefs.phoneStatus==='unavailable'?'Your phone number could not be checked right now.':'No mobile number is on file for you. Ask the office to add one before texts can reach you.'});
  const input=toggle.querySelector('input'),save=button('Save text setting',()=>savePreference(input.checked),'primary',{disabled:S.busy||sms===prefs.sms});
  input.disabled=S.busy||Boolean(saved);
  input.addEventListener('change',()=>{S.smsDraft=input.checked===prefs.sms?null:input.checked;save.disabled=S.busy||input.checked===prefs.sms;});
  return h('div',{class:'hub-card ca-prefs'},h('h2',{},'Schedule texts'),
    h('p',{class:'ca-muted'},'Texts are only about your own schedule and only after you turn them on. Quiet hours are 8 PM to 8 AM.'),toggle,
    saved?h('div',{class:'hub-notice warning',role:'alert'},'A text-setting change was not confirmed. Retry it before making another.',
      h('div',{class:'hub-actions'},button('Retry saved change',replaySaved,'primary',{disabled:S.busy}),button('Discard',()=>{pending().discard();S.smsDraft=null;say('');render();},'',{disabled:S.busy}))):
    h('div',{class:'hub-actions'},save));
}
function memberCard(row){
  const {h,button,field}=kit(),editing=S.editing===row.id;
  const chips=h('div',{class:'ca-chips'},h('span',{class:'ca-chip '+(row.sms?'ca-texted':'ca-off')},row.sms?'Texts on':'Texts off'),
    h('span',{class:'ca-chip '+(row.staffContactId?'ca-texted':'ca-off')},row.staffContactId?'Staff contact linked':'No staff contact'));
  if(!editing)return h('li',{class:'hub-card ca-member','data-member':row.id},h('div',{class:'ca-notice-head'},h('strong',{class:'ca-intent'},row.name),chips),
    row.staffContactId?h('p',{class:'ca-muted'},'HighLevel contact '+row.staffContactId):null,
    h('div',{class:'hub-actions'},button(row.staffContactId?'Change contact':'Link contact',()=>{S.editing=row.id;S.contactDraft=null;say('');render();S.root?.querySelector('[data-member="'+CSS.escape(row.id)+'"] input')?.focus();},'',{disabled:S.busy,'aria-label':(row.staffContactId?'Change HighLevel contact for ':'Link HighLevel contact for ')+row.name})));
  const input=field({label:'HighLevel contact ID',name:'contactId',value:S.contactDraft??row.staffContactId,maxlength:120,autocomplete:'off',help:'The staff contact you created in HighLevel for '+row.name+', tagged egc-staff. Leave empty to unlink.'});
  const control=input.querySelector('input');control.setAttribute('autocapitalize','none');control.spellcheck=false;control.addEventListener('input',()=>{S.contactDraft=control.value;});
  const save=()=>{const value=control.value.trim();if(value&&!CONTACT.test(value)){say('Use the contact ID from HighLevel: letters, numbers, - and _ only.',true);render();return;}
    teamChange({action:'link_staff_contact',employeeId:row.id,contactId:value,expectedRevision:row.revision},data=>data.member?.staffContactId?'Staff contact linked for '+row.name+'.':'Staff contact removed for '+row.name+'.');};
  return h('li',{class:'hub-card ca-member','data-member':row.id},h('strong',{class:'ca-intent'},row.name),input,
    h('div',{class:'hub-actions'},button('Save contact',save,'primary',{disabled:S.busy}),button('Cancel',()=>{S.editing='';S.contactDraft=null;render();},'',{disabled:S.busy})));
}
function attentionCard(row){
  const {h,button}=kit(),removal=REMOVALS.has(row.intent);
  // What Send again would text: the days taken away since their last text too.
  const dropped=!removal&&row.lostSlots?.length?h('p',{class:'ca-lost'},'No longer: '+slotsText(row.lostSlots)):null;
  const why=row.covered?(row.coveredVia==='hub'?'They read a later notice for this job in the Hub, so Send again only clears it.':'A later text already told them about this change, so Send again only clears it.'):row.status==='uncertain'?'HighLevel did not confirm this text, so it is never sent again. Check the conversation in HighLevel.':REASONS[row.reason]||'The text was not sent.';
  return h('li',{class:'hub-card ca-notice ca-attention','data-attention':row.id},
    h('div',{class:'ca-notice-head'},h('strong',{class:'ca-intent'},row.employeeName+' · '+INTENTS[row.intent]),h('span',{class:'ca-chip ca-off'},TEAM_STATUS[row.status]||'Not texted')),
    h('p',{class:'ca-when'},slotsText(removal?lostOf(row):[row.slot])),dropped,h('p',{class:'ca-muted'},why),
    row.canRetry?h('div',{class:'hub-actions'},button('Send again',()=>teamChange({action:'retry',ids:[row.id]},data=>Array.isArray(data.superseded)&&data.superseded.length?(Array.isArray(data.regrouped)&&data.regrouped.length?'A newer change for this job already replaced it, so it was closed. The other visits it stood for were queued to be texted.':'A newer change for this job already replaced it, so it was closed instead of sent again.'):'Queued again. The next messaging run re-checks it against the schedule.'),'',{disabled:S.busy,'aria-label':'Send again: '+row.employeeName+' '+INTENTS[row.intent]})):null);
}
function teamSection(){
  if(!dispatcher())return null;
  const {h,button}=kit(),saved=teamPending().get();
  const head=h('div',{class:'ca-list-head'},h('h2',{},'Crew texts'),button('Refresh crew',()=>loadTeam(),'',{disabled:S.busy}));
  const intro=h('p',{class:'ca-muted'},'Texts go only to crew who turned them on, to the number on their employee account, through the HighLevel staff contact linked here. Create each staff contact in HighLevel, tag it egc-staff, then link it.');
  const retry=saved?h('div',{class:'hub-notice warning',role:'alert'},'A crew text change was not confirmed. Retry it before making another.',
    h('div',{class:'hub-actions'},button('Retry saved change',replayTeam,'primary',{disabled:S.busy}),button('Discard',()=>{teamPending().discard();say('');render();},'',{disabled:S.busy}))):null;
  let body;
  if(S.teamError){
    const denied=Number(S.teamError.status)===403;
    body=h('div',{class:'hub-notice '+(denied?'warning':'error'),role:'alert'},denied?'Crew text setup needs a dispatcher account.':'Crew text setup could not be loaded, so nothing here is shown as current. '+errorText(S.teamError),
      denied?null:h('div',{class:'hub-actions'},button('Retry',()=>loadTeam(),'primary')));
  }else if(!S.team){
    body=h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading crew texts…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}));
  }else{
    const rows=S.team.attention;
    body=h('div',{class:'ca-team'},
      S.team.coverage.complete?null:h('p',{class:'hub-notice warning'},'Only part of the crew list or the unsent texts is shown. Refresh to check again.'),
      h('h3',{},rows.length?`Not texted (${rows.length})`:'Not texted'),
      rows.length?h('ul',{class:'ca-list'},rows.map(attentionCard)):h('p',{class:'ca-empty'},'Every notice for upcoming work was texted or is still queued.'),
      h('h3',{},'Crew'),h('ul',{class:'ca-list'},S.team.team.map(memberCard)));
  }
  return h('section',{class:'hub-card ca-team-panel','aria-label':'Crew texts'},head,intro,retry,body);
}
function render(){
  if(!S.root)return;
  // The field being typed in (a contact ID) is drawn again from S; it keeps focus and its caret.
  const active=document.activeElement,typing=S.root.contains(active)&&active.name?{name:active.name,member:active.closest('[data-member]')?.dataset.member||'',range:typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null}:null;
  const {h,button}=kit();
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'MY EGC'),h('h1',{},'Schedule alerts'),h('p',{},'Changes dispatch made to your jobs, newest first.')),
    h('div',{class:'hub-actions'},button('Refresh',()=>load(),'',{disabled:S.busy})));
  const status=h('p',{class:'ca-status',role:'status','aria-live':'polite'},S.message);
  const alert=S.error?h('p',{class:'hub-notice error',role:'alert'},S.error):null;
  let body;
  if(S.loadError){
    const code=String(S.loadError.code||''),off=code==='crew_notifications_not_enabled';
    body=h('div',{class:'hub-notice '+(off?'warning':'error'),role:'alert'},h('strong',{},off?'Schedule alerts are off':'Schedule alerts are unavailable'),
      h('p',{},off?errorText(S.loadError):'Your notices could not be loaded, so nothing here is shown as current. '+errorText(S.loadError)),off?null:h('div',{class:'hub-actions'},button('Retry',()=>load(),'primary')));
  }else if(!S.data){
    body=h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading schedule alerts…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'}));
  }else{
    const rows=S.data.notices,ids=rows.slice(0,50).map(row=>row.id);
    body=h('div',{class:'ca-body'},preferencesCard(),
      h('div',{class:'ca-list-head'},h('h2',{},rows.length?`New changes (${rows.length})`:'New changes'),rows.length>1?button('Mark all read',()=>acknowledge(ids),'',{disabled:S.busy}):null),
      S.data.coverage.complete?null:h('p',{class:'hub-notice warning'},'Only your newest notices are shown. Clear them to see older ones.'),
      rows.length?h('ul',{class:'ca-list'},rows.map(noticeCard)):h('p',{class:'ca-empty'},'No new schedule changes. Your jobs are in My Day.'),teamSection());
  }
  S.root.replaceChildren(...[head,alert,status,body].filter(Boolean));
  S.root.setAttribute('aria-busy',S.busy?'true':'false');
  const scope=typing?.member?S.root.querySelector('[data-member="'+CSS.escape(typing.member)+'"]'):S.root,again=typing&&scope?.querySelector('[name="'+CSS.escape(typing.name)+'"]');
  if(again&&!again.disabled){again.focus({preventScroll:true});if(typing.range)try{again.setSelectionRange(...typing.range);}catch{}}
}

function mount(host,ctx={}){
  unmount();
  S.ctx=ctx;S.data=null;S.busy=false;S.message='';S.error='';S.loadError=null;S.team=null;S.teamError=null;S.editing='';S.smsDraft=null;S.contactDraft=null;
  S.root=kit().h('section',{class:'hub-screen egc-crew-alerts','aria-label':'Schedule alerts'});
  host.append(S.root);
  return load();
}
function unmount(){S.gen++;S.teamGen++;S.root?.remove();S.root=null;S.data=null;S.team=null;S.busy=false;S.editing='';S.smsDraft=null;S.contactDraft=null;}
window.EGCCrewNotifications=Object.freeze({mount,unmount,canLeave:()=>!S.busy,refresh:()=>S.root&&!dirty()?load():Promise.resolve()});
})();
