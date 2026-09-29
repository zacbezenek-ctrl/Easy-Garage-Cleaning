"""Change orders (P2-11): a customer approves a priced crew decision on a phone and sees it on the balance."""
import copy, json, os, pathlib, re, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DECISION = {'id': 'decision-freezer', 'title': 'Haul the old freezer', 'details': 'Synthetic crew note: it sits by the side door.', 'photoUrl': '', 'priceDelta': 150, 'timeDeltaMinutes': 20,
            'status': 'pending', 'promptedAt': '2026-09-22T16:00:00.000Z', 'respondedAt': '', 'responseNote': '', 'responseBy': '', 'billed': False}

def portal_view(approved=False, finished=False, closed_reason=None):
    decision = {**DECISION, 'status': 'approved', 'respondedAt': '2026-09-22T18:00:00.000Z', 'responseBy': 'Synthetic Customer', 'billed': True} if approved else {**DECISION, 'closed': finished or bool(closed_reason), **({'closedReason': closed_reason} if closed_reason else {})}
    total, balance = (1150, 650) if approved else (1000, 500)
    return {'ok': True, 'viewer': {'owner': True, 'actorId': '', 'name': '', 'permissions': {'view': True, 'decide': True, 'pay': True, 'rebook': True}, 'jobKey': 'synthetic-job-key'},
            'customer': {'name': 'Synthetic Customer', 'firstName': 'Synthetic'},
            'appointment': {'date': '2026-09-22', 'time': '09:00', 'endTime': '13:00', 'arrivalWindow': '', 'address': '100 Synthetic Street, Fort Collins', 'service': 'Garage Turnaround', 'status': 'in_progress'},
            'estimate': {'number': 'EST-0001', 'amount': 1000, 'scope': 'Synthetic garage reset scope.', 'status': 'approved', 'approvedBy': 'Synthetic Customer', 'approvedAt': '2026-09-20T16:00:00.000Z', 'validUntil': '2026-10-01', 'revision': 2, 'depositRequired': 500,
                         'lineItems': [{'name': 'Synthetic Garage Turnaround', 'description': '', 'quantity': 1, 'amount': 1000}], 'terms': 'Synthetic estimate terms.', 'termsVersion': '2026-09-portal', 'fingerprint': 'synthetic-estimate-fingerprint', 'approvable': True},
            'payment': {'total': total, 'paid': 500, 'balance': balance, 'approvedChanges': 150 if approved else 0, 'dueNow': 0, 'purpose': 'deposit', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': ''},
            'photos': {'customerUploadCount': 0}, 'messaging': {'highLevelLinked': False, 'refreshSeconds': 20}, 'conversation': [], 'review': {'eligible': False, 'url': ''},
            'experience': {'memory': {}, 'jobDayRules': {}, 'decisions': [decision], 'rebooking': [], 'giftWallet': {'available': 0, 'cards': []}, 'garageGuard': {}, 'collaborators': []},
            'documents': {'termsVersion': '2026-09-portal', 'guarantee': {'title': 'Synthetic guarantee', 'sections': []}, 'terms': {'title': 'Synthetic terms', 'sections': []}, 'insurance': {'label': 'Certificate of insurance'}},
            'support': {'phone': '(970) 999-1818', 'phoneHref': 'tel:+19709991818', 'smsHref': 'sms:+19709991818'}}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class PortalChangeOrderBrowserTests(unittest.TestCase):
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
        self.errors = []; self.posts = []; self.approved = False; self.finished = False; self.closed_reason = None; self.replies = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET': route.fulfill(status=200, content_type='application/json', body=json.dumps(portal_view(self.approved, self.finished, self.closed_reason))); return
            self.posts.append(request.post_data_json); reply = self.replies.pop(0) if self.replies else None
            if reply == 'lost': route.abort('connectionfailed'); return
            status, body = reply
            if status == 200: self.approved = True
            route.fulfill(status=status, content_type='application/json', body=json.dumps(body)); return
        route.continue_()
    def assert_mobile(self, scope):
        # 375 and 390 are the supported phone widths (the portal shell itself is 3px wider than 320px today).
        for width in (390, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        small = self.page.evaluate("""scope => [...document.querySelectorAll(scope + ' :is(a,button,input)')].filter(node => node.offsetParent).map(node => [node.textContent.trim() || node.placeholder, node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""", scope)
        self.assertEqual(small, [], 'every visible tap target is at least 44px tall')
        sizes = self.page.evaluate("""scope => [...document.querySelectorAll(scope + ' input')].map(node => getComputedStyle(node).fontSize)""", scope)
        self.assertTrue(sizes and all(size == '16px' for size in sizes), sizes)

    def test_a_priced_change_is_approved_once_after_a_lost_connection_and_shows_on_the_balance(self):
        self.page.goto(self.url + '/customer-portal.html'); card = self.page.locator('#decision-card')
        expect(card).to_be_visible(); expect(card.get_by_role('heading', name='Haul the old freezer')).to_be_visible()
        approve = card.get_by_role('button', name='Approve +$150.00')
        expect(approve).to_be_visible(); expect(card.locator('.impact')).to_contain_text('+$150.00')
        self.assert_mobile('#decision-card')
        card.screenshot(path=str(ROOT / 'test-results' / 'portal-change-order-375.png'))
        card.get_by_placeholder('Your full name').fill('Synthetic Customer'); card.get_by_placeholder('Optional note to the crew').fill('Yes, take it')
        self.replies = ['lost', (200, {'ok': True, 'billed': True, 'replayed': False, 'approvedChangeTotal': 150, 'decision': {**DECISION, 'status': 'approved', 'billed': True}})]
        approve.click()
        expect(self.page.locator('#toast')).to_have_class(re.compile(r'\bbad\b')); expect(approve).to_be_enabled(); expect(approve).to_have_text('Approve +$150.00')
        # The unconfirmed request is kept for this viewer on this job only.
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(key => key.startsWith("egc.portal.decision."))'), ['egc.portal.decision.owner.synthetic-job-key.decision-freezer.approved'])
        approve.click()
        expect(self.page.locator('#toast')).to_have_text('Change approved. $150.00 was added to your balance.')
        expect(card).to_be_hidden()
        expect(self.page.locator('#summary-total')).to_have_text('$1,150.00'); expect(self.page.locator('#payment-balance')).to_have_text('$650.00')
        expect(self.page.locator('#estimate-total')).to_have_text('$1,000.00')
        expect(self.page.locator('#payment-due-now')).to_contain_text('Includes $150.00 in approved changes.')
        self.assertEqual(len(self.posts), 2)
        first, second = self.posts
        self.assertRegex(first['request_id'], UUID); self.assertEqual(second, first, 'the retry repeats the original request exactly')
        self.assertEqual(first, {'action': 'respond_decision', 'decision_id': 'decision-freezer', 'response': 'approved', 'responded_by': 'Synthetic Customer', 'note': 'Yes, take it', 'request_id': first['request_id'], 'price_delta_cents': 15000})
        self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(key => key.startsWith("egc.portal.decision."))'), [], 'a saved answer forgets its request')
        self.page.locator('section.card', has=self.page.locator('#pay-button')).screenshot(path=str(ROOT / 'test-results' / 'portal-change-order-balance-375.png'))

    def test_a_price_the_team_changed_reloads_the_card_before_approval(self):
        self.page.goto(self.url + '/customer-portal.html'); card = self.page.locator('#decision-card')
        card.get_by_placeholder('Your full name').fill('Synthetic Customer')
        self.replies = [(409, {'ok': False, 'code': 'CUSTOMER_PORTAL_DECISION_CHANGED', 'error': 'This change was updated after the page loaded. Refresh and review the current price before approving.'})]
        gets = []; self.page.on('request', lambda request: gets.append(request.url) if request.method == 'GET' and request.url.endswith('/api/customer-portal') else None)
        card.get_by_role('button', name='Approve +$150.00').click()
        expect(self.page.locator('#toast')).to_contain_text('Refresh and review the current price')
        for _ in range(50):
            if gets: break
            self.page.wait_for_timeout(100)
        self.assertTrue(gets, 'the portal reloads the current decision')
        expect(card.get_by_role('button', name='Approve +$150.00')).to_be_enabled()

    def test_a_question_left_open_after_the_crew_finished_cannot_be_approved_here(self):
        self.finished = True; self.page.goto(self.url + '/customer-portal.html'); card = self.page.locator('#decision-card')
        expect(card.get_by_role('heading', name='Haul the old freezer')).to_be_visible(); expect(card.locator('.impact')).to_contain_text('+$150.00')
        expect(card).to_contain_text('The crew has finished this job, so this change can no longer be approved here. Call or text us about it.')
        expect(card.get_by_role('button')).to_have_count(0); expect(card.locator('input')).to_have_count(0)
        for width in (390, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        card.screenshot(path=str(ROOT / 'test-results' / 'portal-change-order-closed-375.png'))
        self.assertEqual(self.posts, [])

    def test_a_closed_job_an_old_question_or_one_under_review_says_why_it_cannot_be_approved_here(self):
        copy = {'closed': 'This job is closed, so this change can no longer be approved here. Call or text us about it.',
                'expired': 'This question was sent a while ago, so this change can no longer be approved here. Call or text us about it.',
                'review': 'Our team needs to review this change before it can be answered here. Call or text us about it.'}
        for reason, text in copy.items():
            self.closed_reason = reason; self.page.goto(self.url + '/customer-portal.html'); card = self.page.locator('#decision-card')
            expect(card.get_by_role('heading', name='Haul the old freezer')).to_be_visible(); expect(card).to_contain_text(text)
            expect(card.get_by_role('button')).to_have_count(0); expect(card.locator('input')).to_have_count(0)
            for width in (390, 375):
                self.page.set_viewport_size({'width': width, 'height': 812})
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px ({reason})')
        card.screenshot(path=str(ROOT / 'test-results' / 'portal-change-order-review-375.png'))
        self.assertEqual(self.posts, [])

if __name__ == '__main__':
    unittest.main()
