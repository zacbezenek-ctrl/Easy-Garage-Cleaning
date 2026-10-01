import {describe,it,expect} from "vitest";
import {assertSmsDraftSender,validSmsFromNumbers} from "./sms-senders.js";
import {messageDraft} from "./contracts.js";
import {digest} from "./policy.js";

const lines=["+15555551644","+15555551818"];
const draft={channel:"sms",recipient:"+15555550100",subject:"",body:"Synthetic message",sendWindowStart:"2026-10-01T14:00:00Z",sendWindowEnd:"2026-10-01T23:00:00Z"};
describe("explicit reviewed SMS sender",()=>{
 it("accepts either configured line without choosing one",()=>{
  expect(validSmsFromNumbers(lines)).toEqual(lines);
  for(const fromNumber of lines)expect(()=>assertSmsDraftSender({...draft,fromNumber},lines)).not.toThrow();
  for(const fromNumber of [undefined,null,""])expect(()=>assertSmsDraftSender({...draft,fromNumber},lines)).toThrow("sms_sender_required");
 });
 it("fails closed on missing or malformed configuration and unknown lines",()=>{
  for(const config of [undefined,null,[],"+15555551644",[...lines,"garbage"],[...lines,"+1 555 555 1644"]])expect(()=>assertSmsDraftSender({...draft,fromNumber:lines[0]},config)).toThrow("sms_sender_not_configured");
  expect(()=>assertSmsDraftSender({...draft,fromNumber:"+15555559999"},lines)).toThrow("sms_sender_not_configured");
 });
 it("preserves legacy absence without inventing approval, rejects invalid syntax and email sender leakage",()=>{
  expect(messageDraft.parse(draft)).not.toHaveProperty("fromNumber");
  expect(()=>assertSmsDraftSender(messageDraft.parse(draft),lines)).toThrow("sms_sender_required");
  for(const fromNumber of ["5551644","+1 5555551644","+05555551644","+15555551644 ",1644])expect(messageDraft.safeParse({...draft,fromNumber}).success).toBe(false);
  expect(messageDraft.safeParse({...draft,channel:"email",recipient:"synthetic@example.invalid",fromNumber:lines[0]}).success).toBe(false);
  expect(messageDraft.safeParse({...draft,channel:"email",recipient:"synthetic@example.invalid",fromNumber:null}).success).toBe(true);
 });
 it("binds the exact sender in the review fingerprint",()=>{
  expect(new Set([draft,...lines.map(fromNumber=>({...draft,fromNumber}))].map(digest)).size).toBe(3);
 });
});
