import { adSpendConfig, CONFIG_CURSOR, publishedConfiguration, SOURCES, sourceAccounts, sourceActive, type AdSource, type AdSpendConfig } from "./config.js";
import { addDays, alignedWithDenver, dateRange, dayStart, DENVER, denverDateOf, maxDate, validTimeZone, zonedDate } from "./dates.js";
import { googleProvider } from "./google.js";
import { cursorKey } from "./health.js";
import { metaProvider } from "./meta.js";
import { leadgenRetentionFloor, planPulls, pullFloor, settledOn } from "./plan.js";
import { assertSpendReport, failureCode, ProviderFailure, type LeadgenProvider, type SpendProvider } from "./provider.js";
import { postgresAdSpendStore, type AdSpendStore } from "./store.js";

export interface AccountOutcome { accountId: string; ok: boolean; code?: string; httpStatus?: number; pulledDays: number; restatedDays: number; rows: number }
export interface SourceOutcome { source: AdSource; active: boolean; ok: boolean | null; accounts: AccountOutcome[] }
export interface SyncOptions {
  config?: AdSpendConfig; store?: AdSpendStore; fetcher?: typeof fetch; now?: () => Date; maxChunks?: number;
  providers?: { meta?: SpendProvider & LeadgenProvider; google?: SpendProvider };
}
interface Context { config: AdSpendConfig; store: AdSpendStore; now: () => Date; maxChunks: number }

/** Publishes the non-secret configuration (so coverage can tell "not connected" from
 * "not pulled"), without contacting any provider. The worker calls it even when off. */
export async function publishAdSpendConfiguration(config: AdSpendConfig = adSpendConfig(), store: AdSpendStore = postgresAdSpendStore(), now: () => Date = () => new Date()) {
  const at = now();
  await store.setCursor(CONFIG_CURSOR, JSON.stringify(publishedConfiguration(config, at)), at);
}

async function syncSpendAccount(provider: SpendProvider, accountId: string, c: Context): Promise<AccountOutcome> {
  const info = await provider.account(accountId);
  if (!validTimeZone(info.timeZone)) throw new ProviderFailure("invalid_account_time_zone");
  if (typeof info.currency !== "string" || !/^[A-Z]{3}$/.test(info.currency)) throw new ProviderFailure("invalid_account_currency");
  const timeZone = info.timeZone, currency = info.currency, today = zonedDate(c.now(), timeZone);
  const floor = pullFloor({ today, startDate: c.config.startDate, earliest: await c.store.earliestSyncDay(provider.source, accountId) });
  const chunks = planPulls({ today, floor, states: await c.store.syncStates(provider.source, accountId, floor, today), maxChunks: c.maxChunks });
  const outcome: AccountOutcome = { accountId, ok: true, pulledDays: 0, restatedDays: 0, rows: 0 };
  for (const chunk of chunks) {
    const report = await provider.spend(accountId, chunk);
    assertSpendReport(report, chunk);
    const days = dateRange(chunk.from, chunk.to).map(reportDate => ({ reportDate, denverDate: denverDateOf(reportDate, timeZone),
      timeZoneAligned: alignedWithDenver(reportDate, timeZone), settled: settledOn(reportDate, today) }));
    const result = await c.store.replaceSpend({ source: provider.source, accountId, timeZone, currency, days, report }, c.now());
    outcome.pulledDays += result.days; outcome.restatedDays += result.restatedDays; outcome.rows += result.rows;
  }
  return outcome;
}

