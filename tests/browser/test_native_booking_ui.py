"""Actual booking forms against isolated dispatch receipts. No production services."""
import copy,json,os,pathlib,re,threading,unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
CUSTOMER={'id':'customer-1','revision':'c1','name':'Synthetic customer','phone':'9705550100','email':'synthetic@example.invalid','address':'123 Synthetic St'}
ROSTER=[{'id':'crew.one','name':'Crew One','role':'crew'},{'id':'lead.one','name':'Lead One','role':'crew_lead'}]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/':body='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-suite.css"><link rel="stylesheet" href="/employee-booking.css"><main id="ops-main"></main><script>let jobsCache=[];window.hubFetch=fetch;sessionStorage.setItem('egc_u','zacb');sessionStorage.setItem('egc_business_access','true');sessionStorage.setItem('egc_role','owner');</script><script src="/employee-booking.js"></script><script src="/fixture-suite.js"></script>'''
  elif self.path=='/fixture-suite.js':
   source=(ROOT/'employee-suite.js').read_text(encoding='utf-8');body=source.rsplit('})();',1)[0]+'window.__nativeTest={S,render,syncPayload};})();'
  elif self.path=='/legacy':
   source=(ROOT/'employee.html').read_text(encoding='utf-8');body=re.sub(r'<script\b[^>]*>[\s\S]*?</script>','',source,flags=re.I).replace('</body>','<script src="/employee-booking.js"></script><script src="/fixture-legacy.js"></script></body>')
  elif self.path=='/fixture-legacy.js':
   source=(ROOT/'employee.html').read_text(encoding='utf-8');booking=source[source.index('let bk ='):source.index('/* ═══════════════════════════════════════════════════════\n   TOAST')];phone=source[source.index('let oc ='):source.index("window.addEventListener('egc:booking-recovered'")]
   body='''let jobsCache=[],custsCache=[],leadsCache=[],me='zacb';window.db={collection(){throw Error('Unexpected browser database write')}};sessionStorage.setItem('egc_u','zacb');function loadCustomers(){return [window.syntheticCustomer]};function showToast(t){window.lastToast=t};function refresh(){};function bootDashboard(){};function showModeSelect(){};function showErr(t){document.getElementById('step-err').textContent=t};function clearErr(){showErr('')};function initials(){return 'SC'};function avatarBg(){return '#356'};function fmtDate(d){return d.toISOString().slice(0,10)};function fmtTime(t){return t};function uid(){return crypto.randomUUID()};function esc(s){return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};async function sendBookingConfirmation(){window.sentEmails=(window.sentEmails||0)+1};'''+booking+phone+'''\nfunction calcQuote(){return {low:400,high:600}};'''
  else:return super().do_GET()
  self.send_response(200);self.send_header('Content-Type','application/javascript' if self.path.endswith('.js') else 'text/html');self.end_headers();self.wfile.write(body.encode())
class NativeBookingBrowserTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));threading.Thread(target=cls.server.serve_forever,daemon=True).start();cls.url=f'http://127.0.0.1:{cls.server.server_port}';cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
 def setUp(self):
  self.context=self.browser.new_context(viewport={'width':1360,'height':1000},timezone_id='Asia/Tokyo');self.page=self.context.new_page();self.page.set_default_timeout(6000);self.errors=[];self.calls=[];self.receipts={};self.jobs=[];self.lost=False;self.failure=None;self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route)
 def tearDown(self):self.assertEqual(self.errors,[]);self.context.close()
 def route(self,route):
  req=route.request;url=urlparse(req.url)
  if url.hostname!='127.0.0.1':route.abort();return
  if not url.path.startswith('/api/'):route.continue_();return
  def send(body,status=200):route.fulfill(status=status,content_type='application/json',body=json.dumps(body))
  if url.path=='/api/customer-resolve':send({'ok':True,'customer':CUSTOMER});return
  if url.path!='/api/dispatch':send({'ok':False,'error':'Synthetic provider unavailable'},503);return
  if req.method=='GET':
   args=parse_qs(url.query);found=next((row for row in self.jobs if row['id']==args.get('jobId',[''])[0]),None);send({'ok':True,'jobs':self.jobs,'job':found,'roster':ROSTER,'crews':[],'vehicles':[],'warnings':[]});return
  body=req.post_data_json;self.calls.append(copy.deepcopy(body))
  if body['requestId'] in self.receipts:send(self.receipts[body['requestId']]);return
  if self.failure:send({'ok':False,'error':'Crew unavailable','code':'dispatch_conflict'},409);return
  previous=next((row for row in self.jobs if row['id']==body.get('jobId')),None)
  if previous and body['expectedRevision']!=previous['revision']:send({'ok':False,'code':'dispatch_revision_conflict','error':'Job changed'},409);return
  job={**(previous or {}),'id':body.get('jobId') or 'visit-'+str(len(self.jobs)+1),'revision':'r'+str(len(self.calls)),'type':body.get('kind',previous['type'] if previous else 'job'),'customerId':body.get('customerId',CUSTOMER['id']),'customer':CUSTOMER['name'],'phone':CUSTOMER['phone'],'email':CUSTOMER['email'],'status':'scheduled','syncStatus':'pending',**body.get('changes',{})};self.jobs=[row for row in self.jobs if row['id']!=job['id']]+[job];result={'ok':True,'job':job};self.receipts[body['requestId']]=result
  if self.lost:self.lost=False;route.abort('failed');return
  send(result)
 def suite(self):
  self.page.goto(self.url);self.page.evaluate("__nativeTest.S.active='schedule';__nativeTest.render();opsOpenBooking('2026-09-22')");self.page.get_by_label('Customer / label',exact=True).fill(CUSTOMER['name']);self.page.get_by_label('Mobile',exact=True).fill(CUSTOMER['phone']);self.page.get_by_label('Address',exact=True).fill(CUSTOMER['address']);self.page.get_by_label('Start',exact=True).fill('14:15');self.page.get_by_label('End',exact=True).fill('15:00')
 def legacy(self):self.page.goto(self.url+'/legacy');self.page.evaluate('(c)=>{window.syntheticCustomer=c;openBooking("2026-09-22");bk.customer=c;bk.step=2;renderStep()}',CUSTOMER)
 def review(self):self.page.locator('#b-time').fill('14:15');self.page.locator('#b-endtime').fill('15:00');self.page.get_by_label('Crew One',exact=True).check();self.page.locator('#btn-next').click();self.page.locator('#send-email').uncheck()
 def test_lost_save_preserves_one_visit_and_denver_time(self):
  self.suite();self.lost=True;self.page.get_by_role('button',name='Save + sync',exact=True).click();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();self.assertEqual(len(self.jobs),1);expect(self.page.get_by_label('Customer / label',exact=True)).to_be_disabled();self.page.get_by_role('button',name='Retry original save',exact=True).click();expect(self.page.get_by_role('dialog',name='Schedule work')).to_have_count(0);self.assertEqual(len(self.jobs),1);self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(self.page.evaluate('__nativeTest.syncPayload(jobsCache[0]).start_time'),'2026-09-22T20:15:00.000Z')
 def test_dst_ambiguity_creates_no_visit(self):
  self.suite();self.page.get_by_label('Date',exact=True).fill('2026-11-01');self.page.get_by_label('End date',exact=True).fill('2026-11-01');self.page.get_by_label('Start',exact=True).fill('01:30');self.page.get_by_label('End',exact=True).fill('02:30');self.page.get_by_role('button',name='Save + sync',exact=True).click();expect(self.page.locator('#ops-booking-status')).to_contain_text('daylight-saving');self.assertEqual(self.calls,[])
 def test_refresh_recovers_exact_saved_request(self):
  self.suite();self.lost=True;self.page.get_by_role('button',name='Save + sync',exact=True).click();expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();self.page.reload();self.page.get_by_role('button',name='Retry saved request',exact=True).click();expect(self.page.locator('#egc-booking-recovery')).to_have_count(0);self.assertEqual(len(self.jobs),1);self.assertEqual(self.calls[0],self.calls[1])
 def test_conflict_keeps_form_editable(self):
  self.suite();self.failure=True;self.page.get_by_role('button',name='Save + sync',exact=True).click();expect(self.page.locator('#ops-booking-status')).to_contain_text('unavailable');expect(self.page.get_by_label('Customer / label',exact=True)).to_be_enabled();self.assertEqual(self.jobs,[]);self.failure=None;self.page.get_by_role('button',name='Retry save',exact=True).click();expect(self.page.get_by_role('dialog',name='Schedule work')).to_have_count(0)
 def test_legacy_wizard_uses_live_roster_and_dispatch(self):
  self.legacy();self.review();self.page.locator('#btn-next').click();expect(self.page.locator('#booking-overlay')).not_to_have_class(re.compile('open'));self.assertEqual(self.calls[0]['changes']['assignedCrew'],['crew.one']);self.assertEqual(self.calls[0]['customerId'],CUSTOMER['id'])
 def test_multi_day_edit_preserves_duration_and_cadence(self):
  job={'id':'existing','revision':'r1','type':'job','customerId':CUSTOMER['id'],'customer':CUSTOMER['name'],'date':'2026-09-22','time':'08:00','endDate':'2026-09-23','endTime':'16:30','assignedCrew':['crew.one'],'recurrence':'monthly','status':'scheduled'};self.jobs=[job];self.legacy();self.page.evaluate('(j)=>openBooking(null,j)',job);expect(self.page.locator('#b-enddate')).to_have_value('2026-09-23');expect(self.page.locator('#b-endtime')).to_have_value('16:30');expect(self.page.locator('#job-recurrence')).to_have_value('monthly');self.page.locator('#btn-next').click();self.page.locator('#send-email').uncheck();self.page.locator('#btn-next').click();expect(self.page.locator('#booking-overlay')).not_to_have_class(re.compile('open'));self.assertEqual(len(self.calls),1);self.assertEqual(self.calls[0]['changes']['endDate'],'2026-09-23')
 def test_series_lost_response_replays_then_finishes(self):
  self.legacy();self.page.locator('#job-recurrence').select_option('weekly');self.review();self.lost=True;self.page.locator('#btn-next').click();expect(self.page.locator('#btn-next')).to_have_text('Retry original booking');expect(self.page.locator('#btn-back')).to_be_disabled();self.page.locator('#btn-next').click();expect(self.page.locator('#booking-overlay')).not_to_have_class(re.compile('open'));self.assertEqual(len(self.jobs),9);self.assertEqual(self.calls[0],self.calls[1])
 def test_phone_quote_preserves_range_as_notes(self):
  self.legacy();self.page.evaluate('(c)=>{closeBooking();openOnCall();oc.customer=c;oc.step=3;renderOcStep()}',CUSTOMER);self.page.locator('#oc-time').fill('13:00');self.page.locator('#oc-endtime').fill('14:00');self.page.locator('#oncall-crew').get_by_label('Lead One',exact=True).check();self.page.locator('#oc-email').uncheck();self.page.locator('#oc-next').click();expect(self.page.locator('#oncall-overlay')).not_to_have_class(re.compile('open'));self.assertEqual(self.calls[0]['changes']['assignedCrew'],['lead.one']);self.assertIn('$400–$600',self.calls[0]['changes']['notes']);self.assertNotIn('priceQuoted',self.calls[0]['changes'])
 def test_phone_size_review_and_save(self):
  self.page.set_viewport_size({'width':390,'height':844});self.legacy();self.review();self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),390);self.page.locator('#btn-next').click();expect(self.page.locator('#booking-overlay')).not_to_have_class(re.compile('open'))
if __name__=='__main__':unittest.main(verbosity=2)
