import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  conversionStatus,
  previewConversions,
  retryConversions,
  sendTestEvent,
  syncConversions
} from "@egc/meta-conversions";
import { oauthSecurityMetadata, READ_SCOPE, WRITE_SCOPE } from "./oauth.js";

// The HTTP authorization middleware consumes this same list: metadata alone
// does not enforce write authorization.
export const META_CONVERSION_WRITE_TOOLS = [
  "meta.conversions.sync",
  "meta.conversions.retry",
  "meta.conversions.test"
] as const;

const readMetadata = {
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  ...oauthSecurityMetadata([READ_SCOPE])
};

const writeMetadata = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ...oauthSecurityMetadata([READ_SCOPE, WRITE_SCOPE])
};

const rangeFields = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).default(100)
};

type RangeInput = {
  days?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  dryRun?: boolean | undefined;
  eventIds?: string[] | undefined;
};

function options(input: RangeInput) {
  return {
    ...(input.days !== undefined ? { days: input.days } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.eventIds !== undefined ? { eventIds: input.eventIds } : {})
  };
}

function validRange(input: RangeInput) {
  return !input.from || !input.to || Date.parse(input.from) <= Date.parse(input.to);
}

async function result(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      structuredContent: { result: value }
    };
  } catch {
    // Provider exceptions may contain authorization headers or customer data.
    // Never return or log them at the MCP boundary.
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Meta conversion operation failed. Check meta.conversions.status for sanitized diagnostics." }],
      structuredContent: { result: { error: "meta_conversion_operation_failed" } }
    };
  }
}

export function registerMetaConversionTools(server: McpServer) {
  server.registerTool("meta.conversions.preview", {
    description: "Read-only preview of configured canonical customer conversion stages including qualified leads, walkthrough commitments/completion, quotes, sold/completed jobs and collected revenue. Shows stable IDs, attribution eligibility, missing value and evidence blockers. Does not send events or write the ledger.",
    inputSchema: z.object({ ...rangeFields, days: z.number().int().min(1).max(90).default(7) })
      .refine(validRange, { message: "from must be before or equal to to" }),
    ...readMetadata
  }, async (input) => result(() => previewConversions(options(input))));

  server.registerTool("meta.conversions.sync", {
    description: "Reconcile and safely send eligible unsynced canonical Meta conversions using durable idempotency. Defaults to dryRun=true. Production sends require verified server configuration. An operator-configured historical reconciliation boundary is honored without relaxing Meta event age, original timestamp or existing accepted-ID protections.",
    inputSchema: z.object({
      ...rangeFields,
      days: z.number().int().min(1).max(7).default(7),
      dryRun: z.boolean().default(true)
    }).refine(validRange, { message: "from must be before or equal to to" }),
    ...writeMetadata
  }, async (input) => result(() => syncConversions(options(input))));

  server.registerTool("meta.conversions.status", {
    description: "Report Meta conversion configuration readiness, last synchronization, pending and failed events, recent accepted events, attribution and matching health, and Meta lead conversion rates. No customer matching values or credentials are returned.",
    inputSchema: z.object({ ...rangeFields, days: z.number().int().min(1).max(90).default(30) })
      .refine(validRange, { message: "from must be before or equal to to" }),
    ...readMetadata
  }, async (input) => result(() => conversionStatus(options(input))));

  server.registerTool("meta.conversions.retry", {
    description: "Safely retry failed Meta conversions with their original deterministic event IDs. Accepted events cannot be resent. Defaults to dryRun=true; event age, verified destination, and activation safeguards remain enforced. Optionally select up to 100 internal event IDs.",
    inputSchema: z.object({
      ...rangeFields,
      days: z.number().int().min(1).max(7).default(7),
      dryRun: z.boolean().default(true),
      eventIds: z.array(z.string().regex(/^egc_[a-f0-9]{64}$/)).min(1).max(100).optional()
    }).refine(validRange, { message: "from must be before or equal to to" }),
    ...writeMetadata
  }, async (input) => result(() => retryConversions(options(input))));

  server.registerTool("meta.conversions.test", {
    description: "Send synthetic Meta Test Events diagnostics for walkthrough-booked and job-won stages using only server-side configuration and META_CAPI_TEST_EVENT_CODE. Requires a verified dataset and a configured test code. Does not send real customer information or enable production syncing.",
    inputSchema: z.object({}).strict(),
    ...writeMetadata,
    annotations: { ...writeMetadata.annotations, idempotentHint: false }
  }, async () => result(() => sendTestEvent()));
}
