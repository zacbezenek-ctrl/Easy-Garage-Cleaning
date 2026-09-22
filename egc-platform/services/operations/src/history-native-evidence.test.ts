import {describe,it,expect,vi} from "vitest";
import {nativeHistoryEvents,readNativeHistoryEvidence} from "./history-native-evidence.js";
import type {Actor} from "./contracts.js";
const actor:Actor={id:"test-integration",kind:"integration",role:"integration",workspace:"egc"};
const at="2026-09-17T22:54:46.246Z";
const record=(id="native-job",extra:Record<string,unknown>={})=>({id,highlevelContactId:"provider-exact",kind:"job",createdAt:at,status:"scheduled",sourceType:"cleanout",sourceRevision:"revision",scope:{relocate:["garage to room"]},financials:{timeline:[]},...extra});
const response=(records=[record()],extra:Record<string,unknown>={})=>({ok:true,authority:"employee_hub",contactProviderIds:["provider-exact"],records,coverage:{complete:true,asOf:at},...extra});

describe("exact native customer history",()=>{
  it("requests only the exact provider identity and retains distinct native records and original scope",async()=>{
    const read=vi.fn().mockResolvedValue(response([record("estimate",{kind:"walkthrough"}),record("service",{sourceWalkthroughId:"estimate",createdAt:"2026-09-18T18:00:00Z",jobInstructions:"Move workout items",operationalScope:{text:"Rotate cabinet"},serviceType:"Garage organization"})]));
    const result=await readNativeHistoryEvidence(actor,"provider-exact",read);
    expect(read).toHaveBeenCalledWith(actor,{command:"portal.evidence",contactProviderIds:["provider-exact"]});
    expect(result).toMatchObject({total:2,returned:2,truncated:false,coverage:{complete:true,sourceComplete:true,available:true}});
    expect(result.records.map(r=>r.id)).toEqual(["estimate","service"]);
    expect(result.records[1]).toMatchObject({sourceWalkthroughId:"estimate",jobInstructions:"Move workout items",operationalScope:{text:"Rotate cabinet"},serviceType:"Garage organization"});
    expect(nativeHistoryEvents(result).map(e=>e.id)).toEqual(["hub-record:estimate","hub-record:service"]);
  });
  it("rejects wrong-contact records even beyond the 100-record display bound",async()=>{
    for(const records of [[record("foreign",{highlevelContactId:"other"})],[...Array.from({length:100},(_,i)=>record("same-"+i)),record("foreign",{highlevelContactId:"other"})]]){
      const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>response(records));
      expect(result).toMatchObject({records:[],total:null,coverage:{available:false,complete:false,reason:"portal_evidence_identity_mismatch"}});
    }
  });
  it("rejects extra contact identities, repeated native IDs, foreign authority and malformed coverage",async()=>{
    const examples=[response([],{contactProviderIds:["provider-exact","other"]}),response([record(),record()]),response([],{authority:"ghl"}),response([],{coverage:{complete:true}})];
    for(const example of examples){const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>example);expect(result.coverage.available).toBe(false);expect(result.total).toBeNull();}
  });
  it("missing bridge, unresolved normalized identity and network failures remain unavailable, never zero proof",async()=>{
    for(const result of [await readNativeHistoryEvidence(actor,"provider-exact"),await readNativeHistoryEvidence(actor,null),await readNativeHistoryEvidence(actor,"provider-exact",async()=>{throw new Error("Bearer secret-value");})]){
      expect(result.records).toEqual([]);expect(result.total).toBeNull();expect(result.coverage.complete).toBe(false);expect(result.coverage.available).toBe(false);expect(JSON.stringify(result)).not.toContain("secret-value");
    }
  });
  it("partial source coverage preserves exact visible evidence without claiming a complete total",async()=>{
    const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>response([record()],{coverage:{complete:false,asOf:at}}));
    expect(result).toMatchObject({total:null,returned:1,truncated:false,coverage:{available:true,complete:false,sourceComplete:false,reason:"portal_evidence_partial"}});
  });
  it("caps records at 100 and distinguishes complete source scan from truncated history output",async()=>{
    const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>response(Array.from({length:101},(_,i)=>record("record-"+i))));
    expect(result).toMatchObject({total:101,returned:100,truncated:true,coverage:{complete:false,sourceComplete:true,reason:"portal_evidence_truncated"}});
  });
  it("complete exact empty source is distinguishable from source failure",async()=>{
    expect(await readNativeHistoryEvidence(actor,"provider-exact",async()=>response([]))).toMatchObject({records:[],total:0,returned:0,coverage:{available:true,complete:true}});
  });
  it("does not invent occurrence time and retains explicit financial timestamps/notes only once",async()=>{
    const r=record("native-job",{createdAt:null,updatedAt:"2026-09-20T18:00:00Z",operationNotes:[{id:"note-a",body:"Completed scope review",actorId:"owner",createdAt:at}],financials:{quote:{at:null,amountCents:null},timeline:[{id:"receipt-a",kind:"payment_verified",at,data:{amountCents:13900,currency:"USD",portalJobId:"wrong"}},{id:"receipt-a",kind:"payment_verified",at,data:{amountCents:13900,currency:"USD"}}]}});
    const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>response([r]));
    const events=nativeHistoryEvents(result);expect(events.map(e=>e.kind).sort()).toEqual(["job_note","payment_verified"]);
    expect(events.find(e=>e.kind==="payment_verified")?.data).toMatchObject({amountCents:13900,portalJobId:"native-job",association:"exact_portal_record"});
    expect(result.records[0]?.financials).toMatchObject({quote:{at:null,amountCents:null}});
  });
  it("does not copy unexpected whole-source fields into customer history",async()=>{
    const result=await readNativeHistoryEvidence(actor,"provider-exact",async()=>response([record("native-job",{sealedPayload:"private",wallet:{secret:"private"},payment:{clientSecret:"private"}})]));
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
