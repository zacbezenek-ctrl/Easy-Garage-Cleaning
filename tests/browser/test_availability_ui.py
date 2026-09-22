"""Personal availability browser flows against isolated canonical API fixtures."""
import copy, json, os, pathlib, threading, unittest
from datetime import date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAY = '2026-09-23'
def block(**changes):
    result = {'id':'personal-1','revision':'r1','type':'availability','recordType':'crew_availability','employee':'crew.one','date':DAY,'endDate':DAY,'time':'00:00','endTime':'23:59','allDay':True,'reason':'School day','status':'active','canCancel':True,'sourceCollection':'jobs','timeNeedsReview':False}
    result.update(changes); return result

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/':
            body = b'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-availability.css"></head><body style="margin:0;padding:12px;background:#f1f5f8"><main id="host"></main><script src="/employee-availability.js"></script><script>EGCAvailability.mount(document.querySelector("#host"))</script></body></html>'
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()

class AvailabilityBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever,daemon=True).start(); cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw=sync_playwright().start(); options={'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}
        cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**options)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':390,'height':844},timezone_id='Asia/Tokyo')
        self.page=self.context.new_page(); self.page.set_default_timeout(5000); self.page.add_init_script("const RealDate=Date; window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-22T05:30:00Z']))}static now(){return new RealDate('2026-09-22T05:30:00Z').getTime()}}")
        self.rows=[block(),block(id='manager-1',date='2026-09-25',endDate='2026-09-27',reason='Manager approved leave',canCancel=False,sourceCollection='dispatchResources',recordType='availability',employeeId='crew.one'),block(id='cancelled-1',date='2026-09-24',endDate='2026-09-24',status='cancelled',canCancel=False)]
        self.calls=[];self.gets=[];self.errors=[];self.completed={};self.fail_once=None;self.lost_once=False;self.incomplete_once=False;self.read_status=200;self.employee='crew.one'
        self.page.on('pageerror',lambda error:self.errors.append(str(error)));self.page.route('**/*',self.route)
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.context.close()
    def route(self,route):
        req=route.request;parsed=urlparse(req.url)
        if parsed.hostname!='127.0.0.1':route.abort();return
        if parsed.path!='/api/crew-availability':route.continue_();return
        def send(data,status=200):route.fulfill(status=status,content_type='application/json',body=json.dumps(data))
        if req.method=='GET':
            params=parse_qs(parsed.query);self.gets.append(params)
            if self.read_status!=200:send({'ok':False,'code':'crew_availability_sign_in_required','error':'Sign in required'},self.read_status);return
            first=params['startDate'][0];last=params['endDate'][0];rows=[row for row in self.rows if row['date']<last and row['endDate']>=first]
            send({'ok':True,'timeZone':'America/Denver','employee':self.employee,'startDate':first,'endDate':last,'availability':rows,'exceptions':[],'coverage':{'complete':True}});return
        body=req.post_data_json;self.calls.append(copy.deepcopy(body))
        if self.fail_once:
            status,code,message=self.fail_once;self.fail_once=None;send({'ok':False,'code':code,'error':message},status);return
        if body['requestId'] in self.completed:send({**self.completed[body['requestId']],'replayed':True});return
        if body['action']=='create':
            row=block(id='created-'+str(len(self.rows)),revision='new-r',**body['changes']);self.rows.append(row)
        else:
            row=next(row for row in self.rows if row['id']==body['id'])
            if row['revision']!=body['expectedRevision']:send({'ok':False,'code':'crew_availability_revision_conflict','error':'Record changed'},409);return
            row.update(status='cancelled',canCancel=False,revision=row['revision']+'-next')
        response={'ok':True,'record':row,'requestId':body['requestId']};self.completed[body['requestId']]=copy.deepcopy(response)
        if self.lost_once:self.lost_once=False;route.abort('connectionfailed');return
        if self.incomplete_once:self.incomplete_once=False;send({'ok':True});return
        send(response)
    def open(self):
        self.page.goto(self.url);expect(self.page.get_by_role('heading',name='September 2026',exact=True)).to_be_visible();expect(self.page.locator('.av-block')).to_have_count(2)
    def choose(self,day='2026-09-28'):
        self.page.locator('.av-day[data-date="'+day+'"]').click()
    def create(self):self.page.get_by_role('button',name='Block this time',exact=True).click()
    def card(self,id='personal-1'):return self.page.locator('.av-block[data-id="'+id+'"]')
    def assert_saved(self):expect(self.page.get_by_role('status')).to_contain_text('Unavailable time saved.')

    def test_calendar_uses_denver_date_precise_six_week_range_and_manager_blocks(self):
        self.open();expect(self.page.locator('.av-day.today')).to_have_attribute('data-date','2026-09-21');expect(self.page.locator('.av-day')).to_have_count(42)
        first=self.gets[-1]['startDate'][0];last=self.gets[-1]['endDate'][0];self.assertEqual((date.fromisoformat(last)-date.fromisoformat(first)).days,42)
        for day in ['2026-09-25','2026-09-26','2026-09-27']:expect(self.page.locator('.av-day[data-date="'+day+'"]').locator('b')).to_have_text('Off')
        expect(self.card('manager-1')).to_contain_text('Managed by dispatch');expect(self.card('manager-1').get_by_role('button')).to_have_count(0)
        expect(self.page.locator('.av-day[data-date="2026-09-20"]')).to_be_disabled()
    def test_multiday_all_day_save_and_refresh_persistence(self):
        self.open();self.choose();self.page.get_by_label('Last day',exact=True).fill('2026-09-30');self.page.get_by_label('Reason / note',exact=True).fill('School conference');self.create();self.assert_saved()
        self.assertEqual(self.calls[-1]['changes'],{'date':'2026-09-28','endDate':'2026-09-30','allDay':True,'reason':'School conference'});self.assertNotIn('employee',self.calls[-1]);self.assertEqual(len(self.calls[-1]['requestId']),36)
        self.page.reload();expect(self.page.locator('.av-block').filter(has_text='School conference')).to_be_visible()
    def test_custom_times_midnight_and_all_day_toggle_keep_draft(self):
        self.open();self.choose();self.page.get_by_label('All day',exact=True).uncheck();self.page.get_by_label('Unavailable from',exact=True).fill('22:00');self.page.get_by_label('Unavailable until',exact=True).fill('00:00');self.page.get_by_label('Last day',exact=True).fill('2026-09-29')
        self.page.get_by_label('Reason / note',exact=True).fill('Night class');self.page.get_by_label('All day',exact=True).check();expect(self.page.get_by_label('Unavailable from',exact=True)).to_be_disabled();self.page.get_by_label('All day',exact=True).uncheck()
        expect(self.page.get_by_label('Unavailable from',exact=True)).to_have_value('22:00');self.create();self.assert_saved();self.assertEqual(self.calls[-1]['changes']['endTime'],'00:00');expect(self.page.locator('.av-day[data-date="2026-09-29"] b')).to_have_count(0)
    def test_draft_survives_poll_mount_tab_navigation_and_reload(self):
        self.open();self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Keep this draft');self.page.get_by_label('All day',exact=True).uncheck();self.page.get_by_label('Unavailable from',exact=True).fill('12:30')
        self.page.evaluate('EGCAvailability.mount(document.querySelector("#host"));EGCAvailability.refresh()');expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Keep this draft')
        self.assertTrue(self.page.evaluate('EGCAvailability.canLeave()'));self.page.evaluate('EGCAvailability.unmount();EGCAvailability.mount(document.querySelector("#host"))');expect(self.page.get_by_label('Unavailable from',exact=True)).to_have_value('12:30')
        self.page.reload();expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Keep this draft');expect(self.page.get_by_label('Unavailable from',exact=True)).to_have_value('12:30')
    def test_lost_save_retries_original_uuid_after_reload_without_duplicate(self):
        self.open();self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Lost reply draft');self.lost_once=True;self.create();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible()
        self.assertFalse(self.page.evaluate('EGCAvailability.canLeave()'));expect(self.page.get_by_label('Reason / note',exact=True)).to_be_disabled();self.page.reload();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='Retry original save',exact=True).click();self.assert_saved();self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(len([row for row in self.rows if row['reason']=='Lost reply draft']),1);self.assertTrue(self.page.evaluate('EGCAvailability.canLeave()'))
    def test_definite_failure_releases_form_with_draft_and_new_request(self):
        self.open();self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Conflict draft');self.fail_once=(409,'crew_availability_assignment_conflict','Assigned work must be reassigned first.');self.create()
        expect(self.page.get_by_role('alert')).to_contain_text('reassigned');expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Conflict draft');expect(self.page.get_by_label('Reason / note',exact=True)).to_be_enabled();self.choose('2026-09-29');self.create();self.assert_saved();self.assertNotEqual(self.calls[0]['requestId'],self.calls[1]['requestId'])
    def test_unknown_then_rejected_retry_unlocks_original_timed_values(self):
        self.open();self.choose();self.page.get_by_label('All day',exact=True).uncheck();self.page.get_by_label('Unavailable from',exact=True).fill('12:30');self.fail_once=(503,'crew_availability_unavailable','Save not confirmed');self.create();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible()
        self.fail_once=(400,'crew_availability_invalid_time','Choose another time');self.page.get_by_role('button',name='Retry original save',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('another time');expect(self.page.get_by_label('Unavailable from',exact=True)).to_be_enabled();expect(self.page.get_by_label('Unavailable from',exact=True)).to_have_value('12:30');self.assertEqual(self.calls[0],self.calls[1])
    def test_cancel_is_explicit_revision_checked_and_retry_safe(self):
        self.open();self.card().get_by_role('button',name='Cancel time off',exact=True).click();expect(self.page.get_by_role('dialog')).to_be_visible();self.assertEqual(self.calls,[])
        self.page.get_by_role('button',name='Keep time off',exact=True).click();expect(self.page.get_by_role('dialog')).to_have_count(0);self.card().get_by_role('button',name='Cancel time off',exact=True).click();self.lost_once=True;self.page.get_by_role('button',name='Confirm cancellation',exact=True).click()
        expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();self.page.get_by_role('button',name='Retry original save',exact=True).click();expect(self.page.get_by_role('dialog')).to_have_count(0);expect(self.card()).to_have_count(0)
        self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(self.calls[0]['expectedRevision'],'r1');self.page.get_by_label('Show cancelled',exact=True).check();expect(self.card()).to_contain_text('Cancelled')
    def test_stale_cancel_refreshes_latest_revision_and_does_not_erase_create_draft(self):
        self.open();self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Future draft');self.card().get_by_role('button',name='Cancel time off',exact=True).click();self.rows[0]['revision']='changed';self.page.get_by_role('button',name='Confirm cancellation',exact=True).click()
        expect(self.page.get_by_role('alert')).to_contain_text('schedule changed');expect(self.page.get_by_role('dialog')).to_have_count(0);self.page.get_by_role('button',name='Refresh availability',exact=True).click();expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Future draft')
        self.card().get_by_role('button',name='Cancel time off',exact=True).click();self.page.get_by_role('button',name='Confirm cancellation',exact=True).click();expect(self.page.get_by_role('dialog')).to_have_count(0);self.assertEqual(self.calls[-1]['expectedRevision'],'changed')
    def test_expired_get_and_signout_clear_private_records(self):
        self.open();self.read_status=401;self.page.get_by_role('button',name='Refresh',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('sign-in expired');expect(self.page.locator('.av-block')).to_have_count(0);expect(self.page.get_by_label('Reason / note',exact=True)).to_be_disabled()
        self.page.evaluate('window.dispatchEvent(new Event("egc:signout"))');expect(self.page.locator('#host')).to_be_empty();self.assertEqual(self.page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("egc-availability")).length'),0)
    def test_month_navigation_keeps_partial_draft_and_shows_carryin(self):
        self.rows.append(block(id='across-month',date='2026-09-30',endDate='2026-10-02',reason='Trip'));self.open_count=3
        self.page.goto(self.url);expect(self.page.locator('.av-block')).to_have_count(3);self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Keep across months');self.page.get_by_role('button',name='Next month',exact=True).click();expect(self.page.get_by_role('heading',name='October 2026',exact=True)).to_be_visible();expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Keep across months');expect(self.page.locator('.av-day[data-date="2026-10-01"] b')).to_have_text('Off')
    def test_phone_targets_untrusted_text_and_layout(self):
        self.rows[0]['reason']='<img src=x onerror=window.xss=1>\n'+('Unbroken_note_'*12);self.open();expect(self.card()).to_contain_text('<img');self.assertIsNone(self.page.evaluate('window.xss'))
        for width in [390,320,1360]:
            self.page.set_viewport_size({'width':width,'height':900});self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
            sizes=self.page.locator('.av-day').evaluate_all('(els)=>els.filter(e=>!e.disabled).map(e=>e.getBoundingClientRect().height)');self.assertTrue(all(size>=44 for size in sizes));self.assertGreaterEqual(self.page.get_by_label('First day',exact=True).bounding_box()['height'],44)
        self.page.set_viewport_size({'width':390,'height':844});(ROOT/'test-results').mkdir(exist_ok=True);self.page.screenshot(path=str(ROOT/'test-results'/'availability-mobile.png'),full_page=True)
    def test_unknown_request_restored_in_another_month_reads_correct_range(self):
        self.open();self.page.get_by_role('button',name='Next month',exact=True).click();self.choose('2026-10-20');self.page.get_by_label('Reason / note',exact=True).fill('October appointment');self.lost_once=True;self.create()
        expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();self.page.reload();expect(self.page.get_by_role('heading',name='October 2026',exact=True)).to_be_visible();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible()
        self.assertEqual(self.gets[-1]['startDate'],['2026-09-28']);expect(self.page.locator('.av-block')).to_have_count(1);self.page.get_by_role('button',name='Retry original save',exact=True).click();self.assert_saved();self.assertEqual(self.calls[0],self.calls[1])
    def test_saved_request_cannot_replay_under_a_different_employee(self):
        self.open();self.choose();self.lost_once=True;self.create();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();self.employee='crew.two'
        self.page.get_by_role('button',name='Retry original save',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('belongs to another employee');self.assertEqual(len(self.calls),1);expect(self.page.locator('.av-block')).to_have_count(0)
        self.employee='crew.one';self.page.get_by_role('button',name='Retry original save',exact=True).click();self.assert_saved();self.assertEqual(self.calls[0],self.calls[1])
    def test_incomplete_success_response_retains_identity_and_retry(self):
        self.open();self.choose();self.incomplete_once=True;self.create();expect(self.page.get_by_role('alert')).to_contain_text('response was incomplete');self.page.get_by_role('button',name='Retry original save',exact=True).click();self.assert_saved();self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(len(self.rows),4)
    def test_refresh_keeps_focus_and_offline_read_is_retryable(self):
        self.open();self.choose();self.page.get_by_label('Reason / note',exact=True).fill('Still typing');self.page.evaluate('EGCAvailability.refresh()');expect(self.page.get_by_label('Reason / note',exact=True)).to_be_focused()
        self.read_status=503;self.page.get_by_role('button',name='Refresh',exact=True).click();expect(self.page.get_by_role('alert')).to_be_visible();expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Still typing')
        self.read_status=200;self.page.get_by_role('button',name='Refresh availability',exact=True).click();expect(self.page.get_by_role('alert')).to_have_count(0);expect(self.page.get_by_label('Reason / note',exact=True)).to_have_value('Still typing')

if __name__=='__main__':unittest.main(verbosity=2)
