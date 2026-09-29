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
            html='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-operations.css"><link rel="stylesheet" href="/employee-recordings.css"></head><body><script src="/employee-operations.js"></script><script src="/employee-recordings.js"></script><button onclick="EGCRecordings.open('visit-synthetic',{actor:{role:'owner'},owners:[{id:'test-owner',name:'Test owner'}]})">Recordings</button></body></html>'''
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode())
        else:super().do_GET()
class RecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)));threading.Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.pw=sync_playwright().start();cls.browser=getattr(cls.pw,os.environ.get('EGC_TEST_BROWSER','chromium')).launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}));cls.url=f'http://127.0.0.1:{cls.server.server_port}'
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':390,'height':900});self.page=self.context.new_page();self.calls=[];self.errors=[];self.fail=False;self.fail_text=False
        self.row={'id':str(uuid.uuid4()),'createdAt':'2026-09-21T12:00:00Z','revision':'2026-09-21T12:01:00Z','status':'draft','portalJobId':'visit-synthetic','portalVisitId':'visit-synthetic','linkageExceptions':['project_link_not_established'],'transcript':'I will call before work starts. Keep the bicycle.','extraction':{'garageSize':'2_car','junkVolumeYards':None,'itemsRemove':[],'itemsKeep':['Bicycle'],'itemsRelocate':[],'storageRequirements':[],'bikeRacks':0,'toolRacks':0,'shelving':[],'pressureWashing':False,'pestObservations':[],'activeInfestation':None,'accessNotes':None,'estimatedLaborHours':None,'customerPreferences':[],'customerObjections':[],'salesNotes':[],'crewNotes':[],'pricingNotes':[],'evidence':{},'proposedActions':[{'title':'Call before work','kind':'callback','commitment':'Call before work starts','sourceQuote':'I will call before work starts','ownerMention':None,'dueMention':None,'confidence':0.9}]}}
        self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route)
    def tearDown(self):self.assertEqual(self.errors,[]);self.context.close()
    def route(self,route):
        p=urlparse(route.request.url)
        if p.hostname!='127.0.0.1':route.abort();return
        if p.path=='/api/operations':route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'actor':{'role':'owner','id':'test-owner'},'owners':[{'id':'test-owner','name':'Test owner'}]}));return
        if p.path!='/api/operations-recordings':route.continue_();return
        request=route.request.post_data_json;self.calls.append(request);c=request['body'];name=c['command'];result={'ok':True}
        if name=='recording.list':result.update(recordings=[self.row],nextOffset=None)
        elif name=='recording.get':result['recording']=self.row
        elif name=='recording.transcript':
            if self.fail_text:self.fail_text=False;route.fulfill(status=503,content_type='application/json',body='{"error":"recording_unavailable"}');return
            self.row.update(sourceKind='transcript',sourceFilename=c.get('filename'),transcript=c['transcript']);result['recording']=self.row
        elif name=='recording.approve':
            if self.fail:self.fail=False;self.fail_text=False;route.fulfill(status=503,content_type='application/json',body='{"error":"recording_unavailable"}');return
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
    def add_transcript(self):
        self.page.goto(self.url);self.page.get_by_role('button',name='Recordings',exact=True).click();self.page.get_by_role('button',name='Add transcript',exact=True).click()
    def test_pasted_transcript_saves_exact_text_on_current_visit(self):
        self.add_transcript();text='Customer: Keep both bikes.\nRep: I will send shelving options tomorrow.'
        self.page.get_by_label('Walkthrough transcript',exact=True).fill(text);self.page.get_by_role('button',name='Create review draft',exact=True).click();expect(self.page.get_by_text('Status: draft',exact=True)).to_be_visible()
        writes=[c for c in self.calls if c['body']['command']=='recording.transcript'];self.assertEqual(len(writes),1);self.assertEqual(writes[0]['body'],{'command':'recording.transcript','portalJobId':'visit-synthetic','transcript':text});self.assertFalse(any(c['body']['command']=='recording.approve' for c in self.calls))
    def test_transcript_upload_unknown_outcome_reuses_exact_request(self):
        self.add_transcript();self.fail_text=True;text='WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nPlease keep the bicycle.'
        self.page.get_by_label('Choose transcript file').set_input_files({'name':'walkthrough.vtt','mimeType':'text/vtt','buffer':text.encode()});expect(self.page.get_by_label('Walkthrough transcript',exact=True)).to_have_value(text)
        self.page.get_by_role('button',name='Create review draft',exact=True).click();expect(self.page.get_by_role('button',name='Retry same transcript',exact=True)).to_be_visible();expect(self.page.get_by_label('Walkthrough transcript',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='Retry same transcript',exact=True).click();expect(self.page.get_by_text('Status: draft',exact=True)).to_be_visible();writes=[c for c in self.calls if c['body']['command']=='recording.transcript'];self.assertEqual(len(writes),2);self.assertEqual(writes[0],writes[1]);self.assertEqual(writes[0]['body']['filename'],'walkthrough.vtt')
    def test_oversize_and_empty_transcript_never_submit(self):
        self.add_transcript();self.page.get_by_label('Walkthrough transcript',exact=True).fill(' ');self.page.get_by_role('button',name='Create review draft',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('readable transcript')
        self.page.get_by_label('Walkthrough transcript',exact=True).fill('é'*40001);self.page.get_by_role('button',name='Create review draft',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('80 KB');self.assertFalse(any(c['body']['command']=='recording.transcript' for c in self.calls))
    def test_v2_proposals_become_reviewed_owned_office_tasks(self):
        self.row['sourceKind']='transcript';self.row['proposedTasks']=[{'index':0,'reviewRequired':True,'task':{'title':'Send shelving options','kind':'send_product_options','description':'Customer asked for wall shelves.','sourceEvidence':[{'source':'recording','id':self.row['id'],'excerpt':'I will send shelving options tomorrow.'}],'draft':{'body':'Here are the shelving options we discussed.'}}}]
        self.open()
        self.assertIn('Here are the shelving options',self.page.get_by_label('Office instructions').input_value());self.page.get_by_label('Create an Action Center task').check();self.page.get_by_label('Task owner').select_option('test-owner');self.page.get_by_label('Due time · America/Denver').fill('2026-10-01T09:00');self.page.get_by_label('What proves completion?').fill('Record the customer conversation and the options sent.');self.page.get_by_label('I reviewed the transcript, the current visit, the scope and each selected action').check();self.page.get_by_role('button',name='Approve reviewed scope',exact=True).click();expect(self.page.get_by_text('Status: approved',exact=True)).to_be_visible()
        task=next(c for c in self.calls if c['body']['command']=='recording.approve')['body']['actions'][0];self.assertEqual(task['kind'],'manual');self.assertEqual(task['assignedUserId'],'test-owner');self.assertEqual(task['portalJobId'],'visit-synthetic');self.assertEqual(task['sourceEvidence'][0]['id'],self.row['id']);self.assertIsNone(task['draft']);self.assertEqual(task['dueAt'],'2026-10-01T15:00:00.000Z');expect(self.page.get_by_role('link',name='Open office follow-ups')).to_have_attribute('href','/employee?view=action_center')
    def test_phone_layout_and_transcript_capture_are_touch_ready(self):
        self.add_transcript();self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),390);self.assertGreaterEqual(self.page.get_by_role('button',name='Create review draft',exact=True).bounding_box()['height'],44);self.assertEqual(self.page.get_by_label('Walkthrough transcript',exact=True).evaluate('e=>getComputedStyle(e).fontSize'),'16px')
        if os.environ.get('EGC_SCREENSHOT_DIR'):
            target=pathlib.Path(os.environ['EGC_SCREENSHOT_DIR']);target.mkdir(parents=True,exist_ok=True);self.page.screenshot(path=str(target/'walkthrough-transcript-iphone.png'),full_page=True)
        self.page.set_viewport_size({'width':844,'height':390});self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),844)
    def test_walkthrough_entry_loads_canonical_reviewer_and_owners(self):
        self.page.goto(self.url);self.page.evaluate("EGCRecordings.open('visit-synthetic')");self.page.get_by_role('button',name='Open recording',exact=True).click();expect(self.page.get_by_role('button',name='Approve reviewed scope',exact=True)).to_be_enabled();self.assertEqual(self.page.get_by_label('Task owner').locator('option').count(),2)
    def test_sales_can_read_saved_draft_but_cannot_approve(self):
        self.page.goto(self.url);self.page.evaluate("EGCRecordings.open('visit-synthetic',{actor:{role:'sales'},owners:[]})");self.page.get_by_role('button',name='Open recording',exact=True).click();expect(self.page.get_by_role('button',name='Approve reviewed scope',exact=True)).to_be_disabled();expect(self.page.get_by_label('Keep',exact=True)).to_be_disabled()
    def test_audio_capture_locks_upload_until_finished_and_stops_on_signout(self):
        self.page.add_init_script("window.stoppedTracks=0;Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>window.stoppedTracks++}]})}});window.MediaRecorder=class{constructor(){this.state='inactive';this.mimeType='audio/webm'}start(){this.state='recording'}stop(){this.state='inactive';setTimeout(()=>{this.ondataavailable({data:new Blob(['synthetic-audio'],{type:'audio/webm'})});this.onstop()},0)}};")
        self.page.goto(self.url);self.page.get_by_role('button',name='Recordings',exact=True).click();self.page.get_by_role('button',name='Record or upload audio',exact=True).click();self.page.get_by_label('Everyone present has agreed to the recording').check();self.page.get_by_role('button',name='Start recording',exact=True).click();expect(self.page.get_by_role('button',name='Upload saved audio',exact=True)).to_be_disabled();expect(self.page.get_by_label('Choose walkthrough audio')).to_be_disabled();self.page.get_by_role('button',name='Finish recording',exact=True).click();expect(self.page.get_by_role('button',name='Upload saved audio',exact=True)).to_be_enabled();self.page.get_by_role('button',name='Start recording',exact=True).click();self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))");expect(self.page.get_by_role('dialog')).to_have_count(0);self.assertGreaterEqual(self.page.evaluate('window.stoppedTracks'),2)
    def test_signout_removes_transcript_and_review(self):
        self.open();self.page.evaluate("window.dispatchEvent(new Event('egc:signout'))");expect(self.page.get_by_role('dialog')).to_have_count(0)
if __name__=='__main__':unittest.main(verbosity=2)
