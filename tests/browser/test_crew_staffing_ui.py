"""Crew staffing in a real browser at 390 px (and 1280 px). tests/browser/crew_staffing_fixture.mjs mounts the Crew
staffing panel (as Dispatch > Crews & vehicles does) and the Command center line, and runs the REAL
functions/api/crew-staffing.js and functions/api/dispatch.js over synthetic crews and jobs. Checked:
  - crew problems: a crew with no lead, an empty weekend crew, and Sundays no crew works;
  - the unstaffed jobs of the next 14 days, oldest first, with a customer name made of markup shown as text;
  - "Staff waiting jobs" previews the batch, staffs both Thursday jobs and leaves Sunday's untouched;
  - the Command center line and its Fix button;
  - crew get nothing;
  - no money anywhere, no sideways scroll at 390 px, and 44 px tap targets.
Screenshots land in test-results/."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class CrewStaffingScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'crew_staffing_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.url = 'http://127.0.0.1:%d' % json.loads(cls.fixture.stdout.readline())['port']
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.fixture.stdin.close(); cls.fixture.wait(10); cls.fixture.stdout.close()

    def setUp(self):
        self.errors = []; self.context = None
        self.control(reset=True, who='owner')

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def control(self, **body):
        request = urllib.request.Request(self.url + '/__control', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(request).read()

    def jobs(self):
        return json.loads(urllib.request.urlopen(self.url + '/__jobs').read())

    def open(self, width, height=900, mobile=False):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        return page

    def assert_layout(self, page, phone):
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'the page never scrolls sideways')
        text = page.locator('main').inner_text()
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', text))
        self.assertNotIn('$', text, 'no money on the staffing screens')
        if phone:
            small = page.evaluate("""[...document.querySelectorAll('main button')].filter(el => el.offsetParent).filter(el => el.getBoundingClientRect().height < 44).map(el => el.outerHTML.slice(0, 80))""")
            self.assertEqual(small, [])

    def check_panel(self, page):
        panel = page.locator('[data-cs-panel]')
        expect(panel.get_by_role('heading', name='Crew staffing')).to_be_visible()
        expect(panel.locator('[data-cs-problem="crew_no_lead"]')).to_contain_text('Crew 2 has no crew lead')
        expect(panel.locator('[data-cs-problem="crew_no_members"]')).to_contain_text('Crew 3 has no members')
        expect(panel.locator('[data-cs-problem="uncovered_day"]').first).to_contain_text('No staffable crew works Saturdays')
        expect(panel.locator('[data-cs-problem="uncovered_day"]').nth(1)).to_contain_text('No staffable crew works Sundays')
        self.assertEqual(panel.locator('[data-cs-job]').evaluate_all('rows => rows.map(row => row.dataset.csJob)'), ['thu_a', 'thu_b', 'sun'], 'oldest first (then time, then id); the staffed job is not listed')
        expect(panel.locator('[data-cs-job="thu_b"]')).to_contain_text('<img src=x onerror="window.__xss=1">Synthetic Markup')
        self.assertEqual(panel.locator('[data-cs-job="thu_b"] img').count(), 0)
        self.assertIsNone(page.evaluate('window.__xss'))
        expect(panel.locator('[data-cs-job="sun"]')).to_contain_text('No crew')

    def test_phone_390_preview_then_staff_waiting_jobs(self):
        page = self.open(390, 844, mobile=True)
        line = page.locator('[data-cs-line="warn"]')
        expect(line.locator('[data-cs-summary]')).to_have_text('4 crew problems · 3 unstaffed jobs in the next 14 days')
        self.check_panel(page)
        self.assert_layout(page, True)
        page.screenshot(path=str(RESULTS / 'crew-staffing-390.png'), full_page=True)
        page.locator('[data-cs-staff]').click()
        preview = page.locator('[data-cs-preview]')
        expect(preview).to_contain_text("Crew 1 → 1 job, Crew 2 → 1 job; 1 can't be staffed: no staffable crew works Sundays")
        expect(preview).to_contain_text('HighLevel contact note')
        self.assertEqual(self.jobs()['thu_a']['assignedCrew'], [], 'the preview saves nothing')
        page.locator('[data-cs-apply]').click()
        expect(page.locator('[data-cs-done]')).to_contain_text('Staffed 2 of 2.')
        expect(page.locator('[data-cs-done]')).to_contain_text("1 job was not tried: no staffable crew works Sundays")
        expect(page.locator('[data-cs-job="thu_a"] .cs-need')).to_have_count(0)
        expect(page.locator('[data-cs-job="thu_a"] [data-cs-result="assigned"]')).to_have_text('Crew 1 assigned')
        expect(page.locator('[data-cs-job="thu_b"] [data-cs-result="assigned"]')).to_have_text('Crew 2 assigned')
        saved = self.jobs()
        self.assertEqual((saved['thu_a']['crewId'], saved['thu_b']['crewId'], saved['sun']['crewId']), ('crew_one', 'crew_two', None))
        self.assertEqual((saved['thu_a']['date'], saved['thu_a']['time']), ('2026-10-22', '10:00'), 'staffing never moves the visit')
        self.assert_layout(page, True)
        page.screenshot(path=str(RESULTS / 'crew-staffing-390-done.png'), full_page=True)
        page.locator('[data-cs-close]').click()
        self.assertTrue(page.evaluate('window.__applied'))

    def test_desktop_1280_and_the_fix_button(self):
        page = self.open(1280)
        self.check_panel(page)
        self.assert_layout(page, False)
        page.locator('[data-cs-fix]').click()
        self.assertEqual(page.evaluate('window.__went'), ['schedule'])
        page.screenshot(path=str(RESULTS / 'crew-staffing-1280.png'), full_page=True)

    def test_crew_get_nothing(self):
        self.control(who='crew')
        page = self.open(390, 844, mobile=True)
        expect(page.locator('[data-cs-panel] [role="alert"]')).to_contain_text('Only an owner or a manager')
        page.wait_for_function("document.getElementById('home').hidden === true")
        self.assertEqual(page.locator('#home').inner_text(), '')
        self.assertNotIn('Synthetic', page.locator('main').inner_text())


if __name__ == '__main__':
    unittest.main()
