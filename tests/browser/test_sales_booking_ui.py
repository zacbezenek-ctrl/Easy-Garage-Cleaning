"""SALES-BOOKING: the phone person's booking tools in the real employee.html at 375 px, every API routed to synthetic
fixtures (no production service): navigation by the server's capabilities, the lead card (Call, Open in HighLevel and
Book walkthrough; no sms: link), a new customer through /api/customer-resolve, the booker's dispatch form, the Action
Center deep link with Call and Book, the HighLevel outage wording, and /book's time choices from the Denver clock
(EGC_BOOKING_EXPLICIT_SLOTS on; off, /book keeps its static choices)."""
import copy, json, re, unittest
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect
from hub_shell_harness import HubShell, RESULTS, DAY, DONE, collections

SALES = {'ok': True, 'user': 'Synthetic.Sales', 'displayName': 'Synthetic Sales', 'role': 'sales', 'businessAccess': False, 'payType': 'hourly', 'hourlyRate': 20, 'owner': False,
         'capabilities': ['customer.send', 'followups.own', 'quotes.author', 'schedule.book', 'walkthrough.perform'], 'capabilityMode': 'staff_roles', 'roleAccess': True}
FEED = {'ok': True, 'projection': 'booker', 'locationId': 'location-synthetic', 'leadResetAt': '2026-09-03T00:00:00Z', 'pipelines': [{'id': 'pipe-1', 'stages': [{'id': 'stage-1', 'name': 'New lead'}]}],
        'opportunities': [{'id': 'opp-1', 'name': 'Synthetic Lead — Garage cleanout', 'status': 'open', 'source': 'Website', 'pipelineStageId': 'stage-1', 'contactId': 'contact-1',
                           'contact': {'id': 'contact-1', 'name': 'Synthetic Lead', 'phone': '(970) 555-0111', 'email': 'synthetic.lead@example.invalid'}}]}
LEAD = {'ok': True, 'locationId': 'location-synthetic', 'notesRead': True, 'lead': {'contactId': 'contact-1', 'name': 'Synthetic Lead', 'phone': '(970) 555-0111', 'email': 'synthetic.lead@example.invalid',
        'address': '123 Synthetic Way, Fort Collins, CO', 'service': 'Garage Cleanout', 'requestedSlot': {'date': '2026-09-24', 'window': 'PM'}, 'requestedSlotText': '2026-09-24 PM'}}
