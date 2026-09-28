import {describe,expect,it} from "vitest";
import {randomUUID,createHmac} from "node:crypto";
import {authorizeDelegate,OperationsError,signedClaimsSchema,type Actor,type SignedClaims} from "./contracts.js";
import {signRequest,verifyRequest} from "./auth.js";
import {mcpGrantClaims,mcpGrantLabel} from "./service-auth.js";
const key="isolated-delegate-signing-key-not-production-0123456789";
const NOW=Date.parse("2026-09-22T12:00:00Z");
const actor:Actor={id:"mcp:tylerg:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b",kind:"integration",role:"integration",workspace:"egc"};
const delegate={user:"tylerg",role:"manager" as const,assertion:"synthetic-assertion.signature"};
const claims=(extra:Record<string,unknown>={}):SignedClaims=>({v:1,iss:"mcp",aud:"egc-operations",iat:NOW/1000,nonce:randomUUID(),actor,request:{requestId:randomUUID(),body:{command:"status"}},...extra} as SignedClaims);
const code=(fn:()=>unknown)=>{try{fn();return null;}catch(e){expect(e).toBeInstanceOf(OperationsError);return (e as OperationsError).code;}};
const create={command:"task.create" as const,task:{title:"Synthetic",description:"",kind:"manual" as const,priority:"medium" as const,assignedUserId:"zacb",dueAt:"2026-09-22T12:00:00-06:00",timeZone:"America/Denver",waitingOn:"none" as const,reviewAt:null,portalJobId:null,portalVisitId:null,contactId:null,jobId:null,completionCondition:"Done",sourceEvidence:[],dependencies:[],draft:null}};

describe("delegate in the MCP envelope",()=>{
  it("round trips beside the four-field actor and is optional",()=>{
    const withDelegate=claims({delegate});
    expect(verifyRequest(signRequest(withDelegate,key),{mcp:key},NOW)).toEqual(withDelegate);
    expect(verifyRequest(signRequest(claims(),key),{mcp:key},NOW)).not.toHaveProperty("delegate");
  });
  it("is strict: no extra delegate keys, no unknown roles, no identity inside the actor",()=>{
    for(const bad of [{...delegate,approved:true},{...delegate,role:"admin"},{...delegate,user:"Tyler G"},{...delegate,assertion:""}])expect(signedClaimsSchema.safeParse(claims({delegate:bad})).success).toBe(false);
    expect(signedClaimsSchema.safeParse(claims({actor:{...actor,delegate}})).success).toBe(false);
    const forged={...claims(),delegate:{...delegate,role:"owner"}};
    const payload=Buffer.from(JSON.stringify(forged)).toString("base64url"),signature=signRequest(claims({delegate}),key).split(".")[1];
    expect(code(()=>verifyRequest(`${payload}.${signature}`,{mcp:key},NOW))).toBe("invalid_operations_signature");
    expect(createHmac("sha256",key).update(payload).digest("base64url")).not.toBe(signature);
  });
});

describe("authorizeDelegate",()=>{
  it("lets owner and manager delegates write and every delegate read",()=>{
    for(const role of ["owner","manager"] as const)expect(code(()=>authorizeDelegate({...actor,id:`mcp:u:${randomUUID()}`},create,{...delegate,user:"u",role}))).toBeNull();
    for(const role of ["sales","crew_lead","crew"] as const){
      expect(code(()=>authorizeDelegate({...actor,id:"mcp:u:x"},create,{...delegate,user:"u",role}))).toBe("delegate_write_forbidden");
      expect(code(()=>authorizeDelegate({...actor,id:"mcp:u:x"},{command:"status"},{...delegate,user:"u",role}))).toBeNull();
    }
    expect(code(()=>authorizeDelegate(actor,create,undefined))).toBeNull();
  });
  it("requires the integration actor to name the delegate",()=>{
    expect(code(()=>authorizeDelegate({...actor,id:"mcp:zacb:x"},{command:"status"},delegate))).toBe("delegate_invalid");
    expect(code(()=>authorizeDelegate({...actor,id:"mcp:tylergx:x"},{command:"status"},delegate))).toBe("delegate_invalid");
    expect(code(()=>authorizeDelegate({id:"tylerg",kind:"human",role:"manager",workspace:"egc"},{command:"status"},delegate))).toBe("delegate_invalid");
  });
});

describe("Hub grant claims",()=>{
  const valid={hubUser:"zacb",role:"owner",businessAccess:true,grantNonce:"a".repeat(43),resource:"https://egc-mcp.example.invalid",scope:"egc:read egc:write",client:"Claude (claude.ai)"};
  it("accept exactly the Hub's fields",()=>{
    expect(mcpGrantClaims(valid)).toEqual(valid);expect(mcpGrantClaims({...valid,resource:"http://localhost:4200"}).resource).toBe("http://localhost:4200");
    expect(mcpGrantClaims({...valid,scope:"egc:read",client:""})).toMatchObject({scope:"egc:read",client:""});
  });
  it.each([
    ["extra field",{...valid,approved:true}],["missing field",{hubUser:"zacb",role:"owner",businessAccess:true,grantNonce:"a".repeat(43),resource:"https://egc-mcp.example.invalid",scope:"egc:read"}],
    ["write without read",{...valid,scope:"egc:write"}],["reordered scope",{...valid,scope:"egc:write egc:read"}],["offline scope",{...valid,scope:"egc:read offline_access"}],
    ["label that is not normalised",{...valid,client:" Claude (claude.ai) "}],["label with control text",{...valid,client:"Claude\u202e (claude.ai)"}],["label over 120 characters",{...valid,client:"x".repeat(121)}],["label not text",{...valid,client:7}],
    ["unknown role",{...valid,role:"admin"}],["uppercase user",{...valid,hubUser:"ZacB"}],["string business flag",{...valid,businessAccess:"true"}],
    ["short nonce",{...valid,grantNonce:"a".repeat(42)}],["resource with path",{...valid,resource:"https://egc-mcp.example.invalid/mcp"}],["non-http resource",{...valid,resource:"javascript:alert(1)"}]
  ])("reject %s",(_label,value)=>{expect(()=>mcpGrantClaims(value)).toThrow("invalid_mcp_grant");});
  it("normalise labels idempotently to at most 120 code points, never splitting a character",()=>{
    for(const raw of ["  Claude\u0000\u202e  Desktop\u00a0\u00a0(claude.ai) ","x".repeat(119)+" y z","😀".repeat(130),"\ud800 lone","a\n\tb"]){
      const label=mcpGrantLabel(raw);
      expect(mcpGrantLabel(label)).toBe(label);expect(Array.from(label).length).toBeLessThanOrEqual(120);expect(label).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]|^\s|\s$|\s\s/u);
      expect(new URLSearchParams(new URLSearchParams({client:label}).toString()).get("client")).toBe(label);
    }
    expect(mcpGrantLabel("  Claude\u0000\u202e  Desktop\u00a0\u00a0(claude.ai) ")).toBe("Claude Desktop (claude.ai)");
    expect(mcpGrantLabel("😀".repeat(130))).toBe("😀".repeat(120));expect(mcpGrantLabel(undefined)).toBe("");
  });
});
