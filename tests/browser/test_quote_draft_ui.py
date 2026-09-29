"""Phone-sized "Send options for review" dialog against an isolated quote-draft API fixture."""
import copy, datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
# The walkthrough payload the gameplan builds: its itemized quote and the saved contact.
PLAN = {'client': {'name': 'Synthetic Customer', 'phone': '+19705550100', 'email': 'test@example.invalid', 'address': '100 Synthetic Way, Fort Collins, CO', 'highlevel_contact_id': 'contact-1'},
        'quote': {'title': 'EGC Garage Service — 100 Synthetic Way', 'total': 1400, 'estimated_duration_min': 240, 'catalog_version': '2026-09-pest200-traps250', 'line_items': [
            {'id': 'cleanout', 'kind': 'service', 'name': 'Garage cleanout and reset', 'description': 'Sorting, hauling and disposal for about 1 truckload', 'quantity': 1, 'unitCents': 90000, 'totalCents': 90000},
            {'id': 'shelving', 'kind': 'product', 'name': 'Wood shelving unit with a deliberately long name that must wrap on a phone', 'description': '', 'quantity': 1, 'unitCents': 44900, 'totalCents': 44900},
            {'id': 'totes', 'kind': 'product', 'name': 'Storage tote', 'description': '', 'quantity': 3, 'unitCents': 2150, 'totalCents': 6450}]},
        'logistics': {'crew_size': 2}}
PAGE = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<link rel="stylesheet" href="/crew/quote-draft.css"></head><body><main><button id="open" type="button" style="min-height:48px">Send options for review</button></main>'
        '<script src="/crew/quote-draft.js"></script><script>const PLAN=' + json.dumps(PLAN) + ';'
        'document.getElementById("open").addEventListener("click",()=>EGCQuoteDraft.open({storage:sessionStorage,fetch:(...a)=>fetch(...a),actor:async()=>"sales.person",uuid:()=>crypto.randomUUID(),'
        'plan:()=>structuredClone(PLAN),source:()=>"walk-1",savedJobId:()=>"",accept:r=>{window.accepted=(window.accepted||0)+1},onSent:r=>{window.sent=r.job.estimate.status}}));</script></body></html>').encode()

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/':
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()

class QuoteDraftBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        # Tokyo is already on 2026-09-23 at this instant; the default expiry must follow Denver.
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000)
        self.page.clock.install(time=datetime.datetime(2026, 9, 22, 18, tzinfo=datetime.timezone.utc))
        self.posts = []; self.errors = []; self.mode = 'off'; self.abort_sends = 0; self.abort_saves = 0; self.refuse_send = None; self.revision = 0
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def job(self, status='draft'):
        lines = [dict(line, optional=False, selected=True, included=True, group=None, tier=None) for line in PLAN['quote']['line_items']]
        return {'id': 'dispatch_job1', 'revision': f'r{self.revision}', 'customerId': 'customer-1', 'status': 'unscheduled', 'quoteStatus': status,
                'estimate': {'number': 'EST-JOB1', 'revision': 1, 'status': status, 'amountCents': 141350, 'validUntil': '2026-10-06', 'lineItems': lines, 'options': []}}
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/walkthrough-handoff':
            self.assertEqual(parse_qs(parsed.query), {'sourceWalkthroughId': ['walk-1']})
            send({'ok': True, 'viewer': {'id': 'sales.person'}, 'sourceRevision': 'w1r', 'customerId': 'customer-1', 'jobId': '', 'expectedRevision': '', 'roster': []}); return
        if parsed.path != '/api/quote-draft': route.continue_(); return
        body = req.post_data_json; self.posts.append(copy.deepcopy(body))
        if body['action'] == 'save' and self.abort_saves: self.abort_saves -= 1; route.abort('connectionreset'); return
        if body['action'] == 'save':
            self.revision += 1; send({'ok': True, 'requestId': body['requestId'], 'job': self.job(), 'warnings': []}); return
        if body['action'] == 'send_preview':
            recipient = {'channel': 'SMS', 'masked': '(•••) •••-0100'}
            send({'ok': True, 'job': self.job(), 'delivery': {'mode': self.mode, 'recipient': recipient}, 'summary': 'Send EST-JOB1 revision 1 ($1,413.50) to Synthetic Customer', 'confirmToken': 'ect1.synthetic-token', 'expiresAt': '2026-09-22T18:05:00.000Z'}); return
        if self.abort_sends: self.abort_sends -= 1; route.abort('connectionreset'); return
        if self.refuse_send:
            code, self.refuse_send = self.refuse_send, None
            send({'ok': False, 'code': code, 'error': 'This confirmation does not match the requested change. Review the action and confirm again.'}, 403); return
        self.revision += 1
        send({'ok': True, 'requestId': body['requestId'], 'job': self.job('sent'), 'warnings': [], 'delivery': {'status': 'submitted' if self.mode == 'automation' else 'messaging_disabled'}})
    def open(self):
        self.page.goto(self.url + '/'); self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.page.get_by_role('dialog', name='Send options for review'); expect(dialog).to_be_visible(); return dialog
    def assert_phone_layout(self):
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        box = self.page.locator('.qd-dialog').bounding_box(); self.assertLessEqual(box['x'] + box['width'], 375)
        small = self.page.evaluate("""[...document.querySelectorAll('.qd-dialog button, .qd-dialog input')].filter(el=>el.getBoundingClientRect().height<44).map(el=>el.outerHTML.slice(0,80))""")
        self.assertEqual(small, [])
        fonts = self.page.evaluate("""[...document.querySelectorAll('.qd-dialog input')].map(el=>parseFloat(getComputedStyle(el).fontSize))""")
        self.assertTrue(all(size >= 16 for size in fonts), fonts)
        self.assertIsNone(re.search(r'\bnull\b|\bundefined\b|NaN', self.page.locator('.qd-dialog').inner_text()))
    def test_save_preview_and_confirmed_send_on_a_phone(self):
        dialog = self.open()
        date = dialog.get_by_label('Options valid through')
        expect(date).to_have_value('2026-10-06'); expect(date).to_have_attribute('type', 'date'); expect(date).to_have_attribute('min', '2026-09-22')
        expect(dialog.get_by_text('$1,413.50')).to_be_visible()
        self.assert_phone_layout()
        self.page.screenshot(path=str(ROOT / 'test-results' / 'quote-draft-review-mobile.png'))
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog.get_by_text('Customer messaging is off')).to_be_visible()
        expect(dialog.get_by_text('Send EST-JOB1 revision 1 ($1,413.50) to Synthetic Customer')).to_be_visible()
        self.assert_phone_layout()
        self.page.screenshot(path=str(ROOT / 'test-results' / 'quote-draft-confirm-mobile.png'))
        self.assertEqual([post['action'] for post in self.posts], ['save', 'send_preview'], 'nothing is sent before the person confirms')
        save = self.posts[0]
        self.assertTrue(UUID.match(save['requestId']))
        self.assertEqual({key: save[key] for key in ['actorId', 'customerId', 'sourceWalkthroughId', 'sourceRevision']}, {'actorId': 'sales.person', 'customerId': 'customer-1', 'sourceWalkthroughId': 'walk-1', 'sourceRevision': 'w1r'})
        self.assertEqual(save['draft']['valid_until'], '2026-10-06'); self.assertEqual([line['id'] for line in save['draft']['line_items']], ['cleanout', 'shelving', 'totes'])
        self.assertEqual(self.posts[1], {'action': 'send_preview', 'jobId': 'dispatch_job1', 'expectedRevision': 'r1'})
        dialog.get_by_role('button', name='Mark as sent').click()
        expect(dialog.get_by_text('EST-JOB1 revision 1 is marked sent. Share the quote with the customer yourself.')).to_be_visible()
        send = self.posts[2]
        self.assertEqual({key: send[key] for key in ['action', 'jobId', 'expectedRevision', 'confirmToken']}, {'action': 'send', 'jobId': 'dispatch_job1', 'expectedRevision': 'r1', 'confirmToken': 'ect1.synthetic-token'})
        self.assertTrue(UUID.match(send['requestId']))
        self.assertEqual(self.page.evaluate('window.sent'), 'sent'); self.assertEqual(self.page.evaluate('window.accepted'), 1)
        dialog.get_by_role('button', name='Done').click(); expect(self.page.locator('.qd-dialog')).to_have_count(0)
        expect(self.page.get_by_role('button', name='Send options for review')).to_be_focused()
    def test_closing_before_confirmation_sends_nothing_and_automation_names_the_masked_recipient(self):
        self.mode = 'automation'; dialog = self.open()
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog.get_by_text("HighLevel's estimate-ready automation will notify the customer at (•••) •••-0100.")).to_be_visible()
        expect(dialog.get_by_role('button', name='Send to customer')).to_be_visible()
        dialog.get_by_role('button', name='Close').click(); expect(self.page.locator('.qd-dialog')).to_have_count(0)
        self.assertEqual([post['action'] for post in self.posts], ['save', 'send_preview'])
    def test_a_lost_send_response_retries_the_original_send_request(self):
        self.abort_sends = 1; dialog = self.open()
        dialog.get_by_role('button', name='Save draft').click()
        dialog.get_by_role('button', name='Mark as sent').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Your request is kept')
        retry = dialog.get_by_role('button', name='Retry original send'); expect(retry).to_be_visible()
        retry.click()
        expect(dialog.get_by_text('is marked sent')).to_be_visible()
        sends = [post for post in self.posts if post['action'] == 'send']
        self.assertEqual(len(sends), 2); self.assertEqual(sends[0], sends[1])
    def test_a_refused_confirmation_returns_to_review_instead_of_offering_a_blind_retry(self):
        self.refuse_send = 'confirm_token_mismatch'; dialog = self.open()
        dialog.get_by_role('button', name='Save draft').click()
        dialog.get_by_role('button', name='Mark as sent').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Save and preview the quote again.')
        expect(dialog.get_by_role('button', name='Save draft')).to_be_visible()
        expect(dialog.get_by_role('button', name='Retry original send')).to_have_count(0)
        self.assertFalse(self.page.evaluate("Object.keys(sessionStorage).some(key => key.startsWith('egc-quote-send-v1:'))"))
        self.assert_phone_layout()
        dialog.get_by_role('button', name='Save draft').click()
        dialog.get_by_role('button', name='Mark as sent').click()
        expect(dialog.get_by_text('is marked sent')).to_be_visible()
        sends = [post for post in self.posts if post['action'] == 'send']
        self.assertEqual(len(sends), 2); self.assertNotEqual(sends[0]['requestId'], sends[1]['requestId'])
        self.assertEqual([post['action'] for post in self.posts], ['save', 'send_preview', 'send', 'save', 'send_preview', 'send'])
    def test_a_lost_save_is_retried_as_frozen_and_later_edits_need_their_own_save(self):
        self.abort_saves = 1; dialog = self.open()
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Your request is kept')
        expect(dialog.get_by_role('button', name='Retry original save')).to_be_visible()
        dialog.get_by_role('button', name='Close').click(); expect(self.page.locator('.qd-dialog')).to_have_count(0)
        # The author edits the walkthrough (the cleanout is now $555.55) and opens the dialog again.
        self.page.evaluate('PLAN.quote.line_items[0].unitCents=55555;PLAN.quote.line_items[0].totalCents=55555')
        self.page.get_by_role('button', name='Send options for review').click()
        dialog = self.page.get_by_role('dialog', name='Send options for review')
        expect(dialog.get_by_text('An earlier save of this quote was not confirmed.')).to_be_visible()
        expect(dialog.get_by_text('$1,413.50')).to_be_visible(); expect(dialog.get_by_text('$1,069.05')).to_have_count(0)
        expect(dialog.get_by_text('Options valid through Oct 6, 2026')).to_be_visible()
        retry = dialog.get_by_role('button', name='Retry original save'); expect(retry).to_be_visible()
        self.assert_phone_layout()
        self.page.screenshot(path=str(ROOT / 'test-results' / 'quote-draft-frozen-retry-mobile.png'))
        retry.click()
        expect(dialog.get_by_text('Your later changes to the walkthrough are not saved yet.')).to_be_visible()
        expect(dialog.get_by_text('$1,069.05')).to_be_visible()
        expect(dialog.get_by_role('button', name='Save draft')).to_be_visible()
        self.assertEqual([post['action'] for post in self.posts], ['save', 'save'], 'nothing is previewed from the frozen save')
        self.assertEqual(self.posts[0], self.posts[1])
        dialog.get_by_role('button', name='Save draft').click()
        expect(dialog.get_by_role('button', name='Mark as sent')).to_be_visible()
        self.assertEqual([post['action'] for post in self.posts], ['save', 'save', 'save', 'send_preview'])
        self.assertNotEqual(self.posts[2]['requestId'], self.posts[0]['requestId'])
        self.assertEqual(self.posts[2]['draft']['line_items'][0]['totalCents'], 55555)

if __name__ == '__main__':
    unittest.main()
