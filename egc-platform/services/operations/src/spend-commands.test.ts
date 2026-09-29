import {describe,it,expect,vi,beforeEach} from "vitest";
const ledger=vi.hoisted(()=>{
  class SpendLedgerError extends Error{constructor(readonly code:string,readonly status=400,readonly details:Record<string,unknown>={}){super(code);}}
  return {SpendLedgerError,recordSpendEntry:vi.fn(),voidSpendEntry:vi.fn(),listSpendEntries:vi.fn(),readSpendCoverage:vi.fn()};
});
vi.mock("@egc/ad-spend",()=>ledger);
import {authorize,commandSchema,OperationsError,PORTAL_PASSTHROUGH,WRITE_COMMANDS,type Actor} from "./contracts.js";
import {OperationsService} from "./service.js";
import {SPEND_COMMANDS,SPEND_WRITE_COMMANDS} from "./spend-commands.js";

const owner:Actor={id:"zacb",role:"owner",kind:"human",workspace:"egc"};
const requestId="22222222-2222-4222-8222-222222222222",NOW=new Date("2026-09-22T12:00:00.000Z");
const entry={channel:"yard_signs",description:"Synthetic sign order",amountCents:12500,firstDate:"2026-09-01",lastDate:"2026-09-30",receiptReference:"INV-SYN-1001"};
const errorCode=(fn:()=>unknown,code:string)=>{try{fn();throw new Error("Expected denial");}catch(e){expect(e).toBeInstanceOf(OperationsError);expect((e as OperationsError).code).toBe(code);}};
function fixture(){
  const inserted:unknown[]=[];
  const limit=vi.fn(async()=>[]),where=vi.fn(()=>({limit})),from=vi.fn(()=>({where}));
  const tx={select:vi.fn(()=>({from})),execute:vi.fn(async()=>[]),insert:vi.fn(()=>({values:vi.fn(async(value:unknown)=>{inserted.push(value);})}))};
  const db={select:vi.fn(()=>({from})),transaction:vi.fn(async(fn:(t:unknown)=>unknown,_options?:unknown)=>fn(tx))};
  return {db,tx,inserted,service:new OperationsService(db as never,{workspace:"egc",now:()=>NOW})};
}
beforeEach(()=>vi.clearAllMocks());

describe("spend command contracts",()=>{
  it("parses the four owner spend commands strictly",()=>{
    expect(commandSchema.parse({command:"spend.entry.record",entry})).toEqual({command:"spend.entry.record",entry:{...entry,currency:"USD"}});
    expect(commandSchema.safeParse({command:"spend.entry.record",entry,supersedes:{entryId:"33333333-3333-4333-8333-333333333333",revision:1}}).success).toBe(true);
    expect(commandSchema.parse({command:"spend.entries"})).toEqual({command:"spend.entries",status:"active",offset:0,limit:50});
    expect(commandSchema.safeParse({command:"spend.coverage",from:"2026-09-01",to:"2026-10-01"}).success).toBe(true);
    expect(commandSchema.safeParse({command:"spend.entry.void",entryId:"33333333-3333-4333-8333-333333333333",revision:2,reason:"Duplicate entry"}).success).toBe(true);
  });
  it("refuses API channels, missing receipts, reversed periods, identity fields and extras",()=>{
    for(const change of [{channel:"meta_ads"},{channel:"google_ads"},{channel:"Yard Signs"},{receiptReference:""},{receiptReference:"a\nb"},{amountCents:-1},{amountCents:10.5},{currency:"CAD"},{firstDate:"2026-10-01"},{enteredBy:"someone"},{attestedAt:"2026-01-01T00:00:00Z"}])
      expect(commandSchema.safeParse({command:"spend.entry.record",entry:{...entry,...change}}).success,JSON.stringify(change)).toBe(false);
    for(const body of [{command:"spend.entry.record",entry,actor:"zacb"},{command:"spend.entry.void",entryId:"x",revision:1,reason:"Duplicate"},{command:"spend.entry.void",entryId:"33333333-3333-4333-8333-333333333333",revision:1,reason:"no"},
      {command:"spend.coverage",from:"2026-09-01"},{command:"spend.entries",limit:201}])expect(commandSchema.safeParse(body).success,JSON.stringify(body)).toBe(false);
  });
  it("refuses Meta and Google spend typed in under another name, but not look-alike local channels",()=>{
    for(const channel of ["facebook","facebook_ads","fb","fb_boosts","paid_fb","instagram","insta_story","ig_ads","meta","metaads","meta_boost","google","googleads","google_lsa","adwords","gads","youtube_preroll","yt","paid_facebook_leads"])
      expect(commandSchema.safeParse({command:"spend.entry.record",entry:{...entry,channel}}).success,channel).toBe(false);
    for(const channel of ["yard_signs","nextdoor","metal_signs","bing_ads","local_services_ads","instant_flyers","big_banner","tiktok","yelp","figure_eight_mailers"])
      expect(commandSchema.safeParse({command:"spend.entry.record",entry:{...entry,channel}}).success,channel).toBe(true);
  });
  it("classifies writes and never forwards spend to the Hub",()=>{
    expect(SPEND_WRITE_COMMANDS).toEqual(["spend.entry.record","spend.entry.void"]);
    for(const name of Object.keys(SPEND_COMMANDS)){expect(WRITE_COMMANDS.has(name)).toBe(SPEND_WRITE_COMMANDS.includes(name));expect(PORTAL_PASSTHROUGH.has(name)).toBe(false);}
  });
  it("authorizes only a signed-in human owner",()=>{
    for(const command of [commandSchema.parse({command:"spend.entry.record",entry}),commandSchema.parse({command:"spend.coverage",from:"2026-09-01",to:"2026-10-01"})]){
      expect(()=>authorize(owner,command,"egc")).not.toThrow();
      for(const actor of [{...owner,role:"manager"},{...owner,role:"sales"},{id:"mcp-grant",role:"integration",kind:"integration",workspace:"egc"}] as Actor[])errorCode(()=>authorize(actor,command,"egc"),"spend_owner_required");
      errorCode(()=>authorize({...owner,role:"crew"},command,"egc"),"role_forbidden");
      errorCode(()=>authorize({...owner,workspace:"other"},command,"egc"),"workspace_forbidden");
    }
  });
});

