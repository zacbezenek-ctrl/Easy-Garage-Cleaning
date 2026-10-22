"""Job actuals (owner) in a real browser at 1280 px and 390 px. tests/browser/job_actuals_fixture.mjs serves the screen
on its own page and runs the REAL functions/api/job-actuals.js over synthetic completed jobs and timecards, so every
figure on screen is the server's arithmetic: billed versus actual man-hours, loads, goods at retail, commission by
channel and the margin, which reads "upper bound" until the owner fills every cost setting and is absent without a wage.
Pay figures are synthetic ($10.00 per man-hour, 1% workers' comp), never a real wage. Also: the owner saves
settings in whole cents and basis points, a manager sees them read-only, the CSV export, and the phone layout (no
sideways scroll, 44 px targets, 16 px inputs), and the owner-only Owner targets card (the REAL /api/owner-economics):
synthetic targets, the Cost settings crew wage shown once, Retry/Discard and a conflict. Screenshots land in test-results/."""
import csv, io, json, os, pathlib, re, subprocess, unittest, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'


class JobActualsScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'job_actuals_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
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

    def open(self, width, height=900, mobile=False):
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, accept_downloads=True, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        expect(page.get_by_role('heading', name='Job actuals')).to_be_visible()
        expect(page.locator('tr[data-job]')).to_have_count(4)
        return page

    def row(self, page, job):
        return page.locator(f'tr[data-job="{job}"]')

    def assert_layout(self, page, phone):
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'the page never scrolls sideways')
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', page.locator('#host').inner_text()))
        if phone:
            small = page.evaluate("""[...document.querySelectorAll('#host button, #host input')].filter(el => el.offsetParent).filter(el => el.getBoundingClientRect().height < 44).map(el => el.outerHTML.slice(0, 80))""")
            self.assertEqual(small, [])
            fonts = page.evaluate("""[...document.querySelectorAll('#host input')].map(el => parseFloat(getComputedStyle(el).fontSize))""")
            self.assertTrue(all(size >= 16 for size in fonts), fonts)

    def test_desktop_1280_shows_billed_versus_actual_and_an_upper_bound_margin(self):
        page = self.open(1280)
        expect(page.get_by_text('Margins are an upper bound: 5 of 7 cost settings are blank.')).to_be_visible()
        two_car = self.row(page, 'job-two-car')
        # 2 crew × 9 h on timecards = 18 man-hours against 8 billed; 3 quoted loads; $300.00 of goods at retail.
        expect(two_car.locator('td[data-label="Billed h"]')).to_have_text('8.00')
        expect(two_car.locator('td[data-label="Actual h"]')).to_have_text('18.00Timecards')
        expect(two_car.locator('td[data-label="Variance"]')).to_have_text('+10.00 (+125.0%)')
        expect(two_car.locator('td[data-label="Loads"]')).to_have_text('3Quoted')
        expect(two_car.locator('td[data-label="Goods (retail)"]')).to_have_text('$300.00')
        # Setter 13% + estimator 7% of $4,214.00: $547.82 + $294.98.
        expect(two_car.locator('td[data-label="Commission"]')).to_contain_text('$842.80')
        expect(two_car).to_contain_text('Setter 13% + estimator 7%')
        # Revenue $4,214.00 − 18 h × $10.10 ($181.80) − $300.00 goods = $3,732.20, 88.6%, an upper bound.
        # A third crew member never clocked out (an open shift), so the margin also says its timecards are incomplete.
        expect(two_car.locator('td[data-label="Gross margin"]')).to_have_text('$3,732.20 · 88.6% ≤Timecards incomplete (open shift or review)')
        expect(two_car.locator('td[data-label="Contribution"]')).to_have_text('$2,889.40')
        one_car = self.row(page, 'job-one-car')
        expect(one_car.locator('td[data-label="Actual h"]')).to_have_text('7.00Crew lead')
        expect(one_car.locator('td[data-label="Loads"]')).to_have_text('1Crew lead')
        junk = self.row(page, 'job-junk')
        expect(junk.locator('td[data-label="Billed h"]')).to_have_text('Junk only')
        expect(junk.locator('td[data-label="Actual h"]')).to_have_text('—Not recorded')
        expect(junk.locator('td[data-label="Gross margin"]')).to_have_text('—')
        expect(junk.locator('td[data-label="Commission"]')).to_have_text('$0.00')
        overrun = self.row(page, 'job-overrun')
        expect(overrun).to_have_class('over')
        expect(overrun.locator('td[data-label="Gross margin"]')).to_contain_text('-$53.00')
        last30 = page.get_by_role('region', name='Last 30 days')
        expect(last30).to_contain_text('$5,598.00'); expect(last30).to_contain_text('2 completed jobs')
        expect(last30).to_contain_text('Gross margin (upper bound)')
        expect(page.get_by_role('region', name='Last 90 days')).to_contain_text('4 completed jobs')
        self.assert_layout(page, phone=False)
        page.screenshot(path=str(RESULTS / 'job-actuals-1280.png'), full_page=True)

    def test_phone_390_cards_fit_and_the_owner_fills_the_cost_settings(self):
        page = self.open(390, 844, mobile=True)
        self.assert_layout(page, phone=True)
        page.screenshot(path=str(RESULTS / 'job-actuals-390.png'), full_page=True)
        settings = page.get_by_role('region', name='Cost settings')
        save = settings.get_by_role('button', name='Save cost settings')
        expect(save).to_be_disabled()
        settings.get_by_label('Payroll tax (percent)').fill('7.655')
        expect(settings.get_by_label('Payroll tax (percent)')).to_have_attribute('aria-invalid', 'true'); expect(save).to_be_disabled()
        settings.get_by_label('Payroll tax (percent)').fill('7.65')
        settings.get_by_label('Other burden per man-hour (dollars)').fill('1.50')
        settings.get_by_label('Dump fee per truck load (dollars)').fill('65')
        settings.get_by_label('Truck cost per job (dollars)').fill('$40.00')
        settings.get_by_label('Tax on goods purchases (percent)').fill('7.55')
        expect(save).to_be_enabled()
        with page.expect_request(lambda request: request.method == 'POST') as sent:
            save.click()
        body = sent.value.post_data_json
        self.assertEqual(body['action'], 'job_actuals.settings.set'); self.assertEqual(body['expectedRevision'], 'rev-pay')
        self.assertEqual(body['settings'], {'wageCentsPerManHour': 1000, 'workersCompBp': 100, 'payrollTaxBp': 765, 'burdenCentsPerManHour': 150, 'dumpFeeCentsPerLoad': 6500, 'truckCentsPerJob': 4000, 'goodsTaxBp': 755})
        expect(page.get_by_role('status').filter(has_text='Cost settings saved')).to_be_visible()
        expect(page.get_by_text('Margins are an upper bound')).to_have_count(0)
        two_car = self.row(page, 'job-two-car')
        # 18 h × $12.365 = $222.57; goods $300 + 7.55% = $322.65; 3 loads × $65 = $195; truck $40: $4,214.00 − $780.22 = $3,433.78.
        # Every setting is entered, but the open shift keeps it an upper bound.
        expect(two_car.locator('td[data-label="Gross margin"]')).to_have_text('$3,433.78 · 81.5% ≤Timecards incomplete (open shift or review)Dump cost from quoted loads')
        expect(self.row(page, 'job-one-car').locator('td[data-label="Gross margin"]')).not_to_contain_text('≤')
        self.assert_layout(page, phone=True)
        page.screenshot(path=str(RESULTS / 'job-actuals-390-settings.png'), full_page=True)

    def test_without_a_wage_no_margin_is_shown_and_a_manager_sees_the_settings_read_only(self):
        self.control(reset=True, blank=True, who='manager')
        page = self.open(390, 844, mobile=True)
        settings = page.get_by_role('region', name='Cost settings')
        expect(settings).to_contain_text('Only the owner can change them.')
        expect(settings.locator('input')).to_have_count(0)
        expect(settings).to_contain_text('Not set')
        expect(page.get_by_text('No margins yet: enter the crew wage in Cost settings below.')).to_be_visible()
        expect(self.row(page, 'job-two-car').locator('td[data-label="Gross margin"]')).to_contain_text('No crew wage set')
        expect(self.row(page, 'job-two-car').locator('td[data-label="Gross margin"]')).to_contain_text('—')
        expect(self.row(page, 'job-two-car').locator('td[data-label="Actual h"]')).to_have_text('18.00Timecards')
        # Per-job commission is per-employee pay (FUNNEL-METRICS 8.3): a manager gets no Commission or Contribution
        # column and no Contribution total; hours, revenue and the margin stay.
        expect(page.locator('td[data-label="Commission"], td[data-label="Contribution"]')).to_have_count(0)
        expect(page.locator('.ja-table th', has_text='Commission')).to_have_count(0)
        expect(page.locator('.ja-totals').first).not_to_contain_text('Contribution')
        expect(page.locator('.ja-totals').first).not_to_contain_text('commission')
        expect(self.row(page, 'job-two-car').locator('td[data-label="Revenue"]')).not_to_have_text('—')
        self.assert_layout(page, phone=True)

    def test_an_unconfirmed_save_is_retried_unchanged_or_discarded_never_replaced_by_newer_edits(self):
        page = self.open(390, 844, mobile=True)
        drops = {'left': 1}
        def drop_post(route):
            if route.request.method == 'POST' and drops['left']:
                drops['left'] -= 1; route.abort('connectionreset'); return
            route.continue_()
        page.route('**/api/job-actuals', drop_post)
        settings = page.get_by_role('region', name='Cost settings')
        posts = []
        page.on('request', lambda request: posts.append(request.post_data_json) if request.method == 'POST' else None)
        settings.get_by_label('Truck cost per job (dollars)').fill('40')
        settings.get_by_role('button', name='Save cost settings').click()
        expect(settings.get_by_text('A save was not confirmed')).to_be_visible()
        # New edits cannot be saved while the old request is unconfirmed: the inputs and Save are locked.
        expect(settings.get_by_label('Truck cost per job (dollars)')).to_be_disabled()
        expect(settings.get_by_role('button', name='Save cost settings')).to_be_disabled()
        page.reload(); expect(page.get_by_role('heading', name='Job actuals')).to_be_visible()
        settings = page.get_by_role('region', name='Cost settings')
        expect(settings.get_by_text('A save was not confirmed')).to_be_visible()
        settings.get_by_role('button', name='Retry original save').click()
        expect(page.get_by_role('status').filter(has_text='Cost settings saved')).to_be_visible()
        expect(settings.get_by_text('A save was not confirmed')).to_have_count(0)
        self.assertEqual(len(posts), 2); self.assertEqual(posts[0], posts[1], 'the retry repeats the original request exactly')
        expect(settings.get_by_label('Truck cost per job (dollars)')).to_have_value('40.00')
        # Discard: a second lost save is dropped and the owner can edit again.
        drops['left'] = 1
        settings.get_by_label('Dump fee per truck load (dollars)').fill('65')
        settings.get_by_role('button', name='Save cost settings').click()
        expect(settings.get_by_text('A save was not confirmed')).to_be_visible()
        settings.get_by_role('button', name='Discard unconfirmed save').click()
        expect(settings.get_by_text('A save was not confirmed')).to_have_count(0)
        expect(settings.get_by_label('Dump fee per truck load (dollars)')).to_be_enabled()
        self.assert_layout(page, phone=True)

    def test_edits_survive_a_reload_and_a_conflict_without_undoing_the_other_save(self):
        page = self.open(390, 844, mobile=True)
        drops = {'left': 1}
        def drop_post(route):
            if route.request.method == 'POST' and drops['left']:
                drops['left'] -= 1; route.abort('connectionreset'); return
            route.continue_()
        page.route('**/api/job-actuals', drop_post)
        settings = page.get_by_role('region', name='Cost settings')
        settings.get_by_label('Truck cost per job (dollars)').fill('40')
        settings.get_by_role('button', name='Save cost settings').click()
        expect(settings.get_by_text('A save was not confirmed')).to_be_visible()
        page.reload(); expect(page.get_by_role('heading', name='Job actuals')).to_be_visible()
        settings = page.get_by_role('region', name='Cost settings')
        # The locked inputs show what the unconfirmed save would apply.
        expect(settings.get_by_label('Truck cost per job (dollars)')).to_have_value('40.00')
        expect(settings.get_by_label('Truck cost per job (dollars)')).to_be_disabled()
        self.control(otherSave={'dumpFeeCentsPerLoad': 7000})
        settings.get_by_role('button', name='Retry original save').click()
        expect(settings.get_by_role('alert').filter(has_text='changed elsewhere')).to_be_visible()
        expect(settings.get_by_text('A save was not confirmed')).to_have_count(0)
        expect(settings.get_by_label('Truck cost per job (dollars)')).to_have_value('40.00')
        expect(settings.get_by_label('Dump fee per truck load (dollars)')).to_have_value('70.00')
        with page.expect_request(lambda request: request.method == 'POST') as sent:
            settings.get_by_role('button', name='Save cost settings').click()
        body = sent.value.post_data_json
        self.assertEqual((body['settings']['truckCentsPerJob'], body['settings']['dumpFeeCentsPerLoad']), (4000, 7000), 'the edit is kept and the other save is not undone')
        expect(page.get_by_role('status').filter(has_text='Cost settings saved')).to_be_visible()
        self.assert_layout(page, phone=True)

    def test_the_owner_enters_targets_beside_the_cost_settings_with_the_crew_wage_shown_once(self):
        # Synthetic figures only ($12.00 lead wage, $50 to $75 truck rental, a $1,000 ticket, 40% and 60%), never real targets.
        page = self.open(390, 844, mobile=True)
        owner = page.get_by_role('region', name='Owner targets')
        expect(owner).to_contain_text('Crew wage per hour')
        expect(owner.locator('.ja-setting').first).to_contain_text('$10.00')
        expect(owner.locator('input')).to_have_count(7)
        save = owner.get_by_role('button', name='Save owner targets')
        expect(save).to_be_disabled()
        owner.get_by_label('Lead wage per hour (dollars)').fill('12')
        owner.get_by_label('Truck rental per job, low (dollars)').fill('50')
        owner.get_by_label('Truck rental per job, high (dollars)').fill('75')
        owner.get_by_label('Average ticket target (dollars)').fill('1,000')
        owner.get_by_label('Walkthrough set rate target (percent)').fill('140')
        expect(owner.get_by_label('Walkthrough set rate target (percent)')).to_have_attribute('aria-invalid', 'true'); expect(save).to_be_disabled()
        owner.get_by_label('Walkthrough set rate target (percent)').fill('40')
        owner.get_by_label('Qualified close rate target (percent)').fill('60%')
        with page.expect_request(lambda request: request.method == 'POST') as sent:
            save.click()
        body = sent.value.post_data_json
        self.assertEqual(body['action'], 'owner_economics.settings.set'); self.assertIsNone(body['expectedRevision'])
        self.assertEqual(body['settings'], {'laborCostCentsPerCrewHour': None, 'leadWageCentsPerHour': 1200, 'truckRentalLowCentsPerJob': 5000, 'truckRentalHighCentsPerJob': 7500,
                                            'averageTicketTargetCents': 100000, 'walkthroughSetRateTargetBp': 4000, 'qualifiedCloseRateTargetBp': 6000}, 'a blank stays null, never $0')
        expect(page.get_by_role('status').filter(has_text='Owner targets saved')).to_be_visible()
        expect(owner.get_by_label('Average ticket target (dollars)')).to_have_value('1000.00')
        expect(owner.get_by_label('Labor cost per crew-hour (dollars)')).to_have_value('')
        # A crew wage saved on Cost settings shows on this card: one number, entered once.
        page.get_by_role('region', name='Cost settings').get_by_label('Crew wage per man-hour (dollars)').fill('11')
        page.get_by_role('region', name='Cost settings').get_by_role('button', name='Save cost settings').click()
        expect(page.get_by_role('status').filter(has_text='Cost settings saved')).to_be_visible()
        expect(page.get_by_role('region', name='Owner targets').locator('.ja-setting').first).to_contain_text('$11.00')
        self.assert_layout(page, phone=True)
        page.screenshot(path=str(RESULTS / 'job-actuals-390-owner-targets.png'), full_page=True)

    def test_a_manager_never_sees_or_asks_for_the_owner_targets(self):
        self.control(who='manager')
        requests = []
        self.context = self.browser.new_context(viewport={'width': 1280, 'height': 900})
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('request', lambda request: requests.append(request.url))
        page.goto(self.url + '/')
        expect(page.locator('tr[data-job]')).to_have_count(4)
        expect(page.get_by_role('region', name='Cost settings')).to_contain_text('Only the owner can change them.')
        expect(page.get_by_role('region', name='Owner targets')).to_have_count(0)
        self.assertFalse(any('/api/owner-economics' in url for url in requests))

    def test_an_unconfirmed_owner_targets_save_is_retried_unchanged_and_a_conflict_keeps_the_edit(self):
        page = self.open(390, 844, mobile=True)
        drops = {'left': 1}
        def drop_post(route):
            if route.request.method == 'POST' and drops['left']:
                drops['left'] -= 1; route.abort('connectionreset'); return
            route.continue_()
        page.route('**/api/owner-economics', drop_post)
        posts = []
        page.on('request', lambda request: posts.append(request.post_data_json) if request.method == 'POST' else None)
        owner = page.get_by_role('region', name='Owner targets')
        owner.get_by_label('Lead wage per hour (dollars)').fill('12')
        owner.get_by_role('button', name='Save owner targets').click()
        expect(owner.get_by_text('A save was not confirmed')).to_be_visible()
        expect(owner.get_by_label('Lead wage per hour (dollars)')).to_be_disabled()
        # The Cost settings card keeps working: the two cards never share a pending save.
        expect(page.get_by_role('region', name='Cost settings').get_by_text('A save was not confirmed')).to_have_count(0)
        page.reload(); expect(page.get_by_role('heading', name='Job actuals')).to_be_visible()
        owner = page.get_by_role('region', name='Owner targets')
        expect(owner.get_by_label('Lead wage per hour (dollars)')).to_have_value('12.00')
        owner.get_by_role('button', name='Retry original save').click()
        expect(page.get_by_role('status').filter(has_text='Owner targets saved')).to_be_visible()
        self.assertEqual(len(posts), 2); self.assertEqual(posts[0], posts[1], 'the retry repeats the original request exactly')
        # Another session saves first: the edit is kept and the other save is not undone.
        self.control(otherOwnerSave={'averageTicketTargetCents': 90000})
        owner.get_by_label('Truck rental per job, high (dollars)').fill('75')
        owner.get_by_role('button', name='Save owner targets').click()
        expect(owner.get_by_role('alert').filter(has_text='changed elsewhere')).to_be_visible()
        expect(owner.get_by_label('Truck rental per job, high (dollars)')).to_have_value('75')
        expect(owner.get_by_label('Average ticket target (dollars)')).to_have_value('900.00')
        with page.expect_request(lambda request: request.method == 'POST') as sent:
            owner.get_by_role('button', name='Save owner targets').click()
        body = sent.value.post_data_json
        self.assertEqual((body['settings']['truckRentalHighCentsPerJob'], body['settings']['averageTicketTargetCents'], body['settings']['leadWageCentsPerHour']), (7500, 90000, 1200))
        expect(page.get_by_role('status').filter(has_text='Owner targets saved')).to_be_visible()
        self.assert_layout(page, phone=True)

    def test_an_inverted_truck_range_is_marked_and_a_failed_reload_after_a_save_is_said_and_keeps_the_saved_values(self):
        page = self.open(390, 844, mobile=True)
        owner = page.get_by_role('region', name='Owner targets')
        save = owner.get_by_role('button', name='Save owner targets')
        low, high = owner.get_by_label('Truck rental per job, low (dollars)'), owner.get_by_label('Truck rental per job, high (dollars)')
        low.fill('80'); high.fill('75')
        expect(low).to_have_attribute('aria-invalid', 'true'); expect(high).to_have_attribute('aria-invalid', 'true'); expect(save).to_be_disabled()
        low.fill('50')
        expect(low).to_have_attribute('aria-invalid', 'false'); expect(high).to_have_attribute('aria-invalid', 'false'); expect(save).to_be_enabled()
        # The save lands, then every reload of the card fails: the saved values stay and the card says they may be stale.
        fail = {'on': False}
        def reads(route):
            if route.request.method == 'GET' and fail['on']: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'code': 'owner_economics_unavailable', 'error': 'Synthetic outage'})); return
            if route.request.method == 'POST': fail['on'] = True
            route.continue_()
        page.route('**/api/owner-economics', reads)
        owner.get_by_label('Lead wage per hour (dollars)').fill('12')
        save.click()
        expect(owner.get_by_role('alert').filter(has_text='could not be reloaded')).to_be_visible()
        expect(owner.get_by_label('Lead wage per hour (dollars)')).to_have_value('12.00')
        expect(low).to_have_value('50.00')
        # The next save still carries the stored revision, so it is saved rather than refused as stale.
        fail['on'] = False
        page.unroute('**/api/owner-economics')
        owner.get_by_label('Average ticket target (dollars)').fill('1000')
        with page.expect_response(lambda response: response.request.method == 'POST' and '/api/owner-economics' in response.url) as answer:
            owner.get_by_role('button', name='Save owner targets').click()
        self.assertEqual(answer.value.status, 200)
        expect(page.get_by_role('status').filter(has_text='Owner targets saved')).to_be_visible()
        expect(owner.get_by_role('alert').filter(has_text='could not be reloaded')).to_have_count(0)
        self.assert_layout(page, phone=True)

    def test_csv_export_has_a_row_per_job_with_plain_numbers(self):
        page = self.open(1280)
        with page.expect_download() as download:
            page.get_by_role('button', name='Export CSV').click()
        self.assertEqual(download.value.suggested_filename, 'egc-job-actuals-2026-10-21.csv')
        rows = list(csv.reader(io.StringIO(pathlib.Path(download.value.path()).read_text())))
        self.assertEqual(rows[0][:6], ['Job ID', 'Date', 'Customer', 'Revenue', 'Billed man-hours', 'Actual man-hours'])
        self.assertEqual([row[0] for row in rows[1:]], ['job-two-car', 'job-one-car', 'job-junk', 'job-overrun'])
        overrun = dict(zip(rows[0], rows[4]))
        self.assertEqual(overrun['Gross margin'], '-53.00', 'a negative margin is a number, not a guarded text cell')
        self.assertEqual(overrun['Upper bound'], 'yes')
        two_car = dict(zip(rows[0], rows[1]))
        self.assertEqual([two_car['Revenue'], two_car['Billed man-hours'], two_car['Actual man-hours'], two_car['Commission']], ['4214.00', '8', '18', '842.80'])

    def open_accuracy(self, width, height=900, mobile=False, many=False):
        self.control(accuracy=True, **({'accuracyMany': True} if many else {}))
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, timezone_id='Asia/Tokyo')
        page = self.context.new_page(); page.set_default_timeout(5000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + '/')
        card = page.locator('section.ja-accuracy')
        expect(card.get_by_role('heading', name='Estimator accuracy')).to_be_visible()
        return page, card

    def test_estimator_accuracy_ranks_the_steady_estimator_and_shows_hours_only(self):
        page, card = self.open_accuracy(1280)
        # Est.Alex: 8 -> 8, 8 -> 9, 10 -> 12 and 7.25 -> 7 man-hours: 0%, +12.5%, +20%, -3.4%; average miss 9.0%, under by 7.3%.
        expect(card.get_by_role('status')).to_have_text('Most accurate this month: est.alex — off by 9.0% on average across 4 jobs.')
        alex = card.locator('tr[data-estimator="est.alex"]')
        expect(alex.locator('td[data-label="Jobs"]')).to_have_text('4')
        expect(alex.locator('td[data-label="Average miss"]')).to_have_text('9.0%')
        expect(alex.locator('td[data-label="Tends to"]')).to_have_text('Under by 7.3%')
        expect(alex.locator('td[data-label="Within 10%"]')).to_have_text('50.0%')
        expect(alex.locator('td[data-label="Within 20%"]')).to_have_text('100.0%')
        # One quote is not enough to be ranked, however close or far it was.
        expect(card.locator('tr[data-estimator="sales.sam"]')).to_contain_text('Not ranked: 1 of 3 jobs')
        # Exclusions follow the selected period: the August overrun (no estimator) is outside the last 30 days.
        expect(card).to_contain_text('Not scored in the last 30 days: Timecards incomplete: 1.')
        self.assertNotIn('No estimator on record', card.inner_text())
        self.assertNotIn('$', card.inner_text(), 'the estimator card shows hours only')
        card.get_by_text('Estimate vs actual, job by job').click()
        expect(card.locator('tr[data-accuracy-job="job-acc-3"] td[data-label="Difference"]')).to_have_text('+2.00 h (+20.0%)')
        expect(card.locator('tr[data-accuracy-job="job-acc-4"] td[data-label="Estimator"]')).to_have_text('sales.samSent the quote')
        card.get_by_role('button', name='Last 90 days').click()
        expect(card.get_by_role('table', name='Estimator scorecard, Last 90 days')).to_be_visible()
        expect(card).to_contain_text('No estimator on record: 1')
        page.screenshot(path=str(RESULTS / 'job-actuals-estimator-accuracy-1280.png'), full_page=True)
        self.assert_layout(page, phone=False)

    def test_estimator_accuracy_on_a_phone(self):
        page, card = self.open_accuracy(390, 844, mobile=True)
        expect(card.get_by_role('status')).to_contain_text('Most accurate this month: est.alex')
        card.get_by_text('Estimate vs actual, job by job').click()
        page.screenshot(path=str(RESULTS / 'job-actuals-estimator-accuracy-390.png'), full_page=True)
        self.assert_layout(page, phone=True)

    def test_show_all_and_the_period_buttons_keep_the_job_list_open_and_focus_in_place(self):
        page, card = self.open_accuracy(1280, many=True)
        details = card.locator('details.ja-accuracy-jobs')
        card.get_by_text('Estimate vs actual, job by job').click()
        expect(details).to_have_attribute('open', '')
        expect(details.locator('tbody tr')).to_have_count(20)
        card.get_by_role('button', name=re.compile(r'^Show all \d+ jobs$')).click()
        expect(details).to_have_attribute('open', '')
        self.assertGreater(details.locator('tbody tr').count(), 20)
        expect(details.locator('summary')).to_be_focused()
        card.get_by_role('button', name='Last 90 days').click()
        expect(details).to_have_attribute('open', '')
        expect(card.get_by_role('button', name='Last 90 days')).to_be_focused()
        expect(details.locator('summary')).to_contain_text('in the last 90 days')
        card.get_by_role('button', name='Last 30 days').click()
        expect(details.locator('summary')).to_contain_text('in the last 30 days')
        self.assertEqual(self.errors, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
