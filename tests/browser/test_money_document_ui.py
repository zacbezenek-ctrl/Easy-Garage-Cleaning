"""Phone-width checks for the server-rendered money documents (under their real
no-script CSP) and for the customer portal's document links."""
import datetime, json, os, pathlib, subprocess, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = json.loads(subprocess.run(['node', str(ROOT / 'tests' / 'browser' / 'money_document_fixture.mjs')], check=True, capture_output=True, text=True, cwd=ROOT).stdout)
KINDS = ('estimate', 'invoice', 'receipt')

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/doc/') and path[5:] in KINDS:
            body = FIXTURE['documents'][path[5:]].encode()
            self.send_response(200)
            for name, value in FIXTURE['headers'].items(): self.send_header(name, value)
            self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class MoneyDocumentBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def open(self, path, width=375):
        context = self.browser.new_context(viewport={'width': width, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.addCleanup(context.close)
        page = context.new_page(); page.set_default_timeout(5000)
        page.clock.install(time=datetime.datetime(2026, 9, 22, 18, tzinfo=datetime.timezone.utc))
        errors, console = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: console.append(message.text) if message.type == 'error' else None)
        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.url) else route.abort())
        page.goto(self.url + path)
        self.addCleanup(lambda: self.assertEqual(errors, []))
        return page, console
    def assert_no_overflow(self, page, label):
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth'), label)

    def test_documents_fit_phone_widths_under_the_strict_csp(self):
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True)
        for width in (320, 375, 390):
            for kind in KINDS:
                page, console = self.open(f'/doc/{kind}', width)
                expect(page.get_by_role('heading', name=kind.capitalize(), exact=True)).to_be_visible()
                # The hashed stylesheet applied and the same-origin logo loaded; nothing was blocked.
                self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.doc')).maxWidth"), '820px')
                page.wait_for_function("document.querySelector('.logo').complete")
                self.assertGreater(page.evaluate("document.querySelector('.logo').naturalWidth"), 0)
                self.assertEqual([text for text in console if 'Content Security Policy' in text or 'Refused' in text], [])
                self.assert_no_overflow(page, f'{kind} at {width}px')
                heights = page.evaluate("[...document.querySelectorAll('a')].map(a=>[a.textContent,a.getBoundingClientRect().height])")
                self.assertTrue(heights)
                for text, height in heights: self.assertGreaterEqual(height, 44, f'{kind} link {text!r} at {width}px')
                if width == 375: page.screenshot(path=str(out / f'money-document-{kind}-375.png'), full_page=True)
        page, _ = self.open('/doc/invoice')
        pay = page.get_by_role('link', name='Pay $500,000.00 balance securely')
        expect(pay).to_have_attribute('href', '/customer-portal#pay')
        expect(page.locator('tr.excluded')).to_have_count(0)
        estimate, _ = self.open('/doc/estimate')
        expect(estimate.locator('tr.excluded')).to_contain_text('Synthetic epoxy floor')
        receipt, _ = self.open('/doc/receipt')
        expect(receipt.locator('.totals .tip')).to_contain_text('$50.00')

    def test_print_view_hides_screen_only_help(self):
        page, _ = self.open('/doc/invoice')
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.hint')).display"), 'block')
        page.emulate_media(media='print')
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.hint')).display"), 'none')
        self.assert_no_overflow(page, 'print')

    def test_portal_lists_document_links_and_pay_link_lands_on_pay(self):
        page, _ = self.open('/customer-portal.html?preview=1#pay')
        links = page.locator('#document-links a')
        expect(links).to_have_count(3)
        for index, (label, kind) in enumerate([('View estimate', 'estimate'), ('View invoice', 'invoice'), ('View receipt', 'receipt')]):
            expect(links.nth(index)).to_have_text(label)
            expect(links.nth(index)).to_have_attribute('href', f'/api/money-document?kind={kind}')
            expect(links.nth(index)).to_have_attribute('target', '_blank')
            self.assertGreaterEqual(links.nth(index).bounding_box()['height'], 44)
        expect(page.locator('#pay-button')).to_be_focused()
        self.assertTrue(page.evaluate("(()=>{const r=document.getElementById('pay-button').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"))
        self.assert_no_overflow(page, 'portal at 375px')
        out = ROOT / 'test-results'; out.mkdir(exist_ok=True)
        page.locator('#document-links').screenshot(path=str(out / 'portal-document-links-375.png'))

if __name__ == '__main__':
    unittest.main()
