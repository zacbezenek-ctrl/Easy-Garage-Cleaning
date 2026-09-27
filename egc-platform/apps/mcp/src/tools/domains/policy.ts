import * as z from "zod/v4";
import {accessStatement} from "../../oauth.js";
import {DIRECT_SEND_TOOLS,LEGACY_MUTATIONS_DISABLED,directSendsEnabled,operationsEnabled} from "../../operations.js";
import {defineTool,TOOL_CLASSES,type ToolDef} from "../define.js";

export const connectorMode=(registry:readonly ToolDef[])=>({operations:operationsEnabled(),directSends:directSendsEnabled(),moneyTools:registry.some(def=>def.policy.class==="money")});
const text=z.string();
const output=z.object({
  mode:z.enum(["action_center","legacy"]),
  access:z.object({read:text,write:text,sends:text,approvals:text,payments:text}).strict(),
  customerSends:z.object({oneStepMcpSends:z.enum(["blocked","enabled"]),tools:z.array(text),alternative:text.optional()}).strict(),
  legacyWritesDisabled:z.array(text),
  registry:z.array(z.object({name:text,class:z.enum(TOOL_CLASSES),scope:text,requestIdRequired:z.boolean(),twoStep:z.boolean(),ownerOnly:z.boolean()}).strict())
}).strict();

export function safetyPolicyTool(registry:()=>readonly ToolDef[]){
  return defineTool({
    name:"egc.safety_policy",class:"read",output,
    description:"Read what this connector may do right now before attempting a write: whether customer messages can be sent from MCP, which legacy writes are disabled, and which registered tools need egc:write, a requestId or a two-step preview and confirmation. Returns no customer data and changes nothing.",
    input:z.object({}).strict(),
    handler(){
      const mode=connectorMode(registry()),blockedSends=mode.operations&&!mode.directSends;
      return {mode:mode.operations?"action_center":"legacy",access:accessStatement(mode),
        customerSends:{oneStepMcpSends:blockedSends?"blocked":"enabled",tools:[...DIRECT_SEND_TOOLS],...(blockedSends?{alternative:"actions.propose (kind followup_message) queues the exact draft for owner or manager approval in the Employee Hub; approval does not send, and no send path for approved drafts (Employee Hub one-tap send or MCP two-step confirmation) is enabled on this server yet"}:{})},
        legacyWritesDisabled:mode.operations?[...LEGACY_MUTATIONS_DISABLED]:[],
        registry:registry().map(def=>({name:def.name,class:def.policy.class,scope:def.policy.scope,requestIdRequired:def.policy.requiresRequestId,twoStep:def.policy.twoStep,ownerOnly:def.policy.ownerOnly}))};
    }
  });
}
