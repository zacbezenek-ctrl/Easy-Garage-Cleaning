"""Shift swaps (SHIFT-SWAP, employee-shift-swaps.js) in a real browser at 1280 px and 390 px.
tests/browser/shift_swaps_fixture.mjs runs the REAL /api/shift-swaps, whose approval runs the real dispatch save, so the
whole path goes through the server: a crew member asks a coworker, the coworker accepts, and a manager approves on the
Command center card, after which the job's crew has changed. Also: the review card stays empty for crew, no money is
shown, and the phone layout (no sideways scroll, 44 px controls). Screenshots land in test-results/."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class ShiftSwapWidgetTests(unittest.TestCase):
    def setUp(self):
        RESULTS.mkdir(exist_ok=True)
        self.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'shift_swaps_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.url = 'http://127.0.0.1:%d' % json.loads(self.fixture.stdout.readline())['port']
        self.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        self.browser = self.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        self.errors = []; self.context = None

    def tearDown(self):
        if self.context: self.context.close()
        self.browser.close(); self.pw.stop(); self.fixture.stdin.close(); self.fixture.wait(10); self.fixture.stdout.close()
        self.assertEqual(self.errors, [])

    def control(self, **body):
        request = urllib.request.Request(self.url + '/__control', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(request).read()

    def job(self): return json.loads(urllib.request.urlopen(self.url + '/__job').read())

    def open(self, width, height=900):
        if self.context: self.context.close()
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        return page

    def test_request_accept_approve_moves_the_job(self):
        page = self.open(1280)
        home = page.locator('.ss-home')
        expect(home.get_by_role('heading', name='Ask a coworker to take a job')).to_be_visible()
        expect(page.locator('.ss-review')).to_have_count(0)
        home.get_by_label('Coworker').select_option('crew3')
        home.get_by_label('Reason (optional)').fill('Family event')
        home.get_by_role('button', name='Send request').click()
        expect(home).to_contain_text('Waiting for Crew Three')
        self.assertIsNone(re.search(r'\$|Synthetic Customer', page.locator('main').inner_text()))
        page.screenshot(path=str(RESULTS / 'shift-swaps-1280.png'), full_page=True)

        self.control(who='crew3'); page = self.open(1280); home = page.locator('.ss-home')
        expect(home).to_contain_text('Crew One → Crew Three')
        home.get_by_role('button', name='Accept').click()
        expect(home.get_by_role('button', name='Accept')).to_have_count(0)
        self.assertEqual(self.job()['assignedCrew'], ['crew1', 'crew2'], 'accepting changes nothing')

        self.control(who='manager'); page = self.open(1280); review = page.locator('.ss-review')
        expect(review).to_contain_text('Shift swaps to approve (1)')
        expect(review).to_contain_text('Crew One → Crew Three')
        review.get_by_role('button', name='Approve').click()
        expect(page.locator('.ss-review')).to_have_count(0)
        self.assertEqual(self.job(), {'assignedCrew': ['crew3', 'crew2'], 'crewLead': 'crew3'})
        self.assertIn('Approved', page.evaluate('document.body.dataset.toast'))

    def test_phone_layout(self):
        page = self.open(390, 844)
        expect(page.locator('.ss-home').get_by_role('button', name='Send request')).to_be_visible()
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        small = page.evaluate("""[...document.querySelectorAll('.egc-shift-swaps button, .egc-shift-swaps select')].filter(el => el.offsetParent && el.getBoundingClientRect().height < 44).length""")
        self.assertEqual(small, 0)
        page.screenshot(path=str(RESULTS / 'shift-swaps-390.png'), full_page=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
