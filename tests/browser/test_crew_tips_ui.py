"""Customer card tips on Time approvals (TIPS): the real employee.html with the tip allocation read routed to
synthetic fixtures. The section shows the week's tips, confirms before exporting tips it cannot split, and
downloads the tip CSV for the same payroll week, at phone width with 44px targets and no sideways scroll."""
import json, pathlib, unittest
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, RESULTS

ALLOCATION = {'ok': True, 'authority': 'employee_hub', 'start': '2026-09-21', 'end': '2026-09-28', 'asOf': '2026-09-22T18:00:00Z',
              'jobs': [{'jobId': 'job-done', 'customer': 'Synthetic Finished Garage', 'serviceDate': '2026-09-15', 'tipCents': 9000, 'workMinutes': 240,
                        'employees': [{'employee': 'synthetic.crew', 'name': 'Synthetic Crew', 'minutes': 240, 'tipCents': 0}], 'allocatedCents': 0, 'unallocatedCents': 9000, 'reasons': ['untracked_job_time']}],
              'employees': [], 'totals': {'jobs': 1, 'tipCents': 9000, 'allocatedCents': 0, 'unallocatedCents': 9000},
              'coverage': {'complete': False, 'asOf': '2026-09-22T18:00:00Z', 'reasons': ['untracked_job_time']}}
BLOCKED = {'ok': False, 'code': 'tip_allocation_incomplete', 'error': 'Some tips are on jobs where crew time was not tracked to the job, so the Hub cannot split them. Export again with acknowledge=untracked_job_time to list those tips as unassigned and pay them by hand.',
           'details': {'reasons': ['untracked_job_time'], 'blocking': ['untracked_job_time'], 'acknowledgeable': ['untracked_job_time'], 'jobs': [{'jobId': 'job-done', 'reasons': ['untracked_job_time']}]}}
CSV = '"Employee name","Employee username"\r\n"Unassigned - pay by hand",""\r\n'


class CrewTipsBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self): self.errors = []; self.tip_queries = []; self.tip_probes = []; self.tips_enabled = True; self.review_reads = 0
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        parsed = urlparse(route.request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/tip-allocation':
            query = {key: values[0] for key, values in parse_qs(parsed.query).items()}
            if query.get('config') == 'tips':
                self.tip_probes.append(query)
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'authority': 'employee_hub', 'tips': {'enabled': self.tips_enabled}})); return
            self.tip_queries.append(query)
            if query.get('format') != 'csv': route.fulfill(status=200, content_type='application/json', body=json.dumps(ALLOCATION)); return
            if 'acknowledge' not in query: route.fulfill(status=409, content_type='application/json', body=json.dumps(BLOCKED)); return
            route.fulfill(status=200, content_type='text/csv; charset=utf-8', headers={'Content-Disposition': 'attachment; filename="egc-customer-tips-2026-09-21-to-2026-09-27.csv"'}, body=CSV); return
        # The removed second resolve path: Time approvals must never call it (held charges are resolved in Review queues).
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/tip-reviews':
            self.review_reads += 1
            route.fulfill(status=404, content_type='application/json', body=json.dumps({'ok': False, 'error': 'Not found'})); return
        super().route(route)

    def test_time_approvals_shows_the_week_tips_and_downloads_them_after_confirming_unassigned_tips(self):
        page = self.open('timesheets', width=375, height=812, profile=MANAGER)
        section = page.locator('.ops-crew-tips')
        expect(section.locator('h2')).to_have_text('Crew tips for this payroll week')
        # The heading shows while the week is still loading: the query is checked once the totals it answered are shown.
        expect(section.locator('.ops-crew-tips-totals')).to_contain_text('Unassigned$90.00')
        self.assertEqual(self.tip_queries[0], {'start': '2026-09-21', 'end': '2026-09-28'}, 'the timesheet week, Monday to an exclusive Monday')
        self.assertEqual(self.tip_probes, [{'config': 'tips'}], 'tips were checked to be on first')
        expect(section).to_contain_text('a dispute never does. Check Stripe for refunded or disputed tipped charges before exporting tips.')
        expect(section.get_by_role('status')).to_contain_text('not tracked to that job')
        section.locator('summary').click(); expect(section.locator('.ops-crew-tips-jobs article')).to_contain_text('$90.00 unassigned')
        self.assertLessEqual(self.no_horizontal_scroll()['width'], 375)
        self.assertEqual(self.small_targets('.ops-crew-tips'), [])
        page.screenshot(path=str(RESULTS / 'crew-tips-375.png'), full_page=True)
        section.get_by_role('button', name='Download tips CSV').click()
        dialog = page.locator('.ops-action-dialog')
        expect(dialog).to_contain_text('Export with unassigned tips?'); expect(dialog).to_contain_text('not tracked to the job')
        with page.expect_download() as download:
            dialog.get_by_role('button', name='Export with unassigned tips').click()
        self.assertEqual(download.value.suggested_filename, 'egc-customer-tips-2026-09-21-to-2026-09-27.csv')
        self.assertEqual(pathlib.Path(download.value.path()).read_bytes(), CSV.encode(), 'the file is the server CSV byte for byte (CRLF rows)')
        self.assertEqual(self.tip_queries[-1], {'start': '2026-09-21', 'end': '2026-09-28', 'format': 'csv', 'acknowledge': 'untracked_job_time'})
        expect(page.locator('.ops-crew-tips p[role=status]')).to_have_text('Tip CSV downloaded. Pay the unassigned tips by hand.')

    def test_held_tipped_card_payments_are_left_to_review_queues_on_a_phone(self):
        page = self.open('timesheets', width=375, height=812, profile=MANAGER)
        section = page.locator('.ops-crew-tips')
        expect(section.locator('h2')).to_have_text('Crew tips for this payroll week')
        expect(section).to_contain_text('Tipped card charges held for review are resolved with every other held charge in Hub › Review queues.')
        expect(page.locator('.ops-crew-tips-held')).to_have_count(0); expect(section.get_by_role('button', name='Resolve')).to_have_count(0)
        section.get_by_role('button', name='Refresh tips').click(); expect(section.get_by_role('button', name='Refresh tips')).to_be_enabled()
        self.assertEqual(self.review_reads, 0, 'Time approvals never reads or resolves held charges')
        self.assertLessEqual(self.no_horizontal_scroll()['width'], 375)
        self.assertEqual(self.small_targets('.ops-crew-tips'), [])

    def test_time_approvals_with_tips_off_shows_no_tip_section_and_reads_no_allocation(self):
        self.tips_enabled = False
        page = self.open('timesheets', width=375, height=812, profile=MANAGER)
        expect(page.locator('#ops-main')).to_contain_text('Individual timecards')
        page.wait_for_function('document.querySelector("#ops-crew-tips")!==null')
        page.evaluate('()=>new Promise(resolve=>setTimeout(resolve,300))')
        self.assertEqual(self.tip_probes, [{'config': 'tips'}])
        self.assertEqual(self.tip_queries, [], 'no job or timecard scan while tips are off')
        self.assertEqual(self.review_reads, 0, 'no held payment read while tips are off')
        expect(page.locator('.ops-crew-tips')).to_have_count(0)
        self.assertEqual(page.locator('#ops-crew-tips').inner_html(), '')
        self.assertEqual(page.locator('#ops-crew-tips').bounding_box()['height'], 0, 'the empty slot takes no space')


if __name__ == '__main__':
    unittest.main()
