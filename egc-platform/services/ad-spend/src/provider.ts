import type { SpendSource } from "./config.js";
import { validDate } from "./dates.js";

/** A provider or pull failure with a finite, loggable code. Provider bodies, URLs, headers
 * and exception text are never kept: they can echo tokens or account details. */
export class ProviderFailure extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); this.name = "ProviderFailure"; }
}
const CODE = /^[a-z][a-z0-9_]{2,60}$/;
export function failureCode(error: unknown): { code: string; httpStatus?: number } {
  if (error instanceof ProviderFailure && CODE.test(error.code))
    return { code: error.code, ...(Number.isInteger(error.httpStatus) && error.httpStatus! >= 400 && error.httpStatus! <= 599 ? { httpStatus: error.httpStatus! } : {}) };
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++, current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { code: "database_unavailable" };
  }
  return { code: "ad_spend_sync_failed" };
}

export interface DayTotal { spendCents: number; impressions: number | null; clicks: number | null }
export interface SpendRow {
  level: "ad_set" | "campaign"; campaignId: string; campaignName: string | null; adSetId: string | null; adSetName: string | null;
  reportDate: string; spendCents: number; impressions: number | null; clicks: number | null;
}
/** Totals are the account-level day totals (authoritative); rows are the campaign/ad set
 * breakdown. A report date absent from totals had no delivery, which the provider omits. */
export interface SpendReport { totals: Map<string, DayTotal>; rows: SpendRow[] }
export interface AccountInfo { timeZone: unknown; currency: unknown }
export interface DateRange { from: string; to: string }
export interface SpendProvider {
  source: SpendSource;
  account(accountId: string): Promise<AccountInfo>;
  spend(accountId: string, range: DateRange): Promise<SpendReport>;
}
export interface LeadForm { id: string; name: string | null }
export interface FormLead { id: string; createdAt: number }
export interface LeadgenProvider {
  leadForms(pageId: string): Promise<LeadForm[]>;
  formLeads(formId: string, since: number, until: number): Promise<FormLead[]>;
}

export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const providerId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
export const providerName = (value: unknown): string | null =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null : null;

/** One JSON exchange with a provider: no redirects, a hard timeout, and only the HTTP
 * status survives a failure. */
export async function providerJson(fetcher: typeof fetch, url: URL | string, init: RequestInit, prefix: "meta" | "google") {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) }); }
  catch (error) { throw new ProviderFailure((error as { name?: unknown } | null)?.name === "TimeoutError" ? `${prefix}_timeout` : `${prefix}_network_unavailable`); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new ProviderFailure(`${prefix}_malformed_response`, response.status); }
  return { status: response.status, ok: response.ok, body };
}

/** Independent validation of any provider's report before it can replace stored days. */
export function assertSpendReport(report: SpendReport, range: DateRange) {
  const inRange = (date: string) => validDate(date) && date >= range.from && date <= range.to;
  const int = (value: number | null, nullable: boolean) => (nullable && value === null) || (Number.isSafeInteger(value) && value! >= 0);
  if (!(report.totals instanceof Map) || !Array.isArray(report.rows)) throw new ProviderFailure("provider_report_invalid");
  for (const [date, total] of report.totals)
    if (!inRange(date) || !int(total.spendCents, false) || !int(total.impressions, true) || !int(total.clicks, true)) throw new ProviderFailure("provider_report_invalid");
  const keys = new Set<string>();
  for (const row of report.rows) {
    const key = `${row.reportDate}|${row.campaignId}|${row.adSetId ?? ""}`;
    if (!inRange(row.reportDate) || !providerId(row.campaignId) || (row.level === "ad_set") !== (row.adSetId !== null) || (row.adSetId !== null && !providerId(row.adSetId))
      || !["ad_set", "campaign"].includes(row.level) || !int(row.spendCents, false) || !int(row.impressions, true) || !int(row.clicks, true)) throw new ProviderFailure("provider_report_invalid");
    if (keys.has(key)) throw new ProviderFailure("provider_duplicate_row");
    keys.add(key);
  }
}
