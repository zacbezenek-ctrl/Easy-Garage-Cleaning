"""Portal documents (P4-09): the customer documents card and the Hub certificate control on a phone."""
import base64, copy, json, os, pathlib, re, subprocess, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 5, 30, tzinfo=timezone.utc)  # 11:30 PM Sept 21 in Denver, 2:30 PM Sept 22 in Tokyo
PDF = b'%PDF-1.4\n% Synthetic certificate of insurance fixture only\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
# The real versioned guarantee and terms copy, so the layout is checked with the words customers read.
DOCUMENTS = json.loads(subprocess.run(['node', '--input-type=module', '-e', "const m=await import('./functions/_lib/customer-portal-content.js');console.log(JSON.stringify(m.customerPortalDocuments()))"], cwd=ROOT, check=True, capture_output=True, text=True).stdout)

def portal_view(**estimate):
    return {'ok': True, 'customer': {'name': 'Synthetic Customer', 'firstName': 'Synthetic'},
            'appointment': {'date': '2026-09-28', 'time': '09:00', 'endTime': '12:30', 'arrivalWindow': '9:00 AM – 9:30 AM', 'address': '100 Synthetic Street, Fort Collins', 'service': 'Garage Turnaround', 'status': 'scheduled'},
            'estimate': {'number': 'EST-0001', 'amount': 800, 'scope': 'Synthetic garage cleanout scope.', 'status': 'sent', 'approvedBy': '', 'approvedAt': '', 'validUntil': '2026-10-15', 'revision': 1, 'depositRequired': 400, 'lineItems': [{'name': 'Synthetic Garage Turnaround', 'description': 'One bundled synthetic service.', 'quantity': 1, 'amount': 800}], 'terms': 'Synthetic estimate terms.', 'termsVersion': DOCUMENTS['termsVersion'], **estimate},
            'payment': {'total': 800, 'paid': 0, 'balance': 800, 'dueNow': 400, 'purpose': 'deposit', 'creditApplied': 0, 'receiptUrl': '', 'invoiceNumber': '', 'dueDate': ''},
            'photos': {'customerUploadCount': 0}, 'messaging': {'highLevelLinked': False, 'refreshSeconds': 20}, 'conversation': [],
            'review': {'eligible': False, 'url': ''}, 'experience': {'memory': {}, 'jobDayRules': {}, 'decisions': [], 'rebooking': [], 'giftWallet': {'available': 0, 'cards': []}, 'garageGuard': {}, 'collaborators': []},
            'documents': copy.deepcopy(DOCUMENTS), 'support': {'phone': '(970) 999-1818', 'phoneHref': 'tel:+19709991818', 'smsHref': 'sms:+19709991818'}}

