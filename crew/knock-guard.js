/* GUARD-SELL: Garage Guard at the door. More > Sell Garage Guard opens a short pitch and the shared sales sheet
   (crew/guard-sell.js, channel 'knock'); a sale card in My sales offers it pre-filled with that customer
   (app.sellGuard, knock-sale.js). The rep picks the plan, the customer scans the code and pays on their own phone, and
   the server records the rep as the seller. No commission is paid for Garage Guard, so nothing here shows an amount
   for the rep. The sheet needs a connection (it opens a Stripe checkout); offline it says so. */
import { h, emptyState, toast } from './knock-ui.js';

// The same versioned file the crew pages load (crew/postjob.html, crew/gameplan.html); it sets globalThis.EGCGuardSell.
const TOOL = './guard-sell.js?v=20261030guard1';
let app, loading = null;

const tool = () => loading ||= import(TOOL).then(() => {
  if (!globalThis.EGCGuardSell) throw new Error('The Garage Guard sheet did not load.');
  return globalThis.EGCGuardSell;
}).catch(error => { loading = null; throw error; });

/** Open the sales sheet: customer {name, email, address} and the Hub job id pre-fill it when known. */
export async function sellGuard(customer = {}, { jobId = '', customerId = '' } = {}) {
  try { (await tool()).open({ channel: 'knock', jobId, customerId, customer }); }
  catch { toast('Garage Guard needs a connection. Try again with signal.', { tone: 'error' }); }
}

function guardScreen() {
  return h('div', { class: 'screen' },
    emptyState('shield', 'Garage Guard', 'Yearly maintenance memberships: Guard Black, Garage Guard and Guard Lite. Open at the top and step down. The customer scans a code and pays on their own phone.',
      h('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', onclick: () => sellGuard() }, 'Show the plans')),
    h('p', { class: 'caption muted center' }, 'Plans and prices come from the office. Nothing is charged until the customer pays on the Stripe page.'));
}

export function install(appApi) {
  app = appApi;
  app.sellGuard = sellGuard;
  app.registerScreen('guard', guardScreen, { title: 'Garage Guard', back: 'more' });
  app.moreLinks.push({ route: 'guard', label: 'Sell Garage Guard', icon: 'shield', order: 25, hint: 'Show the customer a sign-up code' });
}
