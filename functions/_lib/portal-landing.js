/* Where a verified private portal link lands. The link names its landing with
   `next`, an allow-list resolved at /api/customer-portal-session to a
   same-site path, never a URL: next=pay opens the portal payment card and
   next=invoice the portal with its View invoice link (M4) in focus when
   documents are on. Every landing is a portal page, never /api/money-document
   itself: a link opened from webmail is a cross-site navigation, and the 303
   chain stays cross-site, which that endpoint refuses; the portal's own link
   opens the document same-origin. Every {{payLink}} carries next=pay
   (message-links.js). */
import { moneyDocumentEnabled, moneyDocumentKinds } from './money-document.js';
import { moneyInvoiceStateEnabled } from './money-core.js';

export const PORTAL_HOME = '/customer-portal';
export const PORTAL_PAY = '/customer-portal#pay';
export const PORTAL_INVOICE = '/customer-portal#invoice';
export const PORTAL_NEXT = Object.freeze(['invoice', 'pay']);

/** Only allow-listed targets; anything else (or nothing) is the portal home. */
export function portalNext(value) {
  return typeof value === 'string' && PORTAL_NEXT.includes(value) ? value : '';
}

/**
 * Where a verified portal session lands. The portal's printable-invoice link
 * (M4) only when documents are on, the viewer may see the project and the
 * job's invoice is issued; otherwise the portal's payment card, which always
 * shows the balance.
 */
export function portalLanding(next, { env = {}, job = null, viewer = null, now } = {}) {
  const target = portalNext(next);
  if (!target) return PORTAL_HOME;
  if (target === 'invoice' && moneyDocumentEnabled(env) && viewer?.permissions?.view !== false) {
    try { if (moneyDocumentKinds(job, now, { invoiceState: moneyInvoiceStateEnabled(env) }).includes('invoice')) return PORTAL_INVOICE; } catch { /* unreadable money falls back to the payment card */ }
  }
  return PORTAL_PAY;
}