describe("spend commands through the operations service",()=>{
  it("reads coverage inside one read-only repeatable-read snapshot with the injected clock",async()=>{
    const f=fixture();ledger.readSpendCoverage.mockResolvedValue({ok:true,metric:{value:null,status:"unknown"}});
    expect(await f.service.execute(owner,{command:"spend.coverage",from:"2026-09-01",to:"2026-10-01"},requestId)).toEqual({ok:true,metric:{value:null,status:"unknown"}});
    expect(f.db.transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:"repeatable read",accessMode:"read only"});
    expect(ledger.readSpendCoverage).toHaveBeenCalledWith(f.tx,owner,{from:"2026-09-01",to:"2026-10-01"},NOW);
    expect(f.inserted).toEqual([]);
  });
  it("records an entry with the envelope request id and saves the idempotency receipt in the same transaction",async()=>{
    const f=fixture(),saved={ok:true,entry:{id:"44444444-4444-4444-8444-444444444444",status:"active"},superseded:null};ledger.recordSpendEntry.mockResolvedValue(saved);
    expect(await f.service.execute(owner,{command:"spend.entry.record",entry},requestId)).toEqual(saved);
    expect(ledger.recordSpendEntry).toHaveBeenCalledWith(f.tx,owner,{entry:{...entry,currency:"USD"},supersedes:undefined},requestId,NOW);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.inserted).toEqual([expect.objectContaining({workspaceId:"egc",actorId:"zacb",requestId,response:saved,digest:expect.stringMatching(/^[a-f0-9]{64}$/)})]);
  });
  it("maps ledger conflicts to operations errors and saves no receipt",async()=>{
    const f=fixture();ledger.voidSpendEntry.mockRejectedValue(new ledger.SpendLedgerError("spend_entry_revision_conflict",409,{currentRevision:3}));
    await expect(f.service.execute(owner,{command:"spend.entry.void",entryId:"33333333-3333-4333-8333-333333333333",revision:2,reason:"Duplicate entry"},requestId))
      .rejects.toMatchObject({code:"spend_entry_revision_conflict",status:409,details:{currentRevision:3}});
    expect(f.inserted).toEqual([]);
  });
  it("refuses a manager and an integration before any database access",async()=>{
    for(const actor of [{...owner,role:"manager"},{id:"mcp-grant",role:"integration",kind:"integration",workspace:"egc"}] as Actor[]){
      const f=fixture();
      await expect(f.service.execute(actor,{command:"spend.entries"},requestId)).rejects.toMatchObject({code:"spend_owner_required",status:403});
      expect(f.db.select).not.toHaveBeenCalled();expect(f.db.transaction).not.toHaveBeenCalled();
    }
  });
});
