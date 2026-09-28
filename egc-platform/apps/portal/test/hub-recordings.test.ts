import {existsSync,readdirSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,describe,expect,it,vi} from "vitest";
import {employeeHubRecordingsUrl,employeeHubUrl} from "../lib/format";
import WalkthroughPage from "../app/walkthroughs/[contactId]/page";
import LeadDetailPage from "../app/leads/[id]/page";
import CustomerDetailPage from "../app/customers/[id]/page";
import JobDetailPage from "../app/jobs/[id]/page";
import WalkthroughsPage from "../app/walkthroughs/page";

vi.mock("next/navigation",()=>({notFound:()=>{throw new Error("not_found");}}));
vi.mock("../lib/intelligence",()=>({getCustomerTimeline:vi.fn(async()=>({customer:null,events:[],assertions:[]})),label:(value:string)=>value,money:(cents:number)=>"$"+(cents/100).toFixed(2)}));
vi.mock("../lib/data",()=>{
  const contact={id:"synthetic-contact-1",name:"Synthetic Lead",phone:"970-555-0101",email:"lead@example.invalid",source:"web"};
  const common={messages:[],calls:[],appointments:[],opportunities:[]};
  return {
    getLeadDetail:vi.fn(async()=>({lead:{source:"web",lastHumanOutreachAt:null,lastCustomerResponseAt:null},contact,...common})),
    getCustomerDetail:vi.fn(async()=>({contact,lead:null,jobs:[],walkthroughs:[],...common})),
    getJobDetail:vi.fn(async()=>({job:{id:"synthetic-job-1",contactId:contact.id,serviceAddress:"1 Synthetic Way",status:"scheduled",scheduledAt:null,garageSize:null,junkVolumeYards:null,estimatedLaborHours:null,priceCents:null,itemsRemove:[],itemsKeep:[],itemsRelocate:[],organizationRequirements:[],addOns:[],accessNotes:null},contact,notes:[],walkthroughs:[]})),
    getWalkthroughs:vi.fn(async()=>[{walkthrough:{id:"synthetic-walkthrough-1",status:"draft",createdAt:new Date("2026-09-22T12:00:00.000Z"),approvedAt:null},contact}])
  };
});

const DEFAULT_RECORDINGS="https://easygaragecleaning.com/employee?view=action_center";
const DEFAULT_WALKTHROUGHS="https://easygaragecleaning.com/employee?view=walkthroughs";
const params=<T>(value:T)=>({params:Promise.resolve(value)});
// Any source-built link into the retired /walkthroughs/<contact> recorder route: concatenated, template or literal.
const RECORDER_LINK=/["'`]\/walkthroughs\/|\/walkthroughs\/\$\{/;
const hrefs=(html:string)=>[...html.matchAll(/href="([^"]*)"/g)].map(match=>match[1]!.replaceAll("&amp;","&"));

afterEach(()=>{vi.unstubAllEnvs();});

describe("Employee Hub deep links",()=>{
  it("defaults to the established Hub and adds only the requested view",()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    expect(employeeHubUrl()).toBe("https://easygaragecleaning.com/employee");
    expect(employeeHubUrl("walkthroughs")).toBe("https://easygaragecleaning.com/employee?view=walkthroughs");
    expect(employeeHubRecordingsUrl()).toBe(DEFAULT_RECORDINGS);
  });
  it("follows a configured https Hub origin and drops its path, query and fragment",()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","https://hub.example.invalid/some/path?view=people#top");
    expect(employeeHubUrl()).toBe("https://hub.example.invalid/employee");
    expect(employeeHubRecordingsUrl()).toBe("https://hub.example.invalid/employee?view=action_center");
  });
  it("never links to an insecure, credentialed or malformed configured origin",()=>{
    for(const origin of ["http://hub.example.invalid","https://user:secret@hub.example.invalid","javascript:alert(1)","not a url"]){
      vi.stubEnv("EGC_PORTAL_ORIGIN",origin);
      expect(employeeHubRecordingsUrl()).toBe(DEFAULT_RECORDINGS);
    }
  });
});

