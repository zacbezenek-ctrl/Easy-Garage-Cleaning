"""Server customer actions (FUN-36) in the browser: flag gating, classed credits, gift-card sales,
decision prompts, rebooking follow-ups, retry-safe saves and phone layout, against DTOs built by the real service."""
import copy, json, os, pathlib, re, subprocess, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
# 23:30 on 2026-09-22 in Denver, already 2026-09-23 in Tokyo and UTC.
CLOCK = '2026-09-23T05:30:00Z'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
VIEWS = r'''
import { readLifecycle } from './functions/_lib/customer-lifecycle.js';
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
const base = { type: 'job', customerId: 'c1', customer: 'Synthetic Customer', status: 'scheduled' };
const rows = {
  'job-root': { ...base, giftWallet: { cards: [{ id: 'credit-legacy', label: 'EGC service credit', issuedAmount: 40, remainingAmount: 15.5 }, { id: 'credit-gg', label: 'Garage Guard credit', creditClass: 'garage_guard', issuedAmount: 75, issuedAmountCents: 7500, remainingAmount: 75 }] },
    garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, membershipId: 'sub_SyntheticMember1', source: 'stripe' },
    customerDecisions: [{ id: 'decision-old', title: 'Haul the old freezer?', priceDelta: 40, status: 'approved' }] },
  // No membership; managers gave $60 courtesy (plus $90 before the 30-day window) and recorded a $950 sale; the owner's $200 never counts.
  'job-limits': { ...base, customerId: 'c2', customer: 'Synthetic Limits', giftWallet: { cards: [
    { id: 'credit-m1', label: 'Courtesy credit', creditClass: 'courtesy', issuedAmount: 60, issuedAmountCents: 6000, remainingAmount: 60, issuedAt: '2026-09-10T18:00:00.000Z', issuedBy: 'tylerg', issuedByOwner: false },
    { id: 'credit-m0', label: 'Courtesy credit', creditClass: 'courtesy', issuedAmount: 90, issuedAmountCents: 9000, remainingAmount: 0, issuedAt: '2026-08-01T18:00:00.000Z', issuedBy: 'tylerg', issuedByOwner: false },
    { id: 'credit-o1', label: 'Courtesy credit', creditClass: 'courtesy', issuedAmount: 200, issuedAmountCents: 20000, remainingAmount: 200, issuedAt: '2026-09-20T18:00:00.000Z', issuedBy: 'zacb', issuedByOwner: true },
    { id: 'giftcard-m2', label: 'EGC gift card', creditClass: 'gift_purchase', issuedAmount: 950, issuedAmountCents: 95000, remainingAmount: 950, issuedAt: '2026-09-21T18:00:00.000Z', issuedBy: 'tylerg', issuedByOwner: false, saleId: 'm2' }] } },
  // A membership typed into the Hub's Garage Guard status editor (no Stripe marker) and a credit from the flag-off browser tool (no class).
  'job-typed': { ...base, customerId: 'c3', customer: 'Synthetic Typed', garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, nextVisit: '', renewalDate: '', updatedAt: '2026-09-22T15:00:00.000Z', updatedBy: 'tylerg' },
    giftWallet: { cards: [{ id: 'credit-mfdk2a', label: 'EGC service credit', source: 'Manager-issued', issuedAmount: 30, remainingAmount: 30, issuedAt: '2026-09-21T16:00:00.000Z', issuedBy: 'alexk' }] } },
  'job-child': { ...base, customerAccountOwnerJobId: 'job-root' },
  'job-walk': { ...base, type: 'walkthrough' },
  'job-rebook': { ...base, status: 'completed', rebookingRequests: [
    { id: 'rebook-1', kind: 'touch_up', timing: 'asap', preferredCrew: true, status: 'pending', requestedAt: '2026-09-20T15:00:00.000Z', notes: 'Same crew please' },
    { id: 'rebook-2', kind: 'repeat', timing: 'choose_date', preferredDate: '2026-10-10', status: 'pending', requestedAt: '2026-09-23T03:30:00.000Z' },
    { id: 'rebook-0', kind: 'repeat', status: 'contacted', requestedAt: '2026-09-01T15:00:00.000Z' }] },
  'job-broken': { ...base, customerAccountOwnerJobId: 'job-gone' },
};
const store = { read: async (collection, id) => rows[id] ? { ...structuredClone(rows[id]), id, revision: `${id}-r1` } : null };
const views = {};
// The same instant as the page clock (the owner-limit window is computed server-side on it).
for (const id of Object.keys(rows)) views[id] = await readLifecycle(store, owner, id, {}, new Date('2026-09-23T05:30:00Z'));
process.stdout.write(JSON.stringify(views));
'''

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-customer-lifecycle.css"></head>'
                    '<body style="margin:0;padding:12px;font:16px system-ui"><main><button id="legacy-credit" onclick="opsIssueCustomerCredit(\'job-root\')">Issue gift credit</button></main>'
                    '<script>window.legacyCalls=[];window.toasts=[];window.triggers=[];'
                    'window.opsIssueCustomerCredit=id=>{legacyCalls.push([id,"credit"])};window.opsSendCustomerDecision=id=>{legacyCalls.push([id,"decision"])};window.opsReviewRebooking=id=>{legacyCalls.push([id,"rebook"])};'
                    'window.opsTriggerCommunication=(id,event,marker)=>{triggers.push([id,event,marker])};window.showToast=m=>toasts.push(String(m));</script>'
                    '<script src="/employee-customer-lifecycle.js"></script></body></html>').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class CustomerLifecycleBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.views = json.loads(subprocess.run(['node', '--input-type=module', '-e', VIEWS], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.set_fixed_time(CLOCK)
        self.flag = True; self.status_fails = False; self.server_enabled = True; self.data = copy.deepcopy(self.views); self.owner = True
        self.gets = []; self.posts = []; self.behaviors = []; self.errors = []; self.status_calls = 0; self.completed = {}
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/integration-status':
            self.status_calls += 1
            if self.status_fails: send({'ok': False, 'error': 'Synthetic outage'}, 503); return
            send({'ok': True, 'status': {}, 'flags': {'moneyApi': False, 'lifecycleApi': self.flag}}); return
        if parsed.path != '/api/customer-lifecycle': route.continue_(); return
        if req.method == 'GET':
            job_id = parse_qs(parsed.query)['jobId'][0]; self.gets.append(job_id)
            view = copy.deepcopy(self.data[job_id]); view['viewer'] = {'id': 'zacb' if self.owner else 'tylerg', 'owner': self.owner}
            send({'ok': True, 'authority': 'employee_hub', 'enabled': self.server_enabled, **view, 'asOf': CLOCK}); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        behavior = self.behaviors.pop(0) if self.behaviors else None
        if isinstance(behavior, tuple): send({'ok': False, 'code': behavior[1], 'error': behavior[2]}, behavior[0]); return
        if body['requestId'] in self.completed: send({**self.completed[body['requestId']], 'replayed': True}); return
        view = self.data[body['jobId']]
        record = view['account'] if body['action'] in ('credit.issue', 'gift_card.sell') else view['job']
        if body['expectedRevision'] != record['revision']: send({'ok': False, 'code': 'lifecycle_revision_conflict', 'error': 'This customer record changed after you opened it.'}, 409); return
        record['revision'] = record['revision'] + '+'
        saved = {'amountCents': body.get('amountCents'), 'creditClass': body.get('creditClass', 'gift_purchase')}
        if body['action'] == 'decision.prompt': saved['decisionId'] = 'decision-' + body['requestId'].lower()
        result = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False, 'result': saved, 'context': view}
        self.completed[body['requestId']] = copy.deepcopy(result)
        if behavior == 'lost': route.abort('connectionfailed'); return
        send(result)
    def open(self, job='job-root', action='opsIssueCustomerCredit'):
        self.page.goto(self.url); self.page.evaluate(f'{action}({json.dumps(job)})')
        expect(self.page.get_by_role('dialog')).to_be_visible(); expect(self.page.locator('.el-body')).not_to_contain_text('Loading')
    def label(self, text): return self.page.get_by_label(text, exact=True)
    def primary(self): return self.page.locator('.el-foot .primary')
    def closed(self): expect(self.page.get_by_role('dialog')).to_have_count(0)

    def test_flag_off_keeps_todays_browser_tools(self):
        self.flag = False; self.page.goto(self.url)
        for name in ['opsIssueCustomerCredit', 'opsSendCustomerDecision', 'opsReviewRebooking']: self.page.evaluate(f"{name}('job-root')")
        self.page.locator('#legacy-credit').click()
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-root', 'credit'], ['job-root', 'decision'], ['job-root', 'rebook'], ['job-root', 'credit']])
        expect(self.page.get_by_role('dialog')).to_have_count(0); self.assertEqual(self.gets, []); self.assertEqual(self.posts, []); self.assertEqual(self.status_calls, 1)
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))'); self.flag = True
        self.page.evaluate("opsIssueCustomerCredit('job-root')"); expect(self.page.get_by_role('dialog')).to_be_visible(); self.assertEqual(self.status_calls, 2)

    def test_issue_a_classed_credit_on_the_customer_account(self):
        self.open('job-child')
        expect(self.page.locator('.el-summary')).to_contain_text('Available credit'); expect(self.page.locator('.el-summary dd').first).to_have_text('$90.50')
        expect(self.page.locator('.el-list li')).to_have_count(2); expect(self.page.locator('.el-list li').first).to_contain_text('Older credit'); expect(self.page.locator('.el-list li').first).to_contain_text('$15.50 of $40.00')
        expect(self.page.locator('.el-summary')).to_contain_text('kept on this customer\'s account')
        expect(self.label('Amount ($)')).to_have_attribute('inputmode', 'decimal'); expect(self.label('Label the customer sees')).to_have_value('EGC service credit')
        self.label('Credit type').select_option('referral'); self.label('Amount ($)').fill('$50'); self.label('Reason').fill('Referred a neighbor')
        self.primary().click(); self.closed()
        body = self.posts[-1]
        self.assertTrue(UUID.match(body['requestId'])); self.assertEqual({key: body[key] for key in ('action', 'jobId', 'accountId', 'expectedRevision', 'actorId', 'amountCents', 'creditClass', 'label', 'reason')},
            {'action': 'credit.issue', 'jobId': 'job-child', 'accountId': 'job-root', 'expectedRevision': 'job-root-r1', 'actorId': 'zacb', 'amountCents': 5000, 'creditClass': 'referral', 'label': 'EGC service credit', 'reason': 'Referred a neighbor'})
        self.assertNotIn('reference', body); self.assertIn('nothing was sent to the customer', self.page.evaluate('toasts.at(-1)'))
        self.assertEqual(self.page.evaluate('triggers'), [])

    def test_courtesy_limit_and_gift_purchase_reference_are_checked_before_anything_is_sent(self):
        self.owner = False; self.open()
        # No credit type is preselected: a manager must choose one.
        expect(self.label('Credit type')).to_have_value(''); expect(self.page.locator('.el-notice.warn')).to_have_count(0)
        self.label('Amount ($)').fill('20'); self.label('Reason').fill('Unused visit'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_have_text('Choose a credit type.'); self.assertEqual(self.posts, [])
        self.label('Credit type').select_option('garage_guard')
        expect(self.page.locator('.el-notice.warn')).to_contain_text('Garage Guard credits over $1,000.00 need the owner')
        expect(self.page.locator('.el-notice.warn')).to_contain_text('every Garage Guard credit or gift-card sale a manager recorded for this customer in the last 30 days: $75.00 so far')
        self.label('Amount ($)').fill('1000.01'); self.label('Reason').fill('Unused visits'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('Garage Guard credits over $1,000.00 need the owner'); self.assertEqual(self.posts, [])
        self.label('Credit type').select_option('courtesy'); expect(self.page.locator('.el-notice.warn')).to_contain_text('Courtesy and referral credits over $100.00 need the owner')
        self.label('Amount ($)').fill('150'); self.label('Reason').fill('Crew arrived late'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('need the owner'); self.assertEqual(self.posts, [])
        # A referral reward is contra revenue too: the same limit applies.
        self.label('Credit type').select_option('referral'); expect(self.page.locator('.el-notice.warn')).to_contain_text('Courtesy and referral credits over $100.00')
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('Courtesy and referral credits over $100.00 need the owner'); self.assertEqual(self.posts, [])
        expect(self.label('Credit type').locator('option[value="gift_purchase"]')).to_have_count(0, timeout=1000)
        # Only the owner may add a gift card sold before the Hub, and it needs the original sale reference.
        self.owner = True; self.page.keyboard.press('Escape'); self.closed(); self.page.evaluate("opsIssueCustomerCredit('job-root')")
        self.label('Credit type').select_option('gift_purchase'); expect(self.page.locator('.el-notice.warn')).to_have_count(0)
        self.label('Amount ($)').fill('150'); self.label('Reason').fill('Paper gift card from 2025')
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('original gift-card sale'); self.assertEqual(self.posts, [])
        self.label('Original sale receipt or reference').fill('Paper card 0042'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('creditClass', 'reference', 'amountCents')}, {'creditClass': 'gift_purchase', 'reference': 'Paper card 0042', 'amountCents': 15000})
        # A server refusal (for example the owner limit) discards the request instead of offering a retry.
        self.owner = False; self.page.evaluate("opsIssueCustomerCredit('job-root')"); self.label('Credit type').select_option('courtesy'); self.label('Amount ($)').fill('90'); self.label('Reason').fill('Goodwill')
        self.behaviors = [(403, 'lifecycle_owner_required', 'Courtesy credits over $80.00 need the owner.')]; self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('$80.00 need the owner'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_have_count(0)

    def test_sell_a_gift_card_records_cash_and_a_wallet_credit(self):
        self.open()
        self.page.get_by_role('button', name='Sell a gift card', exact=True).click()
        expect(self.page.get_by_role('button', name='Sell a gift card', exact=True)).to_have_attribute('aria-pressed', 'true')
        expect(self.label('Label the customer sees')).to_have_value('EGC gift card'); expect(self.page.locator('.el-note')).to_contain_text('not job revenue')
        # The date defaults to today in Denver (Sep 22), not the Tokyo device date (Sep 23), and cannot be in the future.
        received = self.label('Date received')
        expect(received).to_have_attribute('type', 'date'); expect(received).to_have_value('2026-09-22'); expect(received).to_have_attribute('max', '2026-09-22'); expect(received).to_have_attribute('min', '2025-09-22')
        self.assertGreaterEqual(received.bounding_box()['height'], 44); self.assertEqual(received.evaluate('e=>getComputedStyle(e).fontSize'), '16px')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'customer-lifecycle-gift-sale-375.png'))
        self.label('Amount received ($)').fill('150.00'); self.label('How it was paid').select_option('stripe_link'); self.label('Receipt, check or transaction reference').fill('pi_synthetic_123')
        expect(self.primary()).to_have_text('Record gift card sale'); self.primary().click(); self.closed()
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'accountId', 'expectedRevision', 'amountCents', 'method', 'reference', 'label')},
            {'action': 'gift_card.sell', 'accountId': 'job-root', 'expectedRevision': 'job-root-r1', 'amountCents': 15000, 'method': 'stripe_link', 'reference': 'pi_synthetic_123', 'label': 'EGC gift card'})
        self.assertNotIn('creditClass', body); self.assertNotIn('receivedAt', body, 'a sale received today is stamped by the server clock')
        self.assertIn('Gift card recorded: $150.00', self.page.evaluate('toasts.at(-1)'))
        # Cash that came in on an earlier Denver day is dated noon in Denver on that day.
        self.page.evaluate("opsIssueCustomerCredit('job-root')"); self.page.get_by_role('button', name='Sell a gift card', exact=True).click()
        self.label('Amount received ($)').fill('50'); self.label('Receipt, check or transaction reference').fill('Check 3003')
        self.label('Date received').fill('2026-09-23'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('today or a day in the last year'); self.assertEqual(len(self.posts), 1)
        self.label('Date received').fill('2026-09-20'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('method', 'reference', 'receivedAt', 'amountCents')}, {'method': 'check', 'reference': 'Check 3003', 'receivedAt': '2026-09-20T18:00:00.000Z', 'amountCents': 5000})
        # Over the prepaid limit a manager is stopped before anything is sent.
        self.owner = False; self.page.evaluate("opsIssueCustomerCredit('job-root')"); self.page.get_by_role('button', name='Sell a gift card', exact=True).click()
        expect(self.page.locator('.el-notice.warn')).to_contain_text('Gift-card sales over $1,000.00 need the owner')
        self.label('Amount received ($)').fill('1500'); self.label('Receipt, check or transaction reference').fill('Check 3004'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('Gift-card sales over $1,000.00 need the owner'); self.assertEqual(len(self.posts), 2)
        # A duplicate the server refuses is shown with its reason and never offered as a retry.
        self.label('Amount received ($)').fill('50'); self.label('Receipt, check or transaction reference').fill('check-3003')
        self.behaviors = [(409, 'lifecycle_sale_duplicate', 'A check gift-card sale with this reference was already recorded (sale 1a2b3c4d, received Sep 20, 2026).')]; self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('already recorded (sale 1a2b3c4d'); expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_have_count(0)
        expect(self.label('Receipt, check or transaction reference')).to_have_value('check-3003')

    def test_a_hub_typed_membership_does_not_qualify_and_old_browser_credits_count_toward_the_total(self):
        self.owner = False; self.open('job-typed')
        options = self.label('Credit type').locator('option').evaluate_all('els=>els.map(e=>e.value)')
        self.assertEqual(options, ['', 'referral', 'courtesy'], 'a membership set with the Garage Guard status button is not a Stripe membership')
        expect(self.page.locator('.el-body')).to_contain_text('(one set with the Garage Guard status button does not count)')
        # The $30.00 the flag-off tool gave yesterday (no class, issued by a manager) counts toward the courtesy total.
        self.label('Credit type').select_option('courtesy')
        expect(self.page.locator('.el-notice.warn')).to_have_text('Courtesy and referral credits over $100.00 need the owner. That limit counts every courtesy or referral credit a manager gave this customer in the last 30 days: $30.00 so far.')
        self.label('Amount ($)').fill('70.01'); self.label('Reason').fill('Crew arrived late'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('$30.00 so far. Ask the owner to issue this credit.'); self.assertEqual(self.posts, [])
        self.label('Amount ($)').fill('70'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('accountId', 'amountCents', 'creditClass')}, {'accountId': 'job-typed', 'amountCents': 7000, 'creditClass': 'courtesy'})

    def test_a_manager_sees_only_what_they_may_issue_and_the_running_total_is_checked_first(self):
        self.owner = False; self.open('job-limits')
        options = self.label('Credit type').locator('option').evaluate_all('els=>els.map(e=>e.value)')
        self.assertEqual(options, ['', 'referral', 'courtesy'], 'no Garage Guard credit without a membership, no pre-Hub gift card for a manager')
        expect(self.page.locator('.el-body')).to_contain_text('Garage Guard credits need an active Garage Guard membership recorded from Stripe, with unused visits')
        # A type the form did not offer is an error even if it is forced into the list.
        self.page.evaluate("""()=>{const s=document.querySelector('select[name=creditClass]');s.append(new Option('Garage Guard','garage_guard'));s.value='garage_guard';s.dispatchEvent(new Event('change'))}""")
        self.label('Amount ($)').fill('5'); self.label('Reason').fill('Unused visit'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_have_text('Choose a credit type.'); self.assertEqual(self.posts, [])
        # Managers already gave $60.00 in the window ($90.00 earlier and the owner's $200.00 do not count).
        self.label('Credit type').select_option('courtesy')
        expect(self.page.locator('.el-notice.warn')).to_have_text('Courtesy and referral credits over $100.00 need the owner. That limit counts every courtesy or referral credit a manager gave this customer in the last 30 days: $60.00 so far.')
        self.label('Amount ($)').fill('40.01'); self.label('Reason').fill('Crew arrived late'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('$60.00 so far. Ask the owner to issue this credit.'); self.assertEqual(self.posts, [])
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375); self.assertLessEqual(self.page.evaluate("document.querySelector('.egc-lifecycle').scrollWidth"), 375)
        (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'customer-lifecycle-manager-limit-375.png'), full_page=True)
        self.label('Credit type').select_option('referral'); self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('$60.00 so far'); self.assertEqual(self.posts, [])
        self.label('Amount ($)').fill('40'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'creditClass', 'amountCents')}, {'action': 'credit.issue', 'creditClass': 'referral', 'amountCents': 4000})
        # A sale shares the prepaid total with Garage Guard credits, and 'Other' is not offered to a manager.
        self.page.evaluate("opsIssueCustomerCredit('job-limits')"); self.page.get_by_role('button', name='Sell a gift card', exact=True).click()
        methods = self.label('How it was paid').locator('option').evaluate_all('els=>els.map(e=>e.value)')
        self.assertEqual(methods, ['cash', 'check', 'card_terminal', 'stripe_link', 'bank_transfer']); expect(self.page.locator('.el-body')).to_contain_text('A sale paid some other way needs the owner.')
        expect(self.page.locator('.el-notice.warn')).to_contain_text('Gift-card sales over $1,000.00 need the owner. That limit counts every Garage Guard credit or gift-card sale a manager recorded for this customer in the last 30 days: $950.00 so far.')
        self.label('Amount received ($)').fill('50.01'); self.label('Receipt, check or transaction reference').fill('Check 5001'); self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('$950.00 so far. Ask the owner to record this sale.'); self.assertEqual(len(self.posts), 1)
        self.label('Amount received ($)').fill('50'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'method', 'amountCents')}, {'action': 'gift_card.sell', 'method': 'check', 'amountCents': 5000})
        # The owner is offered every type and method and sees no limit notice.
        self.owner = True; self.page.evaluate("opsIssueCustomerCredit('job-limits')")
        self.assertEqual(self.label('Credit type').locator('option').evaluate_all('els=>els.map(e=>e.value)'), ['', 'garage_guard', 'referral', 'courtesy', 'gift_purchase'])
        self.label('Credit type').select_option('courtesy'); expect(self.page.locator('.el-notice.warn')).to_have_count(0)
        self.page.get_by_role('button', name='Sell a gift card', exact=True).click(); expect(self.label('How it was paid').locator('option[value="other"]')).to_have_count(1)
        self.label('Amount received ($)').fill('2000'); self.label('How it was paid').select_option('other'); self.label('Receipt, check or transaction reference').fill('Venmo @synthetic 0922'); self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('method', 'amountCents')}, {'method': 'other', 'amountCents': 200000})

    def test_decision_prompt_saves_then_offers_the_confirmed_customer_notification(self):
        self.open('job-root', 'opsSendCustomerDecision')
        expect(self.page.locator('.el-summary')).to_contain_text('Haul the old freezer? · approved')
        self.label('Decision needed').fill('Remove the damaged cabinet?'); self.label('What the crew found').fill('The back panel is broken.')
        expect(self.label('Additional minutes')).to_have_attribute('inputmode', 'numeric'); expect(self.label('Google Drive photo link (optional)')).to_have_attribute('type', 'url')
        self.label('Additional price ($)').fill('75.5'); self.label('Additional minutes').fill('30'); self.label('Google Drive photo link (optional)').fill('https://evil.example/x')
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('Google Drive'); self.assertEqual(self.posts, [])
        self.label('Google Drive photo link (optional)').fill('https://drive.google.com/file/d/synthetic/view'); self.primary().click(); self.closed()
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'jobId', 'expectedRevision', 'title', 'details', 'priceDeltaCents', 'timeDeltaMinutes', 'photoUrl')},
            {'action': 'decision.prompt', 'jobId': 'job-root', 'expectedRevision': 'job-root-r1', 'title': 'Remove the damaged cabinet?', 'details': 'The back panel is broken.', 'priceDeltaCents': 7550, 'timeDeltaMinutes': 30, 'photoUrl': 'https://drive.google.com/file/d/synthetic/view'})
        self.assertNotIn('promptedAt', body); self.assertNotIn('accountId', body)
        self.assertEqual(self.page.evaluate('triggers'), [['job-root', 'decision-needed', 'decision-' + body['requestId'].lower()]], 'the suite trigger (with its own confirm) is offered, keyed by this decision, never a direct send')
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Decision saved in the customer portal')

    def test_decisions_are_not_offered_on_walkthroughs(self):
        self.open('job-walk', 'opsSendCustomerDecision')
        expect(self.page.locator('.el-notice.warn')).to_contain_text('not walkthroughs'); expect(self.primary()).to_have_count(0)

    def test_rebooking_follow_up_marks_the_chosen_request_contacted(self):
        self.open('job-rebook', 'opsReviewRebooking')
        expect(self.page.locator('.el-choice')).to_have_count(2)
        expect(self.page.locator('.el-choice').nth(1)).to_contain_text('Sep 22, 2026, 9:30 PM')
        expect(self.page.locator('.el-choice input').nth(1)).to_be_checked()
        self.page.locator('.el-choice').first.click(); self.label('Confirmation / scheduling note').fill('Called; touch-up held for Friday.')
        self.primary().click(); self.closed()
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'rebookingRequestId', 'note', 'expectedRevision')}, {'action': 'rebook.mark_contacted', 'rebookingRequestId': 'rebook-1', 'note': 'Called; touch-up held for Friday.', 'expectedRevision': 'job-rebook-r1'})
        self.page.evaluate("opsReviewRebooking('job-root')"); expect(self.page.locator('.el-notice')).to_contain_text('No rebooking request is waiting'); expect(self.primary()).to_have_count(0)
        self.data['job-rebook']['job']['rebooking'] = [item for item in self.data['job-rebook']['job']['rebooking'] if item['id'] != 'rebook-2']
        self.page.keyboard.press('Escape'); self.page.evaluate("opsReviewRebooking('job-rebook')")
        expect(self.page.locator('.el-choice')).to_have_count(0); expect(self.page.locator('.el-request')).to_contain_text('touch-up · next available · same crew requested')
        expect(self.page.locator('.el-request')).to_contain_text('“Same crew please”'); expect(self.page.locator('.el-request')).to_contain_text('Requested Sep 20, 2026, 9:00 AM')
        self.label('Confirmation / scheduling note').fill('Texted to confirm.'); self.primary().click(); self.closed()
        self.assertEqual(self.posts[-1]['rebookingRequestId'], 'rebook-1')

    def test_a_broken_account_link_blocks_credits_with_the_servers_reason(self):
        self.open('job-broken')
        expect(self.page.get_by_role('alert')).to_contain_text('could not be loaded'); expect(self.primary()).to_have_count(0)

    def test_lost_response_retries_the_original_request_after_a_reload(self):
        self.open()
        self.label('Credit type').select_option('garage_guard'); self.label('Amount ($)').fill('25'); self.label('Reason').fill('Unused Garage Guard visit')
        self.behaviors = ['lost']; self.primary().click()
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible(); expect(self.page.get_by_role('alert').first).to_contain_text('Retry it unchanged')
        self.page.reload(); self.page.evaluate("opsIssueCustomerCredit('job-root')")
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible()
        self.page.get_by_role('button', name='Retry original save', exact=True).click(); self.closed()
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1]); self.assertEqual(self.posts[0]['amountCents'], 2500)
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc.lifecycle.pending")).length'), 0)
        # A pending credit never blocks a decision on the same job.
        self.behaviors = ['lost']; self.page.evaluate("opsIssueCustomerCredit('job-root')"); self.label('Credit type').select_option('referral'); self.label('Amount ($)').fill('10'); self.label('Reason').fill('Referral'); self.primary().click()
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible(); self.page.get_by_role('button', name='Cancel', exact=False).count()
        self.page.keyboard.press('Escape'); self.closed()
        self.page.evaluate("opsSendCustomerDecision('job-root')"); expect(self.label('Decision needed')).to_be_visible()

    def test_revision_conflict_keeps_the_draft_and_saves_against_the_latest_revision(self):
        self.open('job-root', 'opsSendCustomerDecision')
        self.label('Decision needed').fill('Keep the bikes?'); self.label('What the crew found').fill('Customer was unsure.')
        self.data['job-root']['job']['revision'] = 'job-root-r2'; self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('changed after you opened it'); expect(self.label('Decision needed')).to_have_value('Keep the bikes?')
        self.page.get_by_role('button', name='Load latest details', exact=True).click(); expect(self.label('Decision needed')).to_have_value('Keep the bikes?')
        self.primary().click(); self.closed()
        self.assertEqual([post['expectedRevision'] for post in self.posts], ['job-root-r1', 'job-root-r2']); self.assertNotEqual(self.posts[0]['requestId'], self.posts[1]['requestId'])

    def test_flag_turned_off_while_open_hands_over_to_the_standard_tool(self):
        self.open()
        self.label('Credit type').select_option('referral'); self.label('Amount ($)').fill('20'); self.label('Reason').fill('Referral reward')
        self.behaviors = [(404, 'lifecycle_api_disabled', 'Server customer actions are turned off.')]; self.primary().click(); self.closed()
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-root', 'credit']]); self.assertIs(self.page.evaluate('window.EGC_FLAGS.lifecycleApi'), False)
        self.assertIn('turned off, so this was not saved here', self.page.evaluate('toasts.at(-1)'))
        self.server_enabled = False; self.page.reload(); self.page.evaluate("opsReviewRebooking('job-rebook')")
        self.closed(); self.assertEqual(self.page.evaluate('legacyCalls'), [['job-rebook', 'rebook']])

    def test_an_unreadable_setting_after_it_was_on_runs_neither_path(self):
        self.open(); self.page.keyboard.press('Escape'); self.closed()
        self.status_fails = True; self.page.reload(); self.page.evaluate("opsSendCustomerDecision('job-root')")
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Customer action settings could not be checked. Retry.')
        self.closed(); self.assertEqual(self.page.evaluate('legacyCalls'), [])

    def test_phone_layout_targets_inputs_and_signout(self):
        for job, action in [('job-root', 'opsIssueCustomerCredit'), ('job-root', 'opsSendCustomerDecision'), ('job-rebook', 'opsReviewRebooking')]:
            self.open(job, action)
            for width in [375, 320, 390]:
                self.page.set_viewport_size({'width': width, 'height': 812})
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
                self.assertLessEqual(self.page.evaluate("document.querySelector('.egc-lifecycle').scrollWidth"), width)
                heights = self.page.locator('.egc-lifecycle button:visible, .egc-lifecycle input:not([type=radio]):visible, .egc-lifecycle select:visible, .egc-lifecycle .el-choice:visible').evaluate_all('els=>els.map(e=>e.getBoundingClientRect().height)')
                self.assertTrue(all(height >= 44 for height in heights), heights)
                fonts = self.page.locator('.egc-lifecycle input:not([type=radio]), .egc-lifecycle select, .egc-lifecycle textarea').evaluate_all('els=>els.map(e=>getComputedStyle(e).fontSize)')
                self.assertTrue(all(font == '16px' for font in fonts), fonts)
                self.assertNotIn('null', self.page.locator('.el-body').inner_text()); self.assertNotIn('undefined', self.page.locator('.el-body').inner_text())
            footer = self.page.locator('.el-foot .primary').bounding_box(); self.assertGreater(footer['y'] + footer['height'], 812 - 120, 'the primary action sits within thumb reach')
            (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / f'customer-lifecycle-{action}-390.png'))
            self.page.set_viewport_size({'width': 375, 'height': 812})
            self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))'); self.closed()

    def test_typed_entries_are_guarded_on_page_unload(self):
        prevented = "(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()"
        self.open(); self.assertIs(self.page.evaluate(prevented), False, 'an untouched form leaves freely')
        self.page.get_by_role('button', name='Sell a gift card', exact=True).click(); self.assertIs(self.page.evaluate(prevented), False, 'switching to a sale is not an entry')
        self.label('Amount received ($)').fill('20'); self.assertIs(self.page.evaluate(prevented), True)
        self.assertIs(self.page.evaluate('EGCCustomerLifecycle.canLeave()'), False)
        self.label('Amount received ($)').fill(''); self.assertIs(self.page.evaluate(prevented), False)
        self.label('How it was paid').select_option('cash'); self.assertIs(self.page.evaluate(prevented), True, 'a changed choice counts too')
        self.page.keyboard.press('Escape'); self.closed(); self.assertIs(self.page.evaluate(prevented), False)
        self.open('job-rebook', 'opsReviewRebooking'); self.label('Confirmation / scheduling note').fill('Called'); self.assertIs(self.page.evaluate(prevented), True)
        self.primary().click(); self.closed(); self.assertIs(self.page.evaluate(prevented), False, 'a saved form leaves freely')
        self.assertIs(self.page.evaluate('EGCCustomerLifecycle.canLeave()'), True)

    def test_untrusted_text_is_rendered_as_text(self):
        self.data['job-root']['job']['customer'] = '<img src=x onerror=window.xss=1>'; self.data['job-root']['account']['customer'] = '<img src=x onerror=window.xss=2>'
        self.data['job-root']['account']['credits'][0]['label'] = '<b>bold</b>'
        self.open(); expect(self.page.locator('.el-customer')).to_have_text('<img src=x onerror=window.xss=2>')
        expect(self.page.locator('.el-list li').first).to_contain_text('<b>bold</b>'); self.assertIsNone(self.page.evaluate('window.xss'))

if __name__ == '__main__': unittest.main(verbosity=2)
