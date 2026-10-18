"""The quote builder's Labor row (owner decision D12: man-hours x $40.00) on a phone, against the REAL /api/quote-draft.

tests/browser/quote_builder_fixture.mjs serves crew/quote-draft.js on its own page and runs functions/api/quote-draft.js
and functions/api/walkthrough-handoff.js with EGC_QUOTE_BUILDER_ENABLED over the estimator fixture's in-memory store. The
walkthrough plan is a crew of 2 for 4 hours on site, so the server pre-fills 8 man-hours ($320.00). Nothing reaches the
network: every host but 127.0.0.1 is aborted."""
import json, os, pathlib, subprocess, unittest, urllib.request
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class QuoteBuilderLaborTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'quote_builder_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.url = 'http://127.0.0.1:%d' % json.loads(cls.fixture.stdout.readline())['port']
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.fixture.stdin.close(); cls.fixture.wait(10); cls.fixture.stdout.close()

    def setUp(self):
        self.errors = []; self.posts = []
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='America/Denver')
        self.page = self.context.new_page(); self.page.set_default_timeout(10000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('request', lambda request: self.posts.append(json.loads(request.post_data)) if request.method == 'POST' and urlparse(request.url).path == '/api/quote-draft' else None)
        self.page.route('**/*', lambda route: route.abort() if urlparse(route.request.url).hostname != '127.0.0.1' else route.continue_())

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def state(self):
        with urllib.request.urlopen(self.url + '/__state', timeout=30) as response: return json.loads(response.read())

    def dialog(self): return self.page.locator('dialog.qd-dialog')

    def review(self):
        self.page.goto(self.url + '/builder-harness')
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.dialog()
        expect(dialog).to_contain_text('Build the itemized quote')
        expect(dialog.locator('.qb-total')).to_contain_text('Labor $320.00 (8 man-hours)')
        dialog.get_by_role('button', name='Continue to shelving').click()
        expect(dialog).to_contain_text('Installing them is billed through the Labor line (man-hours × $40.00) on the review step.')
        dialog.get_by_role('button', name='Add HDX plastic shelving, 36×72×24').click()
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog.locator('.qb-labor h3')).to_have_text('Labor · $320.00')
        return dialog

    def assert_fits(self, dialog):
        overflow = dialog.evaluate('node => node.scrollWidth - node.clientWidth')
        self.assertLessEqual(overflow, 0, 'no sideways scroll at phone width')
        for name in ['Adjust', 'Apply man-hours', 'Save draft']:
            button = dialog.get_by_role('button', name=name, exact=True)
            if button.count(): self.assertGreaterEqual(button.bounding_box()['height'], 44, f'{name} is a 44px touch target')
        for field in dialog.locator('.qb-labor-edit input, .qb-labor-edit select').all():
            box = field.bounding_box()
            self.assertLessEqual(box['x'] + box['width'], 375, 'every labor field fits the phone')

    def test_labor_row_prefills_from_the_estimate_and_adjusts_by_total_or_people_times_hours(self):
        dialog = self.review()
        row = dialog.locator('.qb-labor')
        expect(row.locator('.qb-labor-row')).to_contain_text('8 man-hours × $40.00 = $320.00')
        expect(row).to_contain_text('Estimate: a crew of 2 × 4 hours on site = 8 man-hours. Pre-filled from the estimate.')
        expect(row).to_contain_text('Installing the shelving and storage is billed through this line.')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,255.70')
        self.assertEqual(self.posts[-1]['compositePricing']['labor'], {'manHours': None, 'estimate': {'crewSize': 2, 'onSiteMinutes': 240}})
        self.assertNotIn('rateCents', json.dumps(self.posts[-1]), 'the rate never leaves the browser')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-labor-375.png'), full_page=True)
        # Adjust by total man-hours: the server prices 10.5 man-hours at its own rate.
        row.get_by_role('button', name='Adjust').click()
        expect(dialog.get_by_role('button', name='Save draft')).to_be_disabled()
        field = row.get_by_label('Total man-hours', exact=True)
        expect(field).to_have_value('8')
        field.fill('6.1')
        expect(row.locator('.qb-labor-result')).to_have_text('Enter 0.5 to 200 man-hours in quarter hours.')
        field.fill('10.5')
        expect(row.locator('.qb-labor-result')).to_have_text('= 10.5 man-hours × $40.00 = $420.00')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('10.5 man-hours × $40.00 = $420.00')
        expect(row).to_contain_text('Adjusted from the estimate of 8 man-hours.')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,355.70')
        self.assertEqual(self.posts[-1]['compositePricing']['labor']['manHours'], 10.5)
        # People × hours: 3 people × 2.5 hours on site each.
        row.get_by_role('button', name='Adjust').click()
        row.get_by_label('By people × hours').check()
        row.get_by_label('People', exact=True).select_option('3')
        row.get_by_label('Hours on site each').fill('2.5')
        expect(row.locator('.qb-labor-result')).to_have_text('= 7.5 man-hours × $40.00 = $300.00')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-labor-adjust-375.png'), full_page=True)
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('7.5 man-hours × $40.00 = $300.00')
        # Back to the estimate.
        row.get_by_role('button', name='Reset to estimate (8 man-hours)').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('8 man-hours × $40.00 = $320.00')
        expect(row.get_by_role('button', name='Reset to estimate (8 man-hours)')).to_have_count(0)

    def test_the_saved_draft_keeps_the_estimators_man_hours_and_the_server_prices_them(self):
        dialog = self.review()
        row = dialog.locator('.qb-labor')
        row.get_by_role('button', name='Adjust').click()
        row.get_by_label('Total man-hours', exact=True).fill('9.25')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('9.25 man-hours × $40.00 = $370.00')
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog).to_contain_text('Draft ')
        expect(dialog).to_contain_text('saved.')
        job = self.state()['jobs'][-1]
        labor = job['estimate']['lineItems'][-1]
        self.assertEqual((labor['id'], labor['kind'], labor['name'], labor['totalCents']), ('labor', 'labor', 'Labor: 9.25 man-hours × $40.00', 37000))
        self.assertEqual(job['quoteDraft']['compositePricing']['labor'], {'manHours': 9.25, 'estimate': {'crewSize': 2, 'onSiteMinutes': 240}})
        self.assertEqual((job['quoteDraft']['breakdown']['labor']['prefilledManHours'], job['quoteDraft']['breakdown']['labor']['adjusted']), (8, True))
        self.assertEqual(job['estimate']['amountCents'], 125570 - 32000 + 37000)


if __name__ == '__main__':
    unittest.main()
