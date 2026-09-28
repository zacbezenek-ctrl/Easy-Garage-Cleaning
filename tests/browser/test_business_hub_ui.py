"""Business Client Hub mobile compliance, extension seams and team invitations against a routed fake API; no provider or customer writes."""
import copy, json, os, pathlib, re, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = '2026-09-22T18:00:00Z'
ACCOUNT, OTHER = 'a1' * 16, 'a2' * 16
P1, P2 = 'b1' * 16, 'b2' * 16
R1, R2 = 'c1' * 16, 'c2' * 16
M1, M2, M3, M4 = 'd1' * 16, 'd2' * 16, 'd3' * 16, 'd4' * 16
HEX32 = re.compile(r'^[a-f0-9]{32}$')
LONG_TOKEN = 'Synthetic-unbroken-reference-' + 'X' * 90
COMPANY = 'Synthetic Property Management Group of Northern Colorado Holdings LLC'
CLIENT_TABS = ['Overview', 'Properties', 'Service requests', 'Projects & quotes', 'Invoices & billing', 'Team access', 'Messages']
PERMISSIONS = {
    'admin': {'view': True, 'request': True, 'decide': True, 'pay': True, 'team': True},
    'viewer': {'view': True},
    'limited': {'view': True, 'request': True, 'decide': True},
    'staff': {'view': True, 'request': True, 'team': True, 'staff': True, 'link': True},
}
# Team viewers get invitation status per member (business-hub-invites.js renders it); the admin's own row is marked self.
INVITES = {
    M1: {'inviteStatus': 'active', 'deliveryStatus': 'manual', 'lastSentAt': NOW, 'expiresAt': ''},
    M2: {'inviteStatus': 'active', 'deliveryStatus': 'submitted', 'lastSentAt': NOW, 'expiresAt': ''},
    M3: {'inviteStatus': 'pending', 'deliveryStatus': 'uncertain', 'lastSentAt': NOW, 'expiresAt': '2026-09-24T18:00:00Z'},
    M4: {'inviteStatus': 'revoked', 'deliveryStatus': 'manual', 'lastSentAt': '', 'expiresAt': ''},
}
EXTENSION = r"""(()=>{'use strict';const hub=window.EGCBusinessHub;
hub.registerTab('synthetic','Synthetic ledger',data=>`<section class="card"><h2>Synthetic ledger</h2>${hub.empty('Ledger for '+data.account.company)}<button data-ext-ping="1">Run synthetic action</button></section>`,data=>!data.viewer.permissions.staff);
hub.registerTab('broken','Broken tab',()=>{throw new Error('synthetic render failure');});
hub.registerRequestActions(r=>`<button data-ext-progress="${hub.esc(r.id)}">Synthetic progress</button>`);
hub.registerMemberColumns(m=>hub.esc(m.status==='active'?'All properties':'Pending'),'Property scope');
let duplicate='accepted';try{hub.registerTab('overview','Hijack',()=>'hijacked');}catch{duplicate='rejected';}
window.__extension={duplicate};
document.addEventListener('click',async event=>{if(!event.target.closest('[data-ext-ping]'))return;try{const result=await hub.api({action:'synthetic_ping',requestId:hub.newId()});hub.toast('Synthetic action '+result.state);}catch(error){hub.toast(error.message,true);}});
})();"""

