"""Mobile staff touch policy on shipped HTML and CSS, exercised with WebKit.

Playwright's synthetic taps are useful regression checks, but do not replace a
physical iPhone check of native pinch and double-tap gestures.
"""
import os
import pathlib
import re
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGES = {
    'employee.html': ('#l-user', '.btn-main'),
    'employee-signup.html': ('#first-name', '.back'),
    'dispatch.html': (None, '.dispatch-back'),
    'message-templates.html': (None, '.templates-back'),
    'staff-login.html': ('#user', '#sl-submit'),
    'hub-login-setup.html': ('#password', '#generate'),
    'copilot.html': ('#l-user', '#login-button'),
    'crew/index.html': ('#gate-u', '#egc-gate .gbtn'),
    'crew/gameplan.html': ('#user', '#gate button'),
    'crew/prejob.html': ('#gate-u', '#egc-gate .gbtn'),
    'crew/postjob.html': ('#gate-u', '#egc-gate .gbtn'),
    'crew/job.html': (None, '.field-header a'),
    'crew/profile-photo.html': (None, '.cp-header a'),
    'crew/offline.html': (None, '.actions a'),
}
VIEWPORT = re.compile(r'<meta\s+name=["\']viewport["\']\s+content=["\']([^"\']+)', re.I)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class TouchViewportSourceTests(unittest.TestCase):
    def test_staff_pages_load_shared_policy_without_disabling_pinch_zoom(self):
        for path in PAGES:
            with self.subTest(path=path):
                source = (ROOT / path).read_text(encoding='utf-8')
                viewport = VIEWPORT.search(source)
                self.assertIsNotNone(viewport, path)
                content = viewport.group(1).lower().replace(' ', '')
                self.assertIn('width=device-width', content, path)
                self.assertRegex(content, r'initial-scale=1(?:\.0)?(?:,|$)', path)
                self.assertNotIn('maximum-scale', content, path)
                self.assertNotIn('user-scalable=no', content, path)
                if path in ('crew/offline.html', 'hub-login-setup.html'):
                    # The offline fallback is self-contained; the owner setup
                    # page also embeds CSS under its strict CSP.
                    self.assertRegex(source, r'touch-action\s*:\s*manipulation', path)
                else:
                    self.assertRegex(source, r'<link[^>]+href=["\']/app-touch\.css\?v=[^"\']+["\']', path)


class TouchZoomWebKitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.webkit.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={'width': 390, 'height': 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
            service_workers='block',
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.context.close()

    @staticmethod
    def route(route):
        url = urlparse(route.request.url)
        if url.hostname != '127.0.0.1':
            route.abort()
        elif url.path.endswith('.js'):
            # Only the real markup and stylesheet matter for this policy test.
            route.fulfill(status=200, content_type='application/javascript', body='')
        else:
            route.continue_()

    def open(self, path):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.goto(f'{self.origin}/{path}', wait_until='load')
        if path not in ('crew/offline.html', 'hub-login-setup.html'):
            self.assertEqual(self.page.locator('link[href*="/app-touch.css"]').count(), 1, path)

