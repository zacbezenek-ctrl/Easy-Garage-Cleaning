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
        # site-enhancements.js still adds its drawer link, but the booking bar was already in the HTML.
        page.wait_for_function("!!document.querySelector('#nav-drawer a[href=\"/customer-portal\"]')")
        self.assertEqual(page.locator('#egc-customer-access').count(), 1)
        self.assertEqual(page.locator('#egc-customer-access-style').count(), 0, 'styles.css styles the static bar; the script adds no copy')
        self.assertEqual(page.evaluate("document.querySelector('main').firstElementChild.id"), 'egc-customer-access')
        for link in page.locator('#egc-customer-access a').all(): self.assertGreaterEqual(link.bounding_box()['height'], 44)
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
        self.assertEqual(field('items'), 'Garage Cleanout — Medium garage ($400–$650)')
        self.assertEqual(field('booking_slot'), 'Tomorrow AM'); self.assertEqual(field('flow_type'), 'walkthrough')
        self.assertEqual(field('What to remove'), 'Garage Cleanout — Medium garage ($400–$650) — Fort Collins — Slot: Tomorrow AM — Flow: walkthrough')
        self.assertEqual([lead['phone'] for lead in self.relayed], ['+19705550101'], 'fb-capture.js relays the finalized fields once')

    def test_book_page_ships_its_business_contact_in_the_bar(self):
        page = self.open('/book.html')
        page.wait_for_function("!!document.querySelector('#nav-drawer a[href=\"/customer-portal\"]')")
        expect(page.locator('#egc-customer-access .egc-business-contact a[href="tel:+19709991403"]')).to_have_count(1)
        self.assertEqual(page.locator('.egc-business-contact').count(), 1)
        self.assertLess(sum(page.evaluate('window.__shifts')), 0.01)

    def test_site_enhancements_still_builds_the_bar_on_a_page_without_it(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(8000); self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        def route(route):
            url = urlparse(route.request.url)
            if url.hostname != '127.0.0.1': return route.abort()
            if url.path != SERVICE: return route.continue_()
            html = route.fetch().text()
            stripped = re.sub(r'<nav id="egc-customer-access"[\s\S]*?</nav>', '', html, count=1)
            self.assertNotEqual(stripped, html)
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=stripped)
        self.context.route('**/*', route)
        self.page.goto(self.url + SERVICE)
        self.page.wait_for_function("!!document.getElementById('egc-customer-access-style')")
        self.assertEqual(self.page.evaluate("document.querySelector('main').firstElementChild.id"), 'egc-customer-access')
        self.assertEqual(self.page.locator('#nav-drawer a[href="/customer-portal"]').count(), 1)

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
