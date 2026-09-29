"""One total everywhere (FIX-MONEY-TOTALS): a customer on a phone sees the $1,000 quote, the billed $150 change as its own
line, a $1,150 total, $650 due and a Pay button for exactly what the checkout charges. Every portal answer is produced by
the real handlers (tests/browser/money_totals_fixture.mjs) with MONEY_UNIFIED_TOTALS on or off; the page runs on a paused clock."""
import json, os, pathlib, subprocess, threading, unittest
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)
FIXTURES = json.loads(subprocess.run(['node', 'tests/browser/money_totals_fixture.mjs'], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
PAGE = {}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


def setUpModule():
    (ROOT / 'test-results').mkdir(exist_ok=True)
    PAGE['server'] = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=PAGE['server'].serve_forever, daemon=True).start()
    PAGE['url'] = f"http://127.0.0.1:{PAGE['server'].server_port}"
    PAGE['pw'] = sync_playwright().start()
    options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
    PAGE['browser'] = PAGE['pw'].chromium.launch(headless=True, args=['--no-sandbox'], **options)


def tearDownModule():
    PAGE['browser'].close(); PAGE['pw'].stop(); PAGE['server'].shutdown(); PAGE['server'].server_close()


class MoneyTotalsPortal(unittest.TestCase):
    def open(self, view, width=390, height=844):
        self.context = PAGE['browser'].new_context(viewport={'width': width, 'height': height}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.clock.install(time=NOW); self.page.clock.pause_at(NOW + timedelta(seconds=1))
        self.errors = []; self.posts = []; self.stripe = []; self.view = view
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
        self.page.goto(PAGE['url'] + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()

    def tearDown(self):
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
        self.context.close()

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == 'checkout.stripe.com': self.stripe.append(request.url); route.fulfill(status=200, content_type='text/html', body='<!doctype html><title>Synthetic Stripe</title>'); return
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda status, body: route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET': send(200, self.view); return
            body = request.post_data_json; self.posts.append(body)
            if body.get('action') == 'create_payment': send(200, {'ok': True, 'url': FIXTURES['checkout']['url'], 'amount': FIXTURES['checkout']['amount'], 'purpose': 'balance'}); return
            send(500, {'ok': False, 'error': 'Unexpected request'}); return
        if parsed.path == '/api/customer-portal-document': send(200, {'ok': True, 'kind': 'insurance', 'available': False}); return
        if parsed.path.startswith('/api/'): send(404, {'ok': False}); return
        route.continue_()

    def text(self, selector): return self.page.locator(selector).inner_text().strip()

    def no_sideways_scroll(self):
        width = self.page.evaluate('() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]')
        self.assertLessEqual(max(width[0], width[1]), width[2], f'no horizontal scroll: {width}')

    def test_unified_totals_show_the_billed_change_and_the_pay_button_at_390(self):
        self.open(FIXTURES['unified'])
        self.assertEqual(self.text('#summary-total'), '$1,150.00')
        self.assertEqual(self.text('#summary-balance'), '$650.00')
        self.assertEqual(self.text('#payment-balance'), '$650.00')
        self.assertEqual(self.text('#estimate-total'), '$1,000.00', 'the estimate card keeps the signed quote')
        changes = self.page.locator('#estimate-changes')
        expect(changes).to_be_visible()
        rows = changes.locator('.estimate-line')
        self.assertEqual(rows.count(), 2)
        self.assertIn('Approved change: Haul the old freezer', rows.nth(0).inner_text()); self.assertIn('$150.00', rows.nth(0).inner_text())
        self.assertIn('Total with approved changes', rows.nth(1).inner_text()); self.assertIn('$1,150.00', rows.nth(1).inner_text())
        pay = self.page.locator('#pay-button')
        expect(pay).to_be_visible(); expect(pay).to_be_enabled()
        self.assertEqual(pay.inner_text().strip(), 'Pay $650.00 remaining balance')
        self.assertGreaterEqual(pay.bounding_box()['height'], 44)
        self.assertIn('$650.00 remaining balance due on completion', self.text('#payment-due-now'))
        self.assertIn('Includes $150.00 in approved changes', self.text('#payment-due-now'))
        self.no_sideways_scroll()
        self.page.screenshot(path=str(ROOT / 'test-results' / 'money-totals-portal-390.png'), full_page=True)
        # Pay asks the server for the checkout; the real one charged exactly the $650 shown.
        self.assertEqual(FIXTURES['checkout']['unitAmount'], 65000)
        pay.click()
        for _ in range(200):
            if self.stripe: break
            self.page.wait_for_timeout(20)
        self.assertEqual([post['action'] for post in self.posts], ['create_payment'])
        self.assertEqual(self.stripe, [FIXTURES['checkout']['url']])

    def test_flag_off_keeps_todays_portal(self):
        self.open(FIXTURES['off'])
        self.assertEqual(self.text('#summary-total'), '$1,150.00')
        expect(self.page.locator('#estimate-changes')).to_be_hidden()
        expect(self.page.locator('#pay-button')).to_be_visible()
        self.assertEqual(self.page.locator('#pay-button').inner_text().strip(), 'Pay $650.00 remaining balance')
        self.no_sideways_scroll()

    def test_an_approval_without_a_billed_line_is_not_on_the_balance(self):
        self.open(FIXTURES['unbilled'])
        self.assertEqual(self.text('#summary-total'), '$1,000.00')
        self.assertEqual(self.text('#summary-balance'), '$500.00')
        expect(self.page.locator('#estimate-changes')).to_be_hidden()
        self.assertEqual(self.page.locator('#pay-button').inner_text().strip(), 'Pay $500.00 remaining balance')
        self.no_sideways_scroll()

    def test_amounts_under_review_offer_no_card_payment(self):
        self.open(FIXTURES['review'])
        expect(self.page.locator('#pay-button')).to_be_hidden()
        self.assertIn('The amounts on this project are being reviewed by our team.', self.text('#payment-due-now'))
        self.no_sideways_scroll()

    def test_a_job_with_no_quote_yet_is_not_under_review(self):
        self.assertFalse(FIXTURES['noQuote']['payment']['moneyReview'])
        self.open(FIXTURES['noQuoteOff'])
        today = self.text('#payment-due-now'); self.assertEqual(self.errors, []); self.context.close()
        self.open(FIXTURES['noQuote'])
        self.assertEqual(self.text('#payment-due-now'), today, 'the unpriced job reads as it does today')
        self.assertNotIn('being reviewed', self.text('#payment-due-now'))
        expect(self.page.locator('#pay-button')).to_be_hidden()
        self.no_sideways_scroll()

    def test_the_change_list_fits_a_320_phone(self):
        self.open(FIXTURES['unified'], width=320, height=640)
        expect(self.page.locator('#estimate-changes')).to_be_visible()
        self.no_sideways_scroll()
        box = self.page.locator('#estimate-changes').bounding_box()
        self.assertLessEqual(box['x'] + box['width'], 320)
        self.page.screenshot(path=str(ROOT / 'test-results' / 'money-totals-portal-320.png'), full_page=True)


if __name__ == '__main__':
    unittest.main()
