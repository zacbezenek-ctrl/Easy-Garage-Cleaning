"""Client Login page and the link-confirm page at 375x812 against a routed fake API: the same message for every lookup,
the "Text us" fallback as soon as the on-load probe finds the service off or down, a confirm page that submits once,
44px targets, 16px inputs and no horizontal scroll.
No provider, Firestore or real customer data is touched. Run: python3 tests/browser/test_client_login_ui.py"""
import json, os, pathlib, subprocess, threading, time, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results' / 'client-login'
NOW = '2026-09-22T18:00:00Z'
TOKEN = 'Synthetic_login_token_0123456789abcdefghij'
GENERIC = "If we find a project for that phone or email, we'll send a sign-in link. It expires in 15 minutes."
ACCEPTED = {'ok': True, 'message': GENERIC}
READY = (405, {'ok': False, 'code': 'CUSTOMER_LOGIN_METHOD_NOT_ALLOWED', 'error': 'Use the Client Login page to request a sign-in link.'})

def render_confirm_page(name='confirmPage'):
    # The confirm and retry pages are rendered by the real Pages Function, not a copy.
    script = f"import {{ {name} }} from './functions/api/customer-login-verify.js'; process.stdout.write(await {name}(process.argv[1]).text());"
    return subprocess.run(['node', '--input-type=module', '-e', script, TOKEN], cwd=ROOT, check=True, capture_output=True, text=True, timeout=60).stdout

class Handler(SimpleHTTPRequestHandler):
    confirm_html = ''
    retry_html = ''
    posts = []
    delay = 0
    unfinished = 0
    def log_message(self, *args): pass
    def send_text(self, status, body, content_type, headers=()):
        data = body.encode(); self.send_response(status); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data)))
        for name, value in headers: self.send_header(name, value)
        self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/client-login': self.send_text(200, (ROOT / 'client-login.html').read_text(encoding='utf-8'), 'text/html; charset=utf-8')
        elif url.path == '/api/customer-login-verify' and parse_qs(url.query).get('token') == [TOKEN]: self.send_text(200, Handler.confirm_html, 'text/html; charset=utf-8')
        elif url.path.startswith('/api/'): self.send_text(404, '{}', 'application/json')
        else: super().do_GET()
    def do_POST(self):
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
        if url.path == '/api/customer-login-verify':
            Handler.posts.append({'body': body, 'origin': self.headers.get('Origin'), 'type': self.headers.get('Content-Type')})
            time.sleep(Handler.delay)
            if Handler.unfinished:
                # The sign-in did not commit: the real 503 retry page, with the link still unspent.
                Handler.unfinished -= 1
                return self.send_text(503, Handler.retry_html, 'text/html; charset=utf-8')
            self.send_text(303, '', 'text/plain', [('Location', '/client-login?status=signed_in')])
        else: self.send_text(404, '{}', 'application/json')

AUDIT = """() => {
  const visible = el => { if (el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || el.name || '').trim().slice(0, 40)}"`;
  const targets = [...document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=radio]), label.cl-tab')].filter(visible).filter(el => !el.closest('.cl-honeypot'));
  return {
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    small: targets.filter(el => el.getBoundingClientRect().height < 44).map(el => name(el) + ' ' + el.getBoundingClientRect().height.toFixed(1)),
    fonts: [...document.querySelectorAll('input:not([type=hidden]):not([type=radio])')].filter(visible).filter(el => !el.closest('.cl-honeypot')).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(name),
    outside: [...document.querySelectorAll('body *')].filter(visible).filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(name),
    submitBottom: document.querySelector('[type=submit]') ? document.querySelector('[type=submit]').getBoundingClientRect().bottom : null,
    scripts: document.scripts.length,
  };
}"""

class ClientLoginBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Handler.confirm_html = render_confirm_page()
        Handler.retry_html = render_confirm_page('retryPage')
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        OUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.errors, self.requests, self.replies, self.contexts, self.probes = [], [], [], [], []
        self.probe = READY
        Handler.posts, Handler.delay, Handler.unfinished = [], 0, 0

    def tearDown(self):
        for context in self.contexts: context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')

    def open(self, path, width=375, height=812, javascript=True):
        context = self.browser.new_context(viewport={'width': width, 'height': height}, is_mobile=True, has_touch=True, device_scale_factor=2, timezone_id='Asia/Tokyo', java_script_enabled=javascript)
        self.contexts.append(context)
        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == '127.0.0.1' else route.abort())
        page = context.new_page(); page.set_default_timeout(8000)
        page.clock.install(time=NOW)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/api/customer-login', self.api)
        page.goto(self.url + path)
        return page

    def api(self, route):
        request = route.request
        if request.method == 'GET':
            # The on-load readiness probe: 405 ready, 404 off, 503 not ready.
            self.probes.append(request.headers)
            if self.probe == 'abort': return route.abort()
            return route.fulfill(status=self.probe[0], content_type='application/json', body=json.dumps(self.probe[1]))
        self.requests.append({'method': request.method, 'headers': request.headers, 'body': json.loads(request.post_data or '{}')})
        status, body = self.replies.pop(0) if self.replies else (202, ACCEPTED)
        if status == 'abort': return route.abort()
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

    def audit(self, page, width=375):
        result = page.evaluate(AUDIT)
        self.assertLessEqual(result['scroll'], width, 'no horizontal scroll')
        self.assertEqual(result['small'], [], 'every tap target is at least 44px tall')
        self.assertEqual(result['fonts'], [], 'inputs are 16px so iOS does not zoom')
        self.assertEqual(result['outside'], [], 'nothing paints past the right edge')
        return result

    def test_known_and_unknown_contacts_get_the_same_message(self):
        page = self.open('/client-login')
        expect(page.locator('h1')).to_have_text('Client Login')
        phone = page.get_by_label('Mobile number')
        expect(phone).to_have_attribute('type', 'tel'); expect(phone).to_have_attribute('inputmode', 'tel'); expect(phone).to_have_attribute('autocomplete', 'tel')
        result = self.audit(page)
        self.assertLess(result['submitBottom'], 812, 'the primary action is on the first screen')
        page.screenshot(path=str(OUT / 'client-login-375.png'), full_page=True)
        phone.fill('(970) 555-0101')
        page.get_by_role('button', name='Send my sign-in link').click()
        expect(page.locator('#cl-sent')).to_be_visible()
        expect(page.locator('#cl-sent-message')).to_have_text(GENERIC)
        expect(page.locator('#cl-form')).to_be_hidden()
        sent = self.requests[0]
        self.assertEqual(sent['method'], 'POST')
        self.assertEqual(sent['body'], {'identifier': '(970) 555-0101', 'botcheck': ''})
        self.assertEqual(sent['headers']['content-type'], 'application/json'); self.assertEqual(sent['headers']['x-egc-portal'], '1')
        self.audit(page)
        page.screenshot(path=str(OUT / 'client-login-sent-375.png'), full_page=True)
        page.get_by_role('button', name='Use a different phone or email').click()
        expect(page.locator('#cl-form')).to_be_visible()
        page.locator('label.cl-tab', has_text='Email').click()
        email = page.get_by_label('Email address')
        expect(email).to_be_visible(); expect(page.locator('#cl-phone')).to_be_hidden()
        expect(email).to_have_attribute('type', 'email'); expect(email).to_have_attribute('inputmode', 'email'); expect(email).to_have_attribute('autocomplete', 'email')
        self.audit(page)
        # An address nobody has: the API still answers 202 with the same body, and the page shows the same message.
        email.fill('nobody@example.invalid')
        email.press('Enter')
        expect(page.locator('#cl-sent-message')).to_have_text(GENERIC)
        self.assertEqual(self.requests[1]['body'], {'identifier': 'nobody@example.invalid', 'botcheck': ''})

    def test_the_page_shows_text_us_before_anyone_types_when_sign_in_is_off_or_down(self):
        for probe in [(404, {'ok': False, 'code': 'CUSTOMER_LOGIN_UNAVAILABLE', 'error': 'Client Login is not available right now.'}), (503, {'ok': False, 'code': 'CUSTOMER_LOGIN_UNAVAILABLE', 'error': 'Down'}), 'abort']:
            self.probe = probe
            page = self.open('/client-login')
            expect(page.locator('#cl-fallback')).to_be_visible()
            expect(page.locator('#cl-form')).to_be_hidden()
            expect(page.get_by_role('link', name='Text (970) 999-1818')).to_have_attribute('href', 'sms:+19709991818')
            self.assertEqual(self.requests, [], 'nothing was posted')
            self.audit(page)
        page.screenshot(path=str(OUT / 'client-login-off-375.png'), full_page=True)
        self.probe = READY
        page = self.open('/client-login')
        expect(page.locator('#cl-form')).to_be_visible()
        page.wait_for_load_state('networkidle')
        expect(page.locator('#cl-fallback')).to_be_hidden()
        self.assertGreaterEqual(len(self.probes), 4)

    def test_disabled_unavailable_or_unreachable_service_falls_back_to_texting(self):
        for reply in [(404, {'ok': False, 'code': 'CUSTOMER_LOGIN_UNAVAILABLE', 'error': 'Client Login is not available right now.'}), (503, {'ok': False, 'code': 'CUSTOMER_LOGIN_UNAVAILABLE', 'error': 'Down'}), ('abort', None), (500, {})]:
            self.replies = [reply]
            page = self.open('/client-login')
            page.get_by_label('Mobile number').fill('970 555 0101')
            page.get_by_role('button', name='Send my sign-in link').click()
            expect(page.locator('#cl-fallback')).to_be_visible()
            expect(page.get_by_role('heading', name='Text us for a secure link')).to_be_visible()
            expect(page.get_by_role('link', name='Text (970) 999-1818')).to_have_attribute('href', 'sms:+19709991818')
            expect(page.locator('#cl-sent')).to_be_hidden()
            self.audit(page)
        page.screenshot(path=str(OUT / 'client-login-fallback-375.png'), full_page=True)

    def test_format_errors_stay_on_the_form_and_invalid_input_never_leaves_the_browser(self):
        page = self.open('/client-login')
        submit = page.get_by_role('button', name='Send my sign-in link')
        submit.click()
        expect(page.get_by_role('alert').filter(has_text='10-digit mobile number')).to_be_visible()
        page.get_by_label('Mobile number').fill('555-0101')
        submit.click()
        expect(page.locator('#cl-phone')).to_have_attribute('aria-invalid', 'true')
        self.assertEqual(self.requests, [], 'nothing is sent until the number is complete')
        self.replies = [(400, {'ok': False, 'code': 'CUSTOMER_LOGIN_IDENTIFIER_INVALID', 'error': 'Enter the mobile number or email address you use with Easy Garage Cleaning.'})]
        page.get_by_label('Mobile number').fill('970-555-0101')
        submit.click()
        expect(page.locator('#cl-error')).to_have_text('Enter the mobile number or email address you use with Easy Garage Cleaning.')
        expect(page.locator('#cl-form')).to_be_visible(); expect(submit).to_be_enabled()
        self.audit(page)

    def test_link_status_messages_and_the_confirm_page_post(self):
        page = self.open('/client-login?status=expired')
        expect(page.locator('#cl-status')).to_have_text('That sign-in link expired or is no longer valid. Request a new one below.')
        expect(page.locator('#cl-status-portal')).to_be_hidden()
        self.assertEqual(urlparse(page.url).query, '', 'the status is cleared from the address bar')
        page = self.open('/client-login?status=used')
        expect(page.locator('#cl-status')).to_contain_text('That sign-in link was already used. If you just tapped it, open your projects.')
        expect(page.locator('#cl-status')).to_contain_text('We send up to 3 links a day, so if no link arrives, text us at (970) 999-1818.')
        expect(page.get_by_role('link', name='Open my projects')).to_have_attribute('href', '/customer-portal')
        self.audit(page)
        page.screenshot(path=str(OUT / 'client-login-used-375.png'), full_page=True)
        page = self.open(f'/api/customer-login-verify?token={TOKEN}')
        expect(page.locator('h1')).to_have_text('Finish signing in')
        result = self.audit(page)
        self.assertEqual(result['scripts'], 1, 'only the same-origin double-tap guard')
        page.screenshot(path=str(OUT / 'client-login-confirm-375.png'), full_page=True)
        self.assertEqual(Handler.posts, [], 'opening the link spends nothing')
        # A real double tap: the second tap lands while the first sign-in is still on its way to the server.
        button = page.get_by_role('button', name='Sign in to my projects')
        box = button.bounding_box()
        Handler.delay = 0.8
        button.click(no_wait_after=True)
        page.wait_for_timeout(150)
        page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        expect(page.locator('#cl-status')).to_have_text("You’re signed in, but we couldn’t find an active project to open yet. Text us at (970) 999-1818 and we’ll help.")
        self.assertEqual(len(Handler.posts), 1)
        self.assertEqual(Handler.posts[0]['body'], f'token={TOKEN}')
        self.assertEqual(Handler.posts[0]['origin'], self.url)
        self.assertEqual(Handler.posts[0]['type'], 'application/x-www-form-urlencoded')

    def test_the_confirm_page_signs_in_without_javascript(self):
        page = self.open(f'/api/customer-login-verify?token={TOKEN}', javascript=False)
        self.audit(page)
        page.get_by_role('button', name='Sign in to my projects').click()
        page.wait_for_url(lambda url: urlparse(url).path == '/client-login')
        self.assertEqual(len(Handler.posts), 1)
        self.assertEqual(Handler.posts[0]['body'], f'token={TOKEN}')

    def test_a_sign_in_that_did_not_finish_offers_the_same_link_again(self):
        Handler.unfinished = 1
        page = self.open(f'/api/customer-login-verify?token={TOKEN}')
        page.get_by_role('button', name='Sign in to my projects').click()
        expect(page.locator('h1')).to_have_text('Sign-in didn’t finish')
        expect(page.get_by_role('link', name='Request a new link')).to_have_attribute('href', '/client-login')
        result = self.audit(page)
        self.assertEqual(result['scripts'], 1, 'only the same-origin double-tap guard')
        page.screenshot(path=str(OUT / 'client-login-retry-375.png'), full_page=True)
        page.get_by_role('button', name='Try again').click()
        expect(page.locator('#cl-status')).to_have_text("You’re signed in, but we couldn’t find an active project to open yet. Text us at (970) 999-1818 and we’ll help.")
        self.assertEqual([post['body'] for post in Handler.posts], [f'token={TOKEN}', f'token={TOKEN}'], 'the same link, tapped again')
        self.assertTrue(all(post['origin'] == self.url for post in Handler.posts))

    def test_narrow_phone_has_no_horizontal_scroll(self):
        for width in (320, 390):
            page = self.open('/client-login', width=width, height=740)
            self.audit(page, width)

if __name__ == '__main__':
    unittest.main()
