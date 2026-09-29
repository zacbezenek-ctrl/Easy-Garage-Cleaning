"""Staff directory (TEAM-UI) on a phone: the EGCStaff module mounted standalone with a routed /api/staff-directory.
Role chips, skills, dated pay and the weekly availability editor fit 320-390px without horizontal scroll, keep 44px
tap targets and 16px inputs, use decimal keyboards for rates, and saves carry one requestId that a retry reuses."""
import copy, json, os, pathlib, re, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from hub_shell_harness import HubShell, MANAGER

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'test-results'
NOW = datetime(2026, 9, 22, 5, 30, tzinfo=timezone.utc)  # 11:30 PM Sept 21 in Denver, 2:30 PM Sept 22 in Tokyo
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
ALL_CAPS = ['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage', 'catalog.manage', 'settings.manage']
SKILLS = [['cleanout', 'Garage cleanout'], ['deep_clean', 'Deep clean'], ['pressure_wash', 'Pressure washing'], ['mouse_trapping', 'Mouse trapping'], ['shelving', 'Shelving install'],
          ['overhead_storage', 'Overhead storage install'], ['heavy_lifting', 'Heavy lifting'], ['truck_driving', 'Truck driving'], ['trailer_towing', 'Trailer towing'],
          ['dump_runs', 'Dump and donation runs'], ['walkthrough_estimating', 'Walkthrough estimating'], ['customer_phone', 'Customer phone follow-up'], ['crew_leadership', 'Crew leadership'], ['first_aid', 'First aid']]


def rate(effective, amount):
    return {'effectiveFrom': effective, 'hourlyRate': amount, 'payType': 'hourly', 'overtimeMultiplier': 1.5, 'setBy': 'zacb', 'setAt': '2026-09-01T15:00:00.000Z'}


def person(username, display, revision='rev-1', **extra):
    row = {'username': username, 'displayName': display, 'source': 'employee_account', 'accountStatus': 'approved', 'staffRoles': ['crew', 'phone'], 'staffRolesSource': 'account', 'primaryRole': 'phone',
           'skills': [{'id': 'customer_phone', 'level': 'lead', 'verifiedBy': 'zacb', 'verifiedAt': '2026-09-10T16:00:00.000Z'}, {'id': 'walkthrough_estimating', 'level': 'trainee', 'verifiedBy': 'zacb', 'verifiedAt': '2026-09-10T16:00:00.000Z'}],
           'weeklyAvailability': {'mon': [{'start': '08:00', 'end': '12:00'}, {'start': '13:00', 'end': '17:30'}], 'tue': [], 'wed': [{'start': '18:00', 'end': '24:00'}], 'thu': [], 'fri': [{'start': '09:00', 'end': '15:00'}], 'sat': [], 'sun': []},
           'weeklyAvailabilityNeedsReview': False,
           'pay': {'current': {'hourlyRate': 21, 'payType': 'hourly', 'overtimeMultiplier': 1.5, 'effectiveFrom': '2026-09-01', 'source': 'pay_rates', 'drift': False}, 'upcoming': [rate('2026-10-01', 23.5)],
                   'schedule': [rate('2000-01-01', 20), rate('2026-09-01', 21), rate('2026-10-01', 23.5)], 'needsReview': False},
           'history': [{'action': 'set_roles', 'scope': 'roles', 'actor': 'ZacB', 'at': '2026-09-20T16:00:00.000Z', 'reason': 'Synthetic phone coverage for a very long reason that needs to wrap on a narrow phone screen', 'changes': {'before': {'staffRoles': ['crew']}, 'after': {'staffRoles': ['crew', 'phone']}}}],
           'revision': revision, 'profileNeedsReview': False}
    row.update(extra)
    return row


