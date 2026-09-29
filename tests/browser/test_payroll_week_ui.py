"""Payroll week card (PAY-TIMESHEETS): other employees' pay reads "Pay hidden" (never $0) and only the owner gets the payroll CSV, on a phone."""
import json, os, pathlib, subprocess, threading, unittest
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = datetime(2026, 10, 5, 18, 0, tzinfo=timezone.utc)
# The real /api/timesheets responses for the owner and a manager (EGC_STAFF_PAY_OWNER_ONLY on), from synthetic canary timecards.
FIXTURE = json.loads(subprocess.run(['node', '--input-type=module', '-e', """
const { timesheetHandlers } = await import('./functions/api/timesheets.js');
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, employee, date, from, to, extra = {}) => ({ id, employee, employeeName: 'Synthetic ' + employee, payType: 'hourly', clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [], ...extra });
const timecards = [card('a', 'Crew.One', '2026-09-21', '06:00', '20:00', { hourlyRate: 37.13, bonus: 11.17, tips: 13.19 }), card('b', 'TylerG', '2026-09-23', '08:00', '12:00', { hourlyRate: 41.23 }), card('c', 'AlexK', '2026-09-24', '09:00', '13:00', { hourlyRate: 43.29 })];
const requests = [{ id: 'pto', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-25', endDate: '2026-09-25', paidHoursPerDay: 8 }];
const out = {};
for (const [name, session, query] of [['owner', { user: 'ZacB', role: 'owner', businessAccess: true }, ''], ['manager', { user: 'TylerG', role: 'manager', businessAccess: true }, ''], ['csv', { user: 'ZacB', role: 'owner', businessAccess: true }, '&format=csv']]) {
  const response = await timesheetHandlers({ session: async () => session, read: async () => ({ timecards, requests }), now: () => new Date('2026-10-05T18:00:00Z') }).get({ request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21' + query), env: {} });
  out[name] = query ? await response.text() : await response.json();
}
console.log(JSON.stringify(out));
"""], cwd=ROOT, check=True, capture_output=True, text=True).stdout)
money = lambda value: '${:,.2f}'.format(value)

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.startswith('/payroll-week'):
            who = parse_qs(urlparse(self.path).query).get('who', ['TylerG'])[0]
            body = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-payroll-week.css"></head>'
                    '<body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"><div class="ops-boundary">Individual timecards</div><div id="after">Timecards</div></main><script src="/employee-payroll-week.js"></script>'
                    f'<script>EGCPayrollWeek.mount(document.querySelector("#host"),{{startDate:"2026-09-21",identity:{json.dumps(who)}}})</script></body></html>').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class PayrollWeekBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True, timezone_id='Asia/Tokyo', accept_downloads=True)
        self.page = self.context.new_page(); self.page.set_default_timeout(5000); self.page.clock.install(time=NOW)
        self.errors = []; self.requests = []; self.json_status = 200; self.csv_responses = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error))); self.page.route('**/*', self.route)
    def tearDown(self):
        self.assertEqual(self.errors, []); self.context.close()
    def route(self, route):
        request = route.request; parsed = urlparse(request.url)
        if parsed.hostname != '127.0.0.1': route.abort(); return
        if parsed.path != '/api/timesheets': route.continue_(); return
        query = parse_qs(parsed.query); self.requests.append(query)
        send = lambda data, status=200: route.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(data))
        if query.get('format') == ['csv']:
            if self.who == 'TylerG': send({'ok': False, 'code': 'pay_owner_only', 'error': 'Only the owner can download the payroll export.'}, 403); return
            status, data = self.csv_responses.pop(0) if self.csv_responses else (200, FIXTURE['csv'])
            if status != 200: send(data, status); return
            route.fulfill(status=200, body=data, headers={'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="egc-payroll-2026-09-21-to-2026-09-27.csv"', 'Cache-Control': 'no-store'}); return
        if self.json_status != 200: send({'ok': False, 'code': 'timesheet_unavailable', 'error': 'Timesheets could not be read safely. Retry, or contact the Hub administrator.'}, self.json_status); return
        send(FIXTURE['owner' if self.who == 'ZacB' else 'manager'])
    def open(self, who):
        self.who = who; self.page.goto(f'{self.url}/payroll-week?who={who}')
        card = self.page.locator('.egc-payroll-week'); expect(card.locator('.pw-row').first).to_be_visible(); return card
    def assert_mobile(self):
        for width in (320, 375):
            self.page.set_viewport_size({'width': width, 'height': 812})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width, f'horizontal scroll at {width}px')
        small = self.page.evaluate("""() => [...document.querySelectorAll('.egc-payroll-week :is(a,button)')].filter(node => node.offsetParent).map(node => [node.textContent.trim(), node.getBoundingClientRect().height]).filter(([, height]) => height < 44)""")
        self.assertEqual(small, [], 'every visible tap target is at least 44px tall')

    def test_a_manager_sees_hours_and_their_own_pay_but_other_pay_is_hidden_and_there_is_no_export(self):
        card = self.open('TylerG')
        self.assertEqual(self.page.evaluate("document.querySelector('.egc-payroll-week').previousElementSibling.className"), 'ops-boundary', 'the card sits under the timecard note')
        rows = card.locator('.pw-rows > li')
        expect(rows).to_have_count(3)
        expect(rows.filter(has_text='Synthetic TylerG')).to_contain_text(money(164.92))
        expect(rows.filter(has_text='Synthetic Crew.One')).to_contain_text('Pay hidden'); expect(rows.filter(has_text='Synthetic Crew.One')).to_contain_text('22.00 paid h · 2.00 overtime · 8.00 time off')
        expect(card.locator('.pw-total')).to_contain_text('Pay hidden'); expect(card.locator('.pw-hidden')).to_have_count(3)
        expect(card.get_by_text('Only the owner can download the payroll export.')).to_be_visible()
        expect(card.get_by_role('button', name='Download payroll CSV')).to_have_count(0)
        text = card.inner_text()
        for row in FIXTURE['owner']['employees']:
            if row['employee'] == 'tylerg': continue
            for key in ('grossPay', 'straightPay', 'ptoPay', 'bonus', 'tips'):
                if row[key]: self.assertNotIn(money(row[key]), text, f"{row['employee']}.{key} leaked")
        self.assertNotIn(money(FIXTURE['owner']['totals']['grossPay']), text); self.assertNotIn('$0.00', text)
        card.screenshot(path=str(ROOT / 'test-results' / 'payroll-week-manager-375.png'))
        self.assert_mobile()
        self.assertEqual([query.get('format') for query in self.requests], [None], 'the manager never asks for the CSV')

    def test_the_owner_sees_every_gross_and_downloads_the_payroll_csv(self):
        card = self.open('ZacB')
        for row in FIXTURE['owner']['employees']: expect(card.locator('.pw-rows > li', has_text=row['name'])).to_contain_text(money(row['grossPay']))
        expect(card.locator('.pw-total')).to_contain_text(money(FIXTURE['owner']['totals']['grossPay'])); expect(card.locator('.pw-hidden')).to_have_count(0)
        with self.page.expect_download() as download: card.get_by_role('button', name='Download payroll CSV').click()
        self.assertEqual(download.value.suggested_filename, 'egc-payroll-2026-09-21-to-2026-09-27.csv')
        self.assertEqual(pathlib.Path(download.value.path()).read_bytes().decode(), FIXTURE['csv'], 'the file is the server CSV byte for byte, CRLF rows included')
        expect(card.get_by_role('status')).to_contain_text('Payroll CSV for Sep 21 – Sep 27 downloaded')
        card.screenshot(path=str(ROOT / 'test-results' / 'payroll-week-owner-375.png'))
        self.assert_mobile()

    def test_a_flagged_week_needs_an_explicit_acknowledgement_before_export(self):
        self.csv_responses = [(409, {'ok': False, 'code': 'timesheet_incomplete', 'error': 'Fix the flagged pay (missing_rate), or export again with acknowledge=missing_rate to send them to payroll flagged.', 'details': {'reasons': ['missing_rate'], 'blocking': ['missing_rate'], 'acknowledgeable': ['missing_rate']}})]
        card = self.open('ZacB')
        card.get_by_role('button', name='Download payroll CSV').click()
        expect(card.get_by_role('alert')).to_contain_text('Fix the flagged pay')
        with self.page.expect_download() as download: card.get_by_role('button', name='Export with these flags').click()
        self.assertEqual(download.value.suggested_filename, 'egc-payroll-2026-09-21-to-2026-09-27.csv')
        self.assertEqual([query.get('acknowledge') for query in self.requests if query.get('format')], [None, ['missing_rate']])
        expect(card.get_by_role('status')).to_contain_text('with its pay-review flags')
        # An incomplete week (pending time) offers no acknowledgement: it has to be fixed.
        self.csv_responses = [(409, {'ok': False, 'code': 'timesheet_incomplete', 'error': 'Finish the week and approve, reject, or fix every timecard before exporting payroll.', 'details': {'reasons': ['pending_timecards'], 'blocking': ['pending_timecards'], 'acknowledgeable': []}})]
        card.get_by_role('button', name='Download payroll CSV').click()
        expect(card.get_by_role('alert')).to_contain_text('Finish the week'); expect(card.get_by_role('button', name='Export with these flags')).to_have_count(0)

    def test_an_unreadable_week_is_unavailable_with_retry_never_zero_and_a_rebuilt_screen_reuses_the_loaded_week_until_its_timecards_change(self):
        self.json_status = 503; self.who = 'TylerG'; self.page.goto(f'{self.url}/payroll-week?who=TylerG')
        card = self.page.locator('.egc-payroll-week')
        expect(card.get_by_role('alert')).to_contain_text('Timesheets could not be read safely'); self.assertNotIn('$', card.inner_text())
        self.assert_mobile()
        # Background re-renders mount again: a failed load is not retried at once, but again after a minute.
        remount = "EGCPayrollWeek.mount(document.querySelector('#host'),{startDate:'2026-09-21',identity:'TylerG'})"
        calls = len(self.requests); self.page.evaluate(remount); self.assertEqual(len(self.requests), calls)
        self.page.clock.fast_forward(61000); self.page.evaluate(remount)
        for _ in range(50):
            if len(self.requests) > calls: break
            self.page.wait_for_timeout(50)
        expect(card.get_by_role('alert')).to_contain_text('Timesheets could not be read safely'); self.assertEqual(len(self.requests), calls + 1)
        self.json_status = 200; card.get_by_role('button', name='Retry').click()
        expect(card.locator('.pw-rows > li')).to_have_count(3)
        loads = len(self.requests)
        # The suite rebuilds the timesheet screen on background refreshes and mounts again.
        self.page.evaluate("""() => { const host = document.querySelector('#host'); host.replaceChildren(Object.assign(document.createElement('div'), {className: 'ops-boundary'})); EGCPayrollWeek.mount(host, {startDate: '2026-09-21', identity: 'TylerG'}); }""")
        expect(card.locator('.pw-rows > li')).to_have_count(3)
        self.assertEqual(len(self.requests), loads, 'a remount within five minutes does not reread the vault')
        # An approval on the board below changes the suite's timecards: the next mount rereads the week at once, and only once.
        changed = """() => EGCPayrollWeek.mount(document.querySelector('#host'), {startDate: '2026-09-21', identity: 'TylerG', requests: [],
            timecards: [{id: 'a', status: 'submitted', approvalStatus: 'approved', clockOutAt: '2026-09-21T20:00:00-06:00', updatedAt: '2026-10-05T17:59:00Z'}]})"""
        self.page.evaluate(changed)
        for _ in range(50):
            if len(self.requests) > loads: break
            self.page.wait_for_timeout(50)
        expect(card.locator('.pw-rows > li')).to_have_count(3)
        self.page.evaluate(changed); self.page.wait_for_timeout(200)
        self.assertEqual(len(self.requests), loads + 1, 'changed timecards reread the week once')
        self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))")
        expect(self.page.locator('.egc-payroll-week')).to_have_count(0)

if __name__ == '__main__':
    unittest.main()
