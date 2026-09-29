"""Server money actions (M3) in the browser: flag gating, the itemized estimate editor,
retry-safe payment saves and phone layout, against DTOs built by the real service.
MONEY-GHL-PARITY: a confirmed save starts the standard finance save's HighLevel lifecycle
trigger once, through the suite helper (stubbed here); refused, failed and conflicting saves start none."""
import copy, json, os, pathlib, re, subprocess, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
# 23:30 on 2026-09-22 in Denver, already 2026-09-23 in Tokyo and UTC.
CLOCK = '2026-09-23T05:30:00Z'
SAVED_AT = '2026-09-23T05:30:00.000Z'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PROJECTIONS = r'''
import { moneyProjection } from './functions/_lib/money-service.js';
import { respondToDecision } from './functions/_lib/change-orders.js';
const NOW = '2026-09-23T05:30:00.000Z', line = (id, name, unitCents, quantity = 1, extra = {}) => ({ id, kind: 'service', name, description: '', quantity, unitCents, totalCents: unitCents * quantity, amount: unitCents * quantity / 100, ...extra });
const base = { type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', phone: '9705550100' };
const estimate = { number: 'EST-ABC123', status: 'draft', revision: 1, amount: 1400, depositRequired: 700, scope: 'Clear and reset the two-car garage.', validUntil: '2026-10-06', lineItems: [line('line-1', 'Garage cleanout', 90000), line('line-2', 'Shelving install', 25000, 2)] };
// A change the customer approved in the portal with billing on: a billed change-order line.
const working = { ...base, status: 'in_progress', pipelineStatus: 'in_progress', total: 1400, estimate: { ...estimate, status: 'accepted' }, customerApproval: { status: 'approved', amount: 1400 },
  customerDecisions: [{ id: 'decision-freezer', title: 'Haul the old freezer', details: '', priceDelta: 150, status: 'pending' }] };
const approval = { decisionId: 'decision-freezer', response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: '2b7f0c1e-5a4d-4c3b-9e8f-7a6b5c4d3e2f', priceDeltaCents: 15000 };
const jobs = {
  'job-draft': { ...base, total: 1400, estimate },
  'job-billed': { ...working, ...respondToDecision(working, approval, { billing: true, now: NOW }).patch },
  'job-new': { ...base, total: 800 },
  'job-quiet': { ...base, total: 800, notify: false },
  'job-options': { ...base, total: 900, estimate: { ...estimate, amount: 900, depositRequired: 450, lineItems: [line('base', 'Garage cleanout', 90000), line('epoxy', 'Epoxy floor', 300000, 1, { optional: true, selected: false })] } },
  'job-approved': { ...base, total: 1400, estimate: { ...estimate, status: 'accepted' }, customerApproval: { status: 'approved', approvedBy: 'Synthetic Customer', amount: 1400 } },
  'job-invoiced': { ...base, total: 1400, estimate: { ...estimate, status: 'accepted' }, customerApproval: { status: 'approved', amount: 1400 }, payment: { amount: 300, verified: true, reference: 'CHK-1', lastAmount: 300, recordedBy: 'zacb', method: 'check' },
    invoice: { number: 'INV-ABC123', status: 'issued', amount: 1400, dueDate: '2026-09-29', issuedAt: '2026-09-20T18:00:00.000Z' } },
  'job-change': { ...base, total: 1400, estimate: { ...estimate, status: 'accepted' }, customerApproval: { status: 'approved', amount: 1400 }, approvedChangeTotal: 150,
    customerDecisions: [{ id: 'd1', title: 'Haul extra shelving', priceDelta: 150, status: 'approved' }] },
};
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, moneyProjection({ ...job, id, revision: 'r1' }, NOW)]))));
'''

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-money-actions.css"></head>'
                    '<body style="margin:0;padding:12px;font:16px system-ui"><main><button id="legacy-cost" onclick="opsFinanceAction(\'job-draft\',\'cost\')">Costs</button></main>'
                    '<script>window.legacyCalls=[];window.toasts=[];window.opsFinanceAction=(id,action)=>{legacyCalls.push([id,action])};window.showToast=m=>toasts.push(String(m));'
                    # The suite helper: the saved job as the browser reads it, and the lifecycle trigger (recorded by the test server).
                    'window.EGCCustomerCommunication={read:async id=>{const r=await fetch("/test/saved-job?jobId="+encodeURIComponent(id));return r.ok?r.json():null},'
                    'sync:async(job,event,marker)=>(await fetch("/test/lifecycle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:job.id,event,marker,notify:job.notify})})).ok,'
                    'portalLabel:()=>"Portal text queued in HighLevel",render:()=>{}};</script>'
                    '<script src="/employee-money-actions.js"></script></body></html>').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class MoneyActionsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.projections = json.loads(subprocess.run(['node', '--input-type=module', '-e', PROJECTIONS], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
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
        self.flag = True; self.status_fails = False; self.server_enabled = True; self.jobs = copy.deepcopy(self.projections); self.gets = []; self.posts = []; self.behaviors = []; self.errors = []; self.status_calls = 0; self.completed = {}
        self.saved = {}; self.lifecycle = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/test/saved-job':
            saved = self.saved.get(parse_qs(parsed.query)['jobId'][0])
            if saved: send(saved)
            else: send({'ok': False}, 404)
            return
        if parsed.path == '/test/lifecycle':
            call = req.post_data_json; self.lifecycle.append(call)
            self.saved[call['jobId']]['communicationLog'].append({'id': f"communication:{call['jobId']}:{call['event']}:{call['marker']}", 'status': 'suppressed' if call['notify'] is False else 'triggered'})
            send({'ok': True}); return
        if parsed.path == '/api/integration-status':
            self.status_calls += 1
            if self.status_fails: send({'ok': False, 'error': 'Synthetic outage'}, 503); return
            send({'ok': True, 'status': {}, 'flags': {'moneyApi': self.flag}}); return
        if parsed.path != '/api/money': route.continue_(); return
        if req.method == 'GET':
            job_id = parse_qs(parsed.query)['jobId'][0]; self.gets.append(job_id)
            send({'ok': True, 'authority': 'employee_hub', 'enabled': self.server_enabled, 'viewer': {'id': 'zacb'}, 'job': self.jobs[job_id], 'asOf': CLOCK}); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        behavior = self.behaviors.pop(0) if self.behaviors else None
        if isinstance(behavior, tuple): send({'ok': False, 'code': behavior[1], 'error': behavior[2]}, behavior[0]); return
        if body['requestId'] in self.completed: send({**self.completed[body['requestId']], 'replayed': True}); return
        job = self.jobs[body['jobId']]
        if body['expectedRevision'] != job['revision']: send({'ok': False, 'code': 'money_revision_conflict', 'error': 'This job changed after you opened it.'}, 409); return
        job['revision'] = job['revision'] + '+'
        log = self.saved.get(body['jobId'], {}).get('communicationLog', [])
        self.saved[body['jobId']] = {'id': body['jobId'], 'moneyRequestId': body['requestId'], 'moneyUpdatedAt': SAVED_AT, 'notify': job['notify'], 'communicationLog': log}
        result = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False, 'job': job, 'warnings': [{'code': 'synthetic', 'message': 'Synthetic warning shown.'}] if body['action'] == 'invoice.void' else []}
        self.completed[body['requestId']] = copy.deepcopy(result)
        if behavior == 'lost': route.abort('connectionfailed'); return
        send(result)
    def open(self, job='job-draft', action='estimate'):
        self.page.goto(self.url); self.page.evaluate(f'opsFinanceAction({json.dumps(job)},{json.dumps(action)})')
        expect(self.page.get_by_role('dialog')).to_be_visible(); expect(self.page.locator('.em-summary')).to_be_visible()
    def label(self, text): return self.page.get_by_label(text, exact=True)
    def primary(self): return self.page.locator('.em-foot .primary')

    def test_flag_off_keeps_todays_browser_tools_and_other_actions_always_do(self):
        self.flag = False; self.page.goto(self.url)
        self.page.evaluate("opsFinanceAction('job-draft','estimate')"); self.page.evaluate("opsFinanceAction('job-draft','payment')")
        self.page.locator('#legacy-cost').click()
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-draft', 'estimate'], ['job-draft', 'payment'], ['job-draft', 'cost']])
        expect(self.page.get_by_role('dialog')).to_have_count(0); self.assertEqual(self.gets, []); self.assertEqual(self.posts, [])
        self.assertEqual(self.status_calls, 1, 'the flag is read once per sign-in')
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))'); self.flag = True
        self.page.evaluate("opsFinanceAction('job-draft','estimate')"); expect(self.page.get_by_role('dialog')).to_be_visible(); self.assertEqual(self.status_calls, 2)

    def test_itemized_estimate_saves_integer_cents_with_denver_dates_and_the_estimate_ready_trigger(self):
        self.open()
        expect(self.page.locator('.em-note')).to_have_text('Saving starts the HighLevel estimate-ready automation, as the standard finance tools do.')
        expect(self.label('Name').first).to_have_value('Garage cleanout'); expect(self.page.locator('.em-total')).to_contain_text('$1,400.00')
        self.page.get_by_role('button', name='Add line', exact=True).click()
        self.page.locator('[name="name-2"]').fill('Haul away'); self.page.locator('[name="quantity-2"]').fill('1.5'); self.page.locator('[name="unit-2"]').fill('$99.99')
        expect(self.page.locator('.em-total')).to_contain_text('Check each line'); expect(self.page.locator('[data-line-total="2"]')).to_have_text('Price × quantity must come to whole cents')
        self.page.locator('[name="unit-2"]').fill('100'); expect(self.page.locator('.em-total')).to_contain_text('$1,550.00')
        self.label('Deposit required ($)').fill('500'); self.label('Customer-facing scope').fill('Clear, haul and reset the garage.')
        self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        body = self.posts[-1]
        self.assertTrue(UUID.match(body['requestId'])); self.assertEqual(body['action'], 'estimate.save'); self.assertEqual(body['expectedRevision'], 'r1'); self.assertEqual(body['actorId'], 'zacb')
        self.assertEqual([(line['id'], line['quantity'], line['unitCents']) for line in body['lineItems']][:2], [('line-1', 1, 90000), ('line-2', 2, 25000)])
        self.assertEqual(body['lineItems'][2]['quantity'], 1.5); self.assertEqual(body['lineItems'][2]['unitCents'], 10000); self.assertRegex(body['lineItems'][2]['id'], r'^l[0-9a-f]{10}$')
        self.assertEqual(body['depositCents'], 50000); self.assertEqual(body['validUntil'], '2026-10-06'); self.assertNotIn('amount', body)
        self.page.wait_for_function('toasts.length===1')
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Saved · HighLevel automation triggered')
        self.assertEqual(self.lifecycle, [{'jobId': 'job-draft', 'event': 'estimate-ready', 'marker': f'estimate:{SAVED_AT}', 'notify': True}])

    def test_notify_off_job_says_so_and_suppresses_the_trigger(self):
        self.open('job-quiet')
        expect(self.page.locator('.em-note')).to_have_text('Customer notifications are off for this job, so saving starts no HighLevel automation.')
        self.label('Customer-facing scope').fill('Synthetic scope'); self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.page.wait_for_function('toasts.length===1')
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Saved · customer automation suppressed')
        self.assertEqual([(call['event'], call['notify']) for call in self.lifecycle], [('estimate-ready', False)])

    def test_new_estimate_defaults_follow_denver_today_and_a_fifty_percent_deposit(self):
        self.open('job-new')
        expect(self.label('Estimate valid through')).to_have_value('2026-10-06'); expect(self.label('Estimate valid through')).to_have_attribute('min', '2026-09-22')
        expect(self.label('Deposit required ($)')).to_have_value('400.00')
        self.page.locator('[name="unit-0"]').fill('1000'); expect(self.label('Deposit required ($)')).to_have_value('500.00')
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('scope'); self.assertEqual(self.posts, [])
        self.label('Customer-facing scope').fill('Synthetic scope'); self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.posts[-1]['depositCents'], 50000); self.assertEqual(self.posts[-1]['lineItems'][0]['unitCents'], 100000)

    def test_estimates_with_options_are_never_repriced_here(self):
        self.open('job-options')
        expect(self.page.locator('.em-notice.warn')).to_contain_text('will not reprice'); expect(self.primary()).to_have_count(0)
        self.page.get_by_role('button', name='Record that it was sent', exact=True).click()
        self.label('How it was sent').select_option('text'); self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'channel')}, {'action': 'estimate.mark_sent', 'channel': 'text'})
        self.assertIn('nothing was sent to the customer', self.page.evaluate('toasts.at(-1)')); self.assertEqual(self.lifecycle, [], 'marking it sent starts no trigger')

    def test_lost_payment_response_retries_the_original_request_after_a_reload(self):
        self.open('job-invoiced', 'payment')
        expect(self.label('Amount received ($)')).to_have_value('1100.00'); expect(self.label('Amount received ($)')).to_have_attribute('inputmode', 'decimal')
        self.label('Amount received ($)').fill('250.5'); self.label('How it was received').select_option('cash'); self.label('Receipt, check or transaction reference').fill('Receipt 42')
        self.behaviors = ['lost']; self.primary().click()
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible(); expect(self.page.get_by_role('alert').first).to_contain_text('Retry it unchanged')
        self.assertEqual(self.lifecycle, [], 'an unconfirmed save starts no trigger')
        self.page.reload(); self.page.evaluate("opsFinanceAction('job-invoiced','payment')")
        expect(self.page.get_by_role('button', name='Retry original save', exact=True)).to_be_visible(); expect(self.primary()).to_have_text('Retry original save')
        self.page.get_by_role('button', name='Retry original save', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1]); self.assertEqual(self.posts[0]['amountCents'], 25050)
        self.page.wait_for_function('toasts.length===1')
        self.assertEqual(self.lifecycle, [{'jobId': 'job-invoiced', 'event': 'payment-received', 'marker': f'payment:{SAVED_AT}', 'notify': True}], 'the replayed save starts it exactly once')
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Saved · HighLevel automation triggered')
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc.money.pending")).length'), 0)

    def test_revision_conflict_keeps_the_draft_and_saves_against_the_latest_revision(self):
        self.open('job-draft', 'estimate'); self.label('Customer-facing scope').fill('My unsaved scope')
        self.jobs['job-draft']['revision'] = 'r2'; self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('changed after you opened it'); expect(self.label('Customer-facing scope')).to_have_value('My unsaved scope')
        self.assertEqual(self.lifecycle, [], 'a conflicting save starts no trigger')
        self.page.get_by_role('button', name='Load latest details', exact=True).click(); expect(self.label('Customer-facing scope')).to_have_value('My unsaved scope')
        self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual([post['expectedRevision'] for post in self.posts], ['r1', 'r2']); self.assertNotEqual(self.posts[0]['requestId'], self.posts[1]['requestId'])
        self.page.wait_for_function('toasts.length===1'); self.assertEqual([call['event'] for call in self.lifecycle], ['estimate-ready'])

    def test_a_rejected_request_is_discarded_and_the_next_save_is_a_new_request(self):
        self.open('job-approved', 'accept')
        expect(self.page.locator('.em-notice')).to_contain_text('Approved by Synthetic Customer'); expect(self.primary()).to_have_count(0)
        self.page.get_by_role('button', name='Cancel', exact=True).click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.page.evaluate("opsFinanceAction('job-draft','accept')"); expect(self.label('Approved by')).to_have_value('Synthetic Customer')
        self.behaviors = [(409, 'money_estimate_expired', 'This estimate has expired.')]; self.primary().click()
        expect(self.page.get_by_role('alert')).to_contain_text('expired'); expect(self.label('Approved by')).to_be_enabled()
        self.assertEqual(self.lifecycle, [], 'a refused save starts no trigger')
        self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(len(self.posts), 2); self.assertNotEqual(self.posts[0]['requestId'], self.posts[1]['requestId']); self.assertEqual(self.posts[1]['approvedBy'], 'Synthetic Customer')
        self.page.wait_for_function('toasts.length===1')
        self.assertEqual([call['event'] for call in self.lifecycle], ['estimate-approved']); self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Approval saved · Portal text queued in HighLevel')

    def test_invoice_issue_and_void_need_explicit_confirmation_and_a_reason(self):
        self.open('job-invoiced', 'invoice')
        expect(self.page.locator('.em-preview li')).to_have_count(2); expect(self.label('Payment due date')).to_have_value('2026-09-29')
        expect(self.page.locator('.em-preview-total')).to_have_text('Invoice total$1,400.00'); expect(self.page.locator('.em-body')).to_contain_text('Paid $300.00 · balance $1,100.00')
        self.page.get_by_role('button', name='Void this invoice…', exact=True).click()
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('why'); self.assertEqual(self.posts, [])
        self.label('Reason').fill('Customer asked for a split invoice'); self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'reason')}, {'action': 'invoice.void', 'reason': 'Customer asked for a split invoice'})
        self.assertIn('Synthetic warning shown.', self.page.evaluate('toasts.at(-1)')); self.assertIn('nothing was sent to the customer', self.page.evaluate('toasts.at(-1)'))
        self.assertEqual(self.lifecycle, [], 'voiding starts no trigger')

    def test_invoice_preview_shows_the_servers_lines_including_approved_change_orders(self):
        self.open('job-change', 'invoice')
        expect(self.page.locator('.em-preview li')).to_have_count(3)
        expect(self.page.locator('.em-preview li').nth(2)).to_contain_text('Approved change: Haul extra shelving'); expect(self.page.locator('.em-preview li').nth(2)).to_contain_text('$150.00')
        expect(self.page.locator('.em-preview-total')).to_contain_text('$1,550.00')
        self.assertEqual(self.jobs['job-change']['invoicePreview']['totalCents'], 155000)
        for width in [375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 812}); self.assertLessEqual(self.page.evaluate("document.querySelector('.egc-money').scrollWidth"), width)
        (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'money-invoice-320.png'))

    def test_a_billed_change_is_voided_only_with_a_reason_and_nothing_is_sent(self):
        self.open('job-billed', 'invoice')
        change = self.page.locator('.em-line', has_text='Approved change: Haul the old freezer')
        expect(change).to_contain_text('$150.00'); expect(change).to_contain_text('Approved by Synthetic Customer in the portal')
        expect(self.page.locator('.em-preview-total')).to_contain_text('$1,550.00')
        change.scroll_into_view_if_needed(); (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'money-billed-change-375.png'))
        change.get_by_role('button', name='Void this change…', exact=True).click()
        expect(self.page.locator('#em-title')).to_contain_text('Void approved change'); expect(self.primary()).to_have_text('Void change')
        expect(self.page.locator('.em-body')).to_contain_text('The customer is no longer charged for it')
        self.page.get_by_role('button', name='Back', exact=True).click(); expect(self.page.locator('.em-preview-total')).to_be_visible()
        self.page.get_by_role('button', name='Void this change…', exact=True).click()
        self.primary().click(); expect(self.page.get_by_role('alert')).to_contain_text('why the change'); self.assertEqual(self.posts, [])
        self.label('Reason').fill('The crew left the freezer in place')
        for width in [375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 812}); self.assertLessEqual(self.page.evaluate("document.querySelector('.egc-money').scrollWidth"), width)
            heights = self.page.locator('.egc-money button:visible, .egc-money textarea:visible').evaluate_all('els=>els.map(e=>e.getBoundingClientRect().height)')
            self.assertTrue(all(height >= 44 for height in heights), heights)
        (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'money-void-change-320.png'))
        self.primary().click(); expect(self.page.get_by_role('dialog')).to_have_count(0)
        body = self.posts[-1]
        self.assertTrue(UUID.match(body['requestId']))
        self.assertEqual({key: body[key] for key in ('action', 'jobId', 'expectedRevision', 'actorId', 'changeOrderId', 'reason')}, {'action': 'change_order.void', 'jobId': 'job-billed', 'expectedRevision': 'r1', 'actorId': 'zacb', 'changeOrderId': 'change-decision-freezer', 'reason': 'The crew left the freezer in place'})
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Approved change voided · nothing was sent to the customer')

    def test_flag_turned_off_while_the_dialog_is_open_hands_over_to_the_standard_tools(self):
        self.open('job-invoiced', 'payment')
        self.label('Amount received ($)').fill('100'); self.label('Receipt, check or transaction reference').fill('Receipt 9')
        self.behaviors = [(404, 'money_api_disabled', 'Server money actions are turned off. Use the standard finance tools.')]; self.primary().click()
        expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-invoiced', 'payment']])
        self.assertIn('turned off, so this was not saved here', self.page.evaluate('toasts.at(-1)')); self.assertEqual(self.lifecycle, [])
        self.assertIs(self.page.evaluate('window.EGC_FLAGS.moneyApi'), False)
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc.money.pending")).length'), 0)
        self.page.evaluate("opsFinanceAction('job-invoiced','invoice')")
        self.assertEqual(self.page.evaluate('legacyCalls.at(-1)'), ['job-invoiced', 'invoice']); self.assertEqual(self.status_calls, 1); self.assertEqual(len(self.posts), 1)
        # A reload in this tab remembers it was off, so a failed check keeps today's tools.
        self.status_fails = True; self.page.reload(); self.page.evaluate("opsFinanceAction('job-invoiced','payment')")
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-invoiced', 'payment']])

    def test_flag_found_off_when_the_job_loads_opens_the_standard_tool_before_any_typing(self):
        self.server_enabled = False; self.page.goto(self.url); self.page.evaluate("opsFinanceAction('job-draft','estimate')")
        expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertEqual(self.page.evaluate('legacyCalls'), [['job-draft', 'estimate']]); self.assertEqual(self.posts, [])
        self.assertIn('turned off', self.page.evaluate('toasts.at(-1)'))

    def test_an_unreadable_setting_after_it_was_on_runs_neither_path(self):
        self.open('job-draft', 'estimate'); self.page.get_by_role('button', name='Cancel', exact=True).click()
        self.status_fails = True; self.page.reload(); self.page.evaluate("opsFinanceAction('job-draft','payment')")
        self.assertEqual(self.page.evaluate('toasts.at(-1)'), 'Finance settings could not be checked. Retry.')
        expect(self.page.get_by_role('dialog')).to_have_count(0); self.assertEqual(self.page.evaluate('legacyCalls'), []); self.assertEqual(self.gets, ['job-draft'])
        self.status_fails = False; self.page.evaluate("opsFinanceAction('job-draft','payment')"); expect(self.page.get_by_role('dialog')).to_be_visible()

    def test_phone_layout_targets_inputs_and_signout(self):
        self.open()
        for width in [375, 320, 390]:
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            self.assertLessEqual(self.page.evaluate("document.querySelector('.egc-money').scrollWidth"), width)
            heights = self.page.locator('.egc-money button:visible, .egc-money input:visible, .egc-money select:visible').evaluate_all('els=>els.map(e=>e.getBoundingClientRect().height)')
            self.assertTrue(all(height >= 44 for height in heights), heights)
            self.assertNotIn('null', self.page.locator('.em-body').inner_text())
            fonts = self.page.locator('.egc-money input, .egc-money select, .egc-money textarea').evaluate_all('els=>els.map(e=>getComputedStyle(e).fontSize)')
            self.assertTrue(all(font == '16px' for font in fonts), fonts)
        footer = self.page.locator('.em-foot .primary').bounding_box(); self.assertGreater(footer['y'] + footer['height'], 812 - 120, 'the primary action sits within thumb reach')
        (ROOT / 'test-results').mkdir(exist_ok=True); self.page.screenshot(path=str(ROOT / 'test-results' / 'money-estimate-375.png'))
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))'); expect(self.page.get_by_role('dialog')).to_have_count(0)

    def test_untrusted_text_is_rendered_as_text(self):
        self.jobs['job-draft']['customer'] = '<img src=x onerror=window.xss=1>'; self.jobs['job-draft']['lineItems'][0]['name'] = '<b>bold</b>'
        self.open(); expect(self.page.locator('.em-customer')).to_have_text('<img src=x onerror=window.xss=1>')
        self.assertIsNone(self.page.evaluate('window.xss')); expect(self.label('Name').first).to_have_value('<b>bold</b>')

if __name__ == '__main__': unittest.main(verbosity=2)
