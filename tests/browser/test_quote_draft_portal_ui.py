"""Customer portal on a phone for a Hub quote draft (P2-07): an unsent revision is withheld, a sent one is approvable.
The 20-second quiet refresh re-renders the whole page for every portal customer, so it must never overwrite what a customer is typing."""
import json, os, pathlib, subprocess, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 22, 19, 0, tzinfo=timezone.utc)
# The portal's real GET answer (functions/api/customer-portal.js), rendered from a synthetic quote-draft job:
# revision 1 was sent, revision 2 ($938) was saved afterwards and not sent. `sent` is the same job once revision 2 is sent.
SCRIPT = r"""
const { createCustomerPortalHandlers } = await import('./functions/api/customer-portal.js');
const { createCustomerPortalSessionCookie } = await import('./functions/_lib/customer-portal.js');
const env = { CUSTOMER_PORTAL_SECRET: 'synthetic-quote-draft-portal-ui-secret', FIREBASE_API_KEY: 'synthetic' }, at = Date.parse('2026-09-22T19:00:00.000Z');
const lines = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 4000, totalCents: 4000 }, { id: 'shelf', kind: 'product', name: 'Wood shelving unit', quantity: 2, unitCents: 44900, totalCents: 89800 }];
const job = { id: 'job-1', type: 'job', status: 'unscheduled', pipelineStatus: 'unscheduled', customer: 'Synthetic Customer', serviceType: 'Garage transformation', address: '100 Synthetic Way', quoteDraft: { version: 1 }, total: 938, priceQuoted: 938,
  estimate: { number: 'EST-JOB1', source: 'quote_draft', status: 'draft', revision: 2, sentRevision: 1, sentAt: '2026-09-22T18:02:00.000Z', amount: 938, amountCents: 93800, depositRequired: 469, depositRequiredCents: 46900, scope: 'Cleanout plus wood shelving.', lineItems: lines, validUntil: '2026-10-06' },
  deposit: { amount: 469, paidAmount: 100, verified: true }, payment: { amount: 100, verified: true } };
const view = async row => {
  const handlers = createCustomerPortalHandlers({ now: () => new Date(at), read: async () => ({ ...structuredClone(row), __updateTime: 't1' }) });
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-1', { linkVersion: 0, linkRoot: 'job-1' }, at)).split(';')[0];
  return (await handlers.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/customer-portal', { headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie } }) })).json();
};
// A plain (non-draft) approved job with saved property details, a job-day plan, one authorized person, a pending crew
// decision and two gift cards: what a customer may be editing when the quiet refresh lands.
const plain = { id: 'job-1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Customer', serviceType: 'Garage transformation', address: '100 Synthetic Way', total: 1000, priceQuoted: 1000, date: '2026-09-24', time: '09:00', endTime: '12:00',
  estimate: { number: 'EST-1', status: 'approved', amount: 1000, depositRequired: 500, scope: 'Cleanout.', acceptedAt: '2026-09-21T18:00:00.000Z' }, customerApproval: { status: 'approved', approvedAt: '2026-09-21T18:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 1000 },
  deposit: { amount: 500, paidAmount: 500, verified: true }, payment: { amount: 500, verified: true },
  customerMemory: { accessInstructions: 'Old access', parkingNotes: 'Old parking', petNotes: 'One cat' },
  jobDayRules: { decisionMaker: 'Synthetic Customer', payer: 'Synthetic Customer', noResponseAction: 'pause' },
  customerCollaborators: [{ id: 'person-1', name: 'Synthetic Partner', email: 'partner@example.invalid', role: 'Spouse', status: 'active', permissions: { view: true, decide: true } }],
  customerDecisions: [{ id: 'd1', status: 'pending', title: 'Add a second shelf?', details: 'The crew found space for another shelf.', priceDelta: 120, promptedAt: '2026-09-22T18:55:00.000Z' }],
  giftWallet: { cards: [{ id: 'g1', label: 'Card A', issuedAmount: 100, remainingAmount: 100 }, { id: 'g2', label: 'Card B', issuedAmount: 50, remainingAmount: 50 }] } };
const decision = (id, title, promptedAt) => ({ id, status: 'pending', title, details: 'Synthetic crew question.', priceDelta: 40, promptedAt });
// While the customer types: staff update the pet notes, the crew asks a second question and Card A is partly used elsewhere.
const changed = { ...plain, customerMemory: { ...plain.customerMemory, petNotes: 'Two cats, keep the side door shut' }, customerDecisions: [...plain.customerDecisions, decision('d2', 'Haul the old paint cans?', '2026-09-22T19:00:10.000Z')],
  giftWallet: { cards: [{ ...plain.giftWallet.cards[0], remainingAmount: 80 }, plain.giftWallet.cards[1]] } };
const again = { ...changed, address: '102 Synthetic Way', customerDecisions: [...changed.customerDecisions, decision('d3', 'Keep the workbench?', '2026-09-22T19:00:30.000Z')] };
// The customer's own memory save (the server trims it), a later staff edit, and the saved new person with a server-issued id.
const saved = { ...plain, customerMemory: { ...plain.customerMemory, accessInstructions: 'Gate code 4321, side door' } };
const staff = { ...saved, customerMemory: { ...saved.customerMemory, accessInstructions: 'Use the keypad by the side door' } };
const people = { ...staff, customerCollaborators: [...plain.customerCollaborators, { id: 'person-2', name: 'Synthetic Neighbor', email: 'neighbor@example.invalid', role: 'Neighbor', status: 'active', permissions: { view: true } }] };
// Staff (or the customer's other device) add a helper; later staff also give the partner "pay" and update the neighbor.
const added = { ...plain, customerCollaborators: [...plain.customerCollaborators, { id: 'person-3', name: 'Synthetic Helper', email: 'helper@example.invalid', role: 'Property manager', status: 'active', permissions: { view: true, pay: true } }] };
const everyone = { ...people, customerCollaborators: [{ ...plain.customerCollaborators[0], permissions: { view: true, decide: true, pay: true } }, { ...people.customerCollaborators[1], role: 'Neighbor with key' }, added.customerCollaborators[1]] };
console.log(JSON.stringify({ withheld: await view(job), sent: await view({ ...job, estimate: { ...job.estimate, status: 'sent', sentRevision: 2 } }),
  plain: await view(plain), changed: await view(changed), again: await view(again), saved: await view(saved), staff: await view(staff), people: await view(people),
  added: await view(added), everyone: await view(everyone) }));
"""
VIEWS = json.loads(subprocess.run(['node', '--input-type=module', '-e', SCRIPT], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
# Where keyboard focus is: a field id, a decision control (decision/field-or-action), a credit card, an invite or an editor field.
FOCUS = '''(() => { const a = document.activeElement; if (!a || a === document.body) return 'BODY'; if (a.id) return a.id;
  const decision = a.closest('.decision'); if (decision) return decision.dataset.id + '/' + (a.dataset.field || a.dataset.action);
  const credit = a.closest('.credit-row'); if (credit) return 'credit:' + credit.dataset.card; if (a.dataset.person) return 'invite:' + a.dataset.person;
  const row = a.closest('.person-edit'); if (row) return 'editor:' + row.dataset.id + '/' + (a.dataset.field || a.dataset.permission || a.textContent);
  return a.tagName + ':' + a.textContent })()'''


def with_people(view, change):
    view = json.loads(json.dumps(view)); change(view['experience']['collaborators']); return view


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


class PortalQuoteDraftBrowserTests(unittest.TestCase):
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
        self.errors = []; self.posts = []; self.view = VIEWS['withheld']; self.on_post = None
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)

    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if parsed.path == '/api/customer-portal':
            if request.method == 'GET': send(self.view); return
            self.posts.append(request.post_data_json)
            if self.on_post: self.on_post(request.post_data_json, send); return
            send({'ok': False, 'code': 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE', 'error': 'This estimate is being updated.'}, 409); return
        if parsed.path == '/api/customer-portal-document': send({'ok': True, 'kind': 'insurance', 'available': False}); return
        route.continue_()

    def open_portal(self):
        self.page.goto(self.url + '/customer-portal.html'); expect(self.page.locator('#portal')).to_be_visible()

    def test_an_unsent_revision_shows_no_price_lines_or_approval_on_a_phone(self):
        estimate = self.view['estimate']
        self.assertEqual([estimate['status'], estimate['withheld'], estimate['approvable'], estimate['amount'], estimate['lineItems']], ['being_updated', True, False, 0, []])
        self.open_portal()
        expect(self.page.locator('#estimate-status')).to_have_text('being updated')
        for node in ['#estimate-total', '#summary-total', '#summary-balance', '#payment-balance']: expect(self.page.locator(node)).to_have_text('—')
        expect(self.page.locator('#approval-unavailable')).to_be_visible()
        expect(self.page.locator('#approval-form')).to_be_hidden(); expect(self.page.locator('#approve-button')).to_be_hidden()
        expect(self.page.locator('#pay-button')).to_be_hidden(); expect(self.page.locator('#estimate-lines')).to_be_hidden()
        expect(self.page.locator('.estimate-meta')).to_be_hidden()
        expect(self.page.locator('#payment-paid')).to_have_text('$100.00')
        text = self.page.locator('#portal').inner_text()
        for unsent in ['$938', '938.00', '$469', 'Wood shelving unit', 'Cleanout plus wood shelving', 'Paid in full']: self.assertNotIn(unsent, text)
        for width in (320, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        self.page.locator('#estimate-status').scroll_into_view_if_needed()
        self.page.screenshot(path=str(ROOT / 'test-results' / 'portal-quote-draft-withheld-375.png'))
        self.assertEqual(self.posts, [])

    def test_the_same_revision_once_sent_is_shown_and_approvable(self):
        self.view = VIEWS['sent']; self.open_portal()
        expect(self.page.locator('#estimate-total')).to_have_text('$938.00')
        expect(self.page.locator('#estimate-lines')).to_contain_text('Wood shelving unit')
        expect(self.page.locator('#approve-button')).to_be_visible(); expect(self.page.locator('#approval-unavailable')).to_be_hidden()
        expect(self.page.locator('.estimate-meta')).to_be_visible(); expect(self.page.locator('#estimate-deposit')).to_contain_text('$469.00')

    def test_a_revision_sent_while_the_page_is_open_appears_in_full_on_the_quiet_refresh(self):
        self.open_portal()
        expect(self.page.locator('#payment-due-now')).to_have_text('Nothing is due until we send you the updated estimate to review.')
        expect(self.page.locator('#estimate-lines')).to_be_hidden(); expect(self.page.locator('.estimate-meta')).to_be_hidden()
        # The author sends revision 2 while the customer keeps the portal open; the 20-second refresh picks it up.
        self.view = VIEWS['sent']; self.page.clock.run_for(20000)
        expect(self.page.locator('#estimate-total')).to_have_text('$938.00')
        expect(self.page.locator('#estimate-lines')).to_be_visible(); expect(self.page.locator('#estimate-lines')).to_contain_text('Wood shelving unit')
        expect(self.page.locator('.estimate-meta')).to_be_visible(); expect(self.page.locator('#estimate-deposit')).to_contain_text('$469.00')
        expect(self.page.locator('#estimate-validity')).to_contain_text('Valid through')
        expect(self.page.locator('#approval-updated')).to_be_visible(); expect(self.page.locator('#approve-button')).to_be_visible()
        expect(self.page.locator('#approval-unavailable')).to_be_hidden()
        expect(self.page.locator('#payment-due-now')).to_contain_text('$369.00 deposit due upfront')
        self.assertEqual(self.page.locator('#payment-due-now').count(), 1)
        # Later refreshes keep rendering the whole page (the due-now line is never removed by the closeout rule).
        self.page.clock.run_for(20000)
        expect(self.page.locator('#payment-due-now')).to_contain_text('$369.00 deposit due upfront')
        self.assertEqual(self.page.locator('.payment-rule:not(#payment-due-now)').count(), 1)
        self.assertEqual(self.posts, [])

    def values(self):
        return self.page.evaluate('''() => ({ access: $('memory-access').value, parking: $('memory-parking').value, pets: $('memory-pets').value, decisionMaker: $('decision-maker').value,
            card: $('transfer-card').value, cards: [...$('transfer-card').options].map(option => option.textContent),
            people: [...document.querySelectorAll('#collaborator-editor .person-edit')].map(row => [row.dataset.id, row.querySelector('[data-field="name"]').value]),
            decisions: Object.fromEntries([...document.querySelectorAll('#decision-list .decision')].map(box => [box.querySelector('h3').textContent, box.querySelector('input[autocomplete="name"]').value])),
            focus: document.activeElement?.id || (document.activeElement?.closest?.('.decision') ? document.activeElement.closest('.decision').querySelector('h3').textContent + (document.activeElement.autocomplete === 'name' ? ' / name' : ' / note') : document.activeElement?.tagName) })''')

    def test_the_quiet_refresh_keeps_what_a_customer_is_typing_on_a_plain_job(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        # Unsaved edits across the page: property access, the job-day decision-maker, a new authorized person, a transfer
        # card, a decision name, and Parking still being typed when the refresh lands.
        page.fill('#memory-access', 'Gate code 4321, side door'); page.fill('#decision-maker', 'Synthetic Partner')
        page.locator('#add-person').click(); row = page.locator('#collaborator-editor .person-edit').last
        row.locator('[data-field="name"]').fill('Synthetic Neighbor'); row.locator('[data-field="email"]').fill('neighbor@example.invalid')
        page.select_option('#transfer-card', 'g2'); page.locator('.decision input[autocomplete="name"]').first.fill('Synthetic Cust')
        page.locator('#memory-parking').focus(); page.keyboard.type(' street only')
        before = self.values()
        self.assertEqual([before['access'], before['decisionMaker'], before['card'], before['decisions'], before['focus']], ['Gate code 4321, side door', 'Synthetic Partner', 'g2', {'Add a second shelf?': 'Synthetic Cust'}, 'memory-parking'])
        # Staff change the pet notes, the crew asks a second question and Card A's balance changes; the refresh shows all of it.
        self.view = VIEWS['changed']; page.clock.run_for(20000)
        expect(page.locator('#memory-pets')).to_have_value('Two cats, keep the side door shut')
        expect(page.locator('#decision-count')).to_have_text('2')
        after = self.values()
        for key in ['access', 'parking', 'decisionMaker', 'card', 'people', 'focus']: self.assertEqual(after[key], before[key], key)
        self.assertEqual(after['decisions'], {'Haul the old paint cans?': '', 'Add a second shelf?': 'Synthetic Cust'})
        self.assertEqual(after['cards'], ['Card A · $80.00', 'Card B · $50.00'])
        self.assertEqual(after['people'], [['person-1', 'Synthetic Partner'], ['', 'Synthetic Neighbor']])
        # The decision input has focus while a third question rebuilds the list: the typed name and the focus both survive.
        name = page.locator('.decision', has_text='Add a second shelf?').locator('input[autocomplete="name"]'); name.focus(); page.keyboard.type('omer')
        self.view = VIEWS['again']; page.clock.run_for(20000)
        expect(page.locator('#appointment-address')).to_have_text('102 Synthetic Way'); expect(page.locator('#decision-count')).to_have_text('3')
        last = self.values()
        self.assertEqual([last['decisions'], last['focus']], [{'Keep the workbench?': '', 'Haul the old paint cans?': '', 'Add a second shelf?': 'Synthetic Customer'}, 'Add a second shelf? / name'])
        for key in ['access', 'parking', 'decisionMaker', 'card', 'people']: self.assertEqual(last[key], before[key], key)
        self.assertEqual(self.posts, [])

    def test_a_saved_form_takes_later_server_changes_again(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        def save(body, send):
            self.view = VIEWS['people' if body['action'] == 'save_collaborators' else 'saved']; send({'ok': True})
        self.on_post = save
        # The server trims what it saves; once the save succeeds the field is clean again and follows the saved value.
        page.fill('#memory-access', 'Gate code 4321, side door '); page.get_by_role('button', name='Save property details').click()
        expect(page.locator('#memory-state')).to_have_text('Saved for this job and future rebooking.')
        expect(page.locator('#memory-access')).to_have_value('Gate code 4321, side door')
        self.view = VIEWS['staff']; page.clock.run_for(20000)
        expect(page.locator('#memory-access')).to_have_value('Use the keypad by the side door')
        # A saved new person picks up the server-issued id, so a later save keeps the same person (and their invite).
        page.locator('#add-person').click(); row = page.locator('#collaborator-editor .person-edit').last
        row.locator('[data-field="name"]').fill('Synthetic Neighbor'); row.locator('[data-field="email"]').fill('neighbor@example.invalid'); row.locator('[data-field="role"]').fill('Neighbor')
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('Authorized people saved.')
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-2"]')).to_have_count(1)
        self.assertEqual(self.values()['people'], [['person-1', 'Synthetic Partner'], ['person-2', 'Synthetic Neighbor']])
        self.assertEqual([body['action'] for body in self.posts], ['save_customer_memory', 'save_collaborators'])
        self.assertEqual(self.posts[0]['access_instructions'], 'Gate code 4321, side door ')
        self.assertEqual([person['id'] for person in self.posts[1]['collaborators']], ['person-1', ''])

    def test_focus_on_invite_decision_and_credit_buttons_survives_the_quiet_refresh(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal(); focus = lambda: page.evaluate(FOCUS)
        # Copy invite: a refresh that leaves the people unchanged does not rebuild the list, so the focused button itself stays.
        page.locator('#collaborator-list [data-person="person-1"]').focus(); self.assertEqual(focus(), 'invite:person-1')
        page.evaluate('window.focusedInvite = document.activeElement')
        self.view = VIEWS['changed']; page.clock.run_for(20000); expect(page.locator('#decision-count')).to_have_text('2')
        self.assertTrue(page.evaluate('document.activeElement === window.focusedInvite'), 'an unchanged list keeps its buttons')
        # A person added elsewhere rebuilds the list at once, and focus returns to the same person's new button.
        self.view = VIEWS['added']; page.clock.run_for(20000)
        expect(page.locator('#collaborator-list [data-person="person-3"]')).to_have_text('Copy invite')
        expect(page.locator('#collaborator-editor .person-edit')).to_have_count(2)
        self.assertEqual(focus(), 'invite:person-1'); self.assertFalse(page.evaluate('document.activeElement === window.focusedInvite'))
        # Apply: Card A's balance changes elsewhere, the wallet is rebuilt, and focus returns to Card A's new Apply button.
        page.locator('.credit-row[data-card="g1"] button').focus(); self.assertEqual(focus(), 'credit:g1')
        self.view = VIEWS['changed']; page.clock.run_for(20000)
        expect(page.locator('.credit-row[data-card="g1"] button')).to_have_text('Apply $80.00')
        self.assertEqual(focus(), 'credit:g1')
        # Approve and Decline: a new crew question rebuilds the list and focus returns to the same decision's button.
        page.locator('.decision[data-id="d1"] [data-action="approved"]').focus(); self.assertEqual(focus(), 'd1/approved')
        self.view = VIEWS['again']; page.clock.run_for(20000)
        expect(page.locator('#decision-count')).to_have_text('3')
        self.assertEqual(focus(), 'd1/approved')
        page.locator('.decision[data-id="d2"] [data-action="declined"]').focus()
        self.view = VIEWS['changed']; page.clock.run_for(20000)
        expect(page.locator('#decision-count')).to_have_text('2')
        self.assertEqual(focus(), 'd2/declined')
        self.assertEqual(self.posts, [])

    def test_the_people_editor_follows_staff_changes_until_it_is_edited_and_then_merges_them(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        partner = page.locator('#collaborator-editor .person-edit[data-id="person-1"]'); notice = page.locator('#collaborator-notice')
        # Typing and then restoring the saved value leaves the editor clean, so a person added elsewhere shows up.
        partner.locator('[data-field="role"]').fill('Co-owner'); partner.locator('[data-field="role"]').fill('Spouse'); page.evaluate('document.activeElement.blur()')
        self.view = VIEWS['added']; page.clock.run_for(20000)
        expect(page.locator('#collaborator-editor .person-edit')).to_have_count(2)
        self.assertEqual(self.values()['people'], [['person-1', 'Synthetic Partner'], ['person-3', 'Synthetic Helper']]); expect(notice).to_be_hidden()
        # Focus in a clean editor: the update is applied in place (the helper is removed, a neighbor added) and focus stays.
        partner.locator('[data-field="name"]').focus()
        self.view = VIEWS['people']; page.clock.run_for(20000)
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-2"]')).to_have_count(1)
        self.assertEqual(self.values()['people'], [['person-1', 'Synthetic Partner'], ['person-2', 'Synthetic Neighbor']])
        self.assertEqual(page.evaluate(FOCUS), 'editor:person-1/name'); expect(notice).to_be_hidden()
        # An edited editor keeps the edit. Staff then add the helper back, update the untouched neighbor and give the partner
        # "pay": the helper and the neighbor's update are merged in, the edited partner keeps the customer's version, and a
        # notice says so. Nobody is dropped.
        partner.locator('[data-field="role"]').fill('Co-owner'); page.evaluate('document.activeElement.blur()')
        self.view = VIEWS['everyone']; page.clock.run_for(20000)
        expect(notice).to_be_visible(); expect(notice).to_contain_text('updated while you were editing'); expect(notice).to_contain_text('your version is kept')
        self.assertEqual(self.values()['people'], [['person-1', 'Synthetic Partner'], ['person-2', 'Synthetic Neighbor'], ['person-3', 'Synthetic Helper']])
        expect(partner.locator('[data-field="role"]')).to_have_value('Co-owner'); expect(partner.locator('[data-permission="pay"]')).not_to_be_checked()
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-2"] [data-field="role"]')).to_have_value('Neighbor with key')
        # Later refreshes keep the merged editor as it is while it differs from the server.
        page.clock.run_for(20000); expect(partner.locator('[data-field="role"]')).to_have_value('Co-owner')
        self.assertEqual(len(self.values()['people']), 3)
        self.assertEqual(self.posts, [])

    def test_a_save_from_a_stale_people_editor_waits_for_the_customer_to_review_the_update(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        partner = page.locator('#collaborator-editor .person-edit[data-id="person-1"]'); partner.locator('[data-field="role"]').fill('Co-owner')
        # Staff add a helper; the quiet refresh has not run yet when the customer saves the edited list.
        self.view = VIEWS['added']; saved = with_people(VIEWS['added'], lambda people: people[0].update(role='Co-owner'))
        def save(body, send):
            self.view = saved; send({'ok': True, 'collaborators': saved['experience']['collaborators']})
        self.on_post = save
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('This list changed while you were editing. Review the people above, then save again.')
        self.assertEqual(self.posts, [], 'the stale list is never sent')
        expect(page.locator('#collaborator-notice')).to_be_visible()
        self.assertEqual(self.values()['people'], [['person-1', 'Synthetic Partner'], ['person-3', 'Synthetic Helper']])
        expect(partner.locator('[data-field="role"]')).to_have_value('Co-owner')
        self.assertEqual(page.evaluate('document.activeElement.textContent'), 'Save authorized people', 'focus returns to the button')
        # The reviewed list saves with both the customer's edit and the person staff added.
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('Authorized people saved.')
        self.assertEqual([[person['id'], person['role']] for person in self.posts[0]['collaborators']], [['person-1', 'Co-owner'], ['person-3', 'Property manager']])
        expect(page.locator('#collaborator-notice')).to_be_hidden()
        # Clean again: the editor follows the next staff change.
        self.view = with_people(saved, lambda people: people[1].update(role='Building manager')); page.clock.run_for(20000)
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-3"] [data-field="role"]')).to_have_value('Building manager')
        self.assertEqual(len(self.posts), 1)

    def test_a_save_waits_when_the_latest_people_list_cannot_be_read(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        page.locator('#collaborator-editor .person-edit[data-id="person-1"] [data-field="role"]').fill('Co-owner')
        def unavailable(route):
            if route.request.method == 'GET': route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'error': 'Temporarily unavailable.'}))
            else: route.fallback()
        page.route('**/api/customer-portal', unavailable)
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('The latest list could not be checked, so nothing was saved. Try again in a moment.')
        self.assertEqual(self.posts, [], 'an unchecked list is never sent'); expect(page.locator('#portal')).to_be_visible()
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-1"] [data-field="role"]')).to_have_value('Co-owner')
        # Once the list can be read again, the same save goes out.
        page.unroute('**/api/customer-portal', unavailable); saved = with_people(VIEWS['plain'], lambda people: people[0].update(role='Co-owner'))
        def save(body, send):
            self.view = saved; send({'ok': True, 'collaborators': saved['experience']['collaborators']})
        self.on_post = save
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('Authorized people saved.')
        self.assertEqual([[person['id'], person['role']] for person in self.posts[0]['collaborators']], [['person-1', 'Co-owner']])

    def test_a_new_person_takes_the_server_id_even_when_the_customer_types_during_the_save(self):
        page = self.page; self.view = VIEWS['plain']; self.open_portal()
        page.evaluate("document.querySelectorAll('details').forEach(details => { details.open = true })")
        page.locator('#add-person').click(); row = page.locator('#collaborator-editor .person-edit').nth(1)
        row.locator('[data-field="name"]').fill('Synthetic Neighbor'); row.locator('[data-field="email"]').fill('Neighbor@Example.invalid'); row.locator('[data-field="role"]').fill('Neighbor')
        pending = []; self.on_post = lambda body, send: pending.append(send)
        page.get_by_role('button', name='Save authorized people').click()
        for _ in range(100):
            if pending: break
            page.wait_for_timeout(20)
        self.assertEqual(len(pending), 1)
        # The customer keeps typing while the save is in flight; the server answers with the saved list and its new id.
        row.locator('[data-field="role"]').fill('Neighbor next door')
        self.view = VIEWS['people']; pending[0]({'ok': True, 'collaborators': VIEWS['people']['experience']['collaborators']})
        expect(page.locator('#collaborator-state')).to_have_text('Authorized people saved.')
        expect(page.locator('#collaborator-editor .person-edit[data-id="person-2"]')).to_have_count(1)
        expect(row.locator('[data-field="role"]')).to_have_value('Neighbor next door')
        page.clock.run_for(20000); expect(row.locator('[data-field="role"]')).to_have_value('Neighbor next door')
        # Saving again updates the same person (the same id, so the invite already created keeps working).
        after = with_people(VIEWS['people'], lambda people: people[1].update(role='Neighbor next door'))
        def save(body, send):
            self.view = after; send({'ok': True, 'collaborators': after['experience']['collaborators']})
        self.on_post = save
        page.get_by_role('button', name='Save authorized people').click()
        expect(page.locator('#collaborator-state')).to_have_text('Authorized people saved.')
        self.assertEqual([[person['id'], person['role']] for person in self.posts[1]['collaborators']], [['person-1', 'Spouse'], ['person-2', 'Neighbor next door']])
        self.assertEqual([person['id'] for person in self.posts[0]['collaborators']], ['person-1', ''])


if __name__ == '__main__':
    unittest.main()
