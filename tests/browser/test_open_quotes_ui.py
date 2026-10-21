"""Open quotes (owner and managers) in a real browser at 1280 px and 390 px. tests/browser/open_quotes_fixture.mjs serves
the screen on its own page and runs the REAL functions/api/open-quotes.js over synthetic sent quotes and one signed
walkthrough, so every figure on screen is the server's: oldest-first order, Denver ages, the five buckets with counts and
totals, the draft-price flag and the 30/90-day close rates with the on-site note. Also: a customer name that is markup
renders as text, "Copy customer portal link" asks the existing endpoint for that job and copies its link (nothing else is
called), estimators and crew get no data, and the phone layout (no sideways scroll, 44 px targets). Screenshots land in
test-results/."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
ORDER = ['q_expired', 'q_cold', 'q_cooling', 'q_warm', 'q_fresh']


class OpenQuotesScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'open_quotes_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.url = 'http://127.0.0.1:%d' % json.loads(cls.fixture.stdout.readline())['port']
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.fixture.stdin.close(); cls.fixture.wait(10); cls.fixture.stdout.close()

    def setUp(self):
        self.errors = []; self.context = None; self.calls = []
        self.control(reset=True, who='owner')

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def control(self, **body):
        request = urllib.request.Request(self.url + '/__control', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(request).read()

    def portal_requests(self):
        return json.loads(urllib.request.urlopen(self.url + '/__portal-requests').read())

    def open(self, width, height=900, mobile=False, ready=True):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, timezone_id='Asia/Tokyo')
        self.context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=self.url)
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('request', lambda request: self.calls.append((request.method, request.url.replace(self.url, ''))) if '/api/' in request.url else None)
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        expect(page.get_by_role('heading', name='Open quotes', exact=True)).to_be_visible()
        if ready: expect(page.locator('tr[data-quote]')).to_have_count(len(ORDER))
        return page

    def row(self, page, job):
        return page.locator(f'tr[data-quote="{job}"]')

    def assert_layout(self, page, phone):
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'the page never scrolls sideways')
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', page.locator('#host').inner_text()))
        if phone:
            small = page.evaluate("""[...document.querySelectorAll('#host button, #host a')].filter(el => el.offsetParent).filter(el => el.getBoundingClientRect().height < 44).map(el => el.outerHTML.slice(0, 80))""")
            self.assertEqual(small, [])

    def check_board(self, page):
        self.assertEqual(page.locator('tr[data-quote]').evaluate_all('rows => rows.map(row => row.dataset.quote)'), ORDER, 'oldest first')
        buckets = {b: page.locator(f'[data-bucket="{b}"]') for b in ['fresh', 'warm', 'cooling', 'cold', 'expired']}
        expect(buckets['fresh']).to_have_text('0–2 days1$2,500.00')
        expect(buckets['warm']).to_have_text('3–7 days1$1,800.00')
        expect(buckets['cooling']).to_have_text('8–14 days1$1,200.00')
        expect(buckets['cold']).to_have_text('15+ days1$4,100.00')
        expect(buckets['expired']).to_have_text('Expired1$900.00')
        expect(page.get_by_text('5 open quotes worth $10,500.00.')).to_be_visible()
        cold = self.row(page, 'q_cold')
        expect(cold.locator('[data-label="Age"]')).to_have_text('21 days')
        expect(cold.locator('[data-label="Valid until"]')).to_have_text('Oct 30, 20269 days left')
        expect(cold.locator('[data-label="Total"]')).to_have_text('$4,100.00')
        expect(cold.locator('[data-label="Estimator"]')).to_have_text('Synthetic.Estimator.One')
        expect(self.row(page, 'q_expired').locator('[data-label="Valid until"]')).to_have_text('Oct 1, 2026Expired')
        expect(self.row(page, 'q_warm').locator('[data-label="Draft prices"]')).to_have_text('Waiting for owner')
        expect(self.row(page, 'q_fresh').locator('[data-label="Draft prices"]')).to_have_text('No')
        expect(self.row(page, 'q_fresh').get_by_role('link', name='Job')).to_have_attribute('href', '/crew/job.html?jobId=q_fresh')
        expect(self.row(page, 'q_fresh').get_by_role('link', name='Walkthrough')).to_have_attribute('href', '/crew/gameplan.html?walkthroughId=walk_q_fresh')
        # A customer name that is markup is shown as text and never runs.
        expect(self.row(page, 'q_cooling').locator('th')).to_contain_text('<img src=x onerror="window.__xss=1">Synthetic Markup')
        self.assertEqual(self.row(page, 'q_cooling').locator('img').count(), 0)
        self.assertIsNone(page.evaluate('window.__xss'))
        # Close rate, 90 days: estimator one sent 5 (4 open, 1 approved after 4 days); estimator two sent 1 and had 1 signed on site.
        ninety = page.locator('[data-window="Close rate, last 90 days"]')
        one = ninety.locator('tr[data-estimator="Synthetic.Estimator.One"]')
        expect(one.locator('[data-label="Sent"]')).to_have_text('5')
        expect(one.locator('[data-label="Closed"]')).to_have_text('1')
        expect(one.locator('[data-label="Close %"]')).to_have_text('20.0%')
        expect(one.locator('[data-label="Avg days to close"]')).to_have_text('4.0')
        two = ninety.locator('tr[data-estimator="Synthetic.Estimator.Two"]')
        expect(two.locator('[data-label="Sent"]')).to_have_text('21 signed on site')
        expect(two.locator('[data-label="Close %"]')).to_have_text('50.0%')
        expect(two.locator('[data-label="Avg days to close"]')).to_have_text('0.0')
        total = ninety.locator('tr[data-estimator="__total"]')
        expect(total.locator('[data-label="Close %"]')).to_have_text('28.6%')
        thirty = page.locator('[data-window="Close rate, last 30 days"]')
        expect(thirty.locator('tr[data-estimator="Synthetic.Estimator.One"] [data-label="Sent"]')).to_have_text('4')
        expect(page.get_by_text('A walkthrough the customer signed on site counts as a quote sent and closed the same day')).to_be_visible()

    def test_desktop_1280_board_buckets_and_close_rates(self):
        page = self.open(1280)
        self.check_board(page)
        self.assert_layout(page, False)
        page.screenshot(path=str(RESULTS / 'open-quotes-1280.png'), full_page=True)

    def test_phone_390_cards_without_sideways_scroll(self):
        page = self.open(390, 844, mobile=True)
        self.check_board(page)
        self.assert_layout(page, True)
        # On a phone the header row is hidden and each cell carries its label.
        expect(self.row(page, 'q_cold').locator('[data-label="Age"]')).to_be_visible()
        page.screenshot(path=str(RESULTS / 'open-quotes-390.png'), full_page=True)

    def test_copy_portal_link_uses_the_existing_endpoint_and_sends_nothing_else(self):
        self.control(who='manager')
        page = self.open(1280)
        self.row(page, 'q_cold').get_by_role('button', name='Copy customer portal link').click()
        expect(page.get_by_role('status')).to_have_text('Private portal link copied for Synthetic Cold Garage With A Very Long Family Name That Wraps. Nothing was sent to them.')
        self.assertEqual(self.portal_requests(), [{'job_id': 'q_cold'}])
        self.assertEqual(page.evaluate('navigator.clipboard.readText()'), self.url + '/api/customer-portal-session?access=synthetic-q_cold')
        self.assertEqual(sorted(set(self.calls)), [('GET', '/api/open-quotes'), ('POST', '/api/customer-portal-link')], 'no send, money or HighLevel request')

    def test_estimators_and_crew_get_no_data(self):
        for who in ['estimator', 'crew']:
            self.control(who=who)
            page = self.open(1280, ready=False)
            expect(page.get_by_role('alert')).to_contain_text('Open quotes are unavailable.')
            self.assertEqual(page.locator('tr[data-quote]').count(), 0)
            self.assertNotIn('Synthetic Fresh Garage', page.locator('#host').inner_text())
            self.context.close(); self.context = None


if __name__ == '__main__':
    unittest.main()
