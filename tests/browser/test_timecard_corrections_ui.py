"""Time approvals with EGC_TIMECARD_CORRECTIONS (TIME-CORRECT) in the real employee.html: an open-shift row has Close
shift, a shift open over 14 hours is listed under Needs attention, and the Correct time / Close shift dialog fits a
320x568 phone as well as 390 and 1280 wide screens. The device runs in Asia/Tokyo; every time is Denver wall clock."""
import copy, json, unittest
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, RESULTS, collections

TYLER = {'ok': True, 'user': 'TylerG', 'displayName': 'Synthetic Manager', 'role': 'manager', 'businessAccess': True, 'payType': 'hourly', 'hourlyRate': 30}
# The harness clock is Tuesday Sep 22, 12:00 Denver. Synthetic Crew clocked in Monday at 07:00 and never clocked out.
CARDS = [
    {'id': 'forgot', 'employee': 'Synthetic.Crew', 'employeeName': 'Synthetic Crew', 'payType': 'hourly', 'hourlyRate': 20, 'clockInAt': '2026-09-21T13:00:00.000Z', 'clockOutAt': '', 'status': 'active', 'approvalStatus': 'open',
     'breaks': [{'startAt': '2026-09-21T18:00:00.000Z', 'endAt': '2026-09-21T18:30:00.000Z'}], 'jobId': '', 'jobLabel': '', 'updatedAt': 'forgot-v1'},
    {'id': 'waiting', 'employee': 'Synthetic.Crew', 'employeeName': 'Synthetic Crew', 'payType': 'hourly', 'hourlyRate': 20, 'clockInAt': '2026-09-22T12:00:00.000Z', 'clockOutAt': '2026-09-22T16:00:00.000Z', 'status': 'submitted', 'approvalStatus': 'pending', 'breaks': [], 'updatedAt': 'waiting-v1'},
]
DIALOG_FIT = '''()=>{const d=document.querySelector('dialog.egc-timecard-correct'),r=d.getBoundingClientRect(),foot=d.querySelector('.tc-foot').getBoundingClientRect(),head=d.querySelector('.tc-head').getBoundingClientRect(),body=d.querySelector('.tc-body'),save=d.querySelector('.tc-actions .primary').getBoundingClientRect();
  return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,headTop:head.top,footBottom:foot.bottom,saveBottom:save.bottom,saveHeight:save.height,scrolls:body.scrollHeight>body.clientHeight,overflowX:d.scrollWidth-d.clientWidth,
    wide:[...d.querySelectorAll('*')].filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&b.right>r.right+1}).map(el=>el.tagName+'.'+el.className).slice(0,5),
    smallFonts:[...d.querySelectorAll('input:not([type=checkbox]),select,textarea')].filter(el=>parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.name)}}'''


class TimecardCorrectionsBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.cards = copy.deepcopy(CARDS); self.corrections = True; self.posts = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        if not request.url.split('?')[0].endswith('/api/employee-hub'): return super().route(route)
        self.calls.append((request.method, '/api/employee-hub', ''))
        send = lambda body, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if request.method == 'GET':
            data = collections(self.profile); data['timeEntries'] = copy.deepcopy(self.cards)
            send({'ok': True, 'collections': data, 'accounts': [], 'payVisibility': 'all' if self.profile['role'] == 'owner' else 'own', 'timecardCorrections': self.corrections}); return
        body = request.post_data_json or {}; self.posts.append(body)
        card = next((item for item in self.cards if item['id'] == body.get('id')), None)
        data = body.get('data') or {}
        if card is None or body.get('collection') != 'timeEntries': send({'ok': True, 'record': data}); return
        if 'correction' in data:
            # What the server's timecard rules save (tests/time-correct.test.mjs covers them): the new times, pending.
            if data['correction'].get('expectedUpdatedAt') != card.get('updatedAt'):
                send({'ok': False, 'code': 'EMPLOYEE_TIMECARD_CHANGED', 'error': 'This timecard changed since you opened it. Refresh, then correct it again.'}, 409); return
            card.update({key: value for key, value in data.items() if key in ('clockInAt', 'clockOutAt', 'breaks', 'jobId', 'hourlyRate')})
            card.update({'status': 'submitted', 'approvalStatus': 'pending', 'updatedAt': card['id'] + '-v2', 'correctionReason': data['correction']['reason']})
        else: card.update(data)
        send({'ok': True, 'record': copy.deepcopy(card)})

    def row(self, card_id):
        return self.page.locator('.ops-time-row', has=self.page.locator(f'button[data-timecard-id="{card_id}"]'))

    def test_an_open_shift_row_has_close_shift_and_a_forgotten_one_needs_attention_at_390_and_1280(self):
        for width in (390, 1280):
            with self.subTest(width=width):
                page = self.open('timesheets', width=width, height=900)
                expect(self.row('forgot').get_by_role('button', name='Close shift')).to_be_visible()
                expect(self.row('forgot').get_by_role('button', name='Correct time')).to_be_visible()
                expect(self.row('waiting').get_by_role('button', name='Close shift')).to_have_count(0)
                expect(self.row('waiting').get_by_role('button', name='Approve')).to_be_visible()
                attention = page.locator('.ops-time-attention')
                expect(attention).to_contain_text('Needs attention')
                expect(attention).to_contain_text('Synthetic Crew · clocked in Mon, Sep 21, 7:00 AM · open 29.0 h')
                expect(page.locator('#ops-main')).not_to_contain_text('Download CSV')
                expect(page.locator('#ops-main')).not_to_contain_text('Download for Gusto')
                scroll = self.no_horizontal_scroll()
                self.assertLessEqual(scroll['width'], width, scroll)
                if width < 700: self.assertEqual(self.small_targets('.ops-time-attention, .ops-timesheets'), [])
                page.screenshot(path=str(RESULTS / f'timecard-corrections-board-{width}.png'), full_page=True)
                attention.get_by_role('button', name='Close shift at…').click()
                dialog = page.locator('dialog.egc-timecard-correct')
                expect(dialog).to_be_visible()
                expect(dialog.get_by_role('heading')).to_have_text('Synthetic Crew · Mon, Sep 21')
                fit = page.evaluate(DIALOG_FIT)
                self.assertGreaterEqual(fit['left'], 0, fit); self.assertLessEqual(fit['right'], width, fit)
                self.assertLessEqual(fit['saveBottom'], 900, fit); self.assertEqual(fit['wide'], [], fit); self.assertEqual(fit['smallFonts'] if width < 700 else [], [], fit)
                dialog.get_by_role('button', name='Cancel').click()
                expect(dialog).to_have_count(0)
                self.close_page()

    def test_the_correct_time_dialog_fits_a_320x568_phone_with_every_field(self):
        page = self.open('timesheets', width=320, height=568)
        self.row('forgot').get_by_role('button', name='Correct time').click()
        dialog = page.locator('dialog.egc-timecard-correct')
        expect(dialog).to_be_visible()
        # The owner's dialog: clock-in and clock-out, the recorded lunch, the job, the rate and the reason.
        for name in ('clockIn', 'clockOut', 'break-0-start', 'break-0-end', 'jobId', 'hourlyRate', 'reason'): expect(dialog.locator(f'[name="{name}"]')).to_have_count(1)
        expect(dialog.locator('[name="clockIn"]')).to_have_value('2026-09-21T07:00')
        expect(dialog.locator('[name="clockOut"]')).to_have_value('')
        expect(dialog.locator('[name="hourlyRate"]')).to_have_attribute('inputmode', 'decimal')
        fit = page.evaluate(DIALOG_FIT)
        self.assertGreaterEqual(fit['left'], 0, fit); self.assertLessEqual(fit['right'], 320, fit)
        self.assertGreaterEqual(fit['top'], 0, fit); self.assertLessEqual(fit['bottom'], 568, fit)
        self.assertGreaterEqual(fit['headTop'], 0, fit); self.assertLessEqual(fit['footBottom'], 568, fit)
        self.assertLessEqual(fit['saveBottom'], 568, 'Save is on screen without scrolling the page')
        self.assertGreaterEqual(fit['saveHeight'], 44, fit)
        self.assertTrue(fit['scrolls'], 'the fields scroll inside the dialog between its fixed header and footer')
        self.assertLessEqual(fit['overflowX'], 0, fit); self.assertEqual(fit['wide'], [], fit); self.assertEqual(fit['smallFonts'], [], fit)
        self.assertEqual(self.small_targets('dialog.egc-timecard-correct'), [])
        page.screenshot(path=str(RESULTS / 'timecard-correct-dialog-320x568.png'))
        # The last field scrolls into view inside the dialog, and the footer stays put.
        dialog.locator('[name="reason"]').scroll_into_view_if_needed()
        expect(dialog.locator('[name="reason"]')).to_be_in_viewport()
        self.assertLessEqual(page.evaluate(DIALOG_FIT)['footBottom'], 568)
        dialog.get_by_role('button', name='Add break').click()
        expect(dialog.locator('[name="break-1-start"]')).to_be_focused()
        self.assertEqual(page.evaluate(DIALOG_FIT)['wide'], [])
        page.screenshot(path=str(RESULTS / 'timecard-correct-dialog-320x568-break.png'))

    def test_close_shift_sends_the_manager_update_and_the_shift_leaves_needs_attention(self):
        page = self.open('timesheets', width=390, height=844)
        page.locator('.ops-time-attention').get_by_role('button', name='Close shift at…').click()
        dialog = page.locator('dialog.egc-timecard-correct')
        expect(dialog.locator('[name="reason"]')).to_have_value('Forgot to clock out')
        dialog.get_by_role('button', name='Close shift').click()
        expect(dialog.get_by_role('alert')).to_contain_text('Enter the clock-out date and time')
        self.assertEqual([post for post in self.posts if 'correction' in (post.get('data') or {})], [])
        dialog.locator('[name="clockOut"]').fill('2026-09-21T16:00')
        expect(dialog.locator('.tc-preview')).to_contain_text('8.50 h paid time over a 9.00 h shift with 0.50 h unpaid breaks')
        dialog.get_by_role('button', name='Close shift').click()
        expect(dialog).to_have_count(0)
        [post] = [post for post in self.posts if 'correction' in (post.get('data') or {})]
        self.assertEqual((post['collection'], post['id'], post['data']['clockOutAt']), ('timeEntries', 'forgot', '2026-09-21T22:00:00.000Z'))
        self.assertEqual({key: value for key, value in post['data']['correction'].items() if key != 'requestId'}, {'kind': 'close', 'reason': 'Forgot to clock out', 'expectedUpdatedAt': 'forgot-v1'})
        self.assertRegex(post['data']['correction']['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        expect(page.locator('#toast')).to_contain_text('Shift closed. It is waiting for approval.')
        expect(page.locator('.ops-time-attention')).to_have_count(0)
        expect(self.row('forgot').get_by_role('button', name='Approve')).to_be_visible()
        expect(self.row('forgot').get_by_role('button', name='Close shift')).to_have_count(0)

    def test_a_manager_gets_no_rate_field_and_with_the_switch_off_there_are_no_corrections(self):
        page = self.open('timesheets', width=390, height=844, profile=TYLER)
        self.row('forgot').get_by_role('button', name='Correct time').click()
        dialog = page.locator('dialog.egc-timecard-correct')
        expect(dialog.locator('[name="clockIn"]')).to_be_visible()
        expect(dialog.locator('[name="hourlyRate"]')).to_have_count(0)
        dialog.get_by_role('button', name='Close', exact=True).click()
        self.close_page()
        self.corrections = False
        page = self.open('timesheets', width=390, height=844, profile=MANAGER)
        expect(self.row('waiting').get_by_role('button', name='Approve')).to_be_visible()
        expect(page.locator('.ops-time-row').get_by_role('button', name='Correct time')).to_have_count(0)
        expect(page.locator('.ops-time-row').get_by_role('button', name='Close shift')).to_have_count(0)
        expect(page.locator('.ops-time-attention')).to_have_count(0)
        self.go('today')
        expect(page.locator('#ops-main')).not_to_contain_text('open over 14 hours')

    def test_a_timecard_id_with_quotes_stays_data_when_its_buttons_are_clicked(self):
        # A crew device chose this ID at clock-in (an older build, before the server refused such IDs).
        evil = "x');window.__pwned=1;('"
        self.cards = [dict(copy.deepcopy(CARDS[0]), id=evil), dict(copy.deepcopy(CARDS[1]), id=evil + 'w')]
        page = self.open('timesheets', width=390, height=844)
        self.assertEqual(page.locator('.ops-time-row button[onclick], .ops-time-attention button[onclick]').count(), 0)
        page.locator('.ops-time-attention').get_by_role('button', name='Close shift at…').click()
        dialog = page.locator('dialog.egc-timecard-correct')
        expect(dialog.get_by_role('heading')).to_have_text('Synthetic Crew · Mon, Sep 21')
        dialog.get_by_role('button', name='Cancel').click()
        self.row(evil + 'w').get_by_role('button', name='Approve').click()
        expect(self.row(evil + 'w')).to_contain_text('approved')
        [post] = [post for post in self.posts if post.get('id') == evil + 'w']
        self.assertEqual(post['data']['approvalStatus'], 'approved')
        self.assertIsNone(page.evaluate('window.__pwned'))


if __name__ == '__main__':
    unittest.main()
