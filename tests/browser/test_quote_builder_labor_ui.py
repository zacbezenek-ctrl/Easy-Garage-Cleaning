"""The quote builder's Labor row (owner decision D12: man-hours x $53.00, the rate of 2026-10-19) on a phone, against the REAL /api/quote-draft.

tests/browser/quote_builder_fixture.mjs serves crew/quote-draft.js on its own page and runs functions/api/quote-draft.js
and functions/api/walkthrough-handoff.js with EGC_QUOTE_BUILDER_ENABLED over the estimator fixture's in-memory store. The
walkthrough plan is one truck load and a mattress in a medium-full garage: junk only, so no Labor line (owner decision
D-JUNK: "$750 per truck covers the crew's time"). A shelving unit makes it garage work: the server estimates 3 man-hours
($159.00), the set-up and sweep-out and the unit's hour of installing, whatever the crew size; the truck load and the
mattress add none. The customer's line reads "Labor" (D-LABOR-TEXT). Nothing reaches the network: every host but
127.0.0.1 is aborted."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
# Stands in for the gstatic Firebase compat scripts on the walkthrough page (every external host is aborted): sign-in
# succeeds and today's walkthrough list is empty.
FIREBASE_STUB = """
window.firebase = window.firebase || {
  apps: [], initializeApp() { this.apps.push({}); },
  auth() { return { signInWithCustomToken: async () => ({}), signOut: async () => {} }; },
  firestore() { return { collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), doc: id => ({ get: async () => ({ id, exists: false }) }) }) }; },
};
"""
# Walkthrough 2 of the estimator fixture (its customer, CRM contact and source walkthrough), on the 2-car garage it was
# first recorded as: 1.25 truck loads, a deep clean, sorted with the customer.
WALKTHROUGH = {'sourceWalkthroughId': 'w2', 'highlevelContactId': 'provider2', 'name': 'Synthetic Customer 2', 'phone': '9705550102', 'email': 'customer2@example.invalid',
    'address': '200 Fixture Lane', 'whyNow': 'Moving soon', 'outcome': 'Park two cars', 'truckPlacement': 'Driveway', 'garageSize': '2', 'fill': 'medium', 'loads': '1.25',
    'special': [], 'access': [], 'hazards': [], 'sortMethod': 'customer', 'finish': ['cleanout', 'deep_clean'], 'jobDate': '2026-10-19', 'startTime': '09:30', 'endTime': '12:30', 'crewSize': 2}
SHELF = 'HDX plastic shelving, 36×72×24'


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
        expect(dialog).to_contain_text('Installing them is billed through the Labor line (man-hours × $53.00) on the review step.')
        dialog.get_by_role('button', name='Add HDX plastic shelving, 36×72×24').click()
        expect(dialog.locator('.qb-total')).to_contain_text('Labor $159.00 (3 man-hours)')
        dialog.get_by_role('button', name='Continue to extra storage').click()
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog.locator('.qb-labor h3')).to_have_text('Labor · $159.00')
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

    def test_the_builder_opens_with_the_walkthrough_finish_picks_and_product_rows_stay_in_the_app(self):
        # LANE catalog: shelving and totes picked on the walkthrough's Finish step open in the builder already chosen.
        self.page.goto(self.url + '/builder-harness')
        tote = self.page.evaluate("fetch('/api/quote-draft?view=builder').then(r => r.json()).then(menu => menu.products.find(item => item.group === 'bins-totes'))")
        self.page.evaluate("tote => { window.GOODS = { shelving: [{ id: 'hd-100006678', quantity: 2 }], storage: [{ id: tote.id, quantity: 1 }] }; }", tote)
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.dialog()
        expect(dialog.locator('.qb-total')).to_contain_text('Shelving $231.40')
        expect(dialog.locator('.qb-total')).to_contain_text('Storage $%s' % format(tote['unitCents'] / 100, ',.2f'))
        dialog.get_by_role('button', name='Continue to shelving').click()
        expect(dialog).to_contain_text('In this quote (1)')
        expect(dialog.get_by_role('group', name='HDX plastic shelving, 36×72×24 quantity').locator('output')).to_have_text('2')
        # The size in the row, the fit notes one tap away; no product page, no new tab.
        row = dialog.locator('li.qb-product.on')
        expect(row.locator('.qb-size')).to_have_text('36 W × 72 H × 24 D in')
        notes = row.locator('details.qb-fit')
        expect(notes.locator('summary')).to_have_text('Fit notes')
        expect(notes.locator('p')).not_to_be_visible()
        self.assertGreaterEqual(notes.locator('summary').bounding_box()['height'], 44, 'Fit notes is a 44px touch target')
        notes.locator('summary').click()
        expect(notes.locator('p')).to_contain_text('14.86 in fixed shelf spacing')
        expect(dialog.locator('a')).to_have_count(0)
        dialog.get_by_role('button', name='One more: HDX plastic shelving, 36×72×24').click()
        # LANE catalog review: a change not saved stays in the builder; the walkthrough hears only what is saved.
        self.assertIsNone(self.page.evaluate('window.MIRRORED || null'))
        dialog.get_by_role('button', name='Continue to extra storage').click()
        expect(dialog).to_contain_text('In this quote (1)')
        self.assertEqual(self.posts[-1]['compositePricing']['shelving'], [{'id': 'hd-100006678', 'quantity': 3}], 'the server priced the picks')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-finish-picks-mobile.png'), full_page=True)
        dialog.get_by_role('button', name='Review quote').click()
        expect(dialog.locator('.qb-labor h3')).to_contain_text('Labor')
        self.assertIsNone(self.page.evaluate('window.MIRRORED || null'))
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog).to_contain_text('saved.')
        mirrored = self.page.evaluate('window.MIRRORED')
        self.assertEqual([(row['id'], row['quantity'], row['group']) for row in mirrored['shelving']], [('hd-100006678', 3, 'shelving')])
        self.assertEqual([(row['id'], row['quantity'], row['group']) for row in mirrored['storage']], [(tote['id'], 1, 'bins-totes')])

    def test_labor_row_prefills_from_the_estimate_and_adjusts_by_total_or_people_times_hours(self):
        dialog = self.review()
        row = dialog.locator('.qb-labor')
        expect(row.locator('.qb-labor-row')).to_contain_text('3 man-hours × $53.00 = $159.00')
        expect(row).to_contain_text('Estimate: 3 man-hours of crew time (set-up 2 man-hours, installing shelving 1 man-hour), whatever the crew size. Truck loads, special items and access charges are not counted: their own prices pay for loading, hauling and disposal. Pre-filled from the estimate.')
        expect(row).to_contain_text('Installing the shelving and storage is billed through this line.')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,094.70')
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
        expect(row.locator('.qb-labor-result')).to_have_text('= 10.5 man-hours × $53.00 = $556.50')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('10.5 man-hours × $53.00 = $556.50')
        expect(row).to_contain_text('Adjusted by hand from the estimate of 3 man-hours.')
        expect(dialog.locator('.qd-total')).to_have_text('Quote total $1,492.20')
        self.assertEqual(self.posts[-1]['compositePricing']['labor']['manHours'], 10.5)
        # People × hours: 3 people × 2.5 hours on site each.
        row.get_by_role('button', name='Adjust').click()
        row.get_by_label('By people × hours').check()
        row.get_by_label('People', exact=True).select_option('3')
        row.get_by_label('Hours on site each').fill('2.5')
        expect(row.locator('.qb-labor-result')).to_have_text('= 7.5 man-hours × $53.00 = $397.50')
        self.assert_fits(dialog)
        self.page.screenshot(path=str(RESULTS / 'quote-builder-labor-adjust-375.png'), full_page=True)
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('7.5 man-hours × $53.00 = $397.50')
        # Back to the estimate.
        row.get_by_role('button', name='Reset to estimate (3 man-hours)').click()
        expect(row).to_contain_text('Pre-filled from the estimate.')
        expect(row.locator('.qb-labor-row')).to_contain_text('3 man-hours × $53.00 = $159.00')
        expect(row.get_by_role('button', name='Reset to estimate (3 man-hours)')).to_have_count(0)

    def test_the_saved_draft_keeps_the_estimators_man_hours_and_the_server_prices_them(self):
        dialog = self.review()
        row = dialog.locator('.qb-labor')
        row.get_by_role('button', name='Adjust').click()
        row.get_by_label('Total man-hours', exact=True).fill('9.25')
        row.get_by_role('button', name='Apply man-hours').click()
        expect(row.locator('.qb-labor-row')).to_contain_text('9.25 man-hours × $53.00 = $490.25')
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog).to_contain_text('Draft ')
        expect(dialog).to_contain_text('saved.')
        job = self.state()['jobs'][-1]
        labor = job['estimate']['lineItems'][-1]
        # The customer's line is one amount (D-LABOR-TEXT); the man-hours stay in the selection and breakdown for the staff.
        self.assertEqual((labor['id'], labor['kind'], labor['name'], labor['description'], labor['totalCents']), ('labor', 'labor', 'Labor', 'Includes installing the shelving and storage.', 49025))
        self.assertEqual(job['quoteDraft']['compositePricing']['labor'], {'manHours': 9.25, 'adjusted': True, 'fullness': 'medium'})
        self.assertEqual((job['quoteDraft']['breakdown']['labor']['prefilledManHours'], job['quoteDraft']['breakdown']['labor']['adjusted']), (3, True))
        self.assertEqual(job['estimate']['amountCents'], 109470 - 15900 + 49025)

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
        expect(dialog.locator('.qb-total')).to_contain_text('Labor $106.00 (2 man-hours)')
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
        expect(row.locator('.qb-labor-row')).to_contain_text('9 man-hours × $53.00 = $477.00')
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

    # ---- LANE catalog review: the real walkthrough page with the real builder, quote drafts and signed handoff ----
    def walkthrough(self):
        page = self.page
        page.add_init_script(FIREBASE_STUB)
        page.clock.install(time='2026-10-17T15:00:00Z')
        page.goto(self.url + '/crew/gameplan.html'); expect(page.locator('#app')).to_be_visible()
        page.wait_for_function('() => PRICING !== null && quoteBuilderOn() && EGCGameplanCatalog.menu() !== null')
        # Three walkthrough photos stored on this device exactly as the Photos step keeps them.
        page.evaluate("""async () => { S.jobId = S.jobId || 'synthetic-draft'; const db = await dbOpen();
          await new Promise(done => { const tx = db.transaction('p', 'readwrite'); for (let i = 0; i < 3; i++) tx.objectStore('p').put({ id: 'synthetic-photo-' + i, job: S.photoDraftJobId || S.jobId, tag: 'before', dataUrl: 'data:image/jpeg;base64,/9j/', at: i }); tx.oncomplete = done; });
          await refreshPhotoCount(); }""")
        page.evaluate('s => { Object.assign(S, s); save(); index = 3; render(); }', WALKTHROUGH)
        return page

    def step(self, index): self.page.evaluate('i => { index = i; render(); }', index)

    def sign(self):
        page = self.page
        page.locator('#approved').check()
        canvas = page.locator('#signature'); canvas.scroll_into_view_if_needed(); box = canvas.bounding_box()
        page.mouse.move(box['x'] + 20, box['y'] + 20); page.mouse.down(); page.mouse.move(box['x'] + 120, box['y'] + 60, steps=8); page.mouse.move(box['x'] + 200, box['y'] + 30, steps=8); page.mouse.up()
        self.assertEqual(page.evaluate('[S.approved, Boolean(S.signature), Boolean(S.acceptanceAt)]'), [True, True, True])

    def save_quote(self, dialog):
        for _ in range(3): dialog.get_by_role('button', name=re.compile(r'^(Continue to|Review quote)')).first.click(); expect(dialog.locator('.qd-skeleton')).to_have_count(0)
        expect(dialog.locator('.qb-labor h3')).to_contain_text('Labor')
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog).to_contain_text('saved.')
        dialog.get_by_role('button', name='Done').click()
        expect(dialog).to_have_count(0)

    def test_walkthrough_signature_survives_looking_in_the_builder_and_a_changed_garage_is_rebuilt_before_signing(self):
        page, handoffs = self.walkthrough(), []
        page.on('response', lambda response: handoffs.append((response.status, response.json())) if response.request.method == 'POST' and urlparse(response.url).path == '/api/walkthrough-handoff' else None)
        # Finish: one shelving unit from the builder's products; Review names it before the quote is built.
        goods = page.locator('#finish-goods')
        goods.get_by_label('Search shelving and storage products').fill('HDX plastic shelving')
        goods.get_by_role('button', name=f'Add {SHELF}').click()
        self.step(5)
        expect(page.locator('#review-finish')).to_contain_text(f'Cleanout + reset, Deep clean, {SHELF} × 1')
        # Build the quote: it opens with the two-car deep clean and the Finish pick, and is saved.
        page.locator('#build-quote').click()
        dialog = self.dialog()
        expect(dialog.locator('.qb-total')).to_contain_text('Shelving $115.70')
        self.save_quote(dialog)
        self.assertEqual(page.evaluate('[S.builderQuote.compositePricing.garageSize, builderSignGate()]'), ['2', ''])
        self.sign()
        # The estimator shows the homeowner a second shelf in the builder and closes it without saving: nothing the
        # homeowner signed changed, so the signature stays and the saved quote is still the one signed.
        page.locator('#send-options').click()
        expect(dialog.get_by_role('button', name='Edit quote')).to_be_visible()
        expect(dialog).not_to_contain_text('Finish step')
        dialog.get_by_role('button', name='Edit quote').click()
        dialog.get_by_role('button', name='Continue to shelving').click()
        dialog.get_by_role('button', name=f'One more: {SHELF}').click()
        expect(dialog.get_by_role('group', name=f'{SHELF} quantity').locator('output')).to_have_text('2')
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        self.assertEqual(page.evaluate('[S.approved, Boolean(S.signature), builderSignGate(), S.builderGoods.shelving.map(row => row.quantity)]'), [True, True, '', [1]])
        expect(page.locator('#signature')).to_be_visible()
        # Photos: the garage is a 3-car. The plan changed (approval collected again), and the two-car quote is not signed.
        self.step(1)
        page.get_by_role('button', name='3-car', exact=True).click()
        self.step(5)
        gate = page.locator('#builder-sign-gate')
        expect(gate).to_have_attribute('data-gate', 'size')
        expect(gate).to_contain_text('The garage size changed since this quote was built: it was priced for a 2-car garage, and the walkthrough now records a 3-car garage.')
        for missing in ('#approved', '#signature', '#deposit-summary'): expect(page.locator(missing)).to_have_count(0)
        expect(page.get_by_role('button', name='Save brief + schedule')).to_be_disabled()
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth - innerWidth'), 0)
        page.screenshot(path=str(RESULTS / 'gameplan-garage-size-gate-mobile.png'), full_page=True)
        # Edit the quote: the deep clean follows the 3-car garage. The unsaved second shelf is still in the builder; put it back.
        gate.get_by_role('button', name='Edit the quote').click()
        dialog.get_by_role('button', name='Edit quote').click()
        deep = dialog.locator('label', has_text='Deep clean')
        expect(deep.locator('input')).to_be_checked()
        expect(deep).to_contain_text('Sized to the walkthrough’s 3-car garage.')
        expect(deep).to_contain_text('$480.00')
        dialog.get_by_role('button', name='Continue to shelving').click()
        dialog.get_by_role('button', name=f'One fewer: {SHELF}').click()
        dialog.get_by_role('button', name='Back').click()
        self.save_quote(dialog)
        self.assertEqual(page.evaluate('[S.builderQuote.compositePricing.garageSize, builderSignGate()]'), ['3', ''])
        # The homeowner signs the 3-car quote and the signed job is saved.
        self.sign()
        page.get_by_role('button', name='Save brief + schedule').click()
        expect(page.locator('#send-status')).to_contain_text('Job saved', timeout=20000)
        self.assertEqual([status for status, _ in handoffs], [200], 'one signed save, accepted')
        self.assertEqual(handoffs[0][1]['job']['status'], 'scheduled')
        signed = [post for post in self.posts if post.get('action') == 'save'][-1]['draft']['composite_pricing']
        self.assertEqual(signed['garageSize'], '3')
        self.assertIn({'id': 'egc-009', 'quantity': 1}, signed['removal'], 'the three-car deep clean')
        self.assertEqual(signed['shelving'], [{'id': 'hd-100006678', 'quantity': 1}])


if __name__ == '__main__':
    unittest.main()
