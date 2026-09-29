// MOBILE-HUB: the signed-in Employee Hub shell on every device project (320 to 1440, touch iPads and a landscape phone)
// with long-name fixtures, the clock at NOW and the Denver time zone (helpers/test.mjs and the config).
import {test,expect,open,touch} from './helpers/test.mjs';
import {PRIMARY_CONTROLS,assertNoHorizontalScroll,assertTapTargets} from './helpers/mobile-invariants.mjs';
import {CREW,MANAGER,hubFixtures,hubReady} from './helpers/hub-fixture.mjs';

const VIEWS=[{name:'Command center',view:'today',profile:MANAGER},{name:'My day',view:'my_day',profile:CREW},{name:'Time approvals',view:'timesheets',profile:MANAGER},{name:'Team',view:'people',profile:MANAGER},{name:'Settings',view:'settings',profile:MANAGER}];
const SAMPLE=['.ops-button.primary','#ops-quick-clock','.ops-page-head .ops-eyebrow','.ops-page-head p','#ops-kicker','.ops-nav-label','.fg label','.btn-main','.login-logo .pill'];

async function hub(page,view,profile){
 await hubFixtures(page,{profile});
 await open(page,`/employee.html?view=${view}`);
 await hubReady(page);
}

// Every visible field's computed font size (iOS zooms into anything under 16px when it takes focus).
const smallFields=page=>page.evaluate(()=>[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')]
 .filter(el=>el.checkVisibility()&&el.getBoundingClientRect().width>0&&parseFloat(getComputedStyle(el).fontSize)<16).map(el=>`${el.tagName.toLowerCase()}#${el.id||el.name} ${getComputedStyle(el).fontSize}`));
// aria-hidden content a sighted user sees that holds a heading or a control (the legacy lead drawer did).
const hiddenContent=page=>page.evaluate(()=>[...document.querySelectorAll('[aria-hidden="true"]')].filter(el=>el.checkVisibility()&&el.querySelector('h1,h2,h3,h4,button,a[href],input,select,textarea')).map(el=>el.id||el.className));
// WCAG contrast of the first visible element per selector with its own text, against its composited background.
const contrast=(page,selectors)=>page.evaluate(selectors=>{
 const cs=el=>getComputedStyle(el),parse=c=>{const m=/rgba?\(([^)]+)\)/.exec(c);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
 const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)},blend=(t,b)=>({r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1});
 const bg=el=>{const layers=[];for(let p=el;p;p=p.parentElement){const c=parse(cs(p).backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}let col={r:255,g:255,b:255,a:1};for(let i=layers.length-1;i>=0;i--)col=blend(layers[i],col);return col};
 const out={};for(const selector of selectors){const el=[...document.querySelectorAll(selector)].find(e=>e.checkVisibility({checkVisibilityCSS:true})&&[...e.childNodes].some(n=>n.nodeType===3&&n.nodeValue.trim()));
  if(!el)continue;const b=bg(el),f=blend(parse(cs(el).color),b),L1=lum(f),L2=lum(b);out[selector]=Math.round((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)*100)/100}return out},selectors);
// A dialog's box against the viewport and whether its primary action can be scrolled into view and takes the tap.
const dialogBox=(page,selector,submit)=>page.evaluate(([selector,submit])=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),button=[...el.querySelectorAll(submit)].filter(b=>b.getBoundingClientRect().width>0).at(-1);
 button.scrollIntoView({block:'nearest'});const b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
 return{left:r.left,right:innerWidth-r.right,top:r.top,bottom:innerHeight-r.bottom,height:r.height,vw:innerWidth,vh:innerHeight,reachable:b.top>=0&&b.bottom<=innerHeight+0.5&&(hit===button||button.contains(hit))}},[selector,submit]);
