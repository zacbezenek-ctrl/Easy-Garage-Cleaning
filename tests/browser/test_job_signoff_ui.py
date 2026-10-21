"""Needs sign-off (SIGNOFF, employee-job-signoff.js) in a real browser at 1280 px and 390 px. tests/browser/job_signoff_fixture.mjs
runs the REAL /api/job-signoff over synthetic completed jobs, so the list, the 48-hour flag, the own-job rule, Sign off
and Flag all go through the server. Also: no money on screen, a crew login sees no card, and the phone layout (no
sideways scroll, 44 px buttons). Screenshots land in test-results/."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class JobSignoffWidgetTests(unittest.TestCase):
    def setUp(self):
        RESULTS.mkdir(exist_ok=True)
        # A fresh fixture per test: sign-offs are saved in its in-memory store.
        self.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'job_signoff_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
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

    def open(self, width, height=900):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        return page

    def test_desktop_sign_off_and_flag_through_the_server(self):
        page = self.open(1280)
        widget = page.locator('.egc-job-signoff')
        expect(widget).to_contain_text('3 waiting · 1 over 48 h')
        self.assertEqual(page.locator('[data-so-job]').evaluate_all('rows => rows.map(row => row.dataset.soJob)'), ['old', 'fresh', 'mine'], 'oldest first')
        old = page.locator('[data-so-job="old"]')
        expect(old).to_contain_text('Over 48 h'); expect(old).to_contain_text('Completed 2 days ago')
        expect(old.get_by_role('link', name='Open job')).to_have_attribute('href', '/crew/job.html?jobId=old')
        mine = page.locator('[data-so-job="mine"]')
        expect(mine).to_contain_text('You worked this job'); expect(mine.get_by_role('button', name='Sign off')).to_have_count(0)
        self.assertIsNone(re.search(r'\$|1500|Johnson Family|Older Garage', widget.inner_text()), 'first name and last initial only, no money')
        page.screenshot(path=str(RESULTS / 'job-signoff-1280.png'), full_page=True)
        old.get_by_role('button', name='Sign off').click()
        expect(page.locator('[data-so-job="old"]')).to_have_count(0)
        expect(widget).to_contain_text('2 waiting')
        fresh = page.locator('[data-so-job="fresh"]')
        fresh.get_by_role('button', name='Needs follow-up').click()
        fresh.get_by_role('textbox').fill('ok')
        fresh.get_by_role('button', name='Send to crew lead').click()
        expect(widget.get_by_role('alert')).to_contain_text('Say what needs fixing')
        expect(fresh.get_by_role('textbox')).to_have_value('ok', timeout=2000)
        fresh.get_by_role('textbox').fill('Shelving left unanchored')
        fresh.get_by_role('button', name='Send to crew lead').click()
        expect(page.locator('[data-so-job="fresh"]')).to_contain_text('Needs follow-up (Synthetic Manager): Shelving left unanchored')
        expect(page.locator('[data-so-job="fresh"]')).to_contain_text('Open crew follow-up')
        expect(page.locator('[data-so-job="fresh"]').get_by_role('button', name='Needs follow-up')).to_have_count(0)
        expect(widget).to_contain_text('1 waiting · 1 needs follow-up')
        # The crew lead (crew.one) sees it on My day, with the reason; before, their card stayed hidden.
        self.control(who='crew')
        lead = self.context.new_page(); lead.on('pageerror', lambda error: self.errors.append(str(error)))
        lead.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        lead.goto(self.url + '/lead')
        card = lead.locator('.so-followups')
        expect(card).to_contain_text('Supervisor follow-ups (1)')
        expect(card).to_contain_text('Shelving left unanchored')
        expect(card.get_by_role('link', name='Open job')).to_have_attribute('href', '/crew/job.html?jobId=fresh')
        self.assertIn('new follow-up', page.evaluate('document.body.dataset.toast'))

    def test_phone_layout_and_a_crew_login_sees_nothing(self):
        page = self.open(390, 844)
        expect(page.locator('[data-so-job]')).to_have_count(3)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        small = page.evaluate("""[...document.querySelectorAll('.egc-job-signoff button, .egc-job-signoff a.hub-btn')].filter(el => el.offsetParent && el.getBoundingClientRect().height < 44).length""")
        self.assertEqual(small, 0)
        page.screenshot(path=str(RESULTS / 'job-signoff-390.png'), full_page=True)
        self.control(who='crew')
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(page.locator('.egc-job-signoff')).to_have_count(0)
        # A crew lead with no follow-ups gets a hidden, empty card.
        page.goto(self.url + '/lead')
        page.wait_for_load_state('networkidle')
        self.assertTrue(page.evaluate("document.getElementById('host').hidden && !document.getElementById('host').children.length"))


if __name__ == '__main__':
    unittest.main(verbosity=2)
