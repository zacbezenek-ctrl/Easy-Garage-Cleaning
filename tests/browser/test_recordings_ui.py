"""Recording review UI with isolated synthetic HTTP responses; no provider requests."""
import json, pathlib, threading, unittest, uuid, os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path=='/':
            html='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-operations.css"></head><body><script src="/employee-operations.js"></script><script src="/employee-recordings.js"></script><button onclick="EGCRecordings.open('visit-synthetic',{actor:{role:'owner'},owners:[{id:'test-owner',name:'Test owner'}]})">Recordings</button></body></html>'''
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode())
        else:super().do_GET()
class RecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}));cls.url=f'http://127.0.0.1:{cls.server.server_port}'
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':390,'height':900});self.page=self.context.new_page();self.calls=[];self.errors=[];self.fail=False
        self.row={'id':str(uuid.uuid4()),'createdAt':'2026-09-21T12:00:00Z','revision':'2026-09-21T12:01:00Z','status':'draft','portalJobId':'visit-synthetic','portalVisitId':'visit-synthetic','linkageExceptions':['project_link_not_established'],'transcript':'I will call before work starts. Keep the bicycle.','extraction':{'garageSize':'2_car','junkVolumeYards':None,'itemsRemove':[],'itemsKeep':['Bicycle'],'itemsRelocate':[],'storageRequirements':[],'bikeRacks':0,'toolRacks':0,'shelving':[],'pressureWashing':False,'pestObservations':[],'activeInfestation':None,'accessNotes':None,'estimatedLaborHours':None,'customerPreferences':[],'customerObjections':[],'salesNotes':[],'crewNotes':[],'pricingNotes':[],'evidence':{},'proposedActions':[{'title':'Call before work','kind':'callback','commitment':'Call before work starts','sourceQuote':'I will call before work starts','ownerMention':None,'dueMention':None,'confidence':0.9}]}}
        self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route)
    def tearDown(self):self.assertEqual(self.errors,[]);self.context.close()
    def route(self,route):
        p=urlparse(route.request.url)
        if p.hostname!='127.0.0.1':route.abort();return
        if p.path!='/api/operations-recordings':route.continue_();return
        request=route.request.post_data_json;self.calls.append(request);c=request['body'];name=c['command'];result={'ok':True}
        if name=='recording.list':result.update(recordings=[self.row],nextOffset=None)
        elif name=='recording.get':result['recording']=self.row
        elif name=='recording.approve':
            if self.fail:self.fail=False;route.fulfill(status=503,content_type='application/json',body='{"error":"recording_unavailable"}');return
            self.row['status']='approved';self.row['approvedBy']='test-owner';result['recording']=self.row
        elif name=='recording.retry':self.row['status']='processing';result['recording']=self.row
        route.fulfill(status=200,content_type='application/json',body=json.dumps(result))
    def open(self):self.page.goto(self.url);self.page.get_by_role('button',name='Recordings',exact=True).click();self.page.get_by_role('button',name='Open recording',exact=True).click();expect(self.page.get_by_text('Status: draft',exact=True)).to_be_visible()
    def test_scope_and_source_are_visible_without_invented_tasks(self):
        self.open();expect(self.page.get_by_label('Keep',exact=True)).to_have_value('Bicycle');expect(self.page.get_by_text('I will call before work starts',exact=True)).to_be_visible();self.assertEqual(self.page.get_by_label('Task owner').input_value(),'');self.assertEqual(self.page.get_by_label('Due time · America/Denver').input_value(),'');self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),391)
    def test_review_requires_human_checkbox_and_selected_action_details(self):
        self.open();self.page.get_by_role('button',name='Approve reviewed scope',exact=True).click();self.assertFalse(any(c['body']['command']=='recording.approve' for c in self.calls));self.page.get_by_label('I reviewed the transcript, the current visit, the scope and each selected action').check();self.page.get_by_label('Create an Action Center task').check();self.page.get_by_role('button',name='Approve reviewed scope',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('Choose an owner');self.assertFalse(any(c['body']['command']=='recording.approve' for c in self.calls))
    def test_unknown_approval_retries_exact_review_and_request_id(self):
        self.open();self.fail=True;self.page.get_by_label('I reviewed the transcript, the current visit, the scope and each selected action').check();self.page.get_by_role('button',name='Approve reviewed scope',exact=True).click();expect(self.page.get_by_role('button',name='Retry exact review')).to_be_visible();expect(self.page.get_by_label('Keep',exact=True)).to_be_disabled();self.page.get_by_role('button',name='Retry exact review').click();expect(self.page.get_by_text('Status: approved',exact=True)).to_be_visible();writes=[x for x in self.calls if x['body']['command']=='recording.approve'];self.assertEqual(len(writes),2);self.assertEqual(writes[0],writes[1]);self.assertEqual(writes[0]['body']['actions'],[])
    def test_failed_processing_is_truthful_and_retryable(self):
        self.row['status']='failed';self.row['lastErrorCode']='recording_processing_failed';self.page.goto(self.url);self.page.get_by_role('button',name='Recordings',exact=True).click();self.page.get_by_role('button',name='Open recording',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('Audio is saved');self.page.get_by_role('button',name='Retry processing').click();expect(self.page.get_by_text('Status: processing',exact=True)).to_be_visible()
    def test_signout_removes_transcript_and_review(self):
        self.open();self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))");expect(self.page.get_by_role('dialog')).to_have_count(0)
if __name__=='__main__':unittest.main(verbosity=2)
