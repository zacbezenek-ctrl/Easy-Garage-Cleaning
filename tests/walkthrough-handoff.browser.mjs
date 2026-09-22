// Browser controller -> real signed-in handlers -> actual Firestore emulator.
// Signature/image/customer are explicit fixtures, and external CRM stays blocked.
import assert from 'node:assert/strict';

export async function verifyWalkthroughHandoff({environment,managerPage,crewPage,base,date,readJob}) {
  await environment.withSecurityRulesDisabled(async context => {
    const db=context.firestore();
    await db.doc('customers/handoff-customer').set({name:'Synthetic Signed Handoff',phone:'9705550144',address:'144 Fixture Way'});
    await db.doc('projects/handoff-project').set({customerId:'handoff-customer',sourceRecordId:'handoff-source',sourceWalkthroughId:'handoff-source'});
    await db.doc('jobs/handoff-source').set({type:'walkthrough',customerId:'handoff-customer',projectId:'handoff-project',customer:'Synthetic Signed Handoff',phone:'9705550144',address:'144 Fixture Way',status:'scheduled',date,time:'06:00',endTime:'06:30',assignedCrew:[],payment:{verified:true,amount:40,reference:'synthetic-original-only'}});
  });
  await managerPage.goto(base+'/dispatch.html');
  await managerPage.addScriptTag({url:base+'/crew/gameplan-handoff.js'});
  const original=await managerPage.evaluate(async date => {
    const canvas=document.createElement('canvas');canvas.width=100;canvas.height=40;
    const pen=canvas.getContext('2d');pen.fillText('Synthetic fixture',1,25);
    const plan={client:{name:'Synthetic Signed Handoff',phone:'9705550144',email:'',address:'144 Fixture Way',highlevel_contact_id:''},
      quote:{title:'Signed handoff fixture',total:1400,deposit:700,job_date:date,start_time:'18:00',end_time:'19:00',estimated_duration_min:60},
      discovery:{success:'Park safely'},scope:{keep_items:'Blue bicycle',remove_items:'Empty cartons',exclusions:'Locked cabinet'},
      logistics:{crew_size:1,assigned_to:'Crew One',notes:'Use side gate'},internal_notes:'Keep blue bicycle. Remove empty cartons. Protect locked cabinet.',
      client_checklists:{preJob:[{id:'keep-bike',label:'Protect blue bicycle',detail:'Keep safe',critical:true}],postJob:[{id:'scope-review',label:'Review agreed scope',detail:'Check with customer'}]},
      signature:canvas.toDataURL(),acceptance:{accepted_at:new Date().toISOString(),accepted_by:'Synthetic fixture only',signature_captured:true,method:'in_person_signature',terms_version:'fixture-terms-v1'},terms_version:'fixture-terms-v1',terms_accepted:true,photos:{before:1},notes:'Call before arrival'};
    sessionStorage.setItem('handoff-browser-fixture-plan',JSON.stringify(plan));
    const client=EGCWalkthroughHandoffClient({storage:sessionStorage,fetch:(...a)=>fetch(...a),actor:async()=>{const r=await fetch('/api/hub-auth');return (await r.json()).user;},uuid:()=>crypto.randomUUID(),plan:()=>plan,source:()=> 'handoff-source',savedJobId:()=>'',photoDraftId:()=> 'fixture-draft',accept:()=>{}});
    const [a,b]=await Promise.all([client.save(),client.save()]);
    let crmFailed=false;try{await client.sync(a);}catch{crmFailed=true;}
    return {id:a.result.job.id,secondId:b.result.job.id,requestId:a.pending.requestId,crmFailed};
  },date);
  assert.equal(original.id,original.secondId);assert.equal(original.crmFailed,true);
  const saved=await readJob(original.id);assert.equal(saved.customerId,'handoff-customer');assert.equal(saved.projectId,'handoff-project');
  assert.equal(saved.sourceWalkthroughId,'handoff-source');assert.equal(saved.estimate.amount,1400);assert.equal(saved.estimate.status,'accepted');
  assert.equal(saved.deposit.paidAmount,0);assert.equal(saved.payment,undefined);assert.equal(saved.syncStatus,'pending');
  const source=await readJob('handoff-source');assert.equal(source.status,'scheduled');assert.equal(source.payment.amount,40);assert.equal(source.completedAt,undefined);
  await managerPage.reload();await managerPage.addScriptTag({url:base+'/crew/gameplan-handoff.js'});
  const replay=await managerPage.evaluate(async()=>{
    const client=EGCWalkthroughHandoffClient({storage:sessionStorage,fetch:(...a)=>fetch(...a),actor:async()=>{const r=await fetch('/api/hub-auth');return (await r.json()).user;},uuid:()=>crypto.randomUUID(),plan:()=>JSON.parse(sessionStorage.getItem('handoff-browser-fixture-plan')),source:()=> 'handoff-source',savedJobId:()=>'',photoDraftId:()=> 'fixture-draft',accept:()=>{}});
    const result=await client.save();return {id:result.result.job.id,requestId:result.pending.requestId,replayed:result.result.replayed};
  });
  assert.equal(replay.id,original.id);assert.equal(replay.requestId,original.requestId);assert.equal(replay.replayed,true);
  const photo=await managerPage.evaluate(async id=>{
    const current=await (await fetch('/api/field-jobs?jobId='+id)).json();const canvas=document.createElement('canvas');canvas.width=5;canvas.height=5;
    const response=await fetch('/api/field-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'photo',jobId:id,requestId:crypto.randomUUID(),expectedRevision:current.job.expectedRevision,category:'walkthrough',caption:'Synthetic walkthrough reference',dataUrl:canvas.toDataURL()})});
    return {status:response.status,body:await response.json()};
  },original.id);
  assert.equal(photo.status,200,JSON.stringify(photo.body));assert.equal(photo.body.job.photos[0].category,'walkthrough');
  assert.equal((await readJob(original.id)).fieldLastActionAt,undefined);
  await crewPage.goto(base+'/crew/job.html?jobId='+original.id);
  await crewPage.getByRole('heading',{name:'Synthetic Signed Handoff',exact:true}).waitFor();
  await crewPage.getByText('Keep blue bicycle. Remove empty cartons. Protect locked cabinet.',{exact:true}).waitFor();
  await crewPage.getByText('1 verified',{exact:true}).waitFor();
  assert.equal(await crewPage.locator('body').evaluate(body=>body.scrollWidth<=innerWidth),true);
  console.log('PASS: signed walkthrough browser save/reload/replay survives CRM outage; exact customer/project/source, private crew reference photo, original payment and visit status preserved in real Firestore emulator.');
}
