"""Phone-sized crew/prejob.html Quo send checks against an isolated /api/quo-send fixture.

The fixture replays a used Idempotency-Key the way functions/api/quo-send.js
does, so these checks prove the page keeps one key per job and script across
minutes, and never opens the SMS composer when the outcome is unknown.
"""
import datetime, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
JOB = {'customer': 'Dana Synthetic', 'phone': '(970) 555-0100', 'address': '746 Synthetic Grass Ln', 'total': 450,
       'date': '2026-09-23', 'time': '09:00', 'serviceType': 'Synthetic garage reset', 'assignedCrew': ['ZacB']}
ARRIVAL = "Hi Dana — the Easy Garage Cleaning crew is on the way to 746 Synthetic Grass Ln. We'll see you shortly. Reply here if anything changed."
# Stands in for the three gstatic Firebase compat scripts: auth succeeds and the
# job document read returns JOB. Every other external host is aborted.
FIREBASE_STUB = """
window.firebase = window.firebase || {
  apps: [], initializeApp() { this.apps.push({}); },
  auth() { return { signInWithCustomToken: async () => ({}), signOut: async () => {}, onAuthStateChanged() {} }; },
  firestore() {
    const doc = id => ({ id, get: async () => ({ id, exists: true, data: () => JSON.parse(JSON.stringify(window.__SYNTHETIC_JOB__)) }), set: async () => {} });
    return { collection: () => ({ doc }) };
  },
};
window.__SYNTHETIC_JOB__ = %s;
""" % json.dumps(JOB)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class PrejobSmsBrowserTests(unittest.TestCase):
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

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000)
        self.page.clock.install(time=datetime.datetime(2026, 9, 22, 12, 0, tzinfo=datetime.timezone.utc))
        self.errors, self.dialogs, self.sends, self.receipts, self.replies = [], [], [], {}, []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.context.route('**/*', self.route)

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.context.close()

    def route(self, route):
        url = route.request.url
        if url.startswith('https://www.gstatic.com/firebasejs/'):
            return route.fulfill(status=200, content_type='application/javascript', body=FIREBASE_STUB)
        if not url.startswith(self.url):
            return route.abort()
        path = url[len(self.url):].split('?')[0]
        if path == '/api/hub-auth':
            return self.json(route, {'ok': True, 'user': 'ZacB', 'displayName': 'Synthetic Owner', 'role': 'owner', 'businessAccess': True})
        if path == '/api/firebase-session':
            return self.json(route, {'ok': True, 'token': 'synthetic-firebase-token'})
        if path == '/api/highlevel':
            return self.json(route, {'ok': True})
        if path == '/api/quo-send':
            return self.quo_send(route)
        return route.continue_()

    def json(self, route, body, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

    def quo_send(self, route):
        request = route.request
        body, key = json.loads(request.post_data), request.headers.get('idempotency-key')
        self.assertEqual(request.headers.get('content-type'), 'application/json')
        self.assertEqual(body['idempotency_key'], key)
        self.sends.append({'key': key, 'message': body['message']})
        if key in self.receipts:
            saved = self.receipts[key]
            if saved['message'] != body['message']:
                return self.json(route, {'ok': False, 'code': 'QUO_SEND_IDEMPOTENCY_CONFLICT', 'error': 'Synthetic conflict'}, 409)
            if saved['status'] == 'sent':
                return self.json(route, {'ok': True, 'id': saved['id'], 'replayed': True})
            return self.json(route, {'ok': False, 'code': 'QUO_SEND_OUTCOME_UNKNOWN', 'error': 'Synthetic unknown outcome'}, 409)
        status = self.replies.pop(0) if self.replies else 'sent'
        self.receipts[key] = {'message': body['message'], 'status': status, 'id': f'synthetic-message-{len(self.receipts) + 1}'}
        if status == 'sent':
            return self.json(route, {'ok': True, 'id': self.receipts[key]['id']})
        return self.json(route, {'ok': False, 'code': 'QUO_SEND_OUTCOME_UNKNOWN', 'error': 'Quo did not confirm the message', 'status': 503}, 502)

    def open(self):
        self.page.goto(self.url + '/crew/prejob.html?jobId=job-1')
        expect(self.page.locator('#crew-workflow')).to_be_visible()
        expect(self.page.get_by_role('button', name='Send arrival text')).to_be_visible()

    def status(self, name):
        return self.page.locator('.itemact', has=self.page.get_by_role('button', name=name)).get_by_role('status')

    def test_retries_across_minutes_reuse_one_key_per_script(self):
        self.open()
        self.page.get_by_role('button', name='Send arrival text').click()
        expect(self.status('Send arrival text')).to_have_text('Sent through Quo.')
        self.page.clock.fast_forward('10:00')
        self.page.get_by_role('button', name='Send arrival text').click()
        expect(self.status('Send arrival text')).to_contain_text('Already sent')
        self.assertEqual(len(self.sends), 2)
        self.assertEqual(self.sends[0]['key'], self.sends[1]['key'], 'the key survives a minute boundary')
        self.assertRegex(self.sends[0]['key'], r'^prejob-arrival:job-1:[0-9a-f-]{36}$')
        self.assertEqual(self.sends[0]['message'], ARRIVAL)
        self.page.get_by_role('button', name='Send confirmation text').click()
        expect(self.status('Send confirmation text')).to_have_text('Sent through Quo.')
        self.assertRegex(self.sends[2]['key'], r'^prejob-confirmation:job-1:')
        self.assertIn('Flat rate locked at $450', self.sends[2]['message'])
        self.assertEqual(sum(1 for saved in self.receipts.values() if saved['status'] == 'sent'), 2, 'two scripts, two texts')
        self.assertEqual(self.dialogs, [])
        self.page.reload()
        expect(self.page.get_by_role('button', name='Send arrival text')).to_be_visible()
        self.page.get_by_role('button', name='Send arrival text').click()
        expect(self.status('Send arrival text')).to_contain_text('Already sent')
        self.assertEqual(self.sends[-1]['key'], self.sends[0]['key'], 'the key survives a reload')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), self.page.evaluate('innerWidth'))

    def test_unknown_outcome_shows_a_note_and_never_opens_the_composer(self):
        self.open()
        self.replies.append('uncertain')
        self.page.get_by_role('button', name='Send arrival text').click()
        note = self.status('Send arrival text')
        expect(note).to_contain_text('This text may already have been sent')
        expect(note).to_contain_text("Check the customer's conversation in Quo before resending")
        self.page.get_by_role('button', name='Send arrival text').click()
        expect(note).to_contain_text('may already have been sent')
        self.assertEqual(len(self.sends), 2)
        self.assertEqual(self.sends[0]['key'], self.sends[1]['key'])
        self.assertEqual(self.dialogs, [], 'no alert for an outcome that may already have reached the customer')
        self.assertTrue(self.page.url.endswith('/crew/prejob.html?jobId=job-1'), 'the SMS composer never opens')
        expect(self.page.get_by_role('button', name='Send arrival text')).to_be_enabled()
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), self.page.evaluate('innerWidth'))


if __name__ == '__main__':
    unittest.main()
