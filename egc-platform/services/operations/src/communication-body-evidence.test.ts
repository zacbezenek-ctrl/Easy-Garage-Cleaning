import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {communicationBodyEvidence,approvedCommunicationBodyMatches} from "./communication-body-evidence.js";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const approved="We\u2019ll keep the customer\u2019s exact scope.",observed="We'll keep the customer's exact scope.";

describe("bounded provider SMS body evidence",()=>{
  it("keeps legacy exact-body proof for SMS and email",()=>{
    for(const type of ["SMS","Email"]){const proof=communicationBodyEvidence(approved,approved,type)!;expect(proof).toEqual({version:1,bodyHash:hash(approved)});expect(approvedCommunicationBodyMatches(proof,approved,approved,type)).toBe(true);}
  });
  it("retains both raw hashes and observed body for only the one-way apostrophe conversion",()=>{
    const proof=communicationBodyEvidence(approved,observed,"SMS")!;
    expect(proof).toEqual({version:2,bodyHash:hash(observed),approvedBodyHash:hash(approved),providerBodyHash:hash(observed),providerBody:observed,bodyTransform:"sms_u2019_to_ascii_apostrophe"});
    expect(approvedCommunicationBodyMatches(proof,approved,approved,"SMS")).toBe(true);
    expect(hash(approved)).not.toBe(hash(observed));
  });
  it.each([
    [observed,approved,"SMS"], [approved,observed,"Email"], [approved,observed,"sms"],
    [approved,"We‘ll keep the customer‘s exact scope.","SMS"],
    [approved,"We＇ll keep the customer＇s exact scope.","SMS"],
    [approved,observed+" ","SMS"], [approved,observed.replace("exact","different"),"SMS"],
    ["One  space","One space","SMS"], ["A\nB","A\r\nB","SMS"],
    ["A—B","A-B","SMS"], ["A“B”","A\"B\"","SMS"],
    [approved,"We'll keep the customer’s exact scope.","SMS"],
    [undefined,undefined,"SMS"], [1,"1","SMS"],
  ])("rejects all unapproved equivalences: %j -> %j (%s)",(a,b,type)=>expect(communicationBodyEvidence(a,b,type)).toBeNull());
  it("rejects tampered proof, changed raw send, and an invented proof version",()=>{
    const proof=communicationBodyEvidence(approved,observed,"SMS")!;
    for(const changes of [{bodyHash:hash(approved)},{approvedBodyHash:hash(observed)},{providerBodyHash:"bad"},{providerBody:observed+"!"},{bodyTransform:"unicode"},{version:3}])expect(approvedCommunicationBodyMatches({...proof,...changes},approved,approved,"SMS")).toBe(false);
    expect(approvedCommunicationBodyMatches(proof,approved,observed,"SMS")).toBe(false);
    expect(approvedCommunicationBodyMatches(proof,approved,approved,"Email")).toBe(false);
  });
  it("does not reinterpret a version-one provider hash as the approved raw body",()=>{
    expect(approvedCommunicationBodyMatches({version:1,bodyHash:hash(observed)},approved,approved,"SMS")).toBe(false);
    expect(approvedCommunicationBodyMatches({version:1,bodyHash:hash(approved)},approved,"Changed","SMS")).toBe(false);
  });
});
