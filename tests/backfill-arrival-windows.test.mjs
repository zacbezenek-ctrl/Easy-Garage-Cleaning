import test from 'node:test';
import assert from 'node:assert/strict';
import { planArrivalWindowBackfill, runArrivalWindowBackfill, parseArgs } from '../scripts/backfill-arrival-windows.mjs';

const NOW = '2026-09-22T18:00:00.000Z'; // 12:00 PM in Denver on 2026-09-22
const ENABLED = {defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:60};
const job = (id, extra = {}) => ({id,revision:`${id}-r1`,type:'job',customerId:'c1',customer:'Synthetic Customer',date:'2026-09-24',time:'09:00',endTime:'11:00',status:'scheduled',...extra});
const JOBS = () => [
  job('future'),
  job('later-today',{date:'2026-09-22',time:'13:00',endTime:'14:00',jobInstructions:{arrivalWindow:'1:00–3:00 brief'}}),
  job('walkthrough',{type:'walkthrough',date:'2026-09-25',time:'15:30',endTime:'16:30',status:undefined,pipelineStatus:'scheduled'}),
  job('explicit-unlabeled',{arrivalWindowStart:'08:30',arrivalWindowEnd:'10:00'}),
  job('earlier-today',{date:'2026-09-22',time:'11:00',endTime:'13:00'}),
  job('past',{date:'2026-09-21'}),
  job('labeled',{arrivalWindow:'9:00 AM – 10:00 AM'}),
  job('labeled-other',{arrivalWindow:'8:00 AM – 10:00 AM'}),
  job('stale-explicit',{arrivalWindowStart:'06:00',arrivalWindowEnd:'07:00',arrivalWindow:'6:00 AM – 7:00 AM'}),
  job('last-minute',{time:'23:59',endDate:'2026-09-25',endTime:'01:00'}),
  job('dst-gap',{date:'2027-03-14',time:'02:30',endTime:'04:00'}),
  job('unscheduled',{date:'',time:'',endTime:'',status:'unscheduled'}),
  job('cancelled',{status:'cancelled',pipelineStatus:'cancelled'}),
  job('completed',{pipelineStatus:'completed'}),
  job('blocked',{type:'blocked',customerId:undefined}),
  job('_egc_schedule_lock_2026-09-24',{type:undefined}),
  job('secure_vault',{type:undefined}),
  job('availability-row',{type:'availability',recordType:'crew_availability'}),
];

test('selection labels only future, active, unlabeled customer visits with the dispatch-derived window', () => {
  const {writes,report} = planArrivalWindowBackfill(JOBS(),ENABLED,NOW);
  assert.deepEqual(writes.map(row => [row.id,row.arrivalWindow,row.revision]),[
    ['explicit-unlabeled','8:30 AM – 10:00 AM','explicit-unlabeled-r1'],
    ['future','9:00 AM – 10:00 AM','future-r1'],
    ['later-today','1:00 PM – 2:00 PM','later-today-r1'],
    ['walkthrough','3:30 PM – 4:30 PM','walkthrough-r1'],
  ]);
  assert.equal(writes.find(row => row.id === 'later-today').supersedesBriefText,true);
  assert.equal(writes.find(row => row.id === 'explicit-unlabeled').explicit,true);
  assert.deepEqual({...report,differentLabel:[...report.differentLabel]},{scanned:18,skippedRecords:4,inactive:2,unscheduled:2,past:2,alreadyLabeled:2,differentLabel:['labeled-other'],noDerivableWindow:['last-minute'],
    needsDispatchReview:[{id:'stale-explicit',reason:'The arrival window must include the scheduled start time.'}]});
});

test('the preview uses the configured window length and still previews while the flag is off', () => {
  const {writes} = planArrivalWindowBackfill([job('future')],{defaultArrivalWindowEnabled:false,defaultArrivalWindowMinutes:90},NOW);
  assert.equal(writes[0].arrivalWindow,'9:00 AM – 10:30 AM');
  assert.equal(planArrivalWindowBackfill([job('future',{time:'23:00',endDate:'2026-09-25',endTime:'01:00'})],{defaultArrivalWindowMinutes:120},NOW).writes[0].arrivalWindow,'11:00 PM – 11:59 PM');
  assert.throws(() => planArrivalWindowBackfill(null,ENABLED,NOW),/complete job list/);
  assert.throws(() => planArrivalWindowBackfill([],ENABLED,'not a time'),/valid current time/);
});

function store(settings,rows = JOBS()) {
  const docs = new Map(rows.map(row => [`jobs/${row.id}`,structuredClone(row)])), commits = [];let revision = 0, lose = false, beforeCommit = null;
  return {docs,commits,loseNext:() => {lose = true;},onCommit:fn => {beforeCommit = fn;},
    settings:async () => structuredClone(settings),
    jobs:async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([,row]) => structuredClone(row)),
    read:async (collection,id) => structuredClone(docs.get(`${collection}/${id}`) || null),
    commit:async writes => {
      if (beforeCommit) {const fn = beforeCommit;beforeCommit = null;fn();}
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, current = docs.get(key);
        assert.ok(!seen.has(key),'no duplicate writes per commit');seen.add(key);
        if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('Changed'),{code:'dispatch_revision_conflict',status:409});
      }
      commits.push(structuredClone(writes));
      for (const write of writes) docs.set(`${write.collection}/${write.id}`,{...docs.get(`${write.collection}/${write.id}`),...structuredClone(write.patch),id:write.id,revision:`w${++revision}`});
      if (lose) {lose = false;throw Object.assign(new Error('Lost'),{code:'dispatch_outcome_unknown',status:503});}
    }};
}