async function syncLeadgenPage(provider: LeadgenProvider, pageId: string, c: Context): Promise<AccountOutcome> {
  const today = zonedDate(c.now(), DENVER);
  const floor = maxDate(pullFloor({ today, startDate: c.config.startDate, earliest: await c.store.earliestSyncDay("meta_leadgen", pageId) }), leadgenRetentionFloor(today))!;
  const chunks = planPulls({ today, floor, states: await c.store.syncStates("meta_leadgen", pageId, floor, today), maxChunks: c.maxChunks });
  const outcome: AccountOutcome = { accountId: pageId, ok: true, pulledDays: 0, restatedDays: 0, rows: 0 };
  if (!chunks.length) return outcome;
  const forms = await provider.leadForms(pageId);
  if (new Set(forms.map(form => form.id)).size !== forms.length) throw new ProviderFailure("provider_duplicate_row");
  for (const chunk of chunks) {
    // Lead creation times are instants, so Denver days are exact for every form.
    const since = dayStart(chunk.from, DENVER), until = dayStart(addDays(chunk.to, 1), DENVER), seen = new Set<string>();
    const perForm = [];
    for (const form of forms) {
      const byDate = new Map<string, string[]>();
      for (const lead of await provider.formLeads(form.id, since, until)) {
        if (seen.has(lead.id)) throw new ProviderFailure("provider_duplicate_row");
        seen.add(lead.id);
        const date = zonedDate(lead.createdAt, DENVER);
        byDate.set(date, [...(byDate.get(date) ?? []), lead.id]);
      }
      perForm.push({ formId: form.id, formName: form.name, byDate });
    }
    const days = dateRange(chunk.from, chunk.to).map(date => ({ reportDate: date, denverDate: date, timeZoneAligned: true, settled: settledOn(date, today) }));
    const result = await c.store.replaceLeadgen({ pageId, days, forms: perForm }, c.now());
    outcome.pulledDays += result.days; outcome.restatedDays += result.restatedDays; outcome.rows += result.rows;
  }
  return outcome;
}

/** One pass over every active source and account. Each chunk of days is fetched in full and
 * then replaces the stored days in one transaction, so a failure never leaves a half pull.
 * Health goes to sync_cursors with finite codes only. Nothing is ever written to a provider. */
export async function syncAdSpend(options: SyncOptions = {}) {
  const config = options.config ?? adSpendConfig(), store = options.store ?? postgresAdSpendStore(), fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date()), c: Context = { config, store, now, maxChunks: options.maxChunks ?? 6 };
  const startedAt = now();
  await publishAdSpendConfiguration(config, store, () => startedAt);
  const meta = options.providers?.meta ?? metaProvider(config, fetcher), google = options.providers?.google ?? googleProvider(config, fetcher);
  const sources: SourceOutcome[] = [];
  for (const source of SOURCES) {
    if (!sourceActive(config, source)) { sources.push({ source, active: false, ok: null, accounts: [] }); continue; }
    const attempt = now();
    await store.setCursor(cursorKey(source, "last_attempt"), attempt.toISOString(), attempt);
    const accounts: AccountOutcome[] = [];
    for (const accountId of sourceAccounts(config, source)) {
      try { accounts.push(source === "meta_leadgen" ? await syncLeadgenPage(meta, accountId, c) : await syncSpendAccount(source === "google_ads" ? google : meta, accountId, c)); }
      catch (error) { accounts.push({ accountId, ok: false, ...failureCode(error), pulledDays: 0, restatedDays: 0, rows: 0 }); }
    }
    const finished = now(), ok = accounts.every(account => account.ok), failed = accounts.find(account => !account.ok);
    await store.setCursor(cursorKey(source, "last_run"), JSON.stringify({ at: finished.toISOString(), accounts }), finished);
    if (ok) await store.setCursor(cursorKey(source, "last_success"), finished.toISOString(), finished);
    else await store.setCursor(cursorKey(source, "last_failure"), JSON.stringify({ at: finished.toISOString(), code: failed!.code, accountId: failed!.accountId,
      ...(failed!.httpStatus ? { httpStatus: failed!.httpStatus } : {}) }), finished);
    sources.push({ source, active: true, ok, accounts });
  }
  return { startedAt: startedAt.toISOString(), sources };
}