def hub_status(state='expired', expires='2026-09-20', revision='rev-1'):
    return {'ok': True, 'authority': 'employee_hub', 'revision': revision, 'flag': '' if state == 'current' else 'insurance_certificate_' + state,
            'insurance': {'state': state, 'available': state in ('current', 'expiring_soon'), 'flag': '', 'expiresOn': expires, 'daysRemaining': None, 'uploadedAt': '2025-09-20T16:00:00.000Z', 'uploadedBy': 'zacb', 'filename': 'Synthetic COI 2025.pdf', 'size': len(PDF)},
            'history': [], 'driveConfigured': True, 'maxBytes': 5 * 1024 * 1024}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/hub-documents':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-portal-documents.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main><script src="/employee-portal-documents.js"></script><script>EGCPortalDocuments.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class PortalDocumentsBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo', accept_downloads=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.install(time=NOW)
        self.errors = []; self.posts = []; self.portal_gets = 0; self.status_available = True; self.pdf_status = 200
        self.hub = hub_status(); self.hub_status_code = 200; self.hub_post = None
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET': self.portal_gets += 1; send(portal_view()); return
            body = request.post_data_json; self.posts.append(body)
            send({'ok': False, 'code': 'CUSTOMER_PORTAL_TERMS_CHANGED', 'error': 'Our estimate terms were updated. Review the latest terms, then approve again.'}, 409); return
        if parsed.path == '/api/customer-portal-document':
            if parsed.query == 'kind=insurance&view=status': send({'ok': True, 'kind': 'insurance', 'available': self.status_available}); return
            if self.pdf_status != 200: send({'ok': False, 'code': 'CUSTOMER_PORTAL_DOCUMENT_UNAVAILABLE', 'error': 'Our current certificate of insurance is not available online right now.'}, self.pdf_status); return
            route.fulfill(status=200, body=PDF, headers={'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Easy-Garage-Cleaning-Certificate-of-Insurance.pdf"', 'Cache-Control': 'private, no-store'}); return
        if parsed.path == '/api/portal-documents-admin':
            if request.method == 'GET':
                if self.hub_status_code != 200: send({'ok': False, 'code': 'PORTAL_DOCUMENTS_FORBIDDEN', 'error': 'Only an owner or manager can manage customer portal documents.'}, self.hub_status_code); return
                send(self.hub); return
            body = request.post_data_json; self.posts.append(body)
            if self.hub_post: action = self.hub_post; self.hub_post = None; action(route, body); return
            saved = hub_status('current', body.get('expiresOn', ''), 'rev-2'); saved.pop('driveConfigured'); saved.pop('maxBytes'); saved['requestId'] = body['requestId']; send(saved); return
        route.continue_()
    def assert_mobile(self, scope):
        for width in (320, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        small = self.page.evaluate("""scope => [...document.querySelectorAll(scope + ' :is(a,button,summary,input,select)')].filter(node => node.offsetParent && node.type !== 'checkbox' && getComputedStyle(node).opacity !== '0').map(node => [node.id || node.textContent.trim().slice(0, 40), node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""", scope)
        self.assertEqual(small, [], 'every visible tap target is at least 44px tall')

    def open_portal(self):
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#documents-card')).to_be_visible()

    def test_customer_documents_card_shows_versioned_copy_and_downloads_the_certificate(self):
        self.open_portal(); card = self.page.locator('#documents-card')
        expect(card.locator('#documents-version')).to_have_text('Terms version ' + DOCUMENTS['termsVersion'])
        expect(self.page.locator('#estimate-terms-version')).to_contain_text('Terms version ' + DOCUMENTS['termsVersion'])
        expect(card.get_by_role('link', name='Download PDF')).to_be_visible(); expect(card.get_by_role('link', name='Text us for a copy')).to_be_hidden()
        card.locator('summary', has_text=DOCUMENTS['guarantee']['title']).click(); card.locator('summary', has_text='Service terms').click()
        for section in DOCUMENTS['guarantee']['sections'] + DOCUMENTS['terms']['sections']: expect(card.get_by_text(section['body'], exact=True)).to_be_visible()
        card.screenshot(path=str(ROOT / 'test-results' / 'portal-documents-375.png'))
        self.assert_mobile('#documents-card')
        with self.page.expect_download() as download: card.get_by_role('link', name='Download PDF').click()
        self.assertEqual(download.value.suggested_filename, 'Easy-Garage-Cleaning-Certificate-of-Insurance.pdf')
        self.assertEqual(pathlib.Path(download.value.path()).read_bytes(), PDF)
        expect(card.get_by_role('link', name='Download PDF')).to_have_text('Download PDF')

    def test_missing_certificate_offers_a_text_request_instead_of_a_broken_link(self):
        self.status_available = False; self.open_portal(); card = self.page.locator('#documents-card')
        expect(card.get_by_role('link', name='Text us for a copy')).to_be_visible(); expect(card.get_by_role('link', name='Download PDF')).to_be_hidden()
        expect(card.locator('#insurance-state')).to_contain_text('Not available online right now')
        self.assert_mobile('#documents-card')

    def test_a_certificate_that_lapses_after_page_load_falls_back_on_download(self):
        self.open_portal(); self.pdf_status = 404; card = self.page.locator('#documents-card')
        card.get_by_role('link', name='Download PDF').click()
        expect(self.page.locator('#toast')).to_contain_text('not available online'); expect(card.get_by_role('link', name='Text us for a copy')).to_be_visible()

    def test_approval_sends_the_displayed_terms_version_and_reloads_when_it_changed(self):
        self.open_portal(); before = self.portal_gets
        self.page.locator('#approval-name').fill('Synthetic Customer'); self.page.locator('#approval-confirm').check(); self.page.locator('#approve-button').click()
        expect(self.page.locator('#toast')).to_contain_text('Our estimate terms were updated')
        self.assertEqual(self.posts[-1], {'action': 'approve_estimate', 'signed_name': 'Synthetic Customer', 'confirmed': True, 'terms_version': DOCUMENTS['termsVersion']})
        expect(self.page.locator('#approve-button')).to_be_enabled()
        for _ in range(50):
            if self.portal_gets > before: break
            self.page.wait_for_timeout(100)
        self.assertGreater(self.portal_gets, before, 'the page reloads the latest terms')

    def open_hub(self):
        self.page.goto(self.url + '/hub-documents'); expect(self.page.get_by_role('heading', name='Portal documents')).to_be_visible()

    def unload_blocked(self):
        return self.page.evaluate("() => { const event = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(event); return event.defaultPrevented; }")

    def test_hub_flags_an_expired_certificate_and_uploads_a_renewal_on_a_phone(self):
        self.open_hub(); root = self.page.locator('.egc-portal-docs')
        expect(root.get_by_role('alert')).to_contain_text('Expired'); expect(root.locator('.pd-badge')).to_have_text('Expired')
        date = root.get_by_label('Policy expiration date')
        expect(date).to_have_attribute('min', '2026-09-22')  # the Denver calendar, not the Tokyo device date
        self.assertEqual(date.evaluate('node => getComputedStyle(node).fontSize'), '16px')
        root.get_by_label('Certificate PDF (5 MB max)').set_input_files({'name': 'Synthetic COI 2027.pdf', 'mimeType': 'application/pdf', 'buffer': PDF})
        expect(root.get_by_text('Selected: Synthetic COI 2027.pdf')).to_be_visible(); expect(root.locator('.pd-choose')).to_have_text('Choose a different PDF')
        date.fill('2027-09-01'); self.assert_mobile('.egc-portal-docs')
        self.page.screenshot(path=str(ROOT / 'test-results' / 'hub-portal-documents-375.png'), full_page=True)
        root.get_by_role('button', name='Upload certificate').click()
        expect(root.get_by_role('status')).to_contain_text('Certificate saved'); expect(root.locator('.pd-badge')).to_have_text('Current')
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'expectedRevision', 'expiresOn', 'filename')}, {'action': 'upload', 'expectedRevision': 'rev-1', 'expiresOn': '2027-09-01', 'filename': 'Synthetic COI 2027.pdf'})
        self.assertRegex(body['requestId'], UUID); self.assertEqual(base64.b64decode(body['dataUrl'].split(',', 1)[1]), PDF); self.assertTrue(body['dataUrl'].startswith('data:application/pdf;base64,'))

    def test_hub_retries_a_lost_upload_with_the_same_request(self):
        self.open_hub(); root = self.page.locator('.egc-portal-docs')
        self.hub_post = lambda route, body: route.abort('connectionfailed')
        root.get_by_label('Certificate PDF (5 MB max)').set_input_files({'name': 'Synthetic COI.pdf', 'mimeType': 'application/pdf', 'buffer': PDF})
        root.get_by_label('Policy expiration date').fill('2027-09-01'); root.get_by_role('button', name='Upload certificate').click()
        retry = root.get_by_role('button', name='Retry original upload'); expect(retry).to_be_visible()
        expect(root.get_by_role('button', name='Upload certificate')).to_be_disabled()
        self.assertTrue(self.unload_blocked(), 'closing the tab warns while the retry is on screen')
        self.page.evaluate('EGCPortalDocuments.unmount()')
        self.assertFalse(self.unload_blocked(), 'no unexplained warning once the Hub moved to another screen')
        self.page.evaluate("EGCPortalDocuments.mount(document.querySelector('#host'))"); retry = root.get_by_role('button', name='Retry original upload')
        expect(retry).to_be_visible(); self.assertTrue(self.unload_blocked())
        retry.click(); expect(root.get_by_role('status')).to_contain_text('Certificate saved')
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.posts[0], self.posts[1], 'the retry is byte-identical, including requestId')
        self.assertFalse(self.unload_blocked())

    def test_hub_flags_a_certificate_customers_cannot_get_while_drive_is_disconnected(self):
        self.hub = hub_status('unavailable', '2027-03-01'); self.hub.update(flag='insurance_certificate_drive_unconfigured', driveConfigured=False, pendingUpload={'startedAt': '2026-09-21T20:00:00.000Z', 'by': 'tylerg'})
        self.open_hub(); root = self.page.locator('.egc-portal-docs')
        expect(root.locator('.pd-badge')).to_have_text('Unavailable'); expect(root.locator('.pd-badge')).not_to_have_class(re.compile(r'\bgood\b'))
        expect(root.locator('.pd-status[role=alert]')).to_contain_text('Customers cannot download it because Google Drive is not connected')
        expect(root.get_by_text('An upload by tylerg started Sep 21, 2026, 2:00 PM has not finished.')).to_be_visible()  # Denver time on a Tokyo device
        expect(root.get_by_role('link', name='Open the saved PDF')).to_have_count(0)
        self.assert_mobile('.egc-portal-docs')

    def test_hub_refuses_non_pdf_files_before_uploading(self):
        self.open_hub(); root = self.page.locator('.egc-portal-docs')
        root.get_by_label('Certificate PDF (5 MB max)').set_input_files({'name': 'Synthetic.png', 'mimeType': 'image/png', 'buffer': b'\x89PNG synthetic'})
        expect(root.get_by_role('alert').filter(has_text='Choose the certificate as a PDF file.')).to_be_visible()
        expect(root.get_by_role('button', name='Upload certificate')).to_be_disabled(); self.assertEqual(self.posts, [])

    def test_hub_sales_users_see_a_quiet_note_instead_of_an_error(self):
        self.hub_status_code = 403; self.open_hub(); root = self.page.locator('.egc-portal-docs')
        expect(root.get_by_text('Only the owner or a manager can manage')).to_be_visible(); expect(root.get_by_role('alert')).to_have_count(0)
        expect(root.get_by_role('button', name='Upload certificate')).to_have_count(0)

if __name__ == '__main__':
    unittest.main()
