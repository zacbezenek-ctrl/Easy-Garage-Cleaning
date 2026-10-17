/* Team directory (D10, EGC_STAFF_DIRECTORY_ENABLED): every signed-in staff member's card (name, approved photo, roles,
   crews, shirt size, and the birthday's month and day when it is shared), the birthdays coming up, and the viewer's own
   shirt size and birthday editor. Managers also see birth dates, ages, phones and emergency contacts, edit anyone's
   details (with the HighLevel user ID) and get the shirt-size totals for a uniform order. It reads
   GET /api/staff-directory?view=team and saves set_personal; the server decides every permission and the controls shown
   follow what it returned. Registered Hub screen (the suite lists it only when the directory is on). */
(function(){
'use strict';
if(window.EGCTeamDirectory)return;
const PATH='/api/staff-directory',SCREEN='team_directory',SIZES=['XS','S','M','L','XL','2XL','3XL','4XL'],SOON_DAYS=30,SOON_MAX=8;
const ROLE_LABEL={owner:'Owner',manager:'Manager',team_lead:'Team lead',crew_lead:'Crew lead',crew:'Crew',sales:'Sales',phone:'Phone'};
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ERRORS={staff_directory_not_enabled:'The team directory is not turned on for this Hub yet.',
  staff_directory_revision_conflict:'This card changed while you were editing. The latest details are shown; check them and save again.',
  staff_directory_forbidden:'Your account cannot change these details.',
  staff_directory_account_changed:'This change was made while signed in as another account. Sign in as that account to retry it, or discard it.'};
const DATE=/^\d{4}-\d{2}-\d{2}$/,PHOTO=/^\/api\/crew-public-profile\?photo=[a-z0-9._-]+&v=[0-9a-f-]{36}$/;
const S={root:null,ctx:null,screen:0,loadSeq:0,data:null,loadError:null,loading:false,query:'',search:null,grid:null,edit:'',draft:null,dirty:false,busy:false,message:'',error:''};
const kit=()=>window.EGCHubKit;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const key=value=>String(value??'').trim().toLowerCase();

const birthdayValid=b=>record(b)&&Number.isInteger(b.month)&&b.month>=1&&b.month<=12&&Number.isInteger(b.day)&&b.day>=1&&b.day<=31;
const crewValid=c=>record(c)&&typeof c.id==='string'&&typeof c.name==='string'&&typeof c.lead==='boolean';
const contactValid=c=>record(c)&&typeof c.name==='string'&&typeof c.phone==='string';
function cardValid(p){
  return record(p)&&typeof p.username==='string'&&p.username.trim()!==''&&typeof p.displayName==='string'&&Array.isArray(p.staffRoles)&&p.staffRoles.every(role=>typeof role==='string')&&
    Array.isArray(p.crews)&&p.crews.every(crewValid)&&(p.photoUrl===null||typeof p.photoUrl==='string')&&(p.shirtSize===null||SIZES.includes(p.shirtSize))&&
    (p.birthday===null||birthdayValid(p.birthday))&&typeof p.self==='boolean'&&(p.revision===undefined||typeof p.revision==='string')&&
    (p.birthDate===undefined||p.birthDate===null||DATE.test(p.birthDate))&&(p.age===undefined||p.age===null||Number.isInteger(p.age))&&
    (p.birthdayVisibleToTeam===undefined||typeof p.birthdayVisibleToTeam==='boolean')&&(p.phone===undefined||typeof p.phone==='string')&&
    (p.emergencyContact===undefined||contactValid(p.emergencyContact))&&(p.highlevelUserId===undefined||p.highlevelUserId===null||typeof p.highlevelUserId==='string');
}
function validate(data){
  return DATE.test(String(data.today||''))&&record(data.viewer)&&typeof data.viewer.manager==='boolean'&&Array.isArray(data.people)&&data.people.every(cardValid)&&
    (data.shirtSizes===undefined||record(data.shirtSizes))&&record(data.coverage)&&data.coverage.complete===true;
}
const savedValid=data=>record(data.person)&&typeof data.person.revision==='string';
const viewerId=()=>key(S.ctx?.identity)||undefined;
const pending=()=>kit().pending(SCREEN,viewerId());
// Requests go through the Hub's fetch (ctx.hubFetch: the signed-in session and its sign-out handling).
const options=extra=>({prefix:'staff_directory',...(typeof S.ctx?.hubFetch==='function'?{fetcher:S.ctx.hubFetch}:{}),...extra});
const manager=()=>S.data?.viewer?.manager===true;
const person=username=>S.data?.people.find(p=>key(p.username)===key(username))||null;
const canEdit=p=>Boolean(p&&typeof p.revision==='string'&&!p.profileNeedsReview&&(p.self||manager()));
function say(text,error=false){S.message=error?'':text;S.error=error?text:'';}
const errorText=error=>kit().errorText(error,ERRORS);

// Dates are Denver calendar dates from the server ('today'); the device clock and zone are never used.
const monthDay=b=>birthdayValid(b)?`${MONTHS[b.month-1]} ${b.day}`:'';
const longDate=date=>DATE.test(String(date||''))?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'';
const leap=year=>year%4===0&&(year%100!==0||year%400===0);
// Days from today to the next birthday (0 is today). Feb 29 falls on Mar 1 in other years, as the server counts age.
function daysUntil(b,today){
  const [year,month,day]=today.split('-').map(Number),base=Date.UTC(year,month-1,day);
  const on=y=>b.month===2&&b.day===29&&!leap(y)?Date.UTC(y,2,1):Date.UTC(y,b.month-1,b.day);
  const next=on(year)>=base?on(year):on(year+1);
  return Math.round((next-base)/86400000);
}
const roleText=roles=>roles.map(role=>ROLE_LABEL[role]||role).join(', ')||'Team member';
const initials=name=>String(name||'?').trim().split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase()||'?';
function matches(p,query){
  if(!query)return true;
  const text=[p.displayName,p.username,roleText(p.staffRoles),...p.crews.map(c=>c.name),p.shirtSize||''].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word=>text.includes(word));
}

// S.screen changes when the screen unmounts (an answer for an earlier mount is dropped); S.loadSeq keeps only the newest read.
async function load(){
  const seq=++S.loadSeq,screen=S.screen;S.loadError=null;S.loading=true;
  if(!S.data)render();
  try{
    const data=await kit().requestJSON(PATH+'?view=team',options({validate}));
    if(seq!==S.loadSeq||screen!==S.screen)return;
    S.data=data;
    if(S.edit&&!canEdit(person(S.edit))){S.edit='';S.draft=null;S.dirty=false;}
  }catch(error){if(seq!==S.loadSeq||screen!==S.screen)return;S.loadError=error;}
  finally{if(seq===S.loadSeq&&screen===S.screen)S.loading=false;}
  render();
}

function openEditor(username){
  const p=person(username);
  if(!canEdit(p)||S.busy)return;
  S.edit=p.username;S.dirty=false;
  S.draft={shirtSize:p.shirtSize||'',birthDate:p.birthDate||'',visible:p.birthdayVisibleToTeam!==false,highlevelUserId:p.highlevelUserId||''};
  say('');render();
  S.root?.querySelector('.td-editor select')?.focus?.();
}
function closeEditor(){S.edit='';S.draft=null;S.dirty=false;say('');render();}
function readForm(form){
  const value=name=>form.querySelector(`[name="${name}"]`);
  return {shirtSize:String(value('shirtSize')?.value||''),birthDate:String(value('birthDate')?.value||''),visible:Boolean(value('birthdayVisibleToTeam')?.checked),
    highlevelUserId:String(value('highlevelUserId')?.value||'').trim()};
}
async function save(form){
  if(S.busy||!S.edit)return;
  const p=person(S.edit);
  if(!canEdit(p))return;
  const draft=S.draft=readForm(form);
  const body={action:'set_personal',username:p.username,expectedRevision:p.revision,...(S.ctx?.identity?{expectedUser:String(S.ctx.identity)}:{}),
    shirtSize:draft.shirtSize||null,birthDate:draft.birthDate||null,birthdayVisibleToTeam:draft.visible,
    // Only a manager sets the HighLevel user ID; the server sends it to managers only.
    ...(manager()&&p.highlevelUserId!==undefined?{highlevelUserId:draft.highlevelUserId||null}:{})};
  S.busy=true;say('Saving…');render();const screen=S.screen;
  try{
    const data=await pending().submit(PATH,body,options({validate:savedValid}));
    if(screen!==S.screen)return;
    S.edit='';S.draft=null;S.dirty=false;S.busy=false;say(data.unchanged?'Nothing changed.':p.self?'Your details are saved.':`${p.displayName}'s details are saved.`);
    await load();return;
  }catch(error){
    if(screen!==S.screen)return;
    S.busy=false;say(errorText(error),true);
    // The draft stays open on the latest record, so the change can be checked and saved again.
    if(/_revision_conflict$/.test(String(error?.code||''))){pending().discard();const message=S.error;await load();if(screen!==S.screen)return;say(message,true);}
  }finally{if(screen===S.screen)S.busy=false;}
  render();
}
async function replaySaved(){
  if(S.busy)return;S.busy=true;say('Retrying your saved change…');render();const screen=S.screen;
  try{await pending().replay(options({validate:savedValid}));if(screen!==S.screen)return;S.edit='';S.draft=null;S.dirty=false;S.busy=false;say('Your saved change was confirmed.');await load();return;}
  catch(error){if(screen!==S.screen)return;say(errorText(error),true);}
  finally{if(screen===S.screen)S.busy=false;}
  render();
}
function discardSaved(){pending().discard();say('The unsent change was discarded.');render();}

function avatar(p){
  const {h}=kit();
  return p.photoUrl&&PHOTO.test(p.photoUrl)?h('img',{class:'td-avatar',src:p.photoUrl,alt:'',loading:'lazy',width:56,height:56}):h('span',{class:'td-avatar td-initials','aria-hidden':'true'},initials(p.displayName));
}
function detail(label,value){const {h}=kit();return value?h('div',{class:'td-detail'},h('dt',{},label),h('dd',{},value)):null;}
function card(p){
  const {h,button}=kit(),own=p.self,birthday=p.birthday?monthDay(p.birthday):'';
  const born=p.birthDate?`${longDate(p.birthDate)}${Number.isInteger(p.age)?` · age ${p.age}`:''}${p.birthdayVisibleToTeam===false?' · hidden from the team':''}`:'';
  const contact=p.emergencyContact&&(p.emergencyContact.name||p.emergencyContact.phone)?[p.emergencyContact.name,p.emergencyContact.phone].filter(Boolean).join(' · '):'';
  return h('article',{class:'hub-card td-card'+(own?' td-self':''),'data-username':p.username},
    h('header',{class:'td-card-head'},avatar(p),h('div',{},h('h3',{},p.displayName),h('p',{class:'td-roles'},roleText(p.staffRoles)))),
    p.crews.length?h('ul',{class:'td-crews','aria-label':'Crews'},p.crews.map(c=>h('li',{class:'td-chip'+(c.lead?' td-lead':'')},c.name+(c.lead?' · lead':'')))):null,
    h('dl',{class:'td-details'},
      detail('Shirt',p.shirtSize||'Not set'),
      detail('Birthday',birthday||(p.birthDate===undefined?'Not shared':'')),
      detail(own&&!manager()?'Your birthday':'Born',born),
      p.phone!==undefined?detail('Phone',p.phone?h('a',{href:'tel:'+p.phone.replace(/[^0-9+]/g,'')},p.phone):'Not on file'):null,
      p.emergencyContact!==undefined?detail('Emergency',contact||'Not on file'):null,
      p.highlevelUserId!==undefined?detail('HighLevel user',p.highlevelUserId||'Not linked'):null),
    canEdit(p)?h('div',{class:'hub-actions'},button(own?'Edit my details':'Edit details',()=>openEditor(p.username),'',{disabled:S.busy||Boolean(pending().get()),'aria-label':(own?'Edit my details':'Edit details for '+p.displayName)})):null);
}
function editor(){
  const {h,button,field}=kit(),p=person(S.edit);
  if(!p)return null;
  const d=S.draft||{},saved=pending().get(),locked=S.busy||Boolean(saved);
  const form=h('form',{class:'hub-card td-editor','aria-label':'Edit details for '+p.displayName},
    h('span',{class:'hub-eyebrow'},p.self?'YOUR DETAILS':'TEAM MEMBER DETAILS'),h('h2',{},p.self?'Your shirt size and birthday':p.displayName),
    h('div',{class:'hub-grid'},
      field({label:'Shirt size',name:'shirtSize',type:'select',value:d.shirtSize||'',options:[{value:'',label:'Not set'},...SIZES.map(size=>({value:size,label:size}))]}),
      field({label:'Birthday',name:'birthDate',type:'date',value:d.birthDate||'',max:S.data.today,help:p.self?'Your birth year and age are shown only to you, the owner and managers.':'The birth year and age are shown only to the owner and managers.'}),
      p.highlevelUserId!==undefined&&manager()?field({label:'HighLevel user ID',name:'highlevelUserId',value:d.highlevelUserId||'',maxlength:64,autocomplete:'off',help:'Used later to assign HighLevel appointments to this person.'}):null),
    field({label:p.self?'Show my birthday (month and day) to the team':'Show the birthday (month and day) to the team',name:'birthdayVisibleToTeam',type:'checkbox',value:d.visible!==false}),
    h('div',{class:'hub-actions'},h('button',{type:'submit',class:'hub-btn primary',disabled:locked},S.busy?'Saving…':'Save details'),button('Cancel',closeEditor,'quiet',{disabled:S.busy})));
  // The select shows the draft's size whatever option markup the kit produced.
  const size=form.querySelector('select[name="shirtSize"]');
  if(size)size.value=d.shirtSize||'';
  for(const control of form.querySelectorAll('input,select'))control.disabled=locked;
  form.addEventListener('input',()=>{S.draft=readForm(form);S.dirty=true;});
  form.addEventListener('change',()=>{S.draft=readForm(form);S.dirty=true;});
  form.addEventListener('submit',event=>{event.preventDefault();void save(form);});
  return form;
}
function birthdays(){
  const {h}=kit(),today=S.data.today;
  const soon=S.data.people.filter(p=>p.birthday).map(p=>({p,days:daysUntil(p.birthday,today)})).filter(row=>row.days<=SOON_DAYS).sort((a,b)=>a.days-b.days||a.p.displayName.localeCompare(b.p.displayName)).slice(0,SOON_MAX);
  if(!soon.length)return null;
  return h('section',{class:'td-birthdays','aria-label':'Upcoming birthdays'},h('span',{class:'hub-eyebrow'},'UPCOMING BIRTHDAYS'),
    h('ul',{},soon.map(({p,days})=>h('li',{class:'td-birthday'+(days===0?' td-today':'')},h('strong',{},p.displayName),h('span',{},days===0?'Today':days===1?'Tomorrow':monthDay(p.birthday))))));
}
function sizesPanel(){
  const {h,button}=kit(),totals=S.data.shirtSizes;
  if(!manager()||!record(totals))return null;
  const ordered=SIZES.filter(size=>Number(totals[size])>0),unknown=Number(totals.unknown)||0;
  const csv=()=>kit().downloadCsv('egc-shirt-sizes-'+S.data.today,[['Name','Shirt size','Crews'],...S.data.people.map(p=>[p.displayName,p.shirtSize||'',p.crews.map(c=>c.name).join('; ')])]);
  return h('section',{class:'hub-card td-sizes'},h('span',{class:'hub-eyebrow'},'UNIFORM ORDER'),h('h2',{},'Shirt sizes'),
    h('ul',{class:'td-size-list'},SIZES.map(size=>h('li',{class:Number(totals[size])>0?'':'td-zero'},h('strong',{},String(Number(totals[size])||0)),h('span',{},size)))),
    h('p',{class:'td-muted'},unknown?`${unknown} ${unknown===1?'person has':'people have'} no shirt size saved yet.`:ordered.length?'Everyone has a shirt size saved.':'No shirt sizes are saved yet.'),
    h('div',{class:'hub-actions'},button('Download sizes (CSV)',csv)));
}
function renderGrid(){
  if(!S.grid||!S.data)return;
  const {h}=kit(),shown=S.data.people.filter(p=>matches(p,S.query));
  S.grid.replaceChildren(...(shown.length?shown.map(card):[h('p',{class:'td-muted'},S.query?'No one matches that search.':'No one is on the team roster yet.')]));
  S.root?.querySelector('.td-count')?.replaceChildren(document.createTextNode(`${shown.length} of ${S.data.people.length}`));
}
function render(){
  if(!S.root)return;
  const {h,button}=kit(),nodes=[];
  nodes.push(h('div',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'MY EGC · TEAM'),h('h1',{},'Team directory'),
    h('p',{},'Everyone on the EGC team, their crews, shirt sizes and birthdays. Only EGC staff signed in to the Hub can see this page.')),
    h('div',{class:'hub-actions'},button(S.loading?'Refreshing…':'Refresh',()=>{if(!S.dirty)void load();},'',{disabled:S.loading||S.busy}))));
  if(S.message||S.error)nodes.push(h('div',{class:'hub-notice'+(S.error?' error':' success'),role:S.error?'alert':'status'},S.error||S.message));
  const saved=S.data?pending().get():null;
  if(saved)nodes.push(h('div',{class:'hub-notice warning',role:'status'},'A change you saved has not been confirmed yet.',h('div',{class:'hub-actions'},button('Retry saved change',replaySaved,'primary',{disabled:S.busy}),button('Discard it',discardSaved,'quiet',{disabled:S.busy}))));
  if(S.loadError&&!S.data){
    nodes.push(h('div',{class:'hub-notice error',role:'alert'},errorText(S.loadError),h('div',{class:'hub-actions'},button('Retry',()=>void load(),'primary'))));
  }else if(!S.data){
    nodes.push(h('p',{class:'td-muted',role:'status'},'Loading the team…'));
  }else{
    if(S.loadError)nodes.push(h('div',{class:'hub-notice warning',role:'status'},'The latest team details could not be loaded; the list below is from earlier. '+errorText(S.loadError)));
    if(!S.data.coverage.crews)nodes.push(h('div',{class:'hub-notice warning',role:'status'},'Crew names could not be loaded right now, so no crews are shown.'));
    if(!S.data.coverage.photos)nodes.push(h('div',{class:'hub-notice warning',role:'status'},'Photos could not be loaded right now.'));
    const own=S.data.people.find(p=>p.self);
    if(S.edit)nodes.push(editor());
    else if(own&&canEdit(own)&&!own.shirtSize&&!own.birthDate)nodes.push(h('div',{class:'hub-notice',role:'status'},'Add your shirt size and birthday so the team can order uniforms and celebrate with you.',h('div',{class:'hub-actions'},button('Add my details',()=>openEditor(own.username),'primary',{disabled:S.busy||Boolean(saved)}))));
    nodes.push(birthdays(),sizesPanel());
    if(!S.search){S.search=h('input',{type:'search',class:'td-search-input',name:'teamSearch',placeholder:'Search by name, role, crew or size',autocomplete:'off','aria-label':'Search the team'});S.search.addEventListener('input',()=>{S.query=S.search.value.trim();renderGrid();});}
    nodes.push(h('div',{class:'td-search'},S.search,h('span',{class:'td-count td-muted','aria-live':'polite'})));
    S.grid=h('div',{class:'td-grid'});
    nodes.push(S.grid);
  }
  S.root.replaceChildren(...nodes.filter(Boolean));
  renderGrid();
}

window.EGCTeamDirectory={
  async mount(host,ctx){
    if(!kit())throw new Error('kit_unavailable');
    S.screen++;S.ctx=ctx||{};S.root=kit().h('div',{class:'hub-screen td-root'});S.search=null;S.grid=null;S.query='';S.data=null;S.loadError=null;S.edit='';S.draft=null;S.dirty=false;S.busy=false;say('');
    host.replaceChildren(S.root);
    await load();
  },
  unmount(){S.screen++;S.root=null;S.ctx=null;S.search=null;S.grid=null;S.data=null;S.edit='';S.draft=null;S.dirty=false;S.busy=false;S.loading=false;},
  // An open editor with changes, or a save on its way, keeps the viewer here.
  canLeave(){return!S.busy&&!S.dirty;},
  async refresh(){if(S.root&&!S.dirty&&!S.busy)await load();},
};
})();
