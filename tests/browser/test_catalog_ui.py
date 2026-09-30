"""Owner catalog & pricing screen (CATALOG-ADMIN) on a phone, against the REAL /api/catalog handler.

tests/browser/catalog_api_fixture.mjs serves the screen on its own page and runs functions/api/catalog.js over an
in-memory Firestore REST emulation with an injected clock. The browser runs in Asia/Tokyo with page.clock installed,
so every date shown or sent must follow Denver's calendar. The last class opens the real employee.html to check the
owner-only nav link. Nothing reaches the network: every host but 127.0.0.1 is aborted."""
import json, os, pathlib, re, subprocess, unittest, urllib.request
from datetime import datetime, timezone
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, MANAGER, CREW

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
NOW = datetime(2026, 9, 28, 5, 30, tzinfo=timezone.utc)  # 11:30 PM Sept 27 in Denver, 2:30 PM Sept 28 in Tokyo
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
CATALOG = json.loads((ROOT / 'functions' / '_data' / 'garage-catalog.json').read_text())
VERIFIED = [item for item in CATALOG['items'] if item['priceVerified']]
UNVERIFIED = len(CATALOG['items']) - len(VERIFIED)
LAST_CHECK = max(item['priceVerifiedAt'] for item in VERIFIED)
OWNER = {**MANAGER, 'owner': True}


def iso(moment): return moment.strftime('%Y-%m-%dT%H:%M:%S.000Z')


class CatalogScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.fixture = subprocess.Popen(['node', str(ROOT / 'tests' / 'browser' / 'catalog_api_fixture.mjs')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cls.url = 'http://127.0.0.1:%d' % json.loads(cls.fixture.stdout.readline())['port']
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.fixture.stdin.close(); cls.fixture.wait(10); cls.fixture.stdout.close()

    def setUp(self):
        self.errors = []; self.context = None
        self.control(reset=True, now=iso(NOW))

    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def control(self, **body):
        request = urllib.request.Request(self.url + '/__control', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=30) as response: return json.loads(response.read())

    def route(self, route):
        if urlparse(route.request.url).hostname != '127.0.0.1': route.abort(); return
        route.continue_()

    def open(self, now=NOW, width=375):
        self.control(now=iso(now))
        self.context = self.browser.new_context(viewport={'width': width, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(10000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=now)
        self.page.route('**/*', self.route)
        self.page.goto(self.url + '/catalog-harness')
        self.root = self.page.locator('.egc-catalog')
        expect(self.root.get_by_role('tab', name='Pricing')).to_be_visible()
        return self.page

    def tab(self, name):
        self.root.get_by_role('tab', name=re.compile('^' + name)).click()

    def rows(self): return self.root.locator('.cat-table tbody tr')

    def status(self, value):
        # On a phone the filters beyond search sit in a closed Filters disclosure, keeping the first rows on screen.
        more = self.root.locator('details.cat-filter-more')
        if not more.evaluate('node => node.open'): more.locator('summary').click()
        self.root.get_by_label('Price status').select_option(value)

    def assert_phone_layout(self, scope, widths=(320, 375, 390)):
        for width in widths:
            self.page.set_viewport_size({'width': width, 'height': 812})
            scroll = self.page.evaluate('()=>{const html=document.documentElement,body=document.body;html.style.overflowX="visible";body.style.overflowX="visible";return html.scrollWidth}')
            self.assertLessEqual(scroll, width, f'horizontal scroll at {width}px in {scope}')
            small = self.page.evaluate("""scope => [...document.querySelectorAll(scope)].flatMap(root => [...root.querySelectorAll('button,a[href],select,input,textarea,summary')])
              .map(node => node.matches('input[type=checkbox]') ? node.closest('label') || node : node)
              .filter(node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; })
              .filter(node => node.getBoundingClientRect().height < 43.5).map(node => node.tagName + ' ' + (node.textContent || node.name || '').trim().slice(0, 30) + ' ' + Math.round(node.getBoundingClientRect().height))""", scope)
            self.assertEqual(small, [], f'tap targets under 44px at {width}px in {scope}')
            fonts = self.page.evaluate("""scope => [...document.querySelectorAll(scope)].flatMap(root => [...root.querySelectorAll('input:not([type=checkbox]),select,textarea')])
              .filter(node => node.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(node).fontSize) < 16).map(node => node.name)""", scope)
            self.assertEqual(fonts, [], f'inputs under 16px at {width}px in {scope}')
        self.page.set_viewport_size({'width': 375, 'height': 812})

    def test_stale_badge_is_the_server_flag_at_91_denver_days(self):
        # 91 Denver days after the last price check; Tokyo is already a day ahead, so a device-date bug shows 92.
        day91 = datetime(2026, 12, 27, 19, 0, tzinfo=timezone.utc)
        self.assertEqual((day91.date() - datetime.fromisoformat(LAST_CHECK).date()).days, 91)
        self.open(day91); self.tab('Items')
        expect(self.root.locator('.hub-head p')).to_contain_text(f'{UNVERIFIED} unverified · {len(VERIFIED)} stale (older than 90 days)')
        self.status('stale')
        expect(self.root.locator('.cat-count')).to_contain_text(f'of {len(VERIFIED)}')
        first = self.rows().first
        expect(first.locator('.cat-badge.stale')).to_have_text('Stale')
        expect(first.locator('[data-state="stale"]')).to_contain_text('91 days ago')
        self.status('unverified')
        expect(self.rows().first.locator('.cat-badge.unverified')).to_have_text('Unverified')
        self.page.screenshot(path=str(RESULTS / 'catalog-items-stale-375.png'), full_page=False)
        self.context.close(); self.context = None
        day90 = datetime(2026, 12, 26, 19, 0, tzinfo=timezone.utc)
        self.open(day90); self.tab('Items')
        expect(self.root.locator('.hub-head p')).to_contain_text(f'{UNVERIFIED} unverified · 0 stale')
        self.status('verified')
        expect(self.rows().first.locator('.cat-badge.verified')).to_have_text('Verified')
        expect(self.rows().first.locator('[data-state="verified"]')).to_contain_text('90 days ago')
        self.status('stale')
        expect(self.root.get_by_text('No items match these filters.')).to_be_visible()

    def verify_first_unverified(self, price='49.98'):
        self.tab('Items')
        self.status('unverified')
        row = self.rows().first; name = row.locator('strong').first.inner_text()
        row.get_by_role('button', name=re.compile('^Verify price')).click()
        dialog = self.page.locator('dialog.cat-dialog')
        expect(dialog.get_by_role('heading', name=name)).to_be_visible()
        expect(dialog.get_by_label('Checked on')).to_have_value('2026-09-27')  # the Denver date, not Tokyo's Sept 28
        expect(dialog.get_by_label('Checked on')).to_have_attribute('max', '2026-09-27')
        self.assertEqual(dialog.get_by_label(re.compile(r'^Price seen')).get_attribute('inputmode'), 'decimal')
        dialog.get_by_label('Store').fill('Synthetic Hardware')
        dialog.get_by_label('Product page link').fill('http://synthetic.example.com/p/1')
        dialog.get_by_label(re.compile(r'^Price seen')).fill(price); dialog.get_by_label('Highest price seen ($)').fill('')
        dialog.get_by_role('button', name='Save to draft').click()
        expect(dialog.locator('.cat-error')).to_contain_text('public https:// link')
        dialog.get_by_label('Product page link').fill('https://synthetic.example.com/p/1')
        dialog.get_by_role('button', name='Save to draft').click()
        expect(dialog).to_be_hidden()
        expect(self.root.get_by_role('tab', name='Draft (1)')).to_be_visible()
        return name

    def test_verify_a_price_then_publish_a_new_version_after_the_diff(self):
        self.open()
        name = self.verify_first_unverified()
        self.tab('Draft')
        expect(self.root.locator('.cat-changes li')).to_contain_text(name)
        expect(self.root.locator('.cat-changes li')).to_contain_text('Price checked')
        self.root.get_by_role('button', name='Review & publish').click()
        dialog = self.page.locator('dialog.cat-dialog')
        expect(dialog.get_by_role('heading', name='Publish version 2026-09-27.2')).to_be_visible()
        expect(dialog).to_contain_text('Replaces version 2026-09-27.1')
        verified = dialog.locator('.cat-diff-row').filter(has=self.page.locator('dt', has_text=re.compile(r'^Price verified$')))
        expect(verified.locator('del')).to_have_text('No'); expect(verified.locator('ins')).to_have_text('Yes')
        expect(dialog.locator('.cat-diff-row').filter(has=self.page.locator('dt', has_text=re.compile(r'^Low price$'))).locator('ins')).to_have_text('$49.98')
        self.assert_phone_layout('dialog.cat-dialog')
        dialog.screenshot(path=str(RESULTS / 'catalog-publish-diff-375.png'))
        dialog.get_by_role('button', name='Publish version 2026-09-27.2').click()
        expect(self.root.get_by_role('status').filter(has_text='Published catalog version 2026-09-27.2')).to_be_visible()
        state = self.control()
        self.assertEqual(state['pointer']['version'], '2026-09-27.2')
        post = state['posts'][-1]
        self.assertEqual({key: post[key] for key in ('action', 'basedOnVersion', 'catalogVersion')}, {'action': 'catalog.publish', 'basedOnVersion': '2026-09-27.1', 'catalogVersion': '2026-09-27.2'})
        self.assertRegex(post['requestId'], UUID)
        expect(self.root.locator('.hub-head p')).to_contain_text(f'Version 2026-09-27.2 · {len(CATALOG["items"])} items · {UNVERIFIED - 1} unverified')
        self.status('')
        self.root.get_by_label('Search').fill(name)
        row = self.rows().first
        expect(row.locator('.cat-badge.verified')).to_have_text('Verified')
        expect(row.locator('[data-state="verified"]')).to_contain_text('Checked Sep 27, 2026 · today')
        expect(row).to_contain_text('Synthetic Hardware')
        self.assertEqual(self.page.evaluate("Object.keys(sessionStorage).filter(key=>key.startsWith('egc.hub.draft.v1.catalog.'))"), [])

    def test_a_version_published_elsewhere_keeps_the_draft_and_republishes_over_it(self):
        self.open()
        self.verify_first_unverified('12.00')
        other = CATALOG['items'][0]['id']
        self.control(publish={'version': '2026-09-27.2', 'itemId': other, 'name': 'Synthetic name from another tab'})
        self.tab('Draft'); self.root.get_by_role('button', name='Review & publish').click()
        dialog = self.page.locator('dialog.cat-dialog')
        dialog.get_by_role('button', name='Publish version 2026-09-27.2').click()
        expect(self.root.get_by_role('alert')).to_contain_text('Another catalog version was published while you were editing. Your draft is kept')
        expect(self.root.get_by_role('tab', name='Draft (1)')).to_be_visible()
        self.root.get_by_role('button', name='Load latest catalog').click()
        expect(self.root.locator('.hub-head p')).to_contain_text('Version 2026-09-27.2')
        expect(self.root.locator('.cat-draft')).to_contain_text('This draft started from version 2026-09-27.1; version 2026-09-27.2 is published now. Your changes were moved onto 2026-09-27.2')
        self.root.get_by_role('button', name='Review & publish').click()
        expect(dialog.get_by_role('heading', name='Publish version 2026-09-27.3')).to_be_visible()
        expect(dialog).not_to_contain_text('Synthetic name from another tab')
        dialog.get_by_role('button', name='Publish version 2026-09-27.3').click()
        expect(self.root.get_by_role('status').filter(has_text='Published catalog version 2026-09-27.3')).to_be_visible()
        self.assertEqual(self.control()['pointer']['version'], '2026-09-27.3')
        self.tab('Items'); self.status(''); self.root.get_by_label('Search').fill('Synthetic name from another tab')
        expect(self.rows()).to_have_count(1)

    def test_pricing_settings_review_the_diff_and_confirm_release(self):
        self.open()
        expect(self.root.get_by_text('Placeholder values')).to_be_visible()
        labor = self.root.get_by_label('Labor rate per technician-hour ($)')
        expect(labor).to_have_value('75.00'); self.assertEqual(labor.get_attribute('inputmode'), 'decimal')
        review = self.root.get_by_role('button', name='Review changes')
        expect(review).to_be_disabled()
        labor.fill('80'); self.root.get_by_label('Overhead storage (%)').fill('35')
        self.root.get_by_label('Reviewed: these values may price catalog quotes').check()
        expect(self.root.get_by_label('Version label for this save')).to_have_value('owner-2026-09-27-2330')
        self.assert_phone_layout('.egc-catalog')
        self.page.screenshot(path=str(RESULTS / 'catalog-settings-375.png'), full_page=True)
        review.click()
        dialog = self.page.locator('dialog.cat-dialog')
        expect(dialog.get_by_role('heading', name='Save pricing settings owner-2026-09-27-2330')).to_be_visible()
        expect(dialog.locator('tr', has_text='Labor rate per technician-hour')).to_contain_text('$75.00')
        expect(dialog.locator('tr', has_text='Labor rate per technician-hour').locator('strong')).to_have_text('$80.00')
        expect(dialog.locator('tr', has_text='Markup: Overhead storage').locator('strong')).to_have_text('35%')
        expect(dialog.locator('tr', has_text='Ready for customer quotes').locator('strong')).to_have_text('Yes')
        self.assert_phone_layout('dialog.cat-dialog')
        dialog.get_by_role('button', name='Save settings').click()
        expect(dialog.locator('.cat-error')).to_have_text('Confirm the review to approve these prices.')
        self.assertEqual(self.control()['posts'], [], 'nothing is sent before the release is confirmed')
        dialog.get_by_label('I reviewed every value and these prices may be used for catalog quotes').check()
        dialog.get_by_role('button', name='Save settings').click()
        expect(self.root.get_by_role('status').filter(has_text='Pricing settings saved as owner-2026-09-27-2330, approved for catalog quotes.')).to_be_visible()
        state = self.control(); post = state['posts'][-1]
        self.assertEqual({key: post.get(key) for key in ('action', 'expectedRevision', 'confirmCustomerUse', 'settingsVersion')}, {'action': 'settings.update', 'expectedRevision': None, 'confirmCustomerUse': True, 'settingsVersion': 'owner-2026-09-27-2330'})
        saved = state['settings']['settings']
        self.assertEqual((saved['laborRateCents'], saved['markupPct']['byCategory']['overhead'], saved['mustSetBeforeCustomerUse']), (8000, 35, False))
        expect(self.root.get_by_text('These prices are approved for catalog quotes.')).to_be_visible()
        expect(self.root.get_by_label('Labor rate per technician-hour ($)')).to_have_value('80.00')
        self.tab('Items')
        launch = self.root.get_by_role('button', name='Build catalog quote')
        expect(launch).to_be_enabled()
        self.assertEqual(self.page.locator('[data-egc-catalog-quote-asset]').count(), 0, 'quote assets load only when requested')
        launch.click()
        expect(self.page.get_by_role('dialog', name='Build a catalog quote')).to_be_visible()
        self.assertEqual(set(self.page.locator('[data-egc-catalog-quote-asset]').evaluate_all('nodes => nodes.map(node => node.getAttribute("data-egc-catalog-quote-asset"))')),
                         {'/employee-catalog-quote.css?v=20260930catalogquote1', '/crew/quote-draft.css?v=20260930catalogquote1',
                          '/crew/quote-draft.js?v=20260930catalogquote1', '/employee-catalog-quote.js?v=20260930catalogquote1'})
        self.page.get_by_role('button', name='Close catalog quote').click()

    def test_pricing_actions_only_stick_after_edits_and_quote_needs_approved_settings(self):
        self.open(width=320)
        bar = self.root.locator('.cat-settings .cat-sticky')
        expect(bar).to_have_class(re.compile('cat-idle'))
        self.assertEqual(bar.evaluate('node => getComputedStyle(node).position'), 'static')
        rate = self.root.get_by_label('Labor rate per technician-hour ($)')
        rate.fill('76.00')
        expect(bar).not_to_have_class(re.compile('cat-idle'))
        self.assertEqual(bar.evaluate('node => getComputedStyle(node).position'), 'sticky')
        expect(self.root.get_by_role('button', name='Review changes')).to_be_enabled()
        rate.fill('75.00')
        expect(bar).to_have_class(re.compile('cat-idle'))
        self.tab('Items')
        expect(self.root.get_by_role('button', name='Build catalog quote')).to_be_disabled()
        expect(self.root.get_by_text('Review and approve Pricing before building a catalog quote.')).to_be_visible()
        self.assert_phone_layout('.egc-catalog')
        self.root.get_by_role('button', name='Review pricing').click()
        expect(self.root.get_by_role('tab', name='Pricing')).to_be_focused()

    def test_out_of_range_settings_never_reach_the_server(self):
        self.open()
        cases = [('Labor rate per technician-hour ($)', '0', 'Enter $0.01 to $1,000.00.'), ('Deposit (% of the quote)', '100.5', 'Enter a percentage from 0 to 100'),
                 ('Default markup (%)', '12.345', 'Enter a percentage from 0 to 500'), ('Minimum job ($)', 'lots', 'as dollars, like 75.00')]
        for label, value, message in cases:
            field = self.root.get_by_label(label); before = field.input_value()
            field.fill(value); self.root.get_by_role('button', name='Review changes').click()
            expect(self.root.locator('.hub-field', has=self.page.get_by_label(label)).locator('.cat-error')).to_contain_text(message)
            expect(self.root.get_by_label(label)).to_have_attribute('aria-invalid', 'true')
            expect(self.page.locator('dialog.cat-dialog')).to_have_count(0)
            self.root.get_by_label(label).fill(before)
        self.assertEqual(self.control()['posts'], [])

    def test_a_settings_revision_conflict_keeps_the_edits_and_reviews_against_the_latest(self):
        self.open()
        self.control(saveSettings={'settingsVersion': 'synthetic-other-tab', 'laborRateCents': 9000, 'depositPct': 25})
        self.root.get_by_label('Labor rate per technician-hour ($)').fill('80')
        self.root.get_by_role('button', name='Review changes').click()
        self.page.locator('dialog.cat-dialog').get_by_role('button', name='Save settings').click()
        expect(self.root.get_by_role('alert')).to_contain_text('Pricing settings changed since you opened them. Your edits are kept')
        self.root.get_by_role('button', name='Load latest settings').click()
        expect(self.root.get_by_text('The saved settings changed after you started editing.')).to_be_visible()
        expect(self.root.get_by_label('Labor rate per technician-hour ($)')).to_have_value('80')
        expect(self.root.get_by_label('Deposit (% of the quote)')).to_have_value('25')  # the other save's field, not undone
        self.root.get_by_role('button', name='Review changes').click()
        dialog = self.page.locator('dialog.cat-dialog')
        row = dialog.locator('tr', has_text='Labor rate per technician-hour')
        expect(row).to_contain_text('$90.00'); expect(row.locator('strong')).to_have_text('$80.00')
        expect(dialog.locator('tr', has_text='Deposit')).to_have_count(0)
        dialog.get_by_role('button', name='Save settings').click()
        expect(self.root.get_by_role('status').filter(has_text='Pricing settings saved as owner-2026-09-27-2330')).to_be_visible()
        state = self.control()
        self.assertEqual((state['settings']['settings']['laborRateCents'], state['settings']['settings']['depositPct']), (8000, 25))
        self.assertEqual([post['expectedRevision'] is None for post in state['posts']], [True, False], 'the retry names the revision it reviewed')

    def test_a_lost_response_is_retried_with_the_same_request_after_a_reload(self):
        self.open()
        lost = []
        def lose(route):
            if route.request.method == 'POST' and not lost:
                response = route.fetch(); lost.append(response.status); route.abort('connectionfailed'); return
            route.continue_()
        self.page.route('**/api/catalog', lose)
        self.root.get_by_label('Minimum job ($)').fill('500')
        self.root.get_by_role('button', name='Review changes').click()
        self.page.locator('dialog.cat-dialog').get_by_role('button', name='Save settings').click()
        retry = self.root.locator('.cat-retry')
        expect(retry).to_contain_text('Not confirmed: Save pricing settings owner-2026-09-27-2330')
        self.assertEqual(lost, [200], 'the server applied the save before the response was lost')
        self.page.reload()
        expect(self.root.locator('.cat-retry')).to_contain_text('Not confirmed: Save pricing settings owner-2026-09-27-2330')
        expect(self.root.get_by_label('Minimum job ($)')).to_be_disabled()  # editing waits for the Retry
        self.root.get_by_role('button', name='Retry original request').click()
        expect(self.root.get_by_role('status').filter(has_text='Pricing settings saved as owner-2026-09-27-2330')).to_be_visible()
        state = self.control()
        self.assertEqual(len(state['posts']), 2); self.assertEqual(state['posts'][0]['requestId'], state['posts'][1]['requestId'])
        self.assertEqual((state['settingsVersions'], state['receipts']), (1, 1), 'the retry replayed the saved receipt instead of saving twice')
        expect(self.root.locator('.cat-retry')).to_have_count(0)
        expect(self.root.get_by_label('Minimum job ($)')).to_be_enabled()
        expect(self.root.get_by_label('Minimum job ($)')).to_have_value('500.00')

    def test_every_section_fits_a_phone_with_44px_targets_and_16px_inputs(self):
        self.open()
        self.assert_phone_layout('.egc-catalog')
        self.tab('Items')
        expect(self.rows()).to_have_count(40)
        expect(self.root.locator('details.cat-filter-more')).not_to_have_attribute('open', '')
        self.assertLess(self.rows().first.bounding_box()['y'], 812, 'the first item is on the first phone screen')
        self.rows().nth(1).screenshot(path=str(RESULTS / 'catalog-item-row-375.png'))
        self.root.get_by_role('button', name=re.compile(r'^Needs a check \(\d+\)$')).click()
        expect(self.root.locator('summary')).to_have_text('Filters (1 on)')
        self.root.locator('details.cat-filter-more summary').click()
        self.assert_phone_layout('.egc-catalog')
        self.page.screenshot(path=str(RESULTS / 'catalog-items-375.png'), full_page=False)
        self.root.get_by_role('button', name='Add product').click()
        dialog = self.page.locator('dialog.cat-dialog')
        dialog.get_by_label(re.compile(r'^Category')).select_option('shelving')
        self.assert_phone_layout('dialog.cat-dialog')
        dialog.get_by_role('button', name='Add to draft').click()
        expect(dialog.locator('.cat-error').first).to_be_visible()
        expect(dialog.locator('[aria-invalid="true"]').first).to_be_focused()
        dialog.get_by_role('button', name='Cancel').click()
        self.tab('Draft')
        self.assert_phone_layout('.egc-catalog')
        self.tab('Pricing'); self.root.get_by_role('button', name='Open Team schedule').click()
        self.assertEqual(self.page.evaluate('document.body.dataset.went'), 'schedule')


class CatalogHubNavTests(HubShell, unittest.TestCase):
    """The owner-only nav link on the real employee.html; the screen mounts through the registry."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.catalog_calls = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        parsed = urlparse(route.request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/catalog':
            self.catalog_calls.append(parsed.query)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'enabled': False})); return
        super().route(route)

    def test_only_the_owner_sees_the_catalog_link_and_it_mounts_the_screen(self):
        for profile, first in ((MANAGER, 'today'), (CREW, 'my_day')):
            self.open(first, width=375, height=812, profile=profile)
            self.assertNotIn('catalog', self.nav_views(), profile['role'])
            self.close_page()
        page = self.open('today', width=375, height=812, profile=OWNER)
        self.assertIn('catalog', self.nav_views())
        expect(page.locator('.ops-nav [data-ops-tab="catalog"] span')).to_have_text('Catalog & pricing')
        self.go('catalog')
        expect(page.locator('#ops-title')).to_have_text('Catalog & pricing')
        expect(page.locator('.egc-catalog')).to_contain_text('Catalog pricing is turned off')
        self.assertEqual(self.catalog_calls, ['view=full'])
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll['wide'])
        self.assertEqual(self.small_targets('.egc-catalog'), [])


if __name__ == '__main__':
    unittest.main()
