import * as z from "zod/v4";

/** Owner-only ad spend commands (FUN-15). Manual entries cover channels without an API;
 * Meta and Google spend is ingested read-only by the worker and can never be typed in. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const plain = (max:number) => z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),"Control characters are not allowed");
// Also Meta and Google spend under another name (facebook_ads, fb_boosts, instagram, youtube, adwords):
// the same pattern as @egc/ad-spend API_CHANNEL_ALIAS and the spend_entries_channel_ck check.
const API_CHANNEL_ALIAS = /(^|_)(facebook|fb|instagram|insta|ig|meta|google|googleads|adwords|gads|youtube|yt)(ads?)?(_|$)|^(facebook|instagram|google|adwords|youtube)/;
const channel = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).refine(value=>!["meta_ads","google_ads"].includes(value)&&!API_CHANNEL_ALIAS.test(value),"Meta and Google spend is ingested from the platform APIs");
const entry = z.object({channel,description:plain(500),amountCents:z.number().int().min(0).max(2_000_000_000),currency:z.literal("USD").default("USD"),
  firstDate:date,lastDate:date,receiptReference:plain(500)}).strict().refine(value=>value.firstDate<=value.lastDate,"The period must end on or after its first day");
const page = {offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(200).default(50)};
export const SPEND_COMMANDS = {
  "spend.entry.record": z.object({command:z.literal("spend.entry.record"),entry,supersedes:z.object({entryId:uuid,revision:z.number().int().positive()}).strict().optional()}).strict(),
  "spend.entry.void": z.object({command:z.literal("spend.entry.void"),entryId:uuid,revision:z.number().int().positive(),reason:plain(500).refine(value=>value.length>=3,"Give a reason")}).strict(),
  "spend.entries": z.object({command:z.literal("spend.entries"),from:date.optional(),to:date.optional(),channel:z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),status:z.enum(["active","all"]).default("active"),...page}).strict(),
  "spend.coverage": z.object({command:z.literal("spend.coverage"),from:date,to:date}).strict()
} as const;
export const SPEND_WRITE_COMMANDS:readonly string[] = Object.freeze(["spend.entry.record","spend.entry.void"]);
export const isSpendCommand = (name:unknown):name is keyof typeof SPEND_COMMANDS => typeof name === "string" && Object.hasOwn(SPEND_COMMANDS,name);
/** Returns the denial code or null: a signed-in human owner only (never an integration). */
export function spendCommandDenial(actor:{kind:string;role:string}):string|null {
  return actor.kind==="human"&&actor.role==="owner"?null:"spend_owner_required";
}
