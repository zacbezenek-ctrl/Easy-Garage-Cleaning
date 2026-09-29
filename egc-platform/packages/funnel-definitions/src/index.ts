import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hubDefinitionsHash, hubDefinitionsVersion } from "./generated.js";

// FUN-01: the platform copy of the funnel definitions the Hub owns
// (functions/_data/funnel-definitions.data.json). The JSON beside this package
// is a byte-identical copy written by `node scripts/funnel-definitions.mjs --write`
// at the repo root; the root drift check fails when the two differ. Read the
// lists (GHL exclusion tags, reason codes, calendar, cycle rules) from here and
// never hard-code them. When the Hub and the platform report different
// definitionsHash values, joined metrics must be `unknown` with reason
// `definitions_mismatch`.

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type FunnelEventType = {
  readonly group: string;
  readonly entity: readonly string[];
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly reasons?: string;
};
export type FunnelDefinitions = {
  readonly schemaVersion: 1;
  readonly definitionsVersion: string;
  readonly timeZone: "America/Denver";
  readonly eligibility: {
    readonly hub: { readonly privateIdPrefixes: readonly string[]; readonly testFlags: readonly string[]; readonly internalFlag: string; readonly internalReasonField: string; readonly internalReasons: readonly string[] };
    readonly ghl: { readonly tagFolding: string; readonly exclusionTags: Readonly<Record<string, string>>; readonly exclusionFlags: Readonly<Record<string, string>>; readonly syntheticSources: readonly string[]; readonly hiringCalendarIds: readonly string[] };
    readonly stripe: { readonly requireLivemode: boolean; readonly testIdPrefixes: readonly string[] };
    readonly exclusionClasses: Readonly<Record<string, "never" | "test" | "internal" | "excluded">>;
  };
  readonly vocabularies: Readonly<Record<string, readonly string[]>>;
  readonly reasonCodes: Readonly<Record<"walkthroughOutcome" | "lost" | "cancel" | "reschedule" | "noShow" | "balanceReopened", readonly string[]>>;
  readonly calendar: { readonly [key: string]: JsonValue };
  readonly cycles: { readonly repeatWindowDays: number; readonly expiredAfterDaysWithoutEvent: number; readonly stalledAfterDaysWithoutEvent: number; readonly [key: string]: JsonValue };
  readonly metricWindows: Readonly<Record<string, number>>;
  readonly eventIntegrity: { readonly cutoverDate: string | null; readonly [key: string]: JsonValue };
  readonly eventTypes: Readonly<Record<string, FunnelEventType>>;
  readonly [key: string]: JsonValue | object;
};

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Canonical JSON exactly as the Hub computes it: keys sorted by UTF-16 code unit, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const hashDefinitions = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

export const definitionsText = readFileSync(new URL("../funnel-definitions.data.json", import.meta.url), "utf8");
export const definitions = deepFreeze(JSON.parse(definitionsText)) as FunnelDefinitions;
/** sha256 of the canonical definitions; equals the Hub's definitionsHash() for the same file. */
export const definitionsHash = hashDefinitions(definitions);
export { hubDefinitionsHash, hubDefinitionsVersion };

/** True when the loaded copy is the one the Hub hashed at generation time. */
export const definitionsVerified = definitionsHash === hubDefinitionsHash && definitions.definitionsVersion === hubDefinitionsVersion;

/**
 * A GHL tag or source folded exactly as the Hub folds it (eligibility.ghl.tagFolding):
 * lowercase, each run of spaces, underscores and hyphens one hyphen, none at the ends.
 * Match folded contact tags against eligibility.ghl.exclusionTags, and treat a contact
 * whose exclusionFlags field is `true` (dnd, doNotContact, isVendor, ...) the same way.
 */
export const ghlTagKey = (value: unknown): string => typeof value === "string" ? value.toLowerCase().replace(/[\s_-]+/g, "-").replace(/^-|-$/g, "") : "";

/** Joined Hub + platform metrics are comparable only when both sides report the same hash. */
export const sameDefinitions = (hubHash: unknown): boolean => typeof hubHash === "string" && /^[0-9a-f]{64}$/.test(hubHash) && hubHash === definitionsHash;
