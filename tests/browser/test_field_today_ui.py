"""Phone-sized personal agenda checks against isolated API contract fixtures."""
import datetime, json, os, pathlib, threading, unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-22'

def job(id='job-1', **updates):
    value = {'id':id, 'date':DAY, 'endDate':DAY, 'time':'08:00', 'endTime':'10:00', 'status':'scheduled', 'fieldStatus':'scheduled',
        'customer':'Synthetic Garage', 'phone':'(970) 555-0100', 'address':'123 Synthetic Way, Fort Collins, Colorado',
        'crewMembers':[{'id':'crew.one','name':'Crew One'}, {'id':'lead.one','name':'Lead One'}], 'crewLead':'lead.one', 'vehicleName':'Box Truck',
        'scope':'Clear the garage; preserve the workbench.', 'customerInstructions':'Keep blue bins.', 'accessInstructions':'Use side door.',
        'requiredEquipment':['Dolly','Broom'], 'checklist':[{'id':'address','completed':True},{'id':'photos','completed':False}]}
    value.update(updates)
    return value

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-field-today.css"></head><body style="margin:0;padding:14px;background:#f2f5f7"><main id="host"></main><script src="/employee-field-today.js"></script><script>EGCFieldToday.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class FieldTodayBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start()
        options={'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser=cls.pw.chromium.launch(headless=True,**options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':390,'height':844},timezone_id='Asia/Tokyo',is_mobile=True,has_touch=True)
        self.page=self.context.new_page();self.page.set_default_timeout(5000)
        self.page.clock.install(time=datetime.datetime(2026,9,22,15,tzinfo=datetime.timezone.utc))
        self.jobs=[job(),job('job-2',customer='Synthetic Next Job',time='11:00',endTime='13:00')]
        self.status=200;self.calls=[];self.errors=[];self.malformed=False
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.page.route('**/api/field-jobs?**',self.route)
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.context.close()
    def route(self,route):
        self.calls.append(parse_qs(urlparse(route.request.url).query))
        body={'ok':True,'jobs':self.jobs,'generatedAt':DAY+'T15:00:00Z'} if self.status==200 else {'ok':False,'error':'Sign in again.' if self.status==401 else 'Current schedule could not be verified.'}
        if self.malformed: body={'ok':True}
        route.fulfill(status=self.status,content_type='application/json',body=json.dumps(body))
    def open(self):
        self.page.goto(self.url);expect(self.page.get_by_role('heading',name='Today’s jobs')).to_be_visible()
    def test_current_next_job_and_field_context(self):
        self.open()
        cards=self.page.locator('.ft-job');expect(cards).to_have_count(2)
        expect(cards.nth(0)).to_contain_text('CURRENT JOB');expect(cards.nth(1)).to_contain_text('NEXT JOB')
        for text in ['Crew One, Lead One','Lead One','Box Truck','Use side door.','Keep blue bins.','Dolly, Broom','1 / 2 checklist']:
            expect(cards.nth(0)).to_contain_text(text)
        expect(cards.nth(0).get_by_role('link',name='Open job & checklist')).to_have_attribute('href','/crew/job.html?jobId=job-1')
        expect(cards.nth(0).get_by_role('link',name='Call customer')).to_have_attribute('href','tel:9705550100')
        self.assertEqual(self.calls[0]['date'],[DAY]);self.assertEqual(self.calls[0]['days'],['2'])
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        out=ROOT/'test-results';out.mkdir(exist_ok=True);self.page.screenshot(path=str(out/'field-today-mobile.png'),full_page=True)
    def test_in_progress_job_precedes_the_earlier_scheduled_job(self):
        self.jobs[1].update(status='in_progress',fieldStatus='paused')
        self.open();expect(self.page.locator('.ft-current')).to_contain_text('Synthetic Next Job')
        expect(self.page.locator('.ft-current')).to_contain_text('paused')
    def test_multiday_job_remains_in_today_and_tomorrow_is_next(self):
        self.jobs=[job(date='2026-09-21'),job('tomorrow',date='2026-09-23',endDate='2026-09-23',customer='Tomorrow Garage')]
        self.open();expect(self.page.locator('.ft-current')).to_contain_text('Synthetic Garage')
        expect(self.page.locator('.ft-job').nth(1)).to_contain_text('NEXT JOB · TOMORROW')
    def test_job_ending_at_midnight_is_not_a_current_day_assignment(self):
        self.jobs=[job(date='2026-09-21',endTime='00:00')];self.open();expect(self.page.locator('.ft-job')).to_have_count(0);expect(self.page.get_by_role('heading',name='No jobs assigned today')).to_be_visible()
    def test_incomplete_success_is_an_error_and_not_an_empty_schedule(self):
        self.malformed=True;self.open();expect(self.page.get_by_role('alert')).to_contain_text('could not be verified');expect(self.page.get_by_role('heading',name='No jobs assigned today')).to_have_count(0)
    def test_completion_moves_next_job_to_current_after_refresh(self):
        self.open();self.jobs[0].update(status='completed',fieldStatus='completed')
        self.page.get_by_role('button',name='Refresh',exact=True).click()
        expect(self.page.locator('.ft-current')).to_contain_text('Synthetic Next Job')
        expect(self.page.locator('.ft-completed')).to_contain_text('Completed today · 1')
    def test_cancelled_job_is_not_described_as_completed(self):
        self.jobs=[job(status='cancelled',fieldStatus='cancelled')];self.open()
        expect(self.page.locator('.ft-warning')).to_contain_text('cancelled')
        expect(self.page.get_by_role('heading',name='No remaining active jobs today')).to_be_visible()
        expect(self.page.locator('.ft-completed')).to_have_count(0)
    def test_missing_address_has_no_fake_navigation(self):
        self.jobs=[job(address='',phone='',vehicleName='',crewMembers=[])];self.open()
        expect(self.page.locator('.ft-job')).to_contain_text('Address missing')
        expect(self.page.get_by_role('link',name='Navigate',exact=True)).to_have_count(0)
        expect(self.page.get_by_role('link',name='Call customer')).to_have_count(0)
    def test_error_replaces_stale_assignments_and_retry_recovers(self):
        self.open();self.status=503;self.page.get_by_role('button',name='Refresh',exact=True).click()
        expect(self.page.get_by_role('alert')).to_contain_text('could not be verified')
        expect(self.page.locator('.ft-job')).to_have_count(0)
        self.assertNotIn('null',self.page.locator('#host').inner_text())
        self.status=200;self.page.get_by_role('button',name='Retry',exact=True).click()
        expect(self.page.locator('.ft-job')).to_have_count(2)
    def test_expired_session_and_signout_clear_private_job_details(self):
        self.open();self.status=401;self.page.get_by_role('button',name='Refresh',exact=True).click()
        expect(self.page.get_by_role('link',name='Sign in again')).to_be_visible()
        expect(self.page.locator('.ft-job')).to_have_count(0)
        self.status=200;self.page.get_by_role('button',name='Retry',exact=True).click();expect(self.page.locator('.ft-job')).to_have_count(2)
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))')
        expect(self.page.locator('#host')).to_be_empty()
    def test_narrow_phone_long_labels_keep_buttons_reachable(self):
        self.page.set_viewport_size({'width':320,'height':740})
        self.jobs=[job(customer='Long synthetic customer name '*8,address='Very long unbroken-address-'+('x'*120),vehicleName='Equipment vehicle '*8)]
        self.open();self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        for button in self.page.locator('.ft-actions a').all():
            self.assertGreaterEqual(button.bounding_box()['height'],44)

if __name__=='__main__':unittest.main(verbosity=2)