ROSTER = [{'id': 'synthetic.crew', 'name': 'Synthetic Crew', 'role': 'crew'}, {'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}]
HUB_JOB = {'id': 'job-today', 'revision': 'rev-1', 'type': 'job', 'customerId': 'customer-9', 'customer': 'Synthetic Johnson Garage', 'phone': '9705550100', 'address': '123 Synthetic Way, Fort Collins, CO',
           'date': DAY, 'time': '08:00', 'endDate': DAY, 'endTime': '11:00', 'status': 'scheduled', 'assignedCrew': ['synthetic.crew'], 'startAt': DAY + 'T14:00:00.000Z', 'endAt': DAY + 'T17:00:00.000Z'}
TASK = {'id': 'task-1', 'revision': 1, 'title': 'Schedule the synthetic job', 'description': 'The customer asked to book the cleanout.', 'kind': 'schedule_job', 'status': 'open', 'priority': 'high',
        'assignedUserId': 'synthetic.sales', 'dueAt': DAY + 'T20:00:00.000Z', 'waitingOn': 'none', 'reviewAt': None, 'approvalStatus': 'not_required', 'completionCondition': 'The job is on the schedule',
        'portalJobId': 'job-today', 'sourceEvidence': [], 'completionEvidence': []}
# WT-OUTCOME after SALES-BOOKING: a walkthrough on the booker's board whose HighLevel appointment sync failed.
WALK = {'id': 'walk-today', 'revision': 'walk-rev-1', 'type': 'walkthrough', 'customerId': 'customer-7', 'customer': 'Synthetic Walkthrough Lead', 'phone': '(970) 555-0122', 'address': '7 Found Ct, Loveland, CO',
        'date': DAY, 'time': '15:00', 'endDate': DAY, 'endTime': '16:00', 'status': 'scheduled', 'assignedCrew': ['synthetic.crew'], 'crewLead': None, 'crewId': None, 'vehicleId': None, 'crewNeeded': 1,
        'startAt': DAY + 'T21:00:00.000Z', 'endAt': DAY + 'T22:00:00.000Z', 'serviceType': 'Free walkthrough', 'syncStatus': 'error', 'arrivalWindowStart': None, 'arrivalWindowEnd': None, 'arrivalWindow': ''}


class SalesBookingBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.highlevel = None; self.contacts_down = False; self.resolves = []; self.saves = []; self.operations = []; self.lead_slot = None; self.dispatch_extra = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path.startswith('/api/'):
            query = parse_qs(parsed.query)
            def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
            if parsed.path == '/api/highlevel' and request.method == 'GET':
                view = query.get('view', [''])[0]; self.calls.append((request.method, parsed.path, parsed.query))
                if view == 'command': send(*(self.highlevel or (copy.deepcopy(FEED), 200))); return
                if view == 'lead':
                    lead = copy.deepcopy(LEAD)
                    if self.lead_slot: lead['lead']['requestedSlot'] = self.lead_slot
                    send(lead); return
                if view == 'contacts':
                    if self.contacts_down: send({'ok': False, 'error': 'HighLevel is unreachable'}, 502)
                    else: send({'ok': True, 'contacts': [{'id': 'contact-7', 'name': 'Synthetic Found', 'phone': '(970) 555-0177', 'email': 'found@example.invalid', 'address': '7 Found Ct, Loveland, CO'}]})
                    return
            if parsed.path == '/api/dispatch':
                self.calls.append((request.method, parsed.path, parsed.query))
                if request.method == 'POST':
                    body = request.post_data_json; self.saves.append(body)
                    job = {**(body.get('changes') or {}), 'id': 'visit-1', 'revision': 'rev-new', 'type': body.get('kind', 'job'), 'customerId': body.get('customerId'), 'customer': 'Synthetic Lead', 'status': 'scheduled'}
                    send({'ok': True, 'requestId': body['requestId'], 'job': job, 'warnings': []}); return
                if query.get('view') == ['customers']: send({'ok': True, 'customers': [], 'total': 0}); return
                if query.get('view') == ['job']: send({'ok': True, 'job': copy.deepcopy(HUB_JOB), 'roster': ROSTER, 'crews': [], 'vehicles': [], 'warnings': []}); return
                send({'ok': True, 'viewer': {'id': 'Synthetic.Sales', 'booker': True}, 'timeZone': 'America/Denver', 'jobs': [copy.deepcopy(HUB_JOB)] + copy.deepcopy(self.dispatch_extra), 'roster': ROSTER, 'crews': [], 'vehicles': [],
                      'availability': [], 'warnings': [], 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': query.get('startDate', [DAY])[0], 'endDate': query.get('endDate', ['2026-09-29'])[0]}); return
            if parsed.path == '/api/employee-hub' and request.method == 'GET':
                # The Sales account has finished onboarding, so a deep link opens its view rather than Getting started.
                data = collections(self.profile)
                data['profiles'].append({'id': 'synthetic.sales', 'username': 'Synthetic.Sales', 'displayName': 'Synthetic Sales', 'role': 'sales', 'status': 'active', 'hourlyRate': 20, 'jobTitle': 'Sales', **DONE})
                send({'ok': True, 'collections': data, 'accounts': []}); return
            if parsed.path == '/api/customer-resolve':
                body = request.post_data_json; self.resolves.append(body)
                send({'ok': True, 'requestId': body['requestId'], 'customer': {'id': 'customer-new', 'revision': 'c1', 'phone': '(•••) •••-0111', 'email': 's•••@example.invalid', 'contactDetails': 'masked'}, 'created': True, 'linked': False}); return
            if parsed.path == '/api/operations':
                if request.method == 'GET': send({'ok': True, 'enabled': True, 'actor': {'id': 'Synthetic.Sales', 'role': 'sales', 'kind': 'human'}, 'owners': [{'id': 'synthetic.sales', 'name': 'Synthetic Sales', 'role': 'sales'}]}); return
                command = request.post_data_json['body']; self.operations.append(command)
                if command['command'] == 'queue': send({'ok': True, 'items': [copy.deepcopy(TASK)], 'total': 1, 'nextOffset': None, 'asOf': DAY + 'T18:00:00Z'}); return
                if command['command'] == 'task.get': send({'ok': True, 'task': copy.deepcopy(TASK), 'previewHash': 'a' * 64, 'effectiveApproval': 'not_required', 'history': [], 'approvals': []}); return
                send({'error': 'operations_unavailable'}, 503); return
        super().route(route)

    def dialog(self):
        return self.page.locator('dialog.dp-dialog[open]')

    def assert_phone_fit(self, width, scope):
        scroll = self.no_horizontal_scroll(); self.assertLessEqual(scroll['width'], width, scroll)
        self.assertEqual(self.small_targets(scope), []); self.assertEqual(self.small_inputs(scope), [])

    def test_sales_nav_lead_card_and_book_opens_a_prefilled_walkthrough_at_375(self):
        page = self.open('pipeline', width=375, height=812, profile=SALES)
        self.assertEqual([view for view in self.nav_views() if view in ('pipeline', 'walkthroughs', 'schedule', 'action_center', 'today', 'customers', 'finance', 'people')],
                         ['action_center', 'schedule', 'walkthroughs', 'pipeline'])
        card = page.locator('.ops-pipeline article').first
        expect(card).to_contain_text('Synthetic Lead')
        call = card.get_by_role('link', name='Call', exact=True)
        expect(call).to_have_attribute('href', 'tel:+19705550111')
        expect(call).to_be_visible()  # the feed can render before the Hub shell is shown; measure once it is laid out
        self.assertGreaterEqual(call.evaluate('el=>el.getBoundingClientRect().height'), 44)
        expect(card.get_by_role('link', name='Open in HighLevel', exact=True)).to_have_attribute('href', 'https://app.gohighlevel.com/v2/location/location-synthetic/contacts/detail/contact-1')
        expect(page.locator('#ops-main a[href^="sms:"]')).to_have_count(0)
        expect(card).not_to_contain_text('$')
        self.assert_phone_fit(375, '#ops-main')
        page.screenshot(path=str(RESULTS / 'sales-booking-leads-375.png'), full_page=True)
        card.get_by_role('button', name='Book walkthrough', exact=True).click()
        dialog = self.dialog(); expect(dialog).to_have_attribute('aria-label', 'Create job')
        expect(dialog.get_by_role('combobox', name='Work type', exact=True)).to_have_value('walkthrough')
        expect(dialog).to_contain_text('The customer asked for Thu, Sep 24 afternoon. Confirm the exact time with them.')
        for label, value in [('Start date', '2026-09-24'), ('Start time', '13:00'), ('End time', '14:00'), ('Job address', '123 Synthetic Way, Fort Collins, CO'), ('Service', 'Garage Cleanout'),
                             ('Name', 'Synthetic Lead'), ('Mobile', '(970) 555-0111'), ('Email', 'synthetic.lead@example.invalid'), ('Address', '123 Synthetic Way, Fort Collins, CO')]:
            expect(dialog.get_by_label(label, exact=True)).to_have_value(value)
        expect(dialog.locator('.dp-linked-contact')).to_contain_text('Linked to HighLevel contact Synthetic Lead')
        expect(dialog.get_by_role('group', name='Assigned employees')).to_be_hidden()
        expect(dialog.get_by_role('combobox', name='Saved crew', exact=True)).to_be_hidden()
        expect(dialog).to_contain_text('A manager assigns the crew and vehicle in Dispatch.')
        self.assert_phone_fit(375, 'dialog.dp-dialog')
        page.screenshot(path=str(RESULTS / 'sales-booking-prefilled-375.png'), full_page=True)
        dialog.get_by_role('button', name='Save customer', exact=True).click()
        expect(dialog.locator('.dp-customer-results').first).to_contain_text('New customer saved and selected')
        self.assertEqual(len(self.resolves), 1)
        self.assertRegex(self.resolves[0]['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        self.assertEqual(self.resolves[0]['customer'], {'name': 'Synthetic Lead', 'phone': '(970) 555-0111', 'email': 'synthetic.lead@example.invalid', 'address': '123 Synthetic Way, Fort Collins, CO', 'highlevelContactId': 'contact-1'})
        dialog.get_by_role('button', name='Create job', exact=True).click()
        expect(self.dialog()).to_have_count(0)
        save = self.saves[-1]
        self.assertEqual([save['action'], save['kind'], save['customerId']], ['schedule.create', 'walkthrough', 'customer-new'])
        changes = save['changes']
        self.assertEqual([changes['date'], changes['time'], changes['endDate'], changes['endTime'], changes['address'], changes['serviceType']], ['2026-09-24', '13:00', '2026-09-24', '14:00', '123 Synthetic Way, Fort Collins, CO', 'Garage Cleanout'])
        self.assertEqual([changes['assignedCrew'], changes['crewId'], changes['crewLead'], changes['vehicleId']], [[], None, None, None], 'a booker saves no crew; a manager staffs the visit')
        self.assertFalse(any(call[1] == '/api/highlevel' and call[0] != 'GET' for call in self.calls), 'booking never writes to HighLevel from the Hub page')

    def test_book_for_a_window_that_started_today_in_denver_is_not_prefilled(self):
        # Noon in Denver (the installed 18:00Z) is 03:00 the next day on this Asia/Tokyo device: this afternoon has started.
        self.lead_slot = {'date': DAY, 'window': 'PM'}
        page = self.open('pipeline', width=375, height=812, profile=SALES)
        page.locator('.ops-pipeline article').first.get_by_role('button', name='Book walkthrough', exact=True).click()
        dialog = self.dialog(); expect(dialog).to_have_attribute('aria-label', 'Create job')
        expect(dialog).to_contain_text('The customer asked for Tue, Sep 22 afternoon, which has already started. Agree a time with them.')
        expect(dialog.get_by_label('Start time', exact=True)).not_to_have_value('13:00')
        self.assert_phone_fit(375, 'dialog.dp-dialog')

    def test_new_customer_from_the_dispatch_search_says_when_highlevel_search_is_down(self):
        page = self.open('schedule', width=375, height=812, profile=SALES)
        expect(page.locator('.dp-header-actions')).to_contain_text('Create job')
        for hidden in ('Block time', 'Crews & vehicles'): expect(page.get_by_role('button', name=hidden, exact=True)).to_have_count(0)
        expect(page.locator('.dp-job').first.get_by_role('button', name='Edit / reschedule', exact=True)).to_be_visible()
        page.get_by_role('button', name='Create job', exact=True).first.click()
        dialog = self.dialog()
        dialog.locator('input[name=customerSearch]').fill('Synthetic Newcomer')
        expect(dialog.locator('.dp-customer-results').first).to_contain_text('No matching Hub customer. Add them with New customer below.')
        dialog.get_by_role('button', name='New customer', exact=True).click()
        self.contacts_down = True
        dialog.get_by_label('Find in HighLevel (optional)', exact=True).fill('Synthetic Newcomer')
        expect(dialog.locator('.dp-new-customer-panel [role=alert]')).to_have_text('HighLevel search unavailable. Check HighLevel before creating a new contact.')
        self.contacts_down = False
        dialog.get_by_label('Find in HighLevel (optional)', exact=True).fill('Synthetic Found')
        dialog.get_by_role('button', name='Synthetic Found · (970) 555-0177', exact=True).click()
        expect(dialog.get_by_label('Mobile', exact=True)).to_have_value('(970) 555-0177')
        dialog.get_by_role('button', name='Remove HighLevel link', exact=True).click()
        for label, kind, mode in [('Mobile', 'tel', 'tel'), ('Email', 'email', 'email')]:
            field = dialog.get_by_label(label, exact=True)
            self.assertEqual([field.get_attribute('type'), field.get_attribute('inputmode')], [kind, mode])
            self.assertEqual(field.evaluate('el=>getComputedStyle(el).fontSize'), '16px')
        dialog.get_by_label('Name', exact=True).fill('Synthetic Newcomer')
        dialog.get_by_label('Mobile', exact=True).fill('')
        dialog.get_by_label('Email', exact=True).fill('')
        dialog.get_by_role('button', name='Save customer', exact=True).click()
        expect(dialog.locator('.dp-new-customer-panel')).to_contain_text('Add a mobile or email so this customer can be matched safely.')
        self.assertEqual(self.resolves, [])
        dialog.get_by_label('Mobile', exact=True).fill('9705550188')
        dialog.get_by_role('button', name='Save customer', exact=True).click()
        expect(dialog.locator('.dp-customer-results').first).to_contain_text('New customer saved and selected')
        self.assertEqual(self.resolves[0]['customer'], {'name': 'Synthetic Newcomer', 'phone': '9705550188', 'email': '', 'address': '7 Found Ct, Loveland, CO'})
        dialog.get_by_label('Service', exact=True).fill('Garage organization')
        dialog.get_by_role('button', name='Create job', exact=True).click()
        expect(self.dialog()).to_have_count(0)
        self.assertEqual([self.saves[-1]['kind'], self.saves[-1]['customerId']], ['job', 'customer-new'])
        self.assert_phone_fit(375, '#ops-main')

    def test_sales_walkthroughs_is_the_hub_screen_with_the_sync_state_but_no_retry_or_money_at_375(self):
        # WT-OUTCOME after SALES-BOOKING: Walkthroughs is now a Hub screen (business, and dispatch.write with staff roles). A
        # schedule.book holder still opens it and reads /api/dispatch as a booker: the HighLevel sync shows, and its Retry
        # (dispatch.write) does not. Reschedule opens the booker's form, without the crew controls.
        self.dispatch_extra = [WALK]
        page = self.open('walkthroughs', width=375, height=812, profile=SALES)
        self.assertIn('walkthroughs', self.nav_views())
        expect(page.get_by_role('heading', name='Walkthroughs', exact=True)).to_be_visible()
        card = page.locator('.wt-card').filter(has=page.get_by_role('heading', name='Synthetic Walkthrough Lead', exact=True))
        expect(card.locator('.wt-sync-state')).to_have_text('HighLevel sync failed')
        expect(page.get_by_role('button', name=re.compile('^Retry the HighLevel sync'))).to_have_count(0)
        expect(card.get_by_role('link', name='Call Synthetic Walkthrough Lead', exact=True)).to_have_attribute('href', 'tel:9705550122')
        expect(page.locator('.egc-walkthroughs .wt-notice.error')).to_have_count(0)
        expect(page.locator('#ops-main')).not_to_contain_text('$')
        self.assert_phone_fit(375, '#ops-main')
        page.screenshot(path=str(RESULTS / 'sales-booking-walkthroughs-375.png'), full_page=True)
        card.get_by_role('button', name='Reschedule Synthetic Walkthrough Lead', exact=True).click()
        dialog = self.dialog(); expect(dialog).to_have_attribute('aria-label', 'Edit / reschedule job')
        expect(dialog.get_by_role('group', name='Assigned employees')).to_be_hidden()
        expect(dialog).not_to_contain_text('$')
        self.assertFalse(any(call[1] == '/api/highlevel' and call[0] != 'GET' for call in self.calls))

    def test_action_center_deep_link_calls_and_books_a_schedule_job_action(self):
        page = self.open('action_center', width=375, height=812, profile=SALES)
        expect(page.locator('#ops-title')).to_have_text('Action center')
        page.locator('.ac-row').first.click()
        details = page.get_by_role('dialog', name='Action details')
        expect(details.get_by_role('link', name='Call Synthetic Johnson Garage', exact=True)).to_have_attribute('href', 'tel:+19705550100')
        expect(details.get_by_role('link', name='Call Synthetic Johnson Garage', exact=True)).to_be_visible()
        self.assertGreaterEqual(details.get_by_role('link', name='Call Synthetic Johnson Garage', exact=True).evaluate('el=>el.getBoundingClientRect().height'), 44)
        page.screenshot(path=str(RESULTS / 'sales-booking-action-375.png'), full_page=True)
        details.get_by_role('button', name='Book', exact=True).click()
        page.wait_for_function('new URLSearchParams(location.search).get("view")==="schedule"')
        dialog = self.dialog(); expect(dialog).to_have_attribute('aria-label', 'Create job')
        expect(dialog.get_by_role('combobox', name='Work type', exact=True)).to_have_value('job')
        expect(dialog.locator('input[name=customerSearch]')).to_have_value('Synthetic Johnson Garage')
        expect(dialog.locator('.dp-customer-results').first).to_contain_text('Customer selected')
        dialog.get_by_label('Service', exact=True).fill('Garage cleanout')
        dialog.get_by_role('button', name='Create job', exact=True).click()
        expect(self.dialog()).to_have_count(0)
        self.assertEqual([self.saves[-1]['kind'], self.saves[-1]['customerId'], self.saves[-1]['changes']['address']], ['job', 'customer-9', '123 Synthetic Way, Fort Collins, CO'])

    def test_highlevel_outage_and_not_configured_wording(self):
        self.highlevel = ({'ok': False, 'error': 'HighLevel is unreachable'}, 503)
        page = self.open('pipeline', width=375, height=812, profile=SALES)
        expect(page.locator('#ops-main')).to_contain_text('HighLevel unavailable, retrying')
        expect(page.locator('#ops-main')).to_contain_text('The lead feed could not be loaded at 12:00 PM. The Hub tries again every minute')
        expect(page.locator('#ops-main')).not_to_contain_text('private-integration token')
        self.highlevel = ({'ok': False, 'code': 'HIGHLEVEL_NOT_CONFIGURED', 'error': 'HighLevel needs an API key and location ID'}, 501)
        page.get_by_role('button', name='Retry now', exact=True).click()
        expect(page.locator('#ops-main')).to_contain_text('Add a HighLevel private-integration token and location ID')
        self.assert_phone_fit(375, '#ops-main')


# EGC_BOOKING_EXPLICIT_SLOTS=true: the root middleware (functions/_middleware.js) marks /book's time choices for
# booking-slots.js. This static server has no middleware, so the flag-on tests add the marker the edge would.
BOOK_SLOTS = '<fieldset class="booking-slots"'
STATIC_CHOICES = [['Today PM', 'Today afternoon'], ['Tomorrow AM', 'Tomorrow morning'], ['Tomorrow PM', 'Tomorrow afternoon'], ['This week', 'Later this week'], ['Flexible', 'Flexible']]
def mark_book_slots(route):
    response = route.fetch(); html = response.text()
    assert html.count(BOOK_SLOTS) == 1, 'book.html has one booking-slots fieldset'
    route.fulfill(response=response, body=html.replace(BOOK_SLOTS, BOOK_SLOTS + ' data-explicit-slots', 1))


class BookSlotsBrowserTests(HubShell, unittest.TestCase):
    """/book's walkthrough windows from the Denver clock, with the page in Asia/Tokyo to prove the device zone is ignored:
    rendered only when the server marks the choices (EGC_BOOKING_EXPLICIT_SLOTS on); unmarked, the static choices stay."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def choices(self, instant, marked=True):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, timezone_id='Asia/Tokyo', is_mobile=True, has_touch=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(7000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.clock.install(time=instant)
        self.page.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == '127.0.0.1' and not urlparse(route.request.url).path.startswith('/api/') else route.abort())
        if marked: self.page.route('**/book.html', mark_book_slots)
        self.page.goto(f'{self.url}/book.html')
        if marked: self.page.wait_for_function('document.querySelector("fieldset.booking-slots[data-slots-rendered]")')
        # Unmarked: once booking-slots.js has run (and site-forms.js has bound the form), the choices are final.
        else: self.page.wait_for_function('!!window.EGCBookingSlots && document.readyState === "complete"')
        return self.page.evaluate("[...document.querySelectorAll('fieldset.booking-slots .booking-slot')].map(label=>[label.querySelector('input').value,label.textContent.trim()])")

    def test_flag_off_the_static_choices_stay_and_post_as_before(self):
        # Tuesday 20:55 in Denver: without the marker even "Today afternoon" stays, exactly as /book offered it before.
        self.assertEqual(self.choices('2026-09-30T02:55:00Z', marked=False), STATIC_CHOICES)
        page = self.page
        self.assertFalse(page.evaluate('document.querySelector("fieldset.booking-slots").hasAttribute("data-slots-rendered")'))
        form = page.locator('form.multi-step-form').first
        form.locator('.form-panel[data-step="1"] [data-next]').click()
        form.locator('select[name="Job size"]').select_option('medium')
        form.locator('.form-panel[data-step="2"] [data-next]').click()
        form.locator('input[name="booking_slot_choice"][value="Tomorrow AM"]').check()
        # Coming back to the tab the next day, or from the back-forward cache, changes nothing either.
        page.clock.set_system_time('2026-10-01T15:00:00Z')
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        shown = "[...document.querySelectorAll('fieldset.booking-slots .booking-slot')].map(label=>[label.querySelector('input').value,label.textContent.trim(),label.querySelector('input').checked])"
        self.assertEqual(page.evaluate(shown), [[value, text, value == 'Tomorrow AM'] for value, text in STATIC_CHOICES])
        form.locator('.form-panel[data-step="3"] [data-next]').click()
        expect(form.locator('.form-panel[data-step="4"]')).to_have_class(re.compile(r'\bactive\b'))
        self.assertEqual(form.locator('input[name="booking_slot"]').input_value(), 'Tomorrow AM')
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)

    def test_windows_at_2055_on_a_sunday_and_on_the_fall_back_day(self):
        self.assertEqual(self.choices('2026-09-30T02:55:00Z'), [['2026-09-30 AM', 'Tomorrow morning'], ['2026-09-30 PM', 'Tomorrow afternoon'], ['2026-10-01 AM', 'Thu, Oct 1 morning'], ['2026-10-01 PM', 'Thu, Oct 1 afternoon'], ['Flexible', 'Flexible']])
        self.page.screenshot(path=str(RESULTS / 'book-slots-2055-375.png'), full_page=False)
        self.close_page()
        self.assertEqual([value for value, _ in self.choices('2026-09-27T16:00:00Z')], ['2026-09-28 AM', '2026-09-28 PM', '2026-09-29 AM', '2026-09-29 PM', 'Flexible'])
        self.close_page()
        self.assertEqual(self.choices('2026-11-01T08:30:00Z')[:2], [['2026-11-02 AM', 'Tomorrow morning'], ['2026-11-02 PM', 'Tomorrow afternoon']])

    def test_the_chosen_window_reaches_the_form_as_an_explicit_date(self):
        self.choices('2026-09-30T02:55:00Z')
        page = self.page
        form = page.locator('form.multi-step-form').first
        form.locator('.form-panel[data-step="1"] [data-next]').click()
        form.locator('select[name="Job size"]').select_option('medium')
        form.locator('.form-panel[data-step="2"] [data-next]').click()
        form.locator('input[name="booking_slot_choice"][value="2026-09-30 AM"]').check()
        form.locator('.form-panel[data-step="3"] [data-next]').click()
        expect(form.locator('.form-panel[data-step="4"]')).to_have_class(re.compile(r'\bactive\b'))
        self.assertEqual(form.locator('input[name="booking_slot"]').input_value(), '2026-09-30 AM')
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)

    def test_a_tab_shown_again_later_offers_the_current_windows_and_the_form_still_records_the_choice(self):
        self.choices('2026-09-30T02:55:00Z')
        page = self.page
        form = page.locator('form.multi-step-form').first
        form.locator('.form-panel[data-step="1"] [data-next]').click()
        form.locator('select[name="Job size"]').select_option('medium')
        form.locator('.form-panel[data-step="2"] [data-next]').click()
        form.locator('input[name="booking_slot_choice"][value="2026-09-30 AM"]').check()
        shown = "[...document.querySelectorAll('fieldset.booking-slots .booking-slot')].map(label=>[label.querySelector('input').value,label.textContent.trim(),label.querySelector('input').checked])"
        # Wednesday 09:00 in Denver: the chosen morning has started. Coming back to the tab offers the current windows.
        page.clock.set_system_time('2026-09-30T15:00:00Z')
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        self.assertEqual(page.evaluate(shown), [['2026-09-30 PM', 'Today afternoon', False], ['2026-10-01 AM', 'Tomorrow morning', False], ['2026-10-01 PM', 'Tomorrow afternoon', False], ['2026-10-02 AM', 'Fri, Oct 2 morning', False], ['Flexible', 'Flexible', False]])
        form.locator('.form-panel[data-step="3"] [data-next]').click()
        expect(form.locator('.form-panel[data-step="3"] .form-error')).to_have_text('Please choose a preferred walkthrough window.')
        form.locator('input[name="booking_slot_choice"][value="2026-10-01 AM"]').check()
        # A page restored from the back-forward cache later that day keeps a choice that is still offered.
        page.clock.set_system_time('2026-09-30T19:00:00Z')
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        self.assertEqual(page.evaluate(shown)[:2], [['2026-10-01 AM', 'Tomorrow morning', True], ['2026-10-01 PM', 'Tomorrow afternoon', False]])
        form.locator('.form-panel[data-step="3"] [data-next]').click()
        expect(form.locator('.form-panel[data-step="4"]')).to_have_class(re.compile(r'\bactive\b'))
        self.assertEqual(form.locator('input[name="booking_slot"]').input_value(), '2026-10-01 AM')
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 375)


if __name__ == '__main__':
    unittest.main()
