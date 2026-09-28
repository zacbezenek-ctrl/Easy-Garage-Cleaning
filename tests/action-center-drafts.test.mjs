import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Runs the real Action Center module and checks the draft helpers that decide what a
// manager sees before approving, what Edit sends, and which actions staff may complete.
const source=readFileSync(new URL('../employee-operations.js',import.meta.url),'utf8');
const kindsSource=readFileSync(new URL('../egc-platform/services/operations/src/action-kinds.ts',import.meta.url),'utf8');
function load(){
  const listeners=[],window={addEventListener:(type)=>listeners.push(type)};
  vm.runInNewContext(source,{window,URL,Intl,console},{filename:'employee-operations.js'});
  assert.deepEqual(listeners.sort(),['beforeunload','egc:signout']);
  return window.EGCActionCenter;
}
const platformList=name=>{const match=new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(kindsSource);assert.ok(match,name);return JSON.parse(`[${match[1]}]`);};
const center=load(),drafts=center.drafts;
const plain=value=>JSON.parse(JSON.stringify(value));
const attachments=[
  {kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:'quote:synthetic-1'},
  {kind:'before_after_gallery',url:'https://easygaragecleaning.com/gallery/synthetic?set=2#top',label:'Before and after photos',refId:null}
];
const draft={channel:'sms',recipient:'+15555550100',subject:'',body:'Synthetic exact message',sendWindowStart:'2026-10-01T15:00:00.000Z',sendWindowEnd:'2026-10-02T03:00:00.000Z',attachments};
const form={channel:'email',recipient:'synthetic@example.invalid',subject:'Synthetic subject',body:'Edited synthetic body',sendWindowStart:'2026-10-01T09:00',sendWindowEnd:'2026-10-01T21:30'};

test('the Hub message and attachment kinds are exactly the platform contract lists',()=>{
  const messageKinds=platformList('MESSAGE_TASK_KINDS'),taskKinds=platformList('TASK_KINDS'),attachmentKinds=platformList('MESSAGE_ATTACHMENT_KINDS');
  assert.equal(messageKinds.length,7);
  assert.deepEqual([...drafts.MESSAGE_KINDS],messageKinds);
  assert.deepEqual(Object.keys(drafts.ATTACHMENT_KINDS),attachmentKinds);
  assert.deepEqual(Object.keys(drafts.labels).sort(),[...taskKinds].sort());
  assert.ok(Object.isFrozen(drafts.MESSAGE_KINDS)&&Object.isFrozen(drafts.ATTACHMENT_KINDS));
});

test('no message kind and no deposit can be completed by staff attestation from the Hub',()=>{
  for(const kind of platformList('MESSAGE_TASK_KINDS')){assert.equal(drafts.isMessageKind(kind),true,kind);assert.equal(drafts.canComplete(kind),false,kind);}
  assert.equal(drafts.canComplete('verify_deposit'),false);
  for(const kind of ['manual','callback','prepare_quote','review_notes','job_readiness','schedule_job']){assert.equal(drafts.isMessageKind(kind),false,kind);assert.equal(drafts.canComplete(kind),true,kind);}
  for(const kind of [undefined,null,'','Send_quote','send_quote ','__proto__'])assert.equal(drafts.isMessageKind(kind),false,String(kind));
});

test('Edit sends the exact draft for every message kind and keeps the reviewed links unchanged',()=>{
  for(const kind of platformList('MESSAGE_TASK_KINDS')){
    const built=drafts.buildDraft(kind,form,draft);
    assert.deepEqual(plain(built),{channel:'email',recipient:'synthetic@example.invalid',subject:'Synthetic subject',body:'Edited synthetic body',sendWindowStart:'2026-10-01T15:00:00.000Z',sendWindowEnd:'2026-10-02T03:30:00.000Z',attachments},kind);
    assert.notEqual(built.attachments,draft.attachments,'the saved draft is a copy, not the loaded object');
  }
  assert.deepEqual(plain(drafts.buildDraft('send_quote',form,null)).attachments,[],'a new draft has no links');
  const {attachments:_,...legacy}=draft;assert.deepEqual(plain(drafts.buildDraft('followup_message',form,legacy)).attachments,[],'a pre-v2 draft has no links');
  for(const kind of ['manual','callback','schedule_job','verify_deposit'])assert.equal(drafts.buildDraft(kind,form,draft),null,kind);
  assert.throws(()=>drafts.buildDraft('send_quote',{...form,sendWindowStart:'2026-11-01T01:30'},draft),/daylight saving/);
});

