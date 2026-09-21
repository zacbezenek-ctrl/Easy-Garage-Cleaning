import {describe,it,expect} from "vitest";
import {callContactEvidence,communicationSummary} from "./communications.js";
const at=new Date("2026-09-20T12:00:00Z");
const call=(raw:Record<string,unknown>)=>({direction:String(raw.direction??"outbound"),actorType:raw.direction==="inbound"?"customer":"human",at,raw});
describe("communication evidence",()=>{
  it("does not turn completed, duration, missed inbound or screening into successful contact",()=>{
    for(const raw of [{status:"completed",duration:120},{status:"no-answer",direction:"inbound"},{status:"completed",callStatus:"screened",answeredBy:"human"},{status:"completed",answeredBy:"machine"}]) expect(callContactEvidence(raw).twoWay).toBe(false);
  });
  it("accepts the documented inbound human call tuple, with no voicemail override",()=>{
    const raw={direction:"inbound",status:"completed",callStatus:"completed",userId:"staff-1",callDuration:30};
    expect(callContactEvidence(raw).twoWay).toBe(true);
    expect(callContactEvidence({...raw,disposition:"voicemail"}).twoWay).toBe(false);
  });
  it("accepts HighLevel live GET nested call evidence for an outbound human connection",()=>{
    const raw={direction:"outbound",status:"completed",userId:"staff-1",meta:{call:{status:"completed",duration:192}}};
    expect(callContactEvidence(raw).twoWay).toBe(true);
    expect(callContactEvidence({...raw,meta:{call:{status:"voicemail",duration:192}}}).twoWay).toBe(false);
  });
  it("keeps a human attempt plus missed inbound out of two-way and response counts",()=>{
    const result=communicationSummary([], [call({status:"no-answer"}),call({direction:"inbound",status:"missed"})]);
    expect(result.hasHumanOutreach).toBe(true);expect(result.hasCustomerResponse).toBe(false);expect(result.twoWayContactAt).toBeNull();
  });
  it("does not count mirrored CALL messages as customer SMS replies",()=>{
    expect(communicationSummary([{...call({direction:"inbound",status:"completed"}),type:"TYPE_CALL"}],[]).hasCustomerResponse).toBe(false);
  });
  it("requires actual human messages for a text exchange and excludes failed delivery",()=>{
    const inbound={direction:"inbound",actorType:"customer",at,type:"SMS",raw:{status:"received"}};
    const outbound={direction:"outbound",actorType:"human",at,type:"SMS",raw:{status:"delivered"}};
    expect(communicationSummary([inbound,outbound],[]).twoWayContactAt).toEqual(at);
    expect(communicationSummary([inbound,{...outbound,actorType:"automation"}],[]).twoWayContactAt).toBeNull();
    expect(communicationSummary([inbound,{...outbound,raw:{status:"failed"}}],[]).twoWayContactAt).toBeNull();
  });
});
