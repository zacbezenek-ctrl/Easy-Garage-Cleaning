import {describe,it,expect} from "vitest";
import {callContactEvidence,communicationSummary,normalizeCallMetadata} from "./communications.js";
const at=new Date("2026-09-20T12:00:00Z");
const call=(raw:Record<string,unknown>)=>({direction:String(raw.direction??"outbound"),actorType:raw.direction==="inbound"?"customer":"human",at,raw});
describe("call normalization",()=>{
  it("retains supported nested duration and recording attachment without claiming an answer",()=>{
    const value=normalizeCallMetadata({status:"completed",meta:{call:{duration:312,attachments:[{type:"audio/wav",url:"https://media.example.test/call.wav?token=secret&v=1"}]}}});
    expect(value).toEqual({durationSeconds:312,recordingUrl:"https://media.example.test/call.wav?v=1",answered:null});
    expect(callContactEvidence({status:"completed",meta:{call:{duration:312}}}).twoWay).toBe(false);
  });
  it("handles recording-only and malformed call facts conservatively",()=>{
    expect(normalizeCallMetadata({attachments:["https://media.example.test/recording.mp3"]})).toEqual({durationSeconds:null,recordingUrl:"https://media.example.test/recording.mp3",answered:null});
    for(const duration of [null,"",-1,"not-a-number",90000])expect(normalizeCallMetadata({duration}).durationSeconds).toBeNull();
    expect(normalizeCallMetadata({duration:"12.6"}).durationSeconds).toBe(13);
  });
  it("does not expose URL credentials or credential-shaped query values",()=>{
    expect(normalizeCallMetadata({recordingUrl:"https://user:pass@media.example.test/a.wav"}).recordingUrl).toBeNull();
    expect(normalizeCallMetadata({recordingUrl:"https://media.example.test/a.wav?X-Amz-Signature=secret&part=1"}).recordingUrl).toBe("https://media.example.test/a.wav?part=1");
  });
});
describe("communication evidence",()=>{
  it("does not turn completed, duration, missed inbound or screening into successful contact",()=>{
    for(const raw of [{status:"completed",duration:120},{status:"no-answer",direction:"inbound"},{status:"completed",callStatus:"screened",answeredBy:"human"},{status:"completed",answeredBy:"machine"}]) expect(callContactEvidence(raw).twoWay).toBe(false);
  });
  it("does not accept inbound completed status tuple as conversation evidence",()=>{
    const raw={direction:"inbound",status:"completed",callStatus:"completed",userId:"staff-1",callDuration:30};
    expect(callContactEvidence(raw).twoWay).toBe(false);
    expect(callContactEvidence({...raw,disposition:"voicemail"}).twoWay).toBe(false);
  });
  it("does not accept nested completed call metadata without transcript dialogue",()=>{
    const raw={direction:"outbound",status:"completed",userId:"staff-1",meta:{call:{status:"completed",duration:192}}};
    expect(callContactEvidence(raw).twoWay).toBe(false);
    expect(callContactEvidence({...raw,meta:{call:{status:"voicemail",duration:192}}}).twoWay).toBe(false);
  });
  it("uses actual customer/staff transcript turns instead of call duration",()=>{
    expect(callContactEvidence({status:"completed"},"Agent: What time works for your walkthrough?\nCustomer: Tuesday at two works.").twoWay).toBe(true);
    expect(callContactEvidence({status:"completed"},"Hello. Please leave a message. Hello, I am calling about your walkthrough.").twoWay).toBe(false);
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
