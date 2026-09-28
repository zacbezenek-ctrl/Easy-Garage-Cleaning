import type {McpServer} from "@modelcontextprotocol/server";
import {registerTools,type RegisterOptions,type ToolDef} from "./define.js";
import {safetyPolicyTool} from "./domains/policy.js";
import {crmReadTools} from "./domains/crm-reads.js";
import {followupTools} from "./domains/followups.js";

// Domain modules live under ./domains/ and add their defineTool() definitions here, one per line.
export const DOMAIN_TOOLS:readonly ToolDef[]=[
  safetyPolicyTool(()=>DOMAIN_TOOLS),
  ...crmReadTools(),
  ...followupTools()
];
/** Write enforcement is by name at the HTTP boundary; this set is derived from each definition's class. */
export const REGISTRY_WRITE_TOOLS:ReadonlySet<string>=new Set(DOMAIN_TOOLS.filter(def=>!def.policy.readOnly).map(def=>def.name));
export function registerDomainTools(server:McpServer,options:RegisterOptions={}){return registerTools(server,DOMAIN_TOOLS,options);}
