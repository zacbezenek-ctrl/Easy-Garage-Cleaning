"""Invoicing screen (EGCMoney) mounted standalone with the Hub UI kit against routed synthetic APIs.
Batch issue, the HighLevel lifecycle trigger each issued invoice starts (through a recording stand-in for the
suite helper window.EGCCustomerCommunication), failure and recovery states, phone widths. The Hub sends no
customer message: any /api/messages request fails the test. No external host is reached."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
NOW = '2026-09-22T18:00:00Z'  # noon in Denver; already 03:00 on the 23rd in Tokyo
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
# The suite helper stand-in: read() returns the saved job the routed server wrote, sync() records the trigger it
# would start (the suite's syncCustomerCommunication, which reaches /api/highlevel) and answers __syncResult.
PAGE = b'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated EGC invoicing test</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-money.css"></head>
<body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main>
<script>sessionStorage.setItem('egc_u','TylerG');window.__toasts=[];window.__syncs=[];window.__syncResult=true;window.__syncGate=null;
window.EGCCustomerCommunication={
  read:async id=>{const response=await fetch('/__test/job/'+encodeURIComponent(id));return response.ok?response.json():null;},
  sync:async(job,event,marker)=>{window.__syncs.push({id:job.id,event,marker,notify:job.notify});if(window.__syncGate)await window.__syncGate;return window.__syncResult;},
};</script>
<script src="/employee-ui-kit.js"></script><script src="/employee-money.js"></script>
<script>EGCMoney.mount(document.querySelector('#host'),{identity:'TylerG',toast:message=>window.__toasts.push(message)});</script></body></html>'''


def listing(**changes):
    data = {
        'ok': True, 'authority': 'employee_hub', 'asOf': NOW, 'coverage': {'complete': True, 'asOf': NOW}, 'today': '2026-09-22', 'defaultDueDate': '2026-09-29', 'limits': {'maxItems': 25},
        'enabled': True, 'viewer': {'id': 'tylerg'},
        'candidates': [
            {'jobId': 'job-alpha', 'revision': 'rev-alpha', 'customerId': 'c-a', 'customer': 'Synthetic Alpha Garage With A Very Long Family Name Across The Row', 'serviceDate': '2026-09-10', 'status': 'completed', 'businessAccount': False, 'notify': True, 'automaticReminders': True, 'totalCents': 100000, 'paidCents': 25000, 'balanceCents': 75000, 'invoiceStatus': 'not_issued', 'estimateApproved': True},
            {'jobId': 'job-beta', 'revision': 'rev-beta', 'customerId': 'c-b', 'customer': 'Synthetic Beta Garage', 'serviceDate': '2026-09-15', 'status': 'completed', 'businessAccount': False, 'notify': True, 'totalCents': 120000, 'paidCents': 0, 'balanceCents': 120000, 'invoiceStatus': 'not_issued', 'estimateApproved': False},
            {'jobId': 'job-gamma', 'revision': 'rev-gamma', 'customerId': 'c-g', 'customer': 'Synthetic Gamma Garage', 'serviceDate': '2026-09-18', 'status': 'completed', 'businessAccount': True, 'notify': False, 'totalCents': 50000, 'paidCents': 0, 'balanceCents': 50000, 'invoiceStatus': 'void', 'estimateApproved': True},
        ],
        'review': [{'jobId': 'job-review', 'revision': 'rev-review', 'customerId': 'c-r', 'customer': 'Synthetic Review Garage', 'serviceDate': '2026-09-12', 'status': 'completed', 'businessAccount': False, 'notify': True, 'reason': 'payment_needs_review', 'message': 'A recorded payment on this job is waiting for verification.'}],
        'open': [
            {'jobId': 'job-sent', 'revision': 'rev-sent', 'customerId': 'c-s', 'customer': 'Synthetic Issued Garage', 'serviceDate': '2026-09-01', 'status': 'invoiced', 'businessAccount': False, 'notify': True, 'invoice': {'number': 'INV-SENT01', 'savedStatus': 'issued', 'dueDate': '2026-09-20', 'issuedAt': '2026-09-02T15:00:00.000Z'}, 'invoiceStatus': 'overdue', 'balanceCents': 50000},
            {'jobId': 'job-company', 'revision': 'rev-company', 'customerId': 'c-c', 'customer': 'Synthetic Company Project', 'serviceDate': '2026-09-03', 'status': 'invoiced', 'businessAccount': True, 'notify': False, 'invoice': {'number': 'INV-COMP01', 'savedStatus': 'issued', 'dueDate': '2026-10-01', 'issuedAt': '2026-09-04T15:00:00.000Z'}, 'invoiceStatus': 'issued', 'balanceCents': 90000},
        ],
    }
    data.update(changes)
    return data


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()


class InvoicingBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
        RESULTS.mkdir(exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.list = listing(); self.list_status = 200; self.issues = []; self.receipts = {}; self.saved = {}
        self.issue_fail = []; self.context = None; self.errors = []; self.messages = []
        self.per_call = None; self.hold = set(); self.held = []

    def tearDown(self):
        if self.context:
            self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
            self.assertEqual(self.messages, [], 'the Hub never calls /api/messages from Invoicing')
            self.context.close()

    def open(self, width=375, height=812):
        mobile = width < 700
        self.context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=mobile, has_touch=mobile)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.clock.install(time=NOW)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)
        self.page.goto(self.url + '/')
        return self.page

    def release(self):
        self.hold.clear(); held, self.held = self.held, []
        for route in held: self.route(route)

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if f'{request.method} {parsed.path}' in self.hold: self.held.append(route); return
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(body))
        if parsed.path.startswith('/__test/job/'):
            job = self.saved.get(unquote(parsed.path.rsplit('/', 1)[1]))
            send(job if job else {'ok': False}, 200 if job else 404); return
        if parsed.path == '/api/messages':
            self.messages.append(request.post_data_json); send({'ok': False, 'code': 'unexpected'}, 500); return
        if parsed.path == '/api/invoice-batch' and request.method == 'GET':
            if self.list_status != 200: send({'ok': False, 'code': 'money_storage_unavailable', 'error': 'The complete job money records could not be loaded. Retry.'}, self.list_status); return
            send(self.list); return
        if parsed.path == '/api/invoice-batch':
            body = request.post_data_json; self.issues.append(copy.deepcopy(body))
            failure = self.issue_fail.pop(0) if self.issue_fail else None
            if failure == 'abort': self.apply(body); route.abort(); return
            if failure: send({'ok': False, 'code': failure[0], 'error': failure[1]}, failure[2]); return
            send(self.apply(body)); return
        route.continue_()

    # The routed server: issue (or replay) the batch and save each issued job as the money service would.
    def apply(self, body):
        if body['requestId'] in self.receipts: return {**self.receipts[body['requestId']], 'replayed': True}
        notify = {row['jobId']: row['notify'] for row in listing()['candidates']}
        results = []
        for index, item in enumerate(body['items']):
            if self.per_call is not None and index >= self.per_call:
                results.append({'jobId': item['jobId'], 'ok': False, 'code': 'money_batch_not_attempted', 'error': 'This job was not attempted in this batch. Issue it again in a new batch.'}); continue
            request_id = f'11111111-1111-5111-8111-{len(self.saved):012d}'
            self.saved[item['jobId']] = {'id': item['jobId'], 'moneyRequestId': request_id, 'moneyUpdatedAt': '2026-09-22T18:00:00.000Z', 'notify': notify.get(item['jobId'], True), 'communicationLog': []}
            results.append({'jobId': item['jobId'], 'requestId': request_id, 'ok': True, 'status': 'issued', 'replayed': False, 'revision': 'issued-' + item['jobId'],
                            'invoice': {'number': 'INV-' + item['jobId'][-5:].upper(), 'status': 'issued', 'amountCents': 100000, 'dueDate': body['dueDate'], 'issuedAt': NOW}, 'balanceCents': 75000, 'warnings': []})
        done = sum(1 for row in results if row['ok'])
        reply = {'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': 'issue', 'replayed': False, 'dueDate': body['dueDate'], 'results': results,
                 'summary': {'total': len(results), 'issued': done, 'replayed': 0, 'failed': 0, 'notAttempted': len(results) - done}}
        self.receipts[body['requestId']] = reply
        issued = {row['jobId'] for row in results if row['ok']}
        self.list = listing(candidates=[row for row in self.list['candidates'] if row['jobId'] not in issued])
        return reply

    def syncs(self):
        return self.page.evaluate('window.__syncs')

    def no_horizontal_scroll(self):
        width = self.page.evaluate('document.documentElement.clientWidth')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)

    def small_targets(self):
        return self.page.evaluate('''[...document.querySelectorAll('.egc-invoicing button, .egc-invoicing .mn-main, .egc-invoicing .mn-all, .egc-invoicing input, .egc-invoicing summary')]
            .filter(el => el.offsetParent !== null).map(el => { const r = el.getBoundingClientRect(); const box = el.type === 'checkbox' ? el.closest('li,label').getBoundingClientRect() : r; return [el.textContent.trim() || el.name || el.type, Math.round(box.height)]; })
            .filter(([, height]) => height < 44)''')

    def test_batch_issue_on_a_phone_starts_one_highlevel_trigger_per_invoice_and_sends_nothing(self):
        page = self.open()
        expect(page.get_by_role('heading', name='Ready to invoice (3)')).to_be_visible()
        expect(page.get_by_role('heading', name='Open invoices (2)')).to_be_visible()
        expect(page.get_by_text('Sep 10, 2026 · Balance $750.00', exact=False)).to_be_visible()
        expect(page.get_by_text('No customer approval recorded', exact=False)).to_be_visible()
        expect(page.locator('input[name="dueDate"]')).to_have_value('2026-09-29')
        self.assertEqual(page.locator('input[name="dueDate"]').evaluate('el => getComputedStyle(el).fontSize'), '16px')
        issue = page.get_by_role('button', name='Issue invoice', exact=True); expect(issue).to_be_disabled()
        for width in [375, 320]:
            page.set_viewport_size({'width': width, 'height': 812}); self.no_horizontal_scroll()
        page.set_viewport_size({'width': 375, 'height': 812})
        self.assertEqual(self.small_targets(), [])
        page.screenshot(path=str(RESULTS / 'invoicing-list-375.png'), full_page=True)
        page.get_by_label('Synthetic Alpha Garage', exact=False).check()
        page.get_by_label('Synthetic Beta Garage', exact=False).check()
        expect(page.locator('.mn-bar-text')).to_have_text('2 selected · $1,950.00')
        page.locator('input[name="dueDate"]').fill('2026-10-06')
        page.get_by_role('button', name='Issue 2 invoices', exact=True).click()
        dialog = page.get_by_role('dialog', name='Issue 2 invoices?')
        expect(dialog).to_contain_text('starts the HighLevel invoice automation (tag egc-invoice-issued)')
        expect(dialog).to_contain_text('The Hub itself sends nothing')
        page.screenshot(path=str(RESULTS / 'invoicing-confirm-375.png'))
        dialog.get_by_role('button', name='Issue 2 invoices', exact=True).click()
        expect(page.locator('.mn-summary')).to_have_text('2 issued.')
        [issued] = self.issues
        self.assertTrue(UUID.match(issued['requestId'])); self.assertEqual(issued['action'], 'issue'); self.assertEqual(issued['dueDate'], '2026-10-06')
        self.assertEqual(issued['items'], [{'jobId': 'job-alpha', 'expectedRevision': 'rev-alpha'}, {'jobId': 'job-beta', 'expectedRevision': 'rev-beta'}])
        expect(page.locator('.mn-tag')).to_have_count(2)
        for tag in page.locator('.mn-tag').all(): expect(tag).to_have_text('HighLevel invoice automation started')
        expect(page.get_by_role('heading', name='Ready to invoice (1)')).to_be_visible()
        self.assertEqual(self.syncs(), [{'id': 'job-alpha', 'event': 'invoice-issued', 'marker': 'invoice:2026-09-22T18:00:00.000Z', 'notify': True},
                                        {'id': 'job-beta', 'event': 'invoice-issued', 'marker': 'invoice:2026-09-22T18:00:00.000Z', 'notify': True}], 'one standard invoice-issued trigger per invoice')
        self.assertIn('2 invoices issued · HighLevel invoice automation started', page.evaluate('window.__toasts'))
        self.assertEqual(page.locator('.egc-invoicing').get_by_role('button', name=re.compile('Send|Remind')).count(), 0, 'no Hub send or reminder control')
        self.no_horizontal_scroll(); page.screenshot(path=str(RESULTS / 'invoicing-issued-375.png'), full_page=True)
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(key => key.startsWith('egc.hub.pending.v1.'))"), [], 'nothing is left pending')

    def test_open_invoices_are_read_only_and_trigger_states_are_explained(self):
        page = self.open(1280, 900)
        open_rows = page.locator('.mn-open')
        expect(open_rows).to_have_count(2)
        expect(open_rows.first).to_contain_text('INV-SENT01 · due Sep 20, 2026 · Overdue')
        expect(open_rows.last).to_contain_text('Notifications off')
        # Without the job's automatic reminders (Enable auto) the Hub never adds egc-invoice-overdue: each row says so.
        expect(open_rows.first).to_contain_text('Overdue · Automatic overdue reminder off (Enable auto on the job)')
        expect(open_rows.last).not_to_contain_text('Automatic overdue reminder off')
        expect(page.locator('.mn-row', has_text='Synthetic Beta Garage')).to_contain_text('Automatic overdue reminder off (Enable auto on the job)')
        expect(page.locator('.mn-row', has_text='Synthetic Alpha Garage')).not_to_contain_text('Automatic overdue reminder off')
        expect(page.locator('.mn-row', has_text='Synthetic Gamma Garage')).not_to_contain_text('Automatic overdue reminder off')
        expect(page.get_by_text('The Hub starts the overdue workflow (tag egc-invoice-overdue) only for jobs with automatic reminders on (Enable auto on the job).')).to_be_visible()
        expect(page.get_by_text("HighLevel’s invoice and overdue workflows message the customer; the Hub sends nothing.")).to_be_visible()
        self.assertEqual(open_rows.locator('button').count(), 0, 'open invoices have no send or reminder buttons')
        # Gamma has notifications off; the stand-in reports a failed trigger for the others.
        page.evaluate('window.__syncResult = false')
        page.locator('input[name="selectAll"]').check()
        page.get_by_role('button', name='Issue 3 invoices', exact=True).click()
        dialog = page.get_by_role('dialog', name='Issue 3 invoices?')
        expect(dialog).to_contain_text('One job has notifications off and gets no automation.')
        dialog.get_by_role('button', name='Issue 3 invoices', exact=True).click()
        expect(page.locator('.mn-summary')).to_have_text('3 issued.')
        expect(page.locator('.mn-result', has_text='Synthetic Gamma Garage').locator('.mn-tag')).to_have_text('Notifications are off for this job, so no HighLevel automation')
        expect(page.locator('.mn-result', has_text='Synthetic Beta Garage').locator('.mn-tag')).to_have_text('HighLevel needs a retry · see Customer messages')
        self.assertEqual([row['id'] for row in self.syncs()], ['job-alpha', 'job-beta', 'job-gamma'], 'a job with notify off still goes through the suite helper, which suppresses it as the standard save does')
        self.assertIn('3 invoices issued · 1 with notifications off · 2 need Trigger in HighLevel', page.evaluate('window.__toasts'))

    def test_without_the_suite_helper_nothing_is_triggered_and_the_row_says_so(self):
        page = self.open()
        page.evaluate('delete window.EGCCustomerCommunication')
        page.get_by_label('Synthetic Beta Garage', exact=False).check()
        page.get_by_role('button', name='Issue invoice', exact=True).click()
        page.get_by_role('dialog', name='Issue this invoice?').get_by_role('button', name='Issue invoice', exact=True).click()
        expect(page.locator('.mn-tag')).to_have_text('HighLevel not triggered · use Trigger in HighLevel in Customer messages if still needed')
        self.assertIn('1 invoice issued · 1 needs Trigger in HighLevel', page.evaluate('window.__toasts'))

    def test_a_failed_load_is_unavailable_with_retry_never_an_empty_list(self):
        self.list_status = 503
        page = self.open()
        alert = page.get_by_role('alert'); expect(alert).to_contain_text('Invoicing is unavailable'); expect(alert).to_contain_text('Nothing here is shown as current')
        expect(page.get_by_text('No finished jobs are waiting', exact=False)).to_have_count(0)
        self.list_status = 200
        alert.get_by_role('button', name='Retry', exact=True).click()
        expect(page.get_by_role('heading', name='Ready to invoice (3)')).to_be_visible()

    def test_lost_issue_response_keeps_the_original_request_for_an_exact_retry_and_triggers_once(self):
        self.issue_fail = ['abort']
        page = self.open()
        page.get_by_label('Synthetic Beta Garage', exact=False).check()
        page.get_by_role('button', name='Issue invoice', exact=True).click()
        page.get_by_role('dialog', name='Issue this invoice?').get_by_role('button', name='Issue invoice', exact=True).click()
        expect(page.get_by_role('alert').filter(has_text='Invoices were not issued')).to_be_visible()
        self.assertEqual(self.syncs(), [], 'no trigger starts before the screen sees the issued invoice')
        retry = page.get_by_role('button', name='Retry original batch', exact=True); expect(retry).to_be_visible()
        expect(page.get_by_role('status').filter(has_text='An invoice batch was not confirmed')).to_contain_text('Discarding it does not: any invoice it already issued gets no HighLevel automation from here')
        expect(page.get_by_role('button', name='Issue invoice', exact=True)).to_be_disabled()
        retry.click()
        expect(page.locator('.mn-summary')).to_have_text('1 issued.')
        expect(page.locator('.mn-tag')).to_have_text('HighLevel invoice automation started')
        self.assertEqual(len(self.issues), 2); self.assertEqual(self.issues[0], self.issues[1], 'the retry is the same request and ID')
        self.assertEqual([row['id'] for row in self.syncs()], ['job-beta'])

    def test_one_confirmation_issues_the_whole_batch_across_requests_and_a_retry_carries_it_on(self):
        self.per_call = 1; self.issue_fail = [None, 'abort']
        page = self.open()
        page.locator('input[name="selectAll"]').check()
        page.get_by_role('button', name='Issue 3 invoices', exact=True).click()
        page.get_by_role('dialog', name='Issue 3 invoices?').get_by_role('button', name='Issue 3 invoices', exact=True).click()
        expect(page.get_by_role('alert').filter(has_text='Invoices were not issued')).to_be_visible()
        expect(page.locator('.mn-summary')).to_have_text('1 issued, 2 not attempted.')
        expect(page.get_by_role('button', name='Issue the remaining 2')).to_have_count(0)
        expect(page.locator('.mn-tag')).to_have_count(1)
        page.get_by_role('button', name='Retry original batch', exact=True).click()
        expect(page.locator('.mn-summary')).to_have_text('3 issued.')
        expect(page.get_by_role('heading', name='Ready to invoice (0)')).to_be_visible()
        items = [[row['jobId'] for row in issue['items']] for issue in self.issues]
        self.assertEqual(items, [['job-alpha', 'job-beta', 'job-gamma'], ['job-beta', 'job-gamma'], ['job-beta', 'job-gamma'], ['job-gamma']])
        self.assertEqual(self.issues[1], self.issues[2], 'the lost step is retried unchanged')
        self.assertEqual(len({issue['requestId'] for issue in self.issues}), 3, 'every other step has its own request ID')
        self.assertEqual(self.issues[3]['items'], [{'jobId': 'job-gamma', 'expectedRevision': 'rev-gamma'}]); self.assertEqual(self.issues[3]['dueDate'], '2026-09-29')
        expect(page.locator('.mn-tag')).to_have_count(3)
        # The triggers start one at a time: wait until none is still starting before reading them.
        expect(page.locator('.mn-tag', has_text='Starting the HighLevel invoice automation')).to_have_count(0)
        self.assertEqual(sorted(row['id'] for row in self.syncs()), ['job-alpha', 'job-beta', 'job-gamma'], 'every invoice the batch issued starts its trigger once, even the one issued before the failed step')
        self.assertIn('3 invoices issued · HighLevel invoice automation started for 2 · 1 with notifications off', page.evaluate('window.__toasts'))
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(key => key.startsWith('egc.hub.pending.v1.'))"), [])

    def test_a_list_reload_never_closes_the_open_confirmation_and_leaving_is_guarded_while_busy(self):
        unload = "() => { const e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return e.defaultPrevented; }"
        page = self.open()
        self.assertFalse(page.evaluate(unload))
        self.hold = {'GET /api/invoice-batch'}
        page.get_by_role('button', name='Refresh', exact=True).click()
        expect(page.get_by_role('button', name='Refreshing…')).to_be_visible()
        page.get_by_label('Synthetic Alpha Garage', exact=False).check()
        page.get_by_role('button', name='Issue invoice', exact=True).click()
        dialog = page.get_by_role('dialog', name='Issue this invoice?')
        self.release()
        expect(page.get_by_role('button', name='Refresh', exact=True)).to_be_visible()
        expect(dialog).to_be_visible()
        page.evaluate('() => { window.__syncGate = new Promise(resolve => { window.__openGate = resolve; }); }')
        self.hold = {'POST /api/invoice-batch'}
        dialog.get_by_role('button', name='Issue invoice', exact=True).click()
        expect(page.get_by_role('button', name='Issuing…')).to_be_visible()
        self.assertTrue(page.evaluate(unload), 'an issue in flight guards the page')
        self.release()
        expect(page.locator('.mn-summary')).to_have_text('1 issued.')
        expect(page.locator('.mn-tag')).to_have_text('Starting the HighLevel invoice automation…')
        self.assertTrue(page.evaluate(unload), 'a trigger still starting guards the page')
        page.evaluate('window.__openGate()')
        expect(page.locator('.mn-tag')).to_have_text('HighLevel invoice automation started')
        self.assertFalse(page.evaluate(unload))

    def test_server_money_off_is_explained(self):
        self.list = listing(enabled=False)
        page = self.open()
        expect(page.get_by_text('Batch invoicing is off')).to_be_visible()
        expect(page.get_by_label('Synthetic Beta Garage', exact=False)).to_be_disabled()
        expect(page.get_by_role('heading', name='Open invoices (2)')).to_be_visible()
        self.assertEqual(page.locator('.egc-invoicing').get_by_role('button', name=re.compile('Send|Remind')).count(), 0)


if __name__ == '__main__':
    unittest.main()