describe("retired portal recorder",()=>{
  it("the walkthrough route renders Hub links and no recording controls",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    const html=renderToStaticMarkup(await WalkthroughPage(params({contactId:"synthetic/contact 1"})));
    expect(hrefs(html)).toEqual([DEFAULT_RECORDINGS,DEFAULT_WALKTHROUGHS,"/customers/synthetic%2Fcontact%201"]);
    expect(html).toContain("Open visit recordings in EGC Hub");
    expect(html).toContain("This reporting portal does not record audio.");
    expect(html).not.toMatch(/<(button|form|textarea|input|audio)\b/);
  });
  it("the walkthrough route follows the configured Hub origin",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","https://hub.example.invalid");
    const html=renderToStaticMarkup(await WalkthroughPage(params({contactId:"synthetic-contact-1"})));
    expect(hrefs(html)[0]).toBe("https://hub.example.invalid/employee?view=action_center");
  });
  it("the lead page links straight to the Hub recordings instead of the retired recorder",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    const html=renderToStaticMarkup(await LeadDetailPage(params({id:"synthetic-lead-1"})));
    expect(html).toContain(`<a class="button compact" href="${DEFAULT_RECORDINGS}">Open recordings in EGC Hub</a>`);
    expect(hrefs(html)).toEqual(["/customers/synthetic-contact-1",DEFAULT_RECORDINGS]);
  });
  it("the customer page links straight to the Hub recordings",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    const html=renderToStaticMarkup(await CustomerDetailPage(params({id:"synthetic-contact-1"})));
    expect(html).toContain(`href="${DEFAULT_RECORDINGS}">Open recordings in EGC Hub</a>`);
    expect(hrefs(html).some(href=>href.startsWith("/walkthroughs/"))).toBe(false);
  });
  it("the job page links to Hub walkthroughs instead of the retired recorder",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    const html=renderToStaticMarkup(await JobDetailPage(params({id:"synthetic-job-1"})));
    expect(html).toContain(`<a class="button compact" href="${DEFAULT_WALKTHROUGHS}">Open Hub walkthroughs</a>`);
    expect(hrefs(html)).toEqual([DEFAULT_WALKTHROUGHS]);
  });
  it("the walkthrough list starts each row in the Hub instead of the retired recorder",async()=>{
    vi.stubEnv("EGC_PORTAL_ORIGIN","");
    const html=renderToStaticMarkup(await WalkthroughsPage());
    expect(html).toContain(`href="${DEFAULT_WALKTHROUGHS}">Start in EGC Hub</a>`);
    expect(hrefs(html)).toEqual(["/customers/synthetic-contact-1",DEFAULT_WALKTHROUGHS]);
  });
  it("the recorder-link scan catches every way of building the retired route and spares the list page",()=>{
    for(const source of ['href={"/walkthroughs/" + contact.id}',"href={`/walkthroughs/${contact.id}`}","href={`${origin}/walkthroughs/${id}`}",'href="/walkthroughs/abc"',"href={'/walkthroughs/abc'}"])expect(source).toMatch(RECORDER_LINK);
    for(const source of ['href="/walkthroughs"','href={"/customers/" + contact.id}','employeeHubUrl("walkthroughs")'])expect(source).not.toMatch(RECORDER_LINK);
  });
  it("no portal source captures audio, posts to the retired 409 endpoints or links to the recorder route",()=>{
    const root=fileURLToPath(new URL("..",import.meta.url));
    expect(existsSync(join(root,"app/walkthroughs/[contactId]/recorder.tsx"))).toBe(false);
    expect(existsSync(join(root,"app/api/walkthrough"))).toBe(false);
    const files:string[]=[];
    const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(/\.(tsx?|css)$/.test(entry.name))files.push(path);}};
    walk(join(root,"app"));walk(join(root,"lib"));
    expect(files.length).toBeGreaterThan(10);
    for(const file of files){
      const source=readFileSync(file,"utf8");
      expect(source,file).not.toMatch(/MediaRecorder|getUserMedia|mediaDevices/);
      expect(source,file).not.toMatch(/["'`]\/api\/walkthrough\b/);
      expect(source,file).not.toMatch(RECORDER_LINK);
    }
  });
});
