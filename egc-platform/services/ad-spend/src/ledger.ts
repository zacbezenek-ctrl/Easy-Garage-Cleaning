import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { API_SOURCES } from "./config.js";
import { addDays, daysBetween, validDate, zonedDate } from "./dates.js";

type Db = ReturnType<typeof getDb>;
export type Queryable = Pick<Db, "select" | "insert" | "update">;
export type SpendEntryRow = typeof schema.spendEntries.$inferSelect;
export interface SpendActor { id: string; role: string; kind: string; workspace: string }
export interface SpendEntryInput { channel: string; description: string; amountCents: number; currency?: "USD"; firstDate: string; lastDate: string; receiptReference: string }

export class SpendLedgerError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly details: Record<string, unknown> = {}) { super(code); this.name = "SpendLedgerError"; }
}
export const MAX_ENTRY_CENTS = 2_000_000_000;
/** Other names for spend the Meta and Google APIs already report (Facebook, Instagram, boosted
 * posts, YouTube, AdWords): a name word, or a name the channel starts with. Keep it identical
 * to the operations command schema, the spend_entries_channel_ck check and the Hub screen. */
export const API_CHANNEL_ALIAS = /(^|_)(facebook|fb|instagram|insta|ig|meta|google|googleads|adwords|gads|youtube|yt)(ads?)?(_|$)|^(facebook|instagram|google|adwords|youtube)/;
const CHANNEL = /^[a-z][a-z0-9_]{1,39}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Spend entries are business-confidential acquisition costs: owner only, as a human. */
export function requireSpendOwner(actor: SpendActor) {
  if (actor.kind !== "human" || actor.role !== "owner") throw new SpendLedgerError("spend_owner_required", 403);
}
/** The owner attests the channel, amount and period; the server owns identity and time.
 * API channels, under any of their other names, are ingested and can never be typed in,
 * so nothing is double counted once an API backfills the same days. */
