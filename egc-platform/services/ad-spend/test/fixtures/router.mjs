/** Recorded-fixture transport for the ad spend tests. It answers only the exact provider
 * requests the ingestion makes (rows filtered to the requested dates, as the APIs do) and
 * throws on anything else, so no test can reach a network. */
import {readFileSync} from 'node:fs';

const load = name => JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
export const META = load('meta'), GOOGLE = load('google');
export const IDS = {metaAccount: '1234567890', page: '555000111', googleCustomer: '1234567890', loginCustomer: '9876543210'};
export const SECRETS = {meta: 'synthetic-meta-system-user-token-0123456789', developer: 'synthetic-developer-token-0123', clientSecret: 'synthetic-client-secret-0123', refresh: 'synthetic-refresh-token-0123456789'};
export const ENABLED_ENV = Object.freeze({
  EGC_AD_SPEND_META_ENABLED: 'true', META_ADS_ACCESS_TOKEN: SECRETS.meta, META_ADS_ACCOUNT_IDS: `act_${IDS.metaAccount}`, META_LEADGEN_PAGE_IDS: IDS.page,
  EGC_AD_SPEND_GOOGLE_ENABLED: 'true', GOOGLE_ADS_DEVELOPER_TOKEN: SECRETS.developer, GOOGLE_ADS_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: SECRETS.clientSecret, GOOGLE_ADS_REFRESH_TOKEN: SECRETS.refresh, GOOGLE_ADS_CUSTOMER_IDS: '123-456-7890', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '987-654-3210'
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

export function fixtureFetcher({meta = META, google = GOOGLE, override} = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null;
    const call = {url: url.toString(), host: url.host, path: url.pathname, params: Object.fromEntries(url.searchParams), method,
      headers: Object.fromEntries(new Headers(init.headers)), body, redirect: init.redirect, signal: Boolean(init.signal)};
    calls.push(call);
    if (override) { const replaced = await override(call); if (replaced) return replaced; }
    if (url.host === 'graph.facebook.com' && method === 'GET') {
      const [, node, edge] = url.pathname.split('/').filter(Boolean);
      if (node === `act_${IDS.metaAccount}` && !edge) return json(meta.account);
      if (node === `act_${IDS.metaAccount}` && edge === 'insights') {
        const range = JSON.parse(url.searchParams.get('time_range')), within = rows => rows.filter(r => r.date_start >= range.since && r.date_start <= range.until);
        if (url.searchParams.get('level') === 'account') return json({...meta.insightsAccount, data: within(meta.insightsAccount.data)});
        const pages = meta.insightsAdSetPages, after = url.searchParams.get('after');
        const index = after ? pages.findIndex((_, i) => i > 0 && pages[i - 1].paging.cursors.after === after) : 0;
        if (index < 0) throw new Error('Unexpected Meta paging cursor in test');
        return json({...pages[index], data: within(pages[index].data)});
      }
      if (node === IDS.page && edge === 'leadgen_forms') return json(meta.leadgenForms);
      if (edge === 'leads' && meta.leads[node]) return json(meta.leads[node]);
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') return json(google.token);
    const search = /^\/v\d+\/customers\/(\d{10})\/googleAds:searchStream$/.exec(url.pathname);
    if (url.host === 'googleads.googleapis.com' && method === 'POST' && search?.[1] === IDS.googleCustomer) {
      const query = JSON.parse(body).query, between = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(query);
      const within = batches => batches.map(batch => ({...batch, results: (batch.results ?? []).filter(r => !between || (r.segments.date >= between[1] && r.segments.date <= between[2]))}));
      if (/FROM customer$/.test(query)) return json(google.customer);
      if (/FROM customer WHERE/.test(query)) return json(within(google.totals));
      if (/FROM campaign WHERE/.test(query)) return json(within(google.campaigns));
      if (/FROM ad_group WHERE/.test(query)) return json(within(google.adGroups));
    }
    throw new Error(`Unexpected external request in test: ${method} ${url.host}${url.pathname}`);
  };
  return {fetcher, calls};
}
export {json as jsonResponse};