def directory(people):
    return {'ok': True, 'authority': 'employee_hub', 'timeZone': 'America/Denver', 'today': '2026-09-21', 'viewer': {'user': 'ZacB', 'capabilities': ALL_CAPS},
            'catalog': {'version': '2026-09-staff-skills-v1', 'skills': [{'id': i, 'label': l} for i, l in SKILLS], 'levels': ['trainee', 'proficient', 'lead'], 'roles': ['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone'], 'days': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']},
            'people': people, 'coverage': {'complete': True, 'asOf': '2026-09-22T05:30:00.000Z'}}


PAGE = b'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-staff.css"></head>
<body style="margin:0;padding:12px;background:#f1f0ec"><main id="host"></main><script src="/employee-staff.js"></script>
<script>EGCStaff.mount(document.querySelector('#host'),{identity:'ZacB',capabilities:['crew','business','owner'],screen:'staff',toast(){}})</script></body></html>'''


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/hub-staff':
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE)
        else: super().do_GET()


class StaffDirectoryBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RESULTS.mkdir(exist_ok=True)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start(); cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start(); options = {'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox'], **options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo')
        self.page = self.context.new_page(); self.page.set_default_timeout(6000); self.page.clock.install(time=NOW)
        self.errors = []; self.posts = []; self.gets = 0; self.get_status = 200; self.post_answers = []; self.former = []
        self.people = [person('Zoe.Phone', 'Synthetic Zoe Phone-Followup-With-A-Long-Name'), person('Crew.Two', 'Synthetic Crew Two', staffRoles=['crew'], primaryRole='crew', skills=[], weeklyAvailability=None)]
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/staff-directory': route.continue_(); return
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if request.method == 'GET':
            self.gets += 1
            if self.get_status != 200: send({'ok': False, 'code': 'staff_directory_unavailable', 'error': 'The staff directory could not be verified. Keep your request and retry the same change.'}, self.get_status); return
            send({**directory(copy.deepcopy(self.people)), **({'formerStaff': copy.deepcopy(self.former)} if self.former else {})}); return
        body = request.post_data_json; self.posts.append(body)
        if self.post_answers:
            answer = self.post_answers.pop(0)
            if answer == 'abort': route.abort(); return
        rows = self.people if any(row['username'] == body['username'] for row in self.people) else self.former
        index = next(i for i, row in enumerate(rows) if row['username'] == body['username'])
        updated = copy.deepcopy(rows[index]); updated['revision'] = 'rev-' + str(len(self.posts) + 1)
        if body['action'] == 'set_pay': updated['pay']['schedule'].append(rate(body['effectiveFrom'], body['hourlyRate'])); updated['pay']['schedule'].sort(key=lambda row: row['effectiveFrom'])
        if body['action'] == 'set_roles': updated['staffRoles'] = body['staffRoles']
        if body['action'] == 'set_availability': updated['weeklyAvailability'] = body['weeklyAvailability']
        if body['action'] == 'set_gusto_id': updated['gustoEmployeeId'] = body['gustoEmployeeId'] or None; updated['gustoExcluded'] = body.get('gustoExcluded', updated.get('gustoExcluded', False))
        rows[index] = updated
        send({'ok': True, 'authority': 'employee_hub', 'person': updated, **({'sessionsRevoked': True} if body['action'] == 'set_roles' else {})})

    def open(self):
        self.page.goto(self.url + '/hub-staff')
        expect(self.page.locator('article.st-person').first).to_be_visible()
        return self.page

    def assert_mobile(self, label):
        problems = []
        for width in (320, 375, 390):
            self.page.set_viewport_size({'width': width, 'height': 812})
            scroll = self.page.evaluate('''()=>{const html=document.documentElement,body=document.body,before=[html.style.overflowX,body.style.overflowX];html.style.overflowX='visible';body.style.overflowX='visible';
              const width=html.scrollWidth,wide=[...document.querySelectorAll('.egc-staff *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,4).map(el=>el.tagName+'.'+el.className);
              [html.style.overflowX,body.style.overflowX]=before;return{width,wide};}''')
            if scroll['width'] > width: problems.append(f'{label} {width}: scrolls sideways to {scroll["width"]} {scroll["wide"]}')
            small = self.page.evaluate('''()=>{const seen=new Set(),out=[];for(const el of document.querySelectorAll('.egc-staff :is(button,summary,select,input[type=checkbox])')){
              const target=el.matches('input')?(el.closest('label')||el):el;if(seen.has(target))continue;seen.add(target);const r=target.getBoundingClientRect();
              if(r.width>0&&r.height>0&&r.height<43.5)out.push(target.tagName+' '+(target.textContent||target.getAttribute('aria-label')||'').trim().slice(0,30)+' '+Math.round(r.height));}return out;}''')
            problems += [f'{label} {width}: small target {item}' for item in small]
            tiny = self.page.evaluate('''()=>[...document.querySelectorAll('.egc-staff :is(input:not([type=checkbox]),select,textarea)')].filter(el=>el.getBoundingClientRect().height>0&&parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.name)''')
            problems += [f'{label} {width}: input under 16px {name}' for name in tiny]
        self.page.set_viewport_size({'width': 375, 'height': 812})
        self.assertEqual(problems, [])

    def test_directory_and_every_editor_fit_phone_widths(self):
        page = self.open()
        zoe = page.locator('article.st-person', has=page.get_by_text('@Zoe.Phone'))
        expect(zoe.locator('.st-chip')).to_have_text(['Crew', 'Phone · calls and follow-ups', 'Customer phone follow-up · Lead', 'Walkthrough estimating · Trainee'])
        expect(zoe.locator('.st-pay-row .st-tag')).to_have_text(['Scheduled', 'Current', 'Earlier'])
        expect(zoe.locator('.st-week dd').first).to_have_text('8:00 AM–12:00 PM, 1:00 PM–5:30 PM')
        zoe.locator('summary').click()
        self.assert_mobile('list')
        page.screenshot(path=str(RESULTS / 'staff-directory-375.png'), full_page=True)
        for kind, label in (('roles', 'Edit roles'), ('skills', 'Edit skills'), ('pay', 'Change pay'), ('availability', 'Edit availability')):
            zoe.get_by_role('button', name=label + ' for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
            expect(zoe.locator('form.st-editor')).to_be_visible()
            if kind == 'availability':
                zoe.get_by_role('button', name='Add hours on Monday').click(); zoe.get_by_role('button', name='Add hours on Sunday').click()
            self.assert_mobile(kind)
            page.screenshot(path=str(RESULTS / f'staff-editor-{kind}-375.png'), full_page=True)
            # The primary action stays within thumb reach: the sticky footer is on screen while the form is in view.
            zoe.locator('form.st-editor h4').scroll_into_view_if_needed()
            save = zoe.locator('form.st-editor footer button[type=submit]')
            box = save.bounding_box()
            self.assertLessEqual(box['y'] + box['height'], 812, f'{kind}: save is reachable without scrolling to the end of the form')
            zoe.locator('form.st-editor footer').get_by_role('button', name='Cancel').click()
            self.assertEqual(page.evaluate("document.activeElement.getAttribute('aria-label')"), label + ' for Synthetic Zoe Phone-Followup-With-A-Long-Name', f'{kind}: focus returns to the opener')
        zoe.get_by_role('button', name='Change pay for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
        rate_input = zoe.locator('input[name=hourlyRate]')
        self.assertEqual([rate_input.get_attribute('type'), rate_input.get_attribute('inputmode')], ['number', 'decimal'])
        self.assertEqual(zoe.locator('input[name=overtimeMultiplier]').get_attribute('inputmode'), 'decimal')
        self.assertEqual(zoe.locator('input[name=effectiveFrom]').input_value(), '2026-09-21', 'the default date is the Denver day the server reported, not the Tokyo device day')
        expect(zoe.locator('form.st-editor')).to_contain_text('Today in Denver is Sep 21, 2026')

    def test_owner_schedules_a_raise_and_sets_roles_with_request_ids(self):
        page = self.open()
        zoe = page.locator('article.st-person', has=page.get_by_text('@Zoe.Phone'))
        zoe.get_by_role('button', name='Change pay for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
        zoe.locator('input[name=effectiveFrom]').fill('2026-11-01')
        zoe.locator('input[name=hourlyRate]').fill('24.25')
        zoe.locator('textarea[name=reason]').fill('Synthetic raise')
        zoe.get_by_role('button', name='Save pay change').click()
        expect(page.locator('.st-notice.success')).to_contain_text('Saved: Pay for Synthetic Zoe')
        body = self.posts[-1]
        self.assertRegex(body['requestId'], UUID)
        self.assertEqual({k: v for k, v in body.items() if k != 'requestId'}, {'action': 'set_pay', 'username': 'Zoe.Phone', 'expectedRevision': 'rev-1', 'expectedUser': 'zacb', 'effectiveFrom': '2026-11-01', 'hourlyRate': 24.25, 'payType': 'hourly', 'overtimeMultiplier': 1.5, 'reason': 'Synthetic raise'})
        expect(zoe.locator('.st-pay-row').first).to_contain_text('Nov 1, 2026')
        zoe.get_by_role('button', name='Edit roles for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
        zoe.locator('label.st-check', has_text='Crew lead').click()
        zoe.get_by_role('button', name='Save roles').click()
        expect(page.locator('.st-notice.success')).to_contain_text('signed out so the new roles apply')
        self.assertEqual(self.posts[-1]['staffRoles'], ['crew_lead', 'crew', 'phone'])
        self.assertEqual(self.posts[-1]['expectedRevision'], 'rev-2', 'the second save uses the revision the first returned')
        expect(zoe.locator('.st-chip').first).to_have_text('Crew lead')

    def test_owner_sets_a_gusto_employee_id_on_a_phone(self):
        # GUSTO-EXPORT: the server sends gustoEmployeeId (a string or null) to the owner only.
        self.people[0]['gustoEmployeeId'] = None; self.people[1]['gustoEmployeeId'] = 'gusto-syn-2'
        page = self.open()
        zoe = page.locator('article.st-person', has=page.get_by_text('@Zoe.Phone'))
        expect(zoe.locator('section[aria-label="Gusto employee ID"]')).to_contain_text('Not set. The payroll week’s Gusto hours file names this employee')
        expect(page.locator('article.st-person', has=page.get_by_text('@Crew.Two')).locator('.st-gusto-id')).to_have_text('gusto-syn-2')
        zoe.get_by_role('button', name='Set Gusto ID for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
        field = zoe.locator('input[name=gustoEmployeeId]')
        self.assertEqual([field.get_attribute('type'), field.get_attribute('inputmode'), field.get_attribute('autocomplete'), field.get_attribute('maxlength')], ['text', 'text', 'off', '64'])
        self.assert_mobile('gusto')
        page.screenshot(path=str(RESULTS / 'staff-editor-gusto-375.png'), full_page=True)
        field.fill('gusto-syn-1')
        zoe.get_by_role('button', name='Save Gusto ID').click()
        expect(page.locator('.st-notice.success')).to_contain_text('Saved: Gusto employee ID for Synthetic Zoe')
        body = self.posts[-1]
        self.assertRegex(body['requestId'], UUID)
        self.assertEqual({k: v for k, v in body.items() if k != 'requestId'}, {'action': 'set_gusto_id', 'username': 'Zoe.Phone', 'expectedRevision': 'rev-1', 'expectedUser': 'zacb', 'gustoEmployeeId': 'gusto-syn-1', 'gustoExcluded': False})
        expect(zoe.locator('.st-gusto-id')).to_have_text('gusto-syn-1')

    def test_owner_marks_not_paid_through_gusto_and_sets_a_former_employee_id_on_a_phone(self):
        # GUSTO-EXPORT review: someone not paid through Gusto is marked, not given a made-up ID; former staff (a rejected
        # account with hours still to pay) are listed for the owner with the Gusto editor only.
        self.people[0]['gustoEmployeeId'] = None; self.people[0]['gustoExcluded'] = False; self.people[1]['gustoEmployeeId'] = 'gusto-syn-2'; self.people[1]['gustoExcluded'] = False
        self.former = [{'username': 'Gone.Crew', 'displayName': 'Synthetic Gone Crew With A Long Former Name', 'source': 'former', 'accountStatus': 'rejected', 'gustoEmployeeId': None, 'gustoExcluded': False,
                        'history': [], 'revision': 'rev-gone', 'profileNeedsReview': False}]
        page = self.open()
        zoe = page.locator('article.st-person', has=page.get_by_text('@Zoe.Phone'))
        zoe.get_by_role('button', name='Set Gusto ID for Synthetic Zoe Phone-Followup-With-A-Long-Name').click()
        box = zoe.locator('input[name=gustoExcluded]')
        self.assertEqual(box.get_attribute('type'), 'checkbox')
        self.assert_mobile('gusto marker')
        zoe.get_by_text('Not paid through Gusto (the owner, a 1099 worker)').click()
        expect(box).to_be_checked()
        zoe.get_by_role('button', name='Save Gusto ID').click()
        expect(page.locator('.st-notice.success')).to_contain_text('Saved: Gusto employee ID for Synthetic Zoe')
        self.assertEqual([self.posts[-1]['gustoEmployeeId'], self.posts[-1]['gustoExcluded']], ['', True])
        expect(zoe.locator('.st-gusto-excluded')).to_contain_text('Not paid through Gusto: left out of the Gusto hours file')
        former = page.locator('details.st-former')
        expect(former.locator('summary')).to_have_text('Former staff (1) · Gusto IDs only')
        expect(former.locator('article')).to_be_hidden()
        former.locator('summary').click()
        gone = former.locator('article.st-former-person')
        expect(gone).to_contain_text('@Gone.Crew · Account not approved')
        expect(gone.get_by_role('button')).to_have_text(['Set Gusto ID'])
        gone.get_by_role('button', name='Set Gusto ID for Synthetic Gone Crew With A Long Former Name').click()
        self.assert_mobile('former')
        page.screenshot(path=str(RESULTS / 'staff-former-gusto-375.png'), full_page=True)
        gone.locator('input[name=gustoEmployeeId]').fill('gusto-syn-gone')
        gone.get_by_role('button', name='Save Gusto ID').click()
        expect(page.locator('.st-notice.success')).to_contain_text('Saved: Gusto employee ID for Synthetic Gone Crew')
        self.assertEqual({k: v for k, v in self.posts[-1].items() if k != 'requestId'}, {'action': 'set_gusto_id', 'username': 'Gone.Crew', 'expectedRevision': 'rev-gone', 'expectedUser': 'zacb', 'gustoEmployeeId': 'gusto-syn-gone', 'gustoExcluded': False})
        expect(page.locator('details.st-former article .st-gusto-id')).to_have_text('gusto-syn-gone')
        expect(page.locator('details.st-former')).to_have_attribute('open', '')

    def test_failed_load_is_unavailable_with_retry_not_an_empty_team(self):
        self.get_status = 503
        self.page.goto(self.url + '/hub-staff')
        alert = self.page.get_by_role('alert')
        expect(alert).to_contain_text('Staff directory unavailable')
        expect(self.page.locator('article.st-person')).to_have_count(0)
        self.assert_mobile('unavailable')
        self.get_status = 200
        alert.get_by_role('button', name='Retry').click()
        expect(self.page.locator('article.st-person')).to_have_count(2)

    def test_a_dropped_save_is_retried_with_the_same_request(self):
        page = self.open()
        crew = page.locator('article.st-person', has=page.get_by_text('@Crew.Two'))
        crew.get_by_role('button', name='Edit availability for Synthetic Crew Two').click()
        crew.get_by_role('button', name='Add hours on Tuesday').click()
        crew.locator('input[name=tue_end_0]').fill('00:00')
        self.post_answers = ['abort']
        crew.get_by_role('button', name='Save availability').click()
        banner = page.locator('.st-notice.warning')
        expect(banner).to_contain_text('Unconfirmed change: Weekly availability for Synthetic Crew Two')
        self.assert_mobile('pending')
        page.reload()
        expect(page.locator('.st-notice.warning')).to_contain_text('Unconfirmed change', timeout=6000)
        page.get_by_role('button', name='Retry original save').click()
        expect(page.locator('.st-notice.success')).to_contain_text('Saved: Weekly availability for Synthetic Crew Two')
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self.posts[0], self.posts[1], 'the retry after a reload is the original request')
        self.assertEqual(self.posts[1]['weeklyAvailability']['tue'], [{'start': '08:00', 'end': '24:00'}])
        expect(page.locator('article.st-person', has=page.get_by_text('@Crew.Two')).locator('.st-week dd').nth(1)).to_have_text('8:00 AM–midnight')



class StaffDirectoryShellTests(HubShell, unittest.TestCase):
    """The real employee.html: the Team page section and the registered Staff directory screen."""
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def staff_calls(self):
        return [call for call in self.calls if call[1] == '/api/staff-directory']

    def test_team_page_and_registered_screen_show_the_directory_on_a_phone(self):
        page = self.open('people', width=375, height=812)
        section = page.locator('#ops-staff-directory .egc-staff')
        expect(section.locator('article.st-person')).to_have_count(1)
        expect(section.locator('h2.st-title')).to_have_text('Roles, skills, pay and availability')
        expect(section.locator('.st-chip').first).to_have_text('Crew')
        for width in (320, 375, 390):
            page.set_viewport_size({'width': width, 'height': 812})
            scroll = self.no_horizontal_scroll()
            self.assertLessEqual(scroll['width'], width, scroll)
            self.assertEqual(self.small_targets('#ops-staff-directory'), [])
        page.set_viewport_size({'width': 375, 'height': 812})
        section.screenshot(path=str(RESULTS / 'staff-team-page-375.png'))
        self.assertEqual(len(self.staff_calls()), 1)
        page.evaluate('refresh()')
        page.wait_for_timeout(200)
        expect(section.locator('article.st-person')).to_have_count(1)
        self.assertEqual(len(self.staff_calls()), 1, 'background renders reuse the loaded directory')
        self.go('staff')
        expect(page.locator('#ops-title')).to_have_text('Staff directory')
        expect(page.locator('#ops-main h1.st-title')).to_have_text('Staff directory')
        expect(page.locator('#ops-main article.st-person')).to_have_count(1)
        assets = page.evaluate("[...document.querySelectorAll('[data-egc-hub-asset]')].map(node=>node.getAttribute('src')||node.getAttribute('href')).filter(url=>/staff/.test(url)).sort()")
        # Bumped deliberately (GUSTO-EXPORT): the directory gained the owner's Gusto employee ID editor; (AUTH-ROLES on
        # GUSTO-EXPORT) one new tag for the sign-out outcome and the Gusto editor together.
        self.assertEqual(assets, ['employee-staff.css?v=20260929rolesgusto', 'employee-staff.js?v=20260929rolesgusto'])
        self.assertEqual(page.evaluate('document.querySelectorAll(".egc-staff").length'), 1)
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)

    def test_staff_role_permissions_narrow_the_business_views(self):
        profile = {**MANAGER, 'capabilities': ['customer.send', 'followups.own'], 'capabilityMode': 'staff_roles'}
        page = self.open('my_day', width=390, profile=profile)
        views = self.nav_views()
        for hidden in ('people', 'staff', 'schedule', 'timesheets', 'finance'):
            self.assertNotIn(hidden, views)
        self.assertEqual(self.staff_calls(), [])
        self.close_page()
        page = self.open('people', width=390, profile={**MANAGER, 'capabilities': ['time.approve'], 'capabilityMode': 'staff_roles'})
        views = self.nav_views()
        self.assertIn('people', views); self.assertIn('staff', views); self.assertNotIn('schedule', views)
        expect(page.locator('#ops-staff-directory article.st-person')).to_have_count(1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