export function validateSpendEntry(input: SpendEntryInput, now: Date) {
  if (typeof input.channel !== "string" || !CHANNEL.test(input.channel)) throw new SpendLedgerError("spend_channel_invalid");
  if ((API_SOURCES as readonly string[]).includes(input.channel) || API_CHANNEL_ALIAS.test(input.channel)) throw new SpendLedgerError("spend_channel_api_ingested", 400, { channel: input.channel });
  if (!text(input.description, 500)) throw new SpendLedgerError("spend_description_invalid");
  if (!text(input.receiptReference, 500)) throw new SpendLedgerError("spend_receipt_required");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0 || input.amountCents > MAX_ENTRY_CENTS) throw new SpendLedgerError("spend_amount_invalid");
  if ((input.currency ?? "USD") !== "USD") throw new SpendLedgerError("spend_currency_unsupported");
  const { firstDate, lastDate } = input, today = zonedDate(now);
  if (!validDate(firstDate) || !validDate(lastDate) || firstDate < "2020-01-01" || lastDate < firstDate || daysBetween(firstDate, lastDate) >= 366)
    throw new SpendLedgerError("spend_period_invalid");
  if (lastDate > addDays(today, 62)) throw new SpendLedgerError("spend_period_in_future");
  return { channel: input.channel, description: input.description.trim(), receiptReference: input.receiptReference.trim(), amountCents: input.amountCents, currency: "USD", firstDate, lastDate };
}
export function publicEntry(row: SpendEntryRow) {
  return { id: row.id, channel: row.channel, description: row.description, amountCents: row.amountCents, currency: row.currency,
    firstDate: row.firstDate, lastDate: row.lastDate, receiptReference: row.receiptReference, clockSource: row.clockSource,
    enteredBy: row.enteredBy, attestedAt: row.attestedAt.toISOString(), status: row.status, revision: row.revision,
    supersedesId: row.supersedesId, closedAt: row.closedAt?.toISOString() ?? null, closedBy: row.closedBy, closeReason: row.closeReason };
}
function databaseCode(error: unknown) {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++, current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
async function lockedEntry(tx: Queryable, actor: SpendActor, entryId: string, revision: number) {
  if (!UUID.test(entryId) || !Number.isSafeInteger(revision) || revision < 1) throw new SpendLedgerError("spend_entry_reference_invalid");
  const [row] = await tx.select().from(schema.spendEntries).where(and(eq(schema.spendEntries.id, entryId), eq(schema.spendEntries.workspaceId, actor.workspace))).for("update");
  if (!row) throw new SpendLedgerError("spend_entry_not_found", 404);
  if (row.status !== "active") throw new SpendLedgerError("spend_entry_closed", 409, { status: row.status, currentRevision: row.revision });
  if (row.revision !== revision) throw new SpendLedgerError("spend_entry_revision_conflict", 409, { currentRevision: row.revision });
  return row;
}
async function close(tx: Queryable, actor: SpendActor, row: SpendEntryRow, status: "voided" | "superseded", reason: string, now: Date) {
  const [closed] = await tx.update(schema.spendEntries).set({ status, revision: row.revision + 1, closedAt: now, closedBy: actor.id, closeReason: reason, updatedAt: now })
    .where(and(eq(schema.spendEntries.id, row.id), eq(schema.spendEntries.revision, row.revision), eq(schema.spendEntries.status, "active"))).returning();
  if (!closed) throw new SpendLedgerError("spend_entry_revision_conflict", 409);
  return closed;
}

/** Records one attested entry; with `supersedes` it atomically replaces an active entry
 * (the correction path), so the ledger never shows both or neither. Run inside the caller's
 * transaction together with its idempotency receipt. */
export async function recordSpendEntry(tx: Queryable, actor: SpendActor, input: { entry: SpendEntryInput; supersedes?: { entryId: string; revision: number } | undefined }, requestId: string, now: Date) {
  requireSpendOwner(actor);
  const entry = validateSpendEntry(input.entry, now);
  if (!UUID.test(requestId)) throw new SpendLedgerError("request_id_required");
  const previous = input.supersedes ? await lockedEntry(tx, actor, input.supersedes.entryId, input.supersedes.revision) : null;
  let row: SpendEntryRow | undefined;
  try {
    [row] = await tx.insert(schema.spendEntries).values({ workspaceId: actor.workspace, requestId: requestId.toLowerCase(), ...entry, clockSource: "attested",
      enteredBy: actor.id, attestedAt: now, status: "active", revision: 1, supersedesId: previous?.id ?? null, createdAt: now, updatedAt: now }).returning();
  } catch (error) {
    if (databaseCode(error) === "23505") throw new SpendLedgerError("spend_entry_request_conflict", 409);
    throw error;
  }
  if (!row) throw new SpendLedgerError("spend_entry_save_failed", 503);
  const superseded = previous ? await close(tx, actor, previous, "superseded", `Superseded by ${row.id}`, now) : null;
  return { ok: true, entry: publicEntry(row), superseded: superseded ? publicEntry(superseded) : null };
}
export async function voidSpendEntry(tx: Queryable, actor: SpendActor, input: { entryId: string; revision: number; reason: string }, now: Date) {
  requireSpendOwner(actor);
  if (!text(input.reason, 500) || input.reason.trim().length < 3) throw new SpendLedgerError("spend_void_reason_required");
  const row = await lockedEntry(tx, actor, input.entryId, input.revision);
  return { ok: true, entry: publicEntry(await close(tx, actor, row, "voided", input.reason.trim(), now)) };
}
/** Entries overlapping [from, to) (Denver dates, exclusive end), newest period first. */
export async function listSpendEntries(tx: Queryable, actor: SpendActor, input: { from?: string | undefined; to?: string | undefined; channel?: string | undefined; status?: "active" | "all"; offset?: number; limit?: number }) {
  requireSpendOwner(actor);
  const offset = input.offset ?? 0, limit = input.limit ?? 50, e = schema.spendEntries;
  if ((input.from && !validDate(input.from)) || (input.to && !validDate(input.to)) || (input.from && input.to && input.to <= input.from)
    || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new SpendLedgerError("spend_list_invalid");
  const where = and(eq(e.workspaceId, actor.workspace), input.status === "all" ? undefined : eq(e.status, "active"),
    input.from ? gte(e.lastDate, input.from) : undefined, input.to ? lt(e.firstDate, input.to) : undefined, input.channel ? eq(e.channel, input.channel) : undefined);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(e).where(where);
  const rows = await tx.select().from(e).where(where).orderBy(desc(e.firstDate), desc(e.createdAt), desc(e.id)).limit(limit).offset(offset);
  const total = count?.n ?? 0;
  return { ok: true, items: rows.map(publicEntry), total, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}
