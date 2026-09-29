"""Requests board on a phone against an isolated request workflow API. No production services.
The page adds the border-box sizing that /styles.css gives employee.html."""
import copy,json,os,pathlib,threading,unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
# A workflow approval as the vault stores it: the approve decision's by/at are reviewedBy/reviewedAt.
STARTED={'id':'pto_synthetic2','type':'time_off','employee':'crew.one','employeeName':'Crew One','startDate':'2026-09-23','endDate':'2026-09-26','reason':'Synthetic long weekend','status':'approved','paid':True,'hoursPerDay':8,'paidDates':['2026-09-23','2026-09-24','2026-09-25','2026-09-26'],'paidHours':32,'createdAt':'2026-09-10T10:00:00.000Z','reviewedBy':'zacb','reviewedAt':'2026-09-11T10:00:00.000Z','decisions':[{'action':'approve','status':'approved','by':'zacb','at':'2026-09-11T10:00:00.000Z'}]}
PENDING={'id':'pto_synthetic1','type':'time_off','employee':'crew.one','employeeName':'Crew One','startDate':'2026-09-23','endDate':'2026-09-25','reason':'Synthetic family trip','status':'pending','paid':True,'hoursPerDay':8,'paidHours':24,'createdAt':'2026-09-20T10:00:00.000Z','decisions':[]}
WEEKEND={'id':'pto_synthetic3','type':'time_off','employee':'crew.one','employeeName':'Crew One','startDate':'2026-09-25','endDate':'2026-09-28','reason':'Synthetic long weekend','status':'pending','paid':True,'hoursPerDay':8,'paidHours':16,'createdAt':'2026-09-21T10:00:00.000Z','decisions':[]}
PROFILES=[{'id':'crew.one','username':'crew.one','displayName':'Crew One','role':'crew','status':'active','onboardingCompletedAt':'2026-09-01T12:00:00.000Z','onboardingVersion':'2026-09-location-v2'}]
COLLECTIONS=['profiles','timeEntries','announcements','requests','incidents','equipment','training','teamMessages','jobMessages','messageReads']
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path.startswith('/?'):
   user=self.path.split('user=')[1]
   manager='true' if user=='zacb' else 'false'
   body=f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{{box-sizing:border-box}}</style><link rel="stylesheet" href="/employee-suite.css"><link rel="stylesheet" href="/employee-pto.css"><main id="ops-main"></main><script>let jobsCache=[];window.hubFetch=fetch;sessionStorage.setItem('egc_u','{user}');sessionStorage.setItem('egc_business_access','{manager}');sessionStorage.setItem('egc_role','{'owner' if user=='zacb' else 'crew'}');</script><script src="/employee-pto.js"></script><script src="/fixture-suite.js"></script>'''
  elif self.path=='/fixture-suite.js':
   source=(ROOT/'employee-suite.js').read_text(encoding='utf-8');body=source.rsplit('})();',1)[0]+'window.__ptoTest={S,render};})();'
  else:return super().do_GET()
  self.send_response(200);self.send_header('Content-Type','application/javascript; charset=utf-8' if self.path.endswith('.js') else 'text/html; charset=utf-8');self.end_headers();self.wfile.write(body.encode())
class PtoRequestsBrowserTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  (ROOT/'test-results').mkdir(exist_ok=True);cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));threading.Thread(target=cls.server.serve_forever,daemon=True).start();cls.url=f'http://127.0.0.1:{cls.server.server_port}';cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
 def setUp(self):
  self.context=self.browser.new_context(viewport={'width':375,'height':812},is_mobile=True,has_touch=True,timezone_id='Asia/Tokyo');self.page=self.context.new_page();self.page.set_default_timeout(6000)
  self.errors=[];self.calls=[];self.receipts={};self.requests=[copy.deepcopy(PENDING)];self.conflict=False;self.lost=False
  self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route)
 def tearDown(self):self.assertEqual(self.errors,[]);self.context.close()
 def route(self,route):
  req=route.request;url=urlparse(req.url)
  if url.hostname!='127.0.0.1':route.abort();return
  if not url.path.startswith('/api/'):route.continue_();return
  def send(body,status=200):route.fulfill(status=status,content_type='application/json',body=json.dumps(body))
  if url.path=='/api/employee-hub' and req.method=='GET':send({'ok':True,'collections':{name:(self.requests if name=='requests' else PROFILES if name=='profiles' else []) for name in COLLECTIONS}});return
  if url.path!='/api/employee-pto' or req.method!='POST':send({'ok':False,'error':'Synthetic service unavailable'},503);return
  body=req.post_data_json;self.calls.append(copy.deepcopy(body))
  if body['requestId'] in self.receipts:send(self.receipts[body['requestId']]);return
  if body['action']=='approve' and self.conflict and not body.get('acknowledgeConflicts'):
   send({'ok':False,'code':'crew_availability_assignment_conflict','error':'This employee is assigned to work during this time off.','details':{'acknowledgeable':True,'conflicts':[{'code':'assigned_job','jobId':'job-1','date':'2026-09-23','time':'09:00','label':'Synthetic Customer'}]}},409);return
  if body['action']=='request':
   saved={'id':'pto_'+body['requestId'].replace('-',''),'type':body['type'],'employee':'crew.one','employeeName':'Crew One','startDate':body['startDate'],'endDate':body['endDate'],'reason':body.get('reason',''),'status':'pending','paid':body.get('paid',False),'hoursPerDay':body.get('hoursPerDay'),'paidHours':8 if body.get('paid') else 0,'createdAt':'2026-09-22T18:00:00.000Z','decisions':[]}
   self.requests.append(saved)
  else:
   saved=next(row for row in self.requests if row['id']==body['id']);saved['status']={'approve':'approved','deny':'denied','cancel':'cancelled','end':'approved','amend':'approved'}[body['action']]
   if body['action']=='end':saved['endedEarlyFrom']=body['endedEarlyFrom'];saved['paidHours']=16
   if body['action']=='amend':
    saved.update(paid=body['paid'],hoursPerDay=body.get('hoursPerDay'),paidDates=body.get('paidDates',[]),paidHours=len(body.get('paidDates',[]))*(body.get('hoursPerDay') or 0),reviewedBy='zacb',reviewedAt='2026-09-24T18:00:00.000Z')
    saved['decisions']=saved['decisions']+[{'action':'amend','status':'approved','by':'zacb','at':'2026-09-24T18:00:00.000Z'}]
  result={'ok':True,'requestId':body['requestId'],'request':saved,'warnings':[{'code':'availability_conflicts'}] if body.get('acknowledgeConflicts') else []};self.receipts[body['requestId']]=result
  if self.lost:self.lost=False;route.abort('failed');return
  send(result)
 def open(self,user,time='2026-09-22T18:00:00Z'):
  self.page.clock.install(time=time);self.page.goto(self.url+'/?user='+user)
  self.page.evaluate("(rows)=>{const t=__ptoTest;t.S.active='requests';Object.assign(t.S.peopleState,{loaded:true,loading:false,error:''});t.S.people.requests=rows;t.render()}",self.requests)
 def assert_phone_layout(self):
  self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
  heights=self.page.evaluate("[...document.querySelectorAll('.ops-request-list button,.ops-request-actions button,.ops-pto-pending button')].filter(b=>b.offsetParent).map(b=>b.getBoundingClientRect().height)")
  self.assertTrue(heights);self.assertTrue(all(h>=44 for h in heights),heights)
 def test_manager_confirms_assigned_work_before_approving_on_a_phone(self):
  self.conflict=True;self.open('zacb');self.assert_phone_layout()
  expect(self.page.locator('.ops-request-list')).to_contain_text('Paid 24 h')
  self.page.get_by_role('button',name='Approve',exact=True).click()
  expect(self.page.get_by_role('dialog',name='Approve time off for Crew One?')).to_be_visible();self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
  self.page.get_by_role('button',name='Approve time off',exact=True).click()
  total=self.page.get_by_role('dialog',name='Approve 24 paid hours for Crew One?');expect(total).to_contain_text('3 paid days × 8 hours = 24 hours')
  self.page.get_by_role('button',name='Approve 24 paid hours',exact=True).click()
  dialog=self.page.get_by_role('dialog',name='Approve over assigned work?');expect(dialog).to_contain_text('2026-09-23 09:00 Synthetic Customer');self.page.screenshot(path=str(ROOT/'test-results'/'pto-conflict-mobile.png'))
  self.page.get_by_role('button',name='Approve anyway',exact=True).click()
  expect(self.page.locator('.ops-request-list')).to_contain_text('approved');expect(self.page.get_by_role('button',name='Approve',exact=True)).to_have_count(0)
  self.assertEqual([call['action'] for call in self.calls],['approve','approve']);self.assertNotEqual(self.calls[0]['requestId'],self.calls[1]['requestId'])
  self.assertTrue(self.calls[1]['acknowledgeConflicts']);self.assertEqual(self.calls[1]['paid'],True);self.assertEqual(self.calls[1]['hoursPerDay'],8);self.assertEqual(self.calls[1]['paidDates'],['2026-09-23','2026-09-24','2026-09-25'])
  expect(self.page.get_by_role('button',name='Cancel',exact=True)).to_be_visible();self.assert_phone_layout()
 def test_manager_picks_paid_days_including_a_weekend_day_on_a_phone(self):
  # Weekend days start unpaid; the manager adds Saturday, drops Friday and sees the paid days before confirming.
  self.requests=[copy.deepcopy(WEEKEND)];self.open('zacb');self.assert_phone_layout()
  self.page.get_by_role('button',name='Approve',exact=True).click()
  expect(self.page.get_by_role('dialog',name='Approve time off for Crew One?')).to_contain_text('4 days, 2 on weekdays')
  choice=self.page.locator('.ops-action-dialog select[name=paidDays]');self.assertEqual(choice.input_value(),'weekdays')
  choice.select_option('custom');self.page.get_by_role('button',name='Approve time off',exact=True).click()
  expect(self.page.get_by_role('dialog',name='Choose the paid days for Crew One')).to_be_visible()
  days=self.page.evaluate("[...document.querySelectorAll('.ops-action-dialog select')].map(s=>[s.name,s.value,s.closest('label').querySelector('span').textContent,getComputedStyle(s).fontSize,s.getBoundingClientRect().height>=44])")
  self.assertEqual(days,[['day-2026-09-25','paid','Fri Sep 25','16px',True],['day-2026-09-26','unpaid','Sat Sep 26','16px',True],['day-2026-09-27','unpaid','Sun Sep 27','16px',True],['day-2026-09-28','paid','Mon Sep 28','16px',True]])
  self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
  self.page.locator('.ops-action-dialog select[name="day-2026-09-26"]').select_option('paid');self.page.locator('.ops-action-dialog select[name="day-2026-09-25"]').select_option('unpaid')
  self.page.screenshot(path=str(ROOT/'test-results'/'pto-paid-days-mobile.png'),full_page=True)
  self.page.get_by_role('button',name='Review paid hours',exact=True).click()
  expect(self.page.get_by_role('dialog',name='Approve 16 paid hours for Crew One?')).to_contain_text('Paid: Sat Sep 26, Mon Sep 28. Not paid: Fri Sep 25, Sun Sep 27.')
  self.page.get_by_role('button',name='Approve 16 paid hours',exact=True).click()
  expect(self.page.locator('.ops-request-list')).to_contain_text('approved')
  self.assertEqual(len(self.calls),1);self.assertEqual({key:value for key,value in self.calls[0].items() if key!='requestId'},{'action':'approve','id':'pto_synthetic3','paid':True,'hoursPerDay':8,'paidDates':['2026-09-26','2026-09-28']})
  self.assert_phone_layout()
 def test_manager_ends_started_time_off_on_the_denver_date(self):
  # 18:00 UTC is already tomorrow in Tokyo; the first day back defaults to the Denver date.
  self.requests=[copy.deepcopy(STARTED)];self.open('zacb','2026-09-24T18:00:00Z');self.assert_phone_layout()
  expect(self.page.get_by_role('button',name='Cancel',exact=True)).to_have_count(0)
  self.page.get_by_role('button',name='End early',exact=True).click()
  dialog=self.page.get_by_role('dialog',name='End time off early for Crew One?');expect(dialog).to_contain_text('keep their paid hours')
  field=self.page.get_by_label('First day back',exact=True);self.assertEqual(field.input_value(),'2026-09-24');self.assertEqual(field.get_attribute('min'),'2026-09-24');self.assertEqual(field.get_attribute('type'),'date')
  self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('.ops-action-dialog input')).fontSize"),'16px');self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
  self.assertTrue(self.page.evaluate("(()=>{const box=document.querySelector('.ops-action-dialog').getBoundingClientRect();return [...document.querySelectorAll('.ops-action-dialog input,.ops-action-dialog textarea,.ops-action-dialog button')].every(node=>node.getBoundingClientRect().right<=box.right+0.5)})()"))
  field.fill('2026-09-25');self.page.screenshot(path=str(ROOT/'test-results'/'pto-end-early-mobile.png'))
  self.page.get_by_role('button',name='End time off early',exact=True).click()
  expect(self.page.locator('.ops-request-list')).to_contain_text('Ended early, back 2026-09-25');expect(self.page.locator('.ops-request-list')).to_contain_text('Paid 16 h')
  self.assertEqual(len(self.calls),1);self.assertEqual({key:value for key,value in self.calls[0].items() if key!='requestId'},{'action':'end','id':'pto_synthetic2','endedEarlyFrom':'2026-09-25'})
  self.assert_phone_layout()
 def test_manager_changes_the_pay_of_started_time_off_on_a_phone(self):
  # The dialog starts from what the time off pays now and shows the hours the change replaces.
  self.requests=[copy.deepcopy(STARTED)];self.open('zacb','2026-09-24T18:00:00Z');self.assert_phone_layout()
  expect(self.page.locator('.ops-request-list')).to_contain_text('Paid 32 h')
  self.page.get_by_role('button',name='Edit pay',exact=True).click()
  expect(self.page.get_by_role('dialog',name='Change pay for Crew One?')).to_contain_text('Paid now: 32 hours. The schedule does not change.')
  fields=self.page.evaluate("[...document.querySelectorAll('.ops-action-dialog input,.ops-action-dialog select,.ops-action-dialog textarea')].map(n=>[n.name,n.value,n.getAttribute('inputmode')||'',getComputedStyle(n).fontSize,n.getBoundingClientRect().height>=44])")
  self.assertEqual(fields,[['paid','yes','','16px',True],['hoursPerDay','8','decimal','16px',True],['paidDays','all','','16px',True],['note','','','16px',True]])
  self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
  self.page.locator('.ops-action-dialog input[name=hoursPerDay]').fill('4');self.page.locator('.ops-action-dialog select[name=paidDays]').select_option('weekdays')
  self.page.screenshot(path=str(ROOT/'test-results'/'pto-change-pay-mobile.png'),full_page=True)
  self.page.get_by_role('button',name='Review pay',exact=True).click()
  total=self.page.get_by_role('dialog',name='Save 12 paid hours for Crew One?');expect(total).to_contain_text('Not paid: Sat Sep 26.');expect(total).to_contain_text('They replace the 32 paid hours on the timesheet now.')
  self.page.get_by_role('button',name='Save 12 paid hours',exact=True).click()
  expect(self.page.locator('.ops-request-list')).to_contain_text('Paid 12 h')
  self.assertEqual(len(self.calls),1);self.assertEqual({key:value for key,value in self.calls[0].items() if key!='requestId'},{'action':'amend','id':'pto_synthetic2','paid':True,'hoursPerDay':4,'paidDates':['2026-09-23','2026-09-24','2026-09-25']})
  self.assert_phone_layout()
 def test_crew_retries_a_lost_time_off_request_without_a_duplicate(self):
  self.requests=[];self.lost=True;self.open('crew.one')
  self.page.get_by_role('button',name='Request time off',exact=True).click()
  self.page.get_by_label('Start date',exact=True).fill('2026-09-28');self.page.get_by_label('End date',exact=True).fill('2026-09-28')
  self.page.locator('.ops-action-dialog select[name=paid]').select_option('yes');self.assertEqual(self.page.locator('.ops-action-dialog input[name=hoursPerDay]').input_value(),'8')
  self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('.ops-action-dialog input')).fontSize"),'16px')
  self.page.get_by_role('button',name='Send request',exact=True).click()
  expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_be_visible();expect(self.page.get_by_role('button',name='Request time off',exact=True)).to_be_disabled();self.page.screenshot(path=str(ROOT/'test-results'/'pto-retry-mobile.png'),full_page=True)
  self.assert_phone_layout()
  self.page.get_by_role('button',name='Retry original save',exact=True).click()
  expect(self.page.get_by_role('button',name='Retry original save',exact=True)).to_have_count(0);expect(self.page.locator('.ops-request-list')).to_contain_text('Paid 8 h')
  self.assertEqual(len(self.calls),2);self.assertEqual(self.calls[0],self.calls[1]);self.assertEqual(len(self.requests),1)
  self.assertEqual(self.calls[0]['type'],'time_off');self.assertEqual(self.calls[0]['hoursPerDay'],8)
  expect(self.page.get_by_role('button',name='Cancel',exact=True)).to_be_visible();self.assert_phone_layout()
if __name__=='__main__':unittest.main()
