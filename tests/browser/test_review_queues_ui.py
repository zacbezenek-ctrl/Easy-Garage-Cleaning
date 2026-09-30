"""Review queues (REVIEWS-UI): held Stripe charges, Garage Guard member matches, unconfirmed messages
and the insurance certificate alert, on a phone, against a routed fake Hub API."""
import copy, json, os, pathlib, re, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, CREW, RESULTS

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)  # 12:00 PM in Denver, 3:00 AM Sept 23 in Tokyo
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
LEDGER = 'a' * 64
STALE = 'b' * 64

def stripe_view(can_refund=False):
    return {'ok': True, 'authority': 'employee_hub', 'counts': {'paymentReviews': 1, 'membershipReviews': 1},
            'paymentReviews': [{'sessionId': 'cs_test_held', 'revision': 'rev-p1', 'jobId': 'job-1', 'reason': 'payment_exceeds_balance', 'status': 'open', 'amountCents': 50000, 'currency': 'usd', 'paymentIntentId': 'pi_test_held', 'livemode': False,
                                'jobTotalCents': 100000, 'jobPaidCents': 70000, 'jobBalanceCents': 30000, 'createdBy': 'crew1', 'recordedBy': 'stripe_webhook', 'createdAt': '2026-09-21T23:30:00.000Z', 'customer': 'Synthetic Customer With A Long Household Name', 'jobFound': True, 'recordedOnJob': False}],
            'membershipReviews': [{'subscriptionId': 'sub_member_1', 'revision': 'rev-m1', 'reason': 'ambiguous_customer', 'status': 'open', 'plan': 'guard', 'candidateCustomerIds': ['cust-dana', 'cust-gone'],
                                   'candidates': [{'id': 'cust-dana', 'found': True, 'name': 'Synthetic Dana', 'phone': '(970) 555-0101', 'email': 'dana@example.invalid', 'address': '1 Synthetic Way, Fort Collins'}, {'id': 'cust-gone', 'found': False, 'name': '', 'phone': '', 'email': '', 'address': ''}],
                                   'customerName': 'Synthetic Dana', 'customerEmail': 'dana@example.invalid', 'phone': '+1 970 555 0101', 'serviceAddress': '1 Synthetic Way', 'eventId': 'evt_synthetic', 'createdAt': '2026-09-20T12:00:00.000Z', 'updatedAt': '2026-09-20T12:00:00.000Z'}],
            'viewer': {'canRecordRefund': can_refund}, 'checkoutBlock': True,
            'reasons': {'refund': {'duplicate_charge': 'Duplicate charge', 'exceeds_balance': 'More than the job balance', 'other': 'Other'}, 'dismiss': {'not_a_customer': 'Not a Hub customer yet', 'other': 'Other'}},
            'coverage': {'complete': True, 'asOf': '2026-09-22T18:00:00.000Z'}}

def send(ledger, status, in_flight, attempted='2026-09-22T17:00:00.000Z', automated=False):
    return {'id': ledger, 'revision': 'rev-' + ledger[:4], 'kind': 'on_my_way', 'label': 'On my way', 'audience': 'customer', 'targetType': 'job', 'targetId': 'job-1', 'targetName': 'Synthetic Customer', 'channel': 'SMS', 'recipient': '(•••) •••-0123',
            'status': status, 'inFlight': in_flight, 'attempts': 1, 'approval': 'owner_automation' if automated else 'template+human_trigger', 'automationMayResend': automated, 'maxAttempts': 3, 'resendable': False,
            'attemptedAt': attempted, 'completedAt': '', 'reason': '', 'httpStatus': 503, 'actorId': 'automation' if automated else 'crew1', 'source': 'cron' if automated else 'hub', 'subject': '', 'excerpt': 'Hi Synthetic, our crew is on the way and should arrive in about 20 minutes.', 'reconciled': None}

def sends_view():
    return {'ok': True, 'authority': 'employee_hub', 'sends': [send(LEDGER, 'uncertain', False), send(STALE, 'sending', True, '2026-09-22T17:57:00.000Z')], 'counts': {'unsettled': 2, 'inFlight': 1}, 'staleAfterMinutes': 10, 'coverage': {'complete': True, 'asOf': '2026-09-22T18:00:00.000Z'}}

def insurance_view(state='expired'):
    return {'ok': True, 'authority': 'employee_hub', 'revision': 'rev-1', 'flag': 'insurance_certificate_' + state, 'insurance': {'state': state, 'available': False, 'expiresOn': '2026-09-20', 'daysRemaining': 0}, 'history': [], 'driveConfigured': True}

