"""FUN-15 owner Ad spend screen in the real employee.html at 375x812 with the device in Asia/Tokyo and a fixed clock:
unknown spend is never shown as $0, ranges are Denver days, the owner ledger form uses the right keyboards, 16px inputs
and 44px targets, a save whose outcome is unknown is retried with the same request id, managers and crew never see it,
and the page never scrolls sideways."""
import copy, json, re, unittest
from urllib.parse import urlparse
from playwright.sync_api import expect
from hub_shell_harness import HubShell, MANAGER, CREW, RESULTS

OWNER = {**MANAGER, 'owner': True}
NON_OWNER_MANAGER = {'ok': True, 'user': 'AlexK', 'displayName': 'Synthetic Manager', 'role': 'manager', 'businessAccess': True, 'owner': False, 'payType': 'salary', 'hourlyRate': 0}
AS_OF = '2026-09-22T18:00:00.000Z'
DISCLOSURES = ['non_api_channels_count_only_owner_entries', 'manual_spend_allocated_evenly_per_day', 'ad_platform_restatements_after_settlement_not_reflected']
PERIOD = {'from': '2026-09-01', 'to': '2026-09-23', 'requestedTo': '2026-10-01', 'timeZone': 'America/Denver', 'inProgress': True}


def source(name, status, **extra):
    return {'source': name, 'status': status, 'active': status != 'not_connected', 'blockers': ['flag_off'] if status == 'not_connected' else [], 'accountIds': [],
            'lastAttemptAt': None, 'lastSuccessAt': None, 'lastFailure': None, 'lastRun': None, 'configurationPublishedAt': AS_OF, **extra}


NOT_CONNECTED = {
    'ok': True, 'authority': 'egc_platform_ad_spend', 'timeZone': 'America/Denver', 'asOf': AS_OF, 'period': PERIOD,
    'metric': {'key': 'ad_spend', 'label': 'Ad spend', 'value': None, 'unit': 'cents', 'currency': 'USD', 'status': 'unknown', 'asOf': AS_OF, 'clockSources': [],
               'coverage': {'included': [], 'excluded': [{'channel': 'meta_ads', 'reasons': ['platform_not_connected']}, {'channel': 'google_ads', 'reasons': ['platform_not_connected']}],
                            'reasons': ['platform_not_connected'], 'disclosures': DISCLOSURES}, 'gaps': [], 'gapsTruncated': False},
    'channels': [{'channel': c, 'kind': 'api', 'clockSource': 'provider', 'value': None, 'status': 'unknown', 'reasons': ['platform_not_connected'], 'days': [], 'accounts': [], 'blockers': ['flag_off']}
                 for c in ('meta_ads', 'google_ads')],
    'days': [],
    'leadgen': {'key': 'meta_leadgen_count', 'label': 'Meta lead-form leads', 'unit': 'count', 'value': None, 'status': 'unknown', 'reasons': ['platform_not_connected'], 'asOf': AS_OF, 'pages': [], 'forms': [], 'days': []},
    'sources': [source('meta_ads', 'not_connected'), source('google_ads', 'not_connected'), source('meta_leadgen', 'not_connected')],
}
CONNECTED = {
    **NOT_CONNECTED,
    'metric': {**NOT_CONNECTED['metric'], 'value': 19351, 'status': 'partial', 'clockSources': ['attested', 'provider'],
               'coverage': {'included': ['meta_ads', 'google_ads', 'yard_signs'], 'excluded': [], 'reasons': ['owner_attested', 'restatement_window'], 'disclosures': DISCLOSURES},
               'gaps': [{'channel': 'meta_ads', 'accountId': '1234567890', 'date': '2026-09-02', 'reason': 'day_not_pulled'}], 'gapsTruncated': False},
    'channels': [
        {'channel': 'meta_ads', 'kind': 'api', 'clockSource': 'provider', 'value': 15351, 'status': 'partial', 'reasons': ['day_not_pulled', 'restatement_window'], 'days': [], 'accounts': []},
        {'channel': 'google_ads', 'kind': 'api', 'clockSource': 'provider', 'value': 0, 'status': 'complete', 'reasons': [], 'days': [], 'accounts': []},
        {'channel': 'yard_signs', 'kind': 'manual', 'clockSource': 'attested', 'value': 4000, 'status': 'complete', 'reasons': ['owner_attested'], 'days': [], 'entryIds': []}],
    'leadgen': {**NOT_CONNECTED['leadgen'], 'value': 3, 'status': 'partial', 'reasons': ['restatement_window'],
                'forms': [{'formId': '900000000000001', 'formName': 'Synthetic garage help request form with a long name that wraps', 'pageId': '555000111', 'count': 3, 'days': []}]},
    'sources': [source('meta_ads', 'healthy', lastSuccessAt=AS_OF), source('google_ads', 'healthy', lastSuccessAt=AS_OF),
                source('meta_leadgen', 'failing', lastSuccessAt='2026-09-22T10:00:00.000Z', lastFailure={'at': '2026-09-22T17:00:00.000Z', 'code': 'meta_rate_limited', 'accountId': '555000111'})],
}
ENTRY = {'id': '44444444-4444-4444-8444-444444444444', 'channel': 'neighborhood_sponsorships', 'description': 'Synthetic youth league banner sponsorship for the fall season', 'amountCents': 30000,
         'currency': 'USD', 'firstDate': '2026-09-01', 'lastDate': '2026-09-30', 'receiptReference': 'INV-SYN-2001-LONG-REFERENCE-WITHOUT-SPACES-0123456789', 'clockSource': 'attested',
         'enteredBy': 'zacb', 'attestedAt': AS_OF, 'status': 'active', 'revision': 2, 'supersedesId': None, 'closedAt': None, 'closedBy': None, 'closeReason': None}