test('dry run is the default and writes nothing', async () => {
  const s = store(ENABLED), before = structuredClone([...s.docs]);
  const report = await runArrivalWindowBackfill(s,{now:NOW,runId:'run-dry'});
  assert.equal(report.mode,'dry_run');assert.deepEqual(report.settings,{enabled:true,minutes:60});
  assert.deepEqual(report.writes,{planned:4,committed:0,changedDuringRun:[],receipts:[]});
  assert.deepEqual(report.preview.map(row => row.id),['explicit-unlabeled','future','later-today','walkthrough']);
  assert.doesNotMatch(JSON.stringify(report),/Synthetic Customer/,'the report carries no customer details');
  assert.equal(s.commits.length,0);assert.deepEqual([...s.docs],before);
});

test('apply writes only the label with updateTime preconditions and an atomic receipt, then is a no-op', async () => {
  const s = store(ENABLED), report = await runArrivalWindowBackfill(s,{apply:true,now:NOW,runId:'run-1'});
  assert.equal(report.mode,'apply');assert.equal(report.aborted,undefined);assert.equal(report.writes.committed,4);assert.equal(s.commits.length,1);
  const [writes] = s.commits, receipt = writes.find(write => write.collection === 'dispatchOperations');
  for (const write of writes.filter(write => write.collection === 'jobs')) {assert.equal(write.revision,`${write.id}-r1`);assert.deepEqual(Object.keys(write.patch),['arrivalWindow']);}
  assert.equal(receipt.revision,undefined,'receipts are create-only');assert.equal(receipt.id,report.writes.receipts[0]);
  assert.equal(receipt.patch.runId,'run-1');assert.equal(receipt.patch.createdAt,NOW);assert.equal(receipt.patch.actorId,'arrival-window-backfill');
  assert.deepEqual(receipt.patch.targets.find(row => row.id === 'future'),{id:'future',revision:'future-r1',before:{arrivalWindow:null},after:{arrivalWindow:'9:00 AM – 10:00 AM'}});
  assert.equal(s.docs.get('jobs/future').arrivalWindow,'9:00 AM – 10:00 AM');assert.equal(s.docs.get('jobs/future').arrivalWindowStart,undefined,'derived windows stay implicit');
  assert.equal(s.docs.get('jobs/stale-explicit').arrivalWindow,'6:00 AM – 7:00 AM');assert.equal(s.docs.get('jobs/past').arrivalWindow,undefined);assert.equal(s.docs.get('jobs/cancelled').arrivalWindow,undefined);
  const again = await runArrivalWindowBackfill(s,{apply:true,now:NOW,runId:'run-2'});
  assert.equal(again.writes.planned,0);assert.equal(s.commits.length,1);
});

test('a job saved during the run is skipped and reported while the rest are labeled', async () => {
  const s = store(ENABLED);
  s.onCommit(() => {const row = s.docs.get('jobs/future');s.docs.set('jobs/future',{...row,time:'10:00',revision:'dispatch-save'});});
  const report = await runArrivalWindowBackfill(s,{apply:true,now:NOW,runId:'run-race',batchSize:10});
  assert.deepEqual(report.writes.changedDuringRun,['future']);assert.equal(report.writes.committed,3);assert.equal(report.writes.receipts.length,3);
  assert.equal(s.docs.get('jobs/future').arrivalWindow,undefined,'a concurrent dispatch save is never overwritten');
  assert.equal(s.docs.get('jobs/walkthrough').arrivalWindow,'3:30 PM – 4:30 PM');
});

test('a lost commit response is confirmed by its receipt; apply refuses while the flag is off', async () => {
  const s = store(ENABLED);s.loseNext();
  const report = await runArrivalWindowBackfill(s,{apply:true,now:NOW,runId:'run-lost'});
  assert.equal(report.aborted,undefined);assert.equal(report.writes.committed,4);assert.equal(s.commits.length,1);
  const off = store({defaultArrivalWindowEnabled:false,defaultArrivalWindowMinutes:60}), refused = await runArrivalWindowBackfill(off,{apply:true,now:NOW,runId:'run-off'});
  assert.equal(refused.aborted.code,'arrival_window_backfill_disabled');assert.equal(refused.writes.planned,4);assert.equal(off.commits.length,0);
});

test('arguments default to a dry run and reject ambiguous modes', () => {
  assert.deepEqual(parseArgs([]),{apply:false,report:'',help:false});
  assert.deepEqual(parseArgs(['--apply','--report','out.json']),{apply:true,report:'out.json',help:false});
  assert.throws(() => parseArgs(['--apply','--dry-run']),/either/);assert.throws(() => parseArgs(['--force']),/Unknown/);assert.throws(() => parseArgs(['--report']),/incomplete/);
});
