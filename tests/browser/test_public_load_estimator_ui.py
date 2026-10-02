"""Offline public estimator acceptance. Never contacts lead or analytics providers."""
import os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
class PublicLoadEstimatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start()
        options={'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def test_responsive_keyboard_presets_reduced_motion_and_no_external_requests(self):
        for width in [320,375,768,1440]:
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':900},reduced_motion='reduce')
                context.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
                page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(self.url+'/index.html');root=page.locator('[data-load-estimator]');root.scroll_into_view_if_needed()
                slider=root.get_by_label('Choose your estimated load size')
                expect(slider).to_be_visible();slider.press('Home');expect(slider).to_have_value('1')
                slider.press('ArrowRight');expect(slider).to_have_value('2');expect(slider).to_have_attribute('aria-valuetext','¼ truck, 25 percent of truck space')
                slider.press('End');expect(slider).to_have_value('8');root.get_by_role('button',name='½ truck',exact=True).click();expect(slider).to_have_value('4')
                expect(root.locator('[data-load-price]')).to_have_text('Get an on-site quote')
                self.assertEqual(root.locator('.load-fill').evaluate('(el)=>getComputedStyle(el).transitionDuration'),'0s')
                self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'),width)
                self.assertFalse(errors)
                shots=ROOT/'test-results';shots.mkdir(exist_ok=True)
                page.screenshot(path=str(shots/f'public-load-estimator-{width}.png'))
                context.close()
    def test_without_javascript_booking_still_works(self):
        context=self.browser.new_context(java_script_enabled=False,viewport={'width':375,'height':812})
        context.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
        page=context.new_page();page.goto(self.url+'/pricing.html');root=page.locator('[data-load-estimator]')
        expect(root.locator('[data-load-controls]')).to_be_hidden();expect(root.get_by_role('link',name='Get my free walkthrough →')).to_have_attribute('href','/book')
        context.close()
if __name__=='__main__':unittest.main()