class AdSpendBrowserTests(HubShell, unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.start()
    @classmethod
    def tearDownClass(cls): cls.stop()
    def setUp(self):
        self.errors = []; self.operations = []; self.coverage = NOT_CONNECTED; self.entries = []; self.later_entries = []; self.write_results = []
    def tearDown(self):
        self.close_page()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname == '127.0.0.1' and parsed.path == '/api/operations' and request.method == 'POST':
            body = request.post_data_json; self.operations.append(body); command = body['body']['command']
            if command == 'spend.coverage': status, payload = 200, copy.deepcopy(self.coverage)
            elif command == 'spend.entries':
                offset, total = body['body'].get('offset', 0), len(self.entries) + len(self.later_entries)
                items = self.later_entries if offset else self.entries
                status, payload = 200, {'ok': True, 'items': copy.deepcopy(items), 'total': total, 'offset': offset, 'nextOffset': None if offset or not self.later_entries else len(self.entries)}
            else: status, payload = self.write_results.pop(0) if self.write_results else (503, {'error': 'operations_unavailable', 'retryable': True})
            route.fulfill(status=status, content_type='application/json', body=json.dumps(payload)); return
        super().route(route)

    def commands(self, name):
        return [body for body in self.operations if body['body']['command'] == name]

    def test_unknown_spend_is_never_zero_and_the_screen_fits_a_375px_phone(self):
        page = self.open('ad_spend', width=375, height=812, profile=OWNER)
        expect(page.locator('#ops-title')).to_have_text('Ad spend')
        expect(page.locator('#ops-kicker')).to_have_text('GROW THE ENGINE')
        total = page.locator('[data-as-total]')
        expect(total).to_have_text('Unknown')
        expect(page.locator('[data-as-leads]')).to_have_text('Unknown')
        self.assertNotRegex(page.locator('.egc-ad-spend .as-stack').inner_text(), r'\$\d')
        self.assertNotIn('null', page.locator('.egc-ad-spend').inner_text())
        # 03:00 on Sep 23 on the device (Tokyo) is still Sep 22 in Denver: the month and the 30-day window follow Denver.
        self.assertEqual(self.commands('spend.coverage')[0]['body'], {'command': 'spend.coverage', 'from': '2026-09-01', 'to': '2026-10-01'})
        page.get_by_role('button', name='Last 30 days').click()
        expect(page.get_by_role('button', name='Last 30 days')).to_have_attribute('aria-pressed', 'true')
        self.assertEqual(self.commands('spend.coverage')[-1]['body'], {'command': 'spend.coverage', 'from': '2026-08-24', 'to': '2026-09-23'})
        amount = page.locator('.as-form input[name=amount]')
        self.assertEqual([amount.get_attribute('inputmode'), amount.get_attribute('type')], ['decimal', 'text'])
        self.assertEqual(page.locator('.as-form input[name=firstDate]').get_attribute('type'), 'date')
        self.assertEqual(self.small_inputs('.egc-ad-spend'), [])
        self.assertEqual(self.small_targets('.egc-ad-spend'), [])
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        page.screenshot(path=str(RESULTS / 'ad-spend-not-connected-375.png'), full_page=True)

    def test_connected_numbers_long_entries_and_a_retried_save_fit_and_keep_one_request_id(self):
        self.coverage, self.entries = CONNECTED, [ENTRY]
        page = self.open('ad_spend', width=375, height=812, profile=OWNER)
        expect(page.locator('[data-as-total]')).to_have_text('$193.51')
        expect(page.locator('[data-as-channel="google_ads"] .as-row-value strong')).to_have_text('$0.00')
        expect(page.locator('[data-as-source="meta_leadgen"] .as-badge')).to_have_text('Failing')
        expect(page.locator(f'[data-as-entry="{ENTRY["id"]}"]')).to_contain_text('INV-SYN-2001')
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        self.assertEqual(self.small_targets('.egc-ad-spend'), [])
        form = page.locator('.as-form')
        form.locator('input[name=channel]').fill('yard_signs')
        form.locator('input[name=amount]').fill('1,250.50')
        form.locator('input[name=firstDate]').fill('2026-09-01')
        form.locator('input[name=lastDate]').fill('2026-09-30')
        form.locator('input[name=description]').fill('Synthetic yard sign order')
        form.locator('input[name=receiptReference]').fill('INV-SYN-3001')
        self.write_results = [(503, {'error': 'operations_unavailable', 'retryable': True, 'message': 'The outcome may be unknown. Retry the same request ID; do not create a new copy.'}),
                              (200, {'ok': True, 'entry': {**ENTRY, 'id': '55555555-5555-4555-8555-555555555555', 'channel': 'yard_signs', 'amountCents': 125050, 'revision': 1}, 'superseded': None})]
        page.get_by_role('button', name='Save entry').click()
        expect(page.get_by_text('A spend change is waiting to be confirmed.')).to_be_visible()
        self.assertEqual(self.small_targets('.egc-ad-spend'), [])
        page.screenshot(path=str(RESULTS / 'ad-spend-pending-375.png'), full_page=True)
        page.get_by_role('button', name='Retry original save').click()
        expect(page.get_by_text('A spend change is waiting to be confirmed.')).to_have_count(0)
        first, second = self.commands('spend.entry.record')
        self.assertEqual(first, second, 'the retry sends the identical request id and body')
        self.assertRegex(first['requestId'], r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        self.assertEqual(first['body']['entry'], {'channel': 'yard_signs', 'description': 'Synthetic yard sign order', 'amountCents': 125050, 'firstDate': '2026-09-01', 'lastDate': '2026-09-30', 'receiptReference': 'INV-SYN-3001'})
        expect(form.locator('input[name=amount]')).to_have_value('')
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(key=>key.startsWith('egc.hub.pending.v1.ad_spend'))"), [])

    def test_a_conflicted_correction_and_a_paged_ledger_keep_44px_targets_on_a_phone(self):
        self.coverage, self.entries = CONNECTED, [ENTRY]
        self.later_entries = [{**ENTRY, 'id': '66666666-6666-4666-8666-666666666666', 'channel': 'yard_signs', 'description': 'Synthetic second page entry'}]
        page = self.open('ad_spend', width=375, height=812, profile=OWNER)
        expect(page.locator('[data-as-entries-count]')).to_have_text('Showing 1 of 2 entries.')
        page.get_by_role('button', name='Show more').click()
        expect(page.locator('[data-as-entry]')).to_have_count(2)
        self.assertEqual(self.commands('spend.entries')[-1]['body']['offset'], 1)
        page.locator(f'[data-as-entry="{ENTRY["id"]}"]').get_by_role('button', name='Correct').click()
        page.locator('.as-form input[name=amount]').fill('315.00')
        self.write_results = [(409, {'error': 'spend_entry_revision_conflict', 'details': {'currentRevision': 3}})]
        page.get_by_role('button', name='Save correction').click()
        discard = page.get_by_role('button', name='Discard draft and load latest')
        expect(discard).to_be_visible()
        expect(page.locator('.as-form input[name=amount]')).to_have_value('315.00')
        self.assertEqual(self.small_targets('.egc-ad-spend'), [])
        scroll = self.no_horizontal_scroll()
        self.assertLessEqual(scroll['width'], 375, scroll)
        page.screenshot(path=str(RESULTS / 'ad-spend-conflict-375.png'), full_page=True)
        before = len(self.commands('spend.coverage'))
        discard.click()
        expect(page.locator('#as-form-title')).to_have_text('Record spend')
        expect(page.locator('.as-form input[name=amount]')).to_have_value('')
        self.assertEqual(len(self.commands('spend.coverage')), before + 1)

    def test_managers_and_crew_never_see_ad_spend(self):
        for profile in (NON_OWNER_MANAGER, CREW):
            with self.subTest(role=profile['role']):
                page = self.open('ad_spend', width=375, height=812, profile=profile)
                self.assertNotIn('ad_spend', self.nav_views())
                expect(page.locator('.egc-ad-spend')).to_have_count(0)
                self.assertEqual(self.commands('spend.coverage'), [])
                self.close_page()


if __name__ == '__main__':
    unittest.main()
