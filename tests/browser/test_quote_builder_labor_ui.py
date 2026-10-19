"""The quote builder's Labor row (owner decision D12: man-hours x $40.00) on a phone, against the REAL /api/quote-draft.

tests/browser/quote_builder_fixture.mjs serves crew/quote-draft.js on its own page and runs functions/api/quote-draft.js
and functions/api/walkthrough-handoff.js with EGC_QUOTE_BUILDER_ENABLED over the estimator fixture's in-memory store. The
walkthrough plan is one truck load and a mattress in a medium-full garage: junk only, so no Labor line (owner decision
D-JUNK: "$750 per truck covers the crew's time"). A shelving unit makes it garage work: the server estimates 3 man-hours
($120.00), the set-up and sweep-out and the unit's hour of installing, whatever the crew size; the truck load and the
mattress add none. The customer's line reads "Labor" (D-LABOR-TEXT). Nothing reaches the network: every host but
127.0.0.1 is aborted."""
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
        expect(dialog.locator('.qb-total')).to_contain_text('No Labor line: junk only')
        dialog.get_by_role('button', name='Continue to shelving').click()
        expect(dialog).to_contain_text('Installing them is billed through the Labor line (man-hours × $40.00) on the review step.')
        dialog.get_by_role('button', name='Add HDX plastic shelving, 36×72×24').click()
        expect(dialog.locator('.qb-total')).to_contain_text('Labor $120.00 (3 man-hours)')
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog.locator('.qb-labor h3')).to_have_text('Labor · $120.00')
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
        expect(row.locator('.qb-labor-row')).to_contain_text('3 man-hours × $40.00 = $120.00')
        expect(row).to_contain_text('Estimate: 3 man-hours of crew time (set-up 2 man-hours, installing shelving 1 man-hour), whatever the crew size. Truck loads, special items and access charges are not counted: their own prices pay for loading, hauling and disposal. Pre-filled from the estimate.')
        expect(row).to_contain_text('Installing the shelving and storage is billed through this line.')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,055.70')
        self.assertEqual(self.posts[-1]['compositePricing']['labor'], {'manHours': None, 'adjusted': False, 'fullness': 'medium'})
        self.assertNotIn('rateCents', json.dumps(self.posts[-1]), 'the rate never leaves the browser')
        self.assertNotIn('crewSize', json.dumps(self.posts[-1]), 'nor does a time estimate: the server works it out')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-labor-375.png'), full_page=True)
        # Adjust by total man-hours: the server prices 10.5 man-hours at its own rate.
        row.get_by_role('button', name='Adjust').click()
        expect(dialog.get_by_role('button', name='Save draft')).to_be_disabled()
        field = row.get_by_label('Total man-hours', exact=True)
        expect(field).to_have_value('3')
        field.fill('6.1')
        expect(row.locator('.qb-labor-result')).to_have_text('Enter 0.5 to 200 man-hours in quarter hours.')
        field.fill('10.5')
        expect(row.locator('.qb-labor-result')).to_have_text('= 10.5 man-hours × $40.00 = $420.00')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('10.5 man-hours × $40.00 = $420.00')
        expect(row).to_contain_text('Adjusted by hand from the estimate of 3 man-hours.')
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
        row.get_by_role('button', name='Reset to estimate (3 man-hours)').click()
        expect(row).to_contain_text('Pre-filled from the estimate.')
        expect(row.locator('.qb-labor-row')).to_contain_text('3 man-hours × $40.00 = $120.00')
        expect(row.get_by_role('button', name='Reset to estimate (3 man-hours)')).to_have_count(0)

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
        # The customer's line is one amount (D-LABOR-TEXT); the man-hours stay in the selection and breakdown for the staff.
        self.assertEqual((labor['id'], labor['kind'], labor['name'], labor['description'], labor['totalCents']), ('labor', 'labor', 'Labor', 'Includes installing the shelving and storage.', 37000))
        self.assertEqual(job['quoteDraft']['compositePricing']['labor'], {'manHours': 9.25, 'adjusted': True, 'fullness': 'medium'})
        self.assertEqual((job['quoteDraft']['breakdown']['labor']['prefilledManHours'], job['quoteDraft']['breakdown']['labor']['adjusted']), (3, True))
        self.assertEqual(job['estimate']['amountCents'], 105570 - 12000 + 37000)

    def test_goods_the_estimate_cannot_time_are_named_and_need_the_man_hours_set_by_hand(self):
        self.page.goto(self.url + '/builder-harness')
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.dialog()
        dialog.get_by_role('button', name='Continue to shelving').click()
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_label('Storage group').select_option('overhead')
        add = dialog.locator('.qb-products button.qb-add').first
        name = add.get_attribute('aria-label').removeprefix('Add ')
        add.click()
        expect(dialog.locator('.qb-total')).to_contain_text('Labor $80.00 (2 man-hours)')
        dialog.get_by_role('button', name='Review quote').click()
        gap = dialog.locator('.qb-labor .qb-install-gap')
        expect(gap).to_contain_text('The estimate has no install time for: ' + name)
        expect(gap).to_contain_text('Adjust the man-hours to include installing them. Until you do, this quote can be saved but not sent.')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-install-gap-375.png'), full_page=True)
        row = dialog.locator('.qb-labor')
        row.get_by_role('button', name='Adjust').click()
        row.get_by_label('Total man-hours', exact=True).fill('9')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('9 man-hours × $40.00 = $360.00')
        expect(gap).to_contain_text('You set the man-hours by hand: make sure they include installing these.')
        self.assertEqual(self.posts[-1]['compositePricing']['labor'], {'manHours': 9, 'adjusted': True, 'fullness': 'medium'})

    def test_an_approved_quote_on_an_undated_job_is_saved_and_waits_for_the_job_date_with_one_button(self):
        # The truck load is an approved price and a junk-only quote has no Labor line (D-JUNK), so the real send preview
        # reaches the 25/75 payment dates, which need the job's date: a new quote job has none
        # (quote_draft_payment_dates_pending). Its walkthrough is junk removal only (D-JUNK).
        self.page.goto(self.url + '/builder-harness?plan=junk')
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.dialog()
        dialog.get_by_role('button', name='One fewer: Mattress').click()
        dialog.get_by_role('button', name='Continue to shelving').click()
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog).to_contain_text('Every price on this quote is owner-approved')
        expect(dialog.locator('.qb-labor h3')).to_have_text('Labor · none')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $750.00')
        self.assertNotIn('labor', self.posts[-1]['compositePricing'], 'a junk-only quote sends no labor')
        self.assertLessEqual(dialog.evaluate('node => node.scrollWidth - node.clientWidth'), 0, 'no sideways scroll at phone width')
        self.page.screenshot(path=str(RESULTS / 'quote-builder-junk-only-375.png'), full_page=True)
        dialog.get_by_role('button', name='Save draft').click()
        notice = dialog.locator('[data-held="job-date"]')
        expect(notice).to_contain_text('Sending waits for the job date: the 25% deposit is due when the customer approves the quote, and the 75% balance on the job day.')
        expect(notice).to_contain_text('Ask the office to book this job in Team schedule (To schedule). Then reopen this quote from the walkthrough and choose Send saved quote.')
        self.assertEqual(self.posts[-1]['action'], 'send_preview')
        expect(dialog.locator('.qd-foot button')).to_have_text(['Done'])
        expect(dialog.locator('.qd-error')).to_have_count(0)
        expect(dialog).not_to_contain_text('save it again')
        self.assertGreaterEqual(dialog.get_by_role('button', name='Done').bounding_box()['height'], 44, 'Done is a 44px touch target')
        self.assertLessEqual(dialog.evaluate('node => node.scrollWidth - node.clientWidth'), 0, 'no sideways scroll at phone width')
        self.page.screenshot(path=str(RESULTS / 'quote-builder-waits-for-job-date-375.png'), full_page=True)

    def test_a_junk_only_quote_on_a_walkthrough_that_records_crew_sorting_is_saved_and_held_for_the_estimator(self):
        # D-JUNK: two truck loads ($1,500, approved, no Labor line) on a walkthrough where the crew stages keep / donate /
        # haul zones. The real send preview refuses it (quote_draft_junk_only_garage_work) before the payment dates.
        self.page.goto(self.url + '/builder-harness?plan=zones')
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.dialog()
        expect(dialog.locator('.qb-total')).to_contain_text('No Labor line: junk only')
        dialog.get_by_role('button', name='Continue to shelving').click()
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,500.00')
        expect(dialog.locator('.qb-garage-work')).to_contain_text('sorting into keep / donate / haul zones and resetting what stays. The homeowner cannot sign it, and it cannot be sent, on that walkthrough.')
        expect(dialog).to_contain_text('Every price on this quote is owner-approved, but it cannot be sent while the walkthrough records garage work it does not price (see above). You can save it as a draft.')
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog).to_contain_text('Sending is blocked until you edit this quote and save it again:')
        expect(dialog.locator('.qb-reasons')).to_contain_text('the walkthrough records garage work: sorting into keep / donate / haul zones and resetting what stays. It stays saved as a draft and was not sent.')
        expect(dialog).to_contain_text('The saved draft is kept; no owner approval is needed for this.')
        expect(dialog.locator('.qd-foot button')).to_have_text(['Done', 'Edit quote'])
        expect(dialog.locator('.qd-error')).to_have_count(0)
        self.assertEqual(self.posts[-1]['action'], 'send_preview')
        job = self.state()['jobs'][-1]
        self.assertEqual(job['estimate']['status'], 'draft', 'saved, never sent')
        self.assertLessEqual(dialog.evaluate('node => node.scrollWidth - node.clientWidth'), 0, 'no sideways scroll at phone width')
        self.page.screenshot(path=str(RESULTS / 'quote-builder-junk-garage-work-375.png'), full_page=True)
        dialog.get_by_role('button', name='Edit quote').click()
        expect(dialog.get_by_role('button', name='Continue to shelving')).to_be_visible()


if __name__ == '__main__':
    unittest.main()
