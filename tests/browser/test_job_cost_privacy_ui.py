"""JOB-COST-PRIVACY on the real employee.html finance screen. Labor dollars live in the server-only jobLaborCosts
record (/api/job-labor-costs), never on the job documents the Hub streams to every manager. A manager without
pay.manage sees crew-hours and "Labor $ hidden" (never a labor, direct-cost, contribution or margin figure, even when
an older labor copy is still on the job) at 320, 375 and 390 px without sideways scroll; the cost dialog has no labor
field and never writes one. The owner sees labor from the private record and saves a changed figure there before the
job, and a blank figure there means unknown. A failed labor load says so with a Retry instead of a figure. A crew lead
or sales account with business access, which /api/job-labor-costs refuses (403 job_labor_forbidden), sees "Labor $
hidden" with no Retry and no second request. The dialog shows its first field and its Save button together on a
320x568 phone."""
import copy, json, unittest
from playwright.sync_api import expect
from hub_shell_harness import FIREBASE, HubShell, JOBS, MANAGER, RESULTS

OWNER = {**MANAGER, 'owner': True}
TYLER = {'ok': True, 'user': 'TylerG', 'displayName': 'Synthetic Manager', 'role': 'manager', 'businessAccess': True, 'owner': False, 'payType': 'hourly', 'hourlyRate': 0}
# Labor canaries: $151.64 entered by the owner (still copied on this job, as before the backfill), and the legacy
# $20/crew-hour baseline on a job without costs (3 h -> $60.00).
COSTED = {'id': 'job-costed', 'type': 'job', 'customer': 'Synthetic Costed Garage', 'phone': '9705550103', 'address': '12 Synthetic Pl, Fort Collins, CO', 'date': '2026-09-16', 'time': '09:00',
          'endDate': '2026-09-16', 'endTime': '13:00', 'status': 'completed', 'total': 900, 'priceQuoted': 900, 'hoursOnSite': 4, 'crewSize': 1, 'notify': False, 'syncStatus': 'synced',
          'costs': {'labor': 151.64, 'laborCents': 15164, 'disposal': 85.5, 'materials': 0, 'fuel': 12, 'processing': 0, 'other': 0, 'recordedAt': '2026-09-17T18:00:00Z', 'recordedBy': 'zacb', 'source': 'egc_hub'}}
BASELINE = {'id': 'job-baseline', 'type': 'job', 'customer': 'Synthetic Baseline Garage', 'phone': '9705550104', 'address': '34 Synthetic Pl, Fort Collins, CO', 'date': '2026-09-14', 'time': '09:00',
            'endDate': '2026-09-14', 'endTime': '12:00', 'status': 'completed', 'total': 600, 'priceQuoted': 600, 'hoursOnSite': 3, 'crewSize': 1, 'notify': False, 'syncStatus': 'synced'}
# After the backfill the job carries no labor; the owner's figure is the private record.
CLEAN = {**COSTED, 'costs': {key: value for key, value in COSTED['costs'].items() if key not in ('labor', 'laborCents')}}
RECORD = {'jobId': 'job-costed', 'laborCents': 15164, 'revision': 'labor-r0', 'recordedAt': '2026-09-17T18:00:00Z', 'recordedBy': 'zacb'}
# Business-access accounts that are not operations managers: /api/job-labor-costs refuses them whatever the flag says.
CREW_LEAD = {'ok': True, 'user': 'Synthetic.Lead', 'displayName': 'Synthetic Crew Lead', 'role': 'crew_lead', 'businessAccess': True, 'owner': False, 'payType': 'hourly', 'hourlyRate': 0}
SALES = {'ok': True, 'user': 'Synthetic.Sales', 'displayName': 'Synthetic Sales', 'role': 'sales', 'businessAccess': True, 'owner': False, 'payType': 'hourly', 'hourlyRate': 0}
FORBIDDEN = {'ok': False, 'code': 'job_labor_forbidden', 'error': 'Only an operations manager or owner can open job labor cost.'}
HIDDEN = {'ok': True, 'authority': 'employee_hub', 'laborCostHidden': True, 'jobs': None, 'asOf': '2026-09-22T18:00:00Z'}
VISIBLE = {'ok': True, 'authority': 'employee_hub', 'laborCostHidden': False, 'jobs': [RECORD], 'complete': True, 'asOf': '2026-09-22T18:00:00Z'}
# The Hub shows whole dollars: labor $152 and $60, and the figures that include labor: direct cost 151.64+97.50=$249,
# contribution 900-249.14=$651 at 72.3%, and the baseline job's $540 at 90.0%.
LEAKS = (r'\$152\b', r'\$60(?![\d,.])', r'\$249\b', r'\$651\b', r'\$540\b', r'72\.3%', r'90\.0%')
CAPTURE = FIREBASE.replace("doc(){return{set:async()=>{},", "doc(id){return{set:async(update)=>{(window.__sets||=[]).push([id,JSON.parse(JSON.stringify(update))])},")


class JobCostPrivacyBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.labor = copy.deepcopy(HIDDEN); self.labor_fails = False; self.labor_forbidden = False; self.labor_posts = []; self.labor_gets = 0
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        parsed = route.request.url
        if 'www.gstatic.com' in parsed and parsed.split('?')[0].endswith('/firebase-app-compat.js'):
            route.fulfill(status=200, content_type='application/javascript', body=CAPTURE); return
        if '/api/job-labor-costs' in parsed:
            if route.request.method == 'POST':
                body = route.request.post_data_json; self.labor_posts.append(body)
                saved = {**RECORD, 'laborCents': body['laborCents'], 'revision': 'labor-r1'}
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'replayed': False, 'labor': saved})); return
            self.labor_gets += 1
            if self.labor_forbidden: route.fulfill(status=403, content_type='application/json', body=json.dumps(FORBIDDEN)); return
            if self.labor_fails: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'code': 'job_labor_unavailable', 'error': 'Synthetic outage'})); return
            route.fulfill(status=200, content_type='application/json', body=json.dumps(self.labor)); return
        super().route(route)

    def finance(self, profile, width, height=812, jobs=(COSTED, BASELINE), settled=True):
        page = self.open_page(width, height, profile)
        page.add_init_script('window.__egcJobs=' + json.dumps([*copy.deepcopy(JOBS), *copy.deepcopy(list(jobs))]) + ';')
        page.goto(f'{self.url}/employee.html?view=finance')
        page.wait_for_function('document.querySelector(".ops-finance-list")')
        if settled: page.wait_for_function('["hidden","visible","unavailable"].includes(window.EGCLaborCosts.state())')
        page.wait_for_function('!/Labor \\$ loading/.test(document.querySelector("#ops-main").innerText)')
        return page

    def card(self, customer): return self.page.locator('.ops-finance-list article', has_text=customer)
    def open_costs(self, customer='Synthetic Costed Garage'):
        self.card(customer).get_by_role('button', name='Update costs').click()
        return self.page.locator('.ops-modal')

    def test_a_manager_sees_hours_and_labor_hidden_at_phone_widths(self):
        problems = []
        for width in (320, 375, 390):
            page = self.finance(TYLER, width)
            text = page.locator('#ops-main').inner_text()
            for leak in LEAKS: self.assertNotRegex(text, leak, f'{width}px shows a labor figure')
            self.assertNotRegex(text, r'direct cost|contribution ·|% margin', 'no figure that includes labor dollars')
            expect(self.card('Synthetic Costed Garage')).to_contain_text('4.0 crew-hrs · Labor $ hidden')
            expect(self.card('Synthetic Costed Garage')).to_contain_text('$98 non-labor cost · $225/crew-hr')
            expect(self.card('Synthetic Baseline Garage')).to_contain_text('3.0 crew-hrs · Labor $ hidden')
            summary = page.locator('.ops-metrics article.accent')
            expect(summary.locator('strong')).to_have_text('Labor $ hidden')
            expect(summary).to_contain_text('only the owner sees')
            scroll = self.no_horizontal_scroll()
            if scroll['width'] > width: problems.append(f'{width}: page scrolls sideways to {scroll["width"]}px {scroll["wide"]}')
            problems += [f'{width}: {item}' for item in self.small_targets('.ops-finance-list, .ops-metrics')]
            page.screenshot(path=str(RESULTS / f'job-cost-privacy-manager-{width}.png'), full_page=True)
            self.close_page()
        self.assertEqual(problems, [])

    def test_the_manager_cost_dialog_has_no_labor_field_and_never_writes_labor(self):
        page = self.finance(TYLER, 375)
        dialog = self.open_costs()
        expect(dialog).to_contain_text('Labor $ hidden (owner only); saving keeps it.')
        self.assertEqual(dialog.locator('input[name=labor]').count(), 0)
        self.assertNotIn('151.64', dialog.inner_html())
        self.assertEqual(self.small_inputs('.ops-modal') + self.small_targets('.ops-modal'), [])
        disposal = dialog.locator('input[name=disposal]')
        self.assertEqual([disposal.get_attribute('type'), disposal.get_attribute('inputmode')], ['number', 'decimal'])
        box = dialog.locator('.ops-action-dialog').bounding_box()
        self.assertLessEqual(box['x'] + box['width'], 375 + 0.5)
        # The long form scrolls inside the dialog while Save stays in thumb reach, without scrolling to it first.
        save = dialog.get_by_role('button', name='Save actual costs').bounding_box()
        self.assertLessEqual(save['y'] + save['height'], 812, 'Save actual costs is on screen when the dialog opens')
        self.assertGreaterEqual(save['height'], 44)
        page.screenshot(path=str(RESULTS / 'job-cost-privacy-manager-dialog-375.png'))
        disposal.fill('99.25')
        dialog.get_by_role('button', name='Save actual costs').click()
        page.wait_for_function('(window.__sets||[]).length>0')
        job_id, update = page.evaluate('window.__sets.at(-1)')
        self.assertEqual(job_id, 'job-costed')
        self.assertEqual([key for key in ('labor', 'laborCents', 'laborCost') if key in update['costs'] or key in update], [], 'the manager never writes a labor figure')
        self.assertEqual([update['costs']['disposal'], update['costs']['fuel'], update['costs']['recordedBy']], [99.25, 12, 'TylerG'])
        self.assertEqual(self.labor_posts, [])

    def test_the_owner_sees_labor_from_the_private_record_and_saves_it_there_first(self):
        self.labor = copy.deepcopy(VISIBLE)
        page = self.finance(OWNER, 375, jobs=(CLEAN, BASELINE))
        expect(self.card('Synthetic Costed Garage')).to_contain_text('4.0 crew-hrs · $249 direct cost')
        expect(self.card('Synthetic Costed Garage')).to_contain_text('$651 contribution · 72.3% margin')
        self.assertNotRegex(page.locator('#ops-main').inner_text(), r'Labor \$ (hidden|loading|unavailable)')
        dialog = self.open_costs()
        expect(dialog.locator('input[name=labor]')).to_have_value('151.64')
        dialog.locator('input[name=labor]').fill('160.25')
        dialog.get_by_role('button', name='Save actual costs').click()
        page.wait_for_function('(window.__sets||[]).length>0')
        self.assertEqual(len(self.labor_posts), 1)
        post = self.labor_posts[0]
        self.assertRegex(post['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        self.assertEqual({key: post[key] for key in ('jobId', 'laborCents', 'expectedRevision', 'actorId')}, {'jobId': 'job-costed', 'laborCents': 16025, 'expectedRevision': 'labor-r0', 'actorId': 'ZacB'})
        job_id, update = page.evaluate('window.__sets.at(-1)')
        self.assertEqual([job_id, 'labor' in update['costs'], 'laborCents' in update['costs']], ['job-costed', False, False], 'labor never goes onto the job')
        expect(self.card('Synthetic Costed Garage')).to_contain_text('$258 direct cost')
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(key=>key.startsWith('egc.labor.pending'))"), [], 'a confirmed save leaves no pending request')

    def test_the_owner_blanks_a_saved_labor_figure_through_the_private_record(self):
        self.labor = copy.deepcopy(VISIBLE)
        page = self.finance(OWNER, 375, jobs=(CLEAN, BASELINE))
        dialog = self.open_costs()
        labor = dialog.locator('input[name=labor]')
        expect(labor).to_have_value('151.64')
        self.assertEqual([labor.get_attribute('placeholder'), labor.get_attribute('required')], ['Unknown', None], 'labor may be left blank')
        labor.fill('')
        dialog.get_by_role('button', name='Save actual costs').click()
        page.wait_for_function('(window.__sets||[]).length>0')
        # The saved figure becomes unknown in the private record; nothing about labor goes onto the job.
        self.assertEqual([{key: post[key] for key in ('jobId', 'laborCents', 'expectedRevision')} for post in self.labor_posts], [{'jobId': 'job-costed', 'laborCents': None, 'expectedRevision': 'labor-r0'}])
        job_id, update = page.evaluate('window.__sets.at(-1)')
        self.assertEqual([job_id, 'labor' in update['costs'], 'laborCents' in update['costs']], ['job-costed', False, False])
        expect(self.card('Synthetic Costed Garage')).to_contain_text('Labor cost unknown until actual costs are entered')
        self.assertNotRegex(self.card('Synthetic Costed Garage').inner_text(), r'direct cost|contribution|\$152\b')

    def test_with_the_flag_off_a_manager_sees_labor_as_before(self):
        self.labor = copy.deepcopy(VISIBLE)
        page = self.finance(TYLER, 375)
        expect(self.card('Synthetic Costed Garage')).to_contain_text('$249 direct cost')
        self.assertNotIn('Labor $ hidden', page.locator('#ops-main').inner_text())

    def test_a_failed_labor_load_shows_no_figure_and_offers_retry(self):
        self.labor_fails = True; self.labor = copy.deepcopy(VISIBLE)
        page = self.finance(OWNER, 320)
        self.assertLessEqual(self.no_horizontal_scroll()['width'], 320, 'the Retry button fits a 320px summary card')
        self.assertEqual(self.small_targets('.ops-metrics'), [])
        page.screenshot(path=str(RESULTS / 'job-cost-privacy-labor-unavailable-320.png'), full_page=True)
        text = page.locator('#ops-main').inner_text()
        for leak in LEAKS: self.assertNotRegex(text, leak, 'a failed load shows no labor figure')
        expect(self.card('Synthetic Costed Garage')).to_contain_text('4.0 crew-hrs · Labor $ unavailable')
        retry = page.get_by_role('button', name='Retry labor cost')
        self.assertGreaterEqual(retry.bounding_box()['height'], 44)
        self.labor_fails = False
        retry.click()
        expect(self.card('Synthetic Costed Garage')).to_contain_text('$249 direct cost')

    def test_a_crew_lead_or_sales_account_refused_labor_sees_it_hidden_with_no_retry(self):
        # With the flag on or off, /api/job-labor-costs answers these accounts 403 job_labor_forbidden. That answer
        # cannot change on a retry, so the board says "Labor $ hidden", offers no Retry and asks the server only once.
        self.labor_forbidden = True
        for profile, width in ((CREW_LEAD, 320), (SALES, 375)):
            self.labor_gets = 0
            page = self.finance(profile, width)
            label = f'{profile["role"]} {width}px'
            self.assertEqual(page.evaluate('window.EGCLaborCosts.state()'), 'hidden', label)
            text = page.locator('#ops-main').inner_text()
            for leak in LEAKS: self.assertNotRegex(text, leak, f'{label} shows a labor figure')
            self.assertNotRegex(text, r'Labor \$ unavailable|direct cost|contribution ·|% margin', label)
            expect(self.card('Synthetic Costed Garage')).to_contain_text('4.0 crew-hrs · Labor $ hidden')
            expect(self.card('Synthetic Baseline Garage')).to_contain_text('3.0 crew-hrs · Labor $ hidden')
            expect(page.locator('.ops-metrics article.accent strong')).to_have_text('Labor $ hidden')
            self.assertEqual(page.get_by_role('button', name='Retry labor cost').count(), 0, f'{label}: no Retry for a refusal')
            self.assertLessEqual(self.no_horizontal_scroll()['width'], width, label)
            # Leaving the board and coming back re-renders it from the settled state: still one request.
            self.go('today'); self.go('finance')
            expect(self.card('Synthetic Costed Garage')).to_contain_text('Labor $ hidden')
            self.assertEqual(self.labor_gets, 1, f'{label}: the refusal is asked once, not retried')
            dialog = self.open_costs()
            expect(dialog).to_contain_text('Labor $ hidden (owner only); saving keeps it.')
            self.assertEqual(dialog.locator('input[name=labor]').count(), 0, label)
            self.assertNotIn('151.64', dialog.inner_html())
            page.screenshot(path=str(RESULTS / f'job-cost-privacy-{profile["role"]}-forbidden-{width}.png'), full_page=True)
            self.close_page()
        self.assertEqual(self.labor_posts, [])

    def test_the_cost_dialog_fits_a_320x568_phone_with_its_first_field_and_save_on_screen(self):
        problems = []
        for profile, labor, width, height in ((TYLER, HIDDEN, 320, 568), (OWNER, VISIBLE, 320, 568), (TYLER, HIDDEN, 375, 667)):
            self.labor = copy.deepcopy(labor)
            page = self.finance(profile, width, height)
            dialog = self.open_costs()
            label = f'{profile["user"]} {width}x{height}'
            # Hit tests: the first field and Save are each on screen and on top, not under the sticky row or its note.
            for name, selector in (('first field', '.ops-action-dialog .ops-form-grid input'), ('Save', '.ops-action-dialog>footer button.primary')):
                if not page.evaluate('''selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  return y>0&&y<innerHeight&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(x,y))}''', selector): problems.append(f'{label}: {name} is not visible when the dialog opens')
            # The close button is a 44px square at the top right of the header, not stretched down it.
            close = dialog.get_by_role('button', name='Close').last.bounding_box()
            header = dialog.locator('.ops-action-dialog>header').bounding_box()
            if abs(close['width'] - 44) > 1 or abs(close['height'] - 44) > 1: problems.append(f'{label}: close button is {close["width"]:.0f}x{close["height"]:.0f}')
            if close['y'] - header['y'] > 20 or header['x'] + header['width'] - (close['x'] + close['width']) > 20: problems.append(f'{label}: close button is not top right')
            footer_height = page.evaluate("(()=>{const row=document.querySelector('.ops-action-dialog>footer>div');return row.getBoundingClientRect().height})()")
            if footer_height > 70: problems.append(f'{label}: sticky button row is {footer_height:.0f}px tall')
            problems += [f'{label}: {item}' for item in self.small_inputs('.ops-modal') + self.small_targets('.ops-modal')]
            if self.no_horizontal_scroll()['width'] > width: problems.append(f'{label}: page scrolls sideways')
            page.screenshot(path=str(RESULTS / f'job-cost-privacy-dialog-{profile["user"].lower()}-{width}x{height}.png'))
            # The note scrolls with the form and Save stays in reach at the bottom.
            dialog.locator('.ops-action-dialog').evaluate('form=>form.scrollTop=form.scrollHeight')
            if not page.evaluate('''()=>[...document.querySelectorAll('.ops-action-dialog>footer>span,.ops-action-dialog>footer button.primary')].every(el=>{const r=el.getBoundingClientRect();
                return r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.left+Math.min(r.width/2,20),r.top+r.height/2))})'''): problems.append(f'{label}: at the end of the form the note or Save is covered')
            self.close_page()
        self.assertEqual(problems, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