// An iPhone running the installed Hub: a 47px status bar and a 34px home indicator in portrait.
const PHONE_INSETS=':root{--egc-safe-top:47px;--egc-safe-bottom:34px}';
// A dialog's box, whether its close takes the tap where it sits, then where its save lands once scrolled into view.
const insetBox=(page,selector,close,submit)=>page.evaluate(([selector,close,submit])=>{const el=document.querySelector(selector),x=el.querySelector(close),r=el.getBoundingClientRect(),c=x.getBoundingClientRect();
 const takes=(e,b)=>{const h=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return h===e||e.contains(h)},closeHit=takes(x,c);
 const button=[...el.querySelectorAll(submit)].filter(b=>b.getBoundingClientRect().width>0).at(-1);button.scrollIntoView({block:'nearest'});const s=button.getBoundingClientRect();
 return{top:r.top,bottom:innerHeight-r.bottom,closeTop:c.top,closeHit,saveBottom:innerHeight-s.bottom,saveHit:takes(button,s)}},[selector,close,submit]);

for(const {name,view,profile} of VIEWS){
 test(`${name}: fits, keeps 44px targets and 16px fields, no public-stylesheet padding, AA contrast, honours the top inset`,async({page},info)=>{
  await hub(page,view,profile);
  await assertNoHorizontalScroll(page);
  if(touch(info))await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} hub-shell:${name}`});
  expect(await smallFields(page),'fields under 16px').toEqual([]);
  expect(await hiddenContent(page),'visible aria-hidden content').toEqual([]);
  expect(await page.locator('.ops-workspace').evaluate(el=>getComputedStyle(el).paddingTop),'the public section padding is gone').toBe('0px');
  expect(await page.locator('link[href*="styles.css"]').count()).toBe(0);
  const low=Object.entries(await contrast(page,SAMPLE)).filter(([,ratio])=>ratio<4.5);
  expect(low,'sampled button and eyebrow text under 4.5:1').toEqual([]);
  // Refresh is named "Refresh" at every width, including the 320-400px icon form (its glyph adds nothing to the name).
  await expect(page.locator('.ops-system').getByRole('button',{name:'Refresh',exact:true})).toHaveCount(1);
  await page.addStyleTag({content:':root{--egc-safe-top:47px}'});
  expect(await page.locator('.ops-topbar').evaluate(el=>getComputedStyle(el).paddingTop)).toBe('47px');
 });
}

test('login screen: fits, keeps 44px targets and 16px fields, AA labels and no stray lead drawer',async({page},info)=>{
 await hubFixtures(page,{profile:null});
 await open(page,'/employee.html');
 await page.locator('#l-user').waitFor();
 await assertNoHorizontalScroll(page);
 if(touch(info))await assertTapTargets(page,PRIMARY_CONTROLS,{key:`${info.project.name} hub-shell:login`});
 expect(await smallFields(page)).toEqual([]);
 expect(await hiddenContent(page)).toEqual([]);
 await expect(page.getByRole('heading',{name:'Lead',exact:true})).toHaveCount(0);
 const low=Object.entries(await contrast(page,['.fg label','.btn-main','.login-logo .pill','.login-logo p'])).filter(([,ratio])=>ratio<4.5);
 expect(low).toEqual([]);
});

test('Create job, Record payment and a Hub action dialog sit inside the viewport, centred, with the save reachable',async({page})=>{
 const check=async(label,selector,submit,native)=>{
  const box=await dialogBox(page,selector,submit);
  expect(Math.min(box.left,box.right,box.top,box.bottom),`${label} inside the viewport`).toBeGreaterThanOrEqual(-0.5);
  expect(Math.abs(box.left-box.right),`${label} centred`).toBeLessThanOrEqual(2);
  if(native&&box.vw<=680)expect(box.bottom,`${label} is a bottom sheet on a phone`).toBeLessThanOrEqual(2);
  else if(box.height<box.vh-4)expect(Math.abs(box.top-box.bottom),`${label} centred vertically`).toBeLessThanOrEqual(2);
  expect(box.reachable,`${label} save reachable`).toBe(true);
 };
 await hub(page,'schedule',MANAGER);
 await page.getByRole('button',{name:'Create job',exact:true}).first().click();
 await page.locator('dialog.dp-dialog[open]').waitFor();
 await check('Create job','dialog.dp-dialog[open]','.dp-dialog-foot button',true);
 await page.keyboard.press('Escape');
 await page.evaluate(()=>opsGo('finance'));
 await hubReady(page);
 await page.getByRole('button',{name:'Record payment',exact:true}).first().click();
 await expect(page.locator('dialog.egc-money .em-summary')).toBeVisible();
 await check('Record payment','dialog.egc-money[open]','.em-foot .primary',true);
 await page.keyboard.press('Escape');
 await expect(page.locator('dialog.egc-money[open]')).toHaveCount(0);
 await page.evaluate(()=>opsGo('people'));
 await hubReady(page);
 await page.evaluate(()=>{opsNewAnnouncement();});
 await page.locator('.ops-modal .ops-action-dialog').waitFor();
 await check('Post announcement','.ops-modal .ops-action-dialog','footer button.primary',false);
});

test('On a phone with a status bar and a home indicator, every dialog keeps its close below one and its save above the other',async({page})=>{
 test.skip(page.viewportSize().width>680,'phone bottom sheets only');
 const check=async(label,selector,close,submit,sheet=true)=>{
  const box=await insetBox(page,selector,close,submit);
  if(sheet){
   expect(box.top,`${label} starts below the status bar`).toBeGreaterThanOrEqual(46.5);
   expect(box.bottom,`${label} ends above the home indicator`).toBeGreaterThanOrEqual(33.5);
  }
  expect(box.closeTop,`${label} close below the status bar`).toBeGreaterThanOrEqual(46.5);
  expect(box.closeHit,`${label} close takes the tap`).toBe(true);
  expect(box.saveBottom,`${label} save above the home indicator`).toBeGreaterThanOrEqual(33.5);
  expect(box.saveHit,`${label} save takes the tap`).toBe(true);
  return box;
 };
 await hub(page,'schedule',MANAGER);
 await page.addStyleTag({content:PHONE_INSETS});
 await page.getByRole('button',{name:'Create job',exact:true}).first().click();
 await page.locator('dialog.dp-dialog[open]').waitFor();
 await check('Create job','dialog.dp-dialog[open]','.dp-dialog-head [aria-label="Close dialog"]','.dp-dialog-foot button');
 await page.keyboard.press('Escape');
 await expect(page.locator('dialog.dp-dialog[open]')).toHaveCount(0);
 // The recurring plan stays a full-screen sheet; its own header and footer take the insets.
 await page.locator('.dp-repeat').first().click();
 await page.locator('dialog.rp-dialog[open] .rp-form-foot button[type=submit]').waitFor();
 const plan=await check('Recurring plan','dialog.rp-dialog[open]','.rp-close','.rp-form-foot button[type=submit]',false);
 expect(Math.max(Math.abs(plan.top),Math.abs(plan.bottom)),'the recurring plan fills the screen').toBeLessThanOrEqual(0.5);
 await page.locator('dialog.rp-dialog[open] .rp-close').click();
 await expect(page.locator('dialog.rp-dialog[open]')).toHaveCount(0);
 await page.evaluate(()=>opsGo('finance'));
 await hubReady(page);
 await page.getByRole('button',{name:'Record payment',exact:true}).first().click();
 await expect(page.locator('dialog.egc-money .em-summary')).toBeVisible();
 await check('Record payment','dialog.egc-money[open]','.em-close','.em-foot .primary');
 await page.keyboard.press('Escape');
 await expect(page.locator('dialog.egc-money[open]')).toHaveCount(0);
 await page.evaluate(()=>opsGo('people'));
 await hubReady(page);
 await page.evaluate(()=>{opsNewAnnouncement();});
 await page.locator('.ops-modal .ops-action-dialog').waitFor();
 await check('Post announcement','.ops-modal .ops-action-dialog','header>button','footer button.primary');
});
