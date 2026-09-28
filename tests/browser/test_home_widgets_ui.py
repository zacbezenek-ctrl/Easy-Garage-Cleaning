"""The overdue follow-ups home widget in a real browser: an isolated mount (the widget, its CSS and the UI kit) with a
routed /api/operations, and the real employee.html Command center through the home-widget registry. The clock is fixed
and the browser runs in Asia/Tokyo to prove Denver times. Every non-127.0.0.1 request is aborted or stubbed."""
import datetime, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, RESULTS

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime.datetime(2026, 9, 22, 18, 0, tzinfo=datetime.timezone.utc)
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
PAGE = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated overdue widget</title>'
        '<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-followups-home.css"></head>'
        '<body style="margin:0;background:#f4f3ef"><main id="host" style="padding:16px"></main><script src="/employee-followups-home.js"></script>'
        '<script>EGCFollowupsHome.mount(document.querySelector("#host"),{home:"today"})</script></body></html>').encode()
OWNERS = [{'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}, {'id': 'tylerg', 'name': 'Synthetic Phone Person With A Long Name', 'role': 'sales'}]


def at(**delta): return (NOW + datetime.timedelta(**delta)).isoformat().replace('+00:00', 'Z')
def task(n, **extra):
    return {'id': f'00000000-0000-4000-8000-{n:012d}', 'revision': 1, 'title': f'Synthetic follow-up {n}', 'kind': 'callback', 'status': 'open', 'priority': 'high',
            'assignedUserId': 'tylerg', 'waitingOn': 'none', 'dueAt': at(hours=-(n + 1)), 'reviewAt': None, 'approvalStatus': 'not_required', 'sourceEvidence': [], **extra}
def queue(items, total=None):
    total = len(items) if total is None else total
    return {'ok': True, 'items': items, 'total': total, 'offset': 0, 'nextOffset': len(items) if total > len(items) else None, 'asOf': at(),
            'coverage': {'registeredTasks': 'complete', 'inferredCommitments': 'not_complete'}}
OVERDUE = [task(1, dueAt=at(days=-3), kind='followup_message', assignedUserId='zacb',
                title='Call back Synthetic Johnson about the second-bay shelving quote and the haul-away date they asked to move'),
           task(2, dueAt=at(hours=-26)), task(3, waitingOn='customer', dueAt=at(days=1), reviewAt=at(minutes=-25), kind='send_quote'),
           task(4, assignedUserId=None, kind='prepare_quote'), task(5)]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if urlparse(self.path).path == '/widget':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(PAGE); return
        super().do_GET()


class IsolatedWidgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)
    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.errors = []; self.posts = []; self.identity = {'ok': True, 'enabled': True, 'actor': {'id': 'zacb', 'role': 'owner', 'kind': 'human'}, 'owners': OWNERS}
        self.answers = [(200, queue(OVERDUE, 7))]
        self.context = None
    def tearDown(self):
        if self.context: self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/operations': route.continue_(); return
        if request.method == 'GET': route.fulfill(status=200, content_type='application/json', body=json.dumps(self.identity)); return
        self.posts.append(request.post_data_json)
        status, body = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

    def open(self, width):
        mobile = width < 700
        self.context = self.browser.new_context(viewport={'width': width, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=mobile)
        page = self.context.new_page(); page.set_default_timeout(7000)
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.clock.install(time=NOW.isoformat().replace('+00:00', 'Z'))
        page.route('**/*', self.route)
        page.goto(self.url + '/widget')
        return page

    def fits(self, page, width):
        scroll = page.evaluate('()=>({doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,viewport:innerWidth})')
        self.assertLessEqual(scroll['doc'], width, scroll); self.assertLessEqual(scroll['body'], width, scroll)
        heights = page.locator('.egc-followups-home button').evaluate_all('nodes=>nodes.map(node=>node.getBoundingClientRect().height)')
        self.assertTrue(heights and all(height >= 44 for height in heights), heights)

    def test_overdue_list_shows_count_owner_kind_and_lateness_at_phone_widths(self):
        for width in (375, 390):
            with self.subTest(width=width):
                self.posts = []
                page = self.open(width)
                widget = page.locator('.egc-followups-home')
                expect(widget.locator('[data-fh-count]')).to_have_text('7')
                expect(widget.locator('.fh-count')).to_have_text('7 overdue actions')
                expect(widget.locator('.fh-item')).to_have_count(5)
                expect(widget.locator('.fh-item').nth(0).locator('.fh-meta')).to_have_text('Synthetic Owner · Followup message')
                expect(widget.locator('.fh-item').nth(0).locator('.fh-late')).to_have_text('Overdue by 3 days')
                expect(widget.locator('.fh-item').nth(1).locator('.fh-late')).to_have_text('Overdue by 26 h')
                expect(widget.locator('.fh-item').nth(2).locator('.fh-late')).to_have_text('Overdue by 25 min')
                expect(widget.locator('.fh-item').nth(3).locator('.fh-meta')).to_have_text('Unassigned · Prepare quote')
                expect(widget).to_contain_text('Showing the 5 most overdue of 7.')
                expect(widget).to_contain_text('Updated 12:00 PM · Denver time')
                expect(widget.get_by_role('button', name='Open follow-ups')).to_be_visible()
                self.assertEqual(len(self.posts), 1)
                self.assertRegex(self.posts[0]['requestId'], UUID)
                body = dict(self.posts[0]['body'])
                self.assertRegex(body.pop('dueBefore'), r'^2026-09-22T18:00:0\d\.\d{3}Z$', 'dueBefore is the installed clock, sent as UTC')
                self.assertEqual(body, {'command': 'queue', 'view': 'overdue', 'offset': 0, 'limit': 5}, 'an owner on the Command center reads the whole team')
                self.fits(page, width)
                page.screenshot(path=str(RESULTS / f'home-widget-overdue-{width}.png'), full_page=True)
                self.context.close(); self.context = None

    def test_a_verified_empty_queue_says_so_and_is_not_a_failure(self):
        self.answers = [(200, queue([]))]
        page = self.open(375)
        widget = page.locator('.egc-followups-home')
        expect(widget.locator('[data-fh-count]')).to_have_text('0')
        expect(widget.locator('.fh-empty')).to_have_text('No registered action is overdue.')
        expect(widget).to_contain_text('Commitments nobody recorded as an action are not counted.')
        expect(widget.locator('[role=alert]')).to_have_count(0)
        self.fits(page, 375)
        page.screenshot(path=str(RESULTS / 'home-widget-empty-375.png'), full_page=True)

    def test_a_503_shows_unavailable_never_zero_and_retry_recovers(self):
        self.answers = [(503, {'error': 'operations_unavailable', 'retryable': True, 'message': 'The outcome may be unknown.'}), (200, queue(OVERDUE[:2]))]
        page = self.open(390)
        alert = page.locator('.egc-followups-home [role=alert]')
        expect(alert).to_contain_text('Overdue follow-ups are unavailable')
        expect(alert).to_contain_text('This is not a count of zero.')
        expect(page.locator('[data-fh-count]')).to_have_count(0)
        expect(page.locator('.egc-followups-home')).not_to_contain_text('No registered action')
        self.fits(page, 390)
        page.screenshot(path=str(RESULTS / 'home-widget-unavailable-390.png'), full_page=True)
        alert.get_by_role('button', name='Retry').click()
        expect(page.locator('[data-fh-count]')).to_have_text('2')
        expect(page.locator('.egc-followups-home [role=alert]')).to_have_count(0)

    def test_a_disabled_backend_and_a_sales_viewer(self):
        self.identity = {**self.identity, 'enabled': False}
        page = self.open(375)
        expect(page.locator('.egc-followups-home')).to_contain_text('Follow-up tracking is not enabled')
        expect(page.locator('[data-fh-count]')).to_have_count(0)
        self.assertEqual(self.posts, [], 'no queue read while the backend is off')
        self.context.close(); self.context = None
        self.identity = {**self.identity, 'enabled': True, 'actor': {'id': 'tylerg', 'role': 'sales', 'kind': 'human'}}
        page = self.open(375)
        expect(page.locator('.egc-followups-home')).to_contain_text('Assigned to you · registered actions')
        self.assertEqual(self.posts[-1]['body']['owner'], 'tylerg')


class CommandCenterWidgetTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.operations = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1' or parsed.path != '/api/operations': super().route(route); return
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if request.method == 'GET': send({'ok': True, 'enabled': True, 'actor': {'id': 'zacb', 'role': 'owner', 'kind': 'human'}, 'owners': OWNERS}); return
        body = request.post_data_json['body']; self.operations.append(body)
        send(queue(OVERDUE, 7) if body['view'] == 'overdue' and body['limit'] == 5 else queue(OVERDUE) if body['command'] == 'queue' else {'error': 'operations_unavailable'}, 200 if body['command'] == 'queue' else 503)

    def test_the_command_center_shows_the_widget_and_opens_the_overdue_queue(self):
        page = self.open('today', width=375, height=812)
        widget = page.locator('#ops-home-widgets [data-hub-widget="overdue_followups"]')
        expect(widget.locator('[data-fh-count]')).to_have_text('7')
        expect(widget.locator('.fh-item')).to_have_count(5)
        self.assertEqual(page.locator('#ops-home-widgets').evaluate('node=>node.parentElement.id'), 'ops-main')
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        self.assertEqual(scroll['wide'], [])
        self.assertEqual(self.small_targets('#ops-home-widgets'), [])
        page.screenshot(path=str(RESULTS / 'home-widget-command-center-375.png'), full_page=True)
        widget.get_by_role('button', name='Open follow-ups').click()
        expect(page).to_have_url(re.compile(r'\?view=action_center$'))
        expect(page.locator('#egc-action-center [data-ac-view="overdue"]')).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#ops-home-widgets')).to_have_count(0)
        page.wait_for_function('()=>document.querySelectorAll("#egc-action-center .ac-list").length>0')
        # The Action Center's own list read (limit 50, besides its stat counts) is the overdue view.
        self.assertIn({'command': 'queue', 'view': 'overdue', 'limit': 50}, [{key: op.get(key) for key in ('command', 'view', 'limit')} for op in self.operations])


if __name__ == '__main__':
    unittest.main()
