"""STAFF-ACCESS in the real employee.html at phone width (390px, Asia/Tokyo device clock, fixed page clock): the Team card's
Reset sign-in shows a one-time link to copy (nothing is sent), the approval dialog asks the owner for a role and a
starting rate and a granted manager for the role only, My EGC -> Password changes the signed-in password, and the
owner's Apply rate to open weeks leaves exported weeks alone. With the flag off (no STAFF-ACCESS capabilities) none of
it appears. Every API is routed to synthetic fixtures; no other host is reached."""
import copy, json, re, unittest
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, CREW, RESULTS, STAFF, DAY

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
OWNER_CAPS = ['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage', 'catalog.manage', 'settings.manage']
OWNER_ON = {**MANAGER, 'owner': True, 'capabilities': OWNER_CAPS + ['accounts.reset', 'password.change'], 'capabilityMode': 'legacy'}
OWNER_OFF = {**MANAGER, 'owner': True, 'capabilities': OWNER_CAPS, 'capabilityMode': 'legacy'}
MANAGER_GRANTED = {'ok': True, 'user': 'TylerG', 'displayName': 'Synthetic Manager', 'role': 'manager', 'businessAccess': True, 'payType': 'hourly', 'hourlyRate': 30, 'owner': False,
                   'capabilities': ['dispatch.write', 'time.approve', 'accounts.approve', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage'], 'capabilityMode': 'legacy'}
CREW_ON = {**CREW, 'source': 'employee-account', 'capabilities': ['password.change'], 'capabilityMode': 'legacy'}
PENDING = {'username': 'New.Hire', 'displayName': 'Synthetic New Hire With A Long Name', 'email': 'new.hire@example.invalid', 'phone': '9705550143', 'status': 'pending', 'role': 'crew', 'appliedAt': '2026-09-21T15:00:00Z'}
LINK = 'https://easygaragecleaning.com/staff-setup#invite=reset-c3ludGhldGljLmNyZXc.' + 'A' * 43
WEEKS = [{'weekStart': '2026-09-14', 'weekEnd': '2026-09-20', 'exported': True, 'exportedAt': '2026-09-21T15:00:00.000Z', 'timecards': 1, 'hours': 5, 'rates': [22.5], 'pay': 112.5},
         {'weekStart': '2026-09-21', 'weekEnd': '2026-09-27', 'exported': False, 'timecards': 2, 'hours': 7, 'rates': [22.5], 'pay': 157.5}]


class StaffAccessBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.posts = []; self.staff = copy.deepcopy(STAFF); self.review_options = {'setsPay': True, 'roles': ['manager', 'crew_lead', 'crew', 'sales', 'phone'], 'resets': True}
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        def send(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/employee-hub' and request.method == 'GET':
            self.calls.append((request.method, parsed.path, parsed.query))
            from hub_shell_harness import collections
            data = collections(self.profile)
            data['profiles'][1]['accountStatus'] = 'approved'
            send({'ok': True, 'collections': data, **({'accounts': [copy.deepcopy(PENDING), {'username': 'Synthetic.Crew', 'status': 'approved'}]} if parse_qs(parsed.query).get('include') == ['accounts'] else {})}); return
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/employee-accounts':
            self.calls.append((request.method, parsed.path, parsed.query))
            if request.method == 'GET': send({'ok': True, 'accounts': [copy.deepcopy(PENDING)], 'staffAccess': self.review_options}); return
            body = request.post_data_json; self.posts.append(body)
            if body.get('action') == 'reset_signin':
                send({'ok': True, 'authority': 'employee_hub', 'username': body['username'], 'displayName': 'Synthetic Crew', 'link': LINK, 'expiresAt': '2026-09-23T18:00:00.000Z',
                      'linkShown': True, 'sent': False, 'sessionsRevoked': True, 'firebaseRevocation': {'status': 'revocation_pending', 'message': 'pending'}}); return
            if body.get('action') == 'review':
                send({'ok': True, 'authority': 'employee_hub', 'account': {**PENDING, 'status': body['decision'], 'staffRoles': body.get('staffRoles')}, 'firebaseRevocation': {'status': 'revoked'},
                      'payPending': 'hourlyRate' not in body, 'startingRateSet': 'hourlyRate' in body}); return
            if body.get('action') == 'change_password':
                if body.get('currentPassword') != 'Synthetic-Current-1':
                    send({'ok': False, 'code': 'staff_access_password_incorrect', 'error': 'Your current password is not correct. Nothing was changed.'}, 400); return
                send({'ok': True, 'authority': 'employee_hub', 'passwordChanged': True, 'otherSessionsEnded': True, 'firebaseRevocation': {'status': 'revoked'}}); return
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/staff-directory' and request.method == 'POST':
            self.calls.append((request.method, parsed.path, parsed.query))
            body = request.post_data_json; self.posts.append(body)
            if body.get('action') == 'preview_apply_rate':
                send({'ok': True, 'authority': 'employee_hub', 'username': body['username'], 'displayName': 'Synthetic Crew', 'expectedRevision': 'rev-staff-1', 'planDigest': 'a' * 64,
                      'weeks': copy.deepcopy(WEEKS), 'skipped': {'beforeRate': 1, 'notHourly': 0, 'unreadable': 0}, 'limit': 150, 'asOf': DAY + 'T18:00:00.000Z'}); return
            if body.get('action') == 'apply_rate':
                send({'ok': True, 'authority': 'employee_hub', 'username': body['username'], 'applied': {'weeks': body['weeks'], 'timecards': 2}}); return
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/staff-directory' and request.method == 'GET':
            self.calls.append((request.method, parsed.path, parsed.query)); send(copy.deepcopy(self.staff)); return
        HubShell.route(self, route)

    def dialog(self):
        return self.page.locator('dialog.sa-dialog')

    def settle_team(self):
        # The Team page saves the owner's own profile once and reloads the employee records: wait for that reload so a
        # background render does not replace the card being clicked.
        for _ in range(100):
            posted = [i for i, call in enumerate(self.calls) if call[:2] == ('POST', '/api/employee-hub')]
            if posted and any(call[:2] == ('GET', '/api/employee-hub') for call in self.calls[posted[0]:]): break
            self.page.wait_for_timeout(50)
        self.page.wait_for_timeout(150)

    def assert_phone_layout(self, scope):
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 390, scroll)
        self.assertEqual(self.small_inputs(scope), [])
        self.assertEqual(self.small_targets(scope), [])
        box = self.page.locator(scope).first.bounding_box()
        self.assertGreaterEqual(box['x'], 0); self.assertLessEqual(box['x'] + box['width'], 390)

    def test_reset_sign_in_shows_a_link_to_copy_and_sends_nothing(self):
        page = self.open('people', profile=OWNER_ON)
        self.settle_team()
        button = page.locator('[data-staff-reset="Synthetic.Crew"]')
        expect(button).to_have_text('Reset sign-in')
        expect(page.locator('[data-staff-reset="ZacB"]')).to_have_count(0)
        self.assertGreaterEqual(button.evaluate('el=>el.getBoundingClientRect().height'), 44)
        button.click()
        dialog = self.dialog()
        expect(dialog.locator('h2')).to_have_text('Reset sign-in for Synthetic Crew?')
        expect(dialog).to_contain_text('The Hub sends nothing.')
        self.assert_phone_layout('dialog.sa-dialog')
        page.screenshot(path=str(RESULTS / 'staff-access-reset-confirm-390.png'))
        dialog.locator('textarea[name=reason]').fill('Synthetic forgotten password')
        before = len(self.calls)
        dialog.get_by_role('button', name='Reset sign-in').click()
        expect(dialog.locator('input.sa-link')).to_have_value(LINK)
        expect(dialog).to_contain_text('The Hub has not sent it.')
        expect(dialog).to_contain_text('Ending their Firebase data sessions is pending')
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'username', 'reason', 'expectedUser')}, {'action': 'reset_signin', 'username': 'Synthetic.Crew', 'reason': 'Synthetic forgotten password', 'expectedUser': 'ZacB'})
        self.assertRegex(body['requestId'], UUID)
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(key=>key.startsWith('egc.hub.pending.v1.staffaccess.'))"), [], 'a confirmed reset is not kept')
        # The reset is the only write: nothing is sent to the employee (other hosts are aborted by the harness anyway).
        self.assertEqual([call for call in self.calls[before:] if call[0] != 'GET'], [('POST', '/api/employee-accounts', '')])
        self.assert_phone_layout('dialog.sa-dialog')
        page.screenshot(path=str(RESULTS / 'staff-access-reset-link-390.png'))
        dialog.get_by_role('button', name='Done').click()
        expect(dialog).to_have_count(0)
        expect(button).to_be_focused()

    def test_owner_approval_needs_a_role_and_starting_rate_and_a_granted_manager_sets_the_role_only(self):
        page = self.open('people', profile=OWNER_ON)
        self.settle_team()
        board = page.locator('.ops-account-approvals')
        expect(board).to_contain_text('The owner, and managers the owner allows, approve accounts with a starting role. Only the owner sets pay.')
        board.get_by_role('button', name='Approve').click()
        dialog = self.dialog()
        expect(dialog.locator('select[name=role]')).to_have_value('crew')
        rate = dialog.locator('input[name=hourlyRate]')
        self.assertEqual(rate.get_attribute('inputmode'), 'decimal')
        dialog.get_by_role('button', name='Approve account').click()
        expect(dialog.locator('[role=alert]')).to_contain_text('Enter the starting hourly rate')
        self.assertEqual(self.posts, [])
        dialog.locator('select[name=role]').select_option('crew_lead')
        rate.fill('22.50')
        self.assert_phone_layout('dialog.sa-dialog')
        page.screenshot(path=str(RESULTS / 'staff-access-approve-owner-390.png'))
        dialog.get_by_role('button', name='Approve account').click()
        expect(dialog).to_have_count(0)
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'username', 'decision', 'staffRoles', 'hourlyRate')}, {'action': 'review', 'username': 'New.Hire', 'decision': 'approved', 'staffRoles': ['crew_lead'], 'hourlyRate': 22.5})
        self.assertRegex(body['requestId'], UUID)
        expect(page.locator('#toast')).to_contain_text('is on the team and can now sign in')
        self.close_page()
        self.review_options = {'setsPay': False, 'roles': ['crew_lead', 'crew', 'sales', 'phone'], 'resets': False}
        page = self.open('people', profile=MANAGER_GRANTED)
        self.settle_team()
        expect(page.locator('[data-staff-reset]')).to_have_count(0)
        page.locator('.ops-account-approvals').get_by_role('button', name='Approve').click()
        dialog = self.dialog()
        expect(dialog.locator('input[name=hourlyRate]')).to_have_count(0)
        expect(dialog).to_contain_text('Pay stays pending: only the owner sets the starting rate')
        expect(dialog.locator('select[name=role] option[value=manager]')).to_have_count(0)
        self.assert_phone_layout('dialog.sa-dialog')
        dialog.get_by_role('button', name='Approve account').click()
        expect(dialog).to_have_count(0)
        self.assertNotIn('hourlyRate', self.posts[-1])
        expect(page.locator('#toast')).to_contain_text('Pay is pending: the owner sets the starting rate')

    def test_password_screen_changes_the_signed_in_password(self):
        page = self.open('password', profile=CREW_ON)
        expect(page.locator('#ops-title')).to_have_text('Password')
        screen = page.locator('.egc-access')
        for name, autocomplete in (('currentPassword', 'current-password'), ('newPassword', 'new-password'), ('confirmPassword', 'new-password')):
            self.assertEqual(screen.locator(f'input[name={name}]').get_attribute('autocomplete'), autocomplete)
            self.assertEqual(screen.locator(f'input[name={name}]').get_attribute('type'), 'password')
        self.assert_phone_layout('.egc-access')
        screen.locator('input[name=currentPassword]').fill('Synthetic-Wrong-1')
        screen.locator('input[name=newPassword]').fill('Fresh-Synthetic-Pass-2026')
        screen.locator('input[name=confirmPassword]').fill('Fresh-Synthetic-Pass-2026')
        screen.get_by_role('button', name='Change password').click()
        expect(screen.locator('[role=alert]')).to_contain_text('Your current password is not correct')
        expect(screen.locator('input[name=newPassword]')).to_have_value('Fresh-Synthetic-Pass-2026')
        screen.locator('input[name=currentPassword]').fill('Synthetic-Current-1')
        before = len(self.calls)
        screen.get_by_role('button', name='Change password').click()
        # The change ended this browser's Firebase data session too: once the revocation second has passed it signs in again.
        expect(screen.locator('[role=status]')).to_contain_text('Reconnecting this device')
        expect(screen.locator('[role=status]')).to_contain_text('Password changed. You stay signed in here; your other devices are signed out.')
        self.assertIn(('GET', '/api/firebase-session', ''), self.calls[before:])
        self.assertEqual({key: self.posts[-1][key] for key in ('action', 'currentPassword', 'newPassword', 'confirmPassword')},
                         {'action': 'change_password', 'currentPassword': 'Synthetic-Current-1', 'newPassword': 'Fresh-Synthetic-Pass-2026', 'confirmPassword': 'Fresh-Synthetic-Pass-2026'})
        self.assertEqual(page.evaluate("JSON.stringify({...sessionStorage,...localStorage}).includes('Fresh-Synthetic')"), False, 'no password is kept on the device')
        expect(screen.locator('input[name=newPassword]')).to_have_value('')
        page.screenshot(path=str(RESULTS / 'staff-access-password-390.png'), full_page=True)
        # When this device cannot sign its data session in again, the notice asks for a reload instead.
        self.api_failures['/api/firebase-session'] = 'Synthetic Firebase outage'
        for name, value in (('currentPassword', 'Synthetic-Current-1'), ('newPassword', 'Second-Synthetic-Pass-2026'), ('confirmPassword', 'Second-Synthetic-Pass-2026')):
            screen.locator(f'input[name={name}]').fill(value)
        screen.get_by_role('button', name='Change password').click()
        expect(screen.locator('[role=status]')).to_contain_text('Reload the Hub to reconnect this device')

    def test_apply_rate_to_open_weeks_skips_exported_weeks(self):
        self.staff['viewer']['capabilities'] = OWNER_CAPS + ['accounts.reset', 'password.change']
        page = self.open('staff', profile=OWNER_ON)
        button = page.get_by_role('button', name='Apply rate to open weeks for Synthetic Crew')
        button.click()
        dialog = self.dialog()
        exported, open_week = dialog.locator('input[name=week][value="2026-09-14"]'), dialog.locator('input[name=week][value="2026-09-21"]')
        expect(exported).to_be_disabled(); expect(exported).not_to_be_checked()
        expect(open_week).to_be_checked()
        expect(dialog).to_contain_text('keeps its saved rate')
        self.assert_phone_layout('dialog.sa-dialog')
        page.screenshot(path=str(RESULTS / 'staff-access-apply-rate-390.png'))
        dialog.get_by_role('button', name='Apply rate to chosen weeks').click()
        expect(dialog).to_contain_text('Saved: 2 timecards now use the scheduled rate')
        body = self.posts[-1]
        self.assertEqual({key: body[key] for key in ('action', 'username', 'expectedRevision', 'planDigest', 'weeks')},
                         {'action': 'apply_rate', 'username': 'Synthetic.Crew', 'expectedRevision': 'rev-staff-1', 'planDigest': 'a' * 64, 'weeks': ['2026-09-21']})
        self.assertRegex(body['requestId'], UUID)

    def test_flag_off_shows_none_of_it(self):
        page = self.open('people', profile=OWNER_OFF)
        self.settle_team()
        expect(page.locator('.ops-account-approvals')).to_contain_text('Only Zac can approve accounts.')
        expect(page.locator('[data-staff-reset]')).to_have_count(0)
        self.assertNotIn('password', self.nav_views())
        page.locator('.ops-account-approvals').get_by_role('button', name='Approve').click()
        expect(self.dialog()).to_have_count(0)
        expect(page.locator('.ops-action-dialog')).to_contain_text('This unlocks Employee Hub access using the password they created.')
        self.assertFalse(any(path == '/api/employee-accounts' and method == 'GET' for method, path, _ in self.calls))
        self.close_page()
        page = self.open('my_day', profile={**CREW, 'capabilities': [], 'capabilityMode': 'legacy'})
        self.assertNotIn('password', self.nav_views())
        self.assertEqual(page.evaluate('window.EGCStaffAccess.enabled()'), False)


if __name__ == '__main__':
    unittest.main()
