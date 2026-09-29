"""Customer tipping (TIPS): the portal tip chips on a phone, and the crew closeout picker module."""
import copy, json, os, pathlib, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 5, 30, tzinfo=timezone.utc)  # 11:30 PM Sept 21 in Denver, 2:30 PM Sept 22 in Tokyo
CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_synthetic_tip'

def portal_view(payment=None, viewer=None):
    view = {'ok': True, 'viewer': viewer or {'owner': True, 'actorId': '', 'name': '', 'permissions': {'view': True, 'decide': True, 'pay': True, 'rebook': True}},
            'customer': {'name': 'Synthetic Customer', 'firstName': 'Synthetic'},
            'appointment': {'date': '2026-09-21', 'time': '09:00', 'endTime': '12:30', 'arrivalWindow': '9:00 AM – 9:30 AM', 'address': '100 Synthetic Street, Fort Collins', 'service': 'Garage Turnaround', 'status': 'completed'},
            'estimate': {'number': 'EST-0001', 'amount': 800, 'scope': 'Synthetic garage scope.', 'status': 'approved', 'approvedBy': 'Synthetic Customer', 'approvedAt': '2026-09-18T16:00:00.000Z', 'validUntil': '2026-10-15', 'revision': 1, 'depositRequired': 400, 'lineItems': [], 'terms': 'Synthetic terms.', 'termsVersion': '2026-09', 'fingerprint': 'synthetic-fingerprint', 'approvable': True},
            'payment': payment or {'total': 800, 'paid': 300, 'balance': 500, 'dueNow': 500, 'purpose': 'balance', 'needsReview': False, 'status': 'partial', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': '',
                                   'tip': {'available': True, 'maxCents': 50000, 'presets': [10, 15, 20], 'paidCents': 0}},
            'progress': {'status': 'completed', 'activity': ''}, 'photos': {'customerUploadCount': 0}, 'messaging': {'highLevelLinked': False, 'refreshSeconds': 20}, 'conversation': [],
            'review': {'eligible': False, 'url': ''}, 'experience': {'memory': {}, 'jobDayRules': {}, 'decisions': [], 'rebooking': [], 'giftWallet': {'available': 0, 'cards': []}, 'garageGuard': {}, 'collaborators': []},
            'documents': {'termsVersion': '2026-09', 'guarantee': {'title': 'Guarantee', 'sections': []}, 'terms': {'title': 'Service terms', 'sections': []}}, 'support': {'phone': '(970) 999-1818', 'phoneHref': 'tel:+19709991818', 'smsHref': 'sms:+19709991818'}}
    return view

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/tip-harness':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/customer-tip.css"></head><body style="margin:0;padding:16px;font-family:sans-serif"><main id="host"></main><p id="out"></p><script src="/customer-tip.js"></script><script>window.changes=[];window.picker=EGCTip.mount(document.getElementById("host"),{balanceCents:123456,maxCents:61728,idPrefix:"crew-tip",onChange:cents=>{window.changes.push(cents);document.getElementById("out").textContent=String(cents)}})</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class CustomerTipsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'test-results').mkdir(exist_ok=True)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.install(time=NOW)
        self.errors = []; self.posts = []; self.view = portal_view(); self.replies = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if request.url.startswith('https://checkout.stripe.com/'): route.fulfill(status=200, content_type='text/html', body='<!doctype html><title>Synthetic Stripe</title><p>Synthetic checkout</p>'); return
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET': route.fulfill(status=200, content_type='application/json', body=json.dumps(self.view)); return
            self.posts.append(request.post_data_json)
            if self.replies:
                status, body, view = self.replies.pop(0)
                if view: self.view = view
                route.fulfill(status=status, content_type='application/json', body=json.dumps(body)); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'url': CHECKOUT, 'amount': 500, 'purpose': 'balance'})); return
        if parsed.path.startswith('/api/'): route.fulfill(status=404, content_type='application/json', body='{"ok":false}'); return
        route.continue_()
    def assert_mobile(self, scope):
        for width in (320, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        self.page.set_viewport_size({'width': 375, 'height': 812})
        small = self.page.evaluate("""scope => [...document.querySelectorAll(scope)].flatMap(root => [...root.querySelectorAll('button,input'), ...(root.matches('button') ? [root] : [])]).filter(node => node.offsetParent).map(node => [node.id || node.textContent.trim().slice(0, 30), node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""", scope)
        self.assertEqual(small, [], 'every visible tip control is at least 44px tall')
    def open_portal(self):
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()

    def test_preset_chips_add_the_tip_to_the_pay_button_and_the_checkout_request(self):
        self.open_portal(); picker = self.page.locator('#tip-picker'); pay = self.page.locator('#pay-button')
        expect(picker).to_be_visible(); expect(picker.get_by_role('group', name='Add a tip for your crew (optional)')).to_be_visible()
        expect(picker.get_by_role('button', name='No tip')).to_have_attribute('aria-pressed', 'true')
        for label, amount in (('10%', '$50.00'), ('15%', '$75.00'), ('20%', '$100.00')): expect(picker.get_by_role('button', name=f'{label} {amount}')).to_be_visible()
        expect(pay).to_have_text('Pay $500.00 remaining balance')
        picker.get_by_role('button', name='15% $75.00').click()
        expect(picker.get_by_role('button', name='15% $75.00')).to_have_attribute('aria-pressed', 'true'); expect(picker.get_by_role('button', name='No tip')).to_have_attribute('aria-pressed', 'false')
        expect(pay).to_have_text('Pay $575.00 · balance + $75.00 tip'); expect(picker.locator('.egc-tip-summary')).to_have_text('$75.00 tip for your crew, charged with $500.00 balance: $575.00 total.')
        self.page.screenshot(path=str(ROOT / 'test-results' / 'portal-tip-375.png'), full_page=True)
        self.assert_mobile('#tip-picker, #pay-button')
        box = pay.bounding_box(); self.assertGreaterEqual(box['height'], 44)
        # A 20-second refresh re-renders the card and keeps the choice (the closeout note no longer replaces the due-now line).
        self.page.evaluate('load(true)'); expect(pay).to_have_text('Pay $575.00 · balance + $75.00 tip')
        expect(self.page.locator('#payment-due-now')).to_have_text('$500.00 remaining balance due on completion. Your earlier payments are already applied.')
        expect(self.page.locator('#pay-button ~ .closeout-rule')).to_have_count(1)
        pay.click(); self.page.wait_for_url(CHECKOUT)
        self.assertEqual(len(self.posts), 1); self.assertEqual({key: self.posts[0][key] for key in ('action', 'tip_cents')}, {'action': 'create_payment', 'tip_cents': 7500})

    def test_custom_amount_uses_a_decimal_keyboard_and_blocks_an_over_limit_tip(self):
        self.open_portal(); picker = self.page.locator('#tip-picker'); pay = self.page.locator('#pay-button')
        picker.get_by_role('button', name='Custom').click(); field = picker.get_by_label('Tip amount')
        expect(field).to_be_focused(); expect(field).to_have_attribute('inputmode', 'decimal'); expect(field).to_have_attribute('type', 'text')
        self.assertEqual(field.evaluate('node => getComputedStyle(node).fontSize'), '16px')
        field.fill('600'); expect(picker.get_by_role('alert')).to_have_text('A tip can be at most $500.00 on this balance.'); expect(pay).to_be_disabled()
        field.fill('12.345'); expect(picker.get_by_role('alert')).to_contain_text('dollars and cents'); expect(pay).to_be_disabled()
        field.fill('$12.5'); expect(pay).to_be_enabled(); expect(pay).to_have_text('Pay $512.50 · balance + $12.50 tip')
        self.assert_mobile('#tip-picker, #pay-button')
        picker.get_by_role('button', name='No tip').click(); expect(pay).to_have_text('Pay $500.00 remaining balance'); expect(picker.get_by_label('Tip amount')).to_be_hidden()
        pay.click(); self.page.wait_for_url(CHECKOUT)
        self.assertNotIn('tip_cents', self.posts[0], 'no tip sends exactly today\'s request')

    def test_no_tip_on_a_deposit_for_a_viewer_who_cannot_pay_or_while_tips_are_off(self):
        cases = [
            {'total': 800, 'paid': 0, 'balance': 800, 'dueNow': 400, 'purpose': 'deposit', 'needsReview': False, 'status': 'unpaid', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': '', 'tip': {'available': False, 'maxCents': 0, 'presets': [10, 15, 20], 'paidCents': 0}},
            {'total': 800, 'paid': 300, 'balance': 500, 'dueNow': 500, 'purpose': 'balance', 'needsReview': False, 'status': 'partial', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': ''},
        ]
        for payment in cases:
            self.view = portal_view(payment); self.open_portal()
            expect(self.page.locator('#tip-picker')).to_be_hidden(); expect(self.page.locator('#pay-button')).to_be_visible()
        self.view = portal_view(viewer={'owner': False, 'actorId': 'person-1', 'name': 'Synthetic Helper', 'permissions': {'view': True, 'decide': True, 'pay': False, 'rebook': False}}); self.open_portal()
        expect(self.page.locator('#tip-picker')).to_be_hidden(); expect(self.page.locator('#pay-button')).to_be_hidden()

    def test_a_held_card_payment_hides_pay_and_says_the_team_is_reviewing_it(self):
        held = portal_view({'total': 800, 'paid': 300, 'balance': 500, 'dueNow': 0, 'purpose': 'balance', 'needsReview': False, 'status': 'partial', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': '',
                            'held': True, 'tip': {'available': False, 'maxCents': 0, 'presets': [10, 15, 20], 'paidCents': 0}})
        message = 'Your card payment is confirmed. This job was closed, voided or refunded after checkout opened, so our team will review the payment and your tip before applying them. Please do not pay again.'
        # Back from Stripe with a charge the server holds: the portal stays open with the notice, and Pay is gone.
        self.replies.append((409, {'ok': False, 'code': 'payment_tip_refused', 'reviewRecorded': True, 'error': message}, held))
        self.page.goto(self.url + '/customer-portal.html?payment=stripe-success&session_id=cs_test_synthetic_held')
        expect(self.page.locator('#payment-notice')).to_have_text(message)
        expect(self.page.locator('#portal')).to_be_visible(); expect(self.page.locator('#error')).to_be_hidden()
        expect(self.page.locator('#pay-button')).to_be_hidden(); expect(self.page.locator('#tip-picker')).to_be_hidden()
        expect(self.page.locator('#payment-due-now')).to_have_text('Your card payment is being reviewed by our team before it is applied to your balance. Please do not pay again until we contact you.')
        self.assertEqual(self.page.evaluate('location.pathname + location.search'), '/customer-portal')
        self.assertEqual([post['action'] for post in self.posts], ['verify_payment'])
        self.page.screenshot(path=str(ROOT / 'test-results' / 'portal-tip-held-375.png'), full_page=True)
        self.assert_mobile('#payment-notice, #payment-due-now, #tip-picker, #pay-button')
        # A Pay tap that finds the checkout held (another tab) refreshes into the same held state.
        self.view = portal_view()
        # The one checkout refusal while a charge is held (payment_review_open), with tips on carrying reviewRecorded.
        self.replies.append((409, {'ok': False, 'error': 'A recent card payment on this job is being reviewed by our team. Please wait for us to confirm it before paying again.', 'code': 'payment_review_open', 'reviewRecorded': True}, held))
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#pay-button')).to_be_visible()
        self.page.locator('#pay-button').click()
        expect(self.page.locator('#toast')).to_contain_text('being reviewed by our team'); expect(self.page.locator('#pay-button')).to_be_hidden()
        self.assertEqual(self.posts[-1]['action'], 'create_payment')

    def test_the_crew_picker_module_reports_cents_and_follows_a_new_balance(self):
        self.page.goto(self.url + '/tip-harness'); host = self.page.locator('#host')
        expect(host.get_by_role('button', name='10% $123.46')).to_be_visible()
        host.get_by_role('button', name='20% $246.91').click(); expect(self.page.locator('#out')).to_have_text('24691')
        self.page.evaluate('picker.update({balanceCents:100000,maxCents:50000})'); expect(self.page.locator('#out')).to_have_text('20000')
        host.get_by_role('button', name='Custom').click(); host.get_by_label('Tip amount').fill('abc'); expect(self.page.locator('#out')).to_have_text('null')
        self.assertEqual(self.page.evaluate('[EGCTip.parseDollars("1,234.5"), EGCTip.parseDollars(".75"), EGCTip.parseDollars(""), EGCTip.parseDollars("-1"), EGCTip.parseDollars("1.234")]'), [123450, 75, 0, None, None])
        self.page.evaluate('picker.reset()'); expect(self.page.locator('#out')).to_have_text('0')
        self.assertFalse(self.page.evaluate("document.querySelector('#host').innerHTML.includes('<script')"))
        self.assert_mobile('#host')

if __name__ == '__main__':
    unittest.main()
