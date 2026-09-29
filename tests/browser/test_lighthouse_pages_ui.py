"""The Lighthouse harness measures signed-in screens: the real customer portal, business hub and crew Today pages must render
their signed-in views from tests/lighthouse/fixtures through tests/lighthouse/serve.mjs (the server lhci starts), not an
error or sign-in screen. Run: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python3 tests/browser/test_lighthouse_pages_ui.py"""
import datetime, json, os, pathlib, re, shutil, subprocess, threading, unittest
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests' / 'lighthouse' / 'fixtures'
READY = re.compile(r'EGC Lighthouse server listening on (http://127\.0\.0\.1:\d+)')
# The server's fixed clock; 00:00 on Sep 23 in Tokyo while Denver is still on Sep 22.
NOW = datetime.datetime(2026, 9, 22, 15, tzinfo=datetime.timezone.utc)
# 23:30 on Sep 22 in Los Angeles, 00:30 on Sep 23 in Denver: the crew screen must ask for the Mountain date.
CREW_NOW = datetime.datetime(2026, 9, 23, 6, 30, tzinfo=datetime.timezone.utc)
OUT = ROOT / 'test-results' / 'lighthouse-pages'

def fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))

class LighthouseFixturePagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if not node: raise RuntimeError('Node.js is required to start tests/lighthouse/serve.mjs.')
        cls.server = subprocess.Popen([node, str(ROOT / 'tests' / 'lighthouse' / 'serve.mjs')], cwd=ROOT, env={**os.environ, 'LIGHTHOUSE_PORT': '0'},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        timer = threading.Timer(20, cls.server.kill); timer.start()
        line = cls.server.stdout.readline(); timer.cancel()
        match = READY.search(line)
        if not match:
            cls.server.kill(); raise RuntimeError(f'serve.mjs did not report ready: {line!r}')
        cls.url = match.group(1)
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, **options)
        OUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.terminate(); cls.server.wait(10)

    def open(self, path, timezone, now):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=3, is_mobile=True, has_touch=True, timezone_id=timezone)
        self.page = self.context.new_page(); self.page.set_default_timeout(8000)
        self.page.clock.install(time=now)
        # Layout shifts from first paint on; the portal's loading screen must not move the page when the project arrives.
        self.page.add_init_script("window.__shifts=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__shifts.push(entry.value)}).observe({type:'layout-shift',buffered:true});")
        self.errors, self.failed, self.api = [], [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == '127.0.0.1' else route.abort())
        def response(res):
            url = urlparse(res.url)
            if url.hostname != '127.0.0.1': return
            if url.path.startswith('/api/'): self.api.append((res.request.method, url.path, parse_qs(url.query), res.status))
            if res.status >= 400: self.failed.append(f'{res.status} {url.path}')
        self.page.on('response', response)
        self.page.goto(self.url + path)
        return self.page

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.failed, [], 'every same-origin request, fixture API included, succeeds')
        self.assertTrue(self.api and all(status == 200 for _, _, _, status in self.api), self.api)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.context.close()

    def test_customer_portal_shows_the_signed_in_project(self):
        data = fixture('customer-portal')
        page = self.open('/customer-portal', 'Asia/Tokyo', NOW)
        expect(page.locator('#portal')).to_be_visible()
        expect(page.locator('#welcome')).to_have_text(f"Hi {data['customer']['firstName']}—your project is right here.")
        expect(page.locator('#loading')).to_be_hidden(); expect(page.locator('#error')).to_be_hidden()
        expect(page.locator('#summary-service')).to_have_text(data['appointment']['service'])
        expect(page.locator('#appointment-address')).to_have_text(data['appointment']['address'])
        expect(page.locator('#estimate-number')).to_have_text(data['estimate']['number'])
        self.assertIn(('GET', '/api/customer-portal'), [(method, path) for method, path, _, _ in self.api])
        self.assertLess(sum(page.evaluate('window.__shifts')), 0.01, 'the loading screen holds the layout until the project renders')
        page.screenshot(path=str(OUT / 'customer-portal.png'), full_page=True)

    def test_business_hub_shows_the_signed_in_company_overview(self):
        data = fixture('business-hub')
        page = self.open('/business-hub', 'Asia/Tokyo', NOW)
        expect(page.locator('#app')).to_be_visible(); expect(page.locator('#gate')).to_be_hidden()
        expect(page.locator('#company')).to_contain_text(data['account']['company'])
        expect(page.locator('#company')).to_contain_text(data['viewer']['name'])
        expect(page.locator('#heading')).to_have_text('Overview')
        self.assertIn(('GET', '/api/business-hub'), [(method, path) for method, path, _, _ in self.api])
        page.screenshot(path=str(OUT / 'business-hub.png'), full_page=True)

    def test_crew_today_harness_shows_the_current_and_next_job_for_the_mountain_date(self):
        jobs = fixture('field-jobs')['jobs']
        current = next(job for job in jobs if job['status'] == 'in_progress')
        page = self.open('/field-today', 'America/Los_Angeles', CREW_NOW)
        expect(page.get_by_role('heading', name='Today’s jobs')).to_be_visible()
        expect(page.locator('.ft-job.ft-current')).to_have_count(1)
        expect(page.locator('.ft-current')).to_contain_text(current['customer'])
        expect(page.locator('.ft-current')).to_contain_text('CURRENT JOB')
        expect(page.locator('.ft-job').nth(1)).to_contain_text('NEXT JOB')
        field = [query for _, path, query, _ in self.api if path == '/api/field-jobs']
        self.assertTrue(field)
        self.assertEqual(field[0]['date'], ['2026-09-23'], 'the injected clock and Mountain date pick the day, not the browser zone')
        self.assertEqual(page.evaluate('document.querySelectorAll("script[src*=analytics-loader]").length'), 0)
        page.screenshot(path=str(OUT / 'field-today.png'), full_page=True)

if __name__ == '__main__':
    unittest.main()
