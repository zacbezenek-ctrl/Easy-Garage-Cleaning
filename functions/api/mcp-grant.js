import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { grantDisplayText, issueMcpGrant, mcpGrantConfiguration, MCP_GRANT_NONCE, MCP_GRANT_SCOPES } from '../_lib/mcp-grant-assertion.js';

// The MCP authorization page sends the owner or manager here. The Hub session cookie is
// SameSite=Strict, so the cross-site arrival (GET) only renders the approval form; the
// approval itself is a same-origin form POST that carries the cookie. The approval page uses
// Referrer-Policy same-origin because under no-referrer a browser sends that POST with
// `Origin: null`; nothing is sent to another origin either way. Every other page sends none.
// The client name arrives in the link, so anyone can put any text there: the page labels it as
// unverified. Approving a doctored link connects nothing (the MCP checks the signed name and access).
const BODY_LIMIT = 4096;
const SAFE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' };
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const STYLE = `body{font-family:Inter,system-ui,sans-serif;background:#f5f5f3;color:#151515;margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}main{width:min(440px,100%);box-sizing:border-box;background:#fff;border:1px solid #deded8;border-radius:20px;padding:24px;overflow-wrap:anywhere}h1{margin:0 0 8px;font-size:24px}p{color:#555;line-height:1.5}.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:10px}button{width:100%;min-height:48px;margin-top:16px;padding:12px;border:0;border-radius:11px;background:#111;color:#fff;font:inherit;font-size:16px;font-weight:800;cursor:pointer}a{display:inline-flex;align-items:center;min-height:44px;color:#111;font-weight:700}small{display:block;color:#777;margin-top:14px}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const html = (status, body, { csp = PAGE_CSP, referrer = 'no-referrer' } = {}) => new Response(body, { status, headers: { ...SAFE, 'Referrer-Policy': referrer, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
const shell = (title, content, referrer = 'no-referrer') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="${referrer}"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${content}</main></body></html>`;
const message = (title, text) => shell(title, `<h1>${escape(title)}</h1><p class="error" role="alert">${escape(text)}</p>`);

function requestDetails(params) {
  const scopes = new Set(String(params.get('scope') || '').split(/\s+/));
  return { client: grantDisplayText(params.get('client')), write: scopes.has('egc:write') };
}

function approvalPage({ grant, client, write, mcpHost, error = '' }) {
  return shell('Connect an AI assistant', `<h1>Connect an AI assistant</h1>
<p>An AI assistant wants to connect to Easy Garage Cleaning as you.</p>
${client ? `<p>Name in this approval link (not verified by the Hub): <strong>${escape(client)}</strong>. The connection completes only in the browser that started it, and only if this name and access match that request.</p>\n` : ''}<p>It will be able to read customer records, jobs, messages and schedules${write ? ', and make the changes listed on the connector page you just saw (only owners and managers can allow changes)' : ''}.</p>
<p>Only approve if you just started this connection yourself. It connects to ${escape(mcpHost)}.</p>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/api/mcp-grant">
<input type="hidden" name="grant" value="${escape(grant)}">
<input type="hidden" name="client" value="${escape(client)}">
<input type="hidden" name="scope" value="${MCP_GRANT_SCOPES[write ? 1 : 0]}">
<button type="submit">Approve connection</button>
</form>
<p><a href="/employee" target="_blank" rel="noopener noreferrer">Sign in to the Employee Hub</a></p>
<small>Not signed in? Sign in in this browser (the link opens a new tab), then come back to this tab and approve. To cancel, close this tab.</small>`, 'same-origin');
}
const approval = (status, details) => html(status, approvalPage(details), { referrer: 'same-origin' });

function relayPage(issued, nonce) {
  return shell('Finishing connection', `<h1>Approved</h1>
<p>Finishing the connection for ${escape(issued.hubUser)}…</p>
<form method="post" action="${escape(issued.callback)}">
<input type="hidden" name="grant" value="${escape(issued.grant)}">
<input type="hidden" name="assertion" value="${escape(issued.assertion)}">
<noscript><button type="submit">Finish connecting</button></noscript>
</form>
<script nonce="${nonce}">document.forms[0].submit()</script>`);
}

/**
 * A form POST always sends Origin, and it must be this Hub. A browser whose referrer settings
 * are stricter than the page's sends `Origin: null`; that counts only when the browser itself
 * marks the request same-origin (Sec-Fetch-Site cannot be set by a page).
 */
function sameOriginForm(request) {
  const origin = request.headers.get('Origin'), site = request.headers.get('Sec-Fetch-Site'), self = new URL(request.url).origin;
  return site ? site === 'same-origin' && (origin === self || origin === 'null') : origin === self;
}

export function mcpGrantHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date() } = {}) {
  async function get({ request, env }) {
    const config = mcpGrantConfiguration(env);
    if (!config.configured) return html(503, message('Connections are off', 'AI assistant connections are not set up on this Hub yet.'));
    const params = new URL(request.url).searchParams;
    const grant = params.get('grant') || '';
    if (!MCP_GRANT_NONCE.test(grant)) return html(400, message('Connection request invalid', 'This connection link is incomplete. Start again from your AI assistant.'));
    return approval(200, { grant, ...requestDetails(params), mcpHost: new URL(config.origin).host });
  }

  async function post({ request, env }) {
    if (!sameOriginForm(request)) return html(403, message('Approval blocked', 'Open this approval from the link your AI assistant gave you, then approve on that page.'));
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return html(415, message('Approval blocked', 'This approval was not sent from the approval page.'));
    if (Number(request.headers.get('Content-Length') || 0) > BODY_LIMIT) return html(413, message('Approval blocked', 'This approval request is too large.'));
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > BODY_LIMIT) return html(413, message('Approval blocked', 'This approval request is too large.'));
    const form = new URLSearchParams(raw), details = requestDetails(form), grant = form.get('grant') || '';
    const config = mcpGrantConfiguration(env);
    let issued;
    try {
      issued = await issueMcpGrant(env, storage(env), await session(request, env), { grant, client: details.client, scope: MCP_GRANT_SCOPES[details.write ? 1 : 0] }, now().toISOString());
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('mcp_grant_');
      const status = known ? error.status : 503;
      const text = known ? error.message : 'The approval could not be completed. Nothing was connected. Start again from your AI assistant.';
      if (status === 401 && config.configured && MCP_GRANT_NONCE.test(grant)) return approval(401, { grant, ...details, mcpHost: new URL(config.origin).host, error: text });
      return html(status, message('Connection not approved', text));
    }
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    // No form-action: the MCP callback answers with a redirect to the AI client's own callback,
    // and browsers apply form-action to redirects after a form POST. The action is a fixed server URL.
    return html(200, relayPage(issued, nonce), { csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'` });
  }

  return { get, post };
}

const handlers = mcpGrantHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
