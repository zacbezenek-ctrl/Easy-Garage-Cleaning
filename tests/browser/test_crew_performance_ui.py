"""Crew performance (CREW-PERF) in a real browser at 1280 px and 390 px. tests/browser/crew_performance_fixture.mjs runs
the REAL GET /api/crew-performance over synthetic jobs and timecards, so every figure on screen is the server's: hours on
jobs, jobs worked and led, on-time arrivals against the arrival window, crew hours against the billed Labor line and
issues. Also: the 30/90-day switch, no pay anywhere, the timecards-unavailable notice, a failed Refresh that keeps the last data, a refused crew login and the
phone layout (no sideways scroll, 44 px buttons). Screenshots land in test-results/."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class CrewPerformanceScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'crew_performance_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.url = 'http://127.0.0.1:%d' % json.loads(cls.fixture.stdout.readline())['port']
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.fixture.stdin.close(); cls.fixture.wait(10); cls.fixture.stdout.close()

    def setUp(self):
        self.errors = []; self.context = None
        self.control(who='owner', timecards='ok', api='ok')

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def control(self, **body):
        request = urllib.request.Request(self.url + '/__control', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(request).read()

    def open(self, width, height=900):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        expect(page.get_by_role('heading', name='Crew performance')).to_be_visible()
        return page

    def row(self, page, person): return page.locator(f'tr[data-person="{person}"]')

    def test_desktop_last_30_and_90_days_per_person_with_no_pay(self):
        page = self.open(1280)
        one, two = self.row(page, 'crew.one'), self.row(page, 'crew.two')
        expect(page.locator('tr[data-person]')).to_have_count(2)
        # Crew One: 6 h + 4 h on two jobs, led both, arrived 08:30 and 08:10 inside the 08:00–09:00 window.
        expect(one.locator('td[data-label="Hours on jobs"]')).to_have_text('10.0')
        expect(one.locator('td[data-label="Jobs led"]')).to_have_text('2')
        expect(one.locator('td[data-label="On-time arrivals"]')).to_have_text('2 of 2 (100%)')
        # Both completed jobs sold 8 man-hours (16); the crew worked 6 + 4.83 + 4 = 14.83 actual: 7.3% under billed.
        expect(one.locator('td[data-label="Crew hours vs billed"]')).to_contain_text('under billed · 2 jobs')
        expect(one.locator('td[data-label="Issues"]')).to_have_text('1 closed with issues')
        # Crew Two arrived 09:40, after the window: flagged.
        expect(two.locator('td[data-label="On-time arrivals"]')).to_have_text('0 of 1 (0%)')
        expect(two.locator('td[data-label="On-time arrivals"]')).to_have_class(re.compile('cp-flag'))
        page.get_by_role('button', name='Last 90 days').click()
        expect(two.locator('td[data-label="Jobs worked"]')).to_have_text('2')
        expect(two.locator('td[data-label="On-time arrivals"]')).to_have_text('1 of 2 (50%)')
        text = page.locator('.egc-crew-performance').inner_text()
        self.assertIsNone(re.search(r'\$|\b31\b|rate|wage', text, re.I), 'no pay or money on screen')
        expect(page.locator('.cp-notes')).to_contain_text('Not tracked yet')
        page.screenshot(path=str(RESULTS / 'crew-performance-1280.png'), full_page=True)

    def test_phone_layout_timecards_down_and_a_crew_login_refused(self):
        page = self.open(390, 844)
        expect(page.locator('tr[data-person]')).to_have_count(2)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        small = page.evaluate("""[...document.querySelectorAll('.egc-crew-performance button')].filter(el => el.offsetParent && el.getBoundingClientRect().height < 44).length""")
        self.assertEqual(small, 0)
        page.screenshot(path=str(RESULTS / 'crew-performance-390.png'), full_page=True)
        self.control(timecards='down')
        page.get_by_role('button', name='Refresh').click()
        expect(page.get_by_text('Timecards could not be read')).to_be_visible()
        expect(self.row(page, 'crew.one').locator('td[data-label="Jobs led"]')).to_have_text('2')
        self.control(api='down')
        page.get_by_role('button', name='Refresh').click()
        expect(page.get_by_role('alert')).to_contain_text('Refresh failed')
        expect(self.row(page, 'crew.one')).to_be_visible()
        self.control(who='crew', timecards='ok', api='ok')
        page.reload()
        expect(page.get_by_role('alert')).to_contain_text('Crew performance is unavailable')


if __name__ == '__main__':
    unittest.main(verbosity=2)
