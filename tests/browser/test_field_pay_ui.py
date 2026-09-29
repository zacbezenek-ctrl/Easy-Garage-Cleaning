"""FIELD-PAY on the canonical crew job page: exact card, private receipt review, and safe retries."""
import copy
import datetime
import json
import os
import pathlib
import re
import struct
import threading
import unittest
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright
from test_crew_job_drafts_ui import field_job

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
FINANCE_BOARD = next(line for line in (ROOT / 'employee-suite.js').read_text(encoding='utf-8').splitlines() if line.startswith('function financeBoard(){'))


def png():
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + b'\xf0\xe0\xd0' * 24 for _ in range(32))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 24, 32, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class FieldPayBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        engine = os.environ.get('EGC_TEST_BROWSER', 'chromium')
        if engine == 'webkit':
            cls.browser = cls.pw.webkit.launch(headless=True)
        else:
            options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
            cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = None
        self.manager = False
        self.enabled = True
        self.balance = 14550
        self.row = None
        self.card_claim = None
        self.payment_sync = None
        self.sync_pending = []
        self.posts = []
        self.checkout_posts = []
        self.tip_config = True
        self.fail_submit_once = False
        self.fail_checkout_once = False
        self.fail_review_once = False
        self.fail_sync_once = False
        self.stale_review = False
        self.errors = []
        self.receipt_reads = 0

    def tearDown(self):
        if self.context:
            self.context.close()
        self.assertEqual(self.errors, [])

    def page_open(self, *, manager=False, width=390, url=None):
        self.manager = manager
        self.context = self.browser.new_context(viewport={'width': width, 'height': 844}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True, service_workers='block')
        page = self.context.new_page()
        page.set_default_timeout(8000)
        page.clock.install(time=datetime.datetime(2026, 9, 22, 16, tzinfo=datetime.timezone.utc))
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.route('**/*', self.route)
        page.goto(url or self.url + '/crew/job.html?jobId=job-1')
        expect(page.get_by_role('heading', name='Settle the job with confidence')).to_be_visible()
        expect(page.get_by_text('$145.50', exact=True)).to_be_visible()
        return page

    def detail(self):
        job = field_job(self.manager)
        return {'ok': True, 'job': job, 'historyCursor': None, 'photosAvailable': True, 'features': {'jobCosts': False, 'fieldPay': self.enabled}, 'timezone': 'America/Denver'}

    def view(self):
        submit = self.enabled and not self.manager and self.balance > 0 and self.row is None and self.card_claim is None
        row = copy.deepcopy(self.row) if self.row else None
        if row and not self.manager:
            row.pop('reference', None)
            row.pop('receiptUrl', None)
        return {'ok': True, 'jobId': 'job-1', 'enabled': self.enabled, 'currency': 'usd', 'balanceCents': self.balance,
                'canCollectCard': submit and self.balance >= 50, 'capabilities': {'submit': submit, 'review': self.manager}, 'submissions': [row] if row else [], 'cardCheckout': copy.deepcopy(self.card_claim), 'paymentSync': copy.deepcopy(self.payment_sync) if self.manager else None, 'syncPending': copy.deepcopy(self.sync_pending) if self.manager else [], 'syncOverflow': False}

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        if parsed.hostname == 'checkout.stripe.com':
            route.fulfill(status=200, content_type='text/html', body='<h1>Synthetic Stripe checkout</h1>')
            return
        if parsed.hostname != '127.0.0.1':
            route.abort()
            return
        path, query = parsed.path, parse_qs(parsed.query)
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/hub-auth':
            send({'ok': True, 'user': 'ZacB', 'displayName': 'Owner', 'businessAccess': True} if self.manager else {'ok': True, 'user': 'Crew.One', 'displayName': 'Crew One', 'businessAccess': False})
        elif path == '/api/employee-hub':
            if query.get('view') == ['job-labor']:
                send({'ok': True, 'jobId': 'job-1', 'employees': [], 'asOf': DAY + 'T16:00:00.000Z', 'legacyAssociationOnlyCount': 0, 'needsReviewCount': 0})
            else:
                send({'ok': True, 'user': 'ZacB' if self.manager else 'Crew.One', 'entry': None})
        elif path in ('/api/field-expenses', '/api/field-photo-sharing'):
            send({'ok': False, 'error': 'Not enabled'}, 404)
        elif path == '/api/field-jobs':
            send(self.detail())
        elif path == '/api/field-payments':
            if request.method == 'GET':
                if 'receipt_id' in query:
                    self.receipt_reads += 1
                    route.fulfill(status=200, content_type='image/jpeg', body=b'fake-image')
                else:
                    send(self.view())
            else:
                body = request.post_data_json
                self.posts.append(copy.deepcopy(body))
                if body['action'] == 'submit' and self.fail_submit_once:
                    self.fail_submit_once = False
                    route.abort('failed')
                    return
                if body['action'] in ('accept', 'reject') and self.fail_review_once:
                    self.fail_review_once = False
                    route.abort('failed')
                    return
                if body['action'] == 'sync_payment' and self.fail_sync_once:
                    self.fail_sync_once = False
                    route.abort('failed')
                    return
                if body['action'] in ('accept', 'reject') and self.stale_review:
                    send({'ok': False, 'code': 'FIELD_PAY_REVISION_CONFLICT', 'error': 'The receipt changed. Refresh before reviewing it.'}, 409)
                    return
                if body['action'] == 'submit':
                    self.row = {'id': body['requestId'], 'method': body['method'], 'amountCents': body['amountCents'], 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': body['reference'], 'receiptUrl': f"/api/field-payments?job_id=job-1&receipt_id={body['requestId']}"}
                elif body['action'] == 'cancel_card':
                    self.card_claim = None
                elif body['action'] in ('accept', 'reject'):
                    self.row['status'] = 'accepted' if body['action'] == 'accept' else 'rejected'
                    self.row['revision'] = 'rev-receipt-2'
                    if body['action'] == 'accept':
                        self.balance -= self.row['amountCents']
                elif body['action'] == 'sync_payment':
                    self.sync_pending = [item for item in self.sync_pending if (item['kind'], item['sourceId']) != (body['kind'], body['sourceId'])]
                    if body['kind'] == 'receipt':
                        if self.row and self.row['id'] == body['sourceId']:
                            self.row['crmSyncStatus'] = 'synced'
                    else:
                        if self.payment_sync and self.payment_sync['sourceId'] == body['sourceId']:
                            self.payment_sync['status'] = 'synced'
                send({**self.view(), **({'crmSynced': True} if body['action'] == 'sync_payment' else {})})
        elif path == '/api/job-payment':
            if request.method == 'GET' and query.get('config') == ['tips']:
                send({'ok': True, 'tips': {'enabled': self.tip_config, 'presets': [10, 15, 20]}})
            elif request.method == 'GET' and query.get('session_id'):
                self.balance = 0
                send({'ok': True, 'jobId': 'job-1', 'paid': True, 'sessionId': query['session_id'][0], 'payment': {'verified': True}, 'tipPaid': 14.55})
            else:
                body = request.post_data_json
                self.checkout_posts.append(copy.deepcopy(body))
                if self.fail_checkout_once:
                    self.fail_checkout_once = False
                    route.abort('failed')
                    return
                send({'ok': True, 'sessionId': 'cs_test_syntheticfieldpay', 'url': 'https://checkout.stripe.com/c/pay/syntheticfieldpay'})
        else:
            route.continue_()

    def test_exact_card_balance_and_tip_are_separate(self):
        page = self.page_open()
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_be_enabled()
        page.get_by_role('button', name='10%').click()
        page.get_by_role('button', name='Charge exact $145.50 balance').click()
        expect(page.get_by_role('heading', name='Synthetic Stripe checkout')).to_be_visible()
        self.assertEqual(self.checkout_posts[0]['mode'], 'field_exact_balance')
        self.assertEqual(self.checkout_posts[0]['amount_cents'], 14550)
        self.assertEqual(self.checkout_posts[0]['tip_cents'], 1455)
        page.goto(self.url + '/crew/job.html?jobId=job-1&payment=stripe-success&session_id=cs_test_syntheticfieldpay')
        expect(page.get_by_text('Card payment verified on this job')).to_be_visible()
        expect(page.get_by_text('$0.00', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_have_count(0)

    def test_partial_cash_receipt_is_pending_and_private(self):
        page = self.page_open()
        page.get_by_role('button', name='Check', exact=True).click()
        page.get_by_label('Amount received').fill('45.50')
        page.get_by_label('Check number or receipt reference').fill('Check 418')
        page.get_by_label('Receipt photo', exact=True).set_input_files({'name': 'receipt.png', 'mimeType': 'image/png', 'buffer': png()})
        expect(page.get_by_text('Receipt photo ready for private manager review')).to_be_visible()
        page.get_by_role('button', name='Submit for manager review').click()
        expect(page.get_by_text('Receipt sent for manager review.')).to_be_visible()
        expect(page.get_by_text('$145.50', exact=True)).to_be_visible()
        self.assertEqual(self.posts[0]['amountCents'], 4550)
        self.assertEqual(self.posts[0]['expectedBalanceCents'], 14550)
        self.assertLessEqual(len(self.posts[0]['receiptDataUrl']), 380000)
        self.assertTrue(UUID.match(self.posts[0]['requestId']))
        self.assertEqual(page.get_by_role('link', name='View private receipt').count(), 0)
        expect(page.get_by_text('Awaiting manager verification')).to_be_visible()
        expect(page.get_by_text('A submitted receipt never marks the job paid.')).to_be_visible()

    def test_manager_approves_saved_receipt_after_private_review(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'cash', 'amountCents': 14550, 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Receipt 14', 'receiptUrl': '/api/field-payments?job_id=job-1&receipt_id=11111111-1111-4111-8111-111111111111'}
        page = self.page_open(manager=True)
        expect(page.get_by_role('link', name='View private receipt')).to_have_attribute('href', self.row['receiptUrl'])
        self.assertEqual(page.get_by_role('button', name='Submit for manager review').count(), 0)
        page.get_by_role('button', name='Approve receipt').click()
        expect(page.get_by_text('Receipt approved.')).to_be_visible()
        self.assertEqual(self.posts[0]['submissionId'], self.row['id'])
        self.assertEqual(self.posts[0]['expectedRevision'], 'rev-receipt-1')
        expect(page.get_by_text('$0.00', exact=True)).to_be_visible()

    def test_unknown_cash_outcome_retries_the_same_request(self):
        self.fail_submit_once = True
        page = self.page_open()
        page.get_by_label('Amount received').fill('145.50')
        page.get_by_label('Receipt reference').fill('Receipt 21')
        page.get_by_label('Receipt photo', exact=True).set_input_files({'name': 'receipt.png', 'mimeType': 'image/png', 'buffer': png()})
        page.get_by_role('button', name='Submit for manager review').click()
        expect(page.get_by_role('button', name='Retry same action')).to_be_visible()
        page.reload()
        expect(page.get_by_role('button', name='Retry same action')).to_be_visible()
        page.get_by_role('button', name='Retry same action').click()
        expect(page.get_by_text('Receipt sent for manager review.')).to_be_visible()
        self.assertEqual([item['requestId'] for item in self.posts], [self.posts[0]['requestId']] * 2)

    def test_unknown_card_checkout_retries_same_request_and_amount(self):
        self.fail_checkout_once = True
        page = self.page_open()
        page.get_by_role('button', name='Charge exact $145.50 balance').click()
        expect(page.get_by_role('button', name='Retry same Stripe request')).to_be_visible()
        page.reload()
        page.get_by_role('button', name='Retry same Stripe request').click()
        expect(page.get_by_role('heading', name='Synthetic Stripe checkout')).to_be_visible()
        self.assertEqual(len(self.checkout_posts), 2)
        self.assertEqual(self.checkout_posts[0]['request_id'], self.checkout_posts[1]['request_id'])
        self.assertEqual([item['amount_cents'] for item in self.checkout_posts], [14550, 14550])

    def test_unknown_manager_approval_retries_same_request(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'cash', 'amountCents': 14550, 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Receipt 14', 'receiptUrl': '/api/field-payments?job_id=job-1&receipt_id=11111111-1111-4111-8111-111111111111'}
        self.fail_review_once = True
        page = self.page_open(manager=True)
        page.get_by_role('button', name='Approve receipt').click()
        expect(page.get_by_role('button', name='Retry same action')).to_be_visible()
        page.reload()
        page.get_by_role('button', name='Retry same action').click()
        expect(page.get_by_text('Receipt approved.')).to_be_visible()
        self.assertEqual([item['requestId'] for item in self.posts], [self.posts[0]['requestId']] * 2)
        self.assertEqual(self.balance, 0)

    def test_stale_manager_review_stays_unverified_and_requires_refresh(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'cash', 'amountCents': 14550, 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Receipt 14', 'receiptUrl': '/api/field-payments?job_id=job-1&receipt_id=11111111-1111-4111-8111-111111111111'}
        self.stale_review = True
        page = self.page_open(manager=True)
        page.get_by_role('button', name='Approve receipt').click()
        expect(page.get_by_text('The receipt changed. Refresh before reviewing it.')).to_be_visible()
        expect(page.get_by_text('$145.50', exact=True)).to_be_visible()
        expect(page.get_by_text('Awaiting manager verification')).to_be_visible()
        self.assertEqual(self.balance, 14550)

    def test_flag_off_existing_pending_receipt_can_still_be_reviewed(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'check', 'amountCents': 14550, 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Check 14', 'receiptUrl': '/api/field-payments?job_id=job-1&receipt_id=11111111-1111-4111-8111-111111111111'}
        self.enabled = False
        page = self.page_open(manager=True)
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_have_count(0)
        expect(page.get_by_role('button', name='Submit for manager review')).to_have_count(0)
        page.get_by_role('button', name='Approve receipt').click()
        expect(page.get_by_text('Receipt approved.')).to_be_visible()

    def test_unsafe_receipt_link_is_not_offered(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'cash', 'amountCents': 14550, 'status': 'pending', 'revision': 'rev-receipt-1', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Receipt 14', 'receiptUrl': 'https://not-the-hub.example/receipt/11111111'}
        page = self.page_open(manager=True)
        expect(page.get_by_role('link', name='View private receipt')).to_have_count(0)
        self.assertEqual(self.receipt_reads, 0)

    def test_server_card_claim_blocks_cash_until_safely_cancelled(self):
        self.card_claim = {'status': 'creating', 'sessionId': None, 'revision': 'card-rev-1', 'amountCents': 14550}
        page = self.page_open()
        expect(page.get_by_text('An exact-balance card checkout is open')).to_be_visible()
        expect(page.get_by_role('button', name='Submit for manager review')).to_have_count(0)
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_have_count(0)
        page.on('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='Cancel open checkout').click()
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_be_visible()
        self.assertEqual(self.posts[0]['action'], 'cancel_card')
        self.assertEqual(self.posts[0]['expectedRevision'], 'card-rev-1')

    def test_manager_retries_receipt_crm_handoff_without_recollecting(self):
        self.row = {'id': '11111111-1111-4111-8111-111111111111', 'method': 'cash', 'amountCents': 6450, 'status': 'accepted', 'revision': 'rev-receipt-2', 'submittedAt': DAY + 'T16:03:00Z', 'reference': 'Receipt 14', 'crmSyncStatus': 'error', 'crmSyncError': 'HighLevel temporarily unavailable'}
        self.sync_pending = [{'kind': 'receipt', 'sourceId': self.row['id'], 'amountCents': 6450, 'status': 'error'}]
        self.fail_sync_once = True
        page = self.page_open(manager=True)
        expect(page.get_by_role('heading', name='HighLevel payment handoffs')).to_be_visible()
        expect(page.get_by_role('button', name='Retry HighLevel handoff')).to_have_count(1)
        page.get_by_role('button', name='Retry HighLevel handoff').click()
        expect(page.get_by_role('button', name='Retry same action')).to_be_visible()
        page.reload()
        page.get_by_role('button', name='Retry same action').click()
        expect(page.get_by_text('HighLevel payment note synced')).to_be_visible()
        self.assertEqual([item['action'] for item in self.posts], ['sync_payment', 'sync_payment'])
        self.assertEqual(self.posts[0]['requestId'], self.posts[1]['requestId'])
        self.assertEqual(self.posts[0]['sourceId'], self.row['id'])
        self.assertEqual(self.balance, 14550)

    def test_manager_retries_card_crm_handoff(self):
        self.payment_sync = {'status': 'pending', 'sourceId': 'cs_test_syntheticfieldpay'}
        self.sync_pending = [{'kind': 'card', 'sourceId': 'cs_test_syntheticfieldpay', 'amountCents': 14550, 'status': 'pending'}]
        page = self.page_open(manager=True)
        expect(page.get_by_role('heading', name='HighLevel payment handoffs')).to_be_visible()
        page.get_by_role('button', name='Retry HighLevel handoff').click()
        expect(page.get_by_text('HighLevel card payment note synced')).to_be_visible()
        self.assertEqual(self.posts[0]['action'], 'sync_payment')
        self.assertEqual(self.posts[0]['kind'], 'card')
        self.assertEqual(self.posts[0]['sourceId'], 'cs_test_syntheticfieldpay')

    def test_manager_can_recover_multiple_historical_crm_handoffs(self):
        self.sync_pending = [
            {'kind': 'card', 'sourceId': 'cs_test_oldcard', 'amountCents': 4000, 'status': 'error'},
            {'kind': 'receipt', 'sourceId': '22222222-2222-4222-8222-222222222222', 'amountCents': 2500, 'status': 'pending'},
        ]
        page = self.page_open(manager=True)
        expect(page.get_by_role('button', name='Retry HighLevel handoff')).to_have_count(2)
        page.get_by_role('button', name='Retry HighLevel handoff').first.click()
        expect(page.get_by_role('button', name='Retry HighLevel handoff')).to_have_count(1)
        self.assertEqual(self.posts[0]['sourceId'], 'cs_test_oldcard')
        self.assertEqual(self.posts[0]['kind'], 'card')

    def test_phone_controls_fit_and_off_switch_hides_new_collection(self):
        page = self.page_open(width=375)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)
        for label in ['Charge exact $145.50 balance', 'Submit for manager review']:
            box = page.get_by_role('button', name=label).bounding_box()
            self.assertGreaterEqual(box['height'], 44)
        self.context.close(); self.context = None
        self.enabled = False
        page = self.page_open(manager=True, width=375)
        expect(page.get_by_role('button', name='Submit for manager review')).to_have_count(0)
        expect(page.get_by_role('button', name='Charge exact $145.50 balance')).to_have_count(0)

    def test_finance_board_marks_server_owned_receipt_and_crm_work(self):
        self.context = self.browser.new_context()
        page = self.context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        job = {'id': 'job-1', 'type': 'job', 'customer': 'Synthetic customer', 'date': DAY, 'fieldPaymentPendingId': '11111111-1111-4111-8111-111111111111', 'fieldPaymentSyncPendingIds': ['card:cs_test_prior']}
        page.evaluate('''(job) => {
          const jobs=()=>[job], jobStage=()=> 'scheduled', financeState=()=>({total:145.5,balance:145.5,deposit:0,estimate:'draft',invoice:'open',paid:0}),
            jobEconomics=()=>({known:false,laborUnknown:false}), money=value=>'$'+Number(value).toFixed(2), dateLabel=()=> 'Sep 22',
            badge=(label)=>`<span class="badge">${label}</span>`, esc=value=>String(value), portalInvitationControl=()=>'',salesExitControl=()=>'',
            empty=()=>'';
        ''' + FINANCE_BOARD + '''
          document.body.innerHTML=financeBoard();
        }''', job)
        article = page.locator('[data-finance-job="job-1"]')
        expect(article.get_by_text('Receipt awaiting review')).to_be_visible()
        expect(article.get_by_text('HighLevel handoff pending')).to_be_visible()
        expect(article.get_by_role('link', name='Review pending receipt')).to_have_attribute('href', '/crew/job.html?jobId=job-1#field-payment-card')


if __name__ == '__main__':
    unittest.main()
