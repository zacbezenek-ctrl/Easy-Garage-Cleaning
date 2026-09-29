import type { AdSource, PublishedConfiguration } from "./config.js";

export const CURSOR_SUFFIXES = ["last_attempt", "last_success", "last_failure", "last_run"] as const;
export type CursorSuffix = typeof CURSOR_SUFFIXES[number];
export const cursorKey = (source: AdSource, suffix: CursorSuffix) => `ad_spend:${source}:${suffix}`;
export const HEALTH_STALE_MS = 3 * 3_600_000;
const CODE = /^[a-z][a-z0-9_]{2,60}$/, ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const json = (value: string | undefined) => { try { return value === undefined ? null : JSON.parse(value) as unknown; } catch { return null; } };
const status = (value: unknown) => Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599 ? Number(value) : undefined;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/** Only finite codes, ids, counts and instants are read back from the health cursors. */
function failure(value: unknown) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null, at = instant(row?.at);
  if (!row || !at) return null;
  const httpStatus = status(row.httpStatus);
  return { at, code: typeof row.code === "string" && CODE.test(row.code) ? row.code : "ad_spend_sync_failed",
    accountId: typeof row.accountId === "string" && ACCOUNT.test(row.accountId) ? row.accountId : null, ...(httpStatus ? { httpStatus } : {}) };
}
function run(value: unknown) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null, at = instant(row?.at);
  if (!row || !at || !Array.isArray(row.accounts)) return null;
  return { at, accounts: row.accounts.slice(0, 50).flatMap(item => {
    const a = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!a || typeof a.accountId !== "string" || !ACCOUNT.test(a.accountId) || typeof a.ok !== "boolean") return [];
    const httpStatus = status(a.httpStatus);
    return [{ accountId: a.accountId, ok: a.ok, ...(a.ok ? {} : { code: typeof a.code === "string" && CODE.test(a.code) ? a.code : "ad_spend_sync_failed" }),
      ...(httpStatus ? { httpStatus } : {}), pulledDays: count(a.pulledDays), restatedDays: count(a.restatedDays) }];
  }) };
}
export type SourceHealth = ReturnType<typeof sourceHealth>;
export function sourceHealth(source: AdSource, configuration: PublishedConfiguration | null, cursors: ReadonlyMap<string, string>, now: Date) {
  const publication = configuration?.sources[source] ?? null;
  const lastAttemptAt = instant(cursors.get(cursorKey(source, "last_attempt"))), lastSuccessAt = instant(cursors.get(cursorKey(source, "last_success")));
  const lastFailure = failure(json(cursors.get(cursorKey(source, "last_failure")))), lastRun = run(json(cursors.get(cursorKey(source, "last_run"))));
  const state = !publication?.active ? "not_connected"
    : lastFailure && (!lastSuccessAt || lastFailure.at > lastSuccessAt) ? "failing"
    : !lastSuccessAt ? "never_synced"
    : now.valueOf() - Date.parse(lastSuccessAt) > HEALTH_STALE_MS ? "stale" : "healthy";
  return { source, status: state, active: publication?.active ?? false, blockers: publication ? publication.blockers : ["worker_configuration_missing"],
    accountIds: publication?.accountIds ?? [], lastAttemptAt, lastSuccessAt, lastFailure, lastRun,
    configurationPublishedAt: configuration?.publishedAt ?? null };
}