test('draft review lists every attachment link with its kind, label and host',()=>{
  const review=drafts.draftReview(draft);
  assert.equal(review.ok,true);assert.deepEqual(plain(review.problems),[]);
  assert.deepEqual(plain(review.attachments),[
    {kind:'portal_quote',kindLabel:'Portal quote',label:'Your quote',url:attachments[0].url,host:'easygaragecleaning.com',refId:'quote:synthetic-1',verifiable:true},
    {kind:'before_after_gallery',kindLabel:'Before and after photos',label:'Before and after photos',url:attachments[1].url,host:'easygaragecleaning.com',refId:null,verifiable:true}
  ]);
  const {attachments:_,...legacy}=draft;const old=drafts.draftReview(legacy);assert.equal(old.ok,true);assert.deepEqual(plain(old.attachments),[]);
  assert.equal(drafts.draftReview({...draft,channel:'email',recipient:'synthetic@example.invalid',subject:'Synthetic subject',attachments:[]}).ok,true);
});

test('a draft the Hub cannot show in full is never approvable here',()=>{
  const withLink=(extra,index=0)=>({...draft,attachments:attachments.map((a,i)=>i===index?{...a,...extra}:a)});
  const cases=[
    [null,/missing or unreadable/],[[],/missing or unreadable/],
    [{...draft,mediaUrls:['https://example.com/x']},/field this screen cannot show: mediaUrls/],
    [{...draft,attachments:'https://example.com/x'},/attachment list is unreadable/],
    [{...draft,attachments:[null]},/Attachment 1 is unreadable/],
    [withLink({kind:'invoice_pdf'}),/Attachment 1 has an unknown kind/],
    [withLink({kind:'__proto__'}),/Attachment 1 has an unknown kind/],
    [withLink({signedUrl:'https://example.com/s'},1),/Attachment 2 has a field this screen cannot show: signedUrl/],
    [withLink({label:'   '}),/Attachment 1 has no label/],
    [withLink({url:'http://easygaragecleaning.com/q'}),/canonical https link/],
    [withLink({url:'javascript:alert(1)'}),/canonical https link/],
    [withLink({url:'HTTPS://EasyGarageCleaning.com/q'}),/canonical https link/],
    [withLink({url:'https://easygaragecleaning.com\\q'}),/canonical https link/],
    [withLink({url:'https://user:pass@easygaragecleaning.com/q'}),/canonical https link/],
    [withLink({url:'https://easygaragecleaning.com/​q'}),/canonical https link/],
    [withLink({url:42}),/canonical https link/],
    [withLink({refId:{id:'x'}}),/unreadable reference/],
    [{...draft,channel:'push'},/channel is not SMS or email/],
    [{...draft,body:''},/message is missing/]
  ];
  for(const [value,problem] of cases){
    const review=drafts.draftReview(value);
    assert.equal(review.ok,false,JSON.stringify(value));
    assert.ok(review.problems.some(p=>problem.test(p)),`${JSON.stringify(value)} -> ${review.problems.join(' | ')}`);
  }
  const unknown=drafts.draftReview(withLink({kind:'__proto__'}));assert.equal(unknown.attachments[0].kindLabel,'Unknown kind');
  const bad=drafts.draftReview(withLink({url:'http://easygaragecleaning.com/q'}));assert.equal(bad.attachments[0].verifiable,false);assert.equal(bad.attachments[0].host,'');assert.equal(bad.attachments[1].verifiable,true);
});