def snapshot(role):
    staff = role == 'staff'
    members = [
        {'name': 'Synthetic Administrator With A Long Name', 'role': 'admin', 'status': 'active', 'id': M1, 'email': 'synthetic.administrator.with.long.address@example.invalid'},
        {'name': 'Synthetic Viewer', 'role': 'viewer', 'status': 'active', 'id': M2, 'email': 'viewer@example.invalid', 'propertyIds': [P1]},
        {'name': 'Synthetic Billing', 'role': 'billing', 'status': 'invited', 'id': M3, 'email': 'billing@example.invalid'},
        {'name': 'Synthetic Former', 'role': 'manager', 'status': 'revoked', 'id': M4, 'email': 'former@example.invalid'},
    ]
    if not PERMISSIONS[role].get('team'):
        members = [{k: v for k, v in m.items() if k not in ('id', 'email', 'propertyIds')} for m in members]
    else:
        members = [{**m, **INVITES[m['id']], **({'self': True} if role == 'admin' and m['id'] == M1 else {})} for m in members]
    data = {
        'account': {'id': ACCOUNT, 'company': COMPANY, 'billingEmail': 'accounts.payable.department@synthetic-property-management.example.invalid', 'reference': 'PO-2026-SYN', 'status': 'active'},
        'viewer': {'name': 'EGC account team' if staff else 'Synthetic Administrator', 'role': 'staff' if staff else 'manager' if role == 'limited' else role, 'permissions': PERMISSIONS[role]},
        'properties': [
            {'id': P1, 'name': 'Synthetic Tower North Parking Structure', 'address': '1200 Synthetic Boulevard, Suite 4400, Fort Collins, CO 80525', 'contact': 'Synthetic Super 970-555-0100', 'access': 'Front desk. ' + LONG_TOKEN, 'updatedAt': NOW},
            {'id': P2, 'name': 'Synthetic Storage Annex', 'address': '44 Example Way, Loveland, CO', 'contact': '', 'access': '', 'updatedAt': NOW},
        ],
        'requests': [
            {'id': R1, 'propertyId': P1, 'service': 'Garage cleanout and reset', 'scope': 'Remove approved contents. ' + LONG_TOKEN, 'preferredDate': '2026-10-01', 'purchaseOrder': 'PO-SYN-88', 'onsiteContact': 'Synthetic Super 970-555-0100', 'payer': COMPANY, 'status': 'submitted', 'createdAt': NOW},
            {'id': R2, 'propertyId': P2, 'service': 'Recurring maintenance', 'scope': 'Quarterly reset.', 'preferredDate': '', 'purchaseOrder': '', 'onsiteContact': '', 'payer': 'Synthetic Payer', 'status': 'reviewing', 'createdAt': NOW},
        ],
        'messages': [
            {'id': 'e1' * 16, 'requestId': R1, 'body': 'Please confirm the date. ' + LONG_TOKEN, 'author': 'Synthetic Administrator', 'fromStaff': False, 'at': NOW},
            {'id': 'e2' * 16, 'requestId': '', 'body': 'EGC will confirm scope after the walkthrough.', 'author': 'EGC account team', 'fromStaff': True, 'at': NOW},
        ],
        'members': members,
        'projects': [
            {'jobId': 'synthetic_job_1', 'propertyId': P1, 'service': 'Garage cleanout and reset', 'status': 'scheduled', 'date': '2026-10-02', 'time': '08:00', 'quoteStatus': 'approved', 'quoteNumber': 'Q-SYN-1', 'total': 12845.67, 'invoiceNumber': 'INV-SYN-1001-' + 'LONG' * 8, 'invoiceStatus': 'sent', 'dueDate': '2026-10-15', 'balance': 12345.67, 'paid': 500, 'paymentNeedsReview': False, 'receiptUrl': 'https://pay.stripe.com/receipts/synthetic'},
            {'jobId': 'synthetic_job_2', 'propertyId': P2, 'service': 'Property service', 'status': 'not_scheduled', 'date': '', 'time': '', 'quoteStatus': 'not_issued', 'quoteNumber': '', 'total': None, 'invoiceNumber': '', 'invoiceStatus': 'not_issued', 'dueDate': '', 'balance': None, 'paid': None, 'paymentNeedsReview': False, 'receiptUrl': ''},
            {'jobId': 'synthetic_job_3', 'propertyId': P2, 'unavailable': True},
            {'jobId': 'synthetic_job_4', 'propertyId': P1, 'service': 'Cleaning and organization', 'status': 'completed', 'date': '2026-09-01', 'time': '09:00', 'quoteStatus': 'accepted', 'quoteNumber': 'Q-SYN-4', 'total': 900, 'invoiceNumber': 'INV-SYN-1004', 'invoiceStatus': 'sent', 'dueDate': '2026-09-30', 'balance': None, 'paid': None, 'paymentNeedsReview': True, 'receiptUrl': ''},
        ],
        'manager': {'name': 'Zoe Zoll', 'email': 'zoe.zoll@easygaragecleaning.com', 'phone': '+19709991403'},
        'coverage': {'linked': 4, 'unavailable': 1, 'paymentReview': 1}, 'updatedAt': NOW,
        **({'inviteDelivery': {'email': True}} if staff else {}),
        'rates': RATES,
    }
    if role == 'limited':
        # The server's scoped snapshot: property P1 only, its request and projects, and general messages.
        data['viewer']['propertyIds'] = [P1]; data['account']['billingEmail'] = ''
        data['properties'] = [p for p in data['properties'] if p['id'] == P1]; data['requests'] = [r for r in data['requests'] if r['propertyId'] == P1]
        data['projects'] = [p for p in data['projects'] if p['propertyId'] == P1]; data['messages'] = [m for m in data['messages'] if m['requestId'] in ('', R1)]
        data['coverage'] = {'linked': 2, 'unavailable': 0, 'paymentReview': 1}
    return data

# PRICE-SCRUB: the rate card is the signed-in account's, from /api/business-hub; business-hub.js ships none.
RATES = {'cards': [{'value': '12%', 'title': 'Synthetic partner savings', 'detail': 'Synthetic eligible services <b>not bold</b>.'}, {'value': '18%', 'title': 'Synthetic coordinated properties', 'detail': 'Synthetic multi-property terms.'}],
         'terms': ['Synthetic terms: discounts follow the accepted quote.']}

ACCOUNTS = {'staff': True, 'manager': True, 'next': 'synthetic-cursor', 'limited': False, 'inviteDelivery': {'email': True}, 'accounts': [
    {'id': ACCOUNT, 'company': COMPANY, 'status': 'active', 'properties': 2, 'requests': 1, 'updatedAt': NOW},
    {'id': OTHER, 'company': 'Synthetic Second Client', 'status': 'active', 'properties': 0, 'requests': 0, 'updatedAt': NOW},
]}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def send_text(self, body, content_type):
        data = body.encode(); self.send_response(200); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        path = urlparse(self.path).path
        html = (ROOT / 'business-hub.html').read_text()
        if path == '/business-hub': self.send_text(html, 'text/html; charset=utf-8')
        elif path == '/business-hub-extension-test':
            core = re.search(r'<script src="/business-hub\.js\?v=[^"]+" defer></script>', html).group(0)
            self.send_text(html.replace(core, core + '<script src="/__test__/business-hub-synthetic.js" defer></script>'), 'text/html; charset=utf-8')
        elif path == '/__test__/business-hub-synthetic.js': self.send_text(EXTENSION, 'text/javascript')
        else: super().do_GET()

AUDIT = """() => {
  const visible = el => { if (el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || el.name || '').trim().slice(0, 40)}"`;
  const all = [...document.querySelectorAll('body *')];
  // The painted right edge: clipped by any ancestor with overflow hidden/clip (e.g. the visually hidden table header).
  const right = el => { let edge = el.getBoundingClientRect().right; for (let a = el.parentElement; a; a = a.parentElement) if (['hidden', 'clip'].includes(getComputedStyle(a).overflowX)) edge = Math.min(edge, a.getBoundingClientRect().right); return edge; };
  return {
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll('button, a[href], summary')].filter(visible).filter(el => el.getBoundingClientRect().height < 44).map(el => name(el) + ' ' + el.getBoundingClientRect().height.toFixed(1)),
    fonts: [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(visible).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(name),
    scrollers: all.filter(el => !el.closest('#tabs') && el.tagName !== 'TEXTAREA' && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1).map(name),
    outside: all.filter(visible).filter(el => !el.closest('#tabs') && right(el) > innerWidth + 1).map(name),
    counted: document.querySelectorAll('button, a[href], summary, input, select, textarea').length,
  };
}"""
DESKTOP = """() => {
  const box = s => document.querySelector(s).getBoundingClientRect();
  const tabs = [...document.querySelectorAll('#tabs button')].map(b => b.getBoundingClientRect());
  const metrics = [...document.querySelectorAll('.metric')].map(m => Math.round(m.getBoundingClientRect().top));
  const cards = [...document.querySelectorAll('.grid > .card')].map(c => c.getBoundingClientRect());
  const table = document.querySelector('table'), td = document.querySelector('td[data-label]'), button = document.querySelector('td button');
  const input = document.querySelector('#content input:not([type=hidden]), #content select, #content textarea');
  return {
    width: innerWidth, scroll: document.documentElement.scrollWidth, rail: [box('.rail').x, box('.rail').width], workspace: box('.workspace').x,
    tabsStacked: tabs.length > 1 && tabs.every((t, i) => i === 0 || (t.top >= tabs[i - 1].bottom - 0.5 && Math.abs(t.left - tabs[0].left) < 0.5)),
    metricsRow: metrics.length ? new Set(metrics).size : null, cardsSideBySide: cards.length > 1 ? cards[1].left > cards[0].right : null,
    table: table ? getComputedStyle(table).display : null, thead: table ? document.querySelector('thead').getBoundingClientRect().height : null,
    label: td ? getComputedStyle(td, '::before').content : null, tdButton: button ? button.getBoundingClientRect().height : null,
    input: input ? getComputedStyle(input).fontSize : null,
  };
}"""

class BusinessHubBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.errors = []; self.calls = []; self.gets = []; self.role = 'admin'; self.signed_out = False; self.abort_next = 0; self.replies = []; self.contexts = []; self.dialogs = []; self.dismiss = False; self.hub_auth = []
    def tearDown(self):
        for context in self.contexts: context.close()
        self.assertEqual(self.errors, [], f'Browser errors: {self.errors}')
    def open(self, path, width=375, height=812):
        phone = width <= 700
        context = self.browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Tokyo', is_mobile=phone, has_touch=phone, device_scale_factor=2 if phone else 1)
        self.contexts.append(context)
        page = context.new_page(); page.set_default_timeout(7000); page.clock.install(time=NOW)
        page.on('pageerror', lambda e: self.errors.append(str(e))); page.on('dialog', self.on_dialog)
        page.route('**/*', self.route); page.goto(self.url + path)
        return page
    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.dismiss() if self.dismiss else dialog.accept()
    def route(self, route):
        req = route.request; parsed = urlparse(req.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path == '/api/hub-auth': self.hub_auth.append(req.method); route.fulfill(status=200, content_type='application/json', body='{"ok":true}'); return
        if parsed.path != '/api/business-hub': route.continue_(); return
        def send(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        query = parse_qs(parsed.query)
        if req.method == 'GET':
            self.gets.append(query)
            if self.signed_out: send({'error': 'Open your private business sign-in link or contact Zoe.'}, 401); return
            if query.get('staff') == ['1']: send(snapshot('staff') if query.get('account') else ACCOUNTS); return
            send(snapshot(self.role)); return
        body = req.post_data_json; self.calls.append({'body': copy.deepcopy(body), 'headers': req.headers})
        if self.abort_next: self.abort_next -= 1; route.abort('connectionfailed'); return
        if self.replies: status, data = self.replies.pop(0); send(data, status); return
        if body['action'] in ('invite_member', 'create_account', 'resend_invite', 'reset_sign_in'):
            member = body.get('memberId', M3); address = body.get('email') or next(m['email'] for m in snapshot('staff')['members'] if m['id'] == member)
            if body.get('deliver') == 'email': send({'email': address, 'expiresInHours': 48, 'memberId': member, 'accountId': ACCOUNT, 'delivery': {'channel': 'email', 'status': 'submitted', 'reason': '', 'recorded': True}}, 201); return
            send({'invite': f'{ACCOUNT}.{member}.' + 'e' * 64, 'email': address, 'expiresInHours': 48, 'memberId': member, 'accountId': ACCOUNT}, 201); return
        if body['action'] == 'synthetic_ping': send({'ok': True, 'state': 'done'}); return
        send({'ok': True})
    def audit(self, page, where):
        result = page.evaluate(AUDIT)
        self.assertGreater(result['counted'], 0, where)
        self.assertLessEqual(result['scroll'], result['width'], f'{where}: horizontal scroll')
        for key in ['small', 'fonts', 'scrollers', 'outside']: self.assertEqual(result[key], [], f'{where}: {key}')
    def tab(self, page, name):
        page.locator('#tabs button').filter(has_text=re.compile('^' + re.escape(name) + '$')).click()
        expect(page.locator('#heading')).to_have_text(name)
    def posts(self, action): return [call['body'] for call in self.calls if call['body'].get('action') == action]
    def wait_posts(self, page, action, count):
        for _ in range(100):
            if len(self.posts(action)) >= count: return self.posts(action)
            page.wait_for_timeout(50)
        self.fail(f'{action}: expected {count} posts, saw {len(self.posts(action))}')

    def test_client_every_tab_is_touch_ready_at_375(self):
        page = self.open('/business-hub'); expect(page.locator('#heading')).to_have_text('Overview')
        self.assertEqual(page.locator('#tabs button').all_inner_texts(), CLIENT_TABS)
        for name in CLIENT_TABS:
            self.tab(page, name)
            if name == 'Properties': page.locator('details summary').first.click(); expect(page.locator('details[open] form')).to_be_visible()
            self.audit(page, 'client ' + name)
        self.tab(page, 'Projects & quotes')
        cards = page.evaluate("""() => { const td = document.querySelector('td[data-label]'); return {table: getComputedStyle(document.querySelector('table')).display, thead: document.querySelector('thead').getBoundingClientRect().height, label: getComputedStyle(td, '::before').content, actions: getComputedStyle(document.querySelector('td.actions')).display}; }""")
        self.assertEqual(cards['table'], 'block'); self.assertLessEqual(cards['thead'], 1); self.assertEqual(cards['label'], '"Property / project"'); self.assertEqual(cards['actions'], 'flex')
        expect(page.get_by_role('button', name='Open project').nth(1)).to_be_disabled()

    def test_client_tabs_fit_320_and_390_phones(self):
        for width, height in [(320, 640), (390, 844)]:
            page = self.open('/business-hub', width, height); expect(page.locator('#heading')).to_have_text('Overview')
            for name in CLIENT_TABS: self.tab(page, name); self.audit(page, f'{width} {name}')
            self.tab(page, 'Overview')
            heights = page.evaluate("[...document.querySelectorAll('.metric strong')].map(s => s.getBoundingClientRect().height)")
            self.assertEqual(len(set(heights)), 1, f'{width}: a metric figure wrapped {heights}')

    def test_client_inputs_use_mobile_keyboards_and_invite_dialog_is_reachable(self):
        page = self.open('/business-hub'); self.tab(page, 'Service requests')
        po, contact = page.locator('input[name=purchaseOrder]'), page.locator('input[name=onsiteContact]')
        self.assertEqual((po.get_attribute('autocomplete'), po.get_attribute('autocapitalize'), po.get_attribute('spellcheck')), ('off', 'characters', 'false'))
        self.assertEqual((contact.get_attribute('autocomplete'), contact.get_attribute('placeholder')), ('off', 'Name and mobile number'))
        self.tab(page, 'Invoices & billing'); billing = page.locator('input[name=billingEmail]')
        self.assertEqual((billing.get_attribute('type'), billing.get_attribute('inputmode'), billing.get_attribute('autocomplete')), ('email', 'email', 'email'))
        self.tab(page, 'Team access'); invite = page.locator('form[data-form=invite]')
        self.assertEqual((invite.locator('input[name=email]').get_attribute('inputmode'), invite.locator('input[name=email]').get_attribute('autocomplete')), ('email', 'off'))
        invite.locator('input[name=name]').fill('Synthetic Colleague'); invite.locator('input[name=email]').fill('colleague@example.invalid')
        invite.get_by_role('button', name='Create private invitation').click()
        expect(page.locator('#invite-dialog')).to_be_visible(); self.audit(page, 'invite dialog')
        page.locator('.dialog-close').click(); expect(page.locator('#invite-dialog')).to_be_hidden()
        self.assertEqual(self.posts('invite_member')[-1]['email'], 'colleague@example.invalid')

    def test_rate_card_renders_the_account_response_and_a_safe_fallback(self):
        page = self.open('/business-hub'); expect(page.locator('#heading')).to_have_text('Overview')
        card = page.locator('section.card').filter(has_text='Your business rates')
        self.assertEqual(card.locator('.rate strong').all_inner_texts(), ['12%', '18%'])
        expect(card).to_contain_text('Synthetic partner savings'); expect(card).to_contain_text('Synthetic terms: discounts follow the accepted quote.')
        expect(card).to_contain_text('<b>not bold</b>'); expect(card.locator('b')).to_have_count(0)
        self.assertNotIn('Partner service savings', page.content()); self.audit(page, 'rate card')
        global RATES
        saved, RATES = RATES, None
        try:
            page = self.open('/business-hub'); expect(page.locator('#heading')).to_have_text('Overview')
            card = page.locator('section.card').filter(has_text='Your business rates')
            expect(card).to_contain_text('Your rates are confirmed on each accepted quote.'); expect(card.locator('.rate')).to_have_count(0); self.audit(page, 'rate card fallback')
        finally:
            RATES = saved

    def test_viewer_sees_read_only_cards_without_member_actions(self):
        self.role = 'viewer'; page = self.open('/business-hub')
        for name in CLIENT_TABS:
            self.tab(page, name); self.audit(page, 'viewer ' + name)
        self.tab(page, 'Team access'); expect(page.locator('[data-revoke]')).to_have_count(0); expect(page.locator('form[data-form=invite]')).to_have_count(0)

    def test_staff_list_and_every_account_tab_at_375(self):
        page = self.open('/business-hub?staff=1'); expect(page.locator('#heading')).to_have_text('Business accounts')
        self.audit(page, 'staff account list')
        page.get_by_role('button', name='Open account').first.click(); expect(page.locator('#heading')).to_have_text('Overview')
        self.assertEqual(self.gets[-1].get('account'), [ACCOUNT])
        for name in CLIENT_TABS:
            self.tab(page, name); self.audit(page, 'staff ' + name)
        self.tab(page, 'Service requests'); expect(page.locator('.request-actions button').first).to_be_visible()
        self.tab(page, 'Projects & quotes'); expect(page.get_by_role('button', name='Remove access').first).to_be_visible()

    def test_signed_out_gates_at_375(self):
        self.signed_out = True
        page = self.open('/business-hub'); expect(page.locator('#gate')).to_be_visible(); expect(page.locator('#invite-form')).to_be_visible(); self.audit(page, 'client gate')
        staff = self.open('/business-hub?staff=1'); expect(staff.locator('#staff-login')).to_be_visible(); self.audit(staff, 'staff gate')
        username = staff.locator('input[name=username]')
        self.assertEqual((username.get_attribute('autocomplete'), username.get_attribute('autocapitalize')), ('username', 'none'))

    def test_staff_sign_out_removes_walkthrough_price_tables_left_on_the_device(self):
        # PRICE-SCRUB: crew/gameplan.html caches walkthrough price tables per user; a staff sign-out here removes them too.
        page = self.open('/business-hub?staff=1'); expect(page.locator('#heading')).to_have_text('Business accounts')
        page.evaluate("() => { localStorage.setItem('egc_walkthrough_pricing.v1.zacb.pc_1111111111111111', '{}'); localStorage.setItem('egc_walkthrough_pricing.v1.tylerg.pc_1111111111111111', '{}'); localStorage.setItem('unrelated', 'kept'); }")
        with page.expect_request(lambda request: request.url.endswith('/api/hub-auth') and request.method == 'DELETE'):
            page.get_by_role('button', name='Sign out').click()
        self.assertEqual(page.evaluate('() => Object.keys(localStorage).sort()'), ['unrelated'])
        self.assertEqual([call['body']['action'] for call in self.calls], ['logout'])
        self.assertEqual(self.hub_auth, ['DELETE'])

    def test_new_property_retries_reuse_one_request_id_and_edits_send_none(self):
        page = self.open('/business-hub'); self.tab(page, 'Properties')
        form = page.locator('section.card').filter(has=page.get_by_role('heading', name='Add a property')).locator('form')
        form.locator('input[name=name]').fill('Synthetic New Lot'); form.locator('input[name=address]').fill('9 Example Plaza')
        self.abort_next = 1; form.get_by_role('button', name='Add property').click()
        expect(page.locator('#notice')).to_have_class(re.compile('error'))
        self.replies = [(200, {'ok': True, 'propertyId': 'f1' * 16, 'duplicate': True})]; form.get_by_role('button', name='Add property').click()
        expect(page.locator('#notice')).to_have_text('Saved.')
        first, retry = self.posts('save_property')
        self.assertRegex(first['requestId'], HEX32); self.assertEqual(retry['requestId'], first['requestId']); self.assertEqual(retry['propertyId'], '')
        page.locator('details summary').first.click(); page.locator('details[open] form').get_by_role('button', name='Save property changes').click()
        expect(page.locator('#notice')).to_have_text('Saved.')
        edit = self.wait_posts(page, 'save_property', 3)[-1]; self.assertEqual(edit['propertyId'], P1); self.assertNotIn('requestId', edit)
        fresh = page.locator('section.card').filter(has=page.get_by_role('heading', name='Add a property')).locator('form').get_attribute('data-id')
        self.assertRegex(fresh, HEX32); self.assertNotEqual(fresh, first['requestId'])

    def test_account_onboarding_retry_is_idempotent_and_duplicate_opens_the_account(self):
        page = self.open('/business-hub?staff=1'); form = page.locator('form[data-form=create]')
        form.locator('input[name=company]').fill('Synthetic Retry Co'); form.locator('input[name=name]').fill('Synthetic Admin'); form.locator('input[name=email]').fill('admin@example.invalid')
        self.abort_next = 1; form.get_by_role('button', name='Create account and invitation').click()
        expect(page.locator('#notice')).to_have_class(re.compile('error'))
        self.replies = [(200, {'ok': True, 'duplicate': True, 'accountId': ACCOUNT})]; form.get_by_role('button', name='Create account and invitation').click()
        expect(page.locator('#notice')).to_contain_text('already created'); expect(page.locator('#heading')).to_have_text('Overview')
        expect(page.locator('#invite-dialog')).to_be_hidden()
        first, retry = self.posts('create_account'); self.assertRegex(first['requestId'], HEX32); self.assertEqual(first, retry)
        self.assertEqual(self.gets[-1].get('account'), [ACCOUNT])

    def test_extension_modules_register_tabs_request_actions_and_member_columns(self):
        page = self.open('/business-hub-extension-test'); expect(page.locator('#heading')).to_have_text('Overview')
        self.assertEqual(page.evaluate('window.__extension.duplicate'), 'rejected')
        self.assertEqual(page.locator('#tabs button').all_inner_texts(), CLIENT_TABS + ['Synthetic ledger', 'Broken tab'])
        self.assertEqual(page.evaluate("EGCBusinessHub.exportUrl('synthetic_csv')"), '/api/business-hub?export=synthetic_csv')
        self.assertTrue(page.evaluate('Object.isFrozen(EGCBusinessHub) && EGCBusinessHub.data().account.id === %r' % ACCOUNT))
        self.tab(page, 'Synthetic ledger'); expect(page.locator('#content')).to_contain_text('Ledger for ' + COMPANY); self.audit(page, 'extension tab')
        page.get_by_role('button', name='Run synthetic action').click(); expect(page.locator('#notice')).to_have_text('Synthetic action done')
        call = [c for c in self.calls if c['body']['action'] == 'synthetic_ping'][-1]
        self.assertEqual(call['headers'].get('x-egc-business'), '1'); self.assertEqual(call['headers'].get('content-type'), 'application/json'); self.assertRegex(call['body']['requestId'], HEX32)
        self.tab(page, 'Broken tab'); expect(page.locator('#content')).to_contain_text('This section could not be displayed')
        self.tab(page, 'Service requests'); expect(page.locator('.request-actions').get_by_role('button', name='Synthetic progress')).to_have_count(2); self.audit(page, 'extension request actions')
        self.tab(page, 'Team access'); expect(page.locator('thead th').nth(2)).to_have_text('Property scope')
        expect(page.locator('td[data-label="Property scope"]').first).to_have_text('All properties'); self.audit(page, 'extension member column')
        staff = self.open('/business-hub-extension-test?staff=1&account=' + ACCOUNT); expect(staff.locator('#heading')).to_have_text('Overview')
        self.assertEqual(staff.locator('#tabs button').all_inner_texts(), CLIENT_TABS + ['Broken tab'])
        self.assertEqual(staff.evaluate("EGCBusinessHub.exportUrl('synthetic_csv')"), f'/api/business-hub?staff=1&account={ACCOUNT}&export=synthetic_csv')

    def test_team_property_access_badges_and_edit_dialog_at_375(self):
        page = self.open('/business-hub'); self.tab(page, 'Team access')
        self.assertEqual(page.locator('td[data-label="Property access"] .scope-badge').all_inner_texts(), ['All properties', 'Access limited to 1 property', 'All properties', 'All properties'])
        self.assertEqual(page.locator('[data-ext-scope]').evaluate_all('b => b.map(x => [x.dataset.extScope, x.textContent])'), [[M2, 'Edit property access'], [M3, 'Limit to properties']])
        self.audit(page, 'team property access')
        page.get_by_role('button', name='Edit property access').click(); dialog = page.locator('#scope-dialog')
        expect(dialog).to_be_visible(); expect(dialog.get_by_role('heading', name='Synthetic Viewer')).to_be_visible()
        expect(dialog.get_by_label('Only selected properties')).to_be_checked()
        expect(dialog.get_by_label(re.compile('Synthetic Tower North'))).to_be_checked(); expect(dialog.get_by_label(re.compile('Synthetic Storage Annex'))).not_to_be_checked()
        self.audit(page, 'property access dialog')
        dialog.get_by_label(re.compile('Synthetic Storage Annex')).check()
        self.abort_next = 1; dialog.get_by_role('button', name='Save property access').click()
        expect(dialog.locator('.scope-error')).not_to_be_empty(); expect(dialog).to_be_visible()
        dialog.get_by_role('button', name='Save property access').click()
        expect(dialog).to_be_hidden(); expect(page.locator('#notice')).to_contain_text('Property access saved')
        first, retry = self.posts('set_member_properties')
        self.assertEqual({k: v for k, v in first.items() if k != 'requestId'}, {'action': 'set_member_properties', 'memberId': M2, 'propertyIds': [P1, P2]})
        self.assertRegex(first['requestId'], HEX32); self.assertEqual(retry, first)
        page.get_by_role('button', name='Limit to properties').click()
        expect(dialog.get_by_label('All properties, including ones added later')).to_be_checked(); expect(dialog.locator('.scope-list')).to_be_hidden()
        dialog.get_by_label('Only selected properties').check(); expect(dialog.locator('.scope-list')).to_be_visible()
        dialog.get_by_role('button', name='Save property access').click()
        expect(dialog.locator('.scope-error')).to_have_text('Select at least one property, or choose All properties.')
        self.assertEqual(len(self.posts('set_member_properties')), 2)
        dialog.get_by_label(re.compile('Synthetic Tower North')).check(); dialog.get_by_role('button', name='Save property access').click(); expect(dialog).to_be_hidden()
        third = self.wait_posts(page, 'set_member_properties', 3)[-1]
        self.assertEqual((third['memberId'], third['propertyIds']), (M3, [P1])); self.assertNotEqual(third['requestId'], first['requestId'])
        page.get_by_role('button', name='Limit to properties').click(); dialog.get_by_role('button', name='Close').click()
        expect(dialog).to_be_hidden(); self.assertEqual(page.evaluate('document.activeElement.dataset.extScope'), M3)

    def test_invite_sends_selected_properties_and_administrators_get_every_property(self):
        page = self.open('/business-hub'); self.tab(page, 'Team access'); form = page.locator('form[data-form=invite]')
        field = form.locator('.scope-field'); expect(field.locator('.scope-list')).to_be_hidden()
        form.locator('input[name=name]').fill('Synthetic Scoped'); form.locator('input[name=email]').fill('scoped@example.invalid')
        field.get_by_label('Only selected properties').check(); self.audit(page, 'invite property checkboxes')
        form.get_by_role('button', name='Create private invitation').click()
        expect(page.locator('#notice')).to_have_text('Select at least one property, or choose All properties.'); self.assertEqual(self.posts('invite_member'), [])
        field.get_by_label(re.compile('Synthetic Storage Annex')).check(); form.get_by_role('button', name='Create private invitation').click()
        expect(page.locator('#invite-dialog')).to_be_visible(); page.locator('.dialog-close').click()
        sent = self.wait_posts(page, 'invite_member', 1)[-1]
        self.assertEqual(sent['propertyIds'], [P2]); self.assertEqual(sent['role'], 'manager'); self.assertNotIn('propertyScope', sent)
        form = page.locator('form[data-form=invite]'); field = form.locator('.scope-field')
        form.locator('input[name=email]').fill('viewer@example.invalid'); form.locator('input[name=email]').dispatch_event('change')
        expect(field.get_by_label('Only selected properties')).to_be_checked(); expect(field.get_by_label(re.compile('Synthetic Tower North'))).to_be_checked()
        form.locator('input[name=name]').fill('Synthetic Promoted'); form.locator('select[name=role]').select_option('admin')
        expect(field.get_by_label('Only selected properties')).to_be_disabled(); expect(field.get_by_label('All properties, including ones added later')).to_be_checked()
        expect(field.locator('.scope-admin')).to_be_visible()
        form.get_by_role('button', name='Create private invitation').click(); expect(page.locator('#invite-dialog')).to_be_visible()
        admin = self.wait_posts(page, 'invite_member', 2)[-1]; self.assertEqual((admin['role'], admin['propertyIds']), ('admin', []))

    def test_invite_prefill_never_overrides_a_property_choice_the_administrator_made(self):
        page = self.open('/business-hub'); self.tab(page, 'Team access'); form = page.locator('form[data-form=invite]')
        field = form.locator('.scope-field'); address = form.locator('input[name=email]'); role = form.locator('select[name=role]')
        north = field.get_by_label(re.compile('Synthetic Tower North')); every = field.get_by_label('All properties, including ones added later'); some = field.get_by_label('Only selected properties')
        # Untouched: a member's email starts from their saved access, returning from administrator keeps it, and a new email resets it.
        address.fill('viewer@example.invalid'); address.dispatch_event('change')
        expect(north).to_be_checked(); expect(field.locator('.scope-prefill')).to_have_text('Starting from Synthetic Viewer’s saved property access.')
        role.select_option('admin'); expect(every).to_be_checked(); expect(field.locator('.scope-prefill')).to_have_text('')
        role.select_option('manager'); expect(some).to_be_checked(); expect(north).to_be_checked()
        address.fill('new.person@example.invalid'); address.dispatch_event('change'); expect(every).to_be_checked(); expect(field.locator('.scope-prefill')).to_have_text('')
        # Touched: the email of an unrestricted member keeps the administrator's selection and says so.
        some.check(); north.check(); form.locator('input[name=name]').fill('Synthetic Billing')
        address.fill('billing@example.invalid'); address.dispatch_event('change')
        expect(some).to_be_checked(); expect(north).to_be_checked()
        expect(field.locator('.scope-prefill')).to_have_text('Your choice here replaces Synthetic Billing’s saved property access.'); self.audit(page, 'invite prefill note')
        form.get_by_role('button', name='Create private invitation').click(); expect(page.locator('#invite-dialog')).to_be_visible()
        sent = self.wait_posts(page, 'invite_member', 1)[-1]; self.assertEqual((sent['email'], sent['propertyIds']), ('billing@example.invalid', [P1]))

    def test_limited_member_sees_badge_and_cannot_add_properties_at_375(self):
        self.role = 'limited'; page = self.open('/business-hub'); expect(page.locator('#heading')).to_have_text('Overview')
        for name in CLIENT_TABS:
            self.tab(page, name); expect(page.locator('#content .scope-note')).to_contain_text('Access limited to 1 property'); self.audit(page, 'limited ' + name)
        self.tab(page, 'Properties'); expect(page.get_by_role('heading', name='Add a property')).to_have_count(0)
        expect(page.locator('details summary')).to_have_count(1)
        self.tab(page, 'Team access'); expect(page.locator('[data-ext-scope]')).to_have_count(0); expect(page.locator('form[data-form=invite]')).to_have_count(0)
        expect(page.locator('thead th')).to_have_text(['Person', 'Role / access', ''])
        desktop = self.open('/business-hub', 1280, 800); expect(desktop.locator('#content .scope-note .scope-badge')).to_have_text('Access limited to 1 property')
        self.assertLessEqual(desktop.evaluate('document.documentElement.scrollWidth'), 1280)

    def row(self, page, name): return page.locator('tbody tr').filter(has_text=name)

    def test_staff_invitation_column_resend_reset_and_emailed_dialog_at_375(self):
        page = self.open('/business-hub?staff=1&account=' + ACCOUNT); self.tab(page, 'Team access')
        expect(page.locator('thead th').nth(2)).to_have_text('Invitation')
        billing, viewer, former = self.row(page, 'Synthetic Billing'), self.row(page, 'Synthetic Viewer'), self.row(page, 'Synthetic Former')
        expect(billing.locator('td[data-label="Invitation"] .pill')).to_have_text('Invitation pending')
        expect(billing.locator('td[data-label="Invitation"] small')).to_contain_text('Email not confirmed')
        expect(billing.get_by_role('button', name='Email new link')).to_be_visible(); expect(billing.get_by_role('button', name='New link', exact=True)).to_be_visible()
        expect(viewer.get_by_role('button', name='Reset & email')).to_be_visible(); expect(viewer.get_by_role('button', name='Reset sign-in')).to_be_visible()
        expect(former.locator('[data-ext-invite]')).to_have_count(0); expect(former.locator('td[data-label="Invitation"] .pill')).to_have_text('Access revoked')
        expect(former.get_by_role('button', name='Revoke access')).to_have_count(0); expect(viewer.get_by_role('button', name='Revoke access')).to_be_visible()
        self.audit(page, 'staff invitation column')
        self.dismiss = True; billing.get_by_role('button', name='Email new link').click()
        self.assertEqual(self.dialogs[-1], 'Email a new invitation to Synthetic Billing at billing@example.invalid? Their earlier link stops working.'); self.assertEqual(self.posts('resend_invite'), [])
        self.dismiss = False; billing.get_by_role('button', name='Email new link').click()
        expect(page.locator('#invite-dialog')).to_be_visible(); expect(page.locator('#invite-title')).to_have_text('Invitation emailed.')
        expect(page.locator('#invite-recipient')).to_have_text('Emailed to billing@example.invalid. This link opens only their company account.')
        expect(page.locator('#invite-link')).to_be_hidden(); expect(page.locator('#copy-invite')).to_be_hidden()
        self.audit(page, 'emailed dialog')
        sent = self.posts('resend_invite')[-1]
        self.assertEqual((sent['memberId'], sent['deliver']), (M3, 'email')); self.assertRegex(sent['requestId'], HEX32); self.assertNotIn('confirm', sent)
        page.locator('.dialog-close').click(); expect(page.locator('#invite-dialog')).to_be_hidden()
        viewer.get_by_role('button', name='Reset sign-in').click()
        expect(page.locator('#invite-title')).to_have_text('Share with this person only.'); expect(page.locator('#invite-link')).to_be_visible()
        self.assertIn(f'#invite={ACCOUNT}.{M2}.', page.locator('#invite-url').input_value())
        reset = self.posts('reset_sign_in')[-1]; self.assertEqual((reset['memberId'], reset['deliver'], reset['confirm']), (M2, 'manual', True))
        self.assertIn("End Synthetic Viewer's current sign-in", self.dialogs[-1])
        page.locator('.dialog-close').click()

    def test_email_fallback_dialog_and_retry_reuse_the_request(self):
        page = self.open('/business-hub?staff=1&account=' + ACCOUNT); self.tab(page, 'Team access')
        billing = self.row(page, 'Synthetic Billing')
        self.replies = [(201, {'invite': f'{ACCOUNT}.{M3}.' + 'f' * 64, 'email': 'billing@example.invalid', 'memberId': M3, 'expiresInHours': 48, 'delivery': {'channel': 'email', 'status': 'failed', 'reason': '', 'recorded': True}})]
        billing.get_by_role('button', name='Email new link').click()
        expect(page.locator('#invite-title')).to_have_text('Share with this person only.'); expect(page.locator('#invite-link')).to_be_visible(); expect(page.locator('#copy-invite')).to_be_visible()
        expect(page.locator('#invite-note')).to_contain_text('The email was rejected, so it was not sent.')
        self.assertTrue(page.locator('#invite-url').input_value().endswith('#invite=' + f'{ACCOUNT}.{M3}.' + 'f' * 64))
        self.audit(page, 'fallback dialog'); page.locator('.dialog-close').click()
        self.replies = [(201, {'invite': f'{ACCOUNT}.{M3}.' + 'f' * 64, 'email': 'billing@example.invalid', 'memberId': M3, 'expiresInHours': 48, 'delivery': {'channel': 'email', 'status': 'uncertain', 'reason': 'no_provider_response', 'recorded': True}})]
        billing.get_by_role('button', name='Email new link').click()
        expect(page.locator('#invite-note')).to_have_text('Email delivery could not be confirmed, so it may still arrive. Do not send another; if it does not arrive, share this same link privately. It expires after 48 hours.')
        page.locator('.dialog-close').click()
        self.replies = [(201, {'invite': f'{ACCOUNT}.{M3}.' + 'a' * 64, 'email': 'billing@example.invalid', 'memberId': M3, 'expiresInHours': 48, 'delivery': {'channel': 'email', 'status': 'not_sent', 'reason': 'template_missing_invite_link', 'recorded': True}})]
        billing.get_by_role('button', name='Email new link').click()
        expect(page.locator('#invite-note')).to_contain_text('The approved invitation wording has no link, so nothing was sent.'); expect(page.locator('#invite-link')).to_be_visible()
        page.locator('.dialog-close').click()
        self.abort_next = 1; billing.get_by_role('button', name='New link', exact=True).click()
        expect(page.locator('#notice')).to_have_class(re.compile('error'))
        self.replies = [(200, {'ok': True, 'duplicate': True, 'accountId': ACCOUNT, 'memberId': M3, 'email': 'billing@example.invalid', 'delivery': {'channel': 'manual', 'status': 'manual'}})]
        billing.get_by_role('button', name='New link', exact=True).click()
        expect(page.locator('#notice')).to_have_text('This request was already completed. The team list shows its current status.')
        first, retry = self.posts('resend_invite')[-2:]
        self.assertEqual(first, retry); self.assertEqual(first['deliver'], 'manual')
        billing.get_by_role('button', name='New link', exact=True).click(); expect(page.locator('#invite-dialog')).to_be_visible()
        self.assertNotEqual(self.posts('resend_invite')[-1]['requestId'], first['requestId'])

    def test_staff_invite_and_onboarding_forms_offer_email_after_confirmation(self):
        page = self.open('/business-hub?staff=1&account=' + ACCOUNT); self.tab(page, 'Team access')
        form = page.locator('form[data-form=invite]'); expect(form.locator('select[name=deliver]')).to_have_value('email')
        form.locator('input[name=name]').fill('Synthetic Colleague'); form.locator('input[name=email]').fill('colleague@example.invalid')
        self.dismiss = True; form.get_by_role('button', name='Create private invitation').click()
        self.assertEqual(self.dialogs[-1], 'EGC will email a private sign-in link to colleague@example.invalid. Send it now?'); self.assertEqual(self.posts('invite_member'), [])
        self.dismiss = False; form.get_by_role('button', name='Create private invitation').click()
        expect(page.locator('#invite-title')).to_have_text('Invitation emailed.'); expect(page.locator('#invite-recipient')).to_contain_text('Emailed to colleague@example.invalid')
        body = self.posts('invite_member')[-1]; self.assertEqual(body['deliver'], 'email'); self.assertRegex(body['requestId'], HEX32)
        page.locator('.dialog-close').click()
        form = page.locator('form[data-form=invite]'); form.locator('input[name=name]').fill('Synthetic Manual'); form.locator('input[name=email]').fill('manual@example.invalid')
        form.locator('select[name=deliver]').select_option('manual'); form.get_by_role('button', name='Create private invitation').click()
        expect(page.locator('#invite-link')).to_be_visible(); self.assertEqual(self.posts('invite_member')[-1]['deliver'], 'manual')
        page.locator('.dialog-close').click()
        listing = self.open('/business-hub?staff=1'); expect(listing.locator('form[data-form=create] select[name=deliver]')).to_have_value('email')
        self.audit(listing, 'staff onboarding with delivery choice')

    def test_client_admin_invitations_are_private_links_only_and_fit_small_phones(self):
        for width, height in [(375, 812), (320, 640)]:
            page = self.open('/business-hub', width, height); self.tab(page, 'Team access')
            expect(page.locator('[data-deliver="email"]')).to_have_count(0); expect(page.locator('form[data-form=invite] select[name=deliver]')).to_have_count(0)
            expect(self.row(page, 'Synthetic Administrator With A Long Name').locator('[data-ext-invite]')).to_have_count(0)
            expect(self.row(page, 'Synthetic Billing').get_by_role('button', name='New link', exact=True)).to_be_visible()
            self.audit(page, f'{width} client invitation column')
        self.row(page, 'Synthetic Billing').get_by_role('button', name='New link', exact=True).click()
        expect(page.locator('#invite-link')).to_be_visible(); self.assertEqual(self.posts('resend_invite')[-1]['deliver'], 'manual')
        self.role = 'viewer'; viewer = self.open('/business-hub'); self.tab(viewer, 'Team access')
        expect(viewer.locator('[data-ext-invite]')).to_have_count(0); expect(viewer.locator('td[data-label="Invitation"] .pill')).to_have_count(0)
        desktop = self.open('/business-hub', 1280, 800); self.tab(desktop, 'Team access')
        expect(desktop.locator('thead th')).to_have_text(['Person', 'Role / access', '']); expect(desktop.locator('td[data-label="Invitation"]')).to_have_count(0)

    def test_desktop_layout_is_unchanged_at_1280_and_1360(self):
        for width, height in [(1280, 800), (1360, 950)]:
            page = self.open('/business-hub', width, height); expect(page.locator('#heading')).to_have_text('Overview')
            layout = page.evaluate(DESKTOP)
            self.assertLessEqual(layout['scroll'], layout['width']); self.assertEqual(layout['rail'], [0, 245]); self.assertEqual(layout['workspace'], 245)
            self.assertTrue(layout['tabsStacked']); self.assertEqual(layout['metricsRow'], 1); self.assertTrue(layout['cardsSideBySide'])
            self.assertEqual(layout['table'], 'table'); self.assertGreater(layout['thead'], 20); self.assertIn(layout['label'], ('none', 'normal')); self.assertEqual(layout['tdButton'], 38)
            self.tab(page, 'Service requests'); self.assertEqual(page.evaluate(DESKTOP)['input'], '12px')
            staff = self.open('/business-hub?staff=1', width, height); expect(staff.locator('#heading')).to_have_text('Business accounts')
            listed = staff.evaluate(DESKTOP); self.assertEqual(listed['table'], 'table'); self.assertEqual(listed['tdButton'], 38); self.assertLessEqual(listed['scroll'], listed['width'])
            self.assertLess(staff.locator('.request-actions button').first.bounding_box()['height'], 44)

if __name__ == '__main__':
    unittest.main()
