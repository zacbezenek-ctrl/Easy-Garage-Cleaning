"""MOBILE-HUB: the real employee.html shell, with long-name fixtures, on a 320x568 and 375x812 phone, a 390x844 phone,
an 844x390 landscape phone, an 820x1180 and 1180x820 iPad and a 1366x768 laptop. Each test names the audit finding it
guards (SHELL-01..06, BOOK-19/20/22/27, CD-18, TABLET-01/02, LAND-01, IPAD-01, CONTRAST-01, SETUP-01) and fails on the
shell before this pass. Every wait is on a DOM condition; nothing sleeps."""
import copy, json, pathlib, re, subprocess, unittest
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect
import hub_shell_harness as harness
from hub_shell_harness import HubShell, MANAGER, CREW, RESULTS, JOBS, NOW, DAY

ROOT = pathlib.Path(__file__).resolve().parents[2]
SIZES = {'320x568': (320, 568), '375x812': (375, 812), '390x844': (390, 844), '844x390': (844, 390),
         '820x1180': (820, 1180), '1180x820': (1180, 820), '1366x768': (1366, 768)}
PHONES = ('320x568', '375x812', '390x844')
TOUCH_LARGE = ('844x390', '820x1180', '1180x820')
LONG_NAME = 'Maximiliana Van Der Westhuizen-Oyelaran Family Trust Garage'
LONG_ADDRESS = '12345 East County Road 38 Unit 1204B, Building Seventeen, Fort Collins, CO 80525-9921'
# The finance board's Record payment opens the server money dialog when the moneyApi flag is on; its job comes from the
# real moneyProjection so the fixture cannot drift from the service.
PROJECTION = r'''
import { moneyProjection } from './functions/_lib/money-service.js';
const job = { id: 'job-fixture', revision: 'r1', type: 'job', customerId: 'c1', customer: 'Maximiliana Van Der Westhuizen-Oyelaran Family Trust Garage', serviceType: 'Garage cleanout', date: '2026-09-15', status: 'completed', pipelineStatus: 'completed', phone: '9705550100', total: 1800,
  estimate: { number: 'EST-SYN1', status: 'accepted', revision: 1, amount: 1800, depositRequired: 0, scope: 'Synthetic cleanout.', validUntil: '2026-10-06', lineItems: [{ id: 'line-1', kind: 'service', name: 'Garage cleanout', description: '', quantity: 1, unitCents: 180000, totalCents: 180000, amount: 1800 }] },
  customerApproval: { status: 'approved', amount: 1800 }, invoice: { number: 'INV-1001', status: 'issued', amount: 1800, dueDate: '2026-09-30', issuedAt: '2026-09-15T19:00:00.000Z' } };
process.stdout.write(JSON.stringify(moneyProjection(job, '2026-09-22T18:00:00.000Z')));
'''
# An iPhone running the installed Hub: a 47px status bar (Dynamic Island) and a 34px home indicator in portrait.
PHONE_INSETS = ':root{--egc-safe-top:47px;--egc-safe-bottom:34px}'
# Dispatch's Repeat opens the recurring plan sheet; an empty, enabled plan list is enough to show its form.
PLANS = {'ok': True, 'enabled': True, 'plans': [], 'roster': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew', 'role': 'crew'}], 'viewer': {'id': 'zacb'}, 'coverage': {'complete': True}}


def long_jobs():
    jobs = copy.deepcopy(JOBS)
    jobs[0].update(customer=LONG_NAME, address=LONG_ADDRESS, notes='Keep the workbench and the labelled holiday bins. ' * 6)
    jobs[2].update(customer=LONG_NAME + ' (second bay)', address=LONG_ADDRESS)
    return jobs


class HubShellMobileTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.start()
        cls.projection = json.loads(subprocess.run(['node', '--input-type=module', '-e', PROJECTION], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.jobs = long_jobs(); self.money = False; self.board = None
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        parsed = urlparse(route.request.url)
        if self.money and parsed.hostname == '127.0.0.1' and parsed.path == '/api/money' and route.request.method == 'GET':
            job_id = parse_qs(parsed.query)['jobId'][0]
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'enabled': True, 'viewer': {'id': 'zacb'}, 'job': {**self.projection, 'id': job_id}, 'asOf': NOW}))
            return
        if self.board and parsed.hostname == '127.0.0.1' and parsed.path == '/api/dispatch' and route.request.method == 'GET':
            route.fulfill(status=200, content_type='application/json', body=json.dumps(self.board)); return
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/recurring-plans' and route.request.method == 'GET':
            route.fulfill(status=200, content_type='application/json', body=json.dumps(PLANS)); return
        return HubShell.route(self, route)

    def show(self, view, size, profile=MANAGER):
        width, height = SIZES[size]
        page = self.open(view, width=width, height=height, profile=profile, mobile=width < 900, touch=width < 1300)
        self.settle()
        return page

    def login(self, size):
        width, height = SIZES[size]
        page = self.open_page(width, height, MANAGER, mobile=width < 900, touch=width < 1300)
        self.profile = {'ok': False, 'error': 'Sign in required'}
        page.goto(f'{self.url}/employee.html'); page.wait_for_selector('#l-user')
        return page

    def box(self, selector):
        return self.page.evaluate('s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,display:c.display,visibility:c.visibility,paddingTop:c.paddingTop,paddingLeft:c.paddingLeft,paddingRight:c.paddingRight,paddingBottom:c.paddingBottom}}', selector)

    def hit(self, selector, index=0):
        """True when the element's centre takes the tap (on screen, not clipped or covered)."""
        return self.page.evaluate('([s,i])=>{const e=document.querySelectorAll(s)[i];if(!e)return false;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(y<0||y>innerHeight||x<0||x>innerWidth)return false;const h=document.elementFromPoint(x,y);return!!h&&e.contains(h)}', [selector, index])

    def meaningful_hidden(self):
        """aria-hidden content a sighted user can see that holds a heading or a control (decorative initials and weekday
        strips are fine; the legacy lead drawer was not)."""
        return self.page.evaluate('''()=>[...document.querySelectorAll('[aria-hidden="true"]')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);
          return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&el.querySelector('h1,h2,h3,h4,button,a[href],input,select,textarea')}).map(el=>el.id||el.className)''')

    # SHELL-01, BOOK-27, TABLET-01, TABLET-02: the audit's own checks on the views the owner uses most, at every device.
    def test_the_owners_main_views_fit_every_device_with_touch_targets_16px_fields_and_sans_serif_controls(self):
        problems = []
        cases = [(MANAGER, ['today', 'timesheets', 'people', 'settings']), (CREW, ['my_day'])]
        for size, (width, height) in SIZES.items():
            touch = width < 1300
            for profile, views in cases:
                page = self.show(views[0], size, profile)
                for view in views:
                    self.go(view); self.settle()
                    a = self.audit(scope='body', targets=touch)
                    label = f'{size} {profile["role"]} {view}'
                    if a['scrollWidth'] > width: problems.append(f'{label}: scrolls sideways to {a["scrollWidth"]}px {a["offscreen"][:3]}')
                    problems += [f'{label}: small target {item}' for item in a['smallTargets']]
                    problems += [f'{label}: field under 16px {item}' for item in a['smallInputs']]
                    problems += [f'{label}: no sans-serif fallback {item}' for item in a['fonts']]
                    problems += [f'{label}: section padding {item}' for item in a['sectionPad']]
                    problems += [f'{label}: aria-hidden content {item}' for item in self.meaningful_hidden()]
                self.close_page()
            page = self.login(size)
            a = self.audit(scope='body', targets=touch)
            if a['scrollWidth'] > width: problems.append(f'{size} login: scrolls sideways to {a["scrollWidth"]}px')
            problems += [f'{size} login: {item}' for item in a['smallTargets'] + a['smallInputs'] + a['fonts']]
            problems += [f'{size} login: aria-hidden content {item}' for item in self.meaningful_hidden()]
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-login-{size}.png'))
            self.close_page()
        self.assertEqual(problems, [])

    # SHELL-01, BOOK-19: the public stylesheet is gone, and with it the section padding and the navy footer paint.
    def test_the_public_stylesheet_no_longer_leaks_into_the_hub(self):
        for size in ('390x844', '1180x820'):
            with self.subTest(size=size):
                page = self.show('today', size)
                self.assertEqual(page.evaluate("[...document.styleSheets].filter(s=>/\\/styles\\.css/.test(s.href||'')).length"), 0)
                self.assertEqual(page.locator('link[href*="styles.css"]').count(), 0)
                self.assertEqual(self.box('.ops-workspace')['paddingTop'], '0px')
                self.assertLessEqual(abs(self.box('.ops-topbar')['top'] - self.box('.ops-workspace')['top']), 0.5, 'the topbar starts the workspace')
                self.go('timesheets'); self.settle()
                cards = page.evaluate("[...document.querySelectorAll('.ops-timesheets>section,.hub-home-widget,.ops-chat-room')].map(e=>getComputedStyle(e).paddingTop)")
                self.assertTrue(cards and all(value == '0px' for value in cards), cards)
                self.go('today')
                page.evaluate("opsOpenBooking('2026-09-22')")
                expect(page.locator('.ops-booking')).to_be_visible()
                footer = page.evaluate("(()=>{const f=document.querySelector('.ops-booking>footer'),n=f.querySelector('span'),c=getComputedStyle(f);return{bg:c.backgroundColor,display:c.display,note:getComputedStyle(n).color}})()")
                self.assertNotIn(footer['bg'], ('rgb(4, 16, 32)', 'rgb(9, 26, 48)'), 'the booking footer is not painted navy')
                self.assertEqual(footer['note'], 'rgb(91, 100, 116)', 'the footer note is the muted Hub ink, not the public footer text')
                page.evaluate('opsCloseBooking()')
                # What the Hub did need from the public sheet stays: the skip link is off screen and boxes are border-box.
                self.assertLess(self.box('.skip-link')['right'], 0)
                self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.ops-card,.ops-timesheets>section')).boxSizing"), 'border-box')
                self.close_page()

    # SHELL-02: dialogs are no longer pinned top left; they centre, phones get a bottom sheet, and the save is reachable.
    def test_create_job_record_payment_and_the_action_dialog_centre_inside_the_viewport(self):
        problems = []
        for size, (width, height) in SIZES.items():
            self.money = True
            page = self.show('schedule', size)
            page.get_by_role('button', name='Create job', exact=True).first.click()
            page.wait_for_selector('dialog.dp-dialog[open]')
            problems += self.dialog_problems(f'{size} Create job', 'dialog.dp-dialog[open]', '.dp-dialog-foot button', native=True)
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-create-job-{size}.png'))
            self.close_page()
            page = self.show('finance', size)
            page.evaluate('window.EGC_FLAGS={moneyApi:true}')
            page.get_by_role('button', name='Record payment', exact=True).first.click()
            expect(page.locator('dialog.egc-money .em-summary')).to_be_visible()
            problems += self.dialog_problems(f'{size} Record payment', 'dialog.egc-money[open]', '.em-foot .primary', native=True)
            self.close_page()
            page = self.show('fixture_screen', size)
            page.get_by_role('button', name='Confirm with dialog').click()
            expect(page.get_by_role('dialog', name='Synthetic confirmation')).to_be_visible()
            problems += self.dialog_problems(f'{size} action dialog', '.ops-modal .ops-action-dialog', 'footer button.primary', native=False)
            self.close_page()
        self.assertEqual(problems, [])

    def dialog_problems(self, label, selector, submit, native):
        box, out = self.dialog_box(selector, submit), []
        if box is None: return [f'{label}: no dialog']
        if min(box['left'], box['right'], box['top'], box['bottom']) < -0.5: out.append(f'{label}: outside the viewport {box}')
        if abs(box['left'] - box['right']) > 2: out.append(f'{label}: not centred (left {box["left"]:.0f}, right {box["right"]:.0f})')
        if native and box['vw'] <= 680:
            if box['bottom'] > 2: out.append(f'{label}: phone sheet does not sit on the bottom edge ({box["bottom"]:.0f}px above it)')
        elif box['height'] < box['vh'] - 4 and abs(box['top'] - box['bottom']) > 2: out.append(f'{label}: not centred vertically (top {box["top"]:.0f}, bottom {box["bottom"]:.0f})')
        if not box['reachable']: out.append(f'{label}: {box["submit"]!r} cannot be reached')
        return out

    # SHELL-02, SHELL-04: on an iPhone running the installed Hub (47px status bar, 34px home indicator) every dialog keeps
    # its header and close below the status bar and its save above the home indicator. Tall sheets used to be pushed up
    # past the top edge (Create job and Record payment at -22px, the recurring plan at -34px) and the Hub's own modal sat
    # under the status bar. The recurring plan stays a full-screen sheet whose header and footer take the insets.
    def test_dialogs_clear_the_status_bar_and_the_home_indicator(self):
        problems = []
        for size in ('390x844', '320x568'):
            self.money = True
            page = self.show('schedule', size); page.add_style_tag(content=PHONE_INSETS)
            page.get_by_role('button', name='Create job', exact=True).first.click()
            page.wait_for_selector('dialog.dp-dialog[open]')
            problems += self.inset_problems(f'{size} Create job', 'dialog.dp-dialog[open]', '.dp-dialog-head [aria-label="Close dialog"]', '.dp-dialog-foot button')
            page.keyboard.press('Escape'); expect(page.locator('dialog.dp-dialog[open]')).to_have_count(0)
            page.locator('.dp-repeat').first.click()
            page.wait_for_selector('dialog.rp-dialog[open] .rp-form-foot button[type=submit]')
            sheet = self.box('dialog.rp-dialog[open]')
            if abs(sheet['top']) > 0.5 or abs(sheet['bottom'] - SIZES[size][1]) > 0.5: problems.append(f'{size} recurring plan: no longer a full-screen sheet {sheet}')
            problems += self.inset_problems(f'{size} recurring plan', 'dialog.rp-dialog[open]', '.rp-close', '.rp-form-foot button[type=submit]', sheet=False)
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-insets-recurring-{size}.png'))
            page.locator('dialog.rp-dialog[open] .rp-close').click(); expect(page.locator('dialog.rp-dialog[open]')).to_have_count(0)
            # The lanes calendar's assign sheet keeps its own edge placement (flush with the bottom); its footer pads the indicator.
            page.get_by_role('button', name='Lanes', exact=True).click()
            page.locator('.dc-item').first.click(); page.wait_for_selector('dialog.dc-sheet[open]')
            problems += self.inset_problems(f'{size} calendar sheet', 'dialog.dc-sheet[open]', '.dp-dialog-head [aria-label="Close dialog"]', '.dp-dialog-foot button', sheet=False)
            self.close_page()
            page = self.show('finance', size); page.add_style_tag(content=PHONE_INSETS)
            page.evaluate('window.EGC_FLAGS={moneyApi:true}')
            page.get_by_role('button', name='Record payment', exact=True).first.click()
            expect(page.locator('dialog.egc-money .em-summary')).to_be_visible()
            problems += self.inset_problems(f'{size} Record payment', 'dialog.egc-money[open]', '.em-close', '.em-foot .primary')
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-insets-record-payment-{size}.png'))
            self.close_page()
            page = self.show('today', size); page.add_style_tag(content=PHONE_INSETS)
            page.evaluate("opsOpenBooking('2026-09-22')")
            expect(page.locator('.ops-booking')).to_be_visible()
            problems += self.inset_problems(f'{size} booking', '.ops-modal .ops-booking', 'header>button', 'footer button.primary')
            page.evaluate('opsCloseBooking()')
            self.go('fixture_screen'); self.settle()
            page.get_by_role('button', name='Confirm with dialog').click()
            expect(page.get_by_role('dialog', name='Synthetic confirmation')).to_be_visible()
            problems += self.inset_problems(f'{size} action dialog', '.ops-modal .ops-action-dialog', 'header>button', 'footer button.primary')
            self.close_page()
        self.assertEqual(problems, [])

    # (MOBILE-HUB after SALES-BOOKING, WT-OUTCOME, FIX-DISPATCH-QUEUE and STAFF-ACCESS) the dialogs those units added since this
    # pass was branched keep the same insets under the phone bottom-sheet rule: the booker's Create job form (/api/dispatch
    # viewer.booker), To schedule's Use this time editor, the Walkthroughs screen's Reschedule (EGCDispatch.openFor, off the
    # board) and the STAFF-ACCESS reset and approval dialogs.
    def later_board(self, booker=False):
        base = {**self.job_rows()[0], 'revision': 'rev-1', 'startAt': DAY + 'T08:00:00-06:00', 'endAt': DAY + 'T11:00:00-06:00'}
        walk = {**base, 'id': 'walk-inset', 'revision': 'walk-rev', 'type': 'walkthrough', 'customer': LONG_NAME + ' walkthrough', 'date': '2026-09-23', 'endDate': '2026-09-23',
                'time': '14:00', 'endTime': '15:00', 'startAt': '2026-09-23T14:00:00-06:00', 'endAt': '2026-09-23T15:00:00-06:00', 'status': 'scheduled', 'syncStatus': 'synced'}
        queued = {**base, 'id': 'jobber-inset', 'revision': 'jobber-rev', 'customer': LONG_NAME + ' (Jobber)', 'date': '', 'time': '', 'endDate': '', 'endTime': '', 'startAt': None, 'endAt': None,
                  'status': 'unscheduled', 'pipelineStatus': 'unscheduled', 'assignedCrew': [], 'needsDispatchReview': True, 'dispatchReviewReason': 'jobber_import',
                  'queue': {'since': '2026-09-15T15:00:00.000Z', 'sinceKind': 'created', 'ageDays': 7, 'source': 'jobber',
                            'jobber': {'date': '2026-10-08', 'time': '09:00', 'endDate': '2026-10-08', 'endTime': '12:00', 'usable': True, 'past': False}}}
        return {'ok': True, 'viewer': {'id': 'zacb', **({'booker': True} if booker else {})}, 'queueFacts': True, 'timeZone': 'America/Denver', 'jobs': [base, walk, queued],
                'roster': [{'id': 'synthetic.crew', 'name': 'Synthetic Crew', 'role': 'crew'}, {'id': 'zacb', 'name': 'Synthetic Owner', 'role': 'owner'}], 'crews': [], 'vehicles': [], 'availability': [],
                'warnings': [], 'coverage': {'complete': True, 'asOf': DAY + 'T18:00:00Z'}, 'startDate': DAY, 'endDate': '2026-09-29'}

    def test_dialogs_added_after_the_mobile_pass_clear_the_status_bar_and_the_home_indicator(self):
        problems = []
        for size in ('390x844', '320x568'):
            dialog = 'dialog.dp-dialog[open]', '.dp-dialog-head [aria-label="Close dialog"]', '.dp-dialog-foot button'
            # SALES-BOOKING: the board tells the page its viewer is a booker, so Create job opens without the crew controls.
            self.board = self.later_board(booker=True)
            page = self.show('schedule', size); page.add_style_tag(content=PHONE_INSETS)
            page.get_by_role('button', name='Create job', exact=True).first.click()
            page.wait_for_selector('dialog.dp-dialog.dp-booker[open]')
            problems += self.inset_problems(f'{size} booker Create job', *dialog)
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-insets-booker-{size}.png'))
            page.keyboard.press('Escape'); expect(page.locator('dialog.dp-dialog[open]')).to_have_count(0)
            # FIX-DISPATCH-QUEUE: an imported Jobber job's Use this time opens the schedule editor at Jobber's time.
            page.get_by_role('button', name='To schedule (1)', exact=True).click()
            page.get_by_role('button', name=re.compile('^Use Jobber.s time for ')).click()
            page.wait_for_selector('dialog.dp-dialog[open]')
            problems += self.inset_problems(f'{size} Use this time', *dialog)
            page.keyboard.press('Escape'); expect(page.locator('dialog.dp-dialog[open]')).to_have_count(0)
            self.close_page()
            # WT-OUTCOME: the Walkthroughs screen opens the dispatch dialog with no board mounted.
            self.board = self.later_board()
            page = self.show('walkthroughs', size); page.add_style_tag(content=PHONE_INSETS)
            page.get_by_role('button', name='Reschedule ' + LONG_NAME + ' walkthrough', exact=True).click()
            page.wait_for_selector('dialog.dp-dialog[open]')
            problems += self.inset_problems(f'{size} Walkthroughs reschedule', *dialog)
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-insets-walkthroughs-{size}.png'))
            page.keyboard.press('Escape'); expect(page.locator('dialog.dp-dialog[open]')).to_have_count(0)
            # STAFF-ACCESS: the reset confirmation and the approval dialog (its options unavailable here: Close and Retry).
            page.evaluate("sessionStorage.setItem('egc_capabilities',JSON.stringify(['accounts.reset']))")
            page.evaluate("EGCStaffAccess.openReset({username:'synthetic.crew',displayName:'" + LONG_NAME + "'})")
            page.wait_for_selector('dialog.sa-dialog[open] .sa-dialog-foot button')
            problems += self.inset_problems(f'{size} reset sign-in', 'dialog.sa-dialog[open]', '.sa-dialog-head h2', '.sa-dialog-foot button')
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-insets-reset-{size}.png'))
            page.keyboard.press('Escape'); expect(page.locator('dialog.sa-dialog[open]')).to_have_count(0)
            page.evaluate("EGCStaffAccess.review({username:'synthetic.pending',displayName:'" + LONG_NAME + "',decision:'approved'})")
            page.wait_for_selector('dialog.sa-dialog[open] .sa-dialog-foot button')
            problems += self.inset_problems(f'{size} account review', 'dialog.sa-dialog[open]', '.sa-dialog-head h2', '.sa-dialog-foot button')
            page.keyboard.press('Escape'); expect(page.locator('dialog.sa-dialog[open]')).to_have_count(0)
            self.close_page()
        self.assertEqual(problems, [])

    def test_landscape_dialog_clears_the_side_notch(self):
        # A landscape iPhone has a left camera inset and a right home-swipe inset.
        # The native dialog must stay inside that usable width, even with a long title.
        self.board = self.later_board()
        page = self.show('walkthroughs', '844x390')
        page.add_style_tag(content=':root{--egc-safe-top:0px;--egc-safe-right:21px;--egc-safe-bottom:21px;--egc-safe-left:47px}')
        page.get_by_role('button', name='Reschedule ' + LONG_NAME + ' walkthrough', exact=True).click()
        page.wait_for_selector('dialog.dp-dialog[open]')
        box = self.box('dialog.dp-dialog[open]')
        self.assertGreaterEqual(box['left'], 47 - 0.5, box)
        self.assertLessEqual(box['right'], 844 - 21 + 0.5, box)
        self.assertTrue(self.hit('dialog.dp-dialog[open] .dp-dialog-head [aria-label="Close dialog"]'))
        self.close_page()

    def inset_problems(self, label, selector, close, submit, sheet=True):
        """Under PHONE_INSETS: a sheet's box clears the 47px status bar and the 34px home indicator; for every dialog the
        close sits below the status bar and takes the tap, and the save scrolls into view above the home indicator."""
        out, height = [], self.page.evaluate('innerHeight')
        shut = self.box(f'{selector} {close}')
        if shut is None: return [f'{label}: no close button']
        if shut['top'] < 47 - 0.5: out.append(f'{label}: the close button starts {shut["top"]:.0f}px from the top, under the status bar')
        if not self.hit(f'{selector} {close}'): out.append(f'{label}: the close button does not take the tap')
        box = self.dialog_box(selector, submit)
        if sheet and box['top'] < 47 - 0.5: out.append(f'{label}: the sheet starts {box["top"]:.0f}px from the top, under the status bar')
        if sheet and box['bottom'] < 34 - 0.5: out.append(f'{label}: the sheet ends {box["bottom"]:.0f}px above the bottom, over the home indicator')
        if not box['reachable']: out.append(f'{label}: {box["submit"]!r} cannot be reached')
        save = self.page.evaluate('([s,b])=>{const e=[...document.querySelector(s).querySelectorAll(b)].filter(x=>x.getBoundingClientRect().width>0).at(-1);return e?innerHeight-e.getBoundingClientRect().bottom:null}', [selector, submit])
        if save is None or save < 34 - 0.5: out.append(f'{label}: the save ends {save}px above the bottom of the {height}px screen, over the home indicator')
        return out

    # SHELL-03, BOOK-20, CD-18: the legacy lead drawer (no CSS, no JS) no longer paints a Lead heading and a 4px close.
    def test_the_legacy_lead_drawer_is_gone_from_every_screen(self):
        for opener in (lambda: self.login('390x844'), lambda: self.show('today', '390x844'), lambda: self.show('today', '1366x768')):
            page = opener()
            self.assertEqual(page.locator('#lead-detail-drawer, #lead-form-modal, #cust-detail-modal').count(), 0)
            expect(page.get_by_role('heading', name='Lead', exact=True)).to_have_count(0)
            self.assertEqual(self.meaningful_hidden(), [])
            self.close_page()

    # SHELL-04: the notch and side insets reach the strip, the sticky topbar, the drawer, the rail and the page sides.
    def test_safe_area_insets_are_applied_to_the_shell(self):
        insets = ':root{--egc-safe-top:47px;--egc-safe-right:44px;--egc-safe-bottom:34px;--egc-safe-left:44px}'
        page = self.show('today', '390x844'); page.add_style_tag(content=insets)
        topbar = self.box('.ops-topbar')
        self.assertEqual(topbar['paddingTop'], '47px'); self.assertAlmostEqual(topbar['height'], 68 + 47, delta=0.5)
        page.locator('.ops-menu').click(); expect(page.locator('#ops-rail')).to_be_visible()
        rail = self.box('#ops-rail')
        self.assertEqual([rail['paddingTop'], rail['paddingLeft'], rail['paddingBottom']], ['47px', '44px', '34px'])
        page.keyboard.press('Escape')
        self.assertEqual(self.box('.ops-shell')['paddingLeft'], '44px'); self.assertEqual(self.box('.ops-shell')['paddingRight'], '44px')
        self.assertEqual(page.evaluate("getComputedStyle(document.getElementById('toast')).bottom"), '58px', 'the toast clears the home indicator')
        self.assertEqual(self.box('.egc-portal-foot')['paddingBottom'], '48px')
        self.close_page()
        page = self.show('today', '820x1180'); page.add_style_tag(content=insets)
        bar = self.box('.egc-portal-bar')
        self.assertEqual([bar['paddingTop'], bar['paddingLeft'], bar['paddingRight']], ['47px', '62px', '62px'])
        self.assertAlmostEqual(bar['height'], 45 + 47, delta=0.5)
        self.close_page()
        page = self.show('today', '1366x768'); page.add_style_tag(content=insets)
        self.assertEqual(self.box('#ops-rail')['paddingLeft'], '44px')
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.ops-shell')).gridTemplateColumns.split(' ')[0]"), '296px')
        self.assertEqual(self.box('.ops-topbar')['paddingTop'], '47px')
        self.close_page()
        page = self.login('390x844'); page.add_style_tag(content=insets)
        self.assertEqual(self.box('#login-screen')['paddingTop'], '63px')

    # SHELL-05: Quick "Clock in" lands the clock card below the sticky topbar, and it sits above Today's jobs.
    def test_quick_clock_in_scrolls_the_clock_card_clear_of_the_sticky_topbar(self):
        for size in ('390x844', '844x390', '375x812'):
            with self.subTest(size=size):
                page = self.show('requests', size, CREW)
                page.locator('#ops-quick-clock').click()
                page.wait_for_selector('.ops-clock-card')
                self.assertTrue(page.evaluate("!!(document.querySelector('.ops-clock-card').compareDocumentPosition(document.querySelector('#ops-field-today'))&Node.DOCUMENT_POSITION_FOLLOWING)"),
                                'not clocked in, the clock card comes before Today’s jobs')
                page.wait_for_function('''()=>{const y=scrollY;if(y>0&&window.__lastY===y){window.__still=(window.__still||0)+1}else{window.__still=0}window.__lastY=y;return window.__still>=12}''')
                card, topbar = self.box('.ops-clock-card'), self.box('.ops-topbar')
                self.assertGreaterEqual(card['top'], topbar['bottom'] - 1, f'the card starts below the {topbar["height"]:.0f}px topbar')
                self.assertLess(card['top'], SIZES[size][1] / 2)
                self.assertTrue(self.hit('.ops-clock-card h2'), 'the card heading is on top, not under the topbar')
                page.screenshot(path=str(RESULTS / f'hub-shell-mobile-quick-clock-{size}.png'))
                self.close_page()

    # SHELL-06: at 320 the strip and kicker give way, titles wrap to two lines with a title, and the drawer is one list.
    def test_a_320_phone_wraps_the_title_and_scrolls_the_drawer_as_one_list(self):
        page = self.show('finance', '320x568')
        expect(page.locator('.egc-portal-bar')).to_be_hidden()
        expect(page.locator('#ops-kicker')).to_be_hidden()
        title = page.locator('#ops-title')
        expect(title).to_have_attribute('title', 'Estimates & payments')
        lines = title.evaluate('e=>e.getBoundingClientRect().height/parseFloat(getComputedStyle(e).lineHeight)')
        self.assertGreater(lines, 1.8, 'a long title wraps to a second line instead of ending in an ellipsis on the first')
        self.assertLess(lines, 2.2, 'and never takes a third')
        self.assertLessEqual(self.box('.ops-topbar')['bottom'], 68.5)
        # Refresh is a 44px icon here, and the glyph adds nothing to its name (a screen reader said "↻Refresh").
        refresh = page.locator('.ops-system').get_by_role('button', name='Refresh', exact=True)
        expect(refresh).to_have_count(1)
        self.assertIn('↻', refresh.evaluate("e=>getComputedStyle(e,'::before').content"))
        self.assertGreaterEqual(refresh.bounding_box()['width'], 44)
        page.locator('.ops-menu').click()
        page.wait_for_function("(()=>{const r=document.getElementById('ops-rail').getBoundingClientRect();return r.left>=-0.5&&getComputedStyle(document.getElementById('ops-rail')).visibility==='visible'})()")
        count = page.evaluate("document.querySelectorAll('.ops-nav [data-ops-tab]').length")
        visible = [index for index in range(count) if self.hit('.ops-nav [data-ops-tab]', index)]
        self.assertGreaterEqual(len(visible), 9, f'{len(visible)} of {count} drawer items can be tapped without scrolling')
        self.assertEqual(visible[0], 0)
        self.assertEqual(page.evaluate("document.querySelector('.ops-nav [data-ops-tab]').dataset.opsTab"), 'today')
        foot, last = self.box('.ops-rail-foot'), page.evaluate("document.querySelector('.ops-nav [data-ops-tab]:last-of-type').getBoundingClientRect().bottom")
        self.assertGreaterEqual(foot['top'], last - 0.5, 'the footer links follow the last item instead of pinning the bottom of the drawer')
        page.evaluate("document.getElementById('ops-rail').scrollTop=1e6")
        page.wait_for_function("(()=>{const r=document.getElementById('ops-rail');return r.scrollTop+r.clientHeight>=r.scrollHeight-1})()")
        self.assertTrue(self.hit('.ops-rail-foot a[href="/crew/"]'), 'the crew tools link is reached by scrolling the drawer')
        page.screenshot(path=str(RESULTS / 'hub-shell-mobile-drawer-320.png'))

    # BOOK-22: a laptop's 768px rail opens on the owner's work, not ten MY EGC items.
    def test_business_users_see_run_the_business_first_on_a_laptop_rail(self):
        page = self.show('today', '1366x768')
        self.assertEqual(page.locator('.ops-nav-label').first.inner_text(), 'RUN THE BUSINESS')
        for view in ('today', 'action_center', 'schedule', 'timesheets', 'people'):
            self.assertTrue(self.hit(f'.ops-nav [data-ops-tab="{view}"]'), f'{view} is in the first screen of the rail')
        self.close_page()
        page = self.show('my_day', '1366x768', CREW)
        self.assertEqual(page.locator('.ops-nav-label').first.inner_text(), 'MY EGC')

    # BOOK-27: controls name a sans-serif fallback, so a blocked Inter never renders them in a serif.
    def test_controls_fall_back_to_a_sans_serif_when_the_web_font_is_blocked(self):
        page = self.show('customers', '390x844')
        for view in ('customers', 'scorecard', 'finance', 'today'):
            self.go(view); self.settle()
            self.assertEqual(self.audit(scope='.ops-shell', targets=False)['fonts'], [], view)
        families = page.evaluate("['.ops-button','#ops-quick-clock','.ops-nav button','.ops-context strong'].map(s=>getComputedStyle(document.querySelector(s)).fontFamily)")
        self.assertTrue(all('sans-serif' in family for family in families), families)

    # TABLET-01: no field is under 16px wherever iOS zooms on focus: iPads, landscape phones and laptops included.
    def test_fields_are_16px_on_ipads_landscape_phones_and_laptops(self):
        problems = []
        for size in ('844x390', '820x1180', '1180x820', '1366x768'):
            page = self.show('customers', size)
            for view in ('customers', 'scorecard', 'onboarding', 'fixture_screen'):
                self.go(view); self.settle()
                problems += [f'{size} {view}: {item}' for item in self.small_inputs()]
            page.evaluate("opsOpenBooking('2026-09-22')")
            problems += [f'{size} booking: {item}' for item in self.small_inputs('.ops-modal')]
            self.close_page()
        self.assertEqual(problems, [])

    # TABLET-02: 38-40px buttons, 42px scorecard fields and 43px Route links become 44px on every touch screen.
    def test_touch_targets_are_44px_on_ipads_and_landscape_phones(self):
        problems = []
        for size in TOUCH_LARGE:
            page = self.show('today', size)
            for view in ('today', 'delivery', 'customers', 'finance', 'communications', 'scorecard', 'schedule'):
                self.go(view); self.settle()
                problems += [f'{size} {view}: {item}' for item in self.audit(scope='.ops-shell')['smallTargets']]
            self.close_page()
        self.assertEqual(problems, [])

    # LAND-01: in landscape the first screen shows work: a 48px topbar, no strip, kicker or page eyebrow.
    def test_the_landscape_first_screen_shows_work_not_just_chrome(self):
        for profile, view, first in ((MANAGER, 'today', '.ops-card'), (CREW, 'my_day', '.ops-clock-card')):
            page = self.show(view, '844x390', profile)
            expect(page.locator('.egc-portal-bar')).to_be_hidden()
            expect(page.locator('#ops-kicker')).to_be_hidden()
            expect(page.locator('.ops-page-head .ops-eyebrow')).to_be_hidden()
            self.assertAlmostEqual(self.box('.ops-topbar')['height'], 48, delta=0.5)
            self.assertLessEqual(self.box('#ops-main')['top'], 48.5)
            card = self.box(first)
            self.assertLess(card['top'], 390 - 120, f'{view}: {first} is on the first screen, not below a chrome-and-title fold')
            page.screenshot(path=str(RESULTS / f'hub-shell-mobile-landscape-{view}.png'))
            self.close_page()

    # IPAD-01: the rail's foot is on screen at the top of the page and after scrolling; Team names are not squeezed.
    def test_the_ipad_rail_fits_the_screen_and_team_names_have_room(self):
        page = self.show('people', '1180x820')
        self.assertLessEqual(self.box('#ops-rail')['bottom'], 820.5)
        self.assertTrue(self.hit('.ops-rail-foot a[href="/crew/"]'), 'the rail foot is on screen at the top of the page')
        # The staff directory mounts after the Team board and makes the page long; scroll only once it is in.
        page.wait_for_function("document.querySelector('#ops-staff-directory .egc-staff')&&!document.querySelector('#ops-staff-directory .st-loading')")
        self.settle()
        end = page.evaluate('document.documentElement.scrollHeight-innerHeight')
        self.assertGreater(end, 120, 'the Team page is long enough to scroll the rail')
        # Part way down, the sticky rail is pinned to the top with its foot on screen.
        page.evaluate("y=>scrollTo({top:y,behavior:'instant'})", end // 2)
        page.wait_for_function('y=>Math.abs(scrollY-y)<1', arg=end // 2)
        rail = self.box('#ops-rail')
        self.assertLessEqual(abs(rail['top']), 0.5); self.assertLessEqual(rail['bottom'], 820.5)
        self.assertTrue(self.hit('.ops-rail-foot a[href="/crew/"]'), 'the rail foot is on screen part way down')
        # At the very end the page footer may push the rail up, but its foot stays on screen and takes the tap.
        page.evaluate("scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})")
        page.wait_for_function('Math.abs(scrollY-(document.documentElement.scrollHeight-innerHeight))<1')
        rail = self.box('#ops-rail')
        self.assertLessEqual(rail['top'], 0.5); self.assertLessEqual(rail['bottom'], 820.5)
        self.assertTrue(self.hit('.ops-rail-foot a[href="/crew/"]'), 'the rail foot is on screen at the end of the page')
        widths = page.evaluate("[...document.querySelectorAll('.ops-team-grid>article h2')].map(h=>h.getBoundingClientRect().width)")
        self.assertTrue(widths and min(widths) >= 160, f'team names get {widths}px')
        page.screenshot(path=str(RESULTS / 'hub-shell-mobile-ipad-team.png'))

    # CONTRAST-01: buttons, eyebrows, muted text and the login labels meet WCAG AA (4.5:1).
    def test_buttons_eyebrows_and_muted_text_meet_aa_contrast(self):
        sample = ['.ops-button.primary', '#ops-quick-clock', '.ops-page-head .ops-eyebrow', '.ops-page-head p', '.ops-metrics article.accent span', '#ops-kicker', '.ops-nav-label', '.hub-btn.primary', '.hub-eyebrow']
        low = []
        for size in ('390x844', '820x1180', '1366x768'):
            for profile, views in ((MANAGER, ['today', 'timesheets', 'people', 'settings', 'fixture_screen']), (CREW, ['my_day'])):
                page = self.show(views[0], size, profile)
                for view in views:
                    self.go(view); self.settle()
                    low += [f'{size} {view} {selector} {ratio}' for selector, ratio in self.contrast(sample).items() if ratio is not None and ratio < 4.5]
                self.close_page()
        # The Pending sync panel's Sync now (employee-offline-queue.css), drawn with the Hub's stylesheets: white on the old
        # #ee5c2b was 3.39:1.
        page = self.show('today', '390x844')
        page.evaluate('''()=>{const d=document.createElement('dialog'),f=document.createElement('footer'),b=document.createElement('button');
          d.className='hs-panel';b.type='button';b.className='hs-sync';b.textContent='Sync now';f.append(b);d.append(f);document.body.append(d);d.showModal()}''')
        ratio = self.contrast(['.hs-panel .hs-sync']).get('.hs-panel .hs-sync')
        if ratio is None or ratio < 4.5: low.append(f'sync panel Sync now {ratio}')
        self.close_page()
        page = self.login('390x844')
        low += [f'login {selector} {ratio}' for selector, ratio in self.contrast(['.fg label', '.btn-main', '.login-logo .pill', '.login-logo p', '.employee-signup-link']).items() if ratio is None or ratio < 4.5]
        self.assertEqual(low, [])

    # SETUP-01 and TABLET-01: the setup helper's links are 44px tall and its fields are 16px.
    def test_the_hub_login_setup_page_has_tap_sized_links_and_16px_fields(self):
        page = self.open_page(390, 844, MANAGER)
        page.goto(f'{self.url}/hub-login-setup.html')
        page.fill('#password', 'synthetic-password-1234'); page.fill('#confirmation', 'synthetic-password-1234')
        page.locator('#generate').click()
        expect(page.locator('#results')).to_be_visible(timeout=20000)
        links = page.evaluate("[...document.querySelectorAll('.next a')].map(a=>a.getBoundingClientRect().height)")
        self.assertTrue(links and min(links) >= 44, links)
        fonts = page.evaluate("[...document.querySelectorAll('input,textarea')].map(e=>parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(fonts and min(fonts) >= 16, fonts)
        buttons = page.evaluate("[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width).map(b=>b.getBoundingClientRect().height)")
        self.assertTrue(buttons and min(buttons) >= 44, buttons)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 390)


if __name__ == '__main__':
    unittest.main(verbosity=2)
