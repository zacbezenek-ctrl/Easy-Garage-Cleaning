"""Public mobile navigation at 375x812: a closed drawer is never tabbable, an open drawer traps focus."""
import os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / 'test-results'
# Generator-patched home, a generated service page, a hand-authored landing page,
# a blog article and the server-rendered gallery fallback (gallery-simple.js).
PAGES = ['/index.html', '/garage-cleanouts-fort-collins-co.html', '/garage-guard.html', '/blog/how-much-does-garage-cleanout-cost-fort-collins.html', '/before-after.html']
IN_DRAWER = "() => !!document.activeElement && !!document.activeElement.closest('#nav-drawer')"

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class NavDrawerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start(); cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start(); options={'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':375,'height':812},is_mobile=True,has_touch=True,timezone_id='Asia/Tokyo')
        self.page=self.context.new_page(); self.page.set_default_timeout(5000); self.errors=[]
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.page.route('**/*',lambda route:route.abort() if urlparse(route.request.url).hostname!='127.0.0.1' else route.continue_())
        self.page.clock.install(time='2026-09-22T18:00:00Z')
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.context.close()
    def open(self,path):
        self.page.goto(self.url+path);expect(self.page.locator('.nav-toggle')).to_be_visible()
        self.assertTrue(self.page.evaluate("document.getElementById('nav-drawer').inert"),path)
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375,path)

    def test_tab_from_top_skips_the_closed_drawer(self):
        for path in PAGES:
            with self.subTest(path=path):
                self.open(path);seen=[]
                for _ in range(30):
                    self.page.keyboard.press('Tab')
                    seen.append(self.page.evaluate("() => { const el=document.activeElement; return {drawer:!!el.closest('#nav-drawer'), toggle:el.matches('.nav-toggle'), main:!!el.closest('main')}; }"))
                self.assertFalse(any(step['drawer'] for step in seen),path)
                self.assertTrue(any(step['toggle'] for step in seen),path)
                self.assertTrue(any(step['main'] for step in seen),f'{path}: Tab never moved past the drawer into the page')

    def test_open_drawer_traps_focus_and_escape_returns_to_the_menu_button(self):
        for path in PAGES:
            with self.subTest(path=path):
                self.open(path);toggle=self.page.locator('.nav-toggle');drawer=self.page.locator('#nav-drawer')
                toggle.focus();self.page.keyboard.press('Enter')
                expect(toggle).to_have_attribute('aria-expanded','true');expect(drawer).to_have_attribute('aria-hidden','false')
                self.page.wait_for_function(IN_DRAWER)
                self.assertFalse(self.page.evaluate("document.getElementById('nav-drawer').inert"))
                if path=='/index.html':SHOTS.mkdir(exist_ok=True);self.page.screenshot(path=str(SHOTS/'nav-drawer-open-375.png'))
                for key in ['Tab']*40+['Shift+Tab']*8:
                    self.page.keyboard.press(key);self.assertTrue(self.page.evaluate(IN_DRAWER),f'{path}: {key} escaped the open drawer')
                self.page.keyboard.press('Escape')
                expect(toggle).to_have_attribute('aria-expanded','false');expect(drawer).to_have_attribute('aria-hidden','true')
                self.assertTrue(self.page.evaluate("document.getElementById('nav-drawer').inert"))
                self.assertTrue(self.page.evaluate("document.activeElement===document.querySelector('.nav-toggle')"),path)

    def test_footer_links_are_44px_tap_targets(self):
        for path in PAGES:
            with self.subTest(path=path):
                self.open(path)
                # Every footer link, including the brand block's tel:, mailto: and partner links.
                links=self.page.locator('.site-footer a').evaluate_all("els => els.map(el => ({text: el.textContent.trim(), href: el.getAttribute('href'), brand: !!el.closest('.foot-brand'), height: el.getBoundingClientRect().height}))")
                self.assertTrue(any(link['brand'] for link in links),f'{path}: footer brand links were not measured')
                short=[link for link in links if link['height']<44]
                self.assertEqual(short,[],path)

if __name__ == '__main__':
    unittest.main()
