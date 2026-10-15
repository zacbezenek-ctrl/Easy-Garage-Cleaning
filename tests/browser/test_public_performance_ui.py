"""SITE-4 public pages on a phone (375x812): the generated service page paints its final layout (no shift from the
booking bar), picks the 600w hero and the WebP logo sized for its screen, keeps 44px footer links, and its multi-step walkthrough form,
now loaded from /site-forms.js, posts the same fields as before. The gallery uses its -768 thumbnails at 2x and the
expanded viewer the full photo. Run: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python3 tests/browser/test_public_performance_ui.py"""
import os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / 'test-results'
SERVICE = '/garage-cleanouts-fort-collins-co.html'
SHIFTS = "window.__shifts=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.__shifts.push(entry.value)}).observe({type:'layout-shift',buffered:true});"

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class PublicPerformanceBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def open(self, path, scale=3):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=scale, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(8000); self.errors, self.requested, self.relayed = [], [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        def route(route):
            request = route.request; url = urlparse(request.url); self.requested.append(url.path)
            if url.hostname == '127.0.0.1' and url.path == '/api/web-lead':
                self.relayed.append(request.post_data_json); return route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
            return route.continue_() if url.hostname == '127.0.0.1' else route.abort()
        self.context.route('**/*', route)
        self.page.add_init_script(SHIFTS)
        self.page.clock.install(time='2026-09-22T18:00:00Z')
        self.page.goto(self.url + path, wait_until='load')
        return self.page

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.context.close()

    def test_generated_page_paints_its_final_layout_with_small_images(self):
        page = self.open(SERVICE)
        # Account links are in the server-rendered footer; no script adds a band above the hero.
        expect(page.locator('.site-footer a[href="/customer-portal"]')).to_have_count(1)
        expect(page.locator('.site-footer a[href="/business-hub"]')).to_have_count(1)
        self.assertEqual(page.locator('#egc-customer-access').count(), 0)
        self.assertEqual(page.locator('#egc-customer-access-style').count(), 0)
        self.assertNotEqual(page.evaluate("document.querySelector('main').firstElementChild.id"), 'egc-customer-access')
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.assertLess(sum(page.evaluate('window.__shifts')), 0.01, 'nothing moves the hero after it paints')
        hero = page.locator('.hero-ba img').first
        self.assertEqual(hero.get_attribute('fetchpriority'), 'high')
        page.wait_for_function("document.querySelector('.hero-ba img').complete")
        self.assertTrue(page.evaluate("document.querySelector('.hero-ba img').currentSrc").endswith('/images/garage-before-600.webp'), 'a 3x phone takes the 600w hero, not the 1200w original')
        self.assertIn('egc-logo-horizontal-primary-368.webp', page.evaluate("getComputedStyle(document.querySelector('.nav .logo')).backgroundImage"))
        self.assertFalse([path for path in self.requested if path in ('/images/brand/egc-logo-horizontal-primary.png', '/images/brand/egc-logo-horizontal-white.png', '/images/garage-before.webp')], self.requested)
        self.assertEqual(self.requested.count('/site-forms.js'), 1)
        page.locator('.site-footer').scroll_into_view_if_needed()
        for link in page.locator('.site-footer .foot-col a').all(): self.assertGreaterEqual(link.bounding_box()['height'], 44)
        self.assertIn('egc-logo-horizontal-white-368.webp', page.evaluate("getComputedStyle(document.querySelector('.foot-brand .logo')).backgroundImage"))
        # A 3x phone draws the 181px header and 235px footer lockups from the high-density WebP files only.
        logos = sorted(path for path in self.requested if path.startswith('/images/brand/'))
        self.assertEqual(logos, ['/images/brand/egc-logo-horizontal-primary-552.webp', '/images/brand/egc-logo-horizontal-white-704.webp'])
        toggle = page.locator('.nav-toggle'); toggle.tap()
        expect(page.locator('#nav-drawer')).to_have_attribute('aria-hidden', 'false')
        page.keyboard.press('Escape'); expect(page.locator('#nav-drawer')).to_have_attribute('aria-hidden', 'true')
        SHOTS.mkdir(exist_ok=True); page.screenshot(path=str(SHOTS / 'public-performance-service-375.png'))

    def test_a_1x_screen_takes_the_368px_logos(self):
        page = self.open(SERVICE, scale=1)
        page.locator('.site-footer').scroll_into_view_if_needed()
        page.wait_for_function("[...document.images].every(image => image.complete)")
        logos = sorted(path for path in self.requested if path.startswith('/images/brand/'))
        self.assertEqual(logos, ['/images/brand/egc-logo-horizontal-primary-368.webp', '/images/brand/egc-logo-horizontal-white-368.webp'])

    def test_multi_step_walkthrough_form_posts_the_same_fields(self):
        page = self.open(SERVICE); form = page.locator('form.multi-step-form')
        form.scroll_into_view_if_needed()
        panel = lambda step: form.locator(f'.form-panel[data-step="{step}"]')
        self.assertTrue(panel(1).locator('input[value="Garage Cleanout"]').is_checked(), 'the garage page preselects its service')
        panel(1).locator('[data-next]').tap(); expect(panel(2)).to_have_class(re.compile(r'\bactive\b'))
        expect(page.locator('#quote .form-step-label')).to_have_text('Step 2 of 6: Job size')
        panel(2).locator('[data-next]').tap(); expect(panel(2).locator('.form-error.visible')).to_have_text('Please choose an approximate job size.')
        panel(2).locator('select[name="Job size"]').select_option('medium'); panel(2).locator('[data-next]').tap()
        expect(panel(3)).to_have_class(re.compile(r'\bactive\b')); expect(panel(3).locator('[data-result-booking]')).to_be_visible()
        panel(3).locator('[data-next]').tap(); expect(panel(3).locator('.form-error.visible')).to_have_text('Please choose a preferred walkthrough window.')
        panel(3).locator('input[value="Tomorrow AM"]').check(); panel(3).locator('[data-next]').tap()
        panel(4).locator('select[name="City"]').select_option('Fort Collins'); panel(4).locator('input[name="Zip code"]').fill('80525'); panel(4).locator('[data-next]').tap()
        panel(5).locator('[data-next]').tap(); expect(panel(6)).to_have_class(re.compile(r'\bactive\b'))
        expect(page.locator('#quote [data-progress-pct]')).to_have_text('100%')
        submit = panel(6).locator('button[type="submit"]'); expect(submit).to_have_text('Request walkthrough →')
        self.assertFalse(form.evaluate('form => form.checkValidity()'), 'name and phone are required before the form can submit')
        panel(6).locator('input[name="Name"]').fill('Synthetic Walkthrough'); panel(6).locator('input[name="Phone"]').fill('(970) 555-0101')
        # Capture what the browser would post once the page's own submit handlers have run, and stay on the page.
        page.evaluate("document.addEventListener('submit', event => { window.__posted = Object.fromEntries([...new FormData(event.target)].filter(([, value]) => typeof value === 'string')); event.preventDefault(); })")
        # requestSubmit with the real button runs validation and every submit handler, without a tap racing the smooth scroll.
        self.assertTrue(form.evaluate('form => form.checkValidity()'))
        form.evaluate("form => form.requestSubmit(form.querySelector('button[type=submit]'))"); page.wait_for_function('!!window.__posted')
        expect(submit).to_be_disabled(); expect(submit).to_have_text('Sending…')
        for _ in range(50):
            if self.relayed: break
            page.wait_for_timeout(100)
        posted = page.evaluate('window.__posted'); field = lambda name: posted[name]
        self.assertEqual(field('phone'), '+19705550101'); self.assertEqual(field('name'), 'Synthetic Walkthrough'); self.assertEqual(field('serviceZip'), '80525')
        self.assertEqual(field('items'), 'Garage Cleanout — Medium garage')
        self.assertEqual(field('booking_slot'), 'Tomorrow AM'); self.assertEqual(field('flow_type'), 'walkthrough')
        self.assertEqual(field('What to remove'), 'Garage Cleanout — Medium garage — Fort Collins — Slot: Tomorrow AM — Flow: walkthrough')
        self.assertEqual([lead['phone'] for lead in self.relayed], ['+19705550101'], 'fb-capture.js relays the finalized fields once')

    def walkthrough_to_contact(self, path):
        page = self.open(path)
        if path == '/book.html':
            # These assertions exercise the retained standard-form recovery path.
            page.get_by_text('Need help with the form?', exact=True).press('Enter')
            page.get_by_role('button', name='Use the standard request form', exact=True).press('Enter')
        form = page.locator('form.multi-step-form')
        form.locator('[name="Service type"]').first.check()
        form.locator('[data-step="1"] [data-next]').click()
        form.locator('[name="Job size"]').select_option(index=1)
        form.locator('[data-step="2"] [data-next]').click()
        form.locator('[name="booking_slot_choice"]').first.check()
        form.locator('[data-step="3"] [data-next]').click()
        form.locator('[name="City"]').select_option('Fort Collins')
        form.locator('[data-step="4"] [data-next]').click()
        form.locator('[data-step="5"] [data-next]').click()
        # Step navigation schedules focus. Wait for the contact step to finish
        # moving focus before fill() inserts text into a field on a busy runner.
        expect(form.locator('[data-step="6"]')).to_have_class(re.compile(r'\bactive\b'))
        expect(form.locator('[name="Name"]')).to_be_focused()
        # Observe successful validation without sending customer data anywhere.
        form.evaluate("""form => {window.__accepted = 0; form.addEventListener('submit', event => {
            if (!event.defaultPrevented) window.__accepted++;
            event.preventDefault();
        });}""")
        return page, form

    def check_walkthrough_contact_validation(self, path):
        page, form = self.walkthrough_to_contact(path)
        submit = form.locator('[type="submit"]')
        for name, phone, message in [
            ('   ', '(970) 555-0101', 'Please enter your name.'),
            ('Synthetic Walkthrough', '1', 'Please enter a complete phone number'),
            ('Synthetic Walkthrough', '22345678901', 'Please enter a complete phone number'),
            ('Synthetic Walkthrough', '1234567890123456', 'Please enter a complete phone number'),
        ]:
            form.locator('[name="Name"]').fill(name)
            form.locator('[name="Phone"]').fill(phone)
            expect(form.locator('[name="Name"]')).to_have_value(name)
            expect(form.locator('[name="Phone"]')).to_have_value(phone)
            form.evaluate("form => form.requestSubmit(form.querySelector('[type=submit]'))")
            self.assertEqual(page.evaluate('window.__accepted'), 0, (name, phone))
            expect(form.locator('[data-step="6"] .form-error.visible')).to_contain_text(message)
            expect(submit).to_be_enabled()
        self.assertEqual(self.relayed, [])
        form.locator('[name="Phone"]').fill('(970) 555-0101')
        expect(form.locator('[name="Name"]')).to_have_value('Synthetic Walkthrough')
        expect(form.locator('[name="Phone"]')).to_have_value('(970) 555-0101')
        form.evaluate("form => form.requestSubmit(form.querySelector('[type=submit]'))")
        self.assertEqual(page.evaluate('window.__accepted'), 1)
        expect(submit).to_be_disabled()

    def test_paid_landing_page_preserves_failed_requests_and_relays_once(self):
        page = self.open('/junk-removal-fort-collins.html')
        form = page.locator('#ppcQuoteForm'); submit = page.locator('#ppcSubmitBtn')
        requests = []; outcome = ['network']
        def provider(route):
            requests.append(route.request)
            if outcome[0] == 'network': return route.abort('failed')
            status, body = outcome[0]
            route.fulfill(status=status, content_type='application/json', body=body)
        page.route('https://api.web3forms.com/submit', provider)
        page.evaluate("window.__conversions=[];window.gtag=(...args)=>window.__conversions.push(args)")
        form.locator('[name="name"]').fill('Synthetic Walkthrough')
        form.locator('[name="phone"]').fill('(970) 555-0101')
        form.locator('[name="items"]').fill('Synthetic test couch')
        failures = ['network', (500, '{"success":false}'), (200, '{"success":false}')]
        for index, response in enumerate(failures):
            outcome[0] = response
            if index == 0:
                with page.expect_request('**/api/web-lead'):
                    form.evaluate('form => form.requestSubmit()')
            else:
                form.evaluate('form => form.requestSubmit()')
            expect(page.locator('#ppcFormError')).to_contain_text("couldn't confirm your request")
            expect(submit).to_be_enabled(); expect(form).to_be_visible()
            expect(page.locator('#ppcSuccess')).to_be_hidden()
            expect(form.locator('[name="name"]')).to_have_value('Synthetic Walkthrough')
            self.assertEqual(len(requests), index + 1)
            self.assertEqual(len(self.relayed), 1, 'retries retain the inquiry id and do not duplicate the CRM request')
            self.assertEqual(page.evaluate("window.__conversions.filter(args => args[0] === 'event' && args[1] === 'generate_lead')"), [], 'failed email attempts are not confirmed conversions')
        outcome[0] = (200, '{"success":true}')
        form.evaluate('form => form.requestSubmit()')
        expect(page.locator('#ppcSuccess')).to_be_visible(); expect(form).to_be_hidden()
        self.assertEqual(len(requests), 4); self.assertEqual(len(self.relayed), 1)
        events = page.evaluate("window.__conversions.filter(args => args[0] === 'event' && args[1] === 'generate_lead')")
        self.assertEqual(len(events), 1); self.assertEqual(events[0][1], 'generate_lead')

    def test_short_lead_forms_reject_incomplete_contact_details_natively(self):
        paths = ['/index.html', '/ads.html', '/estate-cleanout-fort-collins.html',
                 '/flat-rate-junk-removal-fort-collins-co.html', '/garage-cleanouts-laporte-co.html',
                 '/garage-cleanouts-severance-co.html', '/garage-turnaround-fort-collins-co.html',
                 '/junk-removal-fort-collins.html']
        for path in paths:
            with self.subTest(path=path):
                page = self.open(path)
                page.evaluate("document.addEventListener('submit', event => {window.__submitted = true; event.preventDefault();}, true)")
                for form in page.locator('form.lead-form-lite').all():
                    name = form.locator('input[name="name"][type="text"]')
                    phone = form.locator('input[name="phone"][type="tel"]')
                    name.fill('Synthetic Walkthrough')
                    for value in ['1', '22345678901', '1234567890123456']:
                        phone.fill(value)
                        self.assertFalse(phone.evaluate('field => field.checkValidity()'), (path, value))
                        form.evaluate('form => form.requestSubmit()')
                        self.assertFalse(page.evaluate('!!window.__submitted'))
                    for value in ['(970) 555-0101', '+1 (970) 555-0101', '+44 207 555 0101']:
                        phone.fill(value)
                        self.assertTrue(phone.evaluate('field => field.checkValidity()'), (path, value))
                    name.fill('   ')
                    self.assertFalse(name.evaluate('field => field.checkValidity()'))
                    form.evaluate('form => form.requestSubmit()')
                    self.assertFalse(page.evaluate('!!window.__submitted'))
                    name.fill('Synthetic Walkthrough')
                    self.assertTrue(name.evaluate('field => field.checkValidity()'))
                self.assertEqual(self.errors, [])
                self.assertEqual(self.relayed, [])
                if path != paths[-1]: self.context.close()

    def test_book_rejects_incomplete_contact_details_before_submission(self):
        self.check_walkthrough_contact_validation('/book.html')

    def test_pricing_rejects_incomplete_contact_details_before_submission(self):
        self.check_walkthrough_contact_validation('/pricing.html')

    def test_back_forward_restoration_allows_walkthrough_submission_again(self):
        page, form = self.walkthrough_to_contact('/book.html')
        form.locator('[name="Name"]').fill('Synthetic Walkthrough')
        form.locator('[name="Phone"]').fill('(970) 555-0101')
        submit = form.locator('[type="submit"]')
        form.evaluate("form => form.requestSubmit(form.querySelector('[type=submit]'))")
        self.assertEqual(page.evaluate('window.__accepted'), 1)
        expect(submit).to_be_disabled()
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
        expect(submit).to_be_enabled(); expect(submit).to_have_text('Request walkthrough →')
        expect(form.locator('[name="Name"]')).to_have_value('Synthetic Walkthrough')
        form.evaluate("form => form.requestSubmit(form.querySelector('[type=submit]'))")
        self.assertEqual(page.evaluate('window.__accepted'), 2)

    def test_book_page_ships_its_business_contact_without_an_account_banner(self):
        page = self.open('/book.html')
        expect(page.locator('.egc-business-contact a[href="tel:+19709991403"]')).to_have_count(1)
        expect(page.locator('.site-footer a[href="/customer-portal"]')).to_have_count(1)
        self.assertEqual(page.locator('#egc-customer-access').count(), 0)
        self.assertEqual(page.locator('.egc-business-contact').count(), 1)
        self.assertLess(sum(page.evaluate('window.__shifts')), 0.01)

    def test_account_access_is_server_rendered_without_javascript(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, java_script_enabled=False)
        self.page = self.context.new_page(); self.page.set_default_timeout(8000); self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        def route(route):
            url = urlparse(route.request.url)
            if url.hostname != '127.0.0.1': return route.abort()
            return route.continue_()
        self.context.route('**/*', route)
        self.page.goto(self.url + SERVICE)
        self.assertEqual(self.page.locator('#egc-customer-access').count(), 0)
        self.assertEqual(self.page.locator('#egc-customer-access-style').count(), 0)
        for target in ('/customer-portal', '/business-hub'):
            link = self.page.locator(f'.site-footer a[href="{target}"]')
            expect(link).to_have_count(1)
            self.assertGreaterEqual(link.bounding_box()['height'], 44)

    def test_gallery_cards_use_thumbnails_on_a_2x_phone_and_the_viewer_the_full_photo(self):
        page = self.open('/before-after.html', scale=2)
        card = page.locator('.ba-card').first
        page.wait_for_function("document.querySelector('.ba-card .after-image').complete")
        self.assertTrue(card.locator('.after-image').evaluate('image => image.currentSrc').endswith('/images/garage-after-768.webp'))
        fonts = page.locator('link[rel="stylesheet"][href^="https://fonts.googleapis.com"]')
        self.assertEqual(fonts.get_attribute('onload'), "this.media='all'", 'the font stylesheet loads as print and never blocks rendering')
        expand = card.locator('[data-expand]'); expect(expand).to_be_visible(); expand.tap()
        viewer = page.locator('#viewer-body .after-image'); expect(viewer).to_have_count(1)
        self.assertIsNone(viewer.get_attribute('srcset'))
        page.wait_for_function("document.querySelector('#viewer-body .after-image').complete")
        self.assertTrue(viewer.evaluate('image => image.currentSrc').endswith('/images/garage-after.webp'))

if __name__ == '__main__':
    unittest.main()