    def test_shipped_controls_keep_manipulation_and_inputs_at_least_16px(self):
        for path, (field, control) in PAGES.items():
            with self.subTest(path=path):
                self.open(path)
                values = self.page.evaluate('''([field,control])=>{
                  const get=selector=>selector?document.querySelector(selector):null;
                  const input=get(field),tap=get(control);
                  return {viewport:visualViewport?.scale, width:innerWidth,
                    root:getComputedStyle(document.documentElement).touchAction,
                    body:getComputedStyle(document.body).touchAction,
                    input:input?{touch:getComputedStyle(input).touchAction,font:parseFloat(getComputedStyle(input).fontSize)}:null,
                    tap:tap?getComputedStyle(tap).touchAction:null};
                }''', [field, control])
                self.assertEqual(values['width'], 390, (path, values))
                self.assertAlmostEqual(values['viewport'], 1, delta=0.01, msg=f'{path}: {values}')
                self.assertEqual(values['root'], 'manipulation', (path, values))
                self.assertEqual(values['body'], 'manipulation', (path, values))
                self.assertEqual(values['tap'], 'manipulation', (path, values))
                if field:
                    self.assertEqual(values['input']['touch'], 'manipulation', (path, values))
                    self.assertGreaterEqual(values['input']['font'], 16, (path, values))
                if path == 'copilot.html':
                    self.page.evaluate('''()=>{
                      document.querySelector('#login-screen').style.display='none';
                      document.querySelector('#copilot-screen').classList.add('active');
                    }''')
                    for width in (390, 320):
                        self.page.set_viewport_size({'width': width, 'height': 844})
                        composer = self.page.evaluate('''()=>{
                          const el=document.querySelector('#query-input'),bar=document.querySelector('.input-area');
                          return {font:parseFloat(getComputedStyle(el).fontSize),
                            width:el.getBoundingClientRect().width,
                            overflow:bar.scrollWidth>bar.clientWidth};
                        }''')
                        self.assertGreaterEqual(composer['font'], 16, (width, composer))
                        self.assertGreater(composer['width'], 80, (width, composer))
                        self.assertFalse(composer['overflow'], (width, composer))

    def test_dialog_scroller_stays_scrollable_and_two_taps_activate_twice(self):
        self.open('employee.html')
        self.page.evaluate('''()=>{
          window.__touchTapCount=0;
          const dialog=document.createElement('dialog');dialog.className='ac-dialog';dialog.id='touch-test-dialog';
          dialog.innerHTML='<div class="ac-dialog-header"><h2>Review</h2></div>'+
            '<div class="ac-dialog-body" id="touch-test-scroll"><p>Office review</p><div style="height:1800px"></div><p>End of review</p></div>'+
            '<div class="ac-dialog-footer"><button id="touch-test-button" type="button">Confirm</button></div>';
          document.body.append(dialog);dialog.showModal();
          document.querySelector('#touch-test-button').onclick=()=>window.__touchTapCount++;
        }''')
        values = self.page.evaluate('''()=>{
          const d=document.querySelector('#touch-test-dialog'),s=document.querySelector('#touch-test-scroll'),b=document.querySelector('#touch-test-button');
          return {dialog:getComputedStyle(d).touchAction,scroller:getComputedStyle(s).touchAction,
            button:getComputedStyle(b).touchAction,overflow:getComputedStyle(s).overflowY,
            room:s.scrollHeight-s.clientHeight};
        }''')
        self.assertEqual((values['dialog'], values['scroller'], values['button']), ('manipulation',)*3, values)
        self.assertIn(values['overflow'], ('auto', 'scroll'), values)
        self.assertGreater(values['room'], 500, values)
        # Playwright's mobile WebKit driver does not implement mouse.wheel.
        # Verify available scroll range and scrollTop, while the touch-action
        # check above protects native panning. Physical swipe remains manual QA.
        moved = self.page.locator('#touch-test-scroll').evaluate('(el)=>{el.scrollTop=460;return el.scrollTop}')
        self.assertGreater(moved, 0)
        button = self.page.locator('#touch-test-button').bounding_box()
        for _ in range(2):
            self.page.touchscreen.tap(button['x'] + button['width']/2, button['y'] + button['height']/2)
        self.assertEqual(self.page.evaluate('window.__touchTapCount'), 2)
        self.assertAlmostEqual(self.page.evaluate('visualViewport.scale'), 1, delta=0.01)

    def test_signature_canvas_keeps_its_deliberate_draw_gesture(self):
        self.open('crew/gameplan.html')
        value = self.page.evaluate('''()=>{
          const canvas=document.createElement('canvas');canvas.className='signature';
          document.body.append(canvas);return getComputedStyle(canvas).touchAction;
        }''')
        self.assertEqual(value, 'none')


if __name__ == '__main__':
    unittest.main()