PAGE = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-reviews.css"></head>
<body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main><div id="toasts"></div>
<script src="/employee-ui-kit.js"></script><script src="/employee-reviews.js"></script>
<script>window.__went=[];EGCReviews.mount(document.querySelector("#host"),{hubFetch:(url,init)=>fetch(url,{...init,credentials:"same-origin"}),toast:text=>{document.querySelector("#toasts").append(Object.assign(document.createElement("p"),{textContent:text}))},go:view=>window.__went.push(view)});</script></body></html>'''
ALERT = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/employee-suite.css"></head><body style="margin:0;padding:12px"><main id="ops-main"><div id="slot"></div><section class="ops-card"><h2>Command center</h2></section></main>
<script src="/employee-review-alerts.js"></script>
<script>window.__went=[];EGCReviewAlerts.mount(document.querySelector("#slot"),{hubFetch:(url,init)=>fetch(url,{...init,credentials:"same-origin"}),go:view=>window.__went.push(view)});</script></body></html>'''

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        pages = {'/hub-reviews': PAGE, '/hub-alerts': ALERT}
        if self.path in pages:
            body = pages[self.path].encode(); self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class ReviewQueuesBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'test-results').mkdir(exist_ok=True)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.install(time=NOW)
        self.errors = []; self.posts = []; self.gets = []; self.post_reply = None
        self.stripe = stripe_view(); self.sends = sends_view(); self.insurance = insurance_view(); self.failing = set(); self.forbidden = set()
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        reply = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        views = {'/api/stripe-reviews': lambda: self.stripe, '/api/message-sends': lambda: self.sends, '/api/portal-documents-admin': lambda: self.insurance}
        if parsed.path in views:
            if request.method == 'GET':
                self.gets.append(parsed.path)
                if parsed.path in self.failing: reply({'ok': False, 'code': 'stripe_review_unavailable', 'error': 'Stripe reviews could not be loaded. Retry.'}, 503); return
                if parsed.path in self.forbidden: reply({'ok': False, 'code': 'dispatch_forbidden', 'error': 'Only an operations manager or owner can do this.'}, 403); return
                reply(views[parsed.path]()); return
            body = request.post_data_json; self.posts.append((parsed.path, body))
            if self.post_reply: handler = self.post_reply; self.post_reply = None; handler(route, parsed.path, body); return
            if parsed.path == '/api/message-sends':
                self.sends = copy.deepcopy(self.sends); self.sends['sends'] = [row for row in self.sends['sends'] if row['id'] != body['ledgerId']]
                reply({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': 'reconcile', 'replayed': False, 'send': {'id': body['ledgerId'], 'status': 'failed'}}); return
            self.stripe = copy.deepcopy(self.stripe)
            key = 'paymentReviews' if body['action'].startswith('payment.') else 'membershipReviews'; field = 'sessionId' if key == 'paymentReviews' else 'subscriptionId'
            self.stripe[key] = [row for row in self.stripe[key] if row[field] != body['reviewId']]
            reply({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False, 'review': {'id': body['reviewId'], 'status': 'resolved'}}); return
        route.continue_()
    def open(self):
        self.page.goto(self.url + '/hub-reviews'); expect(self.page.get_by_role('heading', name='Review queues')).to_be_visible()
        expect(self.page.locator('.rv-summary')).to_have_text('1 held payment · 1 member match · 2 unconfirmed messages')
    def assert_mobile(self):
        for width in (320, 375, 390):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        # A checkbox is tapped through its label (the kit's .hub-check row), so the label is what must be 44px.
        small = self.page.evaluate("""() => [...document.querySelectorAll('button,a,select,input,textarea')].filter(node => node.offsetParent).map(node => node.type === 'checkbox' ? node.closest('label') || node : node).map(node => [node.textContent.trim().slice(0, 40) || node.name, node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""")
        self.assertEqual(small, [], 'every visible tap target is at least 44px tall')
        self.page.set_viewport_size({'width': 375, 'height': 812})
    def wait_for_gets(self, count):
        for _ in range(50):
            if len(self.gets) >= count: break
            self.page.wait_for_timeout(100)
        self.assertGreaterEqual(len(self.gets), count)
        self.page.wait_for_timeout(200)
    def dialog(self):
        dialog = self.page.locator('dialog.rv-dialog'); expect(dialog).to_be_visible(); return dialog

    def test_every_queue_and_the_insurance_alert_render_on_a_phone_in_denver_time(self):
        self.open(); page = self.page
        expect(page.get_by_role('alert').filter(has_text='Insurance certificate expired')).to_contain_text('It expired Sep 20, 2026')
        card = page.locator('.rv-card').filter(has_text='$500.00')
        expect(card).to_contain_text('Synthetic Customer With A Long Household Name'); expect(card).to_contain_text('Not on the job')
        expect(card).to_contain_text('Sep 21, 5:30 PM')  # Denver wall time on a Tokyo phone
        expect(card).to_contain_text('$300.00 of $1,000.00')
        expect(card.get_by_role('button', name='Record refund')).to_have_count(0); expect(card).to_contain_text('Only the owner records refunds.')
        expect(page.get_by_text('New card checkouts on these jobs are blocked until each review is resolved.')).to_be_visible()
        member = page.locator('.rv-card').filter(has_text='Garage Guard')
        expect(member.get_by_role('button', name='Link to this customer')).to_have_count(1, timeout=5000)
        expect(member).to_contain_text('Customer record not found')
        messages = page.locator('.rv-card').filter(has_text='On my way')
        expect(messages.nth(0)).to_contain_text('Outcome unknown'); expect(messages.nth(1)).to_contain_text('May still be sending')
        expect(messages.nth(1).get_by_role('button', name='Mark delivered')).to_be_disabled()
        page.screenshot(path=str(ROOT / 'test-results' / 'review-queues-375.png'), full_page=True)
        self.assert_mobile()
        page.get_by_role('button', name='Open Settings').click(); page.get_by_role('button', name='Message templates').click()
        self.assertEqual(page.evaluate('window.__went'), ['settings', 'message_templates'])

    def test_reconciling_a_charge_needs_a_note_then_saves_with_its_revision_and_leaves_the_queue(self):
        self.open(); page = self.page
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); note = dialog.get_by_label('How it was reconciled')
        self.assertEqual(note.evaluate('node => getComputedStyle(node).fontSize'), '16px')
        dialog.get_by_role('button', name='Mark reconciled').click()
        expect(dialog.get_by_role('alert')).to_have_text('How it was reconciled is required.'); self.assertEqual(self.posts, [])
        self.assert_mobile()
        note.fill('Applied $300 by check; refunded $200 in Stripe'); dialog.get_by_role('button', name='Mark reconciled').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        path, body = self.posts[0]
        self.assertEqual(path, '/api/stripe-reviews')
        self.assertEqual({key: body[key] for key in ('action', 'reviewId', 'expectedRevision', 'note')}, {'action': 'payment.reconcile', 'reviewId': 'cs_test_held', 'expectedRevision': 'rev-p1', 'note': 'Applied $300 by check; refunded $200 in Stripe'})
        self.assertRegex(body['requestId'], UUID)
        expect(page.locator('.rv-card').filter(has_text='$500.00')).to_have_count(0)
        expect(page.get_by_text('No card payments are held for review.')).to_be_visible()
        expect(page.locator('#toasts')).to_contain_text('Charge marked reconciled.')

    def test_the_owner_records_a_refund_with_a_reason(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('Refund the charge in the Stripe dashboard first')
        dialog.get_by_label('Reason').select_option('exceeds_balance'); dialog.get_by_label('Note (owner only)').fill('Customer paid twice')
        dialog.get_by_role('button', name='Record refund').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        body = self.posts[0][1]
        self.assertEqual({key: body[key] for key in ('action', 'reason', 'note', 'expectedRevision')}, {'action': 'payment.refund', 'reason': 'exceeds_balance', 'note': 'Customer paid twice', 'expectedRevision': 'rev-p1'})

    def test_a_refund_stripe_has_not_confirmed_keeps_the_dialog_open_with_the_reason(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_refund_not_found', 'error': 'Stripe does not show a refund for this charge yet. Refund it in the Stripe dashboard first, then record it here.'}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); dialog.get_by_label('Reason').select_option('duplicate_charge'); dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Stripe does not show a refund'); expect(dialog.get_by_role('button', name='Record refund')).to_be_enabled()

    def test_a_lost_response_keeps_the_exact_request_for_retry(self):
        self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.abort('connectionfailed')
        page.locator('.rv-card').filter(has_text='Garage Guard').get_by_role('button', name='Link to this customer').click()
        self.dialog().get_by_role('button', name='Link member').click()
        retry = page.get_by_role('button', name='Retry original change'); expect(retry).to_be_visible()
        expect(page.get_by_role('alert').filter(has_text='The last change was not confirmed')).to_be_visible()
        page.reload(); retry = page.get_by_role('button', name='Retry original change'); expect(retry).to_be_visible()
        retry.click(); expect(page.locator('.rv-feedback')).to_contain_text('The saved change is confirmed.')
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1], 'the retry is identical, including requestId')
        self.assertEqual({key: self.posts[0][1][key] for key in ('action', 'reviewId', 'customerId', 'expectedRevision')}, {'action': 'membership.link', 'reviewId': 'sub_member_1', 'customerId': 'cust-dana', 'expectedRevision': 'rev-m1'})
        expect(page.get_by_text('Every Garage Guard member is linked or closed.')).to_be_visible()

    def test_a_revision_conflict_reloads_the_queue_and_explains_why(self):
        self.open(); page = self.page; before = len(self.gets)
        self.post_reply = lambda route, path, body: route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_revision_conflict', 'error': 'This review changed after you opened it. Refresh and review it again.'}))
        page.locator('.rv-card').filter(has_text='Garage Guard').get_by_role('button', name='Close without linking').click()
        dialog = self.dialog(); dialog.locator('select[name=reason]').select_option('not_a_customer'); dialog.get_by_role('button', name='Close review').click()
        expect(page.locator('.rv-feedback')).to_contain_text('This record changed while you were editing')
        self.assertGreater(len(self.gets), before, 'the queue reloads the latest reviews')
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)

    def test_a_revision_conflict_keeps_the_typed_note_for_the_reopened_dialog(self):
        self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_revision_conflict', 'error': 'This review changed after you opened it. Refresh and review it again.'}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); dialog.get_by_label('How it was reconciled').fill('Applied $300 by check; refunded $200 in Stripe')
        dialog.get_by_role('button', name='Mark reconciled').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        expect(page.locator('.rv-feedback')).to_contain_text('What you typed is kept: open it again to finish.')
        # The reloaded review has a new revision; reopening restores the note and saves against it.
        self.stripe = copy.deepcopy(self.stripe); self.stripe['paymentReviews'][0]['revision'] = 'rev-p2'; page.get_by_role('button', name='Refresh').click()
        expect(page.get_by_role('button', name='Refresh')).to_be_enabled()
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog.get_by_label('How it was reconciled')).to_have_value('Applied $300 by check; refunded $200 in Stripe')
        expect(dialog).to_contain_text('What you typed before is filled in.')
        dialog.get_by_role('button', name='Mark reconciled').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual([body['expectedRevision'] for _, body in self.posts], ['rev-p1', 'rev-p2'])
        self.assertNotEqual(self.posts[0][1]['requestId'], self.posts[1][1]['requestId'], 'a conflict is final; the new attempt is a new request')
        self.assertEqual(self.posts[1][1]['note'], 'Applied $300 by check; refunded $200 in Stripe')

    def test_an_unconfigured_stripe_key_is_shown_in_the_dialog_and_never_kept_for_retry(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_stripe_unconfigured', 'error': 'Stripe is not configured, so the refund cannot be confirmed. Nothing was saved. Ask the owner to set the Stripe key, then record it again.'}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); dialog.get_by_label('Reason').select_option('duplicate_charge'); dialog.get_by_label('Note (owner only)').fill('Customer paid twice')
        dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Stripe is not configured'); expect(dialog.get_by_label('Note (owner only)')).to_have_value('Customer paid twice')
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)
        self.assertIsNone(page.evaluate("Object.keys(sessionStorage).find(key => key.startsWith('egc.hub.pending.v1.reviews')) || null"), 'nothing is kept for a retry that cannot succeed')

    def test_a_refund_on_a_charge_already_on_the_job_needs_the_owner_to_acknowledge_the_job_correction(self):
        self.stripe = stripe_view(can_refund=True); self.stripe['paymentReviews'][0]['recordedOnJob'] = True; self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False, 'review': {'id': body['reviewId'], 'status': 'resolved', 'resolution': 'refunded', 'recordedOnJobAtResolution': True}}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('does not change the job')
        dialog.get_by_label('Reason').select_option('duplicate_charge'); dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_have_text('Confirm that you will correct the job’s payment before recording the refund.'); self.assertEqual(self.posts, [])
        self.assert_mobile()
        dialog.get_by_label('I will correct the job’s payment').check(); dialog.get_by_role('button', name='Record refund').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[0][1][key] for key in ('action', 'reason', 'jobPaymentAcknowledged')}, {'action': 'payment.refund', 'reason': 'duplicate_charge', 'jobPaymentAcknowledged': True})
        expect(page.locator('#toasts')).to_contain_text('The job still counts this charge as paid until its payment is corrected.')

    def test_a_refund_stripe_showed_after_the_charges_review_was_closed_is_recorded_by_its_follow_up_review_id(self):
        self.stripe = stripe_view(can_refund=True)
        self.stripe['paymentReviews'][0].update({'reviewId': 'cs_test_held:refund', 'reason': 'payment_refunded', 'heldReason': 'payment_needs_review', 'refundedCents': 50000, 'keptCents': 0, 'refundSeenAt': '2026-09-22T17:00:00.000Z', 'recordedOnJob': True})
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='$500.00')
        expect(card).to_contain_text('Stripe showed this refund after the charge’s earlier review was closed.')
        expect(card).to_contain_text('Already on the job'); expect(card).to_contain_text('Stripe shows the full $500.00 refunded.')
        self.assert_mobile()
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 50000, 'refundedCents': 50000, 'keptCents': 0, 'refundFull': True, 'recordedOnJobAtResolution': True}}))
        self.post_reply = saved
        card.get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('does not change the job')
        dialog.get_by_label('Reason').select_option('duplicate_charge'); dialog.get_by_label('I will correct the job’s payment').check(); dialog.get_by_role('button', name='Record refund').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[0][1][key] for key in ('action', 'reviewId', 'expectedRevision', 'jobPaymentAcknowledged')}, {'action': 'payment.refund', 'reviewId': 'cs_test_held:refund', 'expectedRevision': 'rev-p1', 'jobPaymentAcknowledged': True})
        expect(page.locator('#toasts')).to_contain_text('The job still counts this charge as paid until its payment is corrected.')

    def test_a_partial_refund_on_a_charge_already_on_the_job_says_to_reduce_the_job_not_to_record_the_amount_kept(self):
        # A later, larger refund after the owner recorded $100: the job counts the full $500 less the $100 recorded, so it is reduced only by the $100 more.
        self.stripe = stripe_view(can_refund=True)
        self.stripe['paymentReviews'][0].update({'reviewId': 'cs_test_held:refund:2', 'reason': 'payment_refunded', 'refundedCents': 20000, 'keptCents': 30000, 'priorRefundedCents': 10000, 'refundSeenAt': '2026-09-22T17:00:00.000Z', 'recordedOnJob': True, 'livemode': True})
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='$500.00')
        expect(card).to_contain_text('Already on the job')
        expect(card.locator('.rv-refund')).to_have_text('Stripe shows $200.00 of $500.00 refunded. Reduce the job’s payment by $100.00 more ($200.00 refunded in all, $100.00 recorded earlier), so it counts only the $300.00 kept.')
        expect(card).not_to_contain_text('by the $200.00 refunded')
        expect(card).not_to_contain_text('kept is not on the job')
        expect(card).to_contain_text('A $100.00 refund on this charge was recorded earlier, and Stripe now shows more refunded. If the job was already reduced by $100.00, reduce it only by the difference.')
        self.assert_mobile()
        card.get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('does not change the job'); expect(dialog.get_by_label('I will correct the job’s payment')).to_be_visible()
        expect(dialog.get_by_text('kept is not on the job')).to_have_count(0)
        dialog.get_by_role('button', name='Cancel').click()
        # The Command Center says the same: reduce the job, never "record the amount kept".
        self.page.goto(self.url + '/hub-alerts')
        row = page.locator('.egc-review-alert').get_by_role('button').filter(has_text='1 card payment is held for review')
        expect(row).to_contain_text('Stripe shows $200.00 of $500.00 refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by $100.00 more ($200.00 refunded in all, $100.00 recorded earlier).')
        expect(row).not_to_contain_text('by the $200.00 refunded')
        expect(row).not_to_contain_text('not applied to the job'); expect(row).not_to_contain_text('kept is not on')
        self.assert_mobile()

    def test_the_owner_closing_a_test_mode_charge_stripe_cannot_check_is_told_it_closed_without_the_check(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        def closed(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'reconciled', 'amountCents': 50000, 'recordedOnJobAtResolution': False, 'stripeCheck': 'other_mode'}}))
        self.post_reply = closed
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('If Stripe cannot be checked for this test-mode charge (no Stripe key, or a live key), only the owner can close it, without the check.')
        dialog.get_by_label('How it was reconciled').fill('Test-mode charge from before going live'); dialog.get_by_role('button', name='Mark reconciled').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        expect(page.locator('#toasts')).to_have_text('Charge marked reconciled without a Stripe check (test-mode charge; the Hub now uses a live Stripe key).')
        expect(page.locator('.rv-feedback')).to_contain_text('without a Stripe check')

    def test_a_live_mode_charge_the_hub_cannot_check_stays_open_with_the_reason_in_the_dialog(self):
        self.stripe = stripe_view(can_refund=True); self.stripe['paymentReviews'][0]['livemode'] = True; self.open(); page = self.page
        message = "This is a live-mode charge, and the Hub's Stripe key is a test key, so it cannot be checked or closed yet. Nothing was saved. Set the live Stripe key (STRIPE_SECRET_KEY), then try again."
        self.post_reply = lambda route, path, body: route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_stripe_not_found', 'error': message}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog).not_to_contain_text('test-mode charge')
        dialog.get_by_label('How it was reconciled').fill('Refunded the excess'); dialog.get_by_role('button', name='Mark reconciled').click()
        expect(dialog.get_by_role('alert')).to_have_text(message)
        expect(page.locator('.rv-card').filter(has_text='$500.00')).to_be_visible(); expect(page.locator('#toasts')).to_have_text('')

    def test_a_partial_refund_reopens_with_the_amounts_and_needs_the_exact_amount_kept_confirmed(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 50000, 'refundedCents': 20000, 'keptCents': 30000, 'refundFull': False, 'recordedOnJobAtResolution': False}}))
        def partial(route, path, body):
            self.post_reply = saved
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_refund_partial', 'error': 'Stripe shows $200.00 of $500.00 refunded. The $300.00 kept is not on the job, and recording this refund closes the review for good.', 'details': {'amountCents': 50000, 'refundedCents': 20000, 'keptCents': 30000}}))
        self.post_reply = partial
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('If only part was refunded, the Hub shows the amount kept')
        dialog.get_by_label('Reason').select_option('exceeds_balance'); dialog.get_by_label('Note (owner only)').fill('Refunded the excess over the balance')
        dialog.get_by_role('button', name='Record refund').click()
        # The dialog reopens with Stripe's amounts, keeps what was typed and asks for the amount kept.
        dialog = page.locator('dialog.rv-dialog'); expect(dialog.get_by_role('heading')).to_have_text('Record a partial Stripe refund?')
        expect(dialog).to_contain_text('Stripe shows $200.00 of $500.00 refunded. The $300.00 kept is not on the job')
        # The money kept is recorded on the job first, while the open review still holds a new checkout, then the refund.
        expect(dialog).to_contain_text('recording this refund closes the review for good. Before recording it, record the $300.00 kept on the job under Estimates & payments.')
        expect(dialog.get_by_label('Reason')).to_have_value('exceeds_balance'); expect(dialog.get_by_label('Note (owner only)')).to_have_value('Refunded the excess over the balance')
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)
        dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_have_text('Confirm the $300.00 kept before recording the refund.'); self.assertEqual(len(self.posts), 1)
        self.assert_mobile()
        dialog.get_by_label('I have recorded the $300.00 kept on the job under Estimates & payments').check(); dialog.get_by_role('button', name='Record refund').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        first, second = self.posts[0][1], self.posts[1][1]
        self.assertNotIn('keptCentsAcknowledged', first)
        self.assertEqual({key: second[key] for key in ('action', 'reason', 'note', 'keptCentsAcknowledged', 'expectedRevision')}, {'action': 'payment.refund', 'reason': 'exceeds_balance', 'note': 'Refunded the excess over the balance', 'keptCentsAcknowledged': 30000, 'expectedRevision': 'rev-p1'})
        self.assertNotEqual(first['requestId'], second['requestId'], 'the refused request is not replayed; the confirmed one is new')
        expect(page.locator('#toasts')).to_contain_text('Refund recorded: $200.00 of $500.00 refunded. The $300.00 kept belongs on the job: check it is recorded under Estimates & payments.')
        expect(page.get_by_text('No card payments are held for review.')).to_be_visible()

    def test_a_held_tipped_charge_shows_its_tip_apart_and_the_owner_records_only_the_kept_service_part(self):
        # TIPS: a tipped charge is resolved here like any held charge; the tip is shown apart and never recorded as service.
        self.stripe = stripe_view(can_refund=True); self.stripe['checkoutBlock'] = False
        self.stripe['paymentReviews'][0].update({'reason': 'payment_tip_refused', 'amountCents': 55000, 'tipCents': 5000, 'serviceCents': 50000, 'createdBy': 'customer_portal'})
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='$550.00')
        expect(card).to_contain_text('Includes a crew tip, and the job was closed, voided or refunded after checkout opened.')
        expect(card.locator('.rv-tip')).to_have_text('Includes a crew tip: $500.00 service + $50.00 tip. Only the service part is ever recorded on the job; the tip is paid to the crew by hand.')
        expect(page.get_by_text('One held charge includes a crew tip: while customer tips are on, no new card checkout opens on its job until it is resolved. Resolve it before turning customer tips off.')).to_be_visible()
        # Reconciling it says to record the service part first, never the tip.
        card.get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('Record its $500.00 service part on the job under Estimates & payments before marking it reconciled (never the $50.00 crew tip, which is paid to the crew by hand)')
        dialog.get_by_role('button', name='Cancel').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assert_mobile()
        # Stripe shows part of it refunded: the kept money is split, and its service part is recorded on the job first.
        self.stripe = copy.deepcopy(self.stripe)
        self.stripe['paymentReviews'][0].update({'reason': 'payment_refunded', 'heldReason': 'payment_tip_refused', 'refundedCents': 20000, 'keptCents': 35000, 'keptServiceCents': 30000, 'keptTipCents': 5000, 'refundSeenAt': '2026-09-22T17:00:00.000Z'})
        page.get_by_role('button', name='Refresh').click(); expect(page.get_by_role('button', name='Refresh')).to_be_enabled()
        expect(card.locator('.rv-refund')).to_have_text('Stripe shows $200.00 of $550.00 refunded; the $350.00 kept is not on the job. Before recording the refund, record its service part on the job under Estimates & payments ($300.00 if the refund came out of the service first, or $350.00 if the crew tip was refunded first); up to $50.00 of the $350.00 kept is the crew tip, which is never a service payment.')
        expect(card).to_contain_text('First held because: includes a crew tip, and the job was closed, voided or refunded after checkout opened.')
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 55000, 'refundedCents': 20000, 'keptCents': 35000, 'refundFull': False, 'recordedOnJobAtResolution': False, 'tipCents': 5000, 'keptServiceCents': 30000, 'keptTipCents': 5000}}))
        def not_recorded(route, path, body):
            self.post_reply = saved
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_kept_not_recorded', 'error': "Record the $300.00 service part kept on the job under Estimates & payments first: the job's payments have grown by $0.00 since this charge was held, so the customer's Pay button would ask again for money this charge already paid. Then record the refund. Nothing was saved.",
                'details': {'amountCents': 55000, 'refundedCents': 20000, 'keptCents': 35000, 'keptServiceCents': 30000, 'keptTipCents': 5000, 'recordedSinceCents': 0}}))
        def partial(route, path, body):
            self.post_reply = not_recorded
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_refund_partial', 'error': 'Stripe shows $200.00 of $550.00 refunded.', 'details': {'amountCents': 55000, 'refundedCents': 20000, 'keptCents': 35000, 'keptServiceCents': 30000, 'keptTipCents': 5000}}))
        self.post_reply = partial
        card.get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); dialog.get_by_label('Reason').select_option('other')
        # The row already shows a partial refund, so the dialog asks which part was refunded.
        dialog.get_by_label('Which part did you refund in Stripe?').select_option('service'); dialog.get_by_role('button', name='Record refund').click()
        dialog = page.locator('dialog.rv-dialog'); expect(dialog.get_by_role('heading')).to_have_text('Record a partial Stripe refund?')
        expect(dialog).to_contain_text('The $350.00 kept is not on the job, and recording this refund closes the review for good (the customer’s Pay button comes back). Before recording it, record its service part on the job under Estimates & payments ($300.00 if the refund came out of the service first, or $350.00 if the crew tip was refunded first)')
        expect(dialog.get_by_label('Which part did you refund in Stripe?')).to_have_value('service')
        self.assert_mobile()
        dialog.get_by_label('I have recorded the service part kept ($300.00, or $350.00 if the crew tip was refunded first) on the job under Estimates & payments, never the tip').check(); dialog.get_by_role('button', name='Record refund').click()
        # Nothing was recorded on the job yet: the server refuses, the dialog stays open with its reason, and nothing is kept for a retry.
        expect(dialog.get_by_role('alert')).to_contain_text('Record the $300.00 service part kept on the job under Estimates & payments first')
        expect(page.locator('.rv-card').filter(has_text='$550.00')).to_be_visible(); expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)
        dialog.get_by_role('button', name='Record refund').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[1][1][key] for key in ('action', 'reason', 'keptCentsAcknowledged', 'tipRefundedFirst')}, {'action': 'payment.refund', 'reason': 'other', 'keptCentsAcknowledged': 35000, 'tipRefundedFirst': False})
        self.assertEqual(self.posts[2][1]['keptCentsAcknowledged'], 35000); self.assertNotEqual(self.posts[1][1]['requestId'], self.posts[2][1]['requestId'])
        expect(page.locator('#toasts')).to_contain_text('Refund recorded: $200.00 of $550.00 refunded. Of the $350.00 kept, the $300.00 service part belongs on the job (under Estimates & payments) and the $50.00 crew tip is paid to the crew by hand, never as a service payment.')
        page.screenshot(path=str(ROOT / 'test-results' / 'review-queues-tipped-375.png'), full_page=True)

    def test_a_refund_on_a_tipped_charge_already_on_the_job_reduces_only_its_service_part(self):
        # TIPS: the job counts only the $500 service part of a $550 tipped charge; the $50 tip is kept apart for tip payroll.
        self.stripe = stripe_view(can_refund=True)
        base = {'reason': 'payment_refunded', 'amountCents': 55000, 'tipCents': 5000, 'serviceCents': 50000, 'recordedOnJob': True, 'createdBy': 'customer_portal', 'refundSeenAt': '2026-09-22T17:00:00.000Z'}
        cases = [
            (55000, 'Stripe shows the full $550.00 refunded. The job counts only the $500.00 service part as paid; the $50.00 tip is kept apart, and tip payroll holds it until you pay what is owed by hand. Reduce the job’s service payment by $500.00 and pay the crew none of the $50.00 tip.'),
            (52000, 'Stripe shows $520.00 of $550.00 refunded. The job counts only the $500.00 service part as paid; the $50.00 tip is kept apart, and tip payroll holds it until you pay what is owed by hand. If the refund came out of the service first, reduce the job’s service payment by $500.00 and pay the crew only $30.00 of the $50.00 tip. If the crew tip was refunded first, reduce the job’s service payment by $470.00 and pay the crew none of the $50.00 tip.'),
            (20000, 'Stripe shows $200.00 of $550.00 refunded. The job counts only the $500.00 service part as paid; the $50.00 tip is kept apart, and tip payroll holds it until you pay what is owed by hand. If the refund came out of the service first, reduce the job’s service payment by $200.00 and pay the crew the whole $50.00 tip. If the crew tip was refunded first, reduce the job’s service payment by $150.00 and pay the crew none of the $50.00 tip.'),
        ]
        page = self.page
        for index, (refunded, text) in enumerate(cases):
            self.stripe = copy.deepcopy(self.stripe); kept = 55000 - refunded
            self.stripe['paymentReviews'][0] = {**stripe_view()['paymentReviews'][0], **base, 'refundedCents': refunded, 'keptCents': kept, 'keptServiceCents': max(0, kept - 5000), 'keptTipCents': min(kept, 5000)}
            if index == 0: self.open()
            else: page.get_by_role('button', name='Refresh').click(); expect(page.get_by_role('button', name='Refresh')).to_be_enabled()
            card = page.locator('.rv-card').filter(has_text='$550.00')
            expect(card).to_contain_text('Already on the job')
            expect(card.locator('.rv-tip')).to_have_text('Includes a crew tip: $500.00 service + $50.00 tip. The job counts only the service part as paid; the tip is kept apart on the job for tip payroll.')
            expect(card.locator('.rv-refund')).to_have_text(text)
            # Never the full Stripe amount, and never "paid to the crew by hand" as if the tip were not on the job.
            expect(card).not_to_contain_text('counts the full'); expect(card).not_to_contain_text('reduce the job’s payment by')
            self.assert_mobile()
        # The owner records the $200 refund, saying the crew tip was refunded first; the notice gives that correction.
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 55000, 'refundedCents': 20000, 'keptCents': 35000, 'refundFull': False, 'recordedOnJobAtResolution': True, 'tipCents': 5000, 'keptServiceCents': 35000, 'keptTipCents': 0, 'tipRefundedFirst': True}}))
        self.post_reply = saved
        page.locator('.rv-card').filter(has_text='$550.00').get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('This charge is already on the job, which counts its $500.00 service part as paid (the $50.00 tip is kept apart).')
        dialog.get_by_label('Reason').select_option('other'); dialog.get_by_label('Which part did you refund in Stripe?').select_option('tip')
        dialog.get_by_label('I will correct the job’s service payment and the crew tip').check()
        self.assert_mobile()
        dialog.get_by_role('button', name='Record refund').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[0][1][key] for key in ('action', 'jobPaymentAcknowledged', 'tipRefundedFirst')}, {'action': 'payment.refund', 'jobPaymentAcknowledged': True, 'tipRefundedFirst': True})
        self.assertNotIn('keptCentsAcknowledged', self.posts[0][1])
        expect(page.locator('#toasts')).to_contain_text('Refund recorded: $200.00 of $550.00 refunded. Reduce the job’s service payment by $150.00 and pay the crew none of the $50.00 tip.')
        # The Command Center never names a lump amount for a tipped charge.
        self.stripe = copy.deepcopy(stripe_view()); self.stripe['paymentReviews'][0].update({**base, 'refundedCents': 20000, 'keptCents': 35000})
        page.goto(self.url + '/hub-alerts')
        row = page.locator('.egc-review-alert').get_by_role('button').filter(has_text='1 card payment is held for review')
        expect(row).to_contain_text('Stripe shows $200.00 of $550.00 refunded on a charge with a crew tip that the job already counts as paid (its service part). Only the owner settles it: record the refund, then correct the job’s service payment and the crew tip as Review queues shows.')
        expect(row).not_to_contain_text('reduce the job’s payment by')
        self.assert_mobile()

    def test_reconciling_a_tipped_charge_not_on_its_job_needs_its_service_part_recorded_or_the_applied_elsewhere_box(self):
        # Seventh review: closing the hold gives the customer's Pay button back, so the service part must be on the job first.
        self.stripe = stripe_view(can_refund=True); self.stripe['checkoutBlock'] = False
        self.stripe['paymentReviews'][0].update({'reason': 'payment_tip_refused', 'amountCents': 55000, 'tipCents': 5000, 'serviceCents': 50000, 'createdBy': 'customer_portal'})
        self.open(); page = self.page
        refusal = "Not on the job: closing this review lets the job's $500.00 balance be paid again. First record its $500.00 service part under Estimates & payments (never the $50.00 tip); $0.00 recorded since the hold. Or tick that it went to another job or outside the Hub. Nothing was saved."
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'reconciled', 'amountCents': 55000, 'tipCents': 5000, 'recordedOnJobAtResolution': False, 'serviceAppliedElsewhere': True}}))
        def refused(route, path, body):
            self.post_reply = saved
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_service_not_recorded', 'error': refusal, 'details': {'amountCents': 55000, 'tipCents': 5000, 'serviceCents': 50000, 'recordedSinceCents': 0, 'jobBalanceCents': 50000}}))
        self.post_reply = refused
        card = page.locator('.rv-card').filter(has_text='$550.00')
        card.get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog()
        expect(dialog).to_contain_text('or, if it was applied to another job or settled outside the Hub, tick that box below.')
        expect(dialog.locator('.rv-dialog-warning')).to_have_text('Marking it reconciled lets the customer pay the job’s balance again. The Hub refuses it until its $500.00 service part is recorded on the job, unless you tick the box.')
        box = dialog.get_by_label('Applied to another job or settled outside the Hub: its $500.00 service part is not recorded on this job')
        expect(box).not_to_be_checked()
        self.assert_mobile()
        # Unticked, with nothing recorded: the server refuses, the dialog keeps what was typed and shows why.
        dialog.get_by_label('How it was reconciled').fill('Service recorded by hand'); dialog.get_by_role('button', name='Mark reconciled').click()
        expect(dialog.get_by_role('alert')).to_have_text(refusal)
        expect(dialog.get_by_label('How it was reconciled')).to_have_value('Service recorded by hand')
        self.assertNotIn('appliedElsewhere', self.posts[0][1])
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)
        # The service part went to another job: tick the box and save.
        dialog.get_by_label('How it was reconciled').fill('Applied the service part to job-2; tip paid with payroll'); box.check()
        dialog.get_by_role('button', name='Mark reconciled').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[1][1][key] for key in ('action', 'reviewId', 'note', 'appliedElsewhere')}, {'action': 'payment.reconcile', 'reviewId': 'cs_test_held', 'note': 'Applied the service part to job-2; tip paid with payroll', 'appliedElsewhere': True})
        self.assertNotEqual(self.posts[0][1]['requestId'], self.posts[1][1]['requestId'])
        expect(page.locator('#toasts')).to_have_text('Charge marked reconciled. Its service part was applied to another job or settled outside the Hub.')
        # An untipped charge, or one already on the job, never shows the box.
        self.stripe = stripe_view(can_refund=True); page.get_by_role('button', name='Refresh').click(); expect(page.get_by_role('button', name='Refresh')).to_be_enabled()
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        expect(self.dialog().get_by_label('Applied to another job or settled outside the Hub', exact=False)).to_have_count(0)

    def test_a_further_refund_after_a_closed_review_of_a_charge_not_on_its_job_is_corrected_where_that_review_put_the_money(self):
        # Seventh review: $200 of a $550 tipped charge was refunded and the $300 service part kept recorded by hand; Stripe now shows it all refunded.
        self.stripe = stripe_view(can_refund=True); self.stripe['checkoutBlock'] = False
        self.stripe['paymentReviews'][0].update({'reviewId': 'cs_test_held:refund', 'reason': 'payment_refunded', 'heldReason': 'payment_tip_refused', 'amountCents': 55000, 'tipCents': 5000, 'serviceCents': 50000,
            'refundedCents': 55000, 'keptCents': 0, 'keptServiceCents': 0, 'keptTipCents': 0, 'priorRefundedCents': 20000, 'priorKeptServiceCents': 30000, 'priorKeptTipCents': 5000, 'refundSeenAt': '2026-09-22T17:00:00.000Z', 'createdBy': 'customer_portal', 'recordedOnJob': False})
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='$550.00')
        expect(card).to_contain_text('Not on the job')
        expect(card.locator('.rv-refund')).to_have_text('Stripe shows the full $550.00 refunded; a $200.00 refund was recorded earlier. When this charge’s earlier review was closed, what it kept was recorded on the job by hand or applied to another job. Reduce the job’s service payment by $300.00 more and pay the crew none of the $50.00 tip.')
        expect(card).not_to_contain_text('kept is not on the job'); expect(card).not_to_contain_text('Before recording the refund')
        expect(card).to_contain_text('A $200.00 refund on this charge was recorded earlier, and Stripe now shows more refunded. Correct only for the refund beyond it.')
        self.assert_mobile()
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 55000, 'refundedCents': 55000, 'keptCents': 0, 'refundFull': True, 'recordedOnJobAtResolution': False, 'settledEarlierAtResolution': True, 'tipCents': 5000}}))
        self.post_reply = saved
        card.get_by_role('button', name='Record refund').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('when its earlier review was closed, what it kept was recorded on the job by hand or applied to another job')
        expect(dialog.get_by_text('I have recorded')).to_have_count(0)
        dialog.get_by_label('Reason').select_option('other'); dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_have_text('Confirm that you will correct that payment before recording the refund.'); self.assertEqual(self.posts, [])
        dialog.get_by_label('I will correct the payment recorded when the earlier review was closed (on this job or another) and the crew tip').check()
        self.assert_mobile()
        dialog.get_by_role('button', name='Record refund').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual({key: self.posts[0][1][key] for key in ('action', 'reviewId', 'jobPaymentAcknowledged')}, {'action': 'payment.refund', 'reviewId': 'cs_test_held:refund', 'jobPaymentAcknowledged': True})
        self.assertNotIn('keptCentsAcknowledged', self.posts[0][1])
        expect(page.locator('#toasts')).to_contain_text('Refund recorded. What the earlier review kept was recorded by hand, on this job or another: reduce the job’s service payment by $300.00 more and pay the crew none of the $50.00 tip.')
        # The Command Center says to correct that payment, never to record the amount kept.
        self.stripe = copy.deepcopy(stripe_view()); self.stripe['paymentReviews'][0].update({'reviewId': 'cs_test_held:refund', 'reason': 'payment_refunded', 'amountCents': 55000, 'tipCents': 5000, 'refundedCents': 55000, 'keptCents': 0, 'priorRefundedCents': 20000})
        page.goto(self.url + '/hub-alerts')
        row = page.locator('.egc-review-alert').get_by_role('button').filter(has_text='1 card payment is held for review')
        expect(row).to_contain_text('Stripe shows a further refund on a charge not on its job whose earlier review was closed')
        expect(row).not_to_contain_text('not applied to the job'); expect(row).not_to_contain_text('Estimates & payments')
        self.assert_mobile()

    def test_a_charge_stripe_shows_refunded_shows_the_amounts_and_only_the_owner_settles_it(self):
        self.stripe = stripe_view()
        self.stripe['paymentReviews'][0].update({'reason': 'payment_refunded', 'heldReason': 'payment_exceeds_balance', 'refundedCents': 20000, 'keptCents': 30000, 'refundSeenAt': '2026-09-22T17:00:00.000Z'})
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='$500.00')
        expect(card).to_contain_text('Stripe shows a refund on this charge.')
        expect(card).to_contain_text('Stripe shows $200.00 of $500.00 refunded; the $300.00 kept is not on the job.')
        expect(card).to_contain_text('First held because: charged more than the job balance at the time.')
        expect(card.get_by_role('button', name='Mark reconciled')).to_have_count(0); expect(card.get_by_role('button', name='Record refund')).to_have_count(0)
        expect(card).to_contain_text('only the owner settles it by recording the refund')
        self.assert_mobile()
        self.stripe = copy.deepcopy(self.stripe); self.stripe['viewer'] = {'canRecordRefund': True}
        page.get_by_role('button', name='Refresh').click(); expect(page.get_by_role('button', name='Refresh')).to_be_enabled()
        expect(card.get_by_role('button', name='Record refund')).to_be_visible(); expect(card.get_by_role('button', name='Mark reconciled')).to_be_visible()
        card.get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('A refund in Stripe is not reconciled here'); expect(dialog).not_to_contain_text('partly refunded')

    def test_mark_reconciled_on_a_charge_stripe_shows_partly_refunded_reopens_as_the_partial_refund_with_the_note_kept(self):
        self.stripe = stripe_view(can_refund=True); self.open(); page = self.page
        def saved(route, path, body):
            self.stripe = {**self.stripe, 'paymentReviews': []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'requestId': body['requestId'], 'action': body['action'], 'replayed': False,
                'review': {'id': body['reviewId'], 'kind': 'payment', 'status': 'resolved', 'resolution': 'refunded', 'amountCents': 50000, 'refundedCents': 20000, 'keptCents': 30000, 'refundFull': False, 'recordedOnJobAtResolution': False}}))
        def shown(route, path, body):
            self.post_reply = saved
            route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_refund_shown', 'error': 'Stripe shows $200.00 of $500.00 refunded, so this charge is settled by recording the refund, not by marking it reconciled. Use Record refund, which confirms the $300.00 kept. Nothing was saved.',
                'details': {'amountCents': 50000, 'refundedCents': 20000, 'keptCents': 30000, 'recordedOnJob': False}}))
        self.post_reply = shown
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('The Hub checks Stripe first.')
        dialog.get_by_label('How it was reconciled').fill('Refunded the $200 over the balance'); dialog.get_by_role('button', name='Mark reconciled').click()
        # Stripe shows part of it refunded: the refund dialog opens with the amounts, the typed note and the amount-kept confirmation.
        dialog = page.locator('dialog.rv-dialog'); expect(dialog.get_by_role('heading')).to_have_text('Record a partial Stripe refund?')
        expect(dialog).to_contain_text('Stripe shows a refund on this charge, so it is recorded as a refund, not reconciled.')
        expect(dialog).to_contain_text('Stripe shows $200.00 of $500.00 refunded. The $300.00 kept is not on the job')
        expect(dialog.get_by_label('Note (owner only)')).to_have_value('Refunded the $200 over the balance')
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0)
        dialog.get_by_label('Reason').select_option('exceeds_balance'); dialog.get_by_role('button', name='Record refund').click()
        expect(dialog.get_by_role('alert')).to_have_text('Confirm the $300.00 kept before recording the refund.'); self.assertEqual(len(self.posts), 1)
        self.assert_mobile()
        dialog.get_by_label('I have recorded the $300.00 kept on the job under Estimates & payments').check(); dialog.get_by_role('button', name='Record refund').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        first, second = self.posts[0][1], self.posts[1][1]
        self.assertEqual({key: first[key] for key in ('action', 'note', 'expectedRevision')}, {'action': 'payment.reconcile', 'note': 'Refunded the $200 over the balance', 'expectedRevision': 'rev-p1'})
        self.assertEqual({key: second[key] for key in ('action', 'reason', 'note', 'keptCentsAcknowledged', 'expectedRevision')}, {'action': 'payment.refund', 'reason': 'exceeds_balance', 'note': 'Refunded the $200 over the balance', 'keptCentsAcknowledged': 30000, 'expectedRevision': 'rev-p1'})
        self.assertNotEqual(first['requestId'], second['requestId'])
        expect(page.locator('#toasts')).to_contain_text('Refund recorded: $200.00 of $500.00 refunded. The $300.00 kept belongs on the job: check it is recorded under Estimates & payments.')

    def test_a_manager_reconciling_a_charge_stripe_shows_refunded_is_told_only_the_owner_settles_it(self):
        self.open(); page = self.page
        self.post_reply = lambda route, path, body: route.fulfill(status=403, content_type='application/json', body=json.dumps({'ok': False, 'code': 'stripe_review_owner_required', 'error': 'Stripe shows a refund on this charge, so only the owner can settle it, by recording the refund.'}))
        page.locator('.rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        dialog = self.dialog(); dialog.get_by_label('How it was reconciled').fill('Handled with the customer'); dialog.get_by_role('button', name='Mark reconciled').click()
        expect(dialog.get_by_role('alert')).to_contain_text('only the owner can settle it'); expect(dialog.get_by_role('heading')).to_have_text('Mark this charge reconciled?')
        expect(page.get_by_role('button', name='Retry original change')).to_have_count(0); self.assertEqual(len(self.posts), 1)
        self.assertIsNone(page.evaluate("Object.keys(sessionStorage).find(key => key.startsWith('egc.hub.pending.v1.reviews')) || null"), 'a definitive refusal is never kept for a retry')

    def test_a_held_portal_payment_says_the_customer_paid_in_the_portal(self):
        self.stripe['paymentReviews'][0].update({'reason': 'payment_refunded', 'createdBy': 'customer_portal', 'recordedBy': 'customer_portal', 'refundedCents': 50000, 'keptCents': 0})
        self.open(); card = self.page.locator('.rv-card').filter(has_text='$500.00')
        expect(card).to_contain_text('Customer portal'); expect(card).to_contain_text('Stripe shows the full $500.00 refunded.')

    def test_a_business_viewer_without_the_manager_role_is_told_the_queues_are_for_managers_and_the_owner(self):
        self.forbidden = {'/api/stripe-reviews', '/api/message-sends'}
        self.page.goto(self.url + '/hub-reviews'); page = self.page
        expect(page.get_by_role('status').filter(has_text='Managers and the owner only')).to_have_count(2)
        expect(page.get_by_text('could not be loaded')).to_have_count(0); expect(page.get_by_role('button', name='Retry')).to_have_count(0)
        expect(page.get_by_role('alert').filter(has_text='Insurance certificate expired')).to_be_visible()
        self.assert_mobile()

    def test_a_late_answer_from_highlevel_is_shown_beside_the_reconcile(self):
        late = send(STALE, 'failed', False)
        late.update({'reason': 'reconciled_not_delivered', 'reconciled': {'outcome': 'not_delivered', 'by': 'tylerg', 'at': '2026-09-22T17:11:00.000Z', 'note': 'Nothing in HighLevel', 'resend': True},
                     'lateResult': {'status': 'submitted', 'messageId': 'message-1', 'httpStatus': None, 'reason': '', 'at': '2026-09-22T17:12:00.000Z'}})
        self.sends = {**sends_view(), 'sends': [send(LEDGER, 'uncertain', False)], 'counts': {'unsettled': 1, 'inFlight': 0}, 'lateResults': [late], 'lateResultCoverage': {'complete': True, 'since': '2026-09-15T18:00:00.000Z', 'days': 7}}
        self.page.goto(self.url + '/hub-reviews'); page = self.page
        section = page.locator('.rv-late'); expect(section.get_by_role('heading', name='HighLevel answered after a person reconciled')).to_be_visible()
        expect(section).to_contain_text('From the last 7 days.')
        card = section.locator('.rv-card'); expect(card).to_contain_text('Differs from the reconcile')
        expect(card).to_contain_text('Marked not delivered by tylerg on Sep 22, 11:11 AM. HighLevel then accepted it (message message-1) on Sep 22, 11:12 AM.')
        expect(card).to_contain_text('It reached HighLevel, so it is never sent again.')
        expect(card.get_by_role('button')).to_have_count(0)
        expect(page.locator('.rv-summary')).to_have_text('1 held payment · 1 member match · 1 unconfirmed message')
        self.assert_mobile()

    def test_an_unconfirmed_message_is_reconciled_with_a_note_and_nothing_is_sent(self):
        self.open(); page = self.page
        card = page.locator('.rv-card').filter(has_text='Outcome unknown')
        card.get_by_role('button', name='Mark not delivered').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('Nothing is sent now; a person can preview and send it again (it tries up to 3 times)')
        dialog.get_by_label('How you checked').fill('No message in the HighLevel thread'); dialog.get_by_role('button', name='Mark not delivered').click()
        expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        path, body = self.posts[0]
        self.assertEqual(path, '/api/message-sends')
        self.assertEqual(body, {**body, 'action': 'reconcile', 'ledgerId': LEDGER, 'expectedRevision': 'rev-aaaa', 'outcome': 'not_delivered', 'note': 'No message in the HighLevel thread'})
        self.assertNotIn('resend', body, 'by default the policy decides whether it may be sent again')
        expect(page.locator('.rv-card').filter(has_text='Outcome unknown')).to_have_count(0)
        self.assertTrue(all(path != '/api/messages' for path, _ in self.posts), 'no send endpoint is ever called')

    def test_an_automated_reminder_says_the_automation_may_resend_it_unless_stopped(self):
        self.sends = {**sends_view(), 'sends': [send(LEDGER, 'uncertain', False, automated=True)], 'counts': {'unsettled': 1, 'inFlight': 0}}
        self.page.goto(self.url + '/hub-reviews'); page = self.page
        page.locator('.rv-card').filter(has_text='Outcome unknown').get_by_role('button', name='Mark not delivered').click()
        dialog = self.dialog(); expect(dialog).to_contain_text('the owner’s automation may send this message again on its next run (it tries up to 3 times)')
        expect(dialog).not_to_contain_text('Nothing is resent automatically')
        dialog.get_by_label('How you checked').fill('Checked HighLevel: not delivered'); dialog.get_by_label('Do not send it again').check()
        self.assert_mobile()
        dialog.get_by_role('button', name='Mark not delivered').click(); expect(page.locator('dialog.rv-dialog')).to_have_count(0)
        self.assertEqual(self.posts[0][1]['resend'], False)
        expect(page.locator('#toasts')).to_contain_text('Message marked not delivered. It will not be sent again.')

    def test_more_messages_than_one_page_say_the_list_is_the_first_page_not_the_newest(self):
        self.sends = {**sends_view(), 'coverage': {'complete': False, 'asOf': '2026-09-22T18:00:00.000Z'}}; self.open()
        expect(self.page.get_by_text('Showing the first 2 messages only; more are waiting.')).to_be_visible()
        expect(self.page.get_by_text('newest', exact=False)).to_have_count(0)

    def test_a_queue_that_cannot_load_shows_unavailable_with_retry_never_empty(self):
        self.failing = {'/api/stripe-reviews'}; self.page.goto(self.url + '/hub-reviews'); page = self.page
        alert = page.get_by_role('alert').filter(has_text='Held Stripe payments and member matches could not be loaded')
        expect(alert).to_be_visible(); expect(page.get_by_text('No card payments are held for review.')).to_have_count(0)
        expect(page.locator('.rv-card').filter(has_text='Outcome unknown')).to_be_visible()
        self.failing = set(); alert.get_by_role('button', name='Retry').click()
        expect(page.locator('.rv-card').filter(has_text='$500.00')).to_be_visible()

    def test_unavailable_summary_and_restricted_insurance_do_not_render_null(self):
        self.failing = {'/api/stripe-reviews', '/api/message-sends'}
        self.forbidden = {'/api/portal-documents-admin'}
        self.page.goto(self.url + '/hub-reviews'); page = self.page
        expect(page.get_by_role('alert').filter(has_text='Held Stripe payments and member matches could not be loaded')).to_be_visible()
        expect(page.get_by_role('alert').filter(has_text='Messages with an unknown outcome could not be loaded')).to_be_visible()
        expect(page.locator('.rv-summary')).to_have_count(0)
        expect(page.get_by_text('null', exact=True)).to_have_count(0)
        self.assertNotIn('null', page.locator('.egc-reviews').evaluate('(root) => [...root.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim())'))

    def test_the_command_center_alert_lists_waiting_items_and_links_to_the_queues(self):
        self.page.goto(self.url + '/hub-alerts'); page = self.page
        # One of the two messages may still be sending, so only one waits for a person.
        alert = page.locator('.egc-review-alert'); expect(alert).to_contain_text('4 items are waiting for a person')
        for text in ('1 card payment is held for review', '1 Garage Guard member needs a customer link', '1 message has an unknown outcome', 'The insurance certificate expired'):
            expect(alert.get_by_role('button').filter(has_text=text)).to_be_visible()
        self.assert_mobile()
        page.screenshot(path=str(ROOT / 'test-results' / 'review-alert-375.png'), full_page=True)
        alert.get_by_role('button').filter(has_text='card payment').click(); alert.get_by_role('button').filter(has_text='insurance').click()
        self.assertEqual(page.evaluate('window.__went'), ['reviews', 'settings'])

    def test_the_command_center_alert_names_the_amount_kept_from_a_partial_refund(self):
        self.stripe['paymentReviews'][0].update({'reason': 'payment_refunded', 'refundedCents': 20000, 'keptCents': 30000})
        self.page.goto(self.url + '/hub-alerts'); page = self.page
        row = page.locator('.egc-review-alert').get_by_role('button').filter(has_text='1 card payment is held for review')
        expect(row).to_contain_text('Stripe shows a refund on it, so only the owner settles it.')
        expect(row).to_contain_text('$200.00 of $500.00 was refunded, so the $300.00 kept is not on the job until it is recorded under Estimates & payments.')
        self.assert_mobile()

    def test_the_command_center_alert_stays_empty_when_everything_is_clear_and_says_so_when_it_cannot_check(self):
        self.stripe = {**stripe_view(), 'paymentReviews': [], 'membershipReviews': []}; self.sends = {**sends_view(), 'sends': []}; self.insurance = insurance_view('current')
        self.page.goto(self.url + '/hub-alerts'); page = self.page
        expect(page.get_by_role('heading', name='Command center')).to_be_visible(); self.wait_for_gets(3)
        expect(page.locator('.egc-review-alert')).to_have_count(0)
        self.failing = {'/api/message-sends'}
        page.evaluate('EGCReviewAlerts.refresh()')
        expect(page.locator('.egc-review-alert')).to_contain_text('Review queues could not be checked')

class ReviewQueuesInHubTests(HubShell, unittest.TestCase):
    """The registered screens inside the real employee.html shell (lazy loading, nav, Command Center alert)."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page(); self.assertEqual(self.errors, [])
    def route(self, route):
        parsed = urlparse(route.request.url)
        views = {'/api/stripe-reviews': stripe_view, '/api/message-sends': sends_view, '/api/portal-documents-admin': insurance_view}
        if parsed.hostname == '127.0.0.1' and parsed.path in views and route.request.method == 'GET':
            self.calls.append(('GET', parsed.path, parsed.query)); route.fulfill(status=200, content_type='application/json', body=json.dumps(views[parsed.path]())); return
        HubShell.route(self, route)

    def test_owner_opens_review_queues_from_the_nav_on_a_phone(self):
        page = self.open('reviews', width=375, height=812)
        expect(page.locator('.egc-reviews h1')).to_have_text('Review queues')
        expect(page.locator('#ops-title')).to_have_text('Review queues'); expect(page.locator('#ops-kicker')).to_have_text('RUN THE BUSINESS')
        expect(page.locator('.egc-reviews .rv-card').filter(has_text='$500.00')).to_be_visible()
        assets = page.evaluate("[...document.querySelectorAll('[data-egc-hub-asset]')].map(node=>node.getAttribute('src')||node.getAttribute('href')).sort()")
        self.assertIn('employee-reviews.js?v=20260930launchpolish', assets); self.assertIn('employee-reviews.css?v=20260930launchpolish', assets)
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], 375, scroll)
        self.assertEqual(self.small_targets('.egc-reviews'), [])
        page.locator('.egc-reviews .rv-card').filter(has_text='$500.00').get_by_role('button', name='Mark reconciled').click()
        self.assertEqual(self.small_inputs('dialog.rv-dialog'), [])
        page.locator('dialog.rv-dialog').get_by_role('button', name='Cancel').click()
        page.screenshot(path=str(RESULTS / 'hub-review-queues-375.png'), full_page=True)
        page.locator('.egc-reviews').get_by_role('button', name='Message templates').click()
        page.wait_for_function('new URLSearchParams(location.search).get("view")==="message_templates"')
        expect(page.locator('#ops-title')).to_have_text('Message templates'); expect(page.locator('#ops-kicker')).to_have_text('SYSTEM')
        expect(page.locator('.egc-templates')).to_be_visible()
        self.assertIn('message_templates', self.nav_views()); self.assertIn('reviews', self.nav_views())

    def test_the_command_center_shows_the_review_alert_and_opens_the_queue(self):
        page = self.open('today', width=375, height=812)
        alert = page.locator('#ops-review-alerts .egc-review-alert'); expect(alert).to_contain_text('4 items are waiting for a person')
        self.assertEqual(self.small_targets('#ops-review-alerts'), [])
        alert.get_by_role('button').filter(has_text='card payment').click()
        page.wait_for_function('new URLSearchParams(location.search).get("view")==="reviews"')
        expect(page.locator('.egc-reviews h1')).to_have_text('Review queues')

    def test_crew_never_see_the_review_queues(self):
        page = self.open('reviews', width=375, height=812, profile=CREW)
        self.assertNotIn('reviews', self.nav_views()); self.assertNotIn('message_templates', self.nav_views())
        expect(page.locator('.egc-reviews')).to_have_count(0)
        self.assertFalse(any(path in ('/api/stripe-reviews', '/api/message-sends') for _, path, _ in self.calls))

if __name__ == '__main__':
    unittest.main()
